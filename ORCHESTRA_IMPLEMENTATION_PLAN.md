# Orchestra — Plano técnico completo de implementação para Linux

## 1. Decisão de stack

### Decisão recomendada

A aplicação deve usar:

- **Desktop shell:** Electron
- **Interface:** React + TypeScript
- **Build da interface:** electron-vite + Vite
- **Núcleo local:** Rust, executado como daemon/sidecar separado
- **Bridge seguro da interface:** Electron Preload + `contextBridge`
- **Terminal visual:** xterm.js
- **Pseudo-terminal:** Rust com `portable-pty` e extensões POSIX via `nix`
- **Canvas:** React Flow como base inicial, com nodes próprios e renderer SVG próprio para cabos
- **Banco local:** SQLite + SQLx
- **Editor:** CodeMirror 6
- **Browser portals:** Electron `WebContentsView`, com Chromium e automação por Chrome DevTools Protocol
- **Git:** Git CLI do sistema como fonte de verdade
- **Docker, Podman e SSH:** CLIs do sistema controladas pelo core Rust
- **File watcher:** `notify` + regras de ignore
- **Scheduler:** Tokio + persistência SQLite
- **Empacotamento:** electron-builder para AppImage, `.deb` e `.rpm`

Electron não é o frontend. Electron é o runtime desktop. O frontend continua a ser React. A aplicação terá três camadas obrigatórias:

1. Renderer React, responsável pelo design e interação.
2. Electron Main, responsável pelas janelas, Chromium incorporado e integração desktop.
3. Core Rust, responsável pelos processos, PTYs, Git, ficheiros, banco, ambientes e orquestração.

Não usar Node.js como núcleo de negócio. O processo principal do Electron utiliza Node por natureza, mas deve permanecer pequeno e restrito.

---

## 2. Por que Electron e não Tauri neste produto

Tauri seria mais leve e permitiria usar Rust diretamente, mas o design inclui browser portals que devem parecer janelas reais do Chrome, com sessões isoladas, navegação, console, DOM, screenshots e controlo por agentes.

Electron já inclui Chromium e possui `WebContentsView`, permitindo criar páginas web independentes dentro da janela principal. Isso reduz o risco técnico dos portals.

A arquitetura escolhida aceita o maior consumo de memória do Electron porque o produto é um workspace avançado para programadores, não uma aplicação simples de notas.

Para evitar desperdício de recursos, apenas portals selecionados ou visíveis permanecerão vivos. Portals em background serão congelados visualmente através de screenshots.

---

## 3. Auditoria do design atual

### 3.1 O que já está forte

O design já define corretamente:

- canvas escuro e infinito;
- barra superior compacta;
- sidebar de workspaces;
- terminal nodes;
- sticky notes Markdown;
- file tree com modo lista, diff, graph e editor;
- browser portal;
- device portal;
- minimapa;
- zoom;
- toolbar flutuante;
- cabos entre nodes;
- seleção, resize e ferramentas contextuais;
- home com workspaces recentes;
- página de ambientes;
- configurações;
- modais de workspace, agente, ambiente e floor;
- prompt composer com contexto;
- notificações;
- command palette;
- tema claro e escuro;
- Partituras, usadas como templates reutilizáveis do canvas.

O design visual deve ser seguido como fonte principal da implementação.

### 3.2 Alterações obrigatórias antes da implementação completa

#### Inspector

O Inspector já está desenhado no HTML, mas está escondido por CSS. Deve voltar a ser parte funcional da aplicação como painel contextual à direita.

#### Floors

Existe lógica visual de floors em modais e Git, mas falta um floor switcher permanentemente visível na barra superior. Deve mostrar:

- floor atual;
- branch;
- estado Git;
- quantidade de agentes;
- mudanças;
- ação para criar, comparar e fazer landing.

#### Routines

O design atual não possui um Routine Node nem uma página de Routines. É uma ausência importante e deve ser adicionada.

#### Gestão completa de roles

Roles aparecem no modal do agente e no Inspector, mas falta a área completa para:

- criar role;
- editar nome, cor e prompt;
- importar `role.json`;
- descobrir roles no repositório;
- atribuir role ao terminal;
- eliminar role com confirmação.

#### Identidade dos terminais

O terminal deve conservar uma faixa mínima que identifique:

- nome;
- agente;
- role;
- ambiente;
- estado;
- floor.

A moldura tipo terminal nativo pode continuar, mas não deve remover estas informações.

#### Device Portal

A interface atual simula um iPhone. Numa aplicação Linux, a primeira implementação real deve ser Android através de ADB e scrcpy.

O iPhone deve ter uma badge explícita:

`Remote iOS · Mac runner required`

Nunca apresentar o iPhone como se estivesse a executar localmente no Linux.

#### Segurança e permissões

Faltam fluxos completos para:

- agente pedir acesso fora do workspace;
- executar comando perigoso;
- abrir rede;
- controlar portal;
- eliminar ficheiros;
- criar ou remover worktrees;
- importar um workspace não confiável.

