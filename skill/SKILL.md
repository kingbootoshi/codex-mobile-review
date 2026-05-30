---
name: diff-review
description: Hand a finished session's git diff to Saint's phone for a full-screen, Tinder-style swipe review, then act on his verdict. This is the mobile diff reviewer — it supersedes the old HTML-page diff-review. Fire after you finish an implementation pass in a repo, or when Saint says "diff review", "$diff-review", "review changes", "review the work", "review this on my phone", "mobile review", "send it to review", "let me approve the diff", or "swipe review". Surfaces a URL + scannable QR, blocks until Saint approves or flags each file, then reworks only the flagged files using his per-file note verbatim and leaves approved files untouched.
---

# Diff Review — mobile swipe review loop

Close the loop between finishing work and Saint signing off. Turn the repo's current diff into a session Saint reviews on his phone by swiping each file, wait for his verdict, then rework exactly what he flags and leave what he approves untouched.

You are done when a verdict comes back with **zero flagged files** — every flagged file reworked with its note and re-submitted until nothing is flagged.

Success looks like:
- Saint gets one URL plus a scannable QR that opens a full-screen reviewer of every changed file.
- You wait (poll loop below) until he submits a verdict — approve or flag, per file, with a typed note on flags.
- Every flagged file is reworked using Saint's note as the literal instruction.
- Every approved file is left exactly as-is.

## When to fire

Fire this right after you finish editing in a git repo and want Saint's sign-off. The diff is computed from the working tree, so **commit nothing first** — just finish editing and run the review.

## The loop

### 1. Submit the diff

```bash
codex-review submit --repo "$(pwd)" --model "<your model label, e.g. gpt-5.5 xhigh>"
```

This returns immediately and prints, in order:
- a **scannable QR code** (ASCII, rendered via `qrencode`),
- the phone **URL** on its own line,
- machine-readable tails: `SESSION_ID=<id>`, `REVIEW_URL=<url>`, `REVIEW_STATUS=awaiting`.

Capture `SESSION_ID` and `REVIEW_URL` from those tails — never hardcode a host; always read the URL the CLI prints.

If you see `REVIEW_STATUS=no-changes`, there is nothing to review — tell Saint and stop.

### 2. Surface it to Saint

Show him both ways to open it, then say you are waiting:
- **Tap the link** — paste `REVIEW_URL` so he can tap it directly if he is reading on his phone.
- **Scan the QR** — the QR is right there in your output. From his phone he can screenshot it; iOS detects the QR inside the screenshot in Photos and offers to open the link. From a desktop terminal he points his phone camera at it.

Example line: "Review ready — scan the QR above or tap `<REVIEW_URL>`. Swipe right to approve, left to flag and type what to fix. I'm waiting on your verdict."

### 3. Wait for his verdict (this is how you "background" it)

Codex has no job-control / background tasks — a turn runs commands to completion. So you wait by **polling in a re-run loop**, which keeps each command short while Saint takes his time:

```bash
codex-review wait <SESSION_ID> --timeout 300
```

- **Exit 0** → it prints the verdict JSON between `===CODEX_REVIEW_VERDICT_BEGIN===` and `===CODEX_REVIEW_VERDICT_END===`. Parse that and go to step 4.
- **Exit 75** (prints `STATUS=pending`) → Saint hasn't finished yet. Run the **exact same** `wait` command again. Keep re-running until you get exit 0. This is the normal path — re-running is the wait.

Do not give up after one timeout. Loop the `wait` until a verdict lands (or until Saint tells you to stop).

### 4. Act on the verdict

The verdict JSON:

```json
{ "sessionId":"ab12cd34", "approved":7, "flagged":2,
  "files":[
    {"path":"src/foo.ts","verdict":"approve","note":null},
    {"path":"src/bar.ts","verdict":"flag","note":"rename the helper, this leaks the tenant id"}
  ] }
```

- For every `"verdict":"flag"` file: open it and rework it so it satisfies the `note`. Treat the note as Saint's exact instruction. A small note means a small fix — do the minimal change that resolves the concern, nothing more.
- For every `"verdict":"approve"` file: do not touch it.
- After reworking all flagged files, run `codex-review submit` again for a fresh pass and repeat from step 1. When a verdict returns `flagged:0`, you are done — tell Saint it's clean.

## Notes

- The reviewer runs as a Docker container on the host machine, exposed over Tailscale; Saint opens it on his phone. You don't manage the server — just call the CLI.
- The diff covers tracked changes (vs `HEAD`) plus new untracked files. Binary/oversized files appear as a summary row.
- One review at a time is the common case. The newest submitted session is what the phone shows by default; always pass the explicit `SESSION_ID` to `wait` so you track the right one.
- `codex-review review --repo <path>` does submit + a single long blocking wait in one call — handy for manual/interactive use, but for an agent loop prefer explicit `submit` + re-run `wait` so a timeout never strands you.
