# Orchestra bug-fix manual regression

Run this checklist only against the reviewed build. Do not install the package
as part of the build/verification workflow.

## Core lifecycle and connected agents

1. Start one Desktop instance and create a terminal.
2. In that terminal run `orchestra doctor`, `orchestra connections` and
   `orchestra agents`; all three must authenticate and agree on the live
   session.
3. Start a second core with the same socket. It must exit with
   `INSTANCE_CONFLICT` and the first terminal must remain usable.
4. Spawn with `--connect-to self`, then confirm exactly one edge in both the
   canvas and `orchestra connections`.
5. Run `send`, `ask --wait`, a timed-out ask and a cancelled ask. A plain send,
   timeout or cancellation must remain `unverified`; only the completion
   acknowledgement may set `delivered` and `completed`.

## Terminal input

1. Paste 1 KiB, 64 KiB and 256 KiB payloads with bracketed paste both enabled
   and disabled. Compare received bytes; each payload must occur once and no
   Enter may be appended.
2. Click terminal `+`, select a path containing spaces and a single quote, and
   inspect the shell line. It must be one safely quoted word, in the selected
   terminal, exactly once; focusing the terminal must not duplicate it.
3. Click the microphone. Verify the provider/network disclosure appears before
   the permission request. Exercise deny, silence, provider failure, cancel and
   switching terminal. Transcribed chunks may fill the composer progressively
   but must never submit it.

## Browser portal

1. Open a portal, navigate to three visibly different URLs, and for each URL
   resize, hide/show and change floor away/back.
2. Confirm no black/white native rectangle appears before the first frame.
3. After every cycle compare the visible page with `portal screenshot` and
   `portal list`: `attached`, `loading`, `firstFrame`, `visible`, `frozen`,
   `crashed`, `snapshotAvailable` and `snapshotCurrent` must agree.
4. Crash/close and recreate the portal; the old view must not reappear.

## Git graph and cables

1. Select normal, root, merge, rename, binary and empty commits in Git Graph.
   The inspector must show loading, changed paths/status, a textual or binary
   diff, an empty state where appropriate, and a useful error on failure.
2. Change selection quickly while a large diff loads. Only the latest selected
   commit may appear.
3. Select a cable, change a permission, then click **Desconectar**. Confirm the
   edge disappears from the canvas and `orchestra connections`; undo/redo must
   restore/remove it and persistence must survive a reload.

## Agent catalog

1. Open **New Terminal → Agents**. Automatically detected tools must remain in
   **Known agents**.
2. Add a custom agent using a name, executable and one argv option per line;
   edit it, close/reopen the modal and confirm persistence, then remove it.
3. Reject a command containing shell operators. Create a valid custom terminal
   with an option containing spaces and confirm it reaches the process as one
   argv item; configuration itself must not execute anything.
