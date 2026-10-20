# D5.1-B1 — schema de downloads

## Escopo

Somente migration e homologacao relacional em instancias descartaveis. Nenhum
endpoint, publicador, arquivo fisico, concessor financeiro ou recuperacao por e-mail
foi implementado. Livros, produtos e relacionamento editorial permanecem separados.

## Estrutura

`migrations/ist_loja_downloads_fundacao.sql` cria:

- `ist_loja_arquivo_versoes`: identidade, produto, versao, caminho relativo,
  SHA-256 BINARY(32), tamanho seguro, MIME PDF, estado e datas de publicacao.
- `ist_loja_download_direitos`: item, produto, versao adquirida, estado, datas,
  motivo e versao otimista.
- `ist_loja_download_direito_eventos`: transicoes por direito/versao, origem,
  motivo e referencia interna do agente.

A unica alteracao existente e UNIQUE `(id, produto_id)` dos itens. A PK simples
nao oferece a mesma chave composta explicita. As duas FKs compostas do direito
impedem associar um item a versao de outro produto. Nao ha cascatas destrutivas.
O ambiente e derivado de direito -> item -> pedido; nao se duplica dinheiro,
e-mail, contexto PayPal ou estado financeiro.

UNIQUE `(produto_id, publicacao_atual)` admite multiplos NULL historicos e um
unico marcador 1 por produto. Retirada comercial nao invalida o direito antigo.
Nao foi mantido UNIQUE de caminho: produtos diferentes podem compartilhar
conteudo explicitamente aprovado. Nao ha indice logico adicional sem consulta
que o justifique. O publicador futuro deve preservar a coerencia da identidade
logica entre as versoes de um produto.

## Datas, versao e imutabilidade

Datas sao UTC DATETIME(3). `ativado_em`, `suspenso_em` e `revogado_em` representam
a ocorrencia mais recente de cada tipo. Reativacao conserva a ultima suspensao;
nova suspensao substitui sua data principal, mantendo todas as anteriores nos
eventos. Versao inicial 1 e evento inicial 1; cada transicao futura deve atualizar
com `WHERE id=? AND versao=?`, incrementar e inserir o evento na mesma transacao.
O UNIQUE de evento impede duplicacao, mas nao impede saltos, omissao de eventos
ou transicao indevida feita por SQL direto: estes controles pertencem ao servico.

Nao ha triggers. FKs/CHECKs nao garantem imutabilidade das colunas ou do PDF.
O servico futuro deve recusar mudanca de produto, identidade, caminho, SHA,
tamanho ou conteudo de versao registrada; novas edicoes exigem novos registros.
UUIDs precisam de geracao/validacao criptografica no servico; comprimento SQL
nao prova aleatoriedade. BINARY(32) tambem nao prova que o SHA corresponde ao PDF.

Caminhos sao internos, ASCII controlado, relativos, segmentos alfanumericos com
`_` e `-`, terminados em `.pdf`. URLs, drives, `%`, query, fragmento, barras
Windows, traversal e controles sao rejeitados. Confinamento por realpath e
protecao contra symlinks/junctions continuam sendo obrigacoes de D6.

## Limites financeiros

Criacao do schema nao cria qualquer versao ou direito. Nenhum direito historico
e inferido, inclusive para produto Sandbox. O banco permite montar fixtures de
direitos independentemente de pagamento: nao e uma autorizacao para entrega.
Ativacao, revalidacao de captura/valor/moeda/ambiente/recebedor, propriedade,
revogacao e tratamento de reversoes permanecem nas fases seguintes. Nao havera
consulta PayPal durante download. Recuperacao em outro navegador sera tratada
separadamente, sem tabelas antecipadas nesta migration.

## Execucao isolada

Windows, somente no processo do teste:

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN = 'C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/lojaDownloadsSchema.integration.test.js
```

A fixture existente inicializa 13.0.2 com autenticacao antes do TCP, porta
dinamica diferente de 3306/3307, datadir TEMP exclusivo e schema
`ist_loja_67_3_<12 hex>`. Ela nao importa configuracao de banco da aplicacao.

WSL, com sudo pessoal no terminal:

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-r2-homologar-mariadb10339-wsl.sh d51
```

