# Orchestra — Plano detalhado de implementação para renderização, File Tree, Git Graph e Drawing

> Auditoria de código realizada em 18 de agosto de 2026.
>
> Este documento é um plano de implementação. Nenhuma correção de produto foi implementada durante a auditoria.

## 1. Objetivo

Eliminar os problemas de renderização, sobreposição, posicionamento e inconsistência visual da aplicação, com prioridade máxima para o Browser Portal, e reconstruir as áreas de File Tree, Git Graph/Fork e Drawing sobre contratos técnicos previsíveis.

O resultado pretendido é:

- Browser Portal estável durante pan, zoom, drag, resize, navegação e sobreposição com outras partes da interface;
- tema claro completo, sem superfícies pretas acidentais no editor, File Tree, Browser, terminal ou controlos auxiliares;
- Git Graph visual e funcional ao nível do gráfico do VS Code/Fork, com linhas contínuas, curvas coerentes e operações Git seguras;
- nodes arrastados exatamente na direção do cursor, sem desvio lateral ou “escorregamento” num eixo;
- uma única entrada pública de Drawing, semelhante ao modelo do Maestri, substituindo os dois conceitos atuais de Shape e Draw;
- regras de renderização, z-order, clipping, tema e interação partilhadas por todos os nodes;
- testes visuais e de interação capazes de detetar regressões reais dentro da aplicação Electron, não apenas em funções isoladas.

## 2. Escopo e limites

### 2.1 Incluído

- Browser Portal e integração com `WebContentsView`;
- canvas React Flow, drag, resize, zoom, clipping e z-order;
- File Tree, editor CodeMirror, pesquisa e menu contextual;
- Git Graph, refs, commits, diffs, checkout e operações relacionadas;
- tema claro/escuro/system em renderer, editor, terminal e superfícies nativas;
- Drawing, formas, traços, persistência e migração dos dados atuais;
- cabos, minimapa, controlos do canvas e problemas transversais de desempenho/renderização;
- observabilidade e testes visuais para Electron.

### 2.2 Não incluído nesta execução de auditoria

- alteração de código-fonte da aplicação;
- mudança do stack Electron/React/Rust;
- redesign integral de áreas não relacionadas;
- implementação de colaboração em tempo real para Drawing;
- sincronização remota de ficheiros ou Git;
- publicação de builds.

## 3. Estado que deve ser preservado antes de implementar

O repositório já possuía alterações locais no momento da auditoria. O agente executor não deve descartá-las, fazer reset destrutivo ou assumir que foram produzidas por esta auditoria.

Alterações observadas:

- `apps/desktop/src/main/index.ts`;
- `apps/desktop/src/renderer/components/Nodes/BrowserNode.tsx`;
- `apps/desktop/src/renderer/components/Nodes/FilesNode.tsx`;
- `apps/desktop/src/renderer/index.css`;
- `apps/desktop/test.js`;
- diretórios `.orchestra/terminals/` não rastreados.

Antes da primeira alteração, o agente deve:

1. guardar `git status --short --branch` num artefacto de auditoria;
2. guardar o diff dos cinco ficheiros modificados;
3. identificar, para cada bloco alterado, se é trabalho válido a integrar, experimento incompleto ou regressão;
4. nunca usar `git reset --hard`, `git checkout -- <ficheiro>` ou outro comando destrutivo para limpar o estado;
5. criar commits pequenos por fase, sem misturar alterações não relacionadas do utilizador.

## 4. Resultado da validação inicial

Na data da auditoria, as verificações existentes deram o seguinte resultado:

| Verificação | Resultado | Interpretação |
|---|---:|---|
| `npm --prefix apps/desktop run check` | passou | TypeScript/lint não detetam os bugs visuais descritos |
| `npm run test:smoke` | passou | a cobertura smoke atual não exercita a composição visual real |
| `npm --prefix apps/desktop run test:portal-harness` | passou | o harness isolado não representa React Flow + overlays + clipping |
| `npm --prefix apps/desktop run build` | passou | compilar não valida estabilidade visual |
| `cargo test -p orchestra-core` | 29 testes passaram | o core não é a causa principal dos bugs de renderização |
| `git diff --check` | passou | não havia erros de whitespace no diff existente |

Outras medições relevantes:

- bundle principal do renderer: aproximadamente **2,08 MB minificado** e **650 KB gzip**;
- folha CSS principal: aproximadamente **97,7 KB**, **824 regras**, **3.281 declarações** e **769 seletores únicos**;
- foram encontrados cerca de **50 seletores duplicados**;
- foram encontradas cerca de **317 declarações de cor hardcoded fora de regras explícitas de tema**.

Conclusão: o projeto compila e os testes atuais passam, mas os contratos de composição visual não estão cobertos. Os problemas são arquiteturais e não simples erros de tipagem.

## 5. Priorização executiva

| Prioridade | Área | Severidade | Causa dominante | Decisão |
|---:|---|---|---|---|
| P0 | Browser Portal | crítica | mistura de `WebContentsView` nativo com DOM transformado e estados contraditórios | introduzir política híbrida nativo/snapshot e gestor central |
| P0 | z-order e clipping | crítica | duas árvores de composição sem contrato comum; serialização `zIndex` inconsistente | corrigir wire format e ordenar DOM + Views pela mesma fonte |
| P0 | drag de nodes | alta | resolução de colisão eixo a eixo | remover bloqueio por colisão ou resolver o vetor completo |
| P1 | tema claro/File Tree/editor | alta | CSS global/hardcoded e recriação do CodeMirror | tokens semânticos + `Compartment` + inicialização de tema antes do mount |
| P1 | Git Graph/Fork | alta | renderer não possui segmentos de grafo; só desenha linhas verticais independentes | novo modelo topológico e rail SVG contínuo |
| P1 | Drawing | alta | Shape e Draw são dois fluxos frágeis sobre nodes funcionais | uma única ferramenta e uma camada gráfica própria |
| P2 | File Tree escalabilidade | média/alta | componente monolítico, polling pesado, menu preso ao scroller | decomposição, cancelamento, portal e virtualização |
| P2 | cabos e desempenho | média/alta | `requestAnimationFrame` permanente e pesquisas O(E×N) | render por invalidação e índices |
| P2 | regressões visuais gerais | média | CSS global com `!important`, fontes remotas e falta de testes Electron | remover hacks e criar matriz visual determinística |

## 6. Regras arquiteturais que todas as fases devem respeitar

### 6.1 Uma única fonte de verdade para coordenadas

Devem existir conversões explícitas entre quatro espaços:

1. **world**: coordenadas persistidas do canvas;
2. **flow viewport**: world depois de pan e zoom do React Flow;
3. **renderer/client**: píxeis CSS dentro da janela Electron;
4. **native content view**: coordenadas inteiras usadas por `WebContentsView`.

Nenhum componente deve voltar a calcular esta transformação de forma independente. Criar um módulo central, com funções puras e testes para:

- world → viewport;
- viewport → client;
- client → bounds nativos;
- interseção com a área segura do workspace;
- conversão de pointer → world;
- arredondamento por `devicePixelRatio`;
- determinação de visibilidade total, parcial e nula.

### 6.2 Separar estado lógico de estado de apresentação

O Browser não pode usar um único `status` para significar navegação, pintura, visibilidade e modo de apresentação. O File Tree também não deve misturar view ativa, pedido em curso, ficheiro selecionado e estado do editor.

Cada subsistema deve ter estados ortogonais. Exemplo conceitual do Browser:

- `navigationState`: idle, starting, loading, committed, failed;
- `paintState`: none, first-frame, current-frame, stale-frame;
- `presentationState`: hidden, snapshot, staging-native, live-native;
- `motionState`: stable, panning, pinching, dragging, resizing, settling;
- `visibilityState`: offscreen, clipped, occluded, fully-visible;
- `lifecycleState`: creating, ready, suspended, destroyed, crashed.

As transições devem ser documentadas e testadas. Um screenshot bem-sucedido não pode, por si só, declarar a navegação pronta.

### 6.3 Nenhum hack global para corrigir um node específico

Devem ser removidas ou substituídas regras equivalentes a:

- visibilidade forçada de todos os `.react-flow__node`;
- `overflow: visible !important` para todo node selecionado;
- cores de Browser/File Tree não limitadas ao tema ou componente;
- regras de drag aplicadas a toda a superfície do node.

Quando um componente precisar de comportamento especial, isso deve ser expresso por classe/atributo próprio e testado no próprio módulo.

### 6.4 Última intenção vence

