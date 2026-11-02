# Loja Virtual IST — fluxo completo de compra e entrega digital

**Elaboração:** 31/10/2026.
**Atualização:** 02/11/2026.
**Código de referência local:** e8cf640e0dd3afddfc076b875b11fd00e92658fc mais a recuperação S1 isolada consolidada no commit que contém esta revisão.
**Base histórica anterior:** 2d82501bd28dc0f21a1e5cda0680c6d4f7260839.

Commits que fundamentam esta atualização:

| Commit | Responsabilidade |
|---|---|
| `970e4f8c639a2a89128064720b955dc953884416` | S1 + S2: intenção durável, recuperação segura e cronologia financeira |
| `38a09adb57db9e6dffd9e6a23a4603d8cb51830f` | S3 e popup: preparação separada do gesto de abertura, continuidade e acompanhamento |
| `3b40635aa8fdfc28dba5f3b9481f231c26250555` | Estrutura e apresentação do aviso da Editora; sem efeito financeiro |
| `e8cf640e0dd3afddfc076b875b11fd00e92658fc` | Preenchimento do e-mail pelo perfil autenticado |

**Abrangência:** produto, carrinho, pedido, PayPal, direitos, biblioteca, PDF, recibo, recuperação, reconciliação e eventos adversos.

Documento descritivo da implementação existente. Não autoriza cobranças, reconciliações, reavaliações de direitos, envios ou mudanças de configuração. Os diagramas descrevem caminhos implementados; não constituem prova de que cada caminho já foi exercitado em produção.

Fontes: código local da revisão indicada, validações locais S1–S3/popup/e-mail, homologações Sandbox descritas na seção 11.3 e registros históricos A–G/H1–H4. A recuperação S1 isolada foi instalada e homologada somente no WSL2 IST-HOMOLOG-2004; isso não comprova ativação do recuperador global nem publicação dessa alteração na VPS. Nesta consolidação foram executados somente testes com provider simulado e MariaDB descartável, sem nova chamada PayPal, mudança no banco persistente ou alteração da instalação ativa.

Os diagramas usam **Mermaid**, renderizável no GitHub e em visualizadores compatíveis. As tabelas distinguem o vocabulário permitido das transições efetivamente automatizadas.

## Índice

