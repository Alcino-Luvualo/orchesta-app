---
name: orchestra-canvas
description: Enables AI coding agents (Claude Code, Antigravity, Codex, OpenCode) to discover canvas connections, inspect connected Markdown notes, read/write project file trees, and orchestrate peer agent terminals.
---

# Orchestra Canvas Context & Multi-Agent Skill

When running inside an Orchestra Desktop terminal node, your session is part of a spatial 2D canvas workspace. You may be connected via physical cables (ropes) to other nodes such as Markdown Notes, File Trees, Browser Portals, or Peer Agent Terminals.

## 1. Discovering Connected Nodes
Orchestra exposes connection state via environment variables and the Orchestra daemon Unix socket:
- **Session ID**: `ORCHESTRA_SESSION_ID` or terminal node ID (e.g. `term_lead`, `term_178602...`)
- **Unix Socket**: `/tmp/orchestra.sock` (or `$XDG_RUNTIME_DIR/orchestra/orchestra.sock`)

You can query the daemon over socket or inspect connected notes/files in the current workspace floor:
- Connected Notes: `.floors/<floor_id>/notes/` or files linked in the canvas layout JSON.
- Connected File Trees: Current working directory (`pwd`).

## 2. Interacting with Connected Markdown Notes
Sticky notes on the canvas are Markdown files readable and writable by agents:
- **Reading a note**: Read the Markdown file content directly to retrieve tasks, specifications, or reviewer feedback.
- **Updating a note**: When completing a task or milestone, update the connected Markdown file (e.g., mark `- [x] Task complete` or append progress logs). The canvas re-renders your edits live in real time!

## 3. Orchestrating Peer Terminals & Agents
If your terminal node is connected to a peer agent terminal (e.g., `Reviewer`, `Frontend Architect`, `Backend Core`):
- You can send instructions, diffs, or review requests to peer agents.
- Delegate subtasks: Write subtask specs into a shared connected note and notify the peer terminal.

## 4. Portals & File Trees
- **File Trees**: Reflect real-time workspace files and Git branch changes.
- **Portals (Browser Nodes)**: Render live previews (e.g. `http://localhost:3000` or Google search). Agents can request screenshot or DOM inspections through the Orchestra IPC bridge.

---
*Use this skill whenever working within Orchestra canvas workspaces to maintain spatial awareness and seamless multi-agent coordination.*
