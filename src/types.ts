// Shared data shapes for the Codex Mobile Review system.
// The CLI produces these from git; the server stores them; the Cockpit UI renders them.

export type LineType = "plus" | "minus" | "ctx";

export interface DiffLine {
  /** Display gutter (new line number for plus/ctx, old line number for minus, "" otherwise). */
  gutter: string;
  /** Raw line content with the leading +/-/space already stripped. */
  content: string;
  type: LineType;
}

export interface DiffHunk {
  /** The @@ ... @@ header line. */
  header: string;
  lines: DiffLine[];
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export interface FileDiff {
  /** Repo-relative path. */
  path: string;
  /** Display name (same as path; UI shortens as needed). */
  name: string;
  add: number;
  del: number;
  status: FileStatus;
  hunks: DiffHunk[];
  /** Set for binary/oversized files that carry no line body. */
  note?: string;
}

export type SessionStatus = "reviewing" | "submitted";

export interface ReviewSession {
  id: string;
  repo: string;
  repoName: string;
  base: string;
  model: string;
  createdAt: number;
  status: SessionStatus;
  files: FileDiff[];
  verdict?: Verdict;
}

export type FileDecision = "approve" | "flag";

export interface FileVerdict {
  path: string;
  verdict: FileDecision;
  note?: string | null;
}

export interface Verdict {
  sessionId: string;
  files: FileVerdict[];
  approved: number;
  flagged: number;
  submittedAt: number;
}

/** Payload the CLI POSTs to create a session (server assigns id/createdAt/status). */
export interface SessionInput {
  repo: string;
  repoName: string;
  base: string;
  model: string;
  files: FileDiff[];
}
