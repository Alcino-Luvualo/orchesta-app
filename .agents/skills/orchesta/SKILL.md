---
name: orchesta
description: Use Orchestra Desktop canvases, connected terminals, notes, file trees and browser portals safely.
---

# Orchestra compatibility skill

The canonical instructions are in `skills/orchestra-canvas/SKILL.md`. When this
compatibility name is activated, follow that skill exactly.

Before any connected-node action, run:

```bash
orchestra doctor
orchestra connections
orchestra agents
```

For an interactive terminal, always inspect first:

```bash
orchestra terminal screen <id> --plain
```

Classify the visible state, then use `terminal type` and an intentional
`terminal key`, and inspect again. `inputWritten` is not proof of semantic
delivery. Use only IDs and permissions returned by `orchestra connections`.
To create a connected note, use the authenticated `orchestra note create`
command documented by the canonical skill; never write canvas context or
database files directly.