#### Estados operacionais

Adicionar designs para:

- processo a iniciar;
- terminal desconectado;
- agente à espera;
- agente bloqueado;
- agente finalizado;
- ambiente indisponível;
- conflito Git;
- recuperação depois de crash;
- workspace movido;
- daemon indisponível;
- portal congelado;
- portal com erro de certificado;
- rotina falhou;
- bridge não instalada.

#### Onboarding e diagnóstico

Adicionar onboarding para verificar:

- Git;
- shell padrão;
- Docker;
- Podman;
- SSH;
- ADB;
- Claude Code;
- Codex;
- OpenCode;
- Ollama opcional;
- permissões do sistema;
- diretórios XDG.

---

## 4. Arquitetura de processos

```text
┌──────────────────────────────────────────────────────────────┐
│                     Electron Application                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ React Renderer                                         │  │
│  │ Canvas · Nodes · xterm.js · CodeMirror · UI            │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │ Typed IPC                          │
│  ┌───────────────────────▼────────────────────────────────┐  │
│  │ Preload                                                │  │
│  │ API mínima, validada e sem exposição direta do Node    │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────▼────────────────────────────────┐  │
│  │ Electron Main                                         │  │
│  │ Window · menus · notifications · WebContentsView       │  │
│  │ Portal manager · updater · native dialogs              │  │
│  └───────────────────────┬────────────────────────────────┘  │
└──────────────────────────┼───────────────────────────────────┘
                           │ Unix socket + MessagePack
┌──────────────────────────▼───────────────────────────────────┐
│                     orchestra-core                           │
│                        Rust daemon                           │
│                                                              │
│ Workspace · SQLite · PTY · Agents · Connections · Git        │
│ Files · Search · Environments · Floors · Routines · Security │
└───────┬─────────────┬─────────────┬──────────────┬───────────┘
        │             │             │              │
      PTYs          Git CLI    Docker/Podman     OpenSSH
        │
 Bash · Zsh · Fish · Claude · Codex · OpenCode

┌──────────────────────────────────────────────────────────────┐
│ orchestra CLI — Rust                                         │
│ ask · list · note · role · recruit · dismiss · routine       │
└──────────────────────────┬───────────────────────────────────┘
                           │ Unix socket ou bridge remoto
                           ▼
                    orchestra-core
```

### 4.1 React Renderer

Pode apenas:

- renderizar dados;
- enviar comandos tipados;
- receber eventos;
- gerir estado visual temporário;
- controlar interação do canvas;
- renderizar terminal e editor.

Não pode:

- ler ficheiros diretamente;
- executar comandos;
- usar `child_process`;
- aceder ao banco;
- guardar secrets;
- controlar Git diretamente;
- criar browsers arbitrários.

### 4.2 Electron Main

Responsável por:

- ciclo de vida da aplicação;
- janela principal;
- tray opcional;
- menu nativo;
- notificações;
- atalhos globais autorizados;
- diálogos de seleção de diretório;
- integração com editores externos;
- `WebContentsView` dos portals;
- sessões e cookies dos portals;
- atualização automática;
- arranque e reconexão ao daemon Rust;
- bridge de eventos de alto volume para o renderer.

### 4.3 Rust daemon

É a fonte de verdade do produto.

Responsável por:

- banco de dados;
- workspaces;
- floors;
- nodes e edges;
- processos;
- PTYs;
- deteção de estado dos agentes;
- filas de mensagens;
- CLI bridge;
- notas;
- ficheiros;
- Git;
- indexação;
- ambientes;
- rotinas;
- auditoria;
- permissões;
- recuperação de sessões.

### 4.4 Orchestra CLI

Binário separado instalado em:

```text
~/.local/bin/orchestra
```

Comandos iniciais:

```bash
orchestra status
orchestra list
orchestra ask "Reviewer" "Revê o diff atual"
orchestra ask "Tester" --raw $'\x03'
orchestra note read "Specification"
orchestra note write "Specification" --stdin
orchestra note append "Progress" "Testes concluídos"
orchestra role show "Reviewer"
orchestra role write "Reviewer" --stdin
orchestra recruit --agent codex --role Reviewer
orchestra dismiss "Reviewer"
orchestra routine create
orchestra notify "Build concluído"
```

---

## 5. Stack detalhada

### 5.1 Desktop e frontend

| Área | Tecnologia |
|---|---|
| Desktop runtime | Electron |
| Renderer | React + TypeScript |
| Bundler | electron-vite |
| Package manager | pnpm |
| Canvas | `@xyflow/react` com nodes e edges próprios |
| Estado visual | Zustand |
| Formulários | React Hook Form + Zod |
| Terminal | `@xterm/xterm` |
| Terminal addons | fit, search, web-links, unicode, WebGL |
| Editor | CodeMirror 6 |
| Acessibilidade de modais | Radix primitives |
| Ícones | Lucide |
| Estilos | CSS Modules + CSS variables |
| Testes unitários | Vitest + Testing Library |
| Testes E2E | Playwright Electron |

