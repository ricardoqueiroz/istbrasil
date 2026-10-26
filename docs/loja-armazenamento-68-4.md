# Armazenamento oficial de livros — Etapa 68.4

## Correções D2 — ativação e recuperação

O contrato `CONTRATO_ARMAZENAMENTO` versão 1 é exportado pelo validador da aplicação.
O executor importa esse módulo da release selecionada em subprocesso Node limitado
a dez segundos, com ambiente limpo e o .env persistente passado explicitamente.
Não importa server.js/db.js, não abre HTTP, não executa SQL ou migrations e não
prepara diretórios. Saídas arbitrárias do subprocesso não são propagadas.

Antes de trocar PM2, o executor verifica o alvo atual de recuperação e depois a
candidata instalada (ou a release restaurada do backup no rollback). Falha deixa
o processo atual intacto, sem invocar switchTo. O backup precisa declarar o mesmo
contrato; idade, commit e health check da página inicial não substituem essa prova.
Um alvo histórico incompatível é recusado, sem aliases nem restauração de .env.
Se o runtime atual não fornecer um alvo de recuperação compatível, a implantação
automática também é recusada; planejar essa transição antes de autorizar deploy.

O layout público conhecido é compartilhado em src/config/lojaImplantacao.js e
canonicalPaths do deploy: html, backend-php e o alvo público phpMyAdmin no Linux.
A área .deploy é descartável e proibida para armazenamento. O mesmo validador
usado no startup aplica esses limites, inclusive quando ficam fora da candidata;
o preflight passa os limites do base selecionado. Não há descoberta automática
da configuração Nginx. Mudanças de layout precisam atualizar esse contrato.

Testes Windows verificam o subprocesso real do validador e o gate de ativação
com callbacks simulados. Os testes do executor completo em Linux continuam
obrigatórios; aprovação local não autoriza deploy nem preparação do VPS.

Este contrato substitui os nomes e comportamentos de configuração descritos nas
fases históricas D6/B1. Não houve implantação ou migração de arquivos nesta etapa.

## Fonte e valores

O backend lê somente `PRODUCTS_LIVROS_PATH` e `CAPAS_LIVROS_STORAGE_PATH` do `.env`
ao lado de server.js (na release, o vínculo .env persistente já existente).
`DOTENV_CONFIG_PATH`, se definido, precisa ser absoluto e identifica explicitamente
outro arquivo dotenv, inclusive o arquivo sintético utilizado pelos testes.
O carregador substitui somente essas duas chaves no ambiente do processo. Não
altera a precedência das demais configurações. Valores herdados do PM2 não
prevalecem sobre os dois valores do arquivo; ausência no arquivo impede startup,
mesmo quando o ambiente herdado contém valores ou nomes antigos.

Valores aprovados para Windows:

```dotenv
PRODUCTS_LIVROS_PATH=C:/inetpub/wwwroot/istbrasil.org.br/istbrasil.private/products/livros
CAPAS_LIVROS_STORAGE_PATH=C:/inetpub/wwwroot/istbrasil.org.br/uploads/livros
```

Valores aprovados para VPS:

```dotenv
PRODUCTS_LIVROS_PATH=/var/www/istbrasil.org.br/backend-node/istbrasil/istbrasil.private/products/livros
CAPAS_LIVROS_STORAGE_PATH=/var/www/istbrasil.org.br/uploads/livros
```

Não há resolução de caminhos relativos, base por cwd ou fallback para
`PRODUCTS_PATH` / `CAPAS_LIVROS_PATH`. Não se atualizam os .env reais automaticamente.
Os diretórios devem existir, ser acessíveis para leitura/escrita e travessia,
sem links inseguros, sem sobreposição público/privado. Arquivos privados continuam
confinados e sujeitos à autorização D6. Falhas interrompem a inicialização antes
de listen, com nome da variável, sem revelar seu valor ou detalhes do filesystem.
As verificações de caminho também permanecem no uso do armazenamento.

## Capas e transição

Upload grava exclusivamente no destino persistente, usando validação de imagem,
UUID e criação exclusiva. A URL pública permanece `/assets/images/livros/`, sem
variável específica de URL. A entrega consulta o destino persistente primeiro;
quando o arquivo está ausente, pode ler as capas legadas da release. Configuração
inválida não autoriza fallback; nunca há novos uploads em src/assets.