O unico ajuste do executor existente e o seletor `d51`. Reutiliza imagem
10.3.39 fixada, autenticacao correta/incorreta, manifesto de identidade,
127.0.0.1:13339 externo, datadir /var/lib/mysql e schema exclusivo. Porta 3306
interna do container nao e o servidor Windows. Sucesso descarta container,
volume e segredos e encerra apenas os servicos Docker iniciados pelo executor;
falha preserva o ambiente para diagnostico, sem repeticao automatica.

Imagem: `sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102`.

## Cobertura

Uma mesma suite e executada nas duas versoes: preexistencia parcial/indice,
reaplicacao, preservacao de tabelas e historicos, tipos, datas, estados, caminhos,
FKs, UNIQUE, publicacao e rollback, corridas de publicacao/direitos em duas
conexoes, ciclo de suspensao/reativacao, controle otimista e restauracao logica
em segundo schema. A restauracao usa SHOW CREATE + dados sinteticos em memoria,
sem dump de dados reais e sem desativar FKs. Nao e ensaio de backup operacional
do banco principal. A suite cria dados, nao chama servicos ainda inexistentes.

Resultados finais devem ser registrados no relatorio da execucao, distinguindo
MariaDB 13.0.2 real de 10.3.39 real; revisao de SQL nao comprova execucao.

Execucao Windows desta etapa: 49 testes do schema aprovados; 801 aprovados ao
incluir as regressoes Node relacionadas, zero falhas e zero ignorados. Bootstrap,
datadir e encerramento foram comprovados pelas fixtures. Houve uma falha inicial
nos testes negativos de eventos por uma data sintetica invalida (`2026-01-99`),
corrigida no proprio teste antes da execucao final. Nenhum servico foi alterado.
Execucao WSL concluida pelo responsavel com sudo pessoal, usando o seletor
`d51`: o executor informou sucesso dos testes e descarte identificado do
container, volume e segredos, seguido de encerramento de Docker/containerd,
sem habilitar inicializacao automatica. A mesma suite de 49 testes foi
selecionada para MariaDB 10.3.39 pela imagem fixada e pela fixture que valida
VERSION(), hostname, porta, datadir e autenticacao antes de qualquer escrita.
A saida compartilhada foi o resumo final de sucesso, sem o detalhamento TAP
individual. Resultado aceito como execucao real reportada pelo responsavel,
nao como nova execucao feita pelo agente. Homologacao isolada B1 concluida;
aplicacao ao principal continua proibida ate aprovacao especifica da B2.

## Seguranca da migration e futura B2

Na versao B1, recusava destino fora do prefixo descartavel. A revisao B2-B1
descrita abaixo acrescenta perfis de servidor ao guard. Continuam as recusas de
transacao aberta, autocommit/FK/CHECK
desligados, modo nao estrito, tipos/FK divergentes, tabelas parciais e indice
preexistente inesperado. DDL faz commit implicito: falha nao autoriza retomar.
Nenhum dado comercial e inserido. A revisao nao autoriza execucao no principal.

B2 exige aprovacao especifica: conferir autorizacao de destino da migration,
revalidar identidade e estrutura reais, backup completo e restauracao,
SHA do SQL, ausencia de escritores, hashes comerciais/financeiros, aplicar
uma unica vez e verificar vazio das novas tabelas e preservacao dos historicos.
Sem rollback improvisado de DDL. Depois de direitos reais, nao remover schema
como rollback de codigo; preservar dados e elaborar recuperacao apropriada.

## D5.1-B2-B1 — revisao exclusiva do guard

SHA-256 anterior: `d5c0ba2edf5dfffa849e72d86b60f25d48791a128147daaadee947bfd6987a07`.
SHA-256 revisado: `3f1b2575f31dde580bae7b67fa2531c55c69ceda35d4fa031053caf78659f18d`.
Todo o conteudo a partir de `IF @@in_transaction` foi comparado byte a byte com
a versao anterior e permaneceu identico: nenhum CREATE/ALTER, FK, CHECK, indice,
tipo ou ordem de DDL mudou.

