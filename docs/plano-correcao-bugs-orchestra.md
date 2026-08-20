# Plano de implementação — estabilidade e bugs do Orchestra

## Agente recomendado

Executar com **GPT-5.6 Sol, effort `xhigh`**, num único worktree dedicado.
Não usar `ultra`, porque este trabalho pede um agente responsável e uma revisão
centralizada, não delegação automática. Se `xhigh` não estiver disponível, usar
`high`. Luna `max` é uma alternativa económica, mas não é a primeira escolha
para este lote de IPC, autenticação, PTY, Electron, Rust e empacotamento.

## Objetivo

Corrigir primeiro as falhas que impedem o próprio Orchestra de coordenar
agentes. Depois corrigir os bugs funcionais registados na nota, preservar a
skill atualizada e produzir um `.deb` verificável. Não instalar o pacote antes
da revisão do coordenador.

## Regras de execução

- Trabalhar num worktree/branch exclusivos, criados a partir de um estado
  conhecido. Não alterar nem limpar o working tree principal sujo.
- Não iniciar manualmente a versão instalada de `orchestra-desktop` ou
  `orchestra-core` durante testes. Usar sockets, runtime e dados temporários
  isolados para evitar tocar nas sessões reais do utilizador.
- Não reutilizar tokens retirados de outros processos e nunca imprimir tokens.
- Fazer commits pequenos por fase. Não juntar correções de lifecycle, browser,
  terminal e UI num único commit.
- Antes de alterar uma área, reproduzir o problema com um teste automatizado ou
  harness determinístico. Quando isso for impraticável, documentar a evidência
  manual e adicionar pelo menos um teste da unidade responsável.
- Não considerar um item concluído apenas porque compila. Exigir os critérios
  de aceitação definidos abaixo.

## Fase 0 — baseline e mapa de ownership

1. Registar `git status`, commit-base e versões de Node, npm e Rust.
2. Executar o baseline:
   - `cargo test -q`
   - `npm --prefix apps/desktop run check`
   - `node apps/desktop/test.js`
   - `npm run skill:check`
   - `node scripts/verify-package-resources.test.mjs`
   - `npm test`
3. Mapear o lifecycle entre Desktop, core, CLI, socket, portal socket, tokens,
   terminais e registos na base de dados.
4. Identificar quais falhas já têm correções parciais no working tree/HEAD e
   evitar implementações duplicadas.

Entrega: relatório curto do baseline, reprodução de cada P0 e lista dos testes
que serão adicionados.

## Fase 1 — P0: daemon, socket e instância única

### Problemas

- O socket pode aparecer em `LISTEN` e ainda assim devolver
  `Connection refused`.
- Uma segunda instância pode substituir/unlinkar o socket da primeira e criar
  dois cores com autenticação divergente.
- Depois da divergência, `doctor` pode passar enquanto operações autenticadas
  falham.

### Implementação esperada

1. Tornar o startup do core seguro e atómico:
   - distinguir socket ativo de socket realmente obsoleto;
   - nunca remover o socket de um daemon vivo;
   - falhar com mensagem clara quando já existe uma instância proprietária;
   - remover apenas sockets stale comprovados.
2. Definir ownership entre Desktop e core para impedir cores órfãos ou
   duplicados. O encerramento deve limpar apenas recursos da própria instância.
3. Derivar o portal socket da instância exata e impedir colisão com outra
   instância.
4. Fortalecer `orchestra doctor`: validar handshake e autenticação da sessão,
   não apenas a existência/negociação básica do daemon.
5. Tornar erros distinguíveis: daemon ausente, socket stale, conflito de
   instância, token inválido e sessão não registada.

### Testes obrigatórios

- Start normal, shutdown e restart no mesmo socket.
- Socket stale sem processo: recuperação bem-sucedida.
- Segundo core contra socket vivo: falha sem interromper o primeiro.
- Segundo Desktop/core não muda o token nem o socket da primeira sessão.
- `doctor`, `connections` e `agents` concordam sobre uma sessão válida.
- Token inválido gera erro de autenticação específico, não sucesso parcial.

