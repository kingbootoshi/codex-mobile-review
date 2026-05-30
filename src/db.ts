// Durable session store (bun:sqlite). Persists to a file so in-flight reviews
// survive a container restart — the agent may be awaiting a verdict for a long time.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FileDiff, ReviewSession, SessionInput, Verdict } from "./types.ts";

export class SessionStore {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        repo       TEXT NOT NULL,
        repo_name  TEXT NOT NULL,
        base       TEXT NOT NULL,
        model      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status     TEXT NOT NULL,
        files_json TEXT NOT NULL,
        verdict_json TEXT
      );
    `);
  }

  /** Short, URL-friendly id (first 8 of a uuid is plenty for a personal tool). */
  private newId(): string {
    return randomUUID().replace(/-/g, "").slice(0, 8);
  }

  create(input: SessionInput): ReviewSession {
    const id = this.newId();
    const createdAt = Date.now();
    this.db
      .query(
        `INSERT INTO sessions (id, repo, repo_name, base, model, created_at, status, files_json)
         VALUES (?, ?, ?, ?, ?, ?, 'reviewing', ?)`,
      )
      .run(id, input.repo, input.repoName, input.base, input.model, createdAt, JSON.stringify(input.files));
    return {
      id,
      repo: input.repo,
      repoName: input.repoName,
      base: input.base,
      model: input.model,
      createdAt,
      status: "reviewing",
      files: input.files,
    };
  }

  get(id: string): ReviewSession | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  current(): ReviewSession | null {
    const row = this.db
      .query("SELECT * FROM sessions ORDER BY (status = 'reviewing') DESC, created_at DESC LIMIT 1")
      .get() as any;
    return row ? this.rowToSession(row) : null;
  }

  list(limit = 50): ReviewSession[] {
    const rows = this.db
      .query("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map((r) => this.rowToSession(r));
  }

  submitVerdict(id: string, verdict: Verdict): ReviewSession | null {
    const session = this.get(id);
    if (!session) return null;
    this.db
      .query("UPDATE sessions SET status = 'submitted', verdict_json = ? WHERE id = ?")
      .run(JSON.stringify(verdict), id);
    return this.get(id);
  }

  private rowToSession(row: any): ReviewSession {
    const files = JSON.parse(row.files_json) as FileDiff[];
    const verdict = row.verdict_json ? (JSON.parse(row.verdict_json) as Verdict) : undefined;
    return {
      id: row.id,
      repo: row.repo,
      repoName: row.repo_name,
      base: row.base,
      model: row.model,
      createdAt: row.created_at,
      status: row.status,
      files,
      verdict,
    };
  }
}
