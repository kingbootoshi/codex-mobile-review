// Git diff engine: turns a repo's working-tree changes into structured FileDiff[].
// Runs on the host (where git + the repo live). Pure parsing, no mutation of the repo.

import { basename, resolve } from "node:path";
import type { DiffHunk, DiffLine, FileDiff, FileStatus, SessionInput } from "./types.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_LINES_PER_FILE = 1500; // guard against multi-thousand-line files bloating the payload
const MAX_UNTRACKED_LINES = 800;

function git(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

/** git quotes paths with special chars in double quotes + C escapes. Undo the common cases. */
function dequote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  return inner.replace(/\\(["\\nt])/g, (_m, c) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c,
  );
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

interface Parsed {
  file: FileDiff;
}

/** Parse a single `diff --git` block into a FileDiff. */
function parseFileBlock(block: string): FileDiff | null {
  const lines = block.split("\n");
  const head = lines[0] ?? "";
  // diff --git a/x b/x  → capture both sides (last resort path source)
  let path = "";
  let oldPath = "";
  let newPath = "";
  let status: FileStatus = "modified";
  let isBinary = false;

  for (const ln of lines) {
    if (ln.startsWith("new file mode")) status = "added";
    else if (ln.startsWith("deleted file mode")) status = "deleted";
    else if (ln.startsWith("rename from") || ln.startsWith("rename to")) status = "renamed";
    else if (ln.startsWith("Binary files")) isBinary = true;
    else if (ln.startsWith("--- ")) oldPath = stripPrefix(dequote(ln.slice(4).trim()));
    else if (ln.startsWith("+++ ")) newPath = stripPrefix(dequote(ln.slice(4).trim()));
  }

  // Resolve display path
  if (newPath && newPath !== "/dev/null") path = newPath;
  else if (oldPath && oldPath !== "/dev/null") path = oldPath;
  else {
    // fall back to the diff --git header
    const m = head.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m) path = dequote(m[2] ?? m[1] ?? "");
  }
  if (!path) return null;

  if (isBinary) {
    return {
      path,
      name: path,
      add: 0,
      del: 0,
      status: "binary",
      hunks: [],
      note: "binary file — not shown",
    };
  }

  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let add = 0;
  let del = 0;
  let emitted = 0;
  let truncated = false;

  for (const ln of lines) {
    if (ln.startsWith("@@")) {
      const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldLine = m ? parseInt(m[1]!, 10) : 0;
      newLine = m ? parseInt(m[2]!, 10) : 0;
      cur = { header: ln, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // header noise (index, ---/+++) before first hunk
    if (ln.startsWith("\\")) continue; // "\ No newline at end of file"

    if (emitted >= MAX_LINES_PER_FILE) {
      truncated = true;
      // keep counting +/- for accurate totals but stop emitting line bodies
      if (ln.startsWith("+") && !ln.startsWith("+++")) add++;
      else if (ln.startsWith("-") && !ln.startsWith("---")) del++;
      continue;
    }

    let dl: DiffLine | null = null;
    if (ln.startsWith("+") && !ln.startsWith("+++")) {
      dl = { gutter: String(newLine), content: ln.slice(1), type: "plus" };
      newLine++;
      add++;
    } else if (ln.startsWith("-") && !ln.startsWith("---")) {
      dl = { gutter: String(oldLine), content: ln.slice(1), type: "minus" };
      oldLine++;
      del++;
    } else if (ln.startsWith(" ")) {
      dl = { gutter: String(newLine), content: ln.slice(1), type: "ctx" };
      oldLine++;
      newLine++;
    }
    if (dl) {
      cur.lines.push(dl);
      emitted++;
    }
  }

  // drop empty hunks (e.g. pure-rename with no content change)
  const realHunks = hunks.filter((h) => h.lines.length > 0);

  const file: FileDiff = {
    path,
    name: path,
    add,
    del,
    status,
    hunks: realHunks,
  };
  if (truncated) file.note = `diff truncated — showing first ${MAX_LINES_PER_FILE} lines`;
  return file;
}

function parseUnifiedDiff(text: string): FileDiff[] {
  if (!text.trim()) return [];
  // Split on the start-of-line "diff --git" marker, keep the marker.
  const blocks = text
    .split(/\n(?=diff --git )/g)
    .map((b) => (b.startsWith("diff --git ") ? b : b.replace(/^[\s\S]*?(?=diff --git )/, "")))
    .filter((b) => b.startsWith("diff --git "));
  const out: FileDiff[] = [];
  for (const b of blocks) {
    const f = parseFileBlock(b);
    if (f) out.push(f);
  }
  return out;
}

function isProbablyBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function untrackedFiles(repo: string): Promise<FileDiff[]> {
  const res = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!res.ok) return [];
  const paths = res.out.split("\0").filter(Boolean);
  const out: FileDiff[] = [];
  for (const rel of paths) {
    const abs = resolve(repo, rel);
    try {
      const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer());
      if (isProbablyBinary(bytes)) {
        out.push({
          path: rel,
          name: rel,
          add: 0,
          del: 0,
          status: "binary",
          hunks: [],
          note: `new binary file — ${bytes.length} bytes`,
        });
        continue;
      }
      const content = new TextDecoder().decode(bytes);
      const allLines = content.split("\n");
      // drop trailing empty element from a final newline
      if (allLines.length && allLines[allLines.length - 1] === "") allLines.pop();
      const shown = allLines.slice(0, MAX_UNTRACKED_LINES);
      const hunkLines: DiffLine[] = shown.map((c, i) => ({
        gutter: String(i + 1),
        content: c,
        type: "plus" as const,
      }));
      const file: FileDiff = {
        path: rel,
        name: rel,
        add: allLines.length,
        del: 0,
        status: "added",
        hunks: hunkLines.length
          ? [{ header: `@@ -0,0 +1,${allLines.length} @@ (new file)`, lines: hunkLines }]
          : [],
      };
      if (allLines.length > MAX_UNTRACKED_LINES)
        file.note = `new file truncated — showing first ${MAX_UNTRACKED_LINES} lines`;
      out.push(file);
    } catch {
      // unreadable (perm, fifo) — skip
    }
  }
  return out;
}

export interface ComputeResult {
  repo: string;
  repoName: string;
  base: string;
}

/** Compute the full session input for a repo's current changes vs base (default HEAD). */
export async function computeSessionInput(
  repoArg: string,
  baseArg: string | undefined,
  model: string,
): Promise<SessionInput> {
  const repo = resolve(repoArg);
  // Verify it's a git repo
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`not a git repo: ${repo}\n${top.err.trim()}`);
  const repoRoot = top.out.trim();

  // Resolve base. Default HEAD; if no commits yet, use the empty tree.
  let base = baseArg ?? "HEAD";
  if (base === "HEAD") {
    const head = git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (!head.ok) base = EMPTY_TREE;
  }

  const tracked = git(repoRoot, ["diff", "--no-color", base, "--"]);
  if (!tracked.ok && !tracked.out) {
    throw new Error(`git diff failed: ${tracked.err.trim()}`);
  }
  const trackedFiles = parseUnifiedDiff(tracked.out);
  const untracked = await untrackedFiles(repoRoot);

  // Merge: tracked first (modified/deleted), then new untracked, dedup by path.
  const seen = new Set(trackedFiles.map((f) => f.path));
  const files = [...trackedFiles, ...untracked.filter((f) => !seen.has(f.path))];

  return {
    repo: repoRoot,
    repoName: basename(repoRoot),
    base,
    model,
    files,
  };
}
