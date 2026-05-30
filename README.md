# Codex Mobile Review

Review your coding agent's work from your phone. Finish an implementation pass, run one command, and a full-screen **Tinder-style swipe reviewer** of every changed file lands on your phone. Swipe right to approve, left to flag and type exactly what to fix. The agent waits for your verdict, reworks only the files you flagged using your note verbatim, and re-submits until nothing is flagged.

Built for the loop where an AI coding agent (Codex, Claude, Cursor, …) does the work and you are the reviewer — at your desk or on the go.

<p align="center"><em>submit → swipe on your phone → agent reworks flags → repeat until clean</em></p>

## Why

Reading raw diffs in a terminal is slow, and uncommitted agent work has no PR to review. This gives you a fast, tactile review surface: one card per file, a real diff viewer you scroll inside, approve/flag with a per-file note, and a verdict the agent can act on automatically. The whole thing is one repo-agnostic server plus a tiny CLI.

## How it works

```
agent finishes editing a repo
        │
        ▼
codex-review submit         # CLI computes the git diff locally, POSTs parsed JSON
        │                   # prints a phone URL + scannable QR, returns immediately
        ▼
you open it on your phone   # swipe each file: right = approve, left = flag + note
        │
        ▼
codex-review wait <id>      # agent blocks (poll loop) until you submit a verdict
        │
        ▼
agent reworks flagged files using your notes → submits again → until flagged: 0
```

- **Server** (`src/server.ts`) — a Bun + `bun:sqlite` HTTP service. Repo-agnostic: it only stores sessions and serves the mobile UI. Runs in Docker, published to `127.0.0.1` only.
- **CLI** (`bin/codex-review` → `src/cli.ts`) — runs on any client machine. Computes the diff with git, submits it, prints the URL + QR, and blocks on the verdict. The clients hold no diff data; they just talk to the one server.
- **Mobile UI** (`web/index.html`) — a single self-contained page. Hard scroll-lock so it feels like a native app (only the diff body scrolls), edge-guarded swipe gestures, and a manual "type what to fix" flag sheet.
- **Skill** (`skill/SKILL.md`) — drop-in instructions so an agent fires the loop automatically: submit, surface the QR, wait, rework flags, repeat.

## Same source of truth

The server + database live on **one host**. Every other machine — your laptop, the host itself, your phone — is just a client pointed at it. Submit from your laptop while travelling, or from the host at your desk, and the same review shows up on your phone. Switch machines freely; the review state is one place.

## CLI

```
codex-review submit [--repo <path>] [--base HEAD] [--model "<name>"]
    compute the repo's diff, register a session, print the phone URL + QR. Returns immediately.
codex-review wait <session-id> [--timeout 600]
    block until you submit a verdict. Exit 0 with verdict JSON, or exit 75 (pending) to re-run.
codex-review review [--repo <path>]
    submit + wait in one call (interactive use).
codex-review serve
    run the review server (used inside the Docker container).
codex-review health
    check the server.
```

Environment:

| var | meaning | default |
| --- | --- | --- |
| `CODEX_REVIEW_SERVER` | API base the CLI talks to | `http://127.0.0.1:7799` |
| `CODEX_REVIEW_PUBLIC_URL` | URL the phone opens (your Tailscale URL) | = `CODEX_REVIEW_SERVER` |
| `CODEX_REVIEW_MODEL` | model label shown in the UI | — |

The inline QR uses [`qrencode`](https://fukuchi.org/works/qrencode/) when present; without it the CLI just prints the URL.

## Run it

Requirements: [Bun](https://bun.sh), and Docker for the containerized server.

**Local, one machine:**

```bash
bun run src/server.ts          # or: docker compose up -d --build
codex-review submit --repo .    # open the printed URL
```

**Host + phone over a private network (recommended): [Tailscale](https://tailscale.com).**
Run the container on a host, expose it over your tailnet, and open it from your phone:

```bash
# on the host
docker compose up -d --build
tailscale serve --bg --https=7443 http://127.0.0.1:7799

# point clients at it
export CODEX_REVIEW_SERVER="https://<host>.<tailnet>.ts.net:7443"
export CODEX_REVIEW_PUBLIC_URL="$CODEX_REVIEW_SERVER"
```

`scripts/deploy-mini.sh` automates the host deploy over SSH (rsync → build → tailscale serve → install CLI + skill). Configure it with env, nothing hardcoded:

```bash
MINI=<ssh-host-alias> TS_HOST=<host>.<tailnet>.ts.net bash scripts/deploy-mini.sh
```

## Use it from an agent

Install `skill/SKILL.md` into your agent's skills directory (e.g. `~/.codex/skills/diff-review/SKILL.md`). When the agent finishes editing a repo it runs the loop: `submit` → surface the QR/URL → `wait` (re-running on exit 75) → rework flagged files with your notes → re-submit until `flagged: 0`.

## License

MIT
