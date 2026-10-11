# Módulo público de projetos

Implementado para homologação local, sem deploy, sem alterações de dados ou schema e sem novas dependências.

## Arquivos

Criados nesta tarefa:
- `src/routes/projetos.routes.js`
- `src/routes/projetos.routes.test.js`
- `src/app/pages/projetos/projeto-apresentacao.ts`
- `src/app/pages/projetos/projeto-detalhe/projeto-detalhe.component.ts`
- `src/app/pages/projetos/projeto-detalhe/projeto-detalhe.component.html`
- `src/app/pages/projetos/projetos.component.spec.ts`
- `docs/projetos-implementacao.md`
- `docs/projetos-banco-recomendacoes.md`

Modificados: `server.js`, `src/app.routes.ts`, `src/controllers/projetosController.js`, `src/app/models/projeto.model.ts`, `src/app/pages/projetos/projetos.component.ts`, `src/app/pages/projetos/projetos.component.html`, `src/app/layout/component/app.menu.ts` e o destino do link Camerata em `src/app/pages/landing/components/highlightswidget.ts`. O CSS existente de projetos foi reutilizado. Alterações anteriores do usuário foram preservadas. Alguns arquivos existentes de projetos estavam sem rastreamento no Git antes desta tarefa.

## Rotas e contrato

- `GET /api/projetos`: array de projetos não cancelados, com classificações coerentes, ordenado por destaque DESC, data de início DESC e ID DESC.
- `GET /api/projetos/:slug`: objeto completo com `documentos`, ordenados por ordem ASC e ID ASC. Slug inválido retorna 400, inexistente/cancelado retorna 404, falha ou duplicidade retorna 500 sem detalhes internos.
- Angular: `/projetos` e `/projetos/:slug`, ambas sob demanda, com cabeçalho e rodapé públicos próprios.
- IDs numéricos; `tipicidade` e `tipologia` strings; `destaque` boolean; DATETIME como string civil `YYYY-MM-DD HH:mm:ss`, sem conversão para UTC; campos SQL nulos continuam `null`. Os campos opcionais do modelo também podem estar ausentes. Documentos recebem datas no mesmo formato.
- Resumo tem tags e scripts removidos com `sanitize-html`, já instalado; os cards usam interpolação. Descrição detalhada usa `[innerHTML]` com sanitização Angular, sem bypass. CTA e imagens usam a validação de URLs já existente em eventos; documentos aceitam caminhos com acentos codificados.
- O link Camerata leva à listagem porque não há projeto correspondente no banco; não foi criado registro fictício. O menu recebeu acesso a Projetos.

## Validação

- Sintaxe Node do controller, router e servidor: aprovada.
- Teste HTTP do router Express com pool simulado: aprovado, incluindo listagem, detalhe, ordenação, parametrização, slug inválido, 404, erro interno e duplicidade.
- Consulta somente de leitura do banco: sem slugs duplicados, sem combinações inválidas de classificações e sem registro `camerata`; não há índice único de slug.
- Smoke test do controller com o banco configurado: listagem 200 com um projeto e detalhe 200 de `novo_museu_em_santarem` com um documento.
- Compilação de produção: aprovada, com avisos CommonJS de `page-flip` e `quill-delta`, fora do módulo. Saída isolada em `.tmp/projetos-build`, sem publicação.
- Testes Angular específicos em ChromeHeadless: 5 aprovados (carregamento/erro/nova tentativa/vazio, links dos cards, sanitização e CTA, distinção 404/500, validação de URLs). A primeira execução detectou dois identificadores incorretos no template, corrigidos antes da execução final aprovada. Houve aviso esperado de sanitização e 404 de imagens no Karma, cujo builder não copia `src/assets`; a compilação de produção copia esses assets normalmente.

## Arquivos e homologação

Não encontrados localmente:
- `src/assets/images/projetos/novo-museu-card.jpg`, destino público `/assets/images/projetos/novo-museu-card.jpg`.
- `src/assets/images/projetos/novo-museu-capa.jpg`, destino público `/assets/images/projetos/novo-museu-capa.jpg`.
- `uploads/documentos/Novo_Museu_de_Santarém.pdf`, destino público `/uploads/documentos/Novo_Museu_de_Santarém.pdf`.

As imagens usam o fallback existente `/assets/images/eventos/default-event.jpg`. A validade sintática de um link não confirma a existência remota do PDF; é necessário disponibilizar o arquivo real ou revisar seu cadastro antes de publicar.

Angular copia `src/assets` para `assets`. Express não registra `/uploads`; o `nginx.conf` local serve arquivos sob `/var/www/istbrasil.org.br/html` e usa fallback para `index.html`, sem um bloco específico de uploads. Não foi possível confirmar a configuração ativa do servidor remoto. Não houve alteração de infraestrutura.

Validar manualmente desktop/tablet/celular, foco e navegação por teclado, imagens, documento real, CTA e atualização/acesso direto à URL no servidor de homologação. Links nativos e grids responsivos foram implementados; não foi executada inspeção visual interativa. Revisar o mapeamento de `/uploads/`, pois um caminho inexistente pode devolver o HTML da aplicação pelo fallback Nginx.

Recomendações de schema constam no relatório separado `docs/projetos-banco-recomendacoes.md`; não foram executadas.
