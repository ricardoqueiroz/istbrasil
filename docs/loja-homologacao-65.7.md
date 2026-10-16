# Etapa 65.7 — Homologação integrada local

Commit local da Etapa 65.6: `4fad328372b882b5dc958cd2bc59d910387a1ce9`.

Resultado: fluxo local Express/cookies/CSRF/MariaDB comprovado, inclusive em
navegador pelo proxy Angular. Homologação integral permanece com pendências:
confiança de proxy em acesso direto de loopback, ausência do MariaDB 10.3.39 e
três falhas na regressão de módulos fora da Loja. Nenhuma arquitetura foi alterada.

## Ambiente efetivamente usado

- Windows; Node 20.19.6; Express e serviços reais da aplicação com dependências apontadas exclusivamente ao banco descartável.
- MariaDB 13.0.2, processo temporário em 127.0.0.1:50690, sem instalar/alterar serviço Windows.
- Banco novo com prefixo ist_loja_65_4_, dentro de datadir temporário validado antes de qualquer DDL/fixture.
- Express de teste em 127.0.0.1:50691, com trust proxy='loopback', igual ao server.js.
- Angular CLI do projeto em 127.0.0.1:50692. Proxy de teste somente em TEMP, apontando /api ao Express isolado.
- Chrome headless com perfil novo em TEMP e depuração limitada a loopback; controle por CDP usando ws já disponível na árvore de dependências. Nenhuma dependência adicionada.
- Segredo CSRF gerado com randomBytes somente em memória do processo de teste. Nenhum token, cookie, senha ou segredo foi impresso ou incluído no relatório.

O backend que já estava na porta 3000 não foi usado para testes nem interrompido
por esta etapa. A instância MariaDB recuperada e o banco istbrasil não foram
consultados/modificados. Os testes adicionais fora da Loja receberam DB_HOST
loopback/DB_PORT=9 e credenciais sintéticas somente no processo para impedir
qualquer conexão acidental ao banco recuperado. Integração legada externa dos
jurados foi explicitamente desabilitada no processo de teste.

## Fluxos comprovados

| Verificação | Resultado / evidência |
| --- | --- |
| Catálogo público real | GET categorias e produtos com serviços reais e banco isolado: duas categorias, dois produtos a 9500 centavos |
| Bootstrap | POST sessao com Origin permitido: 201, cookie HttpOnly e CSRF no cabeçalho |
| Reutilização | Mesmo cookie: 200, mesma expiração e CSRF; sem Set-Cookie novo |
| Pedido | Cookie/CSRF/chave válidos: 201; total de 19000 centavos |
| Replay | Mesma chave/payload: 200 e mesma resposta pública |
| Conflito | Mesma chave e seleção divergente: 409 |
| Navegador | fetch('/api/...') via proxy Angular, cookie enviado automaticamente; document.cookie não lê o cookie de sessão; 201/200/409 confirmados |
| Persistência | Hash binário da sessão encontrado; pedido vinculado à sessão correta; dois itens; COUNT/SUM igual ao total persistido; CRIADO/versão 1 |
| Falhas | Falha no segundo item e conexão perdida: nenhum pedido parcial; COMMIT incerto com e sem persistência e replay posterior continuam aprovados |
| Revalidação | Sessão revogada após middleware: rejeitada dentro da transação, sem pedido |
| Resposta pública | Sem identificação interna de sessão, hashes, referências PDF, e-mail ou dados de pagamento |

O navegador abriu uma URL de catálogo JSON na origem Angular e executou as
chamadas pelo proxy real de desenvolvimento. Isso comprova cookies e mesma
origem; não constitui homologação visual de checkout e não criou interface nova.

## Cookies, CSRF e proteção HTTP

No navegador HTTP local: cookie ist-loja-dev, HttpOnly, SameSite=Lax, Path=/,
Secure=false. Cabeçalho Set-Cookie sem Domain. No conjunto HTTP anterior, a
configuração de produção continua testada com __Host-ist-loja e Secure=true;
não foi executado navegador contra produção/HTTPS nesta etapa.

Origin inválido, CSRF inválido, ausência de cookie e de cabeçalho próprio foram
rejeitados nos testes reais sem criar pedido. Valores financeiros no corpo foram
rejeitados. Cache-Control: no-store foi confirmado no sucesso e nas rejeições,
inclusive 429. Cadastro não é exigido; criação não prova posse de e-mail e não
autoriza pagamento/download.

## Rate limit e IP — ressalva confirmada

O limite de pedidos continua 20/minuto/IP, além do limite global da Loja.
O teste reproduziu a cadeia equivalente ao Nginx do repositório:

`X-Forwarded-For: <valor fornecido pelo cliente>, <IP real anexado pelo proxy>`

Mantendo o IP real fixo e variando o valor à esquerda e X-Real-IP, as vinte
primeiras tentativas inválidas retornaram 403 e a 21ª retornou 429. Portanto,
nessa cadeia, o contador não é fragmentado pelo valor forjado à esquerda.

