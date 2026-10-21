# D7.2-B1 — Biblioteca digital Angular

## Interface e contratos

- `/loja/biblioteca`: uma biblioteca para a autoridade escolhida pelo backend B3. Lista até 50 direitos por página, com cursor, atualização manual e estados acessíveis.
- `/loja/biblioteca/recuperar`: formulário de e-mail com mensagem uniforme. Não consulta existência de compras no frontend.
- `/loja/biblioteca/confirmar` e `/loja/recuperar`: confirmação explícita, com o mesmo componente. A segunda rota preserva os links já produzidos pelo adaptador B2.
- A confirmação fica fora de AppLayout, evitando imagens de perfil e outros recursos do layout. O bootstrap síncrono no head retira fragmento e query antes do Angular e não carrega a fonte externa nesta página. O desafio fica em memória, com retirada única; não é persistido em storage nem em cookies JavaScript.
- O navegador recebe apenas os DTOs públicos D6. O backend continua decidindo escopo, autoridade, evidência financeira e autorização final. A interface não ativa direitos ao listar.
- Reavaliação manual usa o CSRF B2 quando a sessão recuperada está autenticada. Para compra, obtém o CSRF da sessão original pela interface LojaService existente. Não tenta outra autoridade após erro e não implementa retries.
- Revogação chama somente o endpoint de recuperação. Não encerra a sessão de compra.
- Downloads usam GET autenticado e Blob PDF. A URL de objeto é temporária, removida após um segundo ou ao destruir a página. Nenhum PDF ou link é persistido pela aplicação. Uma operação por vez na página, sem contornar limites do servidor.

## Exceção backend autorizada

Foi autorizada separadamente a correção pontual de GET B2 `/sessao`: sem Origin, aceita apenas `Sec-Fetch-Site: same-origin` e a origem efetiva Host/protocolo presente na configuração confiável. Continua exigindo X-IST-Loja e rejeitando query. POST e preflight continuam exigindo Origin; CSRF e demais proteções permanecem. Não altera serviços D5/D6/B1 nem regras financeiras.

Em implantação atrás de proxy, Host/protocolo precisam refletir corretamente a origem pública configurada. Divergência falha fechada. O cliente não tenta forjar Origin.

## Validação executada

```powershell
node node_modules/typescript/bin/tsc --project tsconfig.spec.json --noEmit
node node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadless --reporters=dots --include='src/app/pages/loja/**/*.spec.ts' --include='src/app/pages/editora/**/*.spec.ts' --include='src/app/services/loja*.spec.ts' --include='src/app/services/carrinho*.spec.ts'
node --test tests/lojaBibliotecaNavegador.test.js tests/lojaDownloadRecuperacaoHttp.test.js
node node_modules/@angular/cli/bin/ng.js build --configuration production
node --check src/routes/lojaDownloadRecuperacao.routes.js
node --check src/assets/loja-recuperacao-bootstrap.js
git diff --check
```

Resultados finais: 232 testes Angular aprovados (42 novos), zero falhas e zero ignorados. Node: sete aprovados, zero falhas, um grupo MariaDB excluído; nenhum banco foi acessado. TypeScript, sintaxe e build de produção aprovados. Build conserva avisos CommonJS de page-flip e quill-delta; Karma apresentou imagens ausentes de fixtures antigas.

A primeira tentativa de ChromeHeadless foi bloqueada pelo ambiente restrito, antes dos testes. Fora do sandbox, uma falha nova de acessibilidade foi corrigida com aria-label explícito. O teste de Host forjado utiliza HTTP nativo porque fetch não transmitiu esse cabeçalho. Os resultados acima correspondem às execuções finais após esses ajustes.

## Limitações e próxima revisão

- Não houve validação visual/manual, SMTP real ou recuperação de compra real. A entrega é homologada com mocks HTTP e dados sintéticos.
- O meta Cache-Control da confirmação não substitui o cabeçalho HTTP `Cache-Control: no-store` do documento HTML. O servidor que publica Angular deverá configurar esse cabeçalho para as duas rotas de confirmação e manter Referrer-Policy apropriada. Esta tarefa não alterou hosting ou configuração de servidores. As APIs já respondem no-store.
- Após a URL limpa, a biblioteca usa referrer same-origin para a leitura D6, que já aceita Referer confiável quando Origin não está presente. O segredo não participa desse Referer.
- Em uma navegação interna SPA, o componente também remove o fragmento e query, cobrindo a alternativa ao bootstrap inicial. Remover a URL não elimina cópias anteriores do link no e-mail, extensões ou histórico externo ao documento.
- Nenhuma migration aplicada, nenhuma ativação SMTP e nenhum acesso a PDFs comerciais. Backend preexistente e arquivos protegidos preservados, salvo a exceção GET expressamente autorizada. Nenhum commit, push ou deploy.