O guard reconhece somente versoes 13.0.2 e 10.3.39 MariaDB. Para schema
descartavel, exige perfil Windows 13 com datadir da fixture e porta nao padrao,
ou perfil do container 10.3 com hostname hexadecimal de 12 caracteres,
datadir /var/lib/mysql/ e porta interna 3306. Para `istbrasil`, aceita somente
Windows 13.0.2 com porta/datadir exatos da instalacao local aprovada, ou o
perfil TEMP independente usado para homologar esse nome. `istbrasil` em
Linux 10.3 permanece recusado. Nenhuma variavel arbitraria libera destinos.

Esses metadados nao provam quem administra o servidor nem autenticam a origem
127.0.0.1 da conexao. Outra instancia deliberadamente configurada para imitar
o perfil pode apresentar os mesmos valores. A futura execucao exige verificacao
externa obrigatoria: endpoint TCP literal, PID/executavel/datadir Windows,
versao, configuracao development, conexao dedicada, SHA aprovado e autorizacao
especifica. No Docker, exigir tambem container ID/digest, label da execucao,
volume e bind loopback. O SQL nao substitui essa verificacao ou o consentimento.

Homologacao revisada: 53 testes especificos aprovados em 13.0.2 descartavel;
805 aprovados com as regressoes Node, zero falhas e zero ignorados. Foi aplicado
integralmente em schema chamado `istbrasil` exclusivamente no datadir TEMP,
porta dinamica, removido ao terminar. Testes negativos verificaram nome nao
autorizado mesmo com variavel arbitraria, autocommit, transacao e modo estrito.
Versao incompatível e datadir divergente foram injetados apenas em copias SQL
de teste; isso comprova os ramos do guard, nao execucao em terceira versao real.

O responsavel executou o seletor `d51` no WSL e informou sucesso e descarte
do container, volume e segredos, com Docker/containerd encerrados. Essa suite
tambem testa que `istbrasil` em Linux 10.3 e recusado e que o schema descartavel
permitido recebe o DDL completo. O retorno recebido foi resumo de sucesso,
sem detalhamento TAP individual. Nenhuma migration ou backup no principal.

### Diff exato do guard B2-B1

```diff
--- migration homologada B1
+++ migration revisada B2-B1
@@ -10,3 +10,28 @@
-    IF DATABASE() IS NULL OR DATABASE() NOT REGEXP '^ist_loja_67_3_[0-9a-f]{12}$' THEN
-        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: exige schema descartavel identificado';
-    END IF;
+    -- SQL reduz destinos acidentais, mas nao autentica host cliente/instancia.
+    -- Executor deve validar externamente identidade, destino, hash e autorizacao.
+    -- Nenhuma variavel de sessao habilita o destino principal.
+    IF VERSION() NOT REGEXP '^(13[.]0[.]2|10[.]3[.]39)-MariaDB(-|$)' THEN
+        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: versao MariaDB nao homologada';
+    END IF;
+    IF DATABASE() IS NULL OR NOT (
+      (BINARY DATABASE() REGEXP '^ist_loja_67_3_[0-9a-f]{12}$'
+        AND (
+          (VERSION() REGEXP '^13[.]0[.]2-MariaDB(-|$)'
+            AND UPPER(@@version_compile_os) LIKE 'WIN%'
+            AND @@port NOT IN (3306,3307)
+            AND REPLACE(@@datadir,CHAR(92),'/') REGEXP '/ist-loja-67-4-[a-z0-9]+/$')
+          OR (VERSION() REGEXP '^10[.]3[.]39-MariaDB(-|$)'
+            AND @@port=3306 AND BINARY @@datadir='/var/lib/mysql/'
+            AND BINARY @@hostname REGEXP '^[0-9a-f]{12}$')
+        ))
+      OR (BINARY DATABASE()='istbrasil'
+        AND VERSION() REGEXP '^13[.]0[.]2-MariaDB(-|$)'
+        AND UPPER(@@version_compile_os) LIKE 'WIN%'
+        AND (
+          (@@port=3306 AND BINARY REPLACE(@@datadir,CHAR(92),'/')='C:/Program Files/MariaDB 13.0/data/')
+          OR (@@port NOT IN (3306,3307)
+            AND REPLACE(@@datadir,CHAR(92),'/') REGEXP '/ist-loja-67-4-[a-z0-9]+/$')
+        ))
+    ) THEN
+        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: destino nao autorizado pelo perfil local/descartavel';
+    END IF;
```
