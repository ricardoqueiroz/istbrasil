# D7.4-A — Homologação integrada local da recuperação

## Parecer

**D7 homologada localmente no escopo sintético autorizado**, após correção pontual do submit aprovada pelo usuário. Não habilita SMTP real, produção, pagamentos externos ou D8. Não houve avaliação visual manual; a interface real foi exercitada automaticamente por Chrome/CDP.

## Arquivos desta etapa

- `src/app/pages/loja/loja-recuperacao.component.ts`: única alteração de produção autorizada, uma linha do formulário.
- `src/app/pages/loja/loja-recuperacao.formulario-integrado.spec.ts`: regressão do evento submit HTML.
- `tests/fixtures/lojaDownloadPercursoFixture.js`: parâmetros opcionais de host, porta, origens, relógio e composição do app para reutilizar a compra real sintética da D6. Comportamento padrão preservado e revalidado.
- `tests/fixtures/lojaNavegadorCdp.js`: Chrome existente, perfil/contextos descartáveis, bloqueio de requisições externas e download em diretório temporário.
- `tests/lojaRecuperacaoAngularReal.integration.test.js`: percurso integrado com SQL real, serviços existentes, Angular real e SMTP simulado.
- `scripts/loja-d74a-nginx-config.mjs`: configuração descartável com os blocos de confirmação versionados, build real somente leitura e proxy exclusivo para o backend sintético.
- `scripts/loja-d74a-homologar-wsl.sh`: rodadas separadas 13/10339, identificação, preparação e descarte exclusivo, sem remover imagens.
- Este relatório.

## Falha encontrada e correção autorizada

A primeira rodada 13 chegou ao formulário Angular real, mas não exibiu a mensagem após clicar em enviar: dois testes aprovados e dois falhos (incluindo o teste pai), exit 1. O ambiente foi removido.

Inspeção identificou `<form (ngSubmit)="solicitar()">` com apenas ReactiveFormsModule e sem `[formGroup]`. Nesse contexto, não há diretiva Angular no form emitindo ngSubmit. O teste novo disparou submit HTML e confirmou que a API não era chamada e o comportamento nativo não era impedido (um teste falho, exit 1). Os testes anteriores chamavam diretamente o método e não cobriam esse evento.

O usuário autorizou expressamente trocar somente essa linha por:

```html
<form (submit)="$event.preventDefault(); solicitar()">
```

A regressão passou após a correção. Nenhum contrato HTTP, serviço financeiro, autorização, cookie, CSRF ou estado comercial foi alterado. Não houve repetição automática da rodada falha: a retomada foi autorizada e executada com sudo pessoal pelo usuário.

## Ambiente integrado

- Node 20.19.6 no Windows; Chrome existente automatizado por CDP via ws já instalada. Sem Playwright/Puppeteer ou dependências novas.
- Angular compilado em produção, sem substituições de componentes. `index.html` final SHA-256: `9c130dae11752f1a7d4e57c0a2ae0e822f9c52ad05d70f548eef31564376f04e`.
- Nginx da imagem oficial fixada em `sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5`, frontend em `https://localhost:13381`.
- TLS com certificado sintético temporário. A exceção de certificado ficou restrita ao Chrome de teste e ao cliente HTTPS de loopback do teste; nenhuma CA ou configuração global foi alterada.
- Backend sintético em 13382 na interface virtual Windows/WSL, separado do backend existente em 3000. Sem dotenv ou pool padrão da aplicação. O trust proxy do app sintético vale apenas nessa composição de teste; não altera server.js.
- MariaDB 13.0.2 criado/removido pela fixture Windows; MariaDB 10.3.39 usa imagem fixada `sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102`, volume e credencial próprios.
- Transporte Nodemailer simulado injetado pelo mailService/composição D7.3. Nenhuma conexão SMTP ou chamada PayPal externa. Credenciais, e-mails e PDF exclusivamente sintéticos.
- Nginx monta apenas build público, configuração e certificado/chave de teste; nenhum diretório comercial privado. O PDF fica fora do build e é servido somente pela D6.

## Percurso efetivamente executado nas duas versões

1. Publicação sintética pela interface existente; sessão convidada, pedido, snapshot e direito persistidos pelos serviços reais.
2. Uma captura pelo provedor simulado, com evidência suficiente; o direito continua aguardando confirmação.
3. Sessão original revogada no banco descartável para simular indisponibilidade.
4. Formulário Angular envia a solicitação e apresenta mensagem uniforme; SMTP simulado captura o link HTTPS com segredo no fragmento.
5. Outro contexto de navegador abre o link. Fragmento/query são retirados, não há POST validar automático, recursos externos são bloqueados e a página de confirmação não solicita terceiros.
6. Clique explícito confirma, emite sessão recuperada e navega à biblioteca real.
7. A biblioteca lista somente o direito adquirido. Compra posterior não amplia o escopo; tentativa de baixar seu direito retorna 404 sem PDF.
8. Reavaliação manual com CSRF ativa o direito. O download Blob real gera um arquivo no diretório descartável do Chrome; bytes e SHA-256 são comparados ao PDF sintético original.
9. Revogação pela interface encerra somente a sessão recuperada. Novo download retorna 401 sem bytes PDF; recarregar a biblioteca exibe sessão inválida/expirada. O direito permanece ATIVO no banco, sem ser revogado por encerrar a sessão.

