# D7.3-B1 — SMTP e preparação operacional

## Estado da entrega

Implementação preparada, envio real desabilitado. SQL homologado em MariaDB 13.0.2 e 10.3.39 descartáveis. A pendência HTTP foi concluída na F1 abaixo, com código 0 e descarte dos recursos. Homologação local concluída dentro do escopo simulado; ativação SMTP e implantação efetiva continuam dependendo de autorização e verificação operacional próprias.

Nenhum e-mail real, acesso ao banco principal, alteração em .env, reload de Nginx efetivo, reinicialização da API/Angular, commit, push ou deploy.

## Composição SMTP

`mailService.js` continua sendo o ponto Nodemailer. A nova fábrica `criarEnvioRecuperacaoSmtp` reutiliza `enviarEmail`, com transporte estrito injetado. O comportamento dos consumidores anteriores e do relay legado permanece. A recuperação não utiliza o transporte legado permissivo.

`comporEmailRecuperacao` é registrada em `server.js`. Não conecta, não executa verify SMTP, não consulta SQL nem envia durante a inicialização. Somente a configuração exata `IST_LOJA_RECUPERACAO_EMAIL_ATIVO=true` permite compor o adaptador; qualquer outro valor deixa-o ausente. Configuração inválida desativa apenas o envio de recuperação e emite código fixo sanitizado.

Configurações exigidas para uma futura ativação autorizada:

| Nome | Requisito |
|---|---|
| IST_LOJA_RECUPERACAO_EMAIL_ATIVO | Somente `true` habilita composição; não foi configurado nesta tarefa |
| IST_LOJA_RECUPERACAO_ORIGEM_PUBLICA | Origem HTTPS fixa, sem path, query, fragmento ou credenciais; deve pertencer às origens confiáveis da sessão |
| LOJA_ORIGENS_PERMITIDAS | Configuração existente; deve conter a origem pública aprovada |
| LOJA_CSRF_SECRET | Configuração existente de sessão, necessária à composição confiável |
| IST_LOJA_DOWNLOAD_RECUPERACAO_CHAVE_EMAIL | Chave B1 existente: base64url canônico de 32 bytes |
| SMTP_HOST | Host explícito, sem protocolo/porta/caminho; não aceita localhost ou host vazio |
| SMTP_PORT | `465` ou `587`, sem coerção ou fallback |
| SMTP_SECURE | `true` em 465; `false` em 587 com STARTTLS obrigatório |
| SMTP_REJECT_UNAUTHORIZED | Exatamente `true`; TLS mínimo 1.2 e validação de hostname/certificado |
| MAIL_FROM_ADDRESS | Endereço explícito válido, normalizado, sem display-name ou controles; escolhido pelo backend |
| MAIL_FROM_NAME | Nome explícito, até 100 caracteres, sem controles |
| IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO | `login` ou `relay`, decisão explícita |
| SMTP_USER e SMTP_PASS | Par obrigatório para login; ambos ausentes/vazios para relay |

Os nomes SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_REJECT_UNAUTHORIZED, MAIL_FROM_NAME e MAIL_FROM_ADDRESS foram encontrados no .env local, sem registrar seus valores. SMTP_USER/SMTP_PASS estão documentados no exemplo existente. Nenhum arquivo .env foi alterado.

O remetente é fixado pelo operador na configuração, nunca pelo comprador. A autorização desse remetente no provedor, política do relay, IP autorizado, DNS/SPF/DKIM/DMARC, autenticação e entregabilidade **não foram comprovados**. A presença de uma referência a Google Workspace não prova operação. É necessária homologação real separada e autorizada.

Sem pool SMTP, fila ou retry automático. Timeouts: conexão e greeting 10 s; socket 15 s. Logger/debug desativados e acesso a arquivos/URLs desabilitado. O transporte só recebe texto simples do adaptador B2, sem anexos.

Falha/rejeição/pendência do relay gera apenas `ENVIO_RECUPERACAO_INDISPONIVEL`. A composição registra `RECUPERACAO_EMAIL_ENVIO_INDISPONIVEL`, sem exceção original, endereço, segredo ou resposta SMTP. A B2 preserva HTTP 202 uniforme. Pode permanecer um desafio não consumido após falha de envio; não se cria sessão. O erro não dispara retry.

## Limpeza e retenção aprovada

Operação interna `criarLimpezaRecuperacao({db,bancoEsperado,agora}).limpar({confirmarRetencao:true,limite:100})`. Sem endpoint, timer, novo pool ou integração automática no startup. Não foi chamada no principal.

