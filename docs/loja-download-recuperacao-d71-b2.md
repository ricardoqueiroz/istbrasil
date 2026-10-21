# D7.1-B2 — API de recuperacao e envio simulado

API registrada antes do router D6 e do CORS/parser global. Nenhuma mudanca na B1,
na autorizacao D6 ou na politica financeira. Nenhum SMTP real foi acionado.

## Contratos HTTP

Base: `/api/loja/downloads/recuperacao`. Todos exigem origem permitida,
`X-IST-Loja: 1`, ausencia de query e respostas privadas no-store/no-referrer.
POST exige JSON (maximo 1 KiB), cookie CSRF e `X-CSRF-Token` correspondente.

- `GET /sessao`: 200 com `{sessao:{autenticada:false},csrfToken}` ou
  `{sessao:{autenticada:true,expiraEm},csrfToken}`. Sem token de sessao ou IDs de
  direitos. Nao renova a sessao recuperada. Emite/reutiliza bootstrap CSRF separado.
- `POST /solicitar`: corpo exato `{email}`; email sintaticamente valido recebe
  SEMPRE 202 com `{mensagem:"Se houver direitos elegiveis, enviaremos as instrucoes de recuperacao."}`.
  Isso inclui ausencia de compras, inelegibilidade, supressao por limites, falta
  de adaptador e falha de envio. Sintaxe/CSRF/origem invalidos nao recebem 202.
- `POST /validar`: corpo exato `{publicId,segredo}`. 200 com
  `{sessao:{autenticada:true,expiraEm}}` e cookie apos COMMIT confirmado da B1.
  Desafio invalido/expirado/usado: 400 RECUPERACAO_INVALIDA; limite de IP: 429;
  falha tecnica/COMMIT incerto: 503 RECUPERACAO_INDISPONIVEL, sem cookie.
- `POST /revogar`: corpo `{}`; exige sessao valida. Revoga pela B1 e somente
  depois remove o cookie; 200 `{revogada:true}`. Sessao ausente/expirada/revogada:
  401. Falha tecnica nao simula revogacao nem limpa cookie como se tivesse sucesso.

Erros publicos tem somente `{erro:{codigo}}`, sem mensagem bruta do driver,
SQL, email, segredo ou token. Corpo/query/origem/headers invalidos sao recusados
antes das operacoes. GET de /validar nao consome desafio.

## CSRF e cookies

Cookie recuperado: `ist-loja-recuperacao-dev` no desenvolvimento e
`__Host-ist-loja-recuperacao` em producao. HttpOnly, SameSite=Lax, Path=/,
Secure em producao, sem Domain; Expires absoluto de ate 24 horas, vindo da B1.
Nao usa nem altera o cookie original de checkout.

O bootstrap CSRF NAO e uma sessao autenticada: nonce aleatorio, validade de 15
minutos e assinatura HMAC com dominio proprio, usando a chave CSRF existente.
Cookie distinto `ist-loja-recuperacao-csrf-dev` ou
`__Host-ist-loja-recuperacao-csrf`; atributos de seguranca iguais aos acima.
GET /sessao fornece o MAC CSRF correspondente pelo helper existente. O navegador
que abre o link pode obter seu proprio bootstrap: o desafio nao e vinculado ao
navegador que pediu o email. Cookies duplicados/adulterados nao sao selecionados.

CORS usa apenas origens da configuracao da Loja, com credenciais e sem wildcard.
Preflight limitado a GET/POST e Content-Type/X-IST-Loja/X-CSRF-Token.
O router encerra inclusive erros/rotas ausentes, sem cair no CORS global permissivo.

## Solicitacao e envio

Preflight SQL em transacao READ ONLY/REPEATABLE READ, email normalizado com
comparacao binaria, contexto financeiro confiavel, teto B1 de 50 candidatos.
Reutiliza o avaliador D6 somente leitura, sem ativar/reconciliar direitos.
Somente havendo direitos elegiveis cria desafio pela B1 e chama o adaptador.
A verificacao definitiva de propriedade/escopo continua no consumo B1.

A resposta 202 nao aguarda consulta ou transporte: tarefas em memoria, sem fila,
no maximo quatro em voo. Erros de consulta/envio nao revelam existencia de compras
e nao geram cookies autenticados. Sem garantia de entrega duravel: queda do
processo, saturacao ou falha exigem nova solicitacao dentro das cotas.

