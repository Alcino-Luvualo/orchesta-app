# Orchesta Terminal V2 — Phase Progress

Canonical checkpoint for the phased terminal modernization described in
the original phased goal brief (no longer tracked in the repository).

## Current phase

- Phase: J — Full Performance, Regression + Final Acceptance
- Status: VALIDATING
- Checkpoint: 2026-08-11 (Africa/Luanda)

## Baseline before Phase A

The worktree was already dirty before this task. Existing changes include the
Electron main/preload bridge, renderer terminal node, Rust PTY daemon, socket
protocol/server, workspace UI, and unrelated canvas/application files. Those
changes are preserved and are not attributed to this phase.

Current terminal architecture observed:

`TerminalNode` creates xterm.js, loads Fit/Search/Serialize/Unicode/WebLinks and
optional WebGL addons, batches output onto animation frames, observes its
container with `ResizeObserver`, and sends input/resize through the preload
bridge. Electron main forwards typed-ish request payloads over a framed Unix
socket. `orchestra-core` owns a `portable-pty` session map, broadcasts PTY byte
chunks, stores bounded scrollback, and performs PTY resize/kill operations.

Baseline commands and results:

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo check --workspace` | PASS |
| `cargo test --workspace` | PASS — 9 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite emitted renderer, main, and preload artifacts; chunk-size warning only |
| `npm run test:smoke` | PASS |
| `npm run test:e2e` | BLOCKED by environment: `spawnSync git EPERM` while the harness initializes its temporary Git workspace; core build completed |

Baseline regressions known before Phase A changes:

- Full E2E terminal/workspace flow is not validated because the sandbox denied
  the harness's temporary `git` subprocess. No terminal assertion failed.
- No dedicated terminal lifecycle, resize, PTY backpressure, or selection
  regression suite exists yet.

## Phase A — Terminal Fundamentals

### Scope

- PTY lifecycle and cleanup
- renderer/main/PTY resize consistency
- copy and selection fundamentals
- terminal focus and keyboard ownership fundamentals
- output batching/backpressure needed for stability
- preservation of current real PTY interactive behavior

### Plan

- [x] Audit Electron → IPC → PTY → renderer path
- [x] Add/fix lifecycle, resize, input, selection, and output stability behavior
- [x] Add focused regression coverage
- [x] Run the Phase A validation gate
- [x] Review diff and checkpoint the result

### Files modified during this phase

Phase A terminal changes are in:

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/components/Nodes/TerminalNode.tsx`
- `crates/orchestra-core/src/pty.rs`
- `crates/orchestra-core/src/socket_server.rs`
- `docs/terminal-v2-progress.md`

These files already contained unrelated/user changes before Phase A. The
Phase A work is limited to PTY lifecycle/output delivery, renderer input and
resize handling, terminal focus/copy handling, and cleanup seams in those
files.

### Tests added during this phase

`crates/orchestra-core/src/pty.rs` now covers:

- zero-dimension normalization;
- real PTY input/output round trip;
- 100,000-line streaming output reaching the subscriber;
- explicit kill and post-kill input rejection.

### Validation commands

The focused Phase A checks already run successfully:

- `cargo fmt --all`
- `cargo test --workspace` — PASS, 11 core tests and 0 CLI tests
- `npm --prefix apps/desktop run check` — PASS
- `npm --prefix apps/desktop run build` — PASS; only the existing Vite chunk-size warning
- `npm run test:smoke` — PASS
- `npm run test:e2e` — PASS; real daemon IPC spawn/input/attach/kill flow
- `git diff --check` — PASS

Final gate results:

- `cargo fmt --all -- --check` — PASS
- `cargo test --workspace` — PASS, 11 core tests and 0 CLI tests
- `npm --prefix apps/desktop run check` — PASS
- `npm --prefix apps/desktop run build` — PASS; Vite chunk-size warning only
- `npm run test:smoke` — PASS
- `npm run test:e2e` — PASS; real daemon IPC spawn/input/attach/kill flow
- `git diff --check` — PASS