Critério de aceitação: repetir ciclos de startup/restart e tentativa de segunda
instância sem `Connection refused`, split-brain ou perda da sessão saudável.

## Fase 2 — P0: spawn, arestas e comunicação sem falso sucesso

### Problemas

- `terminal spawn --connect-to <terminal-id>` pode criar o terminal e ignorar a
  conexão; hoje o core só trata corretamente `self`.
- Um `sessionId` é devolvido mesmo sem aresta.
- Sessões antigas aparecem como conectadas quando já não estão alcançáveis.
- `inputWritten: true` é confundido com processamento pelo agente.

### Implementação esperada

1. Escolher e aplicar um contrato explícito para `--connect-to`:
   - suportar `self` de ponta a ponta;
   - rejeitar IDs arbitrários com erro de validação enquanto não forem
     suportados, ou implementar IDs com autorização e testes completos;
   - nunca ignorar silenciosamente o valor recebido.
2. A resposta de spawn deve separar `terminalCreated`, `connectionCreated`,
   `edgeId` e permissões. Se a conexão solicitada falhar, o comando deve falhar
   ou devolver estado parcial inequívoco.
3. Garantir persistência e remoção correta das arestas ao sair/reiniciar.
4. Separar estados de entrega de mensagens: `ptyWritten`, `delivered`,
   `agentAcknowledged`, `completed` e `unverified`, conforme as capacidades do
   destino. Não inventar acknowledgements que o protocolo não consegue provar.
5. Corrigir/prunar sessões stale na listagem de agentes.

### Testes obrigatórios

- Spawn com `--connect-to self` cria exatamente uma aresta com permissões
  esperadas.
- Target não suportado falha claramente e não cria terminal órfão.
- Spawn parcial não é apresentado como conectado.
- `send` e `ask --wait` distinguem escrita PTY, timeout e conclusão.
- Restart/exit remove ou marca corretamente sessões inacessíveis.

Critério de aceitação: um coordenador cria um agente, confirma a aresta, envia
uma tarefa semanticamente e recebe conclusão verificável sem tocar diretamente
na TUI.

## Fase 3 — P0: paste e input do terminal

### Problemas

- Conteúdo grande/multiline no `agy` ou noutra TUI pode ser duplicado,
  fragmentado, embrulhado duas vezes em bracketed paste ou ficar sem submit.
- Pressão/backpressure e normalização de newline não estão suficientemente
  cobertas.

### Implementação esperada

1. Centralizar a transformação de paste numa única camada.
2. Respeitar o modo bracketed-paste anunciado pelo terminal, sem dupla
   aplicação de `ESC[200~`/`ESC[201~`.
3. Definir chunking e backpressure determinísticos para payloads grandes.
4. Preservar UTF-8, linhas vazias, tabs e símbolos; normalizar apenas CR/LF
   conforme o contrato do PTY.
5. Não submeter automaticamente texto colado sem ação explícita do utilizador.
6. Manter `terminal type` orientado para input curto; mensagens entre agentes
   devem usar `send/ask`.

### Testes obrigatórios

- Payloads de 1 KB, 64 KB e 256 KB.
- Texto Unicode, tabs, CRLF, muitas linhas e sequências parecidas com escapes.
- Shell normal, TUI com bracketed paste ligado e desligado.
- Exatamente uma cópia do conteúdo chega ao processo filho.
- O paste não dispara Enter automaticamente.

Critério de aceitação: o conteúdo recebido pelo fixture PTY é byte-a-byte o
esperado, sem duplicação nem escapes adicionais.

## Fase 4 — P1: browser portal preto

1. Criar uma reprodução usando o harness real de `WebContentsView`.
2. Auditar ownership do portal, `firstFrame`, bounds, visibilidade,
   apresentação, snapshot fallback e navegação.
3. Impedir que URL/navigation state seja publicado como “visível” antes do
   primeiro frame apresentável.
4. Tratar crash, detach, resize, reparent e troca de floor/canvas.
5. Expor estado de diagnóstico útil na CLI: attached, loading, first-frame,
   visible, frozen, crashed e snapshot disponível.