Operações assíncronas ligadas a movimento, pesquisa, refresh, screenshot ou carregamento precisam de `generationId`, abort/cancelamento ou fila latest-only. Uma resposta antiga nunca pode sobrescrever o estado produzido por uma intenção mais recente.

### 6.5 Estado visual restaurável

Ao mudar de tema, refrescar Git, redimensionar um node ou alternar a vista, devem ser preservados sempre que aplicável:

- scroll;
- seleção;
- foco;
- cursor;
- undo/redo;
- commit/ficheiro selecionado;
- primeira linha visível e respetivo offset;
- expansão das pastas;
- query e modo de pesquisa.

## 7. Diagnóstico e plano do Browser Portal

### 7.1 Ficheiros principais

- `apps/desktop/src/renderer/components/Nodes/BrowserNode.tsx`;
- `apps/desktop/src/main/index.ts`;
- `apps/desktop/src/shared/browserPortalGeometry.ts`;
- `apps/desktop/src/renderer/components/Canvas/CanvasArea.tsx`;
- `apps/desktop/src/renderer/App.tsx`;
- `apps/desktop/src/preload/index.ts`.

### 7.2 Causa estrutural da sobreposição

O conteúdo web é apresentado por um `WebContentsView`, que é uma View nativa filha da janela. O canvas, toolbar, menus, minimapa, molduras e restantes nodes são DOM do renderer.

Essas duas árvores não obedecem às mesmas regras:

- `z-index` do CSS não reordena uma View nativa;
- `overflow: hidden` e `border-radius` do node não recortam a View nativa;
- `transform: translate(...) scale(...)` do React Flow não é herdado pela View;
- blur, opacity e transições CSS não afetam a View;
- um modal DOM pode ficar visualmente por baixo do browser nativo;
- duas Views nativas precisam de uma ordem definida no processo main.

Por isso, tentar manter o browser nativo sempre visível e apenas atualizar `setBounds()` produz inevitavelmente flashes, atraso, fuga para fora do node e sobreposição incorreta durante movimento.

