# B7-C5 — Integração HTTP, modelo administrativo e SMTP estrito

> Registro histórico preservado. Consulte a seção “Estado atual para consolidação Git” ao final.

Implementação local, sem publicação, alteração de .env, aplicação de migration ou envio real.

## Contratos HTTP

Base: `/api/loja/downloads/recuperacao`.
Bootstrap existente `GET /sessao` fornece cookie CSRF e token; novos POSTs exigem
Origin permitido, `X-IST-Loja: 1`, `X-CSRF-Token`, cookie bootstrap, JSON e nenhuma query string.
Não se altera configuração de proxy: IP vem de `req.ip` segundo a política já configurada no Express.

- `POST /solicitar-codigo`, corpo exato `{email,pedidoPublicId}`.
  HTTP 202: `{"mensagem":"Se houver direitos elegiveis, enviaremos as instrucoes de recuperacao."}`.
  Mesma resposta para pedido inexistente/inelegível, quotas, modelo indisponível, SMTP desativado ou falho.
  Nenhum código, e-mail, identificador de desafio, envelope interno ou status SMTP na resposta.
  Sintaxe de corpo inválida retorna 400; origem/CSRF inválidos 403, como no LINK.
- `POST /validar-codigo`, corpo exato `{pedidoPublicId,codigo}`; código é string.
  HTTP 200: `{"sessao":{"autenticada":true,"expiraEm":"..."}}` e cookie recuperado existente.
  Código errado, expirado, invalidado, reutilizado ou pedido sem desafio: 400 `RECUPERACAO_INVALIDA`.
  Limite HTTP: 429; indisponibilidade/commit incerto: 503; nunca cookie nesses erros.

O backend resolve observacionalmente o desafio OTP aberto pelo pedido e ambiente. O validador
reutilizado relê e verifica identidade, e-mail, estado e HMAC sob lock após adquirir os limites.
Não é necessário transportar e-mail/publicId de desafio na validação nem criar um cookie de desafio.
Uma corrida com reenvio pode recusar o código anterior; não troca seu consumo pelo desafio novo.
Não há captura, reconciliação ou alteração financeira.

## Modelo e envio

`prepararEmailPorChave` carrega um snapshot do modelo e assinatura e devolve compositor puro.
`comporEmailPorChave` continua usando o mesmo caminho; contratos antigos preservados.
O adaptador existente ganha `prepararCodigo`, usando exclusivamente a chave
`recuperacao_biblioteca_codigo`, com os quatro placeholders B7-C2:
`pedido_public_id`, `codigo`, `validade_minutos` e `link_acesso`.
O link absoluto aponta para `/loja/recuperar`, sem segredo, código ou pedido em query/fragmento.
A interface para inserir código ainda depende da próxima fase Angular.

Preflight completo (modelo ativo, placeholders, assinatura e URLs) ocorre antes de solicitar OTP.
A composição com valores efetivos é chamada dentro da transação, antes de invalidar/escrever
qualquer desafio. Esse callback deve ser síncrono e puro; não faz SQL, SMTP ou logs.
Assim, inclusive código literal proibido no assunto preserva o desafio anterior e reverte orçamento
quando a composição efetiva falha. O snapshot evita recarregar modelo editado entre preflight e envio.

Após ACK do commit, enviar uma única vez pelo mesmo `criarEnvioRecuperacaoSmtp`.
A fábrica estrita passa também HTML ao `enviarEmail` existente, mantendo texto, remetente, TLS,
validação de certificados, timeouts, sanitização de erros e ausência de retries.
Nenhum outro transporter ou template HTML foi criado. Assinatura e texto vêm do compositor administrativo.
Falha SMTP depois do commit não desfaz emissão/invalidação: o código pode ter sido aceito remotamente;
não repetir nem restaurar automaticamente o anterior. Cooldown e quotas permanecem.

Tarefas usam o mecanismo existente: até quatro operações em voo, sem fila durável,
com resposta pública imediata e uniforme. Reinício pode perder um envio em andamento;
esta fase não adiciona garantia de entrega. `aguardarEnvios` permanece exclusivo de testes.
Mesmos buckets HTTP de solicitação/validação do LINK; OTP adiciona os limites persistentes já B7-C3/C4.
Compartilhar os buckets preserva os limites anteriores, podendo restringir o reenvio além da janela persistente.

## Configuração futura e implantação

Nenhum valor foi criado ou alterado. Além das configurações existentes de recuperação SMTP/origens,
a fábrica HTTP OTP exige explicitamente chaves base64url canônicas de 32 bytes:

- `IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL` (existente);
- `IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_OTP`;
- `IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_LIMITES`.

