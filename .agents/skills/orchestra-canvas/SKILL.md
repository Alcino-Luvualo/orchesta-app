---
name: orchestra-canvas
description: Safely operate Orchestra canvas connections, terminals, notes, file trees and browser portals.
---

# Orchestra Canvas

Follow the canonical workspace skill at `skills/orchestra-canvas/SKILL.md`.
The cable graph is an access-control graph: use only nodes returned by
`orchestra connections`.

Run this bootstrap before acting:

```bash
orchestra doctor
orchestra connections
orchestra agents
sed -n '1,240p' "$ORCHESTRA_CONTEXT_DIR/connected_notes.md"
sed -n '1,240p' "$ORCHESTRA_CONTEXT_DIR/context.json"
```

For every interactive action use:

```bash
orchestra terminal screen <id> --plain
orchestra terminal type <id> "text"
orchestra terminal key <id> enter
orchestra terminal wait-for <id> "pattern" --timeout-secs 30
```

Inspect and classify the current screen before writing. `inputWritten` only
proves PTY delivery, never that an agent processed the request. Never expose
`ORCHESTRA_TOKEN` or edit canvas context files directly.
