---
name: orchesta
description: Trigger immediately whenever the user mentions Orchestra, orchesta, connected notes, canvas, notes, wires, ropes, browser portals, or spatial multi-agent coordination inside Orchestra Desktop. Automatically reads $ORCHESTRA_CONTEXT_DIR/connected_notes.md and $ORCHESTRA_CONTEXT_DIR/context.json directly without executing grep or file searches.
---

# Orchesta Canvas Context & Multi-Agent Skill

When running inside an Orchestra Desktop terminal node (where `ORCHESTRA=1` and `$ORCHESTRA_CONTEXT_DIR` are set), your session is part of a spatial 2D canvas workspace. You are connected via physical cables (ropes) to other nodes such as Markdown Notes, File Trees, Browser Portals, or Peer Agent Terminals.

## 1. MANDATORY DIRECT ACTION (NO GREP OR FILE SEARCHES):
- **ALWAYS** read `$ORCHESTRA_CONTEXT_DIR/connected_notes.md` directly to view notes connected to THIS terminal.
- **ALWAYS** read `$ORCHESTRA_CONTEXT_DIR/context.json` directly to inspect connected browser URLs, peer agent IDs, and file trees connected ONLY to this agent node.
- **DO NOT** execute `grep`, `find`, or manual filesystem searches to discover connected notes. Rely strictly on `$ORCHESTRA_CONTEXT_DIR`.

## 2. Interacting with Connected Markdown Notes:
- **Reading**: Read `$ORCHESTRA_CONTEXT_DIR/connected_notes.md` to retrieve tasks, specifications, or reviewer feedback.
- **Updating**: Write directly to `$ORCHESTRA_CONTEXT_DIR/connected_notes.md` when completing tasks or updating progress. The Orchestra canvas re-renders your edits live in real time.

## 3. Orchestrating Peer Terminals & Agents:
- To delegate subtasks to connected peer agents, write instructions into `$ORCHESTRA_CONTEXT_DIR/connected_notes.md` or communicate via socket.