As três devem ser independentes. Não há fallback para segredo CSRF ou chave de e-mail.
Carregamento LINK continua independente das novas chaves. Falta de configuração OTP falha fechada;
solicitação permanece genérica e validação não emite cookie.

Pré-requisitos para futura publicação: B7-C3 aplicada mediante autorização, modelo administrativo
ativo criado/revisado separadamente, chaves e SMTP configurados com autorização, backup e rollback
coordenados com leitores LINK dependentes do schema B7-C3. Não executar esses passos agora.

## Testes e limites

`lojaDownloadRecuperacaoOtpHttp.test.js`: Express isolado em loopback/porta efêmera,
MariaDB 10.3.39 nativo descartável com TCP desligado e verificação de identidade da fixture existente.
Nenhum .env da instalação, banco real, Mailpit ou SMTP externo é utilizado.
Modelos/assinaturas sintéticos carregados por mock de banco; SMTP real substituído por `sendMail`
simulado dentro da fábrica estrita existente. Não há conexão SMTP.

Cobre request elegível/inelegível, configuração padrão, modelo ausente/inativo/inválido,
composição efetiva falha antes de invalidar, HTML/texto/assinatura, SMTP falho sem retry,
CSRF/origem, zeros à esquerda, cinco erros, expiração, reutilização, cookie e escopo por pedido.
Regressão HTTP completa por LINK roda contra schema B7-C3, junto das suites C4, templates e SMTP.
A fixture HTTP legada foi atualizada para este schema (MariaDB 10.3.39); a validação antiga
em MariaDB 13 não foi executada e não substitui a compatibilidade exigida com 10.3.39.

Resultados de commit incerto no HTTP são simulados; a suite C4 também simula perda de ACK
antes/depois do commit real. Não se testa queda de processo entre commit e SMTP nem entrega postal.
Respostas genéricas não garantem tempo constante. Quem conhece pedido e código pode autenticar;
quem conhece o pedido pode consumir orçamento de tentativas, limitado por CSRF, IP e buckets persistentes.
Nenhum mecanismo adicional de autenticação/binding foi introduzido fora do contrato solicitado.

Próximas etapas, mediante revisão/autorização: Angular para formulário e código, preparo administrativo
na homologação, ativação coordenada de schema/configuração/código e teste funcional com Mailpit.

## Estado atual para consolidação Git — 30/10/2026

As descrições anteriores de “implementação local” e “próxima fase Angular” são o registro histórico
original da B7-C5. A integração Angular e as etapas de publicação/homologação ocorreram depois.

- **Implementação atual:** `solicitar-codigo` e `validar-codigo` estão integrados ao serviço OTP,
  ao compositor administrativo, à assinatura e ao SMTP estrito. A página Angular solicita e-mail e
  pedido, preserva zeros à esquerda e usa CSRF/cookies existentes. O fluxo LINK continua disponível.
- **Composição:** o modelo `recuperacao_biblioteca_codigo` usa exatamente `pedido_public_id`,
  `codigo`, `validade_minutos` e `link_acesso`. O envelope interno de entrega não é resposta HTTP;
  não registrar códigos, tokens ou valores de placeholders em logs.
- **Testes:** existem suítes HTTP/SMTP simulado, regressão LINK e specs Angular. Os resultados de
  cada etapa têm escopos próprios; esta preparação não executa testes, builds ou envios e não produz
  uma nova contagem agregada de aprovação.
- **Publicação e validação WSL2:** as etapas B7-C7 publicaram backend/frontend e prepararam o modelo.
  A B7-C8 registrou solicitação HTTP 202, validação HTTP 200, captura local no Mailpit, sessão recuperada,
  direitos/download e rejeição do código reutilizado. Nenhuma dessas ações foi repetida agora.
- **SMTP e ambientes:** a homologação usa Mailpit local com captura explícita, sem entrega externa.
  O transporte estrito externo mantém exigências TLS. Não copiar configuração Mailpit, chaves ou
  valores do `.env` para produção ou para o Git. A homologação local não comprova entrega externa.
- **Schema:** as seis CHECKs foram restauradas como correção específica, conforme confirmação do
  responsável em 30/10/2026 e registro atualizado de B7-C3. Não reaplicar B7-C3 automaticamente.
- **Live:** não afirmar publicação ou validação funcional na VPS a partir do schema alinhado.
  Configuração, autorização de envio e validação de produção são etapas operacionais independentes.

Esta consolidação preserva os contratos públicos e os mecanismos de anti-enumeração, CSRF, origem,
rate limiting e cookies. Não inclui alterações de checkout, banco ou serviços durante sua preparação.