O armazenamento persistente do navegador é inspecionado para confirmar ausência do segredo. O token de sessão permanece HttpOnly sob responsabilidade do backend. Estados de carregamento são cobertos pelos testes Angular determinísticos; a mensagem de sucesso e o erro após revogação foram observados na interface real.

## Resultados e exit codes

| Conjunto | Aprovados | Falhos | Ignorados | Exit |
|---|---:|---:|---:|---:|
| Angular pertinente inicial | 50 | 0 | 0 | 0 |
| Regressões SQL D6/B2/B3 em 13.0.2 | 42 | 0 | 0 | 0 |
| SMTP/configuração operacional simulada | 30 | 0 | 0 | 0 |
| Primeira integração 13, antes da correção | 2 | 2 | 0 | 1 |
| Regressão isolada submit, antes da correção | 0 | 1 | 0 | 1 |
| Angular focado após correção, incluindo submit | 28 | 0 | 0 | 0 |
| Integração final Angular/Nginx/13.0.2 | 8 | 0 | 0 | 0 |
| Integração final Angular/Nginx/10.3.39 | 8 | 0 | 0 | 0 |

As contagens não devem ser somadas como testes distintos: há reexecuções e os testes Node incluem os pais. Build de produção final, TypeScript, sintaxe Node/shell e git diff --check aprovados. Avisos CommonJS preexistentes de page-flip e quill-delta permanecem.

Rodada 13 final: `13.0.2-MariaDB`, schema `ist_loja_67_3_7421b917cf06`, porta 56231. Nginx `12d81a03c2a484e0f4aab48951d4cb83efdba2b7dea0773997370d80008ef907`. O executor registrou D74_PDF, D74_ANGULAR_REAL, D74_EXIT_CODE=0 e descarte com resultado=0.

Rodada 10.3 final: `10.3.39-MariaDB-1:10.3.39+maria~ubu2004`, schema `ist_loja_67_3_8272819364f1`, porta interna 3306 / externa 13339. Autenticação correta aceita e incorreta rejeitada antes do SQL. Nginx `c7ba14c721d36a64357eb3b3110a5c62ad21e798a845425de009c1a6b713a811`. O executor registrou os mesmos marcadores e exit 0. Ambas as saídas foram fornecidas pelo usuário após execução com sudo pessoal.

## Segurança: cobertura reutilizada

As 42 regressões reais de D6/B2/B3 cobrem token inválido, expirado, replay, consumo concorrente, sessão revogada, outro comprador, compra posterior, cookies simultâneos/duplicados, CSRF inválido, Origin não autorizado, resposta uniforme, rate limits, PDF adulterado, evidência financeira insuficiente, revogação durante preparação e ausência de bytes PDF nas negativas. Não foi duplicada essa matriz inteira na automação visual: o novo percurso confirma a ligação dos componentes reais nas duas versões. A matriz completa de segurança foi reexecutada nesta etapa no MariaDB 13; a rodada 10.3 nova executou o percurso integrado, sem repetir toda a matriz histórica.

Nginx real: ambas as rotas de confirmação retornam HTTP 200 com `Cache-Control: private, no-store, max-age=0` e `Referrer-Policy: no-referrer`, entregando HTML com app-root e bootstrap real. As rotas `/loja`, `/loja/biblioteca`, `/loja/biblioteca/recuperar` e `/editora` mantêm fallback SPA. A sonda comercial privada retorna somente HTML público de fallback, não PDF; isso não equivale a afirmar que a URL é 404. Cache de APIs sensíveis continua controlado pelos headers D6/B2 validados nas regressões; o Nginx descartável não habilita proxy_cache.

## Descarte e preservação

Ambas as rodadas finais e a primeira rodada falha foram descartadas pelo executor. Perfis/contextos Chrome, downloads, PDF e datadirs Windows foram removidos pela fixture. Nginx, MariaDB 10.3, volume e segredos associados foram removidos após conferência das labels/IDs próprios. Imagens Docker compartilhadas foram preservadas; nenhum prune foi executado.

Conferência posterior: diretórios `/home/ist_user/.local/state/ist-d74a-13` e `/home/ist_user/.local/state/ist-r2-mariadb10339` ausentes; Docker/containerd inativos. Sem listeners nas portas temporárias 13339/13381/13382; conexões TIME_WAIT restantes não possuem processos servidores. Backend preexistente continua na porta 3000 com PID 23300; nenhuma instância Angular preexistente foi reiniciada ou encerrada.

Banco principal não foi utilizado. Migrations, PDFs comerciais, .env, núcleo financeiro, SMTP real e 14 arquivos protegidos não foram alterados. As 57 outras pendências anteriores tiveram seus SHA-256 preservados; a exceção foi o componente de recuperação cuja única linha foi autorizada. Sem staging, commit, push, deploy ou início de D8.

## Comandos reproduzíveis

```powershell
node node_modules/@angular/cli/bin/ng.js build --configuration production
node node_modules/typescript/bin/tsc --project tsconfig.spec.json --noEmit
```

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-d74a-homologar-wsl.sh 13
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-d74a-homologar-wsl.sh 10339
```

Não executar novas rodadas sem necessidade: as evidências finais acima já foram obtidas. SMTP/entregabilidade real, certificados/hosting de produção e publicação continuam fora desta homologação.