- Desafio não consumido: remove somente quando expiração é estritamente anterior ao corte de sete dias.
- Sessão consumida: expiração deve ser estritamente anterior ao corte de 90 dias; se revogada, a revogação também deve ser anterior a esse corte. Portanto, considera conservadoramente o mais recente dos dois marcos.
- No máximo 100 registros por chamada. O operador pode repetir uma chamada concluída com ACK após revisão; não há loop automático.
- Schema explícito, versão homologada, autocommit, FK/CHECK e modo estrito verificados na própria conexão antes de DELETE. Identificação externa de host/porta/datadir continua obrigatória; nome de banco não prova identidade.
- READ COMMITTED; lock de recuperações por id, depois remoção dos vínculos de escopo, depois do registro pai com revalidação do critério. Ordem compatível com B1/B3. Não adquire locks nem altera tabelas financeiras.
- Falha SQL reverte o lote. COMMIT incerto destrói conexão, retorna erro específico e não repete automaticamente.
- Preserva direitos, versões, eventos dos direitos, pedidos, itens, pagamentos, operações e eventos financeiros. Após a retenção aprovada, o registro de recuperação e seu escopo histórico deixam de existir; os dados comerciais e financeiros permanecem.

## Nginx versionado

Somente `nginx.conf` do repositório recebeu um location específico para `/loja/recuperar` e `/loja/biblioteca/confirmar`, com barra final opcional. `try_files /index.html =404` procura o arquivo como primeiro candidato, no mesmo location, em vez de fazer redirect interno pelo último argumento. Assim os headers não dependem de sobreviver à seleção de outro location:

```nginx
add_header Cache-Control "private, no-store, max-age=0" always;
add_header Referrer-Policy "no-referrer" always;
expires off;
etag off;
if_modified_since off;
try_files /index.html =404;
```

O fallback geral continua `try_files $uri $uri/ /index.html`. Nenhuma configuração efetiva foi substituída. O bootstrap Angular D7.2 continua retirando o fragmento antes de carregar recursos externos, sem alterações nesta etapa. Cache externo/CDN e configuração TLS da implantação exigem revisão própria.