Referência técnica: [Electron View API](https://www.electronjs.org/docs/latest/api/view).

### 7.3 Regressão durante zoom

O código local existente congela a escala do conteúdo do portal durante o movimento, mas continua a atualizar os bounds nativos. Isto cria o pior estado intermédio possível:

- a caixa exterior muda em cada frame;
- o `zoomFactor` interno continua antigo;
- o `innerWidth` lógico da página muda;
- breakpoints responsivos são acionados durante o zoom do canvas;
- a página reorganiza conteúdo, scrollbars e layout;
- no fim, o zoom interno é atualizado e ocorre outro salto.

Regra obrigatória: **enquanto a View nativa estiver visível, bounds e zoom devem formar um frame atómico**. Se isso não for garantido, a View deve estar escondida e o renderer deve apresentar um snapshot.

### 7.4 Erro de temporização do pinch

Foi observada uma inconsistência entre:

- atraso de finalização do pinch no canvas: aproximadamente 180 ms;
- watchdog de movimento do Browser: aproximadamente 120 ms;
- evento de início de pinch emitido essencialmente na transição de estado, não como heartbeat.

O Browser pode concluir que o movimento terminou enquanto o pinch ainda está ativo. Em seguida tenta promover a View nativa, volta a receber geometria e oscila entre modos.

Correção:

- o proprietário do gesto deve emitir `motionSessionId` e `phase` (`start`, `update`, `end`);
- updates devem carregar a mesma sessão;
- `end` deve ser explícito, não inferido apenas por timeout;
- watchdog serve só para recuperação de evento perdido, com margem superior ao maior debounce do canvas;
- uma sessão antiga não pode terminar uma sessão nova.

### 7.5 Navegação e first-frame contraditórios

Atualmente, o main pode:

- receber `did-start-loading`;
- marcar `firstFrameReady = false`;
- esconder a View;

ao mesmo tempo que o renderer tenta conservar a apresentação live durante loading. Isso produz placeholder, fundo preto/branco ou flash.

Também foi observado que a captura de screenshot pode promover o estado para ready. Pintar um frame capturável não significa que a navegação terminou nem que a página está estável.

Política correta:

1. ao iniciar uma navegação, conservar o último snapshot válido;
2. marcar esse frame como stale, mas não o remover;
3. manter a View escondida durante a preparação do novo conteúdo;
4. esperar `did-commit-navigation` e um primeiro frame realmente pintado;
5. produzir novo snapshot;
6. só promover a View live quando a geometria estiver estável e sem oclusão;
7. em erro, manter o frame anterior com uma faixa de erro e ação de retry.

### 7.6 Flash na primeira captura

O processo main pode tornar a View visível nos bounds finais para conseguir a primeira captura. Mesmo que seja breve, a View pode aparecer por cima do DOM antes de ser escondida.

Substituir por uma destas estratégias, por ordem de preferência:

1. **staging off-canvas**: posicionar temporariamente a View fora da área visível, aplicar tamanho/zoom, esperar paint e capturar;
2. **staging BrowserWindow escondida**: usar uma superfície auxiliar quando Electron/driver não produzir frames de uma View invisível;
3. **wake protegido**: apenas como fallback de plataforma, atrás de uma cobertura nativa/renderer explicitamente validada.

Nunca acordar a View diretamente nos bounds finais enquanto o utilizador pode vê-la.

### 7.7 Backpressure entre geometria e screenshot

O canal atual de atualização do portal pode esperar vários segundos por uma captura. O renderer serializa atualizações, portanto uma operação pesada bloqueia a geometria nova.

Criar pipelines separados:

#### Pipeline A — geometria

- latest-only;
- sem screenshot;
- sem espera por navegação;
- custo constante;
- payload pequeno;
- aplica apenas a versão mais recente;
- possui `portalId`, `geometryVersion`, `motionSessionId` e timestamp monotónico.

#### Pipeline B — captura

- cancelável/coalescido;
- no máximo uma captura ativa por portal;
- pedidos repetidos enquanto uma captura está ativa convergem num único pedido final;
- nunca bloqueia Pipeline A;
- possui limite de frequência e orçamento global de memória;
- ignora resultados cuja `captureGeneration` já não é atual.

### 7.8 Política híbrida de apresentação

Usar a View nativa apenas quando todas as seguintes condições forem verdadeiras:

- canvas está estável;
- node não está a ser arrastado ou redimensionado;
- pan/zoom/pinch terminaram;
- browser está totalmente dentro da área segura;
- browser não está coberto por modal, menu, toolbar contextual, minimapa ou outro node acima dele;
- bounds e zoom finais foram aplicados enquanto a View estava escondida;
- foi observado pelo menos um frame válido depois da aplicação;
- z-order nativo foi sincronizado;
- a janela está visível e focada segundo a política definida.

Em qualquer outro caso, apresentar snapshot DOM.

Matriz mínima:

| Situação | Apresentação |
|---|---|
| estável, totalmente visível, sem oclusão | native live |
| pan/zoom/pinch | snapshot |
| drag/resize do browser | snapshot |
| parcialmente fora do workspace | snapshot recortado pelo DOM |
| modal/menu sobre o browser | snapshot ou hidden, nunca native acima do overlay |
| navegação em curso | último snapshot + indicador discreto |
| first frame ainda não disponível | skeleton dentro do node |
| browser offscreen | hidden/suspended |
| janela minimizada | hidden/suspended |
| crash do webContents | snapshot + error state |

### 7.9 Sequência de settle obrigatória

Ao terminar movimento:

1. receber `motion:end` da sessão atual;
2. esperar um frame do renderer para estabilizar layout;
3. medir geometria final uma única vez;
4. calcular área segura, clipping e oclusão;
5. manter View escondida;
6. aplicar bounds finais e zoom final em conjunto lógico;
7. sincronizar ordem da View;
8. esperar confirmação de paint/frame;
9. promover de snapshot para live sem remover antecipadamente o snapshot;
10. fazer swap no mesmo frame visual;
11. confirmar que nenhuma nova sessão começou; caso tenha começado, abortar a promoção.

### 7.10 Área segura e oclusão

O cálculo não deve usar apenas `window.innerWidth`/document viewport. Criar um `WorkspaceOverlayRegistry` que conheça:

- rect útil do canvas;
- top bar;
- sidebars;
- Inspector;
- minimapa;
- toolbar inferior;
- toolbar/context menu do node;
- command palette;
- modais;
- notices/toasts que devam cobrir conteúdo;
- outros nodes com `zIndex` superior.

O resultado para cada portal deve ser:

- `fullyVisible`;
- `partiallyVisible`;
- `occluded`;
- `offscreen`;
- lista opcional de razões para debug.

Como uma View nativa retangular não pode respeitar recortes arbitrários do DOM, qualquer clipping parcial ou oclusão não retangular deve forçar snapshot.

### 7.11 Arredondamento, DPR e distorção

O código deve testar separadamente X e Y. Não usar a média das duas escalas quando isso esconder distorção.

Regras:

- largura/altura CSS e raster devem manter o mesmo aspect ratio;
- snapshot não deve usar `object-fit: fill` quando a proporção divergir;
- preferir `contain`/dimensão exata e background controlado;
- arredondar bordas com uma função única testada por DPR;
- tolerância máxima de bleed: zero píxeis visíveis fora da moldura;
- tolerância interna de seam: no máximo um device pixel, sem linha perceptível em 100%/125%/150%/200%.

### 7.12 Snapshots e memória

Base64 PNG em strings cria cópias desnecessárias no main, IPC, estado React e DOM. O plano deve:

- preferir `Buffer`/`Uint8Array` transferível ou blob URL;
- revogar blob URLs substituídos;
- limitar resolução pela área realmente apresentada e DPR máximo configurável;
- manter apenas `current` e, se necessário, `previous` durante transição;
- suspender capturas de portais offscreen;
- instrumentar bytes por portal e bytes globais;
- não capturar por cada input event; capturar por invalidação/coalescing;
- libertar dados no destroy do portal, workspace e janela.

### 7.13 z-order nativo e persistido

Foi identificada uma quebra de contrato:

- Rust/SQLite expõe ou espera `z_index`;
- renderer trabalha com `zIndex`;
- o Canvas coloca o valor dentro de `data`, mas não o aplica necessariamente como `zIndex` top-level do React Flow;
- o fallback no backend pode gravar sempre o mesmo valor.

Correção obrigatória:

1. formato JSON canónico: `zIndex`;
2. coluna interna de banco pode continuar `z_index`;
3. desserialização aceita `z_index` apenas durante uma janela de migração;
4. gravação lê `zIndex` e cobre roundtrip em teste;
5. React Flow recebe `zIndex` no nível correto do node;
6. View nativa recebe a mesma ordem;
7. usar API de ordem de child Views, evitando remover e voltar a adicionar todas as Views a cada foco;
8. `bringToFront` atualiza persistência e ambas as árvores de composição;
9. empate de z-order tem regra determinística por criação/ID;
10. reabrir workspace deve reproduzir exatamente a ordem visual anterior.

### 7.14 CSS específico do Browser

Existe uma regra em que apenas `.chrome-shell` está sob `[data-theme="dark"]`, enquanto seletores seguintes ficaram globalmente escopados por erro de agrupamento. Resultado: toolbar, divisores, navegação e address bar podem permanecer escuros no modo claro.

Ações:

- mover estilos Browser para módulo/camada própria;
- eliminar blocos duplicados da shell Chrome;
- usar tokens semânticos, não hex/rgb diretos;
- criar estados visuais explícitos para loading, stale snapshot, error, suspended e live;
- limitar qualquer exceção de overflow ao elemento correto;
- testar bordas e background em todos os estados e temas.

### 7.15 Arquitetura alvo do Browser

Separar responsabilidades:

- `BrowserNodeView`: moldura, toolbar e DOM do node;
- `BrowserPresentationController`: máquina de estados de snapshot/native;
- `PortalGeometryCoordinator`: conversões e atualizações latest-only;
- `PortalCaptureCoordinator`: capturas coalescidas e cache;
- `PortalOcclusionRegistry`: área segura e overlays;
- `BrowserPortalManager` no main: lifecycle de `WebContentsView`, bounds, zoom e child order;
- `BrowserNavigationStore`: URL, history, loading, erro e título;
- canal de telemetria de debug ativável por portal.

O React component não deve continuar a concentrar todos estes estados em refs e timeouts locais.

### 7.16 Testes obrigatórios do Browser

O harness atual deve continuar como teste matemático rápido, mas não é suficiente. Adicionar Playwright com Electron real e fixture local determinística.

Matriz mínima:

- temas: dark e light;
- tamanhos de janela: 1280×720, 1440×900, 1920×1080 e 390/768 para layouts compactos quando aplicável;
- DPR: 1, 1.25, 1.5 e 2 onde a infraestrutura permitir;
- zoom do canvas: 25%, 43%, 67%, 100%, 150% e 200%;
- um e vários browsers;
- browser totalmente visível, parcialmente recortado e offscreen;
- browser por baixo/acima de terminal, File Tree e note;
- modal, menu e toolbar sobre browser;
- pan contínuo, wheel zoom, pinch simulado, drag e resize;
- navegação local lenta, redirect, erro, certificate/error fixture e crash/reload;
- fechar/reabrir workspace para validar z-order.

Asserções:

- zero píxeis do conteúdo fora do node;
- ausência de frames totalmente brancos/pretos entre estados;
- `innerWidth` da página não oscila durante zoom do canvas;
- resize do node altera viewport de forma intencional e apenas no momento definido;
- overlays permanecem por cima;
- máximo de uma captura final por sessão de movimento;
- fila de geometria nunca fica atrás de uma captura;
- memória retorna ao baseline aceitável após criar/destruir repetidamente portais.

## 8. Tema claro, File Tree e editor

### 8.1 Ficheiros principais

- `apps/desktop/src/renderer/components/Nodes/FilesNode.tsx`;
- `apps/desktop/src/renderer/index.css`;
- `apps/desktop/src/renderer/stores/workspaceStore.ts`;
- `apps/desktop/src/renderer/index.html`;
- `apps/desktop/src/main/index.ts`.

### 8.2 Causa do editor preto no tema claro

O tema claro não falha apenas no tema CodeMirror. A cadeia observada é:

- o editor foi historicamente criado com `oneDark`;
- existe uma tentativa local de tema claro;
- superfícies pai e, principalmente, filhos `.cm-editor`/gutters continuam com backgrounds escuros hardcoded;
- algumas regras de tema estão duplicadas ou mal escopadas;
- `index.html` inicia em dark;
- a BrowserWindow também usa background escuro;
- o tema global começa como dark e não é restaurado antes do primeiro paint.

Logo, mesmo que o estado React diga `light`, pode ocorrer:

- flash inicial preto;
- editor preto dentro de File Tree claro;
- gutters pretas;
- toolbar/footer escuros;
- controlos do canvas e minimapa ainda escuros.

### 8.3 Sistema de tokens semânticos

Criar tokens por função, nunca por componente ou cor literal. Grupos mínimos:

- canvas: background, grid-dot, vignette;
- surface: base, raised, overlay, inset;
- border: subtle, default, strong, selected;
- text: primary, secondary, muted, inverse, danger, success;
- control: bg, hover, active, disabled;
- input: bg, border, focus-ring, placeholder;
- code: bg, gutter-bg, gutter-text, selection, active-line;
- terminal: bg, fg e paleta ANSI 16 cores;
- browser chrome: bg, toolbar, address, divider;
- graph: rail-bg, line-muted, commit-node, ref chips;
- drawing: selection, guide, handle, preview;
- shadow/scrim;
- status: info, warning, error, success.

Cada tema deve preencher todos os tokens. Um teste deve falhar se um token usado não existir em dark e light.

### 8.4 Inicialização do tema sem flash

Fluxo alvo:

1. persistir preferência `dark | light | system`;
2. no preload/bootstrap, ler a preferência antes do mount do React;
3. resolver `system` com `prefers-color-scheme`;
4. aplicar `data-theme` e `color-scheme` ao elemento raiz antes do primeiro paint;
5. comunicar a cor de fundo resolvida ao main;
6. atualizar background da BrowserWindow;
7. ouvir alteração do sistema apenas quando preferência for `system`;
8. garantir que splash/loading usa os mesmos tokens.

### 8.5 CodeMirror sem recriação

O efeito atual depende de caminho e tema e pode destruir/recriar o editor ao alternar tema. Isso perde ou ameaça:

- undo stack;
- cursor e seleção;
- scroll;
- foco;
- extensões com estado;
- conteúdo não sincronizado em React.

Usar `Compartment` do CodeMirror 6 para reconfigurar tema e, se necessário, linguagem/read-only sem destruir `EditorView`.

Referência: [CodeMirror 6 Reference — Compartment](https://codemirror.net/docs/ref/).

Contrato:

- uma instância de `EditorView` por sessão de ficheiro/pane;
- tema muda por `compartment.reconfigure(...)`;
- conteúdo externo entra por transaction anotada;
- transações externas não entram no caminho de autosave como edição do utilizador;
- conteúdo React/store é atualizado junto com o editor;
- conflito entre disco e buffer dirty abre decisão explícita, nunca sobrescreve silenciosamente;
- tema não altera documento, history ou scroll.

### 8.6 Bug de sincronização do conteúdo externo

O polling pode enviar conteúdo diretamente para o CodeMirror sem atualizar `fileContent` no estado React. Uma recriação posterior pode restaurar uma versão antiga.

Corrigir com uma única fonte de verdade de documento:

- `documentVersion` do backend;
- `editorVersion` local;
- `savedVersion`;
- flag `dirty` derivada, não inferida por comparação instável;
- update externo só aplicado automaticamente se o buffer não estiver dirty;
- se estiver dirty, mostrar conflito com `Reload`, `Keep mine` e `Compare`;
- qualquer transaction aplicada ao editor atualiza o modelo de documento correspondente.

### 8.7 Decomposição de `FilesNode.tsx`

O componente concentra árvore, editor, diff, Git Graph, ações Git, polling e layout. Deve ser dividido, no mínimo, em:

- `FilesNodeShell`;
- `FilesHeader`;
- `FileTreeView`;
- `FileTreeRow`;
- `FileSearchController`;
- `EditorPane`;
- `DiffPane`;
- `GitGraphView`;
- `GitRefsSidebar`;
- `CommitDetailsPane`;
- `FileContextMenu`;
- hooks/stores separados para filesystem, editor e Git.

Cada subárea deve ter estado de loading, empty, error e retry próprio. Um erro de Git não deve derrubar a árvore de ficheiros.

### 8.8 Polling e pedidos antigos

O refresh periódico atual pode fazer vários pedidos pesados, incluindo centenas de commits, mesmo quando a vista correspondente não está aberta.

Substituir por:

- watcher/eventos para alterações de ficheiros quando disponível;
- refresh de árvore apenas quando Files view está visível;
- Git status leve em intervalo adaptativo;
- histórico Git apenas quando Graph abre ou refs mudam;
- diff/blame apenas sob pedido;
- `AbortController`/generation em todo carregamento;
- pausa quando node está offscreen, workspace inativo ou janela minimizada;
- backoff em erros repetidos;
- botão manual de refresh com feedback.

### 8.9 Pesquisa ao estilo Maestri

Separar modos:

- default: filtrar por nome/caminho;
- prefixo `>`: pesquisar conteúdo;
- opcionalmente `@`: símbolos numa fase posterior;
- chips/tooltip tornam o modo descobrível;
- debounce e cancelamento por geração;
- resultado mostra caminho, linha e trecho apenas no modo conteúdo;
- Enter abre primeiro resultado; setas navegam; Escape limpa/fecha;
- query e modo persistem enquanto o node existir.

Referência de produto: [Maestri File Tree](https://www.themaestri.app/en/docs/file-tree).

### 8.10 Virtualização e árvore grande

Criar lista achatada derivada do estado de expansão e virtualizá-la. Requisitos:

- chave estável pelo caminho normalizado;
- row height controlada por token;
- navegação de teclado preservada;
- seleção não depende de row montada;
- expand/collapse mantém âncora visual;
- rename inline não desaparece ao virtualizar;
- drag/drop, se mantido, usa overlay próprio;
- teste com 1k, 10k e 50k entradas sintéticas;
- evitar pesquisar conteúdo de todos os ficheiros no renderer.

### 8.11 Menu contextual

O menu atual é posicionado dentro do scroller e o cálculo não considera corretamente scroll. Implementar via portal para uma camada global de overlays.

Requisitos:

- coordenadas client do pointer/elemento;
- flip horizontal/vertical junto às bordas;
- nunca cortado pelo node ou scroller;
- fecha ao scroll externo, resize, Escape e click-away;
- operações destrutivas separadas e confirmadas;
- mantém identificação do alvo mesmo que a lista atualize;
- z-order acima do browser por meio da política snapshot/native.

### 8.12 Layout responsivo do File Tree

Evitar um breakpoint abrupto baseado apenas em `data.width` que monta/desmonta o editor repetidamente durante resize.

Definir três modos com histerese:

- compact: uma vista por vez, editor/detalhes como painel interno;
- medium: tree + pane alternável ou bottom drawer;
- wide: split tree/editor ou graph/details;

No modo Git Graph, o editor normal não deve ocupar automaticamente a lateral. O painel da direita pertence aos detalhes do commit/diff.

### 8.13 Contrato de drag dos controlos

Todos os botões, inputs, selects, tabs, scrollers, CodeMirror e menus devem usar as utility classes adequadas de React Flow:

- `nodrag` para não iniciar drag;
- `nopan` quando a interação não deve mover viewport;
- `nowheel` em scrollers/editores onde a wheel deve permanecer local;
- um `node-drag-handle` explícito para mover o node.

Referência: [React Flow utility classes](https://reactflow.dev/learn/customization/utility-classes).

### 8.14 Testes do tema e File Tree

- screenshot dark/light/system para todos os modos: Files, Editor, Diff, Graph;
- alternar tema com documento dirty, undo stack, cursor, seleção e scroll;
- reload da aplicação sem flash do tema oposto;
- menu contextual depois de scroll vertical/horizontal e zoom do canvas;
- resize cruzando breakpoints repetidamente sem perda de estado;
- atualização externa com buffer clean e dirty;
- pesquisa por nome e conteúdo com respostas fora de ordem;
- árvore de 10k+ itens;
- ANSI black e bright black legíveis no terminal claro;
- minimapa, toolbar, Home, blame e error boundary nos dois temas.

## 9. Git Graph/Fork — reconstrução funcional e visual

### 9.1 Ficheiros principais

- `apps/desktop/src/renderer/components/Nodes/FilesNode.tsx`;
- `apps/desktop/src/renderer/components/Nodes/filesTreeUtils.ts`;
- `apps/desktop/src/renderer/index.css`;
- `crates/orchestra-core/src/git.rs` ou módulo Git equivalente.

### 9.2 Causa das linhas tortas

O modelo atual calcula essencialmente:

- lane do commit;
- quantidade de lanes;
- cores.

Mas não calcula os segmentos que ligam `lanesBefore` a `lanesAfter`. O JSX desenha um marcador e pseudo-elementos verticais independentes por row. Assim:

- mudança de lane não cria curva;
- fork não tem segmento de abertura;
- merge não liga pais;
- lane encerrada não termina visualmente;
- a virtualização corta linhas;
- a margem do texto varia com a quantidade de lanes;
- ao fazer scroll, parecem colunas desconectadas e tortas.

Isto não é corrigível com mais CSS sobre os pseudo-elementos. É necessário construir um grafo topológico e renderizar paths reais.

### 9.3 Ordenação do histórico

O backend deve pedir um histórico apropriado para grafo:

- `--topo-order` para não mostrar pais antes dos filhos de forma visualmente impossível;
- `--date-order` como critério secundário quando adequado;
- formato robusto, com delimitadores que não colidam com mensagens;
- todos os parent hashes;
- refs completas e peeled tags quando necessário;
- paginação por cursor, não carregar sempre 500 commits sem contexto;
- capacidade de obter vizinhança em torno de um commit selecionado.

O parser deve possuir fixtures para mensagens com Unicode, separadores, múltiplas linhas e autores incomuns.

### 9.4 Modelo de dados do grafo

Cada row deve conter, conceitualmente:

- `commitHash`;
- `parents[]`;
- `nodeLane`;
- `lanesBefore[]`;
- `lanesAfter[]`;
- `segments[]`;
- `refs[]`;
- `isHead`, `isMerge`, `isRoot`;
- identidade estável da lane;
- cor derivada da identidade, não apenas do índice atual.

Tipos de segmento mínimos:

- vertical continue;
- start/fork;
- merge left/right;
- lane shift;
- terminate;
- commit dot;
- octopus merge com múltiplos pais.

O algoritmo precisa garantir que a extremidade inferior de uma row coincide exatamente com a extremidade superior da seguinte para cada lane ativa.

### 9.5 Renderização SVG

Substituir pseudo-elementos CSS por um rail SVG de largura fixa.

Requisitos:

- `viewBox` baseado em lane width e row height canónicos;
- paths cúbicos ou quadráticos para transições;
- `vector-effect="non-scaling-stroke"` quando aplicável;
- line caps/joins arredondados;
- commit dot por cima dos segmentos;
- hit target separado da linha visual;
- linhas continuam até às bordas da row;
- overscan da virtualização para não expor cortes;
- texto começa numa coluna X constante, independentemente do número de lanes;
- rail pode fazer scroll horizontal próprio apenas em históricos extremos, sem empurrar a mensagem;
- cores acessíveis nos dois temas e não dependentes apenas de cor para seleção/HEAD.

### 9.6 Identidade e cor das lanes

Não atribuir cor exclusivamente pelo índice da coluna, porque uma compactação de lanes troca a cor da mesma linha no scroll/refresh.

Usar identidade estável derivada da linha viva:

- hash/ref que originou a lane;
- ID gerado e transportado enquanto a lane vive;
- paleta cíclica com contraste validado;
- branch selecionada pode ganhar espessura/halo, não uma cor completamente nova.

### 9.7 Layout alvo inspirado em Fork/VS Code

#### Desktop/wide

- sidebar esquerda fixa: Local, Remote, Tags, Stashes e Worktrees;
- centro: lista de commits com rail SVG, mensagem, autor, data e chips de ref;
- direita: detalhes do commit, ficheiros alterados e diff;
- footer/status discreto para operação Git em curso.

#### Medium

- refs colapsáveis;
- grafo ocupa corpo principal;
- detalhes em bottom drawer redimensionável.

#### Compact

- grafo em ecrã principal;
- refs e detalhes em drawers;
- ações do commit num menu contextual.

Referência de comportamento: [VS Code Source Control Graph](https://code.visualstudio.com/docs/sourcecontrol/staging-commits).

### 9.8 UX das refs

- grupos com contadores e collapse persistido;
- pesquisa de refs;
- mostrar todas por virtualização/paginação, não apenas as primeiras dez;
- HEAD e branch atual claramente identificados;
- remote tracking separado;
- tags anotadas distinguidas;
- stashes e worktrees com ícones/labels próprios;
- click seleciona/filtra; double click não deve executar checkout acidental;
- checkout é ação explícita.

### 9.9 Ações Git seguras

Não deixar operações destrutivas permanentemente comprimidas em botões inline.

Usar toolbar contextual/menu:

- checkout/switch;
- create branch/tag;
- merge/rebase/cherry-pick;
- revert/reset;
- push/pull/fetch;
- stash/apply/drop;
- worktree actions.

Antes de alterar estado:

1. verificar working tree dirty;
2. mostrar impacto e alvo exato;
3. pedir confirmação para ações destrutivas;
4. não assumir remote `origin` se houver mais de um;
5. apresentar output/progresso;
6. em conflito, entrar num estado operacional persistente com `Continue`, `Abort` e ficheiros em conflito;
7. não refrescar a lista de forma que esconda a operação.

### 9.10 Preservação de scroll e seleção

Antes do refresh, guardar:

- hash da primeira row visível;
- offset dessa row em relação ao viewport;
- commit selecionado;
- refs expandidas;
- painel e tab de detalhes.

Depois do refresh:

- encontrar o mesmo hash;
- restaurar posição e offset;
- manter seleção se o commit ainda existir;
- se não existir, explicar por que desapareceu e selecionar o vizinho mais coerente;
- nunca saltar silenciosamente para o topo.

### 9.11 Fixtures e testes do grafo

Criar repositórios Git temporários determinísticos para:

- história linear;
- branch simples;
- merge `--no-ff`;
- duas branches paralelas;
- octopus merge;
- criss-cross merge;
- branch apagada mas commits alcançáveis;
- tags e remotes;
- stash e worktree;
- history paginada.

Asserções algorítmicas:

- todos os pais alcançáveis possuem path correspondente;
- nenhum segmento termina sem causa;
- continuidade matemática entre rows;
- lane IDs mantêm cor enquanto vivem;
- nenhum path cruza o commit dot errado;
- scroll/virtualização não cria gaps;
- coluna de texto mantém X estável.

Asserções visuais:

- screenshots dark/light;
- zoom do canvas em vários níveis;
- resize horizontal e vertical;
- long messages e múltiplos ref chips;
- seleção, hover, HEAD e conflito.

## 10. Drag, colisão e stacking dos nodes

### 10.1 Causa do movimento “torto”

A função de aplicação de mudanças do canvas testa a posição em X e Y separadamente. Quando a posição desejada colide, um eixo pode ser aceite e o outro recusado. O node desliza ao longo da borda de outro node, mesmo que o pointer tenha seguido uma diagonal ou uma vertical.

Exemplo validado: uma intenção de posição `(30, 30)` pôde resultar em `(30, 0)`.

### 10.2 Decisão recomendada

Para uma aplicação de canvas semelhante a VS Code/Figma/Maestri, permitir sobreposição livre e controlar a ordem por `zIndex`. Colisão geométrica não deve bloquear drag.

Adicionar como ajudas não destrutivas:

- snap opcional à grelha;
- alignment guides;
- distribuição/spacing guides;
- snap a bordas/centros com tecla modificadora para ignorar;
- ação Arrange/Tidy quando o utilizador quiser organização automática.

Se o produto insistir em impedir overlap, resolver o vetor completo e retornar a última posição válida; nunca resolver X e Y em fases independentes.

### 10.3 Contrato do drag

- delta world aplicado de forma vetorial;
- movimento visual acompanha o pointer em cada frame;
- persistência ocorre no fim ou é coalescida, não bloqueia frames;
- snap calcula em world space;
- zoom não altera sensibilidade;
- node selecionado pode vir para frente de forma explícita e persistida;
- drag handle claro e consistente em todos os nodes;
- interações internas usam `nodrag`;
- drag de múltiplos nodes preserva offsets;
- Escape cancela e restaura posições iniciais;
- autoscroll junto às bordas não muda o vetor relativo do grupo.

### 10.4 Testes

- drag vertical, horizontal e diagonal junto a outros nodes;
- sobreposição e bring-to-front;
- zoom 25% a 200%;
- multi-select;
- controlos internos, CodeMirror, terminal e scrollers não arrastam node;
- persistência e reload;
- pointer solto fora da janela;
- Escape/cancel;
- DPR fracionário.

## 11. Drawing — substituir Shape + Draw por uma ferramenta única

### 11.1 Diagnóstico atual

O canvas expõe Shape e Draw como ferramentas separadas. Ambas acabam representadas pelo mesmo tipo genérico de node, apesar de terem semântica distinta.

Problemas observados:

- input baseado em mouse events, sem pointer capture;
- ausência de coalesced pointer events;
- pouca suavização/simplificação;
- sem pressão de caneta;
- traços guardados numa geometria que é esticada quando o node redimensiona;
- `preserveAspectRatio="none"` pode distorcer strokes;
- desenhos recebem handles/ports e semântica de node funcional;
- seleção, resize e cabos misturam-se com ilustração;
- dois botões públicos aumentam ambiguidade e fragmentam UX.

### 11.2 Direção de produto

Remover Shape e Draw como entradas principais. Criar uma única entrada **Drawing**, alinhada com a ideia de um drawing node/camada do Maestri.

Referências:

- [Maestri Canvas](https://www.themaestri.app/en/docs/canvas);
- [Maestri changelog — Smart Draw/Shape Library](https://www.themaestri.app/en/changelog).

Ao ativar Drawing, abrir uma palette compacta:

- Select;
- Pen;
- Brush;
- Line;
- Arrow;
- Rectangle;
- Ellipse;
- Diamond;
- Eraser;
- cor, espessura, opacity, fill e dash quando aplicável.

Smart Draw/reconhecimento de forma deve ser fase posterior, não dependência do MVP.

### 11.3 Domínio de dados próprio

Drawing não deve continuar a ser um node funcional com ports.

Criar entidade própria, por exemplo `canvas_drawings`, contendo conceitualmente:

- id;
- workspace/floor;
- kind;
- geometry em world space;
- style;
- bounding box calculável;
- z-order relativo da camada;
- locked/hidden;
- created/updated metadata;
- schema version.

Primitivas:

- freehand stroke: pontos world, pressure/time opcionais;
- line/arrow: start/end;
- rectangle/ellipse/diamond: rect world + rotação futura;
- group opcional numa fase posterior.

Separar persistência de geometria da bbox. Redimensionar seleção deve transformar pontos deliberadamente, não acontecer porque um SVG preenche um node alterado.

### 11.4 Camada gráfica

Criar `DrawingLayer` SVG/canvas sincronizada com a viewport React Flow:

- recebe a mesma transformação world → viewport;
- fica abaixo dos nodes funcionais por padrão, com opção “bring in front” se o produto aceitar;
- seleção e handles ficam numa overlay de interação;
- desenhos não possuem React Flow handles;
- pointer events são ativados apenas para ferramenta/select apropriado;
- clipping respeita a área útil do canvas;
- export/screenshot inclui a camada de forma determinística.

SVG é preferível inicialmente pela edição vetorial, hit testing previsível e boa qualidade em zoom. Avaliar Canvas/WebGL apenas se medições reais mostrarem necessidade para milhares de strokes.

### 11.5 Pipeline de input

- usar Pointer Events;
- `setPointerCapture` no início e release no fim/cancel;
- transformar cada amostra de client para world;
- consumir `getCoalescedEvents()` onde disponível;
- filtrar distância mínima dependente de world units, não píxeis de ecrã;
- suavizar com algoritmo definido e testável;
- simplificar no fim com tolerância limitada pelo zoom/estilo;
- guardar raw temporário apenas durante gesto;
- preview local em `requestAnimationFrame`;
- persistir uma operação atómica no fim;
- suportar `pointercancel`, perda de foco e Escape;
- reservar pressure/tilt para pen/brush sem degradar mouse.

### 11.6 Seleção e edição

- click seleciona desenho;
- marquee seleciona múltiplos;
- handles de resize/rotação apenas em modo Select;
- Shift preserva aspect ratio;
- Alt redimensiona a partir do centro;
- setas movem em incremento pequeno; modificador altera incremento;
- Delete remove com undo;
- lock impede edição;
- ordem e grouping via menu;
- eraser define política clara: apagar objeto inteiro no MVP ou segment erasing apenas numa fase posterior.

### 11.7 Undo/redo

Cada gesto é uma transação:

- add drawing;
- update geometry/style;
- transform selection;
- delete;
- reorder;
- group/ungroup futuramente.

Não criar um item de undo por ponto do stroke. Undo deve restaurar seleção e geometria relevantes.

### 11.8 Migração dos shapes existentes

Criar migração versionada e reversível:

- shape com pontos → freehand stroke em world space;
- shape vazio/retangular → rectangle;
- estilos atuais → tokens/valores equivalentes;
- preservar id antigo em metadata de migração;
- manter renderer legacy read-only por uma release se necessário;
- telemetria local/log de itens que não puderam migrar;
- backup lógico antes da migração;
- remover o tipo legacy apenas depois de roundtrip e fixtures passarem.

### 11.9 Testes de Drawing

- mouse, touchpad e pen quando disponível;
- zoom 25%–200%;
- pan durante ferramenta Select e comportamento definido durante Pen;
- stroke acompanha cursor sem offset;
- pointer sai do node/janela;
- resize não distorce acidentalmente;
- undo/redo por gesto;
- save/reload;
- migração de todas as variantes legacy;
- dark/light;
- milhares de pontos e centenas de objetos;
- screenshots sem blur ou aliasing excessivo.

## 12. Outros problemas de renderização e desempenho

### 12.1 CableSystem em loop permanente

O sistema de cabos mantém `requestAnimationFrame` permanente e, em cada frame, pode:

- ler nodes/edges;
- procurar nodes repetidamente;
- recalcular rotas/simulação;
- consultar DOM;
- fazer mutações de estilo.

Com N nodes e E ligações, pesquisas repetidas aproximam custo O(E×N), mesmo em idle.

Correção:

- construir mapas `nodeById`;
- invalidar quando node/edge/viewport muda;
- correr RAF apenas enquanto houver animação/simulação ativa;
- parar após convergência;
- usar spatial index se routing precisar de obstáculos;
- separar cálculo puro de aplicação DOM;
- atribuir classe raiz real que corresponda aos seletores de focus mode;
- medir frame time e quantidade de layouts forçados.

### 12.2 MiniMap e Background

As cores não podem ficar hardcoded no JSX. Devem receber valores resolvidos dos tokens do tema. Validar:

- fundo;
- máscara;
- cor dos nodes por tipo;
- viewport stroke;
- grid/dots;
- contraste em light.

### 12.3 Terminal no tema claro

ANSI `black` não pode ser igual ao background claro. Definir paleta ANSI light específica:

- black suficientemente escuro e legível;
- bright black visível como cinza;
- cores normais e bright com contraste mínimo;
- selection e cursor visíveis;
- teste com tabela ANSI 16 cores, bold, inverse e dim.

### 12.4 Fontes

Fontes remotas do Google podem atrasar, falhar ou trocar métricas depois do primeiro layout. Para uma app desktop:

- empacotar fontes usadas;
- declarar fallbacks métricos próximos;
- preload apenas dos pesos necessários;
- evitar múltiplas famílias sem necessidade;
- screenshot test deve correr offline;
- verificar que troca de fonte não desloca tabs, graph rows ou toolbars.

### 12.5 Bundle e carregamento

O bundle principal deve ser dividido:

- CodeMirror e linguagens por demanda;
- Git Graph apenas ao abrir Graph;
- xterm addons apenas em Terminal;
- modais/painéis pesados lazy;
- features de Browser debug apenas em desenvolvimento;
- evitar importar todas as linguagens/ícones num barrel único.

Definir orçamento inicial:

- registar baseline por chunk;
- impedir crescimento silencioso significativo no CI;
- medir time-to-first-workspace, não apenas tamanho gzip.

### 12.6 Organização do CSS

Dividir `index.css` em camadas/módulos:

1. reset e base;
2. tokens/themes;
3. layout/shell;
4. canvas/react-flow;
5. terminal;
6. browser;
7. files/editor;
8. git-graph;
9. drawing;
10. modals/overlays;
11. screens auxiliares;
12. utilities limitadas.

Adicionar validações:

- lint para raw colors fora dos ficheiros de tokens/whitelist;
- deteção de seletores duplicados;
- proibir `!important` salvo exceções documentadas;
- proibir seletores globais de componentes sem namespace;
- relatório de regras não usadas quando viável.

## 13. Plano de execução por fases

As fases abaixo são sequenciais nas dependências, mas tarefas internas podem ser paralelizadas quando não tocam nos mesmos ficheiros ou contratos.

### Fase 0 — Baseline, fixtures e observabilidade

#### Objetivo

Congelar evidência dos bugs e criar meios para saber se cada alteração melhora ou piora o sistema.

#### Tarefas

1. preservar status/diff local;
2. criar rota/fixture web local com:
   - breakpoint responsivo;
   - animação;
   - scroll;
   - inputs;
   - loading lento;
   - navegação e redirect;
3. criar workspace fixture com Browser, Terminal, File Tree, Note e sobreposições;
4. criar repositório Git fixture com linear/fork/merge/tags/stash/worktree;
5. adicionar debug overlay opcional com:
   - rect DOM;
   - bounds nativos;
   - zoom;
   - DPR;
   - presentation/motion/visibility states;
   - geometry/capture generation;
6. capturar screenshots/vídeos de baseline;
7. registar métricas de snapshot, RAF, memória e requests do File Tree;
8. documentar comportamento esperado antes de alterar implementação.

#### Gate de saída

- cada bug principal reproduzível por teste ou script documentado;
- artefactos de baseline guardados;
- nenhuma alteração funcional ainda.

### Fase 1 — Contrato transversal do canvas

#### Objetivo

Corrigir coordenadas, drag, z-order e overlays antes de refazer features dependentes.

#### Tarefas

1. criar módulo único de coordenadas;
2. corrigir `zIndex` JSON/DB/React Flow;
3. implementar bring-to-front determinístico;
4. remover colisão eixo a eixo;
5. adotar drag handle explícito;
6. aplicar `nodrag/nopan/nowheel` sistematicamente;
7. criar overlay registry/portal global;
8. remover CSS global de overflow/visibility;
9. adicionar testes unitários e de interação.

#### Dependências

Nenhuma além da Fase 0.

#### Gate de saída

- drag segue o pointer em qualquer vetor;
- z-order sobrevive a reload;
- menus/modais têm ordem previsível;
- conversões passam matriz de zoom/DPR.

### Fase 2 — Refactor do Browser Portal

#### Objetivo

Eliminar estruturalmente flashes, overlap e reflow durante movimento.

#### Tarefas

1. separar controller, geometry, capture, navigation e main manager;
2. implementar estados ortogonais;
3. introduzir motion sessions explícitas;
4. separar Pipeline A e Pipeline B;
5. implementar política híbrida;
6. implementar settle escondido e swap atómico;
7. conservar snapshot durante navegação;
8. resolver first-frame por staging;
9. integrar overlay registry e z-order;
10. otimizar payload/cache de snapshots;
11. implementar suspend/offscreen/destroy;
12. criar testes Electron reais e memória.

#### Gate de saída

- todos os critérios do Browser na secção 17 passam;
- harness isolado e testes reais passam;
- nenhum watchdog é o mecanismo primário de fim de gesto.

### Fase 3 — Tema unificado

#### Objetivo

Eliminar dark hardcoded e evitar recriação de componentes ao mudar tema.

#### Tarefas

1. inventariar cores e superfícies;
2. criar tokens completos;
3. dividir CSS por domínio;
4. inicializar tema antes do mount;
5. sincronizar BrowserWindow;
6. migrar Browser, Canvas, File Tree, editor, Terminal, Graph e modais;
7. usar CodeMirror compartments;
8. definir ANSI light;
9. adicionar lint e screenshots.

#### Gate de saída

- nenhum bloco preto acidental em light;
- reload sem flash de tema;
- alternar tema preserva estado do editor;
- raw colors restantes estão numa whitelist justificada.

### Fase 4 — File Tree e editor

#### Objetivo

Tornar File Tree previsível, escalável e independente do Git Graph.

#### Tarefas

1. decompor componente monolítico;
2. criar modelos de documento/versionamento;
3. corrigir sync externo/dirty conflict;
4. substituir polling indiscriminado;
5. adicionar geração/cancelamento;
6. separar pesquisa nome/conteúdo;
7. virtualizar árvore;
8. mover menu para portal;
9. implementar layouts compact/medium/wide com preservação de estado;
10. adicionar acessibilidade e teclado;
11. cobrir árvore grande e race conditions.

#### Gate de saída

- menu nunca é cortado/deslocado;
- respostas antigas não sobrescrevem estado;
- árvore grande mantém interação fluida;
- theme/resize não perdem buffer, undo ou scroll.

### Fase 5 — Git Graph/Fork

#### Objetivo

Substituir linhas CSS desconectadas por um grafo topológico real e uma UX Git segura.

#### Tarefas

1. atualizar backend para ordem topológica e paginação;
2. criar parser/fixtures robustos;
3. implementar modelo `lanesBefore/segments/lanesAfter`;
4. criar rail SVG;
5. estabilizar lane IDs e cores;
6. reconstruir layout refs/graph/details;
7. preservar scroll por hash;
8. mover ações para toolbar/menu;
9. adicionar dirty guards, confirmações e conflict mode;
10. testar todos os formatos de história.

#### Gate de saída

- nenhum fork/merge fixture possui linha interrompida;
- scroll não altera alinhamento nem cor arbitrariamente;
- operações perigosas não acontecem por mudança de select;
- estado de conflito é recuperável.

### Fase 6 — Drawing unificado

#### Objetivo

Entregar uma única ferramenta de desenho funcional e migrar o legado.

#### Tarefas

1. definir schema versionado;
2. criar DrawingLayer;
3. implementar Pointer Events/pointer capture;
4. implementar subtools MVP;
5. implementar seleção, estilos, transform e undo;
6. persistir operações atómicas;
7. migrar shapes legacy;
8. esconder/remover entradas antigas segundo rollout;
9. testar qualidade e desempenho.

#### Gate de saída

- existe um único botão público Drawing;
- strokes não desviam com zoom;
- resize é deliberado e não distorce por acidente;
- dados antigos abrem corretamente;
- undo funciona por gesto.

### Fase 7 — Desempenho e limpeza

#### Objetivo

Remover trabalho em idle e reduzir fontes de layout shift.

#### Tarefas

1. converter CableSystem para invalidação;
2. indexar nodes/edges;
3. parar RAF depois de convergência;
4. empacotar fontes;
5. lazy load de subsistemas;
6. reduzir polling;
7. remover CSS duplicado e hacks remanescentes;
8. medir CPU, memória e bundle.

#### Gate de saída

- cabos não mantêm CPU ativa em workspace parado;
- nenhum loop/capture continua depois de destroy;
- bundle e startup não pioram relativamente ao baseline;
- fontes funcionam offline sem shift.

### Fase 8 — QA visual, rollout e remoção do legado

#### Objetivo

Validar a integração total e remover caminhos temporários.

#### Tarefas

1. executar matriz Electron em Linux X11 e Wayland;
2. executar macOS/Windows se suportados pelo produto;
3. validar múltiplos monitores/DPR quando possível;
4. rever screenshots com thresholds por região;
5. fazer soak test de criação/destruição de nodes;
6. migrar workspace real de cópia anonimizada;
7. manter flags de rollout para Browser/Drawing/Graph;
8. recolher logs de migração;
9. remover renderers e aliases legacy após estabilidade;
10. atualizar documentação do produto.

#### Gate de saída

- Definition of Done integral satisfeita;
- nenhum caminho legacy necessário para dados migrados;
- rollback documentado para migrações de dados.

## 14. Decomposição sugerida em tickets para um agente de IA

Não entregar o plano inteiro como uma única alteração. Usar tickets com um objetivo verificável e diff limitado.

### CANVAS-01 — Coordenadas canónicas

- criar conversões puras;
- remover cálculos duplicados;
- matriz de testes zoom/DPR/rect.

### CANVAS-02 — zIndex roundtrip

- corrigir wire format e banco;
- aplicar no React Flow;
- teste save/reload e legacy alias.

### CANVAS-03 — Drag vetorial

- remover resolução por eixo;
- handles e utility classes;
- testes de pointer.

### UI-01 — Overlay registry

- camada global de menus/modais;
- registo de rects/oclusão;
- integração inicial com Browser.

### BROWSER-01 — Estados e telemetria

- introduzir state model sem mudar ainda apresentação;
- logs/debug overlay;
- testes de transição.

### BROWSER-02 — Pipelines separados

- geometry latest-only;
- capture coalescido;
- testes de atraso e geração.

### BROWSER-03 — Motion sessions

- start/update/end explícitos;
- pinch/drag/resize;
- watchdog apenas recovery.

### BROWSER-04 — Política snapshot/native

- matriz de apresentação;
- settle escondido;
- overlays e clipping.

### BROWSER-05 — Navegação/first frame

- snapshot stale;
- staging;
- erro/retry/crash.

### BROWSER-06 — Memória e lifecycle

- buffers/blob URLs;
- suspend/destroy;
- soak tests.

### THEME-01 — Tokens e bootstrap

- tokens completos;
- dark/light/system;
- background nativo e no-flash.

### THEME-02 — Migração de componentes

- Browser/Canvas/File Tree/Terminal/modais;
- lint raw colors/duplicate selectors.

### EDITOR-01 — CodeMirror reconfigure

- compartments;
- preservar undo/cursor/scroll;
- testes de theme switch.

### FILES-01 — Decomposição

- separar shell/tree/editor/diff/graph;
- sem mudança visual ampla no mesmo ticket.

### FILES-02 — Documento e sync externo

- versions/dirty/conflict;
- eliminar stale React content.

### FILES-03 — Requests e pesquisa

- cancelamento;
- name vs `>` content;
- polling adaptativo.

### FILES-04 — Virtualização/menu/layout

- lista grande;
- context portal;
- responsive state-preserving.

### GRAPH-01 — Backend topológico

- `--topo-order`/paginação/parser;
- fixtures Git.

### GRAPH-02 — Modelo de lanes

- segmentos e invariantes;
- testes puros para histórias complexas.

### GRAPH-03 — Rail SVG

- paths contínuos;
- virtualização e coluna de texto fixa;
- screenshots.

### GRAPH-04 — Refs e detalhes

- layout Fork/VS Code;
- scroll anchor e seleção.

### GRAPH-05 — Operações seguras

- menus;
- dirty guard;
- conflict mode;
- remote configurável.

### DRAW-01 — Schema e camada

- entidade própria;
- DrawingLayer;
- persistência básica.

### DRAW-02 — Input e ferramentas

- Pointer Events;
- pen/primitivas/eraser MVP;
- smoothing.

### DRAW-03 — Seleção e undo

- transform/style/order;
- transações.

### DRAW-04 — Migração legacy

- fixtures/backup/compatibilidade;
- remoção das entradas antigas.

### PERF-01 — CableSystem

- invalidação;
- índices;
- idle CPU tests.

### PERF-02 — Fonts e chunks

- fontes locais;
- lazy loading;
- budgets.

### QA-01 — Electron visual suite

- fixtures determinísticas;
- screenshots/vídeos;
- matriz theme/zoom/DPR/window.

## 15. Ordem e regras para os pull requests

1. PRs de contratos e testes antes de PRs de redesign visual.
2. Um PR não deve misturar Browser, Graph e Drawing.
3. Alterações de schema devem incluir migração, fixture de dados antigos e rollback.
4. Cada PR deve declarar:
   - bug reproduzido;
   - causa raiz;
   - invariantes alterados;
   - testes adicionados;
   - screenshots antes/depois quando visual;
   - impacto em memória/CPU quando aplicável.
5. Não aceitar uma correção baseada apenas em aumentar timeout.
6. Não aceitar `!important` global como solução de clipping/tema.
7. Não aceitar screenshot do Browser como único modo permanente: inputs, vídeo, seleção e acessibilidade exigem live quando estável.
8. Não aceitar native live permanente: não pode compor corretamente durante transformação/oclusão.
9. Não aceitar Git Graph desenhado apenas com pseudo-elementos por row.
10. Não aceitar recriação do CodeMirror para trocar tema.

## 16. Estratégia de validação

### 16.1 Pirâmide de testes

#### Unitários

- coordenadas;
- clipping/interseção;
- state machines;
- lane algorithm;
- migrations;
- reducers/document versions;
- geração/cancelamento.

#### Integração renderer

- node interactions;
- theme switch;
- virtualized list;
- menu portal;
- Drawing input;
- Graph row continuity.

#### Integração main/IPC

- lifecycle de View;
- geometry latest-only;
- capture cancellation;
- child View ordering;
- crash/destroy;
- IPC schema compatibility.

#### Electron end-to-end

- composição visual real;
- pan/zoom/drag/resize;
- overlays sobre Browser;
- navegação;
- persistência/reload;
- screenshots e vídeos.

#### Soak/performance

- 30–60 minutos de pan/zoom/navegação;
- criar/destruir 50+ portais em ciclos;
- workspace com muitos cabos;
- árvore grande;
- histórico Git grande;
- Drawing com muitos pontos.

### 16.2 Instrumentação mínima

- contagem de geometry updates enviados/aplicados/ignorados;
- capturas pedidas/iniciadas/coalescidas/canceladas/concluídas;
- bytes de snapshot vivos;
- tempo até native promotion;
- mudanças de presentation state;
- frames de CableSystem em idle;
- duração e quantidade de pedidos do File Tree;
- rows visíveis/total da virtualização;
- duração do cálculo de lanes;
- tamanho/tempo de migração Drawing;
- memória antes/depois de destroy.

Logs devem ser ativáveis e não expor URLs/conteúdo sensível por padrão.

### 16.3 Ambientes

Prioridade de plataforma:

1. Linux Wayland;
2. Linux X11;
3. macOS;
4. Windows.

Em Linux, testar pelo menos:

- escalas de display 100%, 125%, 150% e 200% quando suportado;
- GPU ativa e fallback software;
- janela maximizada, restaurada e movida entre monitores;
- fontes/rede indisponíveis.

## 17. Definition of Done

### 17.1 Browser Portal

- nenhum pixel da página aparece fora da moldura do Browser;
- não existe flash branco/preto durante navegação ou promoção;
- pan, zoom, pinch, drag e resize usam snapshot estável;
- página não muda breakpoints durante zoom do canvas;
- overlays DOM aparecem sempre acima quando necessário;
- native live só aparece em estado estável, totalmente visível e não ocluído;
- z-order entre múltiplos browsers e outros nodes é determinístico e persistente;
- último frame permanece visível durante loading/error;
- geometria nunca espera por screenshot;
- no máximo uma captura relevante por settle/mudança final;
- destruir portal liberta View, listeners, timers e snapshots.

### 17.2 Tema/File Tree/editor

- nenhuma superfície preta acidental em light;
- nenhum flash dark ao abrir em light;
- mudar tema não recria CodeMirror nem perde estado;
- ANSI black é legível no terminal claro;
- menu contextual mantém posição após scroll/zoom;
- pesquisa por nome e conteúdo são distintas;
- requests antigos não vencem requests novos;
- árvore grande continua fluida;
- resize não perde seleção, buffer ou scroll.

### 17.3 Git Graph

- todos os forks e merges das fixtures têm paths contínuos;
- virtualização/scroll não corta grafo;
- texto começa sempre na mesma coluna;
- lane mantém identidade/cor enquanto vive;
- refresh preserva commit e âncora de scroll;
- refs não são truncadas arbitrariamente;
- checkout não acontece por seleção acidental;
- operações destrutivas têm confirmação e dirty guard;
- conflitos possuem fluxo Continue/Abort visível.

### 17.4 Drag

- posição final corresponde ao vetor solicitado, salvo snap explícito;
- nenhum controlo interno arrasta o node;
- overlap e bring-to-front são previsíveis;
- comportamento é consistente em todos os zooms e DPRs;
- reload preserva posição e ordem.

### 17.5 Drawing

- existe um único botão Drawing;
- subtools aparecem numa palette coerente;
- stroke acompanha pointer sem offset;
- desenho não recebe ports de node funcional;
- resize/transform não distorce acidentalmente;
- undo/redo trabalha por gesto;
- dados legacy migram sem perda visível;
- save/reload reproduz a geometria.

### 17.6 Desempenho e estabilidade

- CableSystem não mantém RAF permanente em idle;
- CPU de workspace parado retorna a baseline aceitável;
- não existem listeners/timers órfãos depois de fechar nodes/workspace;
- memória não cresce continuamente em ciclos de Browser;
- fontes funcionam offline sem layout shift;
- bundle é dividido e possui orçamento monitorizado;
- suíte visual real corre no CI ou numa pipeline dedicada reproduzível.

## 18. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| Electron/OS não pinta View invisível | first-frame difícil | staging off-canvas ou janela escondida, testado por plataforma |
| snapshot fica stale | sensação de atraso | badge/loading discreto, captura final coalescida e promoção rápida |
| demasiadas capturas | memória/CPU | budgets, buffers, coalescing e suspensão offscreen |
| refactor de tema cria regressões extensas | UI inconsistente | migração por domínio + screenshots dark/light |
| novo grafo falha em histórias raras | linhas erradas | fixtures criss-cross/octopus e invariantes puras |
| virtualização quebra teclado/menu | UX pior | modelo de seleção independente do DOM + testes E2E |
| migração Drawing perde dados | perda de trabalho | schema versionado, backup e renderer legacy temporário |
| alterações locais existentes colidem | perda de trabalho do utilizador | inventário inicial, commits pequenos e merge consciente |
| PR grande torna causa de regressão opaca | revisão difícil | tickets/PRs pequenos e gates por fase |

## 19. Prompt de handoff recomendado para o agente executor

O seguinte texto pode acompanhar este ficheiro:

> Implementa o plano em `docs/plano-implementacao-renderizacao-file-tree-git-graph-drawing.md` por fases e tickets. Não tentes executar tudo num único diff. Começa pela Fase 0 e Fase 1, preserva todas as alterações locais existentes e não uses comandos Git destrutivos. Antes de cada ticket, reproduz o bug, identifica os ficheiros exatos e escreve os testes que demonstram a causa. Depois implementa apenas esse ticket, executa validação proporcional e apresenta diff, testes e riscos. Não resolvas problemas do Browser com timeouts ou CSS global; segue a política híbrida native/snapshot. Não recries CodeMirror para mudar tema. Não desenhes o Git Graph com pseudo-elementos independentes. Não mantenhas Shape e Draw como duas ferramentas públicas. Pára ao fim de cada fase para revisão dos gates de saída.

## 20. Decisão final

A ordem correta não é começar pelo redesign do Git Graph nem por retoques CSS. Primeiro devem ser estabilizados os contratos partilhados de coordenadas, z-order, drag, overlays e tema. O Browser depende diretamente desses contratos; o File Tree, o Git Graph e Drawing dependem deles indiretamente.

O Browser requer uma solução híbrida porque uma View nativa e o DOM transformado nunca terão composição perfeita durante movimento. O Git Graph requer dados topológicos e SVG, não ajustes cosméticos. O tema claro requer tokens e reconfiguração de editor, não mais overrides. Drawing requer um domínio/camada próprios, não mais um node Shape genérico.

Executado nesta ordem, o trabalho elimina causas raiz e reduz a probabilidade de cada correção reabrir bugs noutra área.
