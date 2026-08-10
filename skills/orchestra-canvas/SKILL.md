---
name: orchestra-canvas
description: Enables agents running inside Orchestra terminals to discover and safely use canvas connections.
---

# Orchestra Canvas

You are running in an Orchestra terminal. The visible cable graph is also an access-control graph: you may only use nodes connected to your terminal.

## Required checks

Run these first:

```bash
orchestra doctor
orchestra connections
orchestra agents
```

- `ORCHESTRA_SESSION_ID` identifies this terminal.
- `ORCHESTRA_TOKEN` is injected by Orchestra. Never print, copy or expose it.
- `ORCHESTRA_CONTEXT_DIR` contains local connection metadata.
- `orchestra connections` is the authoritative list of nodes accessible to you.

## Connected notes

Each connected note is a real Markdown file. Use its node ID from `orchestra connections`:

```bash
orchestra note-read <note-id>
orchestra note-write <note-id> "# New content"
orchestra note-append <note-id> $'\n- [x] Done'
```

Do not write to arbitrary filesystem paths to change a canvas note.

## Connected agents

Only target an active terminal returned by `orchestra agents` that is connected to this terminal:

```bash
orchestra send <terminal-id> "Review the authentication implementation and report findings."
```

Orchestra delivers prompts with bracketed paste. Do not claim a response was received unless it appears in the originating terminal; asynchronous response capture is not available yet.

## Boundaries

Browser and device control commands are unavailable until their portal bridge is installed. Do not edit `canvas_context.json` directly: use the CLI commands above.
