# Etapa 67.4 — Núcleo transacional de pagamentos

## Arquitetura e escopo

Arquivos novos:

- src/services/lojaPagamentoContratos.js
- src/services/lojaPagamentoPersistencia.js
- src/services/lojaPagamentoService.js
- tests/fixtures/lojaPagamentoSimulado.js
- tests/fixtures/lojaPagamentoBancoIsolado.js
- tests/lojaPagamentoContratos.test.js
- tests/lojaPagamentoService.integration.test.js
- docs/loja-pagamentos-servico-67.4.md

Somente contratos, persistência transacional e orquestração internos. Não existem
rotas, controller, provider padrão ou ativação por configuração. Pool e adaptador
são injetados obrigatoriamente; importar o serviço não lê dotenv nem conecta a um
banco. Reutiliza UUID e constantes dos contratos de pedidos, sem recotar ou
duplicar preços. A migration 67.3 e todos os arquivos preexistentes permanecem
intactos.

## Interface interna

```js
const pagamentos = criarLojaPagamentoService({
    db, adaptador,
    contexto: { provedor, ambiente, contaRecebedora }
});
await pagamentos.criarTentativa(sessaoValidada, { pedidoPublicId }, chaveUuidV4);
await pagamentos.capturar(sessaoValidada, { pagamentoPublicId }, chaveUuidV4);
await pagamentos.reconciliar(sessaoValidada, { pagamentoPublicId });
```

O contexto é configuração confiável do servidor, nunca JSON do comprador.
sessaoValidada segue o contrato interno de pedidos: metadados provenientes do
middleware, não identificação escolhida pelo navegador. O serviço reconsulta a
sessão e sua propriedade sob bloqueio, inclusive expiração e revogação. O UUID
público não autoriza leitura/captura sozinho. Entradas aceitam somente o campo
de identificação previsto; preços, moeda e resultados enviados como extras são
rejeitados. Não foi criado endpoint ou tratamento HTTP de sessão/CSRF novo.

## Contrato do adaptador

- criar({ referencia, requestId, valorCentavos, moeda, ambiente,
  contaRecebedora, signal })
- consultar({ referencia, ordemId, requestIdCriacao, requestIdCaptura,
  valorCentavos, moeda, ambiente, contaRecebedora, signal })
- capturar({ referencia, ordemId, requestId, valorCentavos, moeda,
  ambiente, contaRecebedora, signal })

Valores são strings de centavos inteiros. Referência é o public_id da tentativa.
Respostas normalizadas: estado, referencia, ordemId, capturaId, valorCentavos,
moeda, contaRecebedora, ambiente e capturadoEm (ISO UTC). IDs/datas ausentes são
null. Somente esses campos permitidos chegam às evidências; extras são descartados.

Consulta deve ser livre de efeitos financeiros. RECUSADO/CANCELADO/EXPIRADO
representam fatos externos definitivos sem cobrança pendente, nunca inferência
a partir de timeout ou de ausência momentânea. DESCONHECIDO não autoriza reenvio.
A consulta por request ID é uma capacidade do simulador, não uma garantia
de disponibilidade em qualquer futuro provedor real.

O adaptador simulado existe somente em tests/fixtures. Sua criação exige
NODE_ENV=test; o serviço também recusa esse adaptador em produção e em live.
Não existe ligação do simulador com rotas, .env ou interface Angular.

## Fluxos e transações

Criação: validar sessão/propriedade e pedido, ler total e moeda persistidos,
reservar tentativa e registrar CRIAR/PREPARADA, confirmar transação, adquirir
execução exclusiva, chamar adaptador e aplicar resposta em outra transação.
Pedido muda para AGUARDANDO_PAGAMENTO sem alterar seus itens/snapshots.

Captura: registrar CAPTURAR, adquirir execução, consultar aprovação no adaptador,
revalidar sessão/pedido e vínculo, persistir APROVADO/CAPTURANDO e decisão de envio,
chamar adaptador fora da transação e aplicar resultado financeiro. Sem aprovação,
nenhuma captura é enviada; a operação permanece preparada para a mesma chave.

Somente captura integral, com valor/moeda/recebedor/referência/ordem verificados,
pode gravar CAPTURADO, liberar a reserva e gravar PAGO/pagamento_confirmado_em no
pedido. Evidência, operação e estado financeiro são confirmados atomicamente.
Mudança inesperada do total persistido, colisão de IDs externos, captura tardia
ou divergência financeira provocam REVISAO. Valor observado divergente é
preservado quando a associação é válida, além da evidência normalizada.

Isolamento READ COMMITTED. Ordem de bloqueio: sessão, pedido, pagamentos por ID,
operações por ID. Eventos são inseridos após esses bloqueios. Nenhum lock SQL é
mantido durante criar/consultar/capturar do adaptador. Não há schema novo, ALTER
ou criação de estruturas durante operação do serviço.

## Idempotência e concorrência