1. [Visão geral](#visao)
2. [Entidades e identificadores](#entidades)
3. [Pré-condições do produto](#produto)
4. [Carrinho, cotação e pedido](#pedido)
5. [Ordem, aprovação e captura](#paypal)
6. [Confirmação e ativação digital](#direitos)
7. [Consulta, acompanhamento e retomada](#polling)
8. [Biblioteca e PDF](#download)
9. [Recibo](#recibo)
10. [Recuperação LINK/OTP](#recuperacao)
11. [Webhooks, recuperação financeira e adversos](#reconciliacao)
12. [Todos os estados dos contratos](#estados)
13. [Todas as transições permitidas do pagamento](#transicoes)
14. [Endpoints e efeitos](#endpoints)
15. [Rotinas e arquivos envolvidos](#rotinas)
16. [Agendadores](#agendadores)
17. [Integridade e caminhos de falha](#falhas)
18. [Roteiro de diagnóstico](#diagnostico)
19. [Referências](#referencias)

<a id="visao"></a>

## 1. Visão geral: quatro conclusões diferentes

- **Aprovação do comprador:** ordem PayPal APPROVED. Não equivale a captura.
- **Quitação financeira:** captura integral comprovada, pagamento CAPTURADO e pedido PAGO persistidos.
- **Liberação digital:** direito ATIVO, versão adquirida válida e solicitação de download autorizada.
- **Comunicação:** recibo processado separadamente pelo worker SMTP.

Popup fechado, indicação de débito no cartão, callback onApprove, HTTP 200 ou e-mail isolado não substituem a cadeia financeira e digital.

~~~mermaid
flowchart TD
    A[Produto com PDF publicado] --> B[Adicionar ao carrinho]
    B --> C[Cotacao oficial]
    C --> D[Email e criacao do pedido]
    D --> E[CRIADO e direito AGUARDANDO_CONFIRMACAO]
    E --> F[Preparar pagamento: SDK, ordem e intencao duravel]
    F --> F2[Continuar no PayPal: novo gesto abre popup]
    F2 --> G[Comprador aprova]
    G --> H[Callback solicita captura ao backend]
    F --> W[Worker encontra intencao nao enviada]
    W --> W2{Aprovacao comprovada e pedido vigente?}
    W2 -->|Sim| H
    W2 -->|Nao| W3[Aguardar ou interromper sem captura]
    H --> I{Captura comprovada?}
    I -->|Pendente ou inconclusiva| J[Pendencia ou desconhecido]
    I -->|Recusa ou revisao| V[Atendimento sem liberar download]
    J --> K[Consulta, webhook ou recuperacao financeira]
    K --> I
    I -->|Sim| L[CAPTURADO e PAGO]
    L --> M[Avaliar e ativar direitos]
    M --> N{Direitos validos e ATIVOS?}
    N -->|Nao| O[Preservar pagamento e acompanhar pendencia]
    N -->|Sim| P[Redirecionar para biblioteca]
    P --> Q[Autorizar e validar PDF privado]
    Q --> R[Entregar livro]
    L --> S[Notificacao PENDENTE]
    S --> T[Worker de recibos e SMTP]
    T --> U[ENVIADO, FALHA ou INCERTO]
~~~

<a id="entidades"></a>

## 2. Entidades, identificadores e fontes de verdade

| Entidade | Onde fica | Identificação e finalidade |
|---|---|---|
| Livro editorial | ist_livros | id, título, idioma, formato e metadados |
| Produto | ist_loja_produtos | id, livro_id, SKU, preço, moeda e flags |
| Categoria | ist_loja_categorias | Caminho de ancestrais e ativação |
| Versão PDF | ist_loja_arquivo_versoes | id/public_id, produto, identidade lógica, número, caminho privado, tamanho, SHA-256, MIME e publicação |
| Carrinho | sessionStorage | Seleção de IDs; não determina preço autorizado |
| Sessão de compra | ist_loja_sessoes | Autoridade do comprador, validade e revogação |
| Pedido | ist_loja_pedidos | public_id, sessão, e-mail, total, ambiente, estado e idempotência |
| Item histórico | ist_loja_pedido_itens | posicao e snapshots de produto/SKU/título/descrição/quantidade/valores |
| Pagamento | ist_loja_pagamentos | public_id, pedido, provedor, ambiente, recebedor, ordem e captura externas |
| Operação | ist_loja_pagamento_operacoes | CRIAR/CAPTURAR, chave, request_id_provedor, estado, reserva e resultado |
| Evento financeiro | ist_loja_pagamento_eventos | origem, evento_id, tipo, hash, evidência e processamento |
| Direito | ist_loja_download_direitos | public_id, pedido_item_id, produto_id, arquivo_versao_id e estado |
| Evento do direito | ist_loja_download_direito_eventos | Versão, estados anterior/novo, origem, motivo e data |
| Outbox de recibos | ist_loja_notificacoes | Pedido, finalidade, ambiente, destinatário, reserva e tentativas |
| Recuperação | ist_loja_download_recuperacoes | LINK/OTP, proteção do desafio, datas, consumo e sessão |
| Escopo recuperado | ist_loja_download_recuperacao_direitos | Direitos e versões autorizados para a recuperação |
| Limites OTP | ist_loja_download_recuperacao_limites | IP/TITULAR/PEDIDO derivados, janelas e orçamento |
| Descoberta | ist_loja_descoberta_checkpoints | Reservas e janelas das fontes complementares |
| Modelos | ist_email_modelos / ist_email_assinaturas | Conteúdo administrativo e assinatura |

**Identificadores distintos:** pedidoPublicId identifica o pedido; pagamentoPublicId identifica a tentativa; ordemId identifica a ordem PayPal; capturaId identifica a captura; direitoPublicId identifica o direito. A referência enviada ao PayPal nas purchase_units é a referência do pagamento, não deve ser confundida com a do pedido.

~~~mermaid
flowchart LR
    L[Livro] --> P[Produto e SKU]
    P --> V[Versao PDF]
    P --> I[Item historico]
    O[Pedido publicId] --> I
    O --> PG[Pagamento publicId]
    PG --> OR[Ordem PayPal]
    OR --> CP[Captura PayPal]
    I --> D[Direito publicId]
    V --> D
    D --> EV[Historico do direito]
    O --> N[Recibo na outbox]
    D --> RD[Escopo recuperado]
~~~

Valores internos são inteiros em centavos. **950 e 9500 são valores diferentes.** O preço atual não reescreve o snapshot de um pedido anterior.

Datas financeiras são tratadas como UTC. Em diagnóstico de DATETIME, usar projeção textual/DATE_FORMAT evita atribuir acidentalmente o fuso local do cliente. A apresentação pode converter explicitamente para America/Sao_Paulo.

<a id="produto"></a>

## 3. Produto disponível e PDF antes da compra

A regra compartilhada é **avaliarPoliticaComercial()**, em [lojaCatalogoService.js](../src/services/lojaCatalogoService.js).

Em Live, comprar exige simultaneamente:

1. Produto ativo, em venda e disponível.
2. Categoria e ancestrais válidos/ativos.
3. Preço positivo válido, BRL, SKU e textos válidos.
4. Tipo DIGITAL, livro associado e formato E-Book.
5. Versão PUBLICADA com publicacao_atual=1.

Na Editora, a propriedade calculada é **comercial.podeComprar**, de /api/books. Na Loja é **disponivel**, retornada pelo catálogo. Ter preço ou arquivo legado na pasta privada não basta.

**registrarRascunho()** valida caminho, ausência de links, identidade do arquivo, cabeçalho, tamanho, SHA-256, MIME, produto/livro e duplicidade. **publicar()** revalida tudo e exige publicacaoAtualEsperada, protegendo concorrência. Uma versão anterior atual torna-se RETIRADA. Preços e flags comerciais não são alterados.

~~~mermaid
stateDiagram-v2
    [*] --> RASCUNHO: registrarRascunho
    RASCUNHO --> PUBLICADA: publicar
    PUBLICADA --> RETIRADA: outra versao passa a ser atual
~~~

**selecionarVersoesNaConexao()** fixa a versão durante o pedido. O comprador não deve receber automaticamente o PDF atual se adquiriu outra versão. RETIRADA significa retirada da publicação atual, não revogação automática dos direitos históricos.

<a id="pedido"></a>

## 4. Carrinho, cotação e criação do pedido

### 4.1 Seleção

**CarrinhoService.adicionar()** aceita IDs válidos, impede duplicação e limita a 100 títulos distintos. O fluxo digital atual utiliza quantidade 1 por produto.

A chave **ist.loja.carrinho.ids** guarda IDs em sessionStorage. Não guarda autoridade financeira. Alterar ou limpar o carrinho não cancela pedido, ordem ou captura.

**cotar()** envia POST /api/loja/cotacao. O servidor calcula os valores oficiais. O serviço descarta respostas tardias quando a seleção muda e rejeita cotações incompatíveis com os IDs escolhidos.

### 4.2 E-mail do comprador autenticado

Ao inicializar `/loja/carrinho`, `LojaCarrinhoComponent.ngOnInit()` chama `preencherEmailAutenticado()`. O `AuthService.verificarSessao()` consulta `GET /api/usuarios/me` com cookies; esse endpoint identifica a sessão, mas não retorna e-mail. Havendo usuário válido, `PerfilService.obterPerfil()` consulta `GET /api/usuarios/perfil`, também com cookies e sem ID de usuário na entrada.

O backend autentica o JWT do cookie e `usuariosController.obterPerfil()` lê `ist_usuarios.email` pela identidade de `req.usuario`. O carrinho confere se a identidade do perfil corresponde à sessão e continua a mesma após a resposta assíncrona. Não usa e-mail arbitrário de storage ou URL como fonte do preenchimento.

O valor é aplicado ao `FormControl email`, ligado a `input#comprador-email`, somente se o campo continuar vazio e pristine, o componente estiver vivo e não houver bloqueio, pedido confirmado ou e-mail confirmado. Valida o e-mail com os validadores do campo, caracteres ASCII imprimíveis sem espaços e domínio contendo ponto. Digitação manual, inclusive digitar e apagar, impede preenchimento tardio. Valores de pedidos retomados são preservados.

O campo permanece editável. Visitante, sessão indisponível, perfil inválido ou falha de rede mantêm o fluxo manual. É uma tentativa na inicialização, sem sincronização contínua ou retry automático. Não altera cadastro, identidade do pedido, chaves financeiras nem dispensa validação backend; o e-mail informado não se torna prova de titularidade de outros pedidos.

### 4.3 Sessão e pedido

POST /api/loja/sessao estabelece a sessão com cookie e CSRF. Origem, X-IST-Loja e controles do backend protegem os demais comandos. A sessão de compra é diferente de login administrativo.

**LojaPedidoService.confirmar()** preserva uma intenção pendente e chave idempotente antes de enviar POST /api/loja/pedidos. Em resposta incerta, preserva a mesma identidade para não criar outro pedido.

**criarPedidoComResultado()**:

1. Valida sessão, entrada, chave e hash canônico.
2. Bloqueia os registros necessários em ordem coerente.
3. Recalcula preços e seleciona versões publicadas.
4. Insere pedido CRIADO e snapshots dos itens.
5. Cria direitos AGUARDANDO_CONFIRMACAO.
6. Registra evento inicial **PEDIDO / DIREITO_CRIADO**, com versão 1.
7. Confirma a transação; repetição idempotente devolve o pedido persistido.

Parâmetros do contrato:

| Parâmetro | Valor |
|---|---|
| Moeda | BRL |
| Máximo de produtos distintos | 100 |
| Quantidade digital atual | 1 por produto |
| Sessão de compra | Até 24 horas |
| Validade do pedido | Até 30 minutos, também limitada pela sessão |
| Referência de atualização da cotação | Cinco minutos |

Validade temporal não equivale a um job que muda automaticamente todos os pedidos vencidos para EXPIRADO.

<a id="paypal"></a>

## 5. Preparação, ordem, aprovação e captura PayPal

### 5.1 Primeiro gesto: Preparar pagamento

`LojaCheckoutComponent.iniciarPagamento()` executa a preparação assíncrona sem abrir popup. Quando necessário, `LojaCheckoutService.preparar()` estabelece sessão/CSRF, preserva as chaves de criação/captura, consulta o estado e a configuração e inicializa o SDK com elegibilidade PayPal.

O backend informa ambiente e Client ID público. Client Secret e token OAuth ficam no servidor. SDK e API usam ambiente explícito, sem fallback Sandbox/Live.

A chave `ist.loja.checkout` guarda `pedidoPublicId`, `criacao`, `captura` e `expiraSessao`. Sua expiração não comprova cancelamento financeiro.

Depois, `prepararAbertura()`:

1. Confere sessão e estado do mesmo pedido.
2. Reutiliza a tentativa existente; só chama `POST /api/loja/checkout/iniciar` se não houver pagamento.
3. Exige `AGUARDANDO_APROVACAO`, ordem identificada e prazo válido.
4. Aguarda `POST /api/loja/checkout/preparar-captura`, com `pagamentoPublicId` e a chave de captura preservada.
5. Reconfere prazo do pedido e da sessão e prepara a sessão SDK em memória.
6. Só então sinaliza `aberturaPronta=true`, habilitando **Continuar no PayPal**.

`criarTentativa()` protege chave/hash e reserva, cria pagamento `CRIANDO` e operação `CRIAR`, persiste `request_id_provedor`, cria a ordem com intenção `CAPTURE` e passa o pedido a `AGUARDANDO_PAGAMENTO`. O resultado normal é `AGUARDANDO_APROVACAO`.

### 5.2 Intenção durável CAPTURAR/PREPARADA

A rota `preparar-captura` exige as proteções de sessão/CSRF e chave idempotente; chama `registrarIntencaoCaptura()` e responde **204**, sem captura ou consulta financeira externa. O helper `prepararCaptura()` cria ou reutiliza a operação `CAPTURAR`, seu hash, chave e `request_id_provedor`. Uma operação existente com a mesma identidade é reutilizada; outra chave para o mesmo pagamento produz conflito.

A preparação nova exige pedido vigente, contexto válido, pagamento `AGUARDANDO_APROVACAO` ou `APROVADO` não fechado e ordem existente. A intenção fica persistida antes da abertura. Ela não comprova aprovação nem pagamento: o backend consulta a ordem antes de qualquer captura.

### 5.3 Segundo gesto: Continuar no PayPal

`pagar()` chama `sessao.start()` diretamente na pilha do novo gesto explícito, sem `await`, HTTP ou encadeamento assíncrono antes dessa chamada. Passa ao SDK a ordem já preparada com `Promise.resolve({orderId})`; não cria nova ordem ou intenção.

A abertura exige a mesma tentativa/ordem/pagamento, `AGUARDANDO_APROVACAO`, prazo válido e ausência de operação em curso. Essa separação evita perder a ativação transitória do navegador durante a preparação. `pronto` indica SDK preparado; `aberturaPronta` indica preparação completa para o segundo gesto.

A sessão SDK é mantida somente em memória. Após recarga, prepara-se novamente SDK/abertura e reutilizam-se pedido, ordem e chaves persistidas. Fechar o popup não cancela financeiramente o pedido nem apaga as chaves; mantém acompanhamento e orienta consultar antes de repetir.

### 5.4 Aprovação e captura

`onApprove()` confere a ordem esperada e chama a rotina privada `continuarCaptura()`. Ela compartilha uma promessa em curso para callbacks duplicados e usa `POST /api/loja/checkout/capturar` com pagamento local e chave original. O ID externo do callback não é enviado como autoridade financeira.

`capturar()` reutiliza `prepararCaptura()` e `executar()`. Callback e recuperador compartilham transações, locks, reserva por token/prazo e identidade da operação. Antes do POST PayPal:

1. Consultam a ordem e exigem resultado `APROVADO` validado.
2. Revalidam pedido, contexto, valores, moeda, recebedor e posse da reserva.
3. Persistem `envio_iniciado_em` e `CAPTURANDO` **antes** de chamar o provider.
4. Enviam a captura com a identidade idempotente persistida.
5. Aplicam resultado/evidências e, se comprovado, confirmam pedido, outbox e direitos na transação local.

O fluxo normal não exige outro clique para concluir a captura após aprovação. O diálogo de consulta conserva a alternativa **Retomar confirmação do pagamento** somente para `APROVADO`, via `retomarConfirmacao()` → `concluirCaptura()` → `continuarCaptura()`. Essa ação é distinta da consulta e do acompanhamento observacionais e continua sujeita às validações backend.

~~~mermaid
sequenceDiagram
    actor C as Comprador
    participant UI as Angular e SDK
    participant API as Checkout
    participant DB as MariaDB
    participant PP as PayPal
    C->>UI: Preparar pagamento
    UI->>API: Estado, configuracao e iniciar se necessario
    API->>PP: Criar ordem se necessaria
    API->>DB: Persistir ordem
    UI->>API: POST preparar-captura e chave original
    API->>DB: Persistir ou reutilizar CAPTURAR PREPARADA
    API-->>UI: 204
    UI-->>C: Habilitar Continuar no PayPal
    C->>UI: Continuar no PayPal
    UI->>PP: sessao.start sincrono abre popup
    C->>PP: Aprovar
    alt Callback recebido
        PP-->>UI: onApprove
        UI->>API: POST capturar e chave original
    else Callback perdido e worker elegivel
        API->>DB: Reservar intencao duravel nunca enviada
    end
    API->>PP: GET ordem e comprovar aprovacao
    API->>DB: Revalidar prazo e persistir envio iniciado
    API->>PP: POST ordem/capture
    PP-->>API: Resultado
    API->>DB: Persistir evidencias, pagamento e direitos
~~~

### 5.5 Nunca enviada versus envio incerto

| Evidência persistida | Tratamento |
|---|---|
| Intenção elegível, `envio_iniciado_em IS NULL`, sem captura/valor confirmado | Recuperador pode reservar, consultar aprovação e continuar a mesma operação durante a vigência |
| `envio_iniciado_em` preenchido, resposta perdida ou reserva expirada | Consulta/reconciliação; não retransmitir captura por presumir ausência de efeito |
| Captura `PENDENTE` | Reconciliar o resultado; não repetir o POST de captura |
| Ordem histórica `APROVADO` sem intenção `CAPTURAR` | Não capturar automaticamente |

`NULL` é uma condição necessária, não autorização isolada. A seleção e a reserva revalidam estado, identidade, valores, ausência de captura, prazo, limites e aprovação. Reserva vencida ou timeout não provam que o envio nunca ocorreu. O marco não é apagado para permitir reenvio.

### 5.6 Expiração e evidência temporal

Não se inicia captura nova depois de `expira_em`, inclusive pelo recuperador. Confirmação local tardia de captura já realizada é um caso diferente: `aplicar()` pode concluir um pedido ainda `CRIADO`/`AGUARDANDO_PAGAMENTO` quando toda a evidência comprova execução dentro da vigência; não reabre pedido em estado terminal.

O provider projeta datas **do recurso de captura**, sem substituir pela data do GET ou pela data da ordem:

| Campo PayPal | Campo normalizado | Uso |
|---|---|---|
| `create_time` | `capturaCriadaEm` | Criação do recurso; isoladamente não prova conclusão |
| `update_time` | `capturaAtualizadaEm` | Última atualização; em recurso `COMPLETED`, limite superior conservador da conclusão |
| `update_time ?? create_time` | `capturadoEm` | Data financeira normalizada; fallback legado não basta para confirmar depois da expiração |

Para confirmação local em instante igual ou posterior à expiração, exige-se cronologia explícita e coerente: criação da captura não anterior à criação do pagamento nem ao envio registrado, criação ≤ atualização e atualização = `capturadoEm`. O envio e `capturadoEm` devem ser **estritamente anteriores** à expiração; `capturadoEm` não pode estar no futuro nem antes do envio/pagamento. As validações integrais de valor, moeda, recebedor, associação e ausência de outro pagamento capturado permanecem.

Datas opcionais preservam compatibilidade de contratos antigos, mas sua ausência não é aceita como prova temporal para confirmação tardia. Datas contraditórias, captura tardia ou cronologia insuficiente mantêm tratamento conservador (`REVISAO`, incluindo `CAPTURA_TARDIA_OU_INESPERADA` e o caminho específico `CAPTURA_CRONOLOGIA_INDETERMINADA`). Uma atualização posterior ao prazo pode impedir conclusão automática mesmo que a captura tenha ocorrido antes: o código não inventa o instante exato.

<a id="direitos"></a>

## 6. Confirmação financeira e ativação digital

A captura deve corresponder ao valor integral, moeda, ordem, referência, recebedor, ambiente e datas esperados.

**lojaPagamentoService.aplicar()**, na transação local:

1. Persiste CAPTURADO, identificadores e valor.
2. Muda o pedido para PAGO e registra pagamento_confirmado_em.
3. Chama **registrarConfirmacaoCompraNaConexao()** para criar a outbox PENDENTE.
4. Persiste resultado da operação e evidências.
5. Chama **confirmarDireitos()**.

**avaliarElegibilidadeFinanceiraNaConexao()** verifica a persistência coerente: pedido, pagamentos, operação confirmadora, evidências, itens, direitos e versões. Não consulta PayPal. Retorna ELEGIVEL, PENDENTE, INCONSISTENTE, REVISAO ou ADVERSO.

Reconciliação inconclusiva anterior à captura só pode ser superada dentro das regras temporais/de associação implementadas. Evidências adversas ou contraditórias continuam impeditivas.

### 6.1 Savepoint e eventos

**confirmarDireitosFinanceirosNaConexao()** usa SAVEPOINT ist_loja_ativacao_digital na transação compartilhada, sem transação aninhada.

Quando elegível:

- direito AGUARDANDO_CONFIRMACAO → ATIVO;
- atualização e evento são atômicos;
- evento de origem **FINANCEIRO**, motivo **CAPTURA_CONFIRMADA**;
- repetição sem transição não duplica evento/versão;
- SUSPENSO/REVOGADO não são reativados por esse caminho.

Uma falha digital reversível pode desfazer somente o trecho até o savepoint e conservar a quitação, com alerta **ATIVACAO_DIGITAL_PENDENTE**. Deadlock, perda da transação e commit incerto são propagados ao tratamento financeiro, não engolidos como falha digital simples.

~~~mermaid
flowchart TD
    A[Captura externa observada] --> B[Transacao financeira local]
    B --> C[CAPTURADO + PAGO + outbox + evidencias]
    C --> D[SAVEPOINT digital]
    D --> E[Avaliar e bloquear direitos]
    E --> F{Elegivel?}
    F -->|Sim| G[Direito ATIVO e evento correspondente]
    F -->|Nao| H[Manter direito sem ativacao]
    G --> I[Release savepoint]
    H --> I
    E -->|Falha digital reversivel| J[Rollback ate savepoint e alerta]
    I --> K[Commit financeiro quando confirmado]
    J --> K
    B -->|Deadlock ou commit incerto| L[Recuperacao financeira sem nova captura cega]
~~~

É possível existir **CAPTURADO + PAGO + AGUARDANDO_CONFIRMACAO**. A interface deve acompanhar a pendência, sem liberar PDF ou iniciar outra cobrança.

<a id="polling"></a>

## 7. Consulta, polling, retomada e redirecionamento

### 7.1 Consultas diferentes

| Caminho | Rotina | Efeitos |
|---|---|---|
| Polling | observar() → checkout/estado → consultarCheckout() | Observação local, sem reconciliação financeira |
| Tentativa anterior | consultarAnterior() | Observa pedido autorizado e preserva chaves |
| Botão Consultar estado do pedido | consultar() | Pode chamar checkout/reconciliar e atualizar finanças locais |
| GET direto de suporte ao PayPal | Processo observacional separado | Não atualiza automaticamente o banco |
| Retomar acompanhamento | retomarAcompanhamento() | Reinicia observações limitadas, sem captura |

**A consulta manual da interface não deve ser tratada como leitura pura.** Pode fazer reconciliação. Não é equivalente à consulta direta observacional realizada em H4.

### 7.2 Acompanhamento

**LojaCheckoutComponent** observa a cada cinco segundos por até dois minutos. Usa exhaustMap para não sobrepor ciclos, cancela leituras antigas e protege contra respostas tardias.

Após confirmação financeira, consulta direitos paginados: até 50 por página, total limitado a 100 e cursores sem repetição. Teto conservador: até 24 ciclos × até três requisições = até 72 requisições por janela, além de bootstrap/ações explícitas.

| Ocorrência | Comportamento |
|---|---|
| 429 | Pausa e respeita Retry-After |
| 401/403/404 | Encerra acompanhamento e orienta sessão/autorização |
| Rede/5xx | Preserva último estado |
| Recusa, cancelamento, expiração, revisão, reembolso, estorno | Interrompe caminho de sucesso |
| Direito suspenso/revogado | Interrompe e orienta atendimento |
| Prazo encerrado | Oferece retomada por até dois minutos quando elegível e mantém consulta manual; não cancela pagamento |
| Pagamento confirmado e direito pendente | Mensagem de pendência; retomada limitada quando oferecida |

**bibliotecaLiberada()** exige CAPTURADO/PAGO, valor/moeda/data coerentes e um direito ATIVO e solicitável por item digital, com IDs distintos e correlação por pedidoPublicId, produtoId e itemPosicao.

Só então ocorre navegação automática. Se o diálogo de consulta estiver aberto, a navegação é adiada e há nova observação ao fechar.

`podeAcompanhar()` permite retomada limitada para pagamento confirmado com direitos pendentes e para `CRIANDO`, `AGUARDANDO_APROVACAO`, `APROVADO`, `CAPTURANDO`, `PENDENTE` ou `DESCONHECIDO`, conforme o mesmo pedido, armazenamento válido e ausência de impedimentos. Pedido terminal, direito suspenso/revogado ou biblioteca já liberada impedem retomada; o ciclo também encerra ao observar estado terminal do pagamento.

A interface agrupa estados intermediários como **Confirmando pagamento**, sem apresentar os códigos internos no caminho normal. Recusa orienta consulta/atendimento e não habilita indiscriminadamente outra cobrança. A retomada do acompanhamento não chama criar, reconciliar ou capturar. A alternativa explícita para `APROVADO` fica no diálogo e tem efeito diferente (seção 5.4). Ao abrir o popup e na primeira aprovação da tentativa inicia-se uma janela limitada; callbacks duplicados não reiniciam livremente esse prazo.

### 7.3 Pedido anterior na mesma aba

A equivalência considera IDs, quantidades, preços unitários, subtotais, moeda e total, além de cotação válida e disponibilidade; não compara apenas títulos.

A retomada exige sessão/pedido válidos, CRIADO/AGUARDANDO_PAGAMENTO e pagamento ausente ou AGUARDANDO_APROVACAO/APROVADO compatível. Reutiliza pedido/chaves, sem iniciar pagamento automaticamente.

Estados incertos, falha de consulta, sessão expirada ou carrinho divergente não autorizam apagar histórico financeiro, cancelar pelo storage ou reutilizar chaves em outro pedido. Uma tentativa comprovadamente paga pode ser resolvida para permitir uma compra distinta posterior.

<a id="download"></a>

## 8. Biblioteca e entrega final do PDF

A biblioteca usa sessão de compra ou sessão recuperada. **listarDireitosDaSessao()** aplica propriedade/escopo, paginação e filtro opcional por pedido.

Na listagem, podeSolicitarArquivo deriva do estado ATIVO; não substitui a autorização final.

~~~mermaid
sequenceDiagram
    actor C as Comprador
    participant UI as Biblioteca
    participant API as Downloads
    participant AUT as Autorizacao e finanças
    participant FS as PDF privado
    UI->>API: GET direitos
    API-->>UI: Direitos da autoridade
    C->>UI: Baixar
    UI->>API: GET itens/direitoPublicId/arquivo
    API->>AUT: Validar sessao, escopo, direito e finanças
    AUT-->>API: Versao autorizada
    API->>FS: Ler e conferir caminho, tamanho e SHA-256
    FS-->>API: Buffer validado
    API->>AUT: Reautorizar e comparar metadados
    AUT-->>API: Autorizacao mantida
    API-->>C: PDF como anexo
~~~

**lojaDownloadsController.arquivo()**:

1. Valida UUID, autoridade, origem e limites.
2. Autoriza o direito em transação/snapshot.
3. Exige elegibilidade financeira atual.
4. Valida raiz privada, caminho, ausência de symlinks, conteúdo e metadados.
5. Reautoriza depois da leitura para detectar mudanças.
6. Entrega application/pdf com Content-Disposition de anexo.

HEAD usa a mesma autorização, sem corpo. A implementação responde Accept-Ranges: none. Não há URL pública permanente do PDF.

O POST **reavaliar** exige sessão legítima/escopo, chama **reavaliarDireitosDoPedido()** e pode mudar direito/eventos. Não captura PayPal. A listagem GET não é uma ativação manual disfarçada.

<a id="recibo"></a>

## 9. Recibo: outbox e SMTP

**registrarConfirmacaoCompraNaConexao()** é chamado na transição financeira para PAGO. Existe UNIQUE(pedido_id, finalidade). O processamento é separado por ambiente.

O browser e a transação de captura não enviam o recibo diretamente.

~~~mermaid
stateDiagram-v2
    [*] --> PENDENTE: pagamento confirmado
    PENDENTE --> PROCESSANDO: reserva e tentativa
    FALHA --> PROCESSANDO: prazo e limite permitem
    PROCESSANDO --> ENVIADO: aceite SMTP e conclusao local
    PROCESSANDO --> FALHA: nao envio comprovado
    PROCESSANDO --> INCERTO: resultado incerto ou reserva expirada
    FALHA --> FALHA: limite esgotado
    INCERTO --> INCERTO: sem reenvio automatico
~~~

**criarProcessadorNotificacoes().processar()** reserva, compõe em leitura consistente, verifica posse da reserva, envia e conclui por token/prazo.

| Condição | Estado/código |
|---|---|
| Composição inválida | FALHA / MENSAGEM_INVALIDA |
| SMTP comprovadamente não aceitou | FALHA / SMTP_NAO_ACEITO |
| Timeout ou resultado indeterminado | INCERTO / SMTP_INDETERMINADO |
| Reserva PROCESSANDO expirada | INCERTO / RESERVA_EXPIRADA |
| Aceite SMTP e conclusão local válida | ENVIADO |

Modelo **confirmacao_compra**: 14 placeholders obrigatórios, HTML/texto e assinatura administrativos. Exige PAGO, captura integral CAPTURADO e dados históricos coerentes. Não usa o preço/catálogo atual para reescrever a compra.

São até cinco tentativas repetíveis, com espera progressiva. Padrões: timeout de envio de 20 segundos e reserva de 60 segundos.

Placeholders do recibo: saudacao, comprador_email, pedido_public_id, pedido_estado, data_compra, data_pagamento, pagamento_referencia, pagamento_estado, ambiente, itens_compra, total, moeda, link_biblioteca e link_recuperacao.

Falha SMTP não desfaz pagamento. Aceite pelo relay não prova entrega na caixa postal. Um resultado incerto não autoriza reenviar cegamente nem permite prometer envio exatamente uma vez.

<a id="recuperacao"></a>

## 10. Recuperação da biblioteca por LINK e OTP

Não confundir com recuperação financeira.

~~~mermaid
flowchart TD
    A[Sessao de compra perdida] --> B[Pagina de recuperacao]
    B --> C{Modo}
    C -->|OTP| D[Email e pedido publico]
    C -->|LINK| E[Email]
    D --> F[Limites, titularidade e modelo]
    F --> G[Codigo protegido por HMAC]
    G --> H[SMTP estrito]
    E --> I[Verificar direitos e criar LINK]
    I --> J[SMTP com link de uso unico]
    H --> K[Informar codigo]
    J --> L[Confirmar explicitamente o link]
    K --> M[Consumo transacional]
    L --> M
    M --> N[Escopo fixado e sessao apos commit]
    N --> O[Biblioteca e autorizacao normal do arquivo]
~~~

| Controle | LINK | OTP |
|---|---|---|
| Entrada | E-mail | E-mail e pedido público |
| Desafio | Segredo aleatório em fragmento de link | Seis dígitos, incluindo zeros iniciais |
| Validade | 15 minutos | Dez minutos |
| Tentativas | Até cinco | Até cinco, com orçamento persistente |
| Armazenamento | Hash do segredo | HMAC específico associado a desafio/pedido/titular |
| Separação | Filtro explícito tipo LINK | Filtro explícito tipo OTP |
| Escopo | Direitos elegíveis do titular dentro dos limites | Direitos elegíveis do pedido |
| Consumo | Único/transacional | Único/transacional |
| Sessão recuperada | Até 24 horas | Mesmo mecanismo compartilhado |

O OTP usa janela de dez minutos, cooldown de 60 segundos, até três emissões, até 20 solicitações por IP na janela e orçamento de cinco falhas nos escopos pertinentes. Os limites persistentes têm retenção mínima de sete dias. Reenvios não reiniciam livremente o orçamento.

A resposta pública é genérica: não confirma existência de pedido, titular ou envio.

O modelo **recuperacao_biblioteca_codigo** exige pedido_public_id, codigo, validade_minutos e link_acesso. É preparado antes da emissão/invalidação de desafios. Modelo ausente/inativo/inválido não ativa um fallback HTML paralelo.

O envelope interno **entrega** contém o código em memória e não integra a resposta HTTP. OTP não é colocado na URL nem persistido no storage do navegador.

**emitirSessao()** fixa o escopo e prepara o segredo dentro da transação. O serviço só o devolve ao chamador externo depois da confirmação transacional; o controller então emite o cookie. Compras futuras não ampliam automaticamente esse escopo. Recuperar sessão não cria direitos e não dispensa a verificação financeira no download.

**criarLimpezaRecuperacao().limpar()** existe, com autorização explícita e critérios de retenção próprios. Não é um quinto agendador automático de server.js nem parte de uma compra.

<a id="reconciliacao"></a>

## 11. Webhooks, reconciliação e eventos adversos

### 11.1 Webhooks de captura

**criarProcessadorWebhookPayPal()** recebe corpo bruto, valida estrutura/tamanho e verifica assinatura no PayPal antes de aceitar o evento.

O caminho financeiro normal reconhece:

- PAYMENT.CAPTURE.COMPLETED
- PAYMENT.CAPTURE.PENDING
- PAYMENT.CAPTURE.DENIED
- PAYMENT.CAPTURE.DECLINED

**reconciliarWebhook()** associa o evento ao pagamento/contexto local. Assinatura válida não basta para tomar o payload como comprovação financeira definitiva.

### 11.2 Recuperação/reconciliação

`reconciliar()` e `reconciliarWebhook()` usam `executar(job, true)` no caminho observacional: consultam recursos oficiais, validam associação e podem atualizar evidências, finanças e direitos locais, sem iniciar captura externa.

`recuperarPendencias()` também usa esse executor, mas S1 distingue a intenção durável **nunca enviada**: nessa condição elegível, muda para o caminho de continuidade, consulta aprovação e pode executar a captura da mesma operação. Portanto, o worker financeiro não é exclusivamente observacional.

O seletor exige provedor/ambiente/recebedor e reserva ativa. Abrange `CRIANDO`, `CAPTURANDO`, `DESCONHECIDO`, `PENDENTE` e intenções `CAPTURAR` nunca enviadas em `AGUARDANDO_APROVACAO`/`APROVADO`. As operações elegíveis são `DESCONHECIDA`, `EM_EXECUCAO` com reserva vencida, `SUCESSO` com pagamento `PENDENTE` ou `CAPTURAR/PREPARADA` sem envio. Prefere `CAPTURAR` a `CRIAR`, respeita pelo menos um minuto desde a atualização e o reagendamento, com espera progressiva e até dez recuperações por operação.

Dentro da transação, a continuidade nunca enviada exige `CAPTURAR`, envio nulo, pagamento `AGUARDANDO_APROVACAO`/`APROVADO`/`DESCONHECIDO`, ausência de captura externa/data/valor e operação `PREPARADA`, `DESCONHECIDA` ou execução vencida. Exige também pedido vigente em `CRIADO`/`AGUARDANDO_PAGAMENTO`. A aprovação é novamente consultada antes do envio; sem ela não captura. Os detalhes estão nas seções 5.4–5.6.

Não seleciona uma ordem histórica apenas por estar `APROVADO`, sem intenção durável. Não varre todos os `CAPTURADO` para corrigir direitos pendentes ou descobrir reembolsos posteriores. A execução automática depende de `IST_LOJA_RECUPERACAO_ATIVA` e da composição válida do financeiro.

~~~mermaid
flowchart LR
    A[Captura sincrona] --> F[Servico financeiro]
    B[Webhook autenticado] --> F
    C[Consulta manual reconciliadora] --> F
    D[Worker de recuperacao] --> F
    F --> G[Validacao e evidencias]
    G --> H[Persistencia e direitos]
    I[Polling] --> J[Observacao local]
~~~

### 11.3 Recuperação financeira S1 — homologação Sandbox

A intenção durável `CAPTURAR/PREPARADA` permite continuar a mesma captura quando a aprovação ocorreu, mas o callback do navegador não chegou ao backend. O callback normal e o recuperador convergem em `executar()`: usam a mesma operação, `request_id_provedor`, reserva transacional, preflight PayPal, marca de envio, aplicação de evidências e ativação de direitos. O recuperador não cria outra ordem nem outra identidade de captura.

O seletor `candidatosRecuperacao()` aceita opcionalmente `pedidoPublicId`. Quando informado, o predicado é aplicado no `SELECT` antes de `ORDER BY` e `LIMIT`, impedindo que pedidos históricos consumam o limite da passagem isolada. A identidade pública retornada pelo seletor é revalidada dentro da transação bloqueada antes de qualquer consulta ou envio ao provider. Sem filtro, a assinatura continua com limite global e preserva o comportamento utilizado pelo agendador existente.

Uma intenção nunca enviada somente pode seguir para captura quando todos estes controles permanecem satisfeitos:

1. contexto de provedor, ambiente e recebedor correspondente;
2. pedido ainda vigente em `CRIADO` ou `AGUARDANDO_PAGAMENTO`;
3. pagamento não fechado, sem captura externa, data ou valor capturado;
4. operação preferencial `CAPTURAR`, elegível e com `envio_iniciado_em IS NULL`;
5. ausência de lease concorrente e respeito ao atraso/backoff persistido;
6. ordem externa presente e aprovação `APPROVED` novamente comprovada por GET;
7. valor, moeda, referência e recebedor consistentes antes do POST de captura.

Se o envio já começou, a recuperação passa pelo caminho observacional/reconciliador e não retransmite o POST. Captura `PENDING`, resposta perdida, execução vencida e resultado indeterminado não são convertidos em autorização para cobrar novamente. Uma ordem histórica `APROVADO` sem intenção durável continua inelegível.

O executor [loja-recuperacao-captura-isolada.mjs](../scripts/loja-recuperacao-captura-isolada.mjs) é uma entrada operacional local, não uma rota HTTP nem um novo worker. Ele:

- exige confirmação explícita na linha de comando e UUID de um único pedido;
- recusa ambiente diferente de Sandbox, banco diferente de `istbrasil_homolog:3307` e recuperador global habilitado;
- carrega banco/provider somente depois dessas guardas;
- chama uma única vez `recuperarPendencias({ limite: 1, pedidoPublicId })`;
- encerra seu pool, produz resultado sanitizado e não repete resultado incerto;
- não abre banco, cria provider ou executa recuperação quando apenas importado.

`IST_LOJA_RECUPERACAO_ATIVA=false` permaneceu durante a homologação. Portanto, o que foi comprovado foi a passagem manual filtrada, não a varredura automática do agendador global.

#### Evidência: compra normal Sandbox

Pedido `4ac612b0-c9db-4aeb-b7e6-609e68ffa165`, no valor de R$ 95,00 BRL:

- captura integral comprovada;
- pagamento `CAPTURADO` e pedido `PAGO`;
- direito digital `ATIVO`;
- redirecionamento para a biblioteca;
- PDF respondido com HTTP 200 e SHA-256 correspondente à versão publicada.

#### Evidência: recuperação S1 isolada

Pedido `e5d32cd4-ff45-422c-ab67-7358bcb65450`, ordem PayPal Sandbox `29D15721B63419740` e captura `3T183636GC6514306`:

1. a ordem foi criada e a intenção ficou `CAPTURAR/PREPARADA`, com envio nulo;
2. antes da aprovação, o Chrome/CDP bloqueou exclusivamente `POST /api/loja/checkout/capturar`;
3. a aprovação externa foi confirmada como `APPROVED`, sem captura existente;
4. o executor filtrado foi chamado exatamente uma vez para esse pedido;
5. a captura retornou `COMPLETED`, R$ 95,00 BRL, com referência e recebedor correspondentes;
6. a operação terminou `SUCESSO` com uma tentativa e um único identificador externo;
7. pagamento passou a `CAPTURADO`, pedido a `PAGO` e direito a `ATIVO` com evento `FINANCEIRO/CAPTURA_CONFIRMADA`;
8. fingerprints dos pedidos, pagamentos, operações, eventos e direitos históricos permaneceram idênticos.

O acesso ao PDF **não foi testado novamente depois da recuperação S1**. A evidência de download acima pertence à compra normal homologada e não deve ser estendida ao cenário recuperado.

### 11.4 Eventos adversos

| Evento | Cobertura |
|---|---|
| PAYMENT.CAPTURE.REFUNDED | Ingestão e comprovação de reembolso por recurso oficial |
| PAYMENT.CAPTURE.REVERSED | Ingestão; extrator financeiro completo de reversão não implementado nesse caminho |
| CUSTOMER.DISPUTE.CREATED | Risco de disputa, sujeito a correlação/comprovação |
| CUSTOMER.DISPUTE.UPDATED | Atualização de disputa |
| CUSTOMER.DISPUTE.RESOLVED | Resolução não reativa automaticamente o direito |
| Não reconhecido | Pode ser registrado como IGNORADO |

**receberEventoAdverso()** persiste projeção autenticada, hash e contexto, sem efeito financeiro. Alguns eventos ainda não têm pagamento_id correlacionado.

**processarEventosAdversos()** reserva eventos e chama **reconciliarEventoAdverso()**. O serviço consulta os recursos oficiais, valida associação e aplica localmente:

- reembolso comprovado → PARCIALMENTE_REEMBOLSADO/REEMBOLSADO;
- risco ou contradição aplicável → REVISAO;
- avaliação de suspensão de direitos com eventos na mesma transação;
- deduplicação da identidade econômica para não somar o mesmo reembolso duas vezes.

Evidência incompleta/contraditória ou tipo não suportado pode produzir REVISAO sem efeito financeiro automático. O worker limita a oito tentativas; D9_AUTENTICACAO exige intervenção e pode pausar o contexto.

~~~mermaid
flowchart TD
    A[Webhook adverso autenticado] --> B[RECEBIDO]
    B --> C[Worker reserva PROCESSANDO]
    C --> D[Consultar recurso e captura]
    D --> E{Evidencia comprovada?}
    E -->|Reembolso| F[Atualizar estados e valores]
    E -->|Disputa ou contradicao aplicavel| G[REVISAO financeira]
    F --> H[Avaliar suspensao de direitos]
    G --> H
    E -->|Incompleta ou nao suportada| I[Revisao sem efeito presumido]
    D -->|Falha transitoria| J[Reagendar com limite]
    J --> B
~~~

Ligar o worker não resolve automaticamente reversões sem extrator, restaura direitos suspensos ou dispensa atendimento operacional.

<a id="estados"></a>

## 12. Catálogo completo de estados dos contratos

### 12.1 Pedido — ist_loja_pedidos.estado

| Estado | Significado |
|---|---|
| CRIADO | Pedido e snapshots persistidos |
| AGUARDANDO_PAGAMENTO | Tentativa financeira iniciada |
| PAGO | Captura válida e confirmação persistidas |
| CANCELADO | Vocabulário previsto de cancelamento |
| EXPIRADO | Vocabulário previsto de expiração |
| PARCIALMENTE_REEMBOLSADO | Reembolso parcial comprovado |
| REEMBOLSADO | Reembolso integral comprovado |
| ESTORNADO | Vocabulário previsto de estorno |
| REVISAO | Risco/inconsistência que exige análise |

**Enum não é automação:** CRIADO → AGUARDANDO_PAGAMENTO → PAGO e efeitos de reembolso/revisão estão implementados pelos serviços descritos. CANCELADO, EXPIRADO e ESTORNADO no contrato não comprovam a existência de um job geral que realize essas transições no pedido. O estado terminal de um pagamento não deve ser presumido como mudança idêntica no pedido.

### 12.2 Pagamento — ist_loja_pagamentos.estado

| Estado | Significado |
|---|---|
| CRIANDO | Criação da ordem em curso |
| AGUARDANDO_APROVACAO | Aguardando decisão do comprador |
| APROVADO | Aprovação observada, ainda sem quitação |
| CAPTURANDO | Captura iniciada/reservada |
| PENDENTE | Resultado financeiro pendente |
| DESCONHECIDO | Prova insuficiente; não significa cancelamento |
| CAPTURADO | Captura confirmada; direito exige validações adicionais |
| RECUSADO | Recusa definitiva comprovada |
| CANCELADO | Cancelamento definitivo comprovado |
| EXPIRADO | Expiração definitiva comprovada |
| PARCIALMENTE_REEMBOLSADO | Parte do valor reembolsada |
| REEMBOLSADO | Reembolso integral |
| ESTORNADO | Estado previsto; cobertura depende do evento suportado |
| REVISAO | Estado conservador sem saída automática na máquina atual |

### 12.3 Operação — ist_loja_pagamento_operacoes

Ações persistidas: **CRIAR** e **CAPTURAR**. Não existe ação RECONCILIAR nesse enum.

| Estado | Significado |
|---|---|
| PREPARADA | Operação persistida, ainda não concluída; CAPTURAR pode representar a intenção durável antes do popup |
| EM_EXECUCAO | Reserva com token e prazo |
| DESCONHECIDA | Resultado da operação indeterminado |
| SUCESSO | A ação foi concluída/observada |
| RECUSADA | Desfecho recusado/cancelado/expirado no tratamento da operação |
| REVISAO | Encaminhada para análise |

**CRIAR/SUCESSO não equivale a CAPTURAR/SUCESSO.** Pode existir APROVADO com apenas uma operação de criação.

### 12.4 Ledger — ist_loja_pagamento_eventos

Estados: **RECEBIDO, PROCESSANDO, PROCESSADO, IGNORADO, REVISAO**.

Origens: **API, WEBHOOK, RECONCILIACAO, INTERNO**.

Tipo e código de erro são dimensões separadas. Tipos incluem estados normalizados de resultado, nomes de webhook e eventos internos como RECUPERACAO_AUTOMATICA, RECUPERACAO_INTERVENCAO, REVISAO_FINANCEIRA, EVIDENCIA_ADVERSA e REEMBOLSO_COMPROVADO. O campo tipo não é o estado do pedido.

### 12.5 Direito — ist_loja_download_direitos.estado

| Estado | Significado |
|---|---|
| AGUARDANDO_CONFIRMACAO | Direito criado, sem liberação |
| ATIVO | Ativação confirmada; download ainda exige autorização |
| SUSPENSO | Acesso bloqueado por motivo financeiro aplicável |
| REVOGADO | Revogação registrada e protegida contra reativação normal |

~~~mermaid
stateDiagram-v2
    [*] --> AGUARDANDO_CONFIRMACAO: pedido
    AGUARDANDO_CONFIRMACAO --> ATIVO: elegibilidade e evento
    AGUARDANDO_CONFIRMACAO --> SUSPENSO: avaliacao impeditiva aplicavel
    ATIVO --> SUSPENSO: evidencia impeditiva aplicavel
    SUSPENSO --> SUSPENSO: sem reativacao automatica
    REVOGADO --> REVOGADO: sem reativacao automatica
~~~

O diagrama não inventa endpoint público de revogação. REVOGADO integra o contrato e é protegido pelos leitores/avaliadores.

### 12.6 Outros estados e ciclos

| Domínio | Vocabulário ou ciclo |
|---|---|
| Versão PDF | RASCUNHO, PUBLICADA, RETIRADA; publicacao_atual |
| Recibo | PENDENTE, PROCESSANDO, ENVIADO, FALHA, INCERTO |
| Avaliação financeira | ELEGIVEL, PENDENTE, INCONSISTENTE, REVISAO, ADVERSO |
| Evidência adversa validada | REEMBOLSO_CONFIRMADO, RISCO_DISPUTA, DISPUTA_ENCERRADA, CONTRADITORIA, INCOMPLETA |
| Projeção inicial adversa | REEMBOLSO_NOTIFICADO, DISPUTA_RESOLVIDA_NOTIFICADA, RISCO_DISPUTA, REVERSAO_NOTIFICADA_SEM_EXTRATOR, REEMBOLSO_CONTRATO_NAO_SUPORTADO, DESCONHECIDO |
| Descoberta | PRONTO, EXECUTANDO, REVISAO |
| Recuperação | tipo LINK/OTP; criado_em, desafio_expira_em, tentativas, consumido_em, invalidado_em, sessao_criada_em, sessao_expira_em, revogada_em |
| Sessão de compra | Criação, expiração e revogação; não é estado financeiro |
| Comercial | ativo, em_venda, disponivel; não concedem download |
| Carrinho/UI | Seleção, carregando, cotação, erro e inconsistências |
| Pedido/UI | processando, pendente, confirmado e preço alterado |
| Checkout/UI | ocupado, pronto (SDK), aberturaPronta, iniciandoPagamento, erro, acompanhamento, direitosConsultados, confirmado, bibliotecaLiberada |
| Popup/SDK | onApprove, onCancel, onError; não são estados persistidos de captura |

### 12.7 Observações externas normalizadas

| Campo | Valores aceitos |
|---|---|
| statusOrdem | null, CREATED, SAVED, PAYER_ACTION_REQUIRED, APPROVED, COMPLETED, VOIDED, DESCONHECIDO |
| statusCaptura | null, COMPLETED, PENDING, DECLINED, REFUNDED, PARTIALLY_REFUNDED, FAILED, DESCONHECIDO |
| evidencia | PRESENTE, AUSENTE, CONTRADITORIA |
| associacaoOrdem | CONFIRMADA, NAO_DEMONSTRADA, DIVERGENTE, INVALIDA |
| validacao | CONSISTENTE, INCONCLUSIVA, DIVERGENTE |
| motivoPendencia | null, BUYER_COMPLAINT, CHARGEBACK, ECHECK, INTERNATIONAL_WITHDRAWAL, OTHER, PENDING_REVIEW, RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION, REFUNDED, TRANSACTION_APPROVED_AWAITING_FUNDING, UNILATERAL, VERIFICATION_REQUIRED |

APPROVED significa aprovação da ordem. Autorização financeira separada exige o respectivo recurso; captura exige captura identificada/consistente. Relato de débito não substitui essa prova.

Falhas do adaptador têm categoria **OPERACAO, AUTENTICACAO, VALIDACAO_LOCAL, RESPOSTA_INVALIDA, INFRAESTRUTURA ou RECUSA_DEFINITIVA**, e envio **NAO_ENVIADO, ENVIADO ou INDETERMINADO**. NAO_ENVIADO de uma consulta não descarta efeito de captura anterior.

<a id="transicoes"></a>

## 13. Todas as transições permitidas do pagamento

Fonte: TRANSICOES_PAGAMENTO em [lojaPagamentoContratos.js](../src/services/lojaPagamentoContratos.js). Permanecer no mesmo estado é permitido pelo validador. Uma aresta permitida não garante cobertura automática de todo evento externo.

| Origem | Destinos diferentes permitidos |
|---|---|
| CRIANDO | AGUARDANDO_APROVACAO, APROVADO, RECUSADO, DESCONHECIDO, REVISAO |
| AGUARDANDO_APROVACAO | APROVADO, CANCELADO, EXPIRADO, DESCONHECIDO, REVISAO |
| APROVADO | CAPTURANDO, CANCELADO, EXPIRADO, DESCONHECIDO, REVISAO |
| CAPTURANDO | CAPTURADO, PENDENTE, RECUSADO, DESCONHECIDO, REVISAO |
| PENDENTE | CAPTURADO, RECUSADO, DESCONHECIDO, REVISAO |
| DESCONHECIDO | AGUARDANDO_APROVACAO, APROVADO, CAPTURADO, PENDENTE, RECUSADO, CANCELADO, EXPIRADO, REVISAO |
| CAPTURADO | PARCIALMENTE_REEMBOLSADO, REEMBOLSADO, ESTORNADO, REVISAO |
| PARCIALMENTE_REEMBOLSADO | REEMBOLSADO, ESTORNADO, REVISAO |
| RECUSADO | REVISAO |
| CANCELADO | REVISAO |
| EXPIRADO | REVISAO |
| REEMBOLSADO | REVISAO |
| ESTORNADO | REVISAO |
| REVISAO | Nenhum destino diferente automático |

~~~mermaid
stateDiagram-v2
    [*] --> CRIANDO
    CRIANDO --> AGUARDANDO_APROVACAO
    AGUARDANDO_APROVACAO --> APROVADO
    APROVADO --> CAPTURANDO
    CAPTURANDO --> CAPTURADO
    CAPTURANDO --> PENDENTE
    PENDENTE --> CAPTURADO
    CRIANDO --> DESCONHECIDO
    CAPTURANDO --> DESCONHECIDO
    DESCONHECIDO --> APROVADO
    DESCONHECIDO --> CAPTURADO
    CAPTURANDO --> RECUSADO
    CAPTURADO --> PARCIALMENTE_REEMBOLSADO
    CAPTURADO --> REEMBOLSADO
    CAPTURADO --> REVISAO
~~~

O diagrama destaca caminhos principais; a tabela contém todas as arestas do contrato.

<a id="endpoints"></a>

## 14. Endpoints e efeitos colaterais

Catálogo descritivo, não instrução para executar comandos em produção. Sessão, origem, CSRF e limites se aplicam conforme cada router.

| Método/rota | Rotina | Natureza |
|---|---|---|
| GET /api/books e /api/books/:id | criarBookController | Leitura editorial/comercial |
| GET /api/usuarios/me | autenticação existente | Identidade da sessão JWT; sem e-mail nessa resposta |
| GET /api/usuarios/perfil | usuariosController.obterPerfil | Perfil do titular autenticado; carrinho utiliza identidade/e-mail |
| GET /api/loja/categorias | listarCategorias | Leitura |
| GET /api/loja/produtos e /:id | listarProdutos / obterProduto | Leitura |
| POST /api/loja/cotacao | cotar | Cotação, sem pedido/captura |
| POST /api/loja/sessao | criarLojaSessaoController | Pode criar sessão/cookie |
| POST /api/loja/pedidos | criarPedidoComResultado | Pedido, snapshots e direitos |
| POST /api/loja/checkout/configuracao | criarLojaCheckoutRouter | Ambiente e Client ID público |
| POST /api/loja/checkout/iniciar | criarTentativa | Pode criar ordem e persistir tentativa |
| POST /api/loja/checkout/preparar-captura | registrarIntencaoCaptura | Persiste/reutiliza intenção CAPTURAR; 204, sem chamada financeira externa |
| POST /api/loja/checkout/estado | consultarCheckout | Observação local |
| POST /api/loja/checkout/capturar | capturar | Escrita financeira externa/local |
| POST /api/loja/checkout/reconciliar | reconciliar | Consulta externa e possível escrita local |
| POST /api/loja/pagamentos/paypal/webhook | criarProcessadorWebhookPayPal | Assinatura e processamento local |
| GET /api/loja/downloads/direitos | listarDireitosDaSessao | Leitura autorizada |
| POST /api/loja/downloads/itens/:direitoPublicId/reavaliar | reavaliarDireitosDoPedido | Pode mudar direito/eventos; sem captura |
| GET/HEAD /api/loja/downloads/itens/:direitoPublicId/arquivo | arquivo / autorizarArquivoNaConexao | Entrega protegida |
| GET /api/loja/downloads/recuperacao/sessao | Bootstrap | Pode emitir cookie CSRF |
| POST /api/loja/downloads/recuperacao/solicitar | criarDesafio | Pode gravar LINK e enviar e-mail |
| POST /api/loja/downloads/recuperacao/solicitar-codigo | solicitarCodigo | Pode gravar OTP/limites e enviar |
| POST /api/loja/downloads/recuperacao/validar | consumirDesafio | Consome LINK e emite sessão |
| POST /api/loja/downloads/recuperacao/validar-codigo | validarCodigoDoPedido | Consome/tenta OTP e emite sessão |
| POST /api/loja/downloads/recuperacao/revogar | revogarSessao | Revoga sessão, não direito financeiro |
| POST /api/admin/loja/livros/:id/pdf | registrarPdfAdmin | Upload privado e rascunho |
| POST /api/admin/loja/livros/:id/versoes-pdf/:versaoPublicId/publicar | publicarPdfAdmin | Publica versão, sem mudar preço |

No PayPal: OAuth autentica; POST de criação abre ordem; POST de captura efetua a operação; GETs observam recursos; verificação de assinatura autentica webhook. Não existe endpoint genérico de “marcar pago” nem download sem direito.

<a id="rotinas"></a>

## 15. Inventário de rotinas e arquivos

Caminhos relativos à raiz da aplicação. A tabela identifica as rotinas do ciclo; os helpers privados de validação estão nos mesmos arquivos.

| Arquivo/camada | Rotinas e responsabilidades |
|---|---|
| src/app/services/carrinho.service.ts | adicionar, remover, limpar, cotar, restaurar e cancelar requisição |
| src/app/pages/loja/loja-catalogo.component.ts e loja-produto.component.ts | Oferta e inclusão no carrinho |
| src/app/pages/loja/loja-carrinho.component.ts | pedidosEquivalentes, confirmarPedido, consultarPedidoAnterior, retomarPedidoAnterior, ngOnInit, preencherEmailAutenticado e podePreencherEmail |
| src/app/shared/auth.service.ts e pages/perfil/services/perfil.service.ts | verificarSessao e obterPerfil, com cookies; sem ID de usuário na requisição |
| src/routes/usuarios.routes.js, middlewares/authMiddleware.js e controllers/usuariosController.js | Autenticação JWT e leitura do perfil em ist_usuarios |
| src/app/services/loja-pedido.service.ts | confirmar e intenção idempotente |
| src/app/services/loja.service.ts | Catálogo, cotação, estabelecerSessao e criarPedido |
| src/app/services/loja-checkout.service.ts | preparar, prepararAbertura, pagar, onApprove/onCancel/onError, continuarCaptura, concluirCaptura, observar, consultar, consultarAnterior, verificarAnterior, podeRetomar, restaurarAnterior, podeAcompanhar, retomarAcompanhamento e bibliotecaLiberada |
| src/app/pages/loja/loja-checkout.component.ts | iniciarPagamento, ciclo, lerDireitos, receberCiclo, tratarErro, encerrarPorPrazo, consultarManual, retomarConfirmacao e retomarAcompanhamento |
| src/app/services/loja-biblioteca.service.ts | sessao, listar, reavaliar, arquivo, solicitar, solicitarCodigo, validarCodigo, confirmar, revogar |
| src/app/pages/loja/loja-biblioteca.component.ts | Listagem/paginação e ações de arquivo/reavaliação |
| src/app/pages/loja/loja-recuperacao.component.ts | Formulário LINK/OTP, reenvio, confirmação e navegação |
| src/controllers/bookController.js | ler, getAllBooks, getBookById e podeComprar |
| src/controllers/lojaController.js | Contratos HTTP de catálogo/cotação |
| src/controllers/lojaSessaoController.js e lojaPedidoController.js | Entrada de sessão/pedido e projeção da resposta |
| src/routes/loja.routes.js, lojaSessao.routes.js, lojaPedido.routes.js e lojaCheckout.routes.js | Montagem dos endpoints, parsers, limites e proteções de compra |
| src/routes/lojaDownloads.routes.js e lojaDownloadRecuperacao.routes.js | Montagem dos endpoints de biblioteca, entrega e recuperação |
| src/services/lojaCatalogoService.js | avaliarPoliticaComercial, prepararItens, cotar e consultas |
| src/services/lojaSessaoService.js | Sessão, segredo, validade e revogação |
| src/middlewares/lojaSessaoMiddleware.js | Origem, cookie, CSRF e autoridade |
| src/services/lojaPedidoService.js | criarPedidoComResultado, criarDireitoInicialNaConexao e recuperação idempotente |
| src/services/lojaPagamentoService.js | criarTentativa, prepararCaptura (helper), registrarIntencaoCaptura, capturar, executar, aplicar, reconciliar, reconciliarWebhook, recuperarPendencias, consultarCheckout, receberEventoAdverso e confirmarDireitos |
| src/services/lojaPagamentoPersistencia.js | transacao, candidatosRecuperacao, contarRecuperacoes, localizarWebhook, eventoWebhook, atualizarWebhook, receberEventoAdverso |
| src/services/lojaPagamentoContratos.js | Estados, transições, normalização, falhas e DTO |
| src/services/pagamentos/paypalProvider.js | OAuth, criar, consultar, capturar, reconciliar, verificarWebhook, consultarEvidenciaAdversa e descoberta |
| src/services/lojaPaypalWebhook.js e routes/lojaPaypalWebhook.routes.js | Corpo bruto, assinatura e encaminhamento |
| src/services/lojaDownloadFinanceiroService.js | avaliarElegibilidadeFinanceiraNaConexao |
| src/services/lojaDownloadDireitosService.js | confirmarDireitosFinanceirosNaConexao, reavaliarDireitosDoPedido, suspenderDireitosFinanceirosNaConexao, confirmarSuspensaoFinanceiraNaConexao e eventos |
| src/services/lojaDownloadAutoridade.js | Autoridade de compra/recuperação sem ampliar escopo |
| src/services/lojaDownloadAutorizacaoService.js | listarDireitosDaSessao, localizarDireitoDaSessao, autorizarArquivoNaConexao, autorizarReavaliacaoNaConexao |
| src/controllers/lojaDownloadsController.js | listar, reavaliar, arquivo e dupla autorização |
| src/middlewares/lojaDownloadsMiddleware.js | Autenticação, CSRF, limites e entrega |
| src/services/lojaDownloadArquivoService.js | prepararArquivoValidado e integridade do PDF |
| src/services/lojaArquivoService.js | registrarRascunho, publicar e selecionarVersoesNaConexao |
| src/services/lojaAdminPdfService.js e controllers/admin/lojaLivrosAdminController.js | registrarPdfAdmin, publicarPdfAdmin, vínculo livro/produto e pré-condições administrativas |
| src/routes/lojaAdmin.routes.js | Entrada administrativa autenticada para registro/publicação de PDF |
| src/config/lojaArmazenamentoInicial.js, lojaArmazenamento.js e lojaArquivos.js | Raiz privada compartilhada e composição |
| src/services/lojaNotificacoesService.js | registrarConfirmacaoCompraNaConexao |
| src/services/lojaNotificacoesWorker.js | processar, reservar, possui, concluir e leitura consistente |
| src/services/lojaNotificacoesMensagem.js | criarCompositorConfirmacaoCompra e descrição editorial legível |
| src/services/emailTemplateService.js, emailHtmlSanitizer.js e config/emailPlaceholders.js | Modelo, placeholders, escape, HTML/texto e assinatura |
| src/services/mailService.js | enviarEmail e criarEnvioRecuperacaoSmtp |
| src/services/lojaDownloadRecuperacaoSmtp.js e lojaDownloadRecuperacaoEmail.js | Adaptador LINK/OTP e transporte estrito |
| src/services/lojaDownloadRecuperacaoService.js | criarDesafio, consumirDesafio, obterSessao, revogarSessao, fixarEscopo, emitirSessao e fachada OTP |
| src/services/lojaDownloadRecuperacaoOtp.js | criarOperacoesOtp, solicitarCodigo, validarCodigoDoPedido, HMAC e limites |
| src/middlewares/lojaRecuperacaoCsrf.js | Bootstrap/cookies da recuperação |
| src/services/lojaDownloadRecuperacaoLimpeza.js | criarLimpezaRecuperacao().limpar, com autorização própria |
| src/services/lojaPagamentoAdversoService.js | reconciliarEventoAdverso, evidências, revisão e suspensão |
| src/services/lojaPagamentoAdversoWorker.js | processar, diagnosticar, reservar, reagendar e pausar |
| src/services/lojaPaypalEventoAdverso.js e lojaPagamentoAdversoContratos.js | Projeções e validações adversas |
| src/services/lojaDescobertaService.js e lojaDescobertaContratos.js | Fontes, janelas e checkpoints |
| src/services/lojaPagamentoAgendador.js | comporFinanceiroLoja, iniciarRecuperacaoLoja, iniciarWorkerAdversoLoja, iniciarDescobertaLoja |
| scripts/loja-recuperacao-captura-isolada.mjs | Passagem manual Sandbox restrita a um pedido, com guardas ambientais e sem efeito durante importação |
| src/services/lojaNotificacoesAgendador.js | iniciarNotificacoesLoja |
| server.js | Composição HTTP, pool, início/parada de timers e encerramento |

<a id="agendadores"></a>

## 16. Agendadores e parâmetros

São timers internos ao Node/PM2, não serviços independentes do sistema operacional. As flags são verificadas na inicialização; editar o arquivo sem recarregar o processo não comprova mudança efetiva.

| Flag | Processo | Cadência/limite |
|---|---|---|
| IST_LOJA_RECUPERACAO_ATIVA | iniciarRecuperacaoLoja → recuperarPendencias | 60 s; até dez candidatos/ciclo; até dez recuperações/operação |
| IST_LOJA_ADVERSOS_ATIVA | iniciarWorkerAdversoLoja → processarEventosAdversos | 60 s; até dez/ciclo; até oito tentativas/evento |
| IST_LOJA_NOTIFICACOES_ATIVAS | iniciarNotificacoesLoja → processar | 60 s; até dez/ciclo; até cinco tentativas repetíveis |
| IST_LOJA_DESCOBERTA_ATIVA | iniciarDescobertaLoja → descobrirEventosAdversos | 60 s; fontes NOTIFICACOES/DISPUTAS/TRANSACOES e checkpoints |

Os ciclos não se sobrepõem dentro da instância; reservas e locks protegem entre processos. A inicialização não executa imediatamente um pagamento. Filas vazias podem não produzir logs de resumo.

**Registro histórico após H2:** recuperação, adversos e notificações habilitados; descoberta desabilitada. Não é uma leitura renovada da produção feita para este documento.

A recuperação de acesso depende de **IST_LOJA_RECUPERACAO_EMAIL_ATIVO**, HMAC/CSRF, origem, sessão, modelo e SMTP; não da flag de recuperação financeira.

O transporte estrito externo exige TLS e validação de certificado. IST_SMTP_CAPTURA_LOCAL permite somente a exceção explícita em loopback, sem credenciais.

**As flags não bloqueiam o checkout.** Desativá-las não impede criar pedido ou capturar por rotas síncronas.

Em H1, a CHECK dos checkpoints ainda aceitava somente Sandbox. A evolução Live existe na release, mas não deve ser presumida como aplicada nem sua ativação é implícita.

<a id="falhas"></a>

## 17. Integridade, idempotência e falhas

### 17.1 Cadeia de proteção

- Sessão/escopo são autoridade; IDs isolados não concedem acesso.
- Provedor, ambiente e recebedor vinculados à tentativa.
- Chaves independentes para pedido, ordem e captura.
- Hash impede reutilizar chave com entrada diferente.
- PayPal-Request-Id persistido por operação.
- Intenção CAPTURAR durável antes do popup; envio_iniciado_em persistido antes do POST financeiro e nunca apagado para permitir retransmissão.
- Locks coerentes: sessão → pedido → pagamentos → operações → evidências → direitos, conforme o serviço.
- Reservas com token/prazo e atualizações condicionais.
- Commit incerto é observado por identidade durável, sem nova chamada financeira cega.
- Direito e evento são atômicos.
- Financeiro e outbox compartilham transação; SMTP fica fora.
- Download usa a versão adquirida e a elegibilidade atual.

### 17.2 Falhas que não podem ser confundidas

| Situação | Consequência |
|---|---|
| Falha antes de comprovar captura | Não afirmar pagamento concluído |
| Captura externa concluída, persistência local incompleta | Preservar incerteza; rollback SQL não desfaz PayPal |
| Financeiro persistido, ativação falhou | Preservar quitação e acompanhar/reavaliar direito por mecanismo autorizado |
| Commit sem resposta conclusiva | Observar por identidade; não repetir captura automaticamente |
| Aceite SMTP e conclusão local perdida | Possível INCERTO; investigar antes de reenviar |
| Popup fechado | Não presumir cancelamento financeiro |
| Sessão/storage expirados | Não presumir ausência de efeitos |
| APROVADO sem CAPTURAR | Há aprovação, não captura comprovada; recuperação não autoriza nova cobrança |

<a id="diagnostico"></a>

## 18. Diagnóstico por etapa

| Sintoma | Conferir | Não presumir |
|---|---|---|
| Preço com compra indisponível | Política e PDF PUBLICADA/atual | Que basta ligar disponivel |
| Pedido criado e popup ausente | Dois gestos, aberturaPronta, ativação transitória, sessão, SDK, storage e intenção | Que o pedido/intenção não persistiu |
| APPROVED | Operação CAPTURAR, callback/ação e captura | Que está PAGO |
| DESCONHECIDO | Operação, ordem, captura e evidências | Que se pode cobrar novamente |
| PAGO com direito pendente | Avaliação, eventos, versão e alerta | Que recibo libera download |
| Polling encerrado | Prazo, sessão e última observação | Que pagamento foi cancelado |
| ATIVO e download recusado | Autoridade, finanças, arquivo e hash | Que se deve ignorar a validação |
| Recibo ausente | Outbox, modelo, worker e SMTP | Que não houve pagamento |
| Reembolso/disputa recebido | Ledger, correlação e processamento | Que já houve suspensão |
| Disputa resolvida | Desfecho e direito | Que acesso foi reativado |
| Recuperação sem mensagem | Resposta genérica, limites, elegibilidade e envio | Que titular/pedido não existe |

Sinais de acompanhamento:

- ATIVACAO_DIGITAL_PENDENTE.
- NOTIFICACOES_RESUMO: reservadas/enviadas/falhas/incertas/semReserva.
- NOTIFICACOES_DESATIVADAS_CONFIGURACAO e NOTIFICACOES_CICLO_INDISPONIVEL.
- RECUPERACAO_EMAIL_ENVIO_INDISPONIVEL.
- D9_AUTENTICACAO, D9_LIMITE e REVISAO.
- DESCONHECIDA/EM_EXECUCAO vencidas, PENDENTE/DESCONHECIDO e divergências entre entidades.

Correlacionar: pedido public_id → pagamentos/operações → ordem/captura → eventos → itens/versões → direitos/eventos → notificação. Não copiar tokens, segredos, dados pessoais ou conteúdo dos PDFs para relatórios.

### Evidências locais e limites de homologação

Na consolidação dos quatro commits anteriores foram registrados 331 testes Node aprovados, zero falhas e dois ignorados; 189 testes Angular aprovados; TypeScript e compilador Angular com `--noEmit` aprovados. Para a consolidação S1 isolada, os quatro arquivos de testes direcionados passaram sem falhas e a suíte financeira executou 36 cenários aprovados em MariaDB 10.3.39 descartável, com socket/datadir privados, TCP desativado e provider simulado; cinco grupos fora do padrão selecionado foram ignorados. A instância foi encerrada e removida ao final.

O Chrome real com SDK oficial Sandbox comprovou o fluxo em dois gestos, uma compra normal completa e o bloqueio controlado do callback no cenário recuperado. A recuperação isolada comprovou aprovação externa, captura única, quitação e ativação do direito; não comprovou novo download do PDF. O preenchimento autenticado do e-mail foi posteriormente conferido no frontend local com sessão real de homologação. Nenhuma dessas evidências comprova comportamento PayPal Live ou implantação da recuperação S1 na VPS.

### Limites explícitos

1. HTTP 200 não comprova navegador, pagamento ou recebimento de e-mail.
2. GET observacional direto não atualiza o banco por si.
3. Recuperação automática pode concluir a mesma intenção durável nunca enviada, após aprovação comprovada e dentro do prazo; envio incerto é somente reconciliado. Não captura ordens históricas sem intenção.
4. Recibo e liberação digital são caminhos separados.
5. Reversões sem extrator e outros adversos exigem intervenção.
6. REVISAO, INCERTO e suspensão não devem ser apagados por SQL para destravar a UI.
7. Transição permitida no contrato não prova automação de todo evento.
8. Aprovação não comprova liquidação do débito relatado.
9. Fim do polling não substitui acompanhamento operacional.
10. Configuração Live/SMTP estruturalmente válida não comprova transação ou entrega real.

<a id="referencias"></a>

## 19. Referências e manutenção

- [Catálogo](loja-catalogo-r2-mariadb10339.md)
- [Sessões](loja-sessoes.md)
- [Pedidos HTTP](loja-pedidos-http.md)
- [Serviço financeiro](loja-pagamentos-servico-67.4.md)
- [Persistência financeira](loja-pagamentos-persistencia-67.3.md)
- [Avaliação financeira](loja-download-financeiro-d52-b3-b1.md)
- [Direitos](loja-download-direitos-d52-b3-b2.md)
- [Downloads HTTP](loja-downloads-http-d6-b3.md)
- [Recibo completo](loja-recibo-compra-b7-e2.md)
- [Outbox](loja-notificacoes-outbox-68-1.md)
- [Processador de notificações](loja-notificacoes-processador-68-2.md)
- [Fundação OTP](loja-recuperacao-otp-persistencia-b7-c3.md)
- [Serviço OTP](loja-recuperacao-otp-servico-b7-c4.md)
- [HTTP OTP](loja-recuperacao-otp-http-b7-c5.md)
- [Eventos adversos](loja-paypal-eventos-d8-b1.md)
- [Worker adverso](loja-worker-adverso-d9-b2.md)
- [Descoberta](loja-descoberta-adversa-d9-b3.md)
- [Sandbox/Live](loja-paypal-live-etapa111.md)

As referências históricas podem descrever etapas anteriores; em conflito, consultar contratos/rotinas da revisão-base. Atualizar este mapa quando mudarem estados, endpoints, callbacks, tempos, retentativas ou critérios de autorização.

Este documento não contém credenciais nem identificadores de compras reais.