Critério de aceitação: navegar, redimensionar, ocultar/mostrar e reconectar o
portal repetidamente sem frame preto; screenshot e estado visual devem
corresponder à URL atual.

## Fase 5 — P1/P2: bugs funcionais da nota

### Git Graph — alterações do commit

- Adicionar no backend Git uma operação segura equivalente a `git show` para
  listar ficheiros, status e diff de um commit selecionado.
- Validar hash e paths; não montar comandos shell concatenados.
- Mostrar no inspector do `FilesNode` os ficheiros alterados e o diff, com
  loading, empty state, erro e cancelamento de seleção antiga.
- Testar commits normais, root, merge, rename, binary e commit sem diff.

### Desconectar corda

- Validar a implementação existente de “Desconectar”.
- Confirmar seleção da aresta, persistência, permissões, undo/state refresh e
  remoção visual. Não duplicar a feature se já estiver completa.

### Botão `+` do terminal

- Inserir uma única vez o caminho correto do ficheiro selecionado na sessão
  correta.
- Aplicar quoting compatível com o shell quando necessário.
- Não enviar Enter e não duplicar o path ao refocar o terminal.

### Botão de voz

- Implementar estados explícitos: idle, requesting-permission, recording,
  processing, inserting, error e cancelled.
- Pedir consentimento de microfone e tornar claro se áudio sai da máquina.
- Criar uma interface de transcrição substituível; não esconder dependência de
  rede/provider.
- Inserir a transcrição no composer do terminal de forma progressiva, sem
  auto-submit e com cancelamento.
- Testar permissão negada, silêncio, erro do provider, cancelamento e mudança
  de terminal durante a transcrição.

### Modal de agentes

- Adicionar aba `Agents` ao lado de `Appearance`.
- Separar catálogo conhecido de agentes personalizados.
- Persistir nome, comando e opções customizadas com validação e edição/remoção.
- Não executar comandos durante a configuração; usar argv seguro no spawn.
- Preservar compatibilidade com ferramentas detectadas automaticamente.

Critério de aceitação: cada item possui teste automatizado relevante e roteiro
manual reproduzível para a interface.

## Fase 6 — skill e notas

1. Preservar as melhorias já feitas em `skills/orchestra-canvas/SKILL.md`:
   distinção Orchestra/Orca, operações semânticas antes de PTY, spawn
   verificado, lifecycle seguro e sincronização da cópia do plugin.
2. Executar `npm run skill:sync` e `npm run skill:check`.
3. Considerar uma operação CLI granular para checklist de nota, para marcar um
   item existente sem reescrever uma nota grande com imagens embebidas.
4. Adicionar testes que garantam que o pacote contém a skill canónica atual e
   que aliases/loaders apontam para ela corretamente.

Critério de aceitação: source, plugin gerado e conteúdo do pacote ficam iguais;
nenhuma instrução recomenda Orca para uma tarefa Orchestra.

## Fase 7 — regressão, revisão e `.deb`

1. Executar novamente todo o baseline da Fase 0.
2. Executar E2E isolado pelo menos três vezes para detectar flakiness de socket
   e lifecycle.
3. Fazer revisão de segurança focada em tokens, permissões de aresta, path
   traversal, command injection e exposição de áudio.
4. Fazer revisão de concorrência focada em sockets, shutdown, PTY queues,
   browser lifecycle e cleanup.
5. Executar `npm run package:deb`.
6. Verificar conteúdo do pacote: core, CLI, skill, plugin, portal resources e
   permissões executáveis.
7. Entregar ao coordenador:
   - commits por fase;
   - resumo de causa raiz;
   - testes executados e resultados;
   - riscos/itens adiados;
   - caminho e checksum do `.deb`.

O coordenador fará o code review final e autorizará a instalação. Só depois da
instalação devem ser executados testes reais dentro do Orchestra e marcados os
itens concluídos na nota conectada.

## Ordem obrigatória

`Fase 0 → Fase 1 → Fase 2 → Fase 3 → Fase 4 → Fase 5 → Fase 6 → Fase 7`

Não avançar para funcionalidades visuais enquanto daemon, autenticação, spawn
e comunicação continuarem não determinísticos.
