---
name: orchestra-canvas
description: Safely operate Orchestra canvas connections, terminals, notes, file trees and browser portals.
---

# Orchestra Canvas — reliable connected work

Connected workspace context is available through the authenticated Orchestra
CLI and the local terminal context files. The visible cable graph is also the
access-control graph: use only nodes connected to this terminal. Never print
or expose `ORCHESTRA_TOKEN`.

## Product and tool boundary

This skill controls **Orchestra Desktop**. Its CLI is `orchestra`, or the exact
executable in `$ORCHESTRA_CLI` when it is not on `PATH`.

- Never use `orca`, `orca-ide`, an Orca skill or an Orca daemon for an
  Orchestra task. The names are similar, but the products and connection
  graphs are unrelated.
- Treat the authenticated `orchestra` subcommands as the API for canvas state.
  Do not substitute generic shell commands, raw PTY automation, direct
  filesystem/database edits or an unrelated browser controller for an
  available Orchestra operation.
- Generic shell commands remain appropriate for ordinary coding and tests
  inside an authorized workspace; this boundary applies to Orchestra nodes,
  connections, messages, notes, portals and lifecycle operations.
- Do not launch `orchestra-desktop` or `orchestra-core` manually as a recovery
  attempt. A second instance can split sockets and authentication state. Stop
  and report a daemon/session failure instead.

## Mandatory bootstrap

At the beginning of every task, run these commands before touching a peer, note, file tree or portal:

```bash
orchestra doctor
orchestra connections
orchestra agents
```

Read `$ORCHESTRA_CONTEXT_DIR/connected_notes.md` and `$ORCHESTRA_CONTEXT_DIR/context.json` directly when local context is needed. Do not discover connected nodes by scanning arbitrary filesystem paths.

`orchestra doctor` also reports the negotiated protocol and capability list. If
the `orchestra` executable is not on `PATH`, use the absolute path in
`$ORCHESTRA_CLI`; never copy or print `$ORCHESTRA_TOKEN` into a command.

All three bootstrap checks must succeed. `doctor` alone is not sufficient: a
session may negotiate the protocol while `connections` or `agents` still fails
authorization. On `Connection refused`, `Unauthorized terminal request`, a
missing socket or disagreement between the three checks, retry the bootstrap
once. If it still fails, stop connected-node work and report the exact failing
command and error. Never borrow a token from another process or session.

## Prefer semantic Orchestra operations

Choose the highest-level authenticated command that represents the intended
action:

- agent delegation: `orchestra send` or `orchestra ask`
- notes: `orchestra note-read`, `note-write`, `note-append` or `note create`
- connected files: `orchestra files` and `orchestra workspace`
- browser portals: `orchestra portal` or its `orchestra browser` alias
- raw interactive TUI control only when no semantic operation can do the job

Do not send a normal agent briefing through `orchestra terminal type`. Large or
multiline PTY input can be duplicated, fragmented or left unsubmitted by an
agent TUI. Use `send`/`ask`; for long context, put the details in an authorized
connected note or file and send a short reference to it.

## Required interactive flow

For the exceptional case that genuinely requires raw interactive terminal
control, follow this exact sequence:

1. Identify the peer in `orchestra connections` or `orchestra agents`.
2. Inspect the current screen with `orchestra terminal screen <id> --plain`.
3. Classify the visible state: `shell`, `permission_prompt`, `agent_ready`, `agent_busy`, `tui` or `unknown`.
4. If it is a permission prompt, ask for approval before sending a confirming key.
5. Write text with `orchestra terminal type <id> "..."`; submit with `orchestra terminal key <id> enter`.
6. Inspect again or use `orchestra terminal wait-for <id> "pattern" --timeout-secs 30`.

`ptyWritten: true` only means that bytes reached the PTY. It does not prove
that an agent received, understood or processed the message. Only a successful
completion acknowledgement may set `delivered`, `agentAcknowledged` and
`completed` to true.

Special keys must use `orchestra terminal key`: `enter`, `shift-enter`,
`ctrl-enter`, `ctrl-shift-enter`, `tab`, `esc`, `up`, `down`, `left`, `right`
and `ctrl-c`. `ctrl-enter`/`shift-enter` are the Ghostty/Kitty modified-Enter
forms used by agent TUIs for an editing newline; plain `enter` submits. Never
simulate special keys with an empty or whitespace prompt.