Não usar uma biblioteca visual que altere o design. Radix será usado apenas como primitive comportamental.

### 5.2 Electron Main

| Área | Tecnologia |
|---|---|
| IPC | `ipcMain`, `ipcRenderer`, MessagePort |
| Portal | `WebContentsView` |
| Automação do portal | Chrome DevTools Protocol através de `webContents.debugger` |
| Packaging | electron-builder |
| Update | electron-updater ou serviço próprio assinado |
| Logs | electron-log, encaminhado para o core quando aplicável |

### 5.3 Rust

| Área | Crate/tecnologia |
|---|---|
| Runtime assíncrono | Tokio |
| Serialização | Serde |
| Protocolo binário | `rmp-serde` |
| Banco | SQLx + SQLite |
| Erros | thiserror + anyhow nas bordas |
| Logs | tracing + tracing-subscriber |
| PTY | portable-pty |
| POSIX/process groups | nix |
| File watcher | notify |
| Percurso de ficheiros | ignore + walkdir |
| IDs | uuid |
| Scheduler | cron + Tokio |
| HTTP local opcional | Axum |
| Linux D-Bus | zbus |
| Secrets | Secret Service/keyring através de Rust |

### 5.4 Ferramentas do sistema

- `git`;
- `ssh`;
- `scp` e `sftp` quando necessário;
- `docker`;
- `podman`;
- `adb`;
- `scrcpy`;
- `rg`;
- `fd`, opcional;
- shells instalados pelo utilizador.

---

## 6. Estrutura do repositório

```text
orchestra/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── main/
│       │   ├── preload/
│       │   └── renderer/
│       ├── resources/
│       └── electron-builder.yml
├── packages/
│   ├── ui/
│   ├── canvas/
│   ├── design-tokens/
│   ├── protocol-ts/
│   └── test-fixtures/
├── crates/
│   ├── orchestra-core/
│   ├── orchestra-daemon/
│   ├── orchestra-cli/
│   ├── orchestra-protocol/
│   ├── orchestra-db/
│   ├── orchestra-workspace/
│   ├── orchestra-terminal/
│   ├── orchestra-agent/
│   ├── orchestra-connections/
│   ├── orchestra-notes/
│   ├── orchestra-files/
│   ├── orchestra-git/
│   ├── orchestra-environments/
│   ├── orchestra-routines/
│   └── orchestra-security/
├── migrations/
├── scripts/
├── fixtures/
├── docs/
├── pnpm-workspace.yaml
├── Cargo.toml
└── package.json
```

---

## 7. Persistência e diretórios Linux

Seguir XDG Base Directory.

```text
~/.config/orchestra/
├── settings.json
└── permissions.json

~/.local/share/orchestra/
├── orchestra.db
├── workspaces/
│   └── <workspace-id>/
│       ├── notes/
│       ├── attachments/
│       ├── snapshots/
│       └── browser-data/
└── roles/

~/.local/state/orchestra/
├── logs/
└── crash-recovery/

$XDG_RUNTIME_DIR/orchestra/
├── orchestra.sock
├── daemon.pid
└── sessions/
```

### Banco SQLite

Ativar:

- WAL;
- foreign keys;
- busy timeout;
- migrations versionadas;
- transações para alterações de canvas;
- snapshots periódicos.

### Tabelas principais

```text
workspaces
workspace_recent
floors
canvas_nodes
canvas_edges
node_groups
terminal_sessions
terminal_snapshots
agent_presets
agent_instances
roles
role_assignments
notes
note_links
file_tree_states
browser_sessions
device_sessions
environments
connection_permissions
agent_messages
routines
routine_steps
routine_runs
permissions
audit_events
notifications
settings
schema_migrations
```

### Notes

Notas são ficheiros Markdown reais.

O banco guarda:

- ID;
- nome;
- path;
- workspace;
- hash;
- posição no canvas;
- modo raw/preview;
- cor;
- estado de sincronização.

---

## 8. Protocolo entre Electron e Rust

Usar Unix domain socket:

```text
$XDG_RUNTIME_DIR/orchestra/orchestra.sock
```

Formato:

```text
4 bytes de tamanho
payload MessagePack
```

Cada mensagem contém:

```ts
type Envelope = {
  protocolVersion: number;
  requestId?: string;
  eventId?: string;
  workspaceId?: string;
  type: string;
  payload: unknown;
};
```

Tipos principais:

```text
workspace.open
workspace.close
workspace.snapshot
canvas.node.create
canvas.node.update
canvas.node.delete
canvas.edge.create
canvas.edge.delete
terminal.spawn
terminal.input
terminal.resize
terminal.kill
terminal.output
terminal.status
agent.message.send
agent.message.received
note.read
note.write
file.search
git.status
git.diff
floor.create
floor.land
environment.connect
routine.create
routine.run
permission.request
permission.resolve
```

Para output de terminal, usar MessagePorts no Electron para não sobrecarregar o canal normal de IPC.

---

## 9. Canvas

### Modelo

O canvas deve utilizar React Flow inicialmente, mas com aparência completamente própria.

