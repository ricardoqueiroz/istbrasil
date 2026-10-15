# Sessões anônimas da Loja — Etapa 65.2

## Configuração do servidor

Nenhum `.env` foi alterado. Antes de habilitar o endpoint, configurar no processo:

- `NODE_ENV=development` (ou `test`) no HTTP local; `production` no HTTPS de produção. Valores desconhecidos são rejeitados.
- `LOJA_ORIGENS_PERMITIDAS`: origens completas separadas por vírgula, sem barra final, caminho, credenciais ou curingas. Desenvolvimento aceita somente loopback; padrão `http://localhost:4200`. Produção exige configuração explícita HTTPS; exemplo, após aprovação operacional: `https://istbrasil.org.br,https://www.istbrasil.org.br`.
- `LOJA_CSRF_SECRET`: segredo exclusivo, 32 bytes criptograficamente aleatórios codificados em base64url canônico (43 caracteres). Gerar com `crypto.randomBytes(32)` em processo administrativo seguro e armazenar no gerenciador de segredos. Não versionar, registrar ou devolver o valor. Compartilhar entre instâncias. A rotação invalida os CSRF anteriores; um novo bootstrap fornece outro CSRF para o mesmo cookie válido.

Ausência ou invalidade de configuração bloqueia os novos endpoints com erro sanitizado; não impede consultas existentes do catálogo. A seleção do cookie depende exclusivamente da configuração do processo, nunca de Host ou X-Forwarded-Proto.

## Contrato HTTP

Chamada same-origin `POST /api/loja/sessao`, corpo `{}`, `Content-Type: application/json`, `X-IST-Loja: 1` e `Origin` exatamente permitido. O navegador envia Origin e cookies. Não enviar parâmetros de consulta. Corpo limitado a 4 KiB; aplica-se também o limite de requisições existente da Loja.

Resposta `201` para nova sessão ou `200` para reutilização:

```json
{"sessao":{"expiraEm":"2026-10-16T12:34:56.123Z"}}
```

Cabeçalho `X-CSRF-Token` contém o CSRF, não o token de sessão. `Cache-Control: no-store`. O token de sessão sai exclusivamente em `Set-Cookie` na criação. A reutilização não reenvia cookie nem estende a validade. Guardar CSRF em memória e recuperá-lo por novo bootstrap após recarregar; nunca colocá-lo em URL. Não foi implementada integração Angular nesta etapa.

Produção: `__Host-ist-loja; Secure; HttpOnly; SameSite=Lax; Path=/`, sem Domain. Local: `ist-loja-dev; HttpOnly; SameSite=Lax; Path=/`, sem Secure. Max-Age de no máximo 86400 segundos, limitado ao tempo restante. Cookies legados não são modificados. Usar `/api` via proxy e mesma origem; não depender do CORS global, que permanece intacto.

## Persistência e proteção

Token de 32 bytes aleatórios em base64url; banco recebe apenas SHA-256 binário da representação textual canônica. SQL limitado a `ist_loja_sessoes`, usando o pool existente, sem alteração de esquema. Datas DATETIME(3) escritas em UTC explícito e lidas como texto UTC por DATE_FORMAT, sem conversão do fuso do driver. Validade absoluta de 24 horas, sem renovação. Cada operação protegida consulta novamente expiração e revogação.

CSRF: HMAC-SHA256 do domínio `ist-loja/csrf/v1` seguido de byte NUL e dos 32 bytes do token de sessão, usando segredo exclusivo do servidor; comparação com timingSafeEqual após validar tamanho/codificação. Não é o hash armazenado no banco.

O middleware `criarProtecaoLoja().protegerEscritaLoja` exige cookie válido, Origin permitido, JSON, `X-IST-Loja: 1` e `X-CSRF-Token`. Rejeita Origin ausente/null, consultas na URL e substituição do cookie pelo CSRF. Disponibiliza apenas metadados internos em `res.locals.sessaoLoja`. Não foi montado em novas operações comerciais, pois elas ainda não existem.

`revogarSessao` é operação interna idempotente; não há endpoint público de revogação nesta etapa. Sessão expirada, revogada ou desconhecida é rejeitada no middleware; o bootstrap cria outra. Erro de banco não é confundido com sessão inválida e não provoca substituição. Colisões UNIQUE na criação têm no máximo três tentativas; não há renovação nem retentativa ilimitada.

Cookies bloqueados: bootstrap pode responder 201, mas operações protegidas retornam 401 sem cookie. Não há fallback por URL/JSON. A futura interface deverá informar que cookies são necessários. Inicializações sem cookie simultâneas podem criar sessões distintas; serializar bootstrap no cliente. Reutilizações concorrentes não alteram validade. Esta sessão anônima não autentica usuário nem substitui a autenticação legada.

## Validação e limites

Testes usam pool simulado e servidor HTTP efêmero em loopback. Não acessam o banco recuperado nem produção e não criam pedidos. Ativação com segredo e allowlist reais e integração Angular ficam pendentes de autorização. Não há checkout, pagamento, entrega digital ou criação de pedidos nesta etapa.