### Validation results

Phase A is PASS as of 2026-08-11 (Africa/Luanda). The focused PTY test also
verified a 100,000-line stream and explicit process kill.

### Regressions found / fixed

- Replaced the lossy bounded PTY broadcast path with bounded per-subscriber
  queues that apply backpressure to the individual PTY reader.
- Prevented initial shell output from being lost by registering the first
  subscriber before the child process starts.
- Added terminal subscription cleanup on detach, process exit, kill, and
  renderer teardown.
- Coalesced renderer input/output and resize work per animation frame and
  rejected zero-sized resize requests.
- Added app shutdown cleanup for terminals owned by the Electron process.

### Remaining blockers

- No blocker for Phase A.

### Decisions

- Keep xterm.js and `portable-pty` as the current terminal core; Phase A does
  not introduce the later session state machine, shell integration, rich
  editor, or block model.
- Keep PTY ownership independent from React component mount/unmount; explicit
  terminal deletion remains the process-destruction boundary.
- Treat zero-sized renderer measurements as invalid and never forward them to
  the PTY.

## Phase B — Terminal Session + State Machine

### Scope

- independent terminal session/process/view records;
- explicit interaction modes and process lifecycle transitions;
- attach, detach, exit, disconnect, and state event protocol;
- preservation of the real PTY path while shell integration is still pending.

### Implementation checkpoint

Phase B implementation is complete and is undergoing its validation gate. The
new registry keeps process ownership independent from renderer views, so a
component detach does not kill a live PTY. New sessions begin in
`shell_fallback`; later shell-integration phases can promote them to prompt,
running-command, interactive-program, alternate-screen, or password-input
modes through the explicit transition seam.

Files added or modified for Phase B:

- `crates/orchestra-core/src/terminal_session.rs`
- `crates/orchestra-core/src/main.rs`
- `crates/orchestra-core/src/socket_server.rs`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/components/Nodes/TerminalNode.tsx`

### Validation results

Phase B is PASS as of 2026-08-11 (Africa/Luanda).

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo test --workspace` | PASS — 14 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite chunk-size warning only |
| `npm run test:smoke` | PASS |
| `npm run test:e2e` | PASS — real daemon spawn/input/attach/kill flow with state protocol |
| `git diff --check` | PASS |

### Regressions found / fixed

- Added a session registry that separates PTY process ownership from attached
  renderer views.
- Added explicit interaction/process transitions with post-exit rejection and
  disconnected-session handling.
- Added `terminal.state` and `terminal.detach` capability and event paths.
- Made renderer status follow state events while preserving the real PTY in
  `shell_fallback` until shell integration is enabled.

### Remaining blockers

- No blocker for Phase B.

## Phase C — Shell Integration + Prompt/Command Boundaries

### Scope

- OSC 133 prompt/command/command-output/command-finished markers;
- OSC 7 working-directory updates;
- shell bootstrap and fallback behavior;
- parser tests for fragmented and malformed control sequences;
- state transitions from shell markers into the Phase B registry.

Phase C implementation is complete and is undergoing its validation gate as of
2026-08-11 (Africa/Luanda). Its gate will be closed before any Phase D editor
implementation begins.

Files added or modified for Phase C:

- `crates/orchestra-core/src/shell_integration.rs`
- `crates/orchestra-core/src/pty.rs`
- `crates/orchestra-core/src/terminal_session.rs`
- `crates/orchestra-core/src/socket_server.rs`
- `crates/orchestra-core/src/main.rs`
- `apps/desktop/e2e.js`

The shell bootstrap writes only under the terminal's private
`.orchestra/terminals/<session>/shell` directory, sources the user's existing
configuration where supported, and appends hooks for bash, zsh, or fish. The
incremental parser consumes only OSC 133/7 and preserves unknown VT/OSC data.

Tests added during this phase:

- fragmented OSC 133/7 parser coverage;
- C1 OSC and percent-decoded CWD coverage;
- malformed unterminated-control-sequence bound coverage;
- unknown OSC/regular ANSI preservation coverage;
- E2E prompt, command-running, command-finish, exit-code, CWD, and marker
  invisibility assertions for zsh and bash.

### Validation results

Phase C is PASS as of 2026-08-11 (Africa/Luanda).

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo test --workspace` | PASS — 18 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite chunk-size warning only |
| `npm run test:smoke` | PASS |
| `node apps/desktop/e2e.js` | PASS — zsh OSC 133/7 flow |
| `ORCHESTRA_SHELL=/usr/bin/bash node apps/desktop/e2e.js` | PASS — bash OSC 133/7 flow |
| `git diff --check` | PASS |

Fish was not installed (`command -v fish` returned no executable), so its
generated hook path is covered by code review and parser tests but not runtime
smoke-tested in this environment. Unsupported shells remain in
`shell_fallback` and keep the real PTY usable.

### Regressions found / fixed

- zsh initially entered `zsh-newuser-install` because the isolated startup
  directory lacked `.zshenv` and the wrapper was named `zshrc`; adding the
  correct `.zshenv`/`.zshrc` startup files fixed prompt detection without
  touching the user's home directory.
- Shell markers are parsed before history/subscriber delivery, so scrollback
  and visible output contain no OSC 133/7 garbage.
- Unknown OSC and normal ANSI sequences remain byte-preserved.

### Remaining blockers

- No blocker for Phase C. Fish runtime smoke is unavailable because fish is not
  installed; the fallback path remains explicitly supported.

## Phase D — Rich Command Editor

Phase D implementation is complete and is undergoing its validation gate as of
2026-08-11 (Africa/Luanda). The editor is introduced only for confirmed
`shell_prompt` sessions; command-running and interactive PTY modes continue to
own keyboard input.

Files added or modified for Phase D:

- `apps/desktop/src/renderer/components/Nodes/CommandEditorEngine.ts`
- `apps/desktop/src/renderer/components/Nodes/RichCommandEditor.tsx`
- `apps/desktop/src/renderer/components/Nodes/TerminalNode.tsx`
- `apps/desktop/src/renderer/index.css`
- `apps/desktop/test.js`

The editor uses CodeMirror 6 behind a small engine interface. It provides a
real document/caret/selection model, multiline soft wrapping, undo/redo, word
navigation, auto-closing pairs, native composition/IME handling, Unicode-safe
editing, and independent selection from xterm output. The `terminal.richInputV2`
local-storage/property flag can disable it for compatibility. Enter has an
optional `onExecute` seam but no PTY handoff is implemented in this phase.

### Validation results

Phase D is PASS as of 2026-08-11 (Africa/Luanda).

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo test --workspace` | PASS — 18 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite chunk-size warning only |
| `npm run test:smoke` | PASS — CodeMirror/editor architecture assertions |
| `node apps/desktop/e2e.js` | PASS — zsh/PTY regression |
| `ORCHESTRA_SHELL=/usr/bin/bash node apps/desktop/e2e.js` | PASS — bash/PTY regression |
| `git diff --check` | PASS |

### Regressions found / fixed

- Rich input is gated by confirmed `shell_prompt` state, so arrows, Escape,
  Enter, Ctrl+C, mouse reports, and bracketed paste remain xterm-owned while a
  command or interactive program is running.
- The editor is mounted in its own viewport and does not share xterm's output
  selection or DOM focus.

### Remaining blockers

- No blocker for Phase D.

## Phase E — Real PTY Execution + Echo Reconciliation

Phase E implementation is complete and is undergoing its validation gate as of
2026-08-11 (Africa/Luanda). The editor seam is connected to exact PTY writes
and prompt-confirmed handoff; no character-by-character editor syncing is used.

Files added or modified for Phase E:

- `crates/orchestra-core/src/socket_server.rs`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/components/Nodes/TerminalNode.tsx`
- `apps/desktop/e2e.js`

`terminal.execute` is an authenticated, serialized request. It validates the
session is in `shell_prompt`, transitions to `command_running` before writing,
uses the normal readline path for one-line commands, uses bracketed paste for
multiline documents, and returns the xterm focus after handoff. The editor is
removed only after the request succeeds, so the PTY echo is the sole visible
command representation; prompt-ready state remounts a fresh editor. This is
the explicit echo-reconciliation path, with no timing-based hiding.

### Validation results

Phase E is PASS as of 2026-08-11 (Africa/Luanda).

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo test --workspace` | PASS — 18 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite chunk-size warning only |
| `npm run test:smoke` | PASS |
| `node apps/desktop/e2e.js` | PASS — execute, multiline, false, read, Ctrl+C, CWD, attach |
| `ORCHESTRA_SHELL=/usr/bin/bash node apps/desktop/e2e.js` | PASS — same real PTY flow under bash |
| `git diff --check` | PASS |

### Regressions found / fixed

- Rich execution initially used bracketed paste for every command, which made
  zsh redraw a single-line command through its line editor; single-line
  handoff now uses normal readline input and multiline handoff uses bracketed
  paste only when needed.
- Portable `printf` + `read` replaced zsh-incompatible `read -p` in the runtime
  regression flow.

### Remaining blockers

- No blocker for Phase E. Full-screen/TUI-specific smoke remains part of the
  later advanced VT/final acceptance gates.

## Phase F — History, Parser, Completion + Autosuggest

Phase F implementation is complete and is undergoing its validation gate as of
2026-08-11 (Africa/Luanda). The current terminal remains the real PTY while
history/completion services stay isolated from the active shell process.

Files added or modified for Phase F:

- `apps/desktop/src/renderer/components/Nodes/shellCommandParser.ts`
- `apps/desktop/src/renderer/components/Nodes/shellLanguage.ts`
- `apps/desktop/src/renderer/components/Nodes/commandHistory.ts`
- `apps/desktop/src/renderer/components/Nodes/CommandSearchOverlay.tsx`
- `apps/desktop/src/renderer/components/Nodes/completionProviders.ts`
- `apps/desktop/src/renderer/components/Nodes/CommandEditorEngine.ts`
- `apps/desktop/src/renderer/components/Nodes/RichCommandEditor.tsx`
- `apps/desktop/src/renderer/components/Nodes/TerminalNode.tsx`
- `apps/desktop/src/renderer/index.css`
- `crates/orchestra-core/src/socket_server.rs`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/e2e.js`

History entries retain command, CWD, shell, session/terminal/workspace IDs,
start/finish timestamps, duration, and exit code. Ctrl+R selects an entry into
the editor without execution. Completion requests use AbortController and a
monotonic request sequence so stale async results cannot overwrite newer text;
queries are performed through authenticated completion IPC or isolated local
history providers.

### Validation results

Phase F is PASS as of 2026-08-11 (Africa/Luanda).

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo test --workspace` | PASS — 18 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite chunk-size warning only |
| `npm run test:smoke` | PASS — editor/parser/completion architecture assertions |
| `node apps/desktop/e2e.js` | PASS — completion + PTY regression |
| `ORCHESTRA_SHELL=/usr/bin/bash node apps/desktop/e2e.js` | PASS — completion + PTY regression |
| `git diff --check` | PASS |

### Regressions found / fixed

- A completion provider initially borrowed a directory-prefix string from a
  temporary `PathBuf`; it now owns the prefix and passes Rust lifetime checks.
- Bash Ctrl+C validation now waits for the shell's OSC 133 preexec confirmation
  before sending the interrupt, synchronizing with the foreground command
  instead of relying on an arbitrary delay.
- zsh/bash-compatible interactive read coverage uses portable shell syntax.

### Remaining blockers

- No blocker for Phase F. History storage is session-scoped renderer storage;
  durable cross-session history is intentionally outside this phase.

## Phase G — Semantic Command/Output Blocks

Phase G implementation is complete and is undergoing its validation gate as of
2026-08-11 (Africa/Luanda). Blocks consume the already-confirmed
execute/state/output boundaries without replacing xterm's ANSI renderer or
capturing secure/password input.

