#!/usr/bin/env bun
// codex-review CLI. Host-side glue: compute the git diff, hand it to the server,
// surface the phone URL, and await the human verdict so a Codex agent can block on it.

import { computeSessionInput } from "./diff.ts";
import type { Verdict } from "./types.ts";

const SERVER = (process.env.CODEX_REVIEW_SERVER ?? "http://127.0.0.1:7799").replace(/\/$/, "");
// Where the phone reaches it (Tailscale). Falls back to SERVER for local use.
const PUBLIC_URL = (process.env.CODEX_REVIEW_PUBLIC_URL ?? SERVER).replace(/\/$/, "");

const VERDICT_BEGIN = "===CODEX_REVIEW_VERDICT_BEGIN===";
const VERDICT_END = "===CODEX_REVIEW_VERDICT_END===";

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

function qr(url: string): void {
  try {
    const p = Bun.spawnSync(["qrencode", "-t", "ANSIUTF8", "-m", "1", url], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode === 0) process.stdout.write(p.stdout.toString());
  } catch {
    /* qrencode not installed — skip, the URL text is enough */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function cmdSubmit(flags: Record<string, string | boolean>): Promise<number> {
  const repo = String(flags.repo ?? process.cwd());
  const base = flags.base ? String(flags.base) : undefined;
  const model = String(flags.model ?? process.env.CODEX_REVIEW_MODEL ?? "");

  const input = await computeSessionInput(repo, base, model);
  if (input.files.length === 0) {
    console.log(`[codex-review] no changes in ${input.repoName} (base ${input.base}) — nothing to review.`);
    console.log("SESSION_ID=");
    console.log("REVIEW_STATUS=no-changes");
    return 0;
  }

  const res = await fetch(`${SERVER}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    console.error(`[codex-review] server rejected session: HTTP ${res.status} ${await res.text()}`);
    return 1;
  }
  const { id } = (await res.json()) as { id: string };
  const url = `${PUBLIC_URL}/s/${id}`;

  const totalAdd = input.files.reduce((n, f) => n + f.add, 0);
  const totalDel = input.files.reduce((n, f) => n + f.del, 0);

  console.log("");
  console.log(`  📱 Review ${input.files.length} file(s) in ${input.repoName}  (+${totalAdd} −${totalDel})`);
  console.log("");
  qr(url);
  console.log("");
  console.log(`  ${url}`);
  console.log("");
  console.log(`SESSION_ID=${id}`);
  console.log(`REVIEW_URL=${url}`);
  console.log(`REVIEW_STATUS=awaiting`);
  return 0;
}

function printVerdict(v: Verdict): void {
  const flagged = v.files.filter((f) => f.verdict === "flag");
  console.log("");
  console.log(`  ✅ ${v.approved} approved   ⚑ ${v.flagged} flagged`);
  if (flagged.length) {
    console.log("");
    console.log("  Flagged files (rework these with the note as the instruction):");
    for (const f of flagged) console.log(`   ⚑ ${f.path}\n      → ${f.note}`);
  }
  console.log("");
  console.log(VERDICT_BEGIN);
  console.log(JSON.stringify(v, null, 2));
  console.log(VERDICT_END);
}

async function cmdWait(id: string, flags: Record<string, string | boolean>): Promise<number> {
  if (!id) {
    console.error("usage: codex-review wait <session-id> [--timeout 600]");
    return 2;
  }
  const timeoutMs = Number(flags.timeout ?? 600) * 1000;
  const start = Date.now();
  let beats = 0;
  while (Date.now() - start < timeoutMs) {
    let res: Response;
    try {
      res = await fetch(`${SERVER}/api/sessions/${id}/wait`);
    } catch (e) {
      // server momentarily unreachable (e.g. restart) — back off and retry
      await sleep(2000);
      continue;
    }
    if (res.status === 404) {
      console.error(`[codex-review] session ${id} not found`);
      return 1;
    }
    if (res.status === 200) {
      const data = (await res.json()) as { verdict: Verdict };
      printVerdict(data.verdict);
      return 0;
    }
    // 204 → no verdict yet; loop (server already held ~25s)
    beats++;
    if (beats % 4 === 0) {
      const secs = Math.round((Date.now() - start) / 1000);
      console.log(`[codex-review] still awaiting review… (${secs}s)`);
    }
  }
  console.log(`STATUS=pending`);
  console.log(`[codex-review] no verdict after ${Math.round(timeoutMs / 1000)}s — re-run: codex-review wait ${id}`);
  return 75; // pending: caller should re-invoke wait
}

async function cmdReview(flags: Record<string, string | boolean>): Promise<number> {
  // submit, capturing id, then block on wait with a long timeout (interactive use)
  const repo = String(flags.repo ?? process.cwd());
  const base = flags.base ? String(flags.base) : undefined;
  const model = String(flags.model ?? process.env.CODEX_REVIEW_MODEL ?? "");
  const input = await computeSessionInput(repo, base, model);
  if (input.files.length === 0) {
    console.log(`[codex-review] no changes in ${input.repoName} — nothing to review.`);
    return 0;
  }
  const res = await fetch(`${SERVER}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    console.error(`[codex-review] server rejected session: HTTP ${res.status}`);
    return 1;
  }
  const { id } = (await res.json()) as { id: string };
  const url = `${PUBLIC_URL}/s/${id}`;
  console.log("");
  qr(url);
  console.log(`\n  ${url}\n`);
  console.log(`[codex-review] awaiting your review on the phone…`);
  return cmdWait(id, { timeout: String(flags.timeout ?? 86400) });
}

async function main(): Promise<number> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  switch (cmd) {
    case "serve":
      await import("./server.ts");
      await new Promise(() => {}); // keep alive
      return 0;
    case "submit":
      return cmdSubmit(flags);
    case "wait":
      return cmdWait(_[1] ?? "", flags);
    case "review":
      return cmdReview(flags);
    case "health": {
      try {
        const r = await fetch(`${SERVER}/api/health`);
        console.log(await r.text());
        return r.ok ? 0 : 1;
      } catch (e) {
        console.error(`unreachable: ${SERVER} (${e})`);
        return 1;
      }
    }
    default:
      console.log(`codex-review — mobile diff review for Codex sessions

usage:
  codex-review submit [--repo <path>] [--base HEAD] [--model "<name>"]
      compute the repo's diff, register a review session, print the phone URL + QR. Returns immediately.
  codex-review wait <session-id> [--timeout 600]
      block until the human submits a verdict. Exit 0 with verdict JSON, or exit 75 (pending) to re-run.
  codex-review review [--repo <path>]
      submit + wait in one call (interactive/manual use).
  codex-review serve
      run the review server (used inside the Docker container).
  codex-review health
      check the server.

env:
  CODEX_REVIEW_SERVER       API base the CLI talks to     (default http://127.0.0.1:7799)
  CODEX_REVIEW_PUBLIC_URL   URL the phone opens           (default = SERVER; set to the Tailscale URL)
  CODEX_REVIEW_MODEL        model label shown in the UI`);
      return cmd ? 1 : 0;
  }
}

main().then((code) => process.exit(code));