`criarAdaptadorEmailRecuperacao({enviarEmail,origemPublica,producao})` aceita a
assinatura do `mailService.enviarEmail`, mas NAO importa esse servico nem fornece
transporte real default. Origem explicita e canonica; HTTPS em producao e origem
loopback em desenvolvimento. Nunca usa Host/X-Forwarded-Host recebidos.
Mensagem de texto com link `/loja/recuperar#id=...&segredo=...` e aviso de
confirmacao explicita. Segredo fica no fragmento, fora da query HTTP.

## Limites por processo

- Solicitacao: cinco por IP/15 minutos, com supressao e o mesmo 202 ao exceder.
- Envio: ate tres por email normalizado/hora; chave HMAC em memoria, sem email
  em texto na chave do mapa. Tentativas admitidas contam mesmo se envio falhar.
- Validacao: dez por IP/15 minutos, alem das cinco falhas por desafio persistidas
  na B1; excesso de IP retorna 429.
- Consulta: trinta por IP/minuto; revogacao: dez por IP/minuto.
- Mapas limitados a 10.000 entradas, expiradas removidas ao receber requisicoes;
  sem timer permanente. Maximo quatro tarefas, sem enfileirar excedentes.

IP usa a configuracao trust proxy existente. Proxy confiavel deve impedir
falsificacao de encaminhamento. Limites em memoria nao sao globais em multiplos
processos e reiniciam com o processo; isso exige revisao antes de escalar/ativar.

## Composicao e limites operacionais

`server.js` registra o router com o pool compartilhado, sem consultas ou envios na
importacao/inicializacao e sem criar outro pool. Fabrica financeira B1 e lazy.
Pode receber service, chaveEmail, contextoEsperado e adaptadorEmail explicitamente.
Sem chave injetada, a chave B1 e lida de
`IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL` (32 bytes em base64url canonico).
Contexto vem de IST_LOJA_PAYPAL_ENV/IST_LOJA_PAYPAL_CONTA_RECEBEDORA existentes.
Configuracao ausente falha conservadoramente; nenhum .env foi modificado.

O registro padrao NAO injeta adaptador: envio real permanece desabilitado nesta
etapa. A futura composicao SMTP devera configurar origem publica e transporte
explicitamente, verificar TLS/certificados e autorizar envio real separadamente.
A chave e a migration nao foram instaladas no banco/ambiente principal.

Pagina Angular `/loja/recuperar` ainda nao implementada. A futura pagina deve
remover o fragmento do historico, evitar terceiros/Referer e exigir confirmacao
antes do POST. Link so pode ser testado manualmente com cliente sintetico nesta
entrega. Scanners GET nao consomem; nao se promete protecao absoluta contra
scanners interativos. Sessao recuperada ainda NAO e aceita pelos downloads D6.
Limpeza operacional dos desafios expirados continua pendencia documentada na B1.

## Testes executados

Transporte exclusivamente simulado; dados sinteticos e portas HTTP loopback
dinamicas. Nenhum backend/Angular preexistente reiniciado.

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/lojaDownloadRecuperacaoHttp.test.js tests/lojaDownloadRecuperacaoService.test.js tests/lojaSessaoHttp.test.js tests/serverComposicao.test.js
```

MariaDB 13.0.2: 71 testes aprovados, 0 falhas, 0 ignorados (18 B2, 15 B1,
36 sessao/CSRF e 2 composicao). Fixtures confirmaram encerramento e remocao
dos datadirs. Sintaxe Node, Bash e git diff --check aprovados.

MariaDB 10.3.39 real, executor novo e independente sem alterar o B1:

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-d71b2-homologar-mariadb10339-wsl.sh
```

Saida fornecida pelo usuario: 10.3.39-MariaDB-1:10.3.39+maria~ubu2004;
externo 127.0.0.1:13339, interno 3306; 18 testes aprovados, 0 falhas, 0
ignorados, CODIGO_DE_SAIDA_TESTES=0. Confirmados autenticacao, identidade e
descarte de container/volume/segredos; Docker/containerd encerrados sem autostart.

Cobertura: uniformidade, ausencia de compras, cotas IP/email, transporte simulado
e falho/lento, consumo em outro dispositivo, concorrencia, expiracao/replay,
cookie Secure/HttpOnly, revogacao persistente, CSRF/CORS, Host malicioso,
GET de scanner, ausencia de segredos nos DTOs/erros, COMMIT incerto real sem
cookie e preservacao da sessao/estado financeiro anterior.
