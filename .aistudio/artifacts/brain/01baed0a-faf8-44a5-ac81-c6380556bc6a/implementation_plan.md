## Goal Description

Resolver definitivamente os bloqueios identificados na revisão final da persistência das configurações de pagamento do Mercado Pago no **PX CUSTOM — Plataforma de Ingressos, Eventos & Check-in Online**, garantindo que as configurações administrativas sobrevivam a novos deploys na Hostinger sem exigir novas migrations no banco de dados, que falhas ou corrupções operem de maneira estritamente *fail-closed* (`HTTP 503`), que o caminho em disco seja independente do diretório de trabalho do processo Node.js e que todos os cenários de falha de auditoria, rollback e recuperação administrativa possuam cobertura automatizada comprovada.

## Aesthetic Direction

- **Domain**: Painel Administrativo Automotivo & Plataforma de Ingressos/Checkout (**PX CONTROL** / **PX CUSTOM**).
- **Aesthetic Persona**: *Precision Motorsport Control* — estética automotiva premium em modo escuro, alto contraste funcional e feedback operacional inequívoco.
- **Brand Inspirations**: Porsche Track Precision, Brembo Technical Consoles, FIA Timing & Telemetry Systems.
- **Color Palette**:
  - Background Primary: `#09090B` (Grafite profundo / Preto carbono)
  - Background Secondary: `#18181B` (Superfície estrutural com bordas sutis `#27272A`)
  - Text Primary: `#FAFAFA`
  - Text Secondary: `#A1A1AA`
  - Accent Primary: `#DC2626` (Vermelho oficial PX CUSTOM)
  - Accent Secondary: `#EF4444`
  - Semantic Status: `#16A34A` (Operacional / Sincronizado), `#D97706` (Alerta de contingência), `#DC2626` (Bloqueio *fail-closed* / Erro crítico)
- **Typography**:
  - Heading Font: Tipografia display condensada/geométrica existente do projeto, peso `700`, `tracking-tight`.
  - Body Font: Sans-serif limpa de alta legibilidade em telas móveis e desktops (`14px`–`16px`).
  - Monospace Font: `font-mono tabular-nums` para códigos de erro, timestamps de auditoria e identificadores técnicos.
- **Layout & Viewport Budget**:
  - Preservação integral do layout existente do **PX CONTROL** e do modal de **Checkout**, mantendo superfície limpa, sem aninhamento desnecessário de cartões e com remoção imediata de banners de erro de carregamento assim que o administrador regravar uma configuração válida.

## User Review Required

As decisões arquiteturais críticas foram alinhadas e confirmadas:

1. **Persistência Durável Sem Novas Migrations**:
   - A tabela existente `public.audit_logs` no Supabase será utilizada como fonte durável de verdade para os registros `action = 'UPDATE_PAYMENT_SETTINGS'` (`entity = 'payment_settings'`, `entity_id = 'mercado_pago'`), mantendo o arquivo local de configurações como cache sincronizado de baixa latência e resolvido de forma determinística a partir da raiz do módulo/projeto (independente de `process.cwd()`).
2. **Política Estritamente Fail-Closed (`HTTP 503`)**:
   - Quando o Supabase estiver inacessível para consultar o estado durável (e não houver garantia de integridade) ou quando a configuração persistida/cache local estiver corrompida ou inválida, os endpoints `/api/payments/config`, `/api/admin/payments/config` (`GET`) e `/api/orders/create` retornarão `HTTP 503` (*fail-closed*), impedindo que métodos desativados pelo administrador (como Pix ou Cartão) voltem a ficar disponíveis acidentalmente após um deploy ou falha.
   - O retorno às configurações padrão iniciais (`Pix` e `Cartão` habilitados) ocorrerá **exclusivamente** quando a consulta confirmar ausência de configuração prévia (`default_initial_state`) e ausência de arquivo local corrompido.

## Architecture & Data Flow

```
+-------------------------------------------------------------------------+
|                        PX CONTROL (Admin UI)                            |
|  - Exibe banner de erro se GET retornar HTTP 503                        |
|  - Mantem formulario editavel para recuperacao administrativa           |
|  - Limpa loadError imediatamente apos PUT/POST retornar HTTP 200        |
+------------------------------------+------------------------------------+
                                     |
                        PUT / POST /api/admin/payments/config
                        (Valida JWT + Role ADMIN/SUPER_ADMIN + Payload)
                                     |
                                     v
+-------------------------------------------------------------------------+
|               Camada de Persistencia Transacional (Backend)             |
|                                                                         |
|  1. Inspeciona cache local (caminho absoluto fixo via import.meta.url)  |
|     e ultimo registro em public.audit_logs (sem bloquear se corrompido) |
|  2. Grava arquivo temporario (.tmp) + fsync + rename atomico            |
|  3. Insere registro obrigatorio em public.audit_logs:                   |
|     action = 'UPDATE_PAYMENT_SETTINGS', details = { old, new_config }   |
|                                                                         |
|  +-- Se insert no Supabase falhar:                                      |
|      +-- Tenta reverter cache local para o snapshot anterior            |
|      +-- Rollback OK   -> HTTP 500 (AUDIT_LOG_FAILED, rolledBack: true) |
|      +-- Rollback FAIL -> HTTP 500 (AUDIT_LOG_AND_ROLLBACK_FAILED,      |
|                           rolledBack: false)                            |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|         Resolucao Autoritativa de Leitura (Checkout & Config API)       |
|         GET /api/payments/config  |  POST /api/orders/create            |
|                                                                         |
|  1. Consulta ultimo UPDATE_PAYMENT_SETTINGS em public.audit_logs        |
|     + inspeciona cache local sincronizado:                              |
|     - Corrupcao local ou no registro de auditoria -> HTTP 503           |
|     - Erro de comunicacao com Supabase            -> HTTP 503           |
|     - Registro valido no Supabase (mesmo se cache local foi apagado     |
|       por novo deploy na Hostinger)               -> Re-hidrata cache   |
|                                                      local e aplica     |
|     - Nenhum registro em audit_logs + sem arquivo corrompido            |
|       (instalacao inicial)                        -> Defaults iniciais  |
+-------------------------------------------------------------------------+
```

