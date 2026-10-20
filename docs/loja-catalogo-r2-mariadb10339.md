# R2.2 — resultado real em MariaDB 10.3.39

## Resultado registrado

- Versão SQL: `10.3.39-MariaDB-1:10.3.39+maria~ubu2004`.
- Imagem oficial amd64: `docker.io/library/mariadb@sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102`.
- Contêiner existente reutilizado: `f34adbe6695bdabbf511d206b874201b56f5799e7d493d00178f282d96e14bbc`.
- Host externo `127.0.0.1:13339`, porta interna 3306; hostname corresponde ao contêiner.
- Schema sintético: `ist_loja_67_3_efc5322951db`.
- Teste `tests/lojaCatalogoExpansaoR2.mariadb10339.test.js`: 1 aprovado, 0 falhas, 0 excluídos.
- Migration original SHA-256: `d93e85e4660179372cd47ed2329cbec7f51c67baeb580733fd97c4257938a5d5`, inalterada.

## Cobertura executada

Conexão com senha correta aceita e senha incorreta rejeitada com
`ER_ACCESS_DENIED_ERROR`, antes de criar schema ou carregar SQL.
Versão, hostname, porta, datadir e inexistência do schema confirmados.
Estruturas anteriores criadas somente no contêiner; migration R2 completa aplicada.
IDs, SKUs, categorias, vínculos e colunas antigas preservados por comparação.
Preços exatos 9500, 9500 e 100 centavos. Textos com acentos, emoji e JSON
preservados. Classificação editorial 1/2=1, 3=0, outro livro=NULL.
FK, UNIQUE, múltiplos NULL, CHECK e rollback das sondagens aprovados.
Dois pedidos, snapshots, pagamentos PENDENTE/CAPTURADO, operações e eventos
sintéticos preservados. Divergência de preço recusada antes do DDL;
reaplicação recusada sem alteração de dados. Perfil fiscal vazio.

## Incompatibilidade corrigida

A primeira execução parou na identidade, antes de qualquer schema, porque
`@@skip_grant_tables` não existe como variável SQL em 10.3.39.
Somente a fixture específica foi corrigida: retirou a consulta incompatível e
substituiu a inferência por teste efetivo de autenticação positiva/negativa.
Nenhuma asserção da migration foi removida; SQL R2 e fixture Windows intactos.

## Destinos e pendências

Banco principal, MariaDB Windows e produção não foram acessados nesta retomada.
Sem alterações em checkout, PayPal, webhook, filtro ou npm-audit-local.json.
Sem commit/push/deploy. R3 e D3 não iniciadas.

Compatibilidade da migration R2 comprovada no cenário sintético executado em
10.3.39, além dos testes prévios em 13.0.2. Aplicação ao banco local principal
continua exigindo nova autorização, backup/restauração validada, janela sem
escritores e conferência atualizada das pré-condições. Não autoriza produção.

Descarte administrativo concluído pelo usuário no terminal sudo. A saída confirmou
o ID exato do contêiner e o volume antes da remoção, seguida de remoção dos segredos
e encerramento de Docker/containerd, sem habilitar inicialização automática.
Conferência posterior somente leitura: serviços inactive/disabled, diretório
temporário ausente e nenhuma escuta Windows na porta 13339.
Não foi reiniciado o daemon apenas para consultar inventário Docker.