Referências primárias: [Nodemailer SMTP](https://nodemailer.com/smtp), [Nginx headers](https://nginx.org/en/docs/http/ngx_http_headers_module.html), [Nginx try_files](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files).

## Evidências dos testes

- 61 testes Node sem banco principal: SMTP simulado, configurações, falhas de certificado/autenticação/timeout simuladas, mensagem sanitizada, composição do servidor, templates de e-mail, bootstrap e GET B2. Todos aprovados, zero ignorados.
- MariaDB 13.0.2 Windows: 25 testes aprovados, zero falhos/ignorados, incluindo regressão HTTP B2. Schemas sintéticos `ist_loja_67_3_853799b27363` (porta 63196) e `ist_loja_67_3_67d4f8489e52` (porta 63197). A fixture confirmou encerramento e remoção de ambos os datadirs.
- MariaDB 10.3.39 WSL: sete testes aprovados, zero falhos/cancelados/ignorados; código 0. Versão `10.3.39-MariaDB-1:10.3.39+maria~ubu2004`, schema `ist_loja_67_3_7b7078d27dbc`, porta interna 3306 e externa 13339. Imagem fixada em `sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102`.
- Os testes SQL verificaram limites de retenção, sessões válidas e recentemente revogadas, escopo, preservação por hash dos dados financeiros/direitos, rollback, concorrência, schema incorreto e COMMIT incerto.
- Nginx descartável: imagem `nginx@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5`; `nginx -t` aprovado com os blocos reais de locations em configuração sintética HTTP. Não valida certificados ou o arquivo completo de produção.
- A primeira chamada HTTP pelo Node Windows a 127.0.0.1:13380 falhou com ECONNREFUSED. Nenhuma das quatro asserções de cabeçalhos HTTP chegou a ser executada. Disponibilidade havia sido confirmada somente dentro do contêiner. Leitura posterior de sockets mostrou 13380 em escuta tanto no WSL quanto no Windows: atraso de encaminhamento é hipótese compatível, não causa definitivamente demonstrada.
- Sintaxe Node e shell aprovada. Não houve teste SMTP/TLS externo, envio real ou alteração do banco principal.

## Recursos preservados após a falha

O executor interrompeu sem retry ou descarte, conforme instruído:

- MariaDB: `ist-r2-mariadb10339`, id `021c657da1155a16fc65dced5540bc0128cb7711c3c44ae416530d2d7e35b002`.
- Volume: `ist-r2-mariadb10339-data`.
- Nginx: `ist-d73b1-nginx`, id `b4d0063bbb9cbefdd911e47f718a71705ed2d19f1ff57c7bd0cd698310e20aea`.
- Diretório temporário: `/home/ist_user/.local/state/ist-r2-mariadb10339`, incluindo segredos exclusivos que não devem ser enviados ao chat ou versionados.
- Portas limitadas ao loopback: 13339 e 13380. Docker/containerd permanecem necessários aos recursos preservados; não foram encerrados após a falha.

Na ocasião da falha, a retomada e o descarte ficaram pendentes de autorização. Essa autorização foi concedida na D7.3-B1-F1, concluída abaixo. Os recursos listados acima não permanecem ativos.

## D7.3-B1-F1 — conclusão HTTP e descarte

Somente os executores `scripts/loja-d73b1-validar-nginx.mjs` e `scripts/loja-d73b1-homologar-mariadb10339-wsl.sh` foram ajustados, além deste registro. Nenhuma configuração Nginx ou funcionalidade da aplicação foi alterada na F1.

O modo `--concluir-nginx` valida os IDs completos já registrados, imagens, label de execução comum, volume exclusivo, mounts, portas e diretório canônico com inventário fechado de quatro arquivos. Não executa SQL, não cria contêineres e não aceita recursos apenas por semelhança de nome.

Prontidão: espera interna limitada a 30 segundos; depois sondagem TCP e HTTP pelo Node Windows em 127.0.0.1:13380, com janela de 45 segundos, intervalo de um segundo e timeouts por operação. Falha gera diagnóstico de etapa sem conteúdo de resposta. Após a validação, bem-sucedida ou não, revalida identidades antes do descarte autorizado. A hipótese de atraso do encaminhamento localhost permanece compatível com a primeira falha, mas não foi provada como sua causa exclusiva.

Comando executado pelo usuário com sudo pessoal no WSL:

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-d73b1-homologar-mariadb10339-wsl.sh --concluir-nginx
```

Resultados efetivos fornecidos pelo executor:

- Identidades confirmadas antes da validação e novamente antes do descarte.
- `nginx -t`: aprovado. Prontidão Windows: TCP e HTTP 200 confirmados.
- `/loja/recuperar`, `/loja/recuperar/`, `/loja/biblioteca/confirmar` e sua variante com barra/query sintética: HTTP 200, `Cache-Control: private, no-store, max-age=0`, `Referrer-Policy: no-referrer`, sem ETag ou exposição de segredo em cabeçalhos; corpo igual ao index sintético.
- `/loja`, `/loja/biblioteca`, `/loja/biblioteca/recuperar` e `/editora`: HTTP 200 e fallback preservado, sem aplicar os cabeçalhos exclusivos da confirmação às demais páginas.
- Sondas `/istbrasil.private/products/livros/sonda-sintetica.pdf` e `/private/sonda-sintetica.pdf`: somente fallback HTML sintético, sem PDF. Isso não é uma afirmação de 404 nem nova homologação da autorização D6. O Nginx tinha apenas o arquivo de configuração montado, sem diretórios comerciais privados.
- `CODIGO_DE_SAIDA_HTTP=0`.
- Contêineres `ist-r2-mariadb10339` e `ist-d73b1-nginx`, volume `ist-r2-mariadb10339-data` e diretório `/home/ist_user/.local/state/ist-r2-mariadb10339` removidos após conferência de propriedade. Imagens Docker preservadas.
- Portas 13339/13380 livres no WSL, conforme executor; conferência posterior no Windows sem LISTEN nessas portas, apenas conexões TIME_WAIT sem processo proprietário.
- Conferência posterior: diretório temporário ausente; docker.service, docker.socket e containerd.service inativos. Backend preexistente segue na porta 3000, PID 23300; nenhuma instância Angular foi iniciada ou encerrada.

Limite da validação: o contêiner usa HTML sintético da imagem oficial para provar entrega do index e fallback SPA; não executa o runtime Angular, não usa build comercial e não valida TLS/CDN/hosting efetivo. Nenhum teste SQL foi repetido na F1. Banco principal, PDFs, SMTP, serviços financeiros, .env e 14 arquivos protegidos permanecem preservados. Nenhum commit, push, deploy ou início de D8.
