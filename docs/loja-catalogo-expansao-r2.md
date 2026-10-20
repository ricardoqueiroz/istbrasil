# R2 — expansão do catálogo (aplicação principal NÃO autorizada)

SQL exato proposto: `migrations/ist_loja_catalogo_expansao_r2.sql`.
Não substituir nome de banco no arquivo. Executar integralmente, na mesma conexão,
sem `--force`, com autocommit/strict/FKs/CHECKs ativos e sem transação prévia.
Não editar nem reaplicar migrations históricas.

## Escopo

- Uma tabela fiscal vazia, sem classificação atribuída ou cálculos.
- Produto mantém PK INT signed, SKU, categoria, ordem e atividade.
- `livro_id` aceita NULL e mantém FK/UNIQUE; múltiplos produtos sem livro permitidos.
- Novos campos opcionais: tipo, título, descrição LONGTEXT, preço BIGINT em centavos,
  moeda BRL, venda, disponibilidade, imagem e perfil fiscal.
- Livro recebe classificação opcional: IDs 1/2 = 1; ID 3 = 0; demais NULL.
- Copia somente produtos 1/2/6: preços 9500/9500/100, tipo DIGITAL.
- Fonte antiga permanece intacta; nenhuma consulta comercial muda antes da R3.
- Campos novos continuam opcionais: endurecimento NOT NULL é uma fase futura.
- Não modifica arquivos privados ou snapshots; não contém DROP TABLE.

## Validação realizada

`tests/lojaCatalogoExpansaoR2.integration.test.js` usa a fixture existente, sem dotenv,
sem credenciais reais e sem PayPal. Instância separada, bind 127.0.0.1, porta dinâmica
diferente de 3306/3307, autenticação pré-TCP e datadir temporário removido ao terminar.

Cobertura: cópia exata de texto latin1/utf8mb4, descrição com emoji e JSON original,
preços decimais exatos, IDs/SKUs/categorias/vínculos, classificação restrita,
perfil fiscal vazio, dois pedidos com itens/snapshots, pagamentos PENDENTE/CAPTURADO,
operações e eventos sintéticos preservados por comparação de todas as colunas.
Também verifica rejeição de preço inesperado antes do DDL, reexecução recusada,
UNIQUE do livro, UNIQUE com NULL, FKs de livro/perfil, CHECKs e rollback de sondagens.

Execução específica: `node --test tests/lojaCatalogoExpansaoR2.integration.test.js`,
com `IST_LOJA_PAGAMENTOS_MARIADB_BIN` apontando para a instalação autorizada 13.0.

Versão realmente executada: MariaDB 13.0.2. Não há instância 10.3.39 disponível
identificada. Fixture limita deliberadamente seu bootstrap à versão 13.0.2.
Sintaxe analisada para 10.3: BEGIN NOT ATOMIC/SIGNAL, ALTER/MODIFY, FK explícita,
CHECK, utf8mb4_unicode_ci, CONVERT e aritmética DECIMAL. Nenhuma homologação real
em MariaDB 10.3.39 foi feita; essa execução continua pendente antes de produção.

## Aplicação principal futura: pré-condições

1. Obter autorização expressa para DDL/DML local; produção não está autorizada.
2. Reservar janela SEM escritores de catálogo (pausar ações que possam escrever).
   O arquivo não implementa bloqueio de aplicação entre vários DDLs.
3. Backup consistente e restrito das tabelas afetadas com estrutura, dados,
   charsets, índices, FKs e contadores AUTO_INCREMENT; comprovar restauração em
   instância isolada antes de aplicar. Não colocar backups com dados reais no Git.
4. Registrar SHOW CREATE TABLE de livros/produtos/categorias e baseline de IDs,
   SKUs, categorias, vínculos, preços e hashes dos textos. Registrar hashes/contagens
   dos pedidos, itens, sessões, pagamentos, operações e eventos, sem expor PII.
5. Confirmar destino 127.0.0.1:3306/istbrasil, versão, inexistência de expansão,
   três produtos esperados e ausência de escritores. Inspecionar o arquivo exato.
6. Executar exclusivamente o SQL proposto e parar no primeiro erro.
7. Conferir SHOW CREATE TABLE, novos valores e classificação; comparar baseline
   das colunas antigas e tabelas preservadas; verificar preços 9500/9500/100,
   textos byte a byte após conversão, FKs/UNIQUE e perfil fiscal vazio.
8. Manter consultas atuais e checkout intactos; não iniciar R3.

## Idempotência operacional e recuperação

O repositório utiliza migrations manuais com precondições, sem ledger automático.
Esta migration segue esse mecanismo: não usa IF NOT EXISTS para esconder diferenças.
Reexecução ou qualquer marcador de expansão existente interrompem antes do DDL.
Não há promessa de repetição automática após sucesso ou execução parcial.

DDL faz commit implícito. O handler faz ROLLBACK apenas da carga DML ainda aberta;
não desfaz tabela/colunas adicionadas. Se houver falha: interromper, preservar
erro/estrutura, não reaplicar, não tentar reparação automática. O código antigo
continua utilizando os campos antigos, mas alterações parciais devem ser auditadas.
Recuperação estrutural exige plano aprovado a partir do backup e estado observado;
não está embutida nenhuma exclusão nem restauração destrutiva. Campos antigos e
evidências financeiras não são removidos. A primeira e segunda compras Sandbox
reais não são copiadas para os testes nem modificadas pela migration.

## Limites

O banco principal foi apenas inspecionado por leitura. Nenhum DDL/DML R2 nele foi
executado. Não foram alterados backend/frontend, pagamentos, snapshots, migrations
históricas, filtro de túnel ou npm-audit-local.json. Sem commit/push/deploy.