React Flow fornece:

- viewport;
- pan;
- zoom;
- seleção;
- multi-seleção;
- nodes customizados;
- edges customizadas;
- minimapa;
- atalhos básicos.

A física dos cabos será implementada num edge renderer próprio.

### Tipos de node

```text
terminal
note
files
browser
device
routine
text
shape
drawing
image
video
pdf
group
```

### Estado persistido de um node

```ts
type CanvasNodeRecord = {
  id: string;
  workspaceId: string;
  floorId: string | null;
  kind: NodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  locked: boolean;
  collapsed: boolean;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

### Regras

- salvar alterações com debounce de 250–500 ms;
- salvar imediatamente ao criar ou eliminar;
- undo/redo local com journal;
- impedir nodes de ficarem totalmente fora do alcance;
- auto-layout apenas quando pedido;
- não mover nodes automaticamente depois do utilizador os reposicionar;
- virtualizar nodes complexos fora do viewport;
- suspender rendering de terminal invisível;
- limitar animações em canvases densos.

### Partituras

Partituras tornam-se templates reais.

Devem guardar:

- nodes;
- dimensões;
- posições relativas;
- conexões;
- roles;
- tipos de agentes;
- notas opcionais;
- rotina opcional;
- regras de ambiente sem secrets.

Nunca guardar:

- tokens;
- cookies;
- conteúdo privado de terminal;
- chaves SSH;
- passwords.

---

## 10. Terminais e PTY

### Fluxo

```text
TerminalNode React
    ↓ input
Preload
    ↓ MessagePort
Electron Main
    ↓ Unix socket
Rust Terminal Manager
    ↓ PTY master
bash/zsh/fish
    ↓
Claude/Codex/OpenCode
```

### TerminalSession

```rust
struct TerminalSession {
    id: Uuid,
    workspace_id: Uuid,
    floor_id: Option<Uuid>,
    environment_id: Uuid,
    agent_id: Option<Uuid>,
    cwd: PathBuf,
    shell: String,
    command: Vec<String>,
    pid: Option<u32>,
    process_group_id: Option<i32>,
    cols: u16,
    rows: u16,
    status: TerminalStatus,
}
```

### Estados

```text
CREATED
STARTING
RUNNING
STREAMING
WAITING_USER
IDLE
COMPLETED
FAILED
DISCONNECTED
TERMINATED
RESTORING
```

### Requisitos

- TTY real;
- ANSI 24-bit;
- resize;
- clipboard;
- search;
- links;
- Ctrl+C, Ctrl+D, Ctrl+Z;
- signals para process group;
- scrollback configurável;
- backpressure;
- restore seguro;
- monitorização de atividade;
- atenção quando o agente para e aguarda input;
- abrir modo focus;
- número rápido para navegar entre terminais.

### Deteção de estado

Combinar:

1. output recente;
2. prompt do shell;
3. OSC shell integration;
4. adapter específico do agente;
5. eventos explícitos da CLI Orchestra;
6. timeout apenas como fallback.

Nunca assumir que silêncio significa conclusão.

---

## 11. Agentes e roles

### AgentPreset

```rust
struct AgentPreset {
    id: String,
    display_name: String,
    executable: String,
    default_args: Vec<String>,
    version_command: Vec<String>,
    role_strategy: RoleStrategy,
    supports_raw_input: bool,
    supports_manager_mode: bool,
}
```

Presets iniciais:

- Claude Code;
- Codex;
- OpenCode;
- Gemini CLI;
- Aider;
- shell genérico;
- comando customizado.

### Role

```text
name
badge color
instructions
allowed tools
recommended agent
created source
role.json path
```

Ao iniciar um agente:

1. resolver workspace, floor e ambiente;
2. criar runtime dir;
3. criar ou sincronizar `CLAUDE.md` e `AGENTS.md` conforme o adapter;
4. escrever `role.json`;
5. definir variáveis `ORCHESTRA_*`;
6. garantir acesso à CLI;
7. iniciar o PTY;
8. registar estado;
9. emitir evento para o renderer.

---

## 12. Conexões e comunicação entre agentes

### Tipos de conexão

```text
agent ↔ agent
agent ↔ note
agent ↔ file tree
agent ↔ browser
agent ↔ device
agent ↔ routine
note ↔ note
```

### Permissões da conexão

```text
read
write
send_prompt
receive_response
control
share_context
bidirectional
```

### Fluxo de mensagem

```text
Agent A executa orchestra ask Reviewer "Revê o módulo"
    ↓
CLI envia AgentMessageRequest ao daemon
    ↓
Daemon valida edge e permissões
    ↓
Mensagem entra na fila do Reviewer
    ↓
Daemon escreve o prompt no PTY do Reviewer
    ↓
Reviewer trabalha
    ↓
Reviewer chama orchestra respond <correlation-id>
    ↓
