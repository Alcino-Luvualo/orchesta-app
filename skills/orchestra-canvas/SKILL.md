---
name: orchestra-canvas
description: Enables AI coding agents (Claude Code, Antigravity, Codex, OpenCode) to discover canvas connections, inspect connected Markdown notes, manipulate browser portals, read/write project file trees, and orchestrate peer agent terminals.
---

# Orchestra Canvas Context & Multi-Agent Skill

When running inside an Orchestra Desktop terminal node, your session is part of a spatial 2D canvas workspace. You may be connected via physical cables (ropes) to other nodes such as Markdown Notes, File Trees, Browser Portals, or Peer Agent Terminals.

## 1. Discovering Connected Nodes
Orchestra exposes connection state via environment variables, `.orchestra/canvas_context.json`, `.orchestra/connected_notes.md`, and the Orchestra daemon Unix socket:
- **Session ID**: `ORCHESTRA_SESSION_ID` or terminal node ID (e.g. `term_lead`, `term_178602...`)
- **Unix Socket**: `/tmp/orchestra.sock` (or `$XDG_RUNTIME_DIR/orchestra/orchestra.sock`)

You can query the daemon over socket or inspect connected notes/files in `.orchestra/`:
- **Connected Notes**: `.orchestra/connected_notes.md` (updates live whenever a note is edited on the canvas).
- **Canvas Context**: `.orchestra/canvas_context.json` (contains all connected nodes, browser URLs, and peer agent IDs).

## 2. Interacting with Connected Markdown Notes
Sticky notes on the canvas are Markdown files readable and writable by agents:
- **Reading a note**: Read `.orchestra/connected_notes.md` or note Markdown files directly to retrieve tasks, specifications, or reviewer feedback.
- **Updating a note**: When completing a task or milestone, update the connected Markdown file (e.g., mark `- [x] Task complete` or append progress logs). The canvas re-renders your edits live in real time!

## 3. Orchestrating Peer Terminals & Agents
If your terminal node is connected to a peer agent terminal (e.g., `Reviewer`, `Frontend Architect`, `Backend Core`):
- You can send instructions, diffs, or review requests to peer agents over PTY relay or socket.
- **Delegating Subtasks**: Write subtask specs into a shared connected note and notify the peer terminal.

## 4. Manipulating Connected Browser Portals & File Trees
- **Browser Portals (Canvas Browsers)**: Portals render live web apps (e.g. `http://localhost:3000` or Google Search). When connected to a Portal:
  - **Navegar / Trocar URL**: O agente pode atualizar a URL do portal conectado no `.orchestra/canvas_context.json` ou via IPC socket `browser.navigate`.
  - **Inspeção & Testes E2E**: Agentes podem inspecionar a interface da aplicação local, preencher formulários, simular testes e verificar rotas.
  - **Pesquisa na Web**: O agente pode aceder ao portal para realizar pesquisas e inspecionar documentação técnica online.
- **File Trees**: Refletem os ficheiros do projeto e estado do Git em tempo real.

---
*Use this skill whenever working within Orchestra canvas workspaces to maintain spatial awareness and seamless multi-agent coordination.*