Files added or modified for Phase G:

- `apps/desktop/src/renderer/components/Nodes/terminalBlocks.ts`
- `apps/desktop/src/renderer/components/Nodes/TerminalBlockList.tsx`
- `apps/desktop/src/renderer/components/Nodes/TerminalNode.tsx`
- `apps/desktop/src/renderer/index.css`
- `crates/orchestra-core/src/socket_server.rs`
- `apps/desktop/test.js`

The model stores exact command/CWD/timestamps/duration/exit state and output as
ordered base64 chunks, preserving ANSI bytes for the terminal renderer. The
list exposes output expansion, copy command/output, and re-input without
execution. Output refreshes are frame-coalesced; the active xterm remains the
source of truth for live VT behavior.

### Validation results

Phase G is PASS as of 2026-08-11 (Africa/Luanda).

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo test --workspace` | PASS — 18 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite chunk-size warning only |
| `npm run test:smoke` | PASS — block model/action architecture assertions |
| `node apps/desktop/e2e.js` | PASS — execute/output/exit/CWD regression |
| `ORCHESTRA_SHELL=/usr/bin/bash node apps/desktop/e2e.js` | PASS — bash block-boundary regression |
| `git diff --check` | PASS |

### Regressions found / fixed

- Output and shell events were initially applied in the wrong order for a PTY
  read containing both command output and OSC 133 completion; output now crosses
  IPC before the semantic completion event, keeping the block tail intact.
- An initial virtualization draft was removed before this checkpoint because
  virtualization is owned by Phase H; G contains only the bounded companion
  list and lifecycle model.

### Remaining blockers

- No blocker for Phase G.

## Phase H — Virtualization, Filter + Actions

Phase H is PASS as of 2026-08-11 (Africa/Luanda). The block list preserves the
semantic model while mounting only visible rows plus overscan, and its filter
operates on derived display text without modifying stored base64 output.

Files added or modified during this phase:

- `apps/desktop/src/renderer/components/Nodes/virtualBlockIndex.ts`
- `apps/desktop/src/renderer/components/Nodes/TerminalBlockList.tsx`
- `apps/desktop/src/renderer/components/Nodes/terminalBlocks.ts`
- `apps/desktop/src/renderer/components/Nodes/TerminalNode.tsx`
- `apps/desktop/src/renderer/index.css`
- `apps/desktop/test.js`

The Fenwick-backed index provides logarithmic offset/index lookup, height
updates, and block jumps. The list observes dynamic row heights, adjusts the
scroll anchor when a preceding row grows, renders an overscan window, and
keeps a sticky command/status header. Filtering supports case-insensitive
literal searches and bounded slash-delimited regular expressions; only
matching output lines are shown and clearing the filter restores the original
decoded output. Collapse/expand, bookmark, re-input, re-run, and copy actions
are attached to block IDs. The store caps retained history at 2,000 blocks.

### Validation results

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo test --workspace` | PASS — 18 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite chunk-size warning only |
| `npm run test:smoke` | PASS — virtualization/filter/action architecture assertions |
| `node --experimental-strip-types --input-type=module -e ...virtualBlockIndex...` | PASS — 1,000-row dynamic-height self-check |
| `node apps/desktop/e2e.js` | PASS — zsh real PTY regression |
| `ORCHESTRA_SHELL=/usr/bin/bash node apps/desktop/e2e.js` | PASS — bash real PTY regression |
| `git diff --check` | PASS |

### Regressions found / fixed

- A row ref was initially typed as `HTMLDivElement` while the virtualized
  content uses semantic `<article>` rows; it now observes `HTMLElement`
  correctly without weakening the ResizeObserver path.
- An empty filtered result initially hid the filter control; the toolbar now
  remains available so the user can clear the non-destructive filter.
- Dynamic row growth now compensates the scroll anchor when a preceding row
  changes height, keeping streaming/expanded output stable.

### Remaining blockers