Keep `terminal type` input short and single-line. After submission, require an
observable state transition, matching output or a structured response. If the
screen is unchanged, classify delivery as unverified; do not repeatedly paste
the payload.

## Connected notes

Use the note node ID from `orchestra connections`; the visible title is not an identifier:

```bash
orchestra note create --title "Research" --content $'# Findings\n'
```

This authenticated command creates a visible note beside the current terminal,
connects it to `self`, and grants only `read`, `write` and `append`
permissions. It returns the generated `noteId`; use that ID for subsequent
operations:

```bash
orchestra note-read <note-id>
orchestra note-write <note-id> "# New content"
orchestra note-append <note-id> $'\n- [x] Done'
```

The nested forms `orchestra note read|write|append` remain available too.
If permission is refused, stop and report the exact reason. Do not edit note
files, `canvas_context.json` or the canvas database directly as a workaround.

`orchestra note-read`, `orchestra note-write` and `orchestra note-append` are
the stable flat aliases for scripts. `orchestra note create` returns the
generated `noteId`; use that ID, not the visible title.

For an existing checklist item, mark `- [ ]` as `- [x]` only after the fix and
its verification are complete. Preserve all other note content and verify the
result with `note-read`. If the note is too large to rewrite safely and the CLI
does not expose a granular checklist update, report that missing capability
instead of appending a duplicate item or editing the Markdown file directly.

## Connected agents

Only target an active terminal returned by `orchestra agents` that is connected to this terminal:

```bash
orchestra send <terminal-id> "Review the authentication implementation and report findings."
orchestra ask <terminal-id> "Review the authentication implementation and report findings." --wait --timeout-secs 90
```

`send` reports `ptyWritten: true` but remains `delivered: false` and
`unverified: true`, because a PTY write is not semantic acknowledgement.
`ask --wait` becomes delivered only after the peer prints the request-specific
completion marker; a timeout, cancellation or partial response must be
reported as unverified. Requests are recorded locally with
`orchestra request-history`.

`orchestra request-history` also accepts the `orchestra requests` alias. Keep
the source terminal connected for `ask --wait`; a delivered write is not proof
that the peer has processed the request.

### Spawning and connection verification

When a task authorizes creating an agent, first create or select its dedicated
worktree, then spawn it from the terminal that should own the connection:

```bash
orchestra terminal spawn --cwd <worktree> --command <agent-command> --connect-to self --title "<title>"
```

The currently supported connection target is `self`. Do not pass an arbitrary
terminal ID unless `orchestra doctor` explicitly advertises that capability.
Immediately rerun `orchestra connections` and `orchestra agents` and require a
visible edge with the needed permissions. A returned `sessionId` proves only
that a terminal was created; it does not prove that it is connected. Do not
delegate work until the edge is confirmed.

## Connected files and workspace

Use only the selected workspace or a connected file-tree node:

```bash
orchestra workspace open
orchestra workspace snapshot --workspace-id <workspace-id>
orchestra files tree --workspace-id <workspace-id> . --depth 6
orchestra files read --workspace-id <workspace-id> path/to/file
orchestra files search --workspace-id <workspace-id> "query" --content
```

Relative paths are resolved below the registered workspace root. The daemon must reject traversal outside it.

## Browser portals

Open a visible portal from a connected Orchestra terminal:

```bash
orchestra portal open https://example.com --connect-to self
orchestra portal inspect <portal-id>
orchestra portal screenshot <portal-id> --output /tmp/portal.png
```

The Desktop process must be running. If it is not, report that the portal
bridge is unavailable and include the socket path from the error; do not create
a fake browser node or use an unrelated browser session. Each Orchestra
instance has a portal socket derived from its exact `ORCHESTRA_SOCKET`
(`<core-socket>.portal.sock`). Keep `ORCHESTRA_PORTAL_SOCKET` when it is
provided by the terminal environment and never guess a shared
`/tmp/portal.sock`.

`orchestra browser` is an alias for `orchestra portal`. Use `orchestra browser
list` to verify that the connected Desktop instance owns the portal before
calling `inspect`, `navigate`, `click`, `type` or `screenshot`.

## Boundaries

Do not edit `canvas_context.json`, `connected_notes.md` or canvas database files directly. Use the CLI or the authorized portal bridge. Never use a node that is not listed by `orchestra connections`.