Escopo persistido: pedido/ação/chave UUID. Hash SHA-256 contém versão, identificação
da solicitação e contexto do servidor. Repetição idêntica reutiliza a operação;
conteúdo/contexto divergente conflita. Request ID externo é imutável. Uma operação
lógica de criação/captura por tentativa e reserva única por pedido usam os índices
da 67.3. Replays concluídos não gravam nem chamam novamente o adaptador.

Operações em execução têm token interno, prazo e versão. A comparação do token
impede o trabalhador anterior de sobrescrever o atual. Prazo vencido permite
somente consulta, sem reenviar a operação financeira. Consulta que ainda mostre
APROVADO após envio de captura não prova falha: continua DESCONHECIDO com reserva.

Transações SQL podem repetir no máximo três vezes por deadlock/lock timeout,
sempre após rollback. Chamadas externas não são repetidas automaticamente.
Conexões sujas, rollback não confirmado ou COMMIT incerto não voltam ao pool.
Após resultado externo perdido, registra-se DESCONHECIDO. Se o COMMIT de aplicação
do resultado tiver ocorrido, a releitura detecta o desfecho persistido sem regressão.

## Estados e recuperação

Implementados: CRIANDO, AGUARDANDO_APROVACAO, APROVADO, CAPTURANDO, PENDENTE,
CAPTURADO, RECUSADO, CANCELADO, EXPIRADO, DESCONHECIDO e REVISAO. O mapa de
transições rejeita regressões inválidas. Estados de reembolso/estorno estão
previstos no vocabulário, sem comandos que os executem.

PENDENTE e DESCONHECIDO conservam reserva; recusa definitiva permite outra
tentativa somente enquanto o pedido continuar elegível. Reconciliação é explícita
e apenas consulta o adaptador. Resposta perdida após captura efetivada pode ser
recuperada para PAGO; resultado ainda ambíguo permanece preservado, sem recaptura.
Sessão revogada durante uma chamada já autorizada não impede persistir o fato
financeiro de retorno. Novas chamadas continuam exigindo sessão válida.

## Validação executada

MariaDB **13.0.2-MariaDB**, instâncias próprias em loopback e porta aleatória
distinta de 3306/3307. Datadir abaixo de TEMP validado por SELECT antes de qualquer
escrita. Fixtures novas, sem credenciais/pool do ambiente recuperado. Fundação de
pedidos criada a partir do DDL versionado e migration 67.3 executada integralmente.

Última execução conjunta: serviço em 127.0.0.1:63743; persistência em
127.0.0.1:63742. Ambos encerrados e datadirs removidos com verificação de caminho.

- 6 testes unitários novos.
- 47 cenários de integração novos; 48 contabilizados com o grupo pai.
- 70 cenários da persistência 67.3; 71 contabilizados com o grupo pai.
- **125 testes contabilizados, todos aprovados; zero falhas/ignorados.**

Cobertura inclui autorização, validade, replay, conflitos de conteúdo/contexto,
duas tentativas e capturas concorrentes, aprovação obrigatória, captura integral,
pendência, recusa, cancelamento/expiração externos, timeout e resposta perdida,
reconciliação, prazo de execução vencido, trabalhador antigo, captura tardia,
divergências, colisão de ID externo, falha parcial/rollback, COMMIT incerto com e
sem persistência, retry limitado de deadlock, descarte de conexão suja, projeção
segura de dados e impedimento de uso real do simulador. Os deadlocks e COMMITs
perdidos são injetados sobre conexões/transações reais; não simulam falha física.

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN = 'C:/Program Files/MariaDB 13.0/bin'
node --test --test-reporter=spec tests/lojaPagamentoContratos.test.js tests/lojaPagamentoService.integration.test.js tests/lojaPagamentosPersistencia.integration.test.js
```

Sem a variável opt-in, integrações são explicitamente ignoradas. Nenhuma
dependência instalada, serviço Windows alterado ou servidor preexistente usado.

## Limitações e próximos blocos

Não há prova de compatibilidade executada em MariaDB 10.3.39. Não houve chamada
a PayPal, Mercado Pago ou outro provedor real. Adaptadores futuros precisam
implementar a normalização e as garantias de consulta; simulador não comprova
comportamento financeiro real.

Não existe scheduler, webhook, endpoint, checkout, reembolso ou resolução
administrativa de REVISAO. A reconciliação oferecida requer sessão válida;
recuperação operacional após expiração da sessão precisará de entrada interna
autorizada em etapa posterior. Operações não esclarecidas continuam reservadas,
sem cancelamento automático ou criação de nova tentativa. Não é garantia de
exactly-once entre banco e rede: o protocolo conserva a incerteza com segurança.

Não alterados: migration 67.3, schemas reais, Angular, PayPal legado, ist_orders,
server.js, Nginx, .env ou configurações de deploy/produção. Nenhum banco real
acessado. npm-audit-local.json preservado. Sem commit, push ou deploy.