- No blocker for Phase H.

## Phase I — Advanced VT Behavior, Clipboard + Compatibility

Phase I is PASS as of 2026-08-11 (Africa/Luanda). xterm.js remains the VT
engine, with its supported advanced protocols wired through explicit security
and compatibility seams.

Files added or modified during this phase:

- `apps/desktop/src/renderer/components/Nodes/terminalSecurity.ts`
- `apps/desktop/src/renderer/components/Nodes/TerminalNode.tsx`
- `apps/desktop/src/renderer/components/Nodes/CommandEditorEngine.ts`
- `apps/desktop/src/renderer/components/Nodes/RichCommandEditor.tsx`
- `apps/desktop/src/renderer/components/Nodes/FilesNode.tsx`
- `apps/desktop/src/renderer/index.css`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/global.d.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/test.js`
- `apps/desktop/e2e.js`

Terminal initialization now enables the real xterm.js OSC 8 link handler,
proposed parser API, screen-reader support, Unicode 11, GPU fallback, native
mouse tracking, application cursor behavior, and lossless binary mouse input.
OSC 8 and plain HTTP(S) links require Ctrl/Cmd-click and are sanitized again
in Electron before `shell.openExternal`; file references such as
`src/main.ts:124:15` dispatch into the workspace File Explorer only when they
resolve inside the active workspace.

OSC 52 is intercepted before xterm can expose it. Read/write permissions use
secure `ask` defaults and support allow/deny once or persistently, with no
clipboard data stored in history or blocks. Multiline paste into non-bracketed
raw PTY mode is wrapped in bracketed-paste delimiters; applications that
request bracketed paste retain xterm's native path. Alt-drag is the explicit
Linux local-selection escape hatch when a TUI reports mouse events, while
macOS uses xterm's native selection modifier. BEL and long-command completion
produce non-modal attention/notification feedback. The editor also owns
contextual Ctrl+C/Ctrl+D/Ctrl+L behavior at the shell prompt, and unsupported
or remote shell integration continues to use the real raw PTY fallback.

### Validation results

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo test --workspace` | PASS — 18 core tests, 0 CLI tests |
| `npm --prefix apps/desktop run check` | PASS |
| `npm --prefix apps/desktop run build` | PASS — Vite chunk-size warning only |
| `npm run test:smoke` | PASS — VT/security/fallback architecture assertions |
| `node --experimental-strip-types --input-type=module -e ...terminalSecurity...` | PASS — OSC 52, URL and file-reference self-check |
| `node apps/desktop/e2e.js` | PASS — zsh PTY, TERM, bracketed paste and lifecycle regression |
| `ORCHESTRA_SHELL=/usr/bin/bash node apps/desktop/e2e.js` | PASS — bash equivalent regression |
| `git diff --check` | PASS |
| isolated Electron startup (`--no-sandbox --disable-gpu`) | PASS — renderer/core startup; only environment GPU shutdown diagnostics |

### Regressions found / fixed

- Renderer startup called `workspace.default-path` through the core socket,
  although that request is an Electron-local bridge; it now resolves locally
  and no longer emits an unknown-message error on a clean launch.
- Plain xterm/WebLinks activation previously could open a URI without an
  explicit modifier and used the browser default opener; terminal links now
  require Ctrl/Cmd-click and pass through the safe main-process bridge.
- Non-bracketed multiline paste could reach a raw shell as ordinary newlines;
  a capture-phase guard wraps it before xterm's paste handler.

### Remaining blockers

- No blocker for Phase I. Fish runtime smoke remains unavailable because fish
  is not installed in this environment; unsupported/remote shells retain the
  tested raw fallback path.

## Phase J — Full Performance, Regression + Final Acceptance

Phase J is now VALIDATING as of 2026-08-11 (Africa/Luanda). This final phase
will stress the bounded PTY/block paths, run the complete A–I regression set,
and validate the exact Section 82 editor → real PTY → block → interactive CLI
handoff and return-to-editor behavior before the final checkpoint.