## Key Features & UX Flows

1. **Sobrevivência a Novos Deploys na Hostinger (Sincronização Supabase + Cache Local)**:
   - Em um novo deploy onde o diretório de release é recriado do zero (sem arquivo local), o servidor consulta `public.audit_logs` (`action = 'UPDATE_PAYMENT_SETTINGS'`, `entity = 'payment_settings'`, `entity_id = 'mercado_pago'`) ordenado por `created_at DESC LIMIT 1`.
   - Ao encontrar a última configuração salva pelo administrador (por exemplo, `credit_card.enabled = false`), o servidor valida a estrutura de `details.new_config`, re-hidrata automaticamente o cache local de forma atômica e aplica a restrição imediatamente, bloqueando tentativas de compra com o método desativado em `/api/orders/create` (`HTTP 400`).
2. **Resolução Determinística de Caminho e Proteção Git**:
   - O caminho padrão do cache local passa a ser calculado a partir de `fileURLToPath(import.meta.url)` relativo à raiz do projeto, garantindo que processos iniciados de qualquer diretório de trabalho na Hostinger leiam e gravem exatamente no mesmo local.
   - Regras explícitas de exclusão são adicionadas ao controle de versão para impedir que arquivos de estado de pagamento em tempo de execução, arquivos temporários (`.tmp`) ou snapshots de rollback sejam versionados acidentalmente.
3. **Rollback Auditável e Tratamento de Falha Dupla**:
   - A operação de atualização administrativa recebe suporte a injeção do mecanismo de reversão em testes, permitindo validar deterministicamente tanto o cenário em que a falha de auditoria reverte o arquivo (`rolledBack: true`, `AUDIT_LOG_FAILED`) quanto o cenário crítico em que a auditoria e a reversão falham simultaneamente (`rolledBack: false`, `AUDIT_LOG_AND_ROLLBACK_FAILED`), sem jamais afirmar falsamente que a alteração foi revertida.
4. **Recuperação Administrativa Completa no PX CONTROL**:
   - Caso o estado esteja corrompido ou indisponível (`HTTP 503`), a tela de configurações de pagamento exibe o alerta técnico correspondente, mantém os controles de edição acessíveis para o administrador e, assim que o salvamento (`PUT`/`POST`) for concluído com sucesso (`HTTP 200`), limpa imediatamente o estado de erro de carregamento (`loadError = null`) e exibe a configuração recém-restaurada.
5. **Bloqueio Fail-Closed no Checkout**:
   - Se a leitura das configurações falhar (`HTTP 503`) no carregamento do modal de checkout ou na validação de `/api/orders/create`, nenhum método de pagamento é assumido como habilitado por padrão e nenhuma cobrança ou pedido é criado.

## Verification Plan

1. **Testes Automatizados de Segurança, Persistência e Rollback**:
   - **Cenário A**: Ausência inicial de configuração (sem registro em `audit_logs` e sem arquivo local) retornando padrões iniciais com segurança.
   - **Cenário B**: Arquivo local corrompido ou ilegível bloqueando `GET /api/payments/config` e `POST /api/orders/create` com `HTTP 503` (*fail-closed*).
   - **Cenário C**: Administrador corrigindo arquivo corrompido via `PUT /api/admin/payments/config` (`HTTP 200`) e restaurando a operação normal.
   - **Cenário D**: Falha no insert de `audit_logs` com rollback bem-sucedido (`HTTP 500`, `code: 'AUDIT_LOG_FAILED'`, `rolledBack: true`) preservando o estado anterior.
   - **Cenário E**: Falha simultânea no insert de `audit_logs` e no rollback do arquivo (`HTTP 500`, `code: 'AUDIT_LOG_AND_ROLLBACK_FAILED'`, `rolledBack: false`) com mensagem precisa informando que a reversão automática não pôde ser concluída.
   - **Cenário F**: Persistência durável após reinício do servidor e remoção do arquivo local (simulando novo deploy na Hostinger), comprovando re-hidratação a partir de `public.audit_logs` e bloqueio de método desativado em `/api/orders/create`.
   - **Cenário G**: Indisponibilidade do Supabase na resolução autoritativa bloqueando pedidos com `HTTP 503` (*fail-closed*).
   - **Cenário H**: Limpeza de `loadError` na interface administrativa após salvamento bem-sucedido.
2. **Suíte Completa de Validação Local (Sem Tocar no Banco Real)**:
   - Execução de `npm run lint`, `npm run build`, `npm run test:runtime`, `npm run test:gate`, `npx tsx scripts/test-audit-security.ts`, `npx tsx scripts/test-order-confirmation-email.ts`, `git diff --check` e `git status --short`.