O PM2 não injeta mais os caminhos de armazenamento. Deploy e rollback não criam,
copiam, removem, sobrescrevem ou restauram uploads/livros. O exportador mantém
uploads fora da release. Nginx mantém o location específico que encaminha a URI
das capas ao Node, sem publicar diretórios privados ou depender de rebuild Angular.

## Pré-requisitos obrigatórios do VPS — executar somente com autorização futura

O usuário informou que uploads existe e contém documentos, mas uploads/livros
ainda não existe. O novo backend NÃO pode ser ativado antes desta preparação.

1. Confirmar PM2 como admin, caminhos canônicos, proprietário e ausência de links.
   Fazer backup separado do .env e das cinco capas existentes, sem divulgá-los.
2. Criar somente o subdiretório uploads/livros como usuário operacional autorizado,
   sem mudar uploads/documentos. Exemplo proposto, NÃO executado:

   ```bash
   sudo install -d -m 0700 -o admin -g admin /var/www/istbrasil.org.br/uploads/livros
   ```

3. Validar os dois diretórios, permissões efetivas do usuário PM2 e variáveis no
   .env persistente. Verificar ausência de DOTENV_CONFIG_PATH divergente, sem
   publicar conteúdo ou segredos. O diretório de PDFs não deve ser alterado.
4. Inventariar as cinco capas em backend-node/istbrasil/src/assets/images/livros:
   nome seguro, tamanho, formato e SHA-256. Copiar para o destino apenas arquivos
   ausentes, com criação exclusiva. Mesmo nome e bytes iguais: não duplicar.
   Mesmo nome e conteúdo divergente: parar para decisão humana; nunca sobrescrever.
5. Comparar hashes e preservar todos os originais. Nenhuma alteração no banco.
6. Somente depois autorizar a ativação da release, conferir inicialização e URLs.
   Não ativar notificações nem executar compra/SMTP como parte dessa preparação.

## Rollback

Rollback de código não restaura nem limpa os diretórios persistentes, nem altera
o .env. Selecionar release já compatível com as variáveis oficiais e o contrato
de armazenamento; validar isso antes do deploy. Um backup anterior pode conter
código que exige nomes antigos ou valores injetados pelo PM2. Não presumir que um
health check HTTP simples detecte essa incompatibilidade.

Para voltar a código incompatível, interromper o procedimento padrão e preparar
plano operacional específico autorizado, incluindo a configuração correspondente.
Não introduzir aliases antigos automaticamente, não reescrever o .env durante
rollback e não copiar uploads de volta para uma release antiga. Backup/restauração
dos dados persistentes permanece operação separada da recuperação de código.

## Arquivos da normalização

- Inicialização/configuração: `server.js`, `src/config/lojaArmazenamento.js`
  e `src/config/lojaArmazenamentoInicial.js` (dois módulos novos).
- Consumidores: `src/services/lojaCapaService.js`, `src/routes/lojaAdmin.routes.js`
  e `src/routes/lojaDownloads.routes.js`.
- Operação: `scripts/deploy/production-operation.mjs` e
  `scripts/deploy/production-inspect.mjs`.
- Testes: `tests/lojaArmazenamento.test.js` e
  `tests/fixtures/lojaArmazenamentoSintetico.js` (novos),
  `tests/lojaCapasPersistentes.test.js`, `tests/lojaAdminLivrosHttp.test.js`,
  `tests/lojaAdminLivroPatchHttp.test.js`, `tests/serverComposicao.test.js`,
  `tests/fixtures/lojaDownloadsHttpFixture.js`,
  `tests/lojaDownloadAutoridadeRecuperada.integration.test.js` e
  `tests/lojaPagamentoAdversoDireitos.integration.test.js`.
- Documentação: este documento novo, `docs/deploy.md`,
  `docs/loja-admin-fase1-contratos.md`, `docs/loja-capas-persistentes-68-4-b1.md`,
  `docs/loja-download-arquivo-d6-b2.md`, `docs/loja-downloads-http-d6-b3.md` e
  `docs/loja-downloads-raiz-privada-d6-b4-f1.md`.