Daemon entrega resposta ao Agent A
```

### Fallback

Se o agente não chamar `respond`:

- detetar retorno ao prompt;
- pedir confirmação ao utilizador;
- permitir “Marcar resposta como concluída”;
- nunca devolver output parcial silenciosamente.

### Fila

Cada agente possui fila serial por padrão.

Opções:

- rejeitar quando ocupado;
- enfileirar;
- interromper tarefa atual;
- executar num novo recruta.

---

## 13. Prompt Composer

Deve seguir o design atual e suportar:

- `@agente`;
- `/ficheiro`;
- `#nota`;
- diff Git;
- floor;
- browser portal;
- seleção atual do editor;
- screenshot;
- múltiplos destinos;
- sequência;
- paralelo;
- criação de tarefa;
- histórico.

Antes do envio, mostrar o contexto exato que será partilhado.

O frontend cria um `PromptRequest`; o core resolve paths, permissões e destinos.

---

## 14. Notes

### Funcionalidades

- Markdown raw e preview;
- headings;
- checklists;
- tabelas;
- code blocks;
- links;
- imagens coladas;
- renomear;
- mover ficheiro;
- notes chaining;
- leitura/escrita por agentes;
- conflito externo;
- histórico local opcional.

### Segurança

O parser de Markdown deve sanitizar HTML.

Links externos abrem através de uma confirmação ou allowlist.

Imagens incorporadas são copiadas para attachments, salvo quando o utilizador escolhe link externo.

---

## 15. File Tree e editor

### File Tree

- múltiplos file trees no mesmo canvas;
- estado independente;
- lista;
- ícones;
- pesquisa por nome;
- pesquisa por conteúdo;
- Git changes;
- diff;
- commits;
- rename;
- move;
- delete;
- criar ficheiro/pasta;
- drag para agente;
- drag para canvas;
- abrir no editor interno;
- abrir no editor externo.

### Indexação

Usar:

- watcher `notify`;
- `ignore` para `.gitignore`;
- ripgrep para pesquisa de conteúdo;
- cache SQLite FTS5 para notas e metadados;
- debounce de eventos.

Ignorar por padrão:

```text
.git
node_modules
dist
build
target
.next
.cache
vendor
```

### Editor

CodeMirror 6 com:

- tabs;
- syntax highlight;
- find/replace;
- save;
- dirty state;
- encoding detection;
- line endings;
- diff;
- limite de tamanho;
- fallback para editor externo em ficheiros gigantes ou binários.

---

## 16. Git

Usar o Git instalado pelo utilizador para manter comportamento compatível com:

- credentials;
- hooks;
- aliases relevantes;
- SSH agent;
- signing;
- config global;
- submodules;
- LFS.

### Operações

```text
status
diff
log
show
add
restore
commit
pull
push
fetch
checkout
switch
branch
merge
rebase
cherry-pick
revert
stash
tag
worktree
```

### Segurança

Ações destrutivas exigem confirmação:

- reset hard;
- clean;
- force push;
- apagar branch;
- remover worktree com alterações;
- rebase com working tree suja.

### Hooks

Mostrar claramente quando um hook será executado.

Permitir desativar hooks apenas como ação explícita e temporária.

---

## 17. Floors

No Linux, floors usam `git worktree`.

### Estrutura

```text
~/.local/share/orchestra/worktrees/<workspace-id>/<floor-id>/
```

### Criar floor

1. validar que o projeto é Git;
2. atualizar referências;
3. escolher branch base;
4. criar branch;
5. criar worktree;
6. copiar configuração permitida;
7. executar setup hook autorizado;
8. criar layout do floor;
9. iniciar agentes opcionais.

### Landing

1. verificar alterações não guardadas;
2. executar testes configurados;
3. calcular commits e diff;
4. detectar conflitos;
5. mostrar preview;
6. escolher merge, rebase, squash ou cherry-pick;
7. aplicar;
8. validar resultado;
9. remover worktree apenas com confirmação;
10. manter log de auditoria.

### Floor UI

Adicionar:

- switcher na topbar;
- painel de floors;
- modal Create Floor;
- modal Compare Floors;
- modal Land Floor;
- conflito visual;
- estado de agentes por floor.

---

## 18. Environments

### Interface Rust

```rust
trait RuntimeAdapter {
    async fn probe(&self) -> Result<RuntimeInfo>;
    async fn spawn_pty(&self, request: SpawnRequest) -> Result<SessionId>;
    async fn exec(&self, request: ExecRequest) -> Result<ExecResult>;
    async fn install_bridge(&self) -> Result<BridgeInfo>;
    async fn resolve_path(&self, path: &str) -> Result<ResolvedPath>;
    async fn shutdown(&self) -> Result<()>;
}
```

### Local

- shell e processos diretamente no host;
- PTY POSIX;
- acesso limitado ao workspace conforme permissões.

### Docker e Podman

- detectar containers;
- `exec -it`;
- mapear diretório;
- mapear CLI bridge;
- mostrar estado do container;
- iniciar container apenas com confirmação;
- nunca montar diretórios secretos automaticamente.

### SSH

Usar OpenSSH do sistema para respeitar:

- `~/.ssh/config`;
- ssh-agent;
- ProxyJump;
- hardware keys;
- known_hosts.

A bridge remota usa túnel para um endpoint local autenticado por token temporário.

### Custom runtime

Configuração avançada com placeholders:

```text
{workspace}
{command}
{cols}
{rows}
{bridge_endpoint}
```

---

## 19. Browser Portals

### Implementação

Cada portal possui:

- `WebContentsView`;
- session partition própria;
- cookies próprios;
- cache próprio;
- permissões próprias;
- URL allowlist opcional;
- screenshot atual;
- histórico;
- console;
- network log;
- DOM snapshot;
- accessibility tree.

### Estratégia híbrida de performance

Estado `LIVE`:

- portal selecionado;
- WebContentsView visível;
- input real;
- automação ativa.

Estado `FROZEN`:

- screenshot no node React;
- WebContentsView escondido ou suspenso;
- ativado novamente ao focar.

Durante pan e zoom:

- mostrar screenshot;
- reposicionar WebContentsView apenas no fim ou com throttle;
- evitar jitter e custo de layout.

### API para agentes

```bash
orchestra portal list
orchestra portal open "Login" http://localhost:3000/login
orchestra portal click "Login" --selector '#submit'
orchestra portal fill "Login" --selector '#email' --value 'test@example.com'
orchestra portal screenshot "Login"
orchestra portal text "Login" --selector 'main'
orchestra portal console "Login"
```

### Segurança

- `nodeIntegration: false`;
- `contextIsolation: true`;
- sandbox ativo;
- sem APIs Electron expostas;
- bloquear popups;
- validar downloads;
- validar navegação;
- permission request handler;
- CSP para a interface local;
- partitions independentes;
- limpar sessão quando pedido.

---

## 20. Device Portal

### Android — implementação local

- ADB discovery;
- devices físicos;
- Android Emulator;
- screenshot;
- input tap/swipe/text;
- orientation;
- logs;
- accessibility tree;
- streaming por scrcpy;
- controlo pelo agente.

### iOS

Não executar simulador iOS no Linux.

Arquitetura futura:

```text
Orchestra Linux
    ↓ SSH/WebSocket seguro
Orchestra Mac Runner
    ↓
Xcode Simulator / dispositivo iOS
```

O design deve distinguir Android local e iOS remoto.

---

## 21. Routines

### Modelo

```rust
struct Routine {
    id: Uuid,
    workspace_id: Uuid,
    target_agent_id: Uuid,
    name: String,
    schedule: RoutineSchedule,
    enabled: bool,
    timeout_seconds: u64,
    retry_policy: RetryPolicy,
}
```

### Triggers

- intervalo;
- cron;
- ao abrir workspace;
- após commit;
- após mudança de ficheiro;
- após agente concluir;
- após rotina concluir;
- manual.

### Chain

Separar steps através de linha contendo apenas:

```text
&&
```

O próximo step só começa após sucesso do anterior.

### Proteções

- timeout;
- máximo de retries;
- cooldown;
- limite por hora;
- confirmação para ações perigosas;
- impedir ciclos entre routines;
- histórico completo;
- botão stop.

### Design a acrescentar

- Routine Node;
- página Routines;
- editor;
- histórico;
- logs;
- estado paused/running/failed;
- ação Run Now.

---

## 22. Conductor

Conductor é um agente com permissões de gestão.

Pode:

- recrutar;
- atribuir role;
- escolher environment;
- escolher floor;
- conectar notas;
- conectar agentes;
- criar rotina;
- terminar recrutas;
- emitir notificações.

Não recebe permissões ilimitadas automaticamente.

Matriz de permissões:

```text
recruit_agents
dismiss_agents
create_connections
create_floors
land_floors
create_routines
control_portals
modify_roles
run_host_commands
```

Todas as ações do Conductor entram no audit log.

---

## 23. Segurança

### Renderer

- sem Node integration;
- context isolation;
- sandbox;
- preload mínimo;
- CSP restritiva;
- custom protocol `orchestra://app`, não `file://`;
- validação Zod de todo IPC;
- validar sender.

### Core

- canonicalizar paths;
- impedir `..` e escapes por symlink;
- allowlist por workspace;
- process groups;
- timeouts;
- tokens temporários para bridge;
- socket `0600`;
- verificar UID do peer quando possível;
- secrets fora do SQLite;
- audit log.

### Permissões por agente

```text
read_workspace
write_workspace
execute_commands
network_access
control_browser
control_device
message_agents
recruit_agents
create_floor
delete_files
access_outside_workspace
```

### Importação

Workspaces e Partituras importadas abrem em modo não confiável:

- routines pausadas;
- hooks desativados;
- commands não executados;
- paths validados;
- preview antes da importação.

---

## 24. Recuperação e ciclo de vida

### Fechar a janela

Opções:

- perguntar sempre;
- manter agentes em background;
- terminar agentes;
- minimizar para tray.

### Daemon

O daemon deve poder continuar ativo sem a janela.

Fase inicial:

- processo sidecar detached;
- lock file;
- reconnect automático.

Fase estável:

- user service do systemd opcional.

### Crash recovery

Guardar:

- PID;
- estado da sessão;
- tamanho PTY;
- cwd;
- agente;
- floor;
- último snapshot visual;
- últimos eventos não sensíveis.

Após crash:

- reconectar a processos vivos;
- marcar processos perdidos;
- restaurar layout;
- mostrar relatório;
- não reiniciar comandos destrutivos automaticamente.

---

## 25. Performance

### Metas

- pan e zoom próximos de 60 FPS num canvas normal;
- input de terminal percebido abaixo de 50 ms localmente;
- abrir workspace comum em menos de 2 s sem restaurar agentes;
- autosave sem bloquear a interface;
- pesquisa por nome quase instantânea depois do índice;
- 30 terminais ativos suportados no cenário de stress;
- 500 nodes simples no canvas;
- 100 conexões animadas sem queda grave;
- 3 portals live por padrão;
- portals adicionais congelados.

### Técnicas

- batching de output PTY a cada frame ou 8–16 ms;
- ring buffer por terminal;
- WebGL addon do xterm;
- suspender terminal fora do viewport;
- stagger no restore de agentes;
- screenshots para portals inativos;
- watchers com debounce;
- SQLite WAL;
- queries preparadas;
- não persistir a cada pixel do drag;
- persistir no fim do drag e por debounce.

---

## 26. Testes

### 26.1 Rust unit tests

- path sandbox;
- symlink escape;
- protocolo;
- migrations;
- role injection;
- estado do agente;
- scheduler;
- routine chain;
- fila de mensagens;
- floor command builder;
- parsing Git;
- permission evaluator;
- snapshot recovery.

### 26.2 PTY integration tests

Testar:

- bash;
- zsh;
- fish;
- resize;
- UTF-8;
- ANSI;
- Ctrl+C;
- Ctrl+D;
- process groups;
- vim;
- less;
- htop;
- agente mock interativo;
- processo que gera muito output;
- processo silencioso;
- processo filho órfão.

### 26.3 Renderer unit tests

- node rendering;
- toolbar;
- keyboard shortcuts;
- Inspector;
- Prompt Composer;
- role editor;
- routine editor;
- connection permissions;
- error states;
- focus management;
- reduced motion.

### 26.4 Electron E2E

- criar workspace;
- selecionar diretório;
- criar terminal;
- escrever no PTY;
- resize;
- criar note;
- ligar terminal e note;
- guardar e reabrir;
- abrir file tree;
- editar ficheiro;
- criar floor;
- abrir portal;
- isolar cookies;
- executar routine;
- fechar com agente ativo;
- recuperar depois de crash.

### 26.5 Segurança

- remote page sem Node;
- popup bloqueado;
- navegação maliciosa;
- IPC sender inválido;
- payload inválido;
- path traversal;
- symlink traversal;
- socket de outro utilizador;
- token expirado;
- import malicioso;
- comando destrutivo sem confirmação.

### 26.6 Git

- repo normal;
- detached HEAD;
- untracked files;
- submodule;
- LFS;
- merge conflict;
- rebase conflict;
- worktree locked;
- branch já existente;
- dirty worktree;
- signed commit;
- hook falhou.

### 26.7 Ambientes

- Docker running/stopped;
- Podman rootless;
- SSH password;
- SSH key;
- ProxyJump;
- conexão perdida;
- bridge ausente;
- path remoto diferente;
- container sem shell esperado.

### 26.8 Carga

Cenários:

```text
30 terminais ativos
500 nodes
100 cabos
50.000 ficheiros
1 GB de output acumulado
10 workspaces em background
10 floors
10 routines simultâneas
10 portals, 3 live
```

### 26.9 Matriz Linux

- Ubuntu;
- Debian;
- Fedora;
- Arch;
- Pop!_OS;
- Linux Mint;
- GNOME Wayland;
- GNOME X11;
- KDE Wayland;
- KDE X11;
- NVIDIA;
- AMD;
- Intel;
- HiDPI;
- múltiplos monitores.

---

## 27. CI/CD e distribuição

### Pipeline

1. lint TypeScript;
2. typecheck;
3. Vitest;
4. cargo fmt;
5. cargo clippy;
6. cargo test;
7. integration tests;
8. Electron E2E;
9. build release;
10. gerar SBOM;
11. assinar artefactos;
12. publicar canal beta;
13. promoção manual para stable.

### Artefactos

- AppImage;
- `.deb`;
- `.rpm`;
- tarball;
- checksums;
- assinatura.

Flatpak apenas depois, devido às permissões necessárias para PTY, Git, Docker, SSH e ficheiros.

---

## 28. Roadmap

### Fase 0 — Spikes técnicos

Duração: 2–3 semanas.

Entregas:

- Electron abre o design React;
- Rust daemon via Unix socket;
- PTY real em xterm.js;
- um WebContentsView alinhado a um node;
- SQLite;
- prova de Git worktree;
- prova Docker/SSH.