Entretanto, server.js confia em loopback. Em chamada DIRETA ao backend a partir
de loopback, um X-Forwarded-For único é aceito como req.ip. O diagnóstico variou
esse valor em 21 chamadas e todas retornaram 403, sem atingir 429: bypass local
do contador confirmado. O teste registra o risco existente, não uma garantia de
segurança aprovada. Não demonstrou bypass remoto pela cadeia Nginx.

Nenhum ajuste de trust proxy, CORS, listener ou Nginx foi feito. Antes de declarar
a identificação de IP plenamente homologada, aprovar e validar o perímetro de
acesso ao backend e quais conexões podem representar um proxy confiável. O
limitador também continua em memória por processo, sem coordenação distribuída.

## Angular e proxy

angular.json usa proxy.conf.json no dev-server. O arquivo existente encaminha
/api a http://localhost:3000; production environment usa apiUrl='/api'.
O environment de desenvolvimento e o serviço Angular atual usam URL absoluta
http://localhost:3000/api. Assim, a viabilidade de chamadas relativas foi
comprovada, mas a integração Angular existente ainda não foi convertida para
same-origin. Nenhum desses arquivos nem a Editora foi alterado.

Para o ensaio, o CLI recebeu --proxy-config apontando a um arquivo temporário,
com a mesma rota /api e alvo na porta isolada 50691. O backend existente em 3000
não recebeu chamadas do ensaio. Não foi carregada a SPA para realizar checkout;
o documento JSON do catálogo mantém a origem Angular e evita inicializações de
módulos legados durante o teste.

## MariaDB 10.3.39

Não localizada instalação/binário/container local dessa versão. Program Files,
PATH, pacotes Chocolatey e Downloads consultados disponibilizam somente 13.0.2.
Docker/Podman não encontrados. Não houve download, instalação ou alteração de
serviços Windows. Execução real e homologação em 10.3.39 permanecem pendentes.

Compatibilidade analisada nas etapas anteriores não equivale à compatibilidade
testada: os testes desta etapa executaram MariaDB 13.0.2, inclusive DDL das
migrations aplicado apenas no servidor descartável.

## Testes executados

- Loja: 425 testes sem MariaDB real aprovados, zero falhas.
- Integração isolada: 27 cenários aprovados, incluindo cinco novos; Node contabiliza 28 testes com o grupo pai. Inclui o teste real no Chrome.
- Backend completo (26 arquivos .test.js): 1603 testes contabilizados, 1583 aprovados, 3 falhas e 17 ignorados de integração legada externa não habilitada. As falhas não estão na Loja.
- Reexecução apenas dos dois módulos com falha: 73 testes, 70 aprovados e as mesmas 3 falhas. Esses módulos não importam o fluxo de pedidos da Loja e não foram modificados.
- Sintaxe Node do teste modificado e git diff --check aprovados.

Falhas fora do escopo, preservadas sem alterações:

1. adminUsuariosApi.test.js:227, "cadeia administrativa válida alcança a etapa seguinte": 401 em vez de 200.
2. adminUsuariosApi.test.js:238, "tipo administrativo no JWT não prevalece sobre o tipo atual no banco": 401 em vez de 403.
3. festivalParticipation.test.js:132, "schema versionado identifica participação por PK e usuário/evento": ENOENT do arquivo database/istbrasil_table_ist_concorrentes.sql, ausente no workspace/HEAD.

O primeiro lançamento do Chrome no sandbox falhou por acesso negado em
subprocessos gráficos. O ensaio foi repetido com execução autorizada fora desse
sandbox, mantendo perfil temporário e navegação exclusivamente local; passou.
Essa falha de infraestrutura não foi ocultada nem resolvida alterando testes.

## Arquivos e limpeza

Modificado somente tests/lojaPedidoService.integration.test.js: fixture mínima
de livros acrescida dos campos públicos necessários à consulta real, injeção do
catálogo real, configuração de trust proxy equivalente à aplicação e cinco
cenários adicionais, incluindo diagnóstico do risco e navegador opcional.
Criado este relatório. Nenhum código de aplicação/arquitetura foi alterado.

Todos os processos temporários criados nesta etapa foram encerrados; datadir,
proxy e os dois perfis Chrome foram removidos após validar os caminhos e PIDs.
O backend preexistente na porta 3000 permaneceu disponível. Não houve alteração
de serviços Windows. npm-audit-local.json permanece não rastreado.

Produção, banco recuperado, migrations, .env, CORS global, Angular, Editora,
PayPal e downloads permaneceram intactos. Sem commit adicional, push ou deploy.
Aguardar autorização para tratar as pendências ou avançar.

## Conferência da retomada — 16/10/2026

Após a interrupção por créditos, foram conferidos novamente o commit, o status
do Git, a sintaxe Node e git diff --check. Os 425 testes da Loja foram
reexecutados: todos aprovados, zero falhas. Nenhum código de aplicação foi
alterado na retomada.

As evidências anteriores de MariaDB/Chrome e da regressão completa permanecem
as registradas acima; esses ensaios não foram repetidos na retomada. Confirmada
a ausência dos três diretórios temporários e de listeners nas portas usadas.
Nenhuma tarefa de execução/limpeza ficou pendente; faltava a entrega final.
As ressalvas de segurança, regressão legada e MariaDB 10.3.39 continuam abertas.
