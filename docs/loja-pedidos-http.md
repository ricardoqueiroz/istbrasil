# Etapa 65.6 — Criação HTTP de pedidos

Commit local da auditoria 65.5: `88434e74d00b1c824f1e10ae47c91ff55d9882c7`.

## Contrato

`POST /api/loja/pedidos`, preferencialmente same-origin via `/api`.

Cabeçalhos obrigatórios:

- `Origin`: origem exata da allowlist do servidor; enviado pelo navegador.
- `Content-Type: application/json`.
- `Idempotency-Key`: UUID v4, preservado pelo cliente em todas as repetições da mesma solicitação.
- `X-IST-Loja: 1`.
- `X-CSRF-Token`: obtido no cabeçalho da resposta de `POST /api/loja/sessao`.
- Cookie HttpOnly da sessão, enviado automaticamente pelo navegador.

```json
{
  "produtoIds": [1, 2],
  "compradorEmail": "comprador@example.com"
}
```

Somente esses dois campos. Rejeita preço, total, moeda, quantidade, ambiente,
identificação de sessão e tokens enviados no corpo. Não aceita parâmetros na URL,
inclusive tokens de sessão/CSRF. Requer de 1 a 100 IDs distintos. E-mail e IDs são
validados/normalizados pelos contratos existentes. Corpo limitado a 8 KiB.

## Respostas

- **201:** esta operação criou o pedido.
- **200:** reutilização idempotente de pedido existente.

O corpo é exclusivamente o DTO de `pedidoPublico`: publicId, estado, versao,
moeda, totalCentavos, criadoEm, expiraEm e itens públicos. Não inclui o metadado
interno criado, identificação de sessão, e-mail, hashes, tokens, descrição,
referências de PDF, credenciais ou dados de pagamento. Não há endpoint GET de
pedido ou downloads nesta etapa.

Todas as respostas do caminho de pedidos usam `Cache-Control: no-store`,
inclusive erros e limites de requisições. O endpoint de pedidos não emite cookie.

| HTTP | Códigos / motivo |
| --- | --- |
| 400 | SOLICITACAO_INVALIDA, IDEMPOTENCIA_INVALIDA, JSON_INVALIDO, CONTEUDO_INVALIDO |
| 401 | SESSAO_INVALIDA |
| 403 | ORIGEM_INVALIDA, CSRF_INVALIDO |
| 409 | CONFLITO_IDEMPOTENCIA |
| 422 | SELECAO_INVALIDA, EMAIL_INVALIDO, PRODUTO_INDISPONIVEL |
| 429 | LIMITE_REQUISICOES |
| 503 | CONTENCAO_TEMPORARIA |
| 500 | ERRO_INTERNO, inclusive configuração inválida |
| 413 | CORPO_MUITO_GRANDE, acima de 8 KiB |

Formato de erro: `{"erro":{"codigo":"CODIGO_ESTAVEL","mensagem":"Mensagem segura"}}`.
Sem detalhes SQL, stack ou mensagens arbitrárias de exceções.

## Cadeia aplicada

1. Marca no-store antes do limite global existente da Loja (120/minuto/IP).
2. Aplica limite próprio de pedidos (20/minuto/IP), incluindo tentativas rejeitadas.
3. Reutiliza protegerEscritaLoja: Origin, cabeçalho próprio, JSON/ausência de query, cookie válido, consulta da sessão e CSRF com comparação criptográfica segura.
4. Valida e normaliza Idempotency-Key antes do parser do corpo.
5. Analisa JSON (8 KiB), valida e normaliza solicitação com os contratos existentes.
6. Obtém configuração confiável e invoca uma única operação de criação no serviço.
7. Serializa somente o DTO público e escolhe status pelo resultado explícito.

O controller não faz transação, não consulta catálogo, não calcula valores nem
implementa idempotência. O serviço continua revalidando a sessão sob FOR UPDATE,
usando preços oficiais e gravando pedido/itens atomicamente. Proteção HTTP
rejeitada não invoca o serviço de pedidos. Nenhuma política global de CORS ou de
autenticação legada foi alterada.

## Adaptação mínima do serviço

A fábrica agora oferece `criarPedidoComResultado(sessaoValidada, entrada, chave)`,
retornando `{ pedido, criado }`. O método anterior `criarPedido(...)` continua
retornando somente o DTO, preservando os consumidores e testes existentes.
Ambos executam a mesma implementação, sem transações ou chamadas duplicadas.

O resultado não é inferido pelo estado CRIADO: replay pode devolver esse mesmo
estado com criado=false. Após COMMIT incerto, a reconciliação compara também o
public_id persistido com aquele inserido por esta operação. Se for o mesmo,
criado=true (201); replay posterior é 200. Se não houve persistência, retorna 503;
nova solicitação do cliente com a mesma chave poderá criar uma vez e retornar 201.

## Configuração e ativação

Reutiliza [a configuração de sessões](loja-sessoes.md):

- `LOJA_CSRF_SECRET`: 32 bytes secretos aleatórios, base64url canônico, configurados somente no servidor.
- `LOJA_ORIGENS_PERMITIDAS`: origens explícitas. Default local `http://localhost:4200`; produção exige HTTPS e allowlist explícita.
- `NODE_ENV`: seleciona cookie confiável do servidor, preservando políticas anteriores.
- `LOJA_AMBIENTE`: configuração de processo do adapter de pedidos, opcional; default `sandbox` do contrato aprovado, valores reconhecidos `sandbox` e `live`. Valor inválido bloqueia a operação. Não é lido do cliente e não habilita pagamento.
- Pool MariaDB existente: nenhuma configuração de conexão foi modificada.

Nenhum `.env` foi editado, nenhum segredo real foi versionado e nenhuma
configuração foi ativada por esta etapa. Integração Angular futura deverá usar
same-origin `/api`; os serviços Angular atuais não foram modificados.

## Validação realizada

- 59 testes novos de HTTP/configuração: cadeia real de middleware e controller, com sessão/criptografia reais e banco simulado nos testes sem MariaDB.
- 366 testes anteriores sem banco real: todos aprovados.
- 22 cenários na instância MariaDB temporária (18 anteriores + quatro novos HTTP); Node contabiliza 23 testes incluindo o grupo pai. Todos aprovados.
- Os quatro cenários novos cobrem 201/200/409 e concorrência HTTP; COMMIT incerto com persistência; COMMIT incerto sem persistência; sessão revogada entre middleware e transação.
- Sintaxe Node e git diff --check aprovados.

Instância isolada MariaDB 13.0.2, em loopback e porta distinta de 3306, com
diretório TEMP verificado antes de aplicar DDL/fixtures. A instância foi encerrada
e seus dados artificiais removidos. Banco recuperado e produção não acessados.
Não houve teste de escrita no banco recuperado.

## Limitações

Compatibilidade com MariaDB 10.3.39 analisada nas etapas anteriores, sem execução
real nessa versão. A integração desta etapa foi testada no 13.0.2, sem homologação
em 10.3.39. Confirmações perdidas foram injetadas em torno de COMMIT real; não
simulam falha física de disco ou partição de rede.

O limitador é em memória por processo, conforme o padrão existente; não é um
limitador distribuído. A sessão anônima não exige cadastro nem comprova posse do
e-mail. Criar pedido não confirma pagamento e não autoriza downloads.

Não houve checkout Angular, integração de pagamentos, webhooks, entrega digital,
commit da 65.6, push ou deploy. Aguardar aprovação antes do commit/próxima etapa.
