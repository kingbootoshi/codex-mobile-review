// Codex Mobile Review server. Serves the Cockpit UI + REST API.
// Repo-agnostic: it only stores what the CLI sends. Runs in Docker on the mini.

import { resolve } from "node:path";
import { SessionStore } from "./db.ts";
import type { FileVerdict, Verdict } from "./types.ts";

const PORT = Number(process.env.PORT ?? process.env.CODEX_REVIEW_PORT ?? 7799);
const DB_PATH = process.env.CODEX_REVIEW_DB ?? resolve(import.meta.dir, "../data/sessions.db");
const WEB_DIR = process.env.CODEX_REVIEW_WEB_DIR ?? resolve(import.meta.dir, "../web");

const store = new SessionStore(DB_PATH);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function html(): Promise<Response> {
  const file = Bun.file(resolve(WEB_DIR, "index.html"));
  if (!(await file.exists())) return new Response("UI not found", { status: 500 });
  return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildVerdict(sessionId: string, files: FileVerdict[]): Verdict {
  const clean = files.map((f) => ({
    path: f.path,
    verdict: f.verdict === "flag" ? "flag" : "approve",
    note: f.verdict === "flag" ? (f.note ?? "").toString().trim() || "flagged for rework" : null,
  })) as FileVerdict[];
  return {
    sessionId,
    files: clean,
    approved: clean.filter((f) => f.verdict === "approve").length,
    flagged: clean.filter((f) => f.verdict === "flag").length,
    submittedAt: Date.now(),
  };
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 60, // allow long-poll requests to stay open
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // --- API ---
    if (path === "/api/health") return json({ ok: true, port: PORT, sessions: store.list(1).length >= 0 });

    if (path === "/api/sessions" && method === "POST") {
      try {
        const body = (await req.json()) as any;
        if (!body?.files || !Array.isArray(body.files)) return json({ error: "files[] required" }, 400);
        const session = store.create({
          repo: String(body.repo ?? ""),
          repoName: String(body.repoName ?? "repo"),
          base: String(body.base ?? "HEAD"),
          model: String(body.model ?? ""),
          files: body.files,
        });
        return json({ id: session.id, status: session.status, files: session.files.length });
      } catch (e) {
        return json({ error: String(e) }, 400);
      }
    }

    if (path === "/api/sessions" && method === "GET") {
      return json(
        store.list().map((s) => ({
          id: s.id,
          repoName: s.repoName,
          status: s.status,
          files: s.files.length,
          createdAt: s.createdAt,
        })),
      );
    }

    if (path === "/api/sessions/current" && method === "GET") {
      const s = store.current();
      return s ? json(s) : json({ error: "no sessions" }, 404);
    }

    // /api/sessions/:id  and  /api/sessions/:id/wait  and  /api/sessions/:id/verdict
    const m = path.match(/^\/api\/sessions\/([A-Za-z0-9]+)(\/(wait|verdict))?$/);
    if (m) {
      const id = m[1]!;
      const sub = m[3];

      if (!sub && method === "GET") {
        const s = store.get(id);
        return s ? json(s) : json({ error: "not found" }, 404);
      }

      if (sub === "wait" && method === "GET") {
        // Long-poll: resolve as soon as a verdict exists, else 204 after ~25s.
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          const s = store.get(id);
          if (!s) return json({ error: "not found" }, 404);
          if (s.status === "submitted" && s.verdict) return json({ status: "submitted", verdict: s.verdict });
          await sleep(500);
        }
        return new Response(null, { status: 204, headers: CORS });
      }

      if (sub === "verdict" && method === "POST") {
        try {
          const body = (await req.json()) as any;
          if (!Array.isArray(body?.files)) return json({ error: "files[] required" }, 400);
          const verdict = buildVerdict(id, body.files);
          const s = store.submitVerdict(id, verdict);
          if (!s) return json({ error: "not found" }, 404);
          return json({ ok: true, verdict });
        } catch (e) {
          return json({ error: String(e) }, 400);
        }
      }
    }

    // --- UI ---
    if (path === "/" || /^\/s\/[A-Za-z0-9]+$/.test(path)) return html();
    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    return new Response("not found", { status: 404, headers: CORS });
  },
});

console.log(`[codex-review] server on http://0.0.0.0:${server.port}  db=${DB_PATH}  web=${WEB_DIR}`);