Esta fase decide os maiores riscos antes de construir o produto.

### Fase 1 — Foundation

- monorepo;
- design tokens;
- app shell;
- IPC;
- daemon lifecycle;
- migrations;
- settings;
- logs;
- error boundaries.

### Fase 2 — Canvas fiel ao design

- pan;
- zoom;
- nodes;
- selection;
- resize;
- minimap;
- connections;
- contextual toolbar;
- Partituras;
- undo/redo;
- autosave.

### Fase 3 — Terminal e agentes

- PTY;
- xterm;
- presets;
- roles;
- states;
- notifications;
- restore;
- focus mode.

### Fase 4 — Notes e Composer

- Markdown;
- attachments;
- connections;
- CLI note commands;
- mentions;
- context resolver.

### Fase 5 — Files e Git

- file tree;
- watcher;
- search;
- editor;
- diff;
- graph;
- Git actions;
- external IDE.

### Fase 6 — Comunicação

- Orchestra CLI;
- agent-to-agent;
- queues;
- correlation;
- raw input;
- connection permissions;
- audit.

### Fase 7 — Floors e environments

- worktrees;
- landing;
- Docker;
- Podman;
- SSH;
- remote bridge.

### Fase 8 — Browser portals

- WebContentsView;
- partitions;
- live/frozen mode;
- screenshots;
- console;
- network;
- CDP automation;
- security hardening.

### Fase 9 — Routines e Conductor

- scheduler;
- chains;
- Routine Node;
- manager permissions;
- recruit/dismiss;
- background operation.

### Fase 10 — Android e hardening

- ADB;
- scrcpy;
- accessibility;
- crash recovery;
- performance;
- distro testing;
- installer;
- beta.

---

## 29. MVP recomendado

O primeiro MVP público deve incluir:

- Linux;
- Electron + React;
- Rust daemon;
- workspaces;
- canvas;
- terminal real;
- Claude Code, Codex, OpenCode e custom;
- roles;
- notes Markdown;
- file tree;
- editor simples;
- Git status e diff;
- connections;
- CLI bridge;
- agent-to-agent;
- local environment;
- Docker e Podman;
- floors por worktree;
- autosave;
- crash recovery básica;
- AppImage e `.deb`.

Adiar para a versão seguinte:

- iOS remoto;
- Android streaming completo;
- automação browser avançada;
- Conductor completo;
- routines disparadas por eventos complexos;
- colaboração cloud;
- sincronização entre máquinas;
- marketplace de Partituras.

---

## 30. Equipa e prazo

### Equipa mínima recomendada

- 1 developer Electron/React/canvas;
- 1 developer Rust/sistemas;
- 1 developer full-stack/QA que possa trabalhar nos dois lados;
- designer part-time para evolução e estados.

### Estimativa

Equipa de três developers:

- spike funcional: 3 semanas;
- alpha interno: 3–4 meses;
- MVP público: 6–9 meses;
- produto com portals, routines, Conductor e Android: 10–16 meses.

Um developer sozinho:

- protótipo técnico: 1–2 meses;
- MVP limitado: 8–12 meses;
- produto amplo: 18–30 meses.

---

## 31. Definition of Done do MVP

O MVP só está concluído quando:

1. O layout do design foi convertido para componentes React reutilizáveis.
2. Um workspace pode ser criado a partir de um diretório real.
3. O canvas restaura posições, dimensões e conexões depois de reiniciar.
4. Um terminal executa um shell real em PTY.
5. Claude Code, Codex ou OpenCode podem ser iniciados como processos reais.
6. Roles são injetadas e persistidas.
7. Notes são ficheiros Markdown reais.
8. Um agente conectado pode ler e escrever uma note autorizada.
9. Dois agentes conectados conseguem trocar uma mensagem e resposta.
10. O File Tree reflete o filesystem real.
11. O Git status e diff são reais.
12. Um floor cria um `git worktree` real.
13. Docker e Podman executam PTYs reais.
14. O renderer não possui acesso direto ao Node ou filesystem.
15. Permissões perigosas pedem confirmação.
16. A aplicação recupera o layout após crash.
17. Testes automatizados cobrem os fluxos críticos.
18. AppImage e `.deb` funcionam em máquinas limpas suportadas.
19. Nenhum dado do projeto é enviado para cloud pela aplicação.
20. O desempenho permanece aceitável com pelo menos 20 terminais e 200 nodes de teste.

---

## 32. Primeira tarefa de desenvolvimento

Não começar por recriar todas as telas.

Construir primeiro este vertical slice:

```text
Electron window
    → React canvas fiel ao design
    → criar Terminal Node
    → Rust cria PTY real
    → xterm.js recebe output
    → salvar node no SQLite
    → fechar aplicação
    → reabrir e restaurar node
```

Depois acrescentar:

```text
Note real
    → conexão Terminal–Note
    → Orchestra CLI lê a note
    → agente escreve na note
```

Este vertical slice valida o coração técnico do produto antes de Git, floors, portals e routines.
