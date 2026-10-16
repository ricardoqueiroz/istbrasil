# Etapa 67.3 — Fundação da persistência de pagamentos

## Entrega e DDL final

DDL integral: `migrations/ist_loja_pagamentos_fundacao.sql`.
Testes reproduzíveis: `tests/lojaPagamentosPersistencia.integration.test.js`.

Somente três tabelas novas, todas InnoDB, ROW_FORMAT=DYNAMIC, utf8mb4_unicode_ci:

| Tabela | Relação e garantias principais |
| --- | --- |
| ist_loja_pagamentos | FK INT UNSIGNED para pedidos; public_id único; reserva ativa única por pedido; IDs externos únicos no contexto provedor/ambiente/recebedor |
| ist_loja_pagamento_operacoes | FK composta pagamento/pedido; unicidade de pedido/ação/chave; uma criação e uma captura lógica por tentativa; request_id do provedor único |
| ist_loja_pagamento_eventos | Associação opcional; FK composta impede contexto divergente; deduplicação por provedor/ambiente/recebedor/origem/evento |

Nenhum ALTER, DROP, INSERT, trigger ou objeto persistido além dessas três tabelas
na migration. Não existe referência ou tabela de compatibilidade financeira
legada. Não foi implementado serviço de pagamentos, provedor ou endpoint.

Valores monetários usam BIGINT UNSIGNED em centavos. O esperado é limitado a
9007199254740991, compatível com o backend atual. Valores externos exigem parsing
decimal exato; valores observados grandes precisam de string decimal/BigInt.
Captura divergente pode ser registrada para revisão, sem forçar igualdade com
o esperado. DATETIME(3) recebe UTC explícito do chamador e não tem default local.

## Ajustes em relação à especificação 67.2

- Preflight exige schema esperado, nenhuma tabela nova preexistente, as três
  tabelas de fundação em InnoDB, seus 32 campos com tipos/nulabilidade relevantes
  e PKs. Não reconstrói nem corrige fundação divergente. O preflight é uma guarda
  de requisitos; não substitui a comparação completa do esquema de destino.
- Exige modo estrito, FKs e CHECKs ligados, autocommit e ausência de transação
  pendente. Não altera automaticamente essas configurações.
- Permite istbrasil ou schema de teste com nome estritamente delimitado. Nome do
  banco não atesta isolamento: o executor precisa confirmar host/porta/datadir.
- CHECK da reserva usa IS NOT NULL explícito. A expressão anterior podia avaliar
  como UNKNOWN e permitir reserva NULL sem encerramento.
- CRIANDO, AGUARDANDO_APROVACAO, APROVADO, CAPTURANDO, PENDENTE e DESCONHECIDO
  exigem reserva 1. Não se pode liberá-la apenas por vencer o prazo local.
- REVISAO permite tentativa histórica encerrada, para evidência tardia sem
  disputar outra reserva existente. Decidir e aplicar transições continua sendo
  responsabilidade do futuro serviço, sob bloqueio do pedido.
- EM_EXECUCAO e PROCESSANDO exigem token interno de coordenação e prazo válidos;
  os demais estados não podem manter esses campos. O vencimento não libera
  automaticamente uma operação nem autoriza repetir uma chamada externa.
- JSON_VALID e limite de 16 KiB para evidência/resultado; identificações vazias
  são rejeitadas. UUID v4, conteúdo permitido e transições exigem validadores
  futuros. JSON válido não comprova ausência de dados sensíveis.
- Vocabulários comparados de forma binária. Sem colunas geradas ou índices
  parciais. DDL não é reversível com ROLLBACK.

## Execução isolada e resultados

Validação realizada em 16/10/2026:

- Servidor efetivamente consultado: **13.0.2-MariaDB**, Windows x64.
- Última execução: 127.0.0.1:51968, datadir novo abaixo de TEMP, confirmado por
  SELECT @@datadir, @@port e VERSION() antes de qualquer escrita SQL.
- Banco novo com prefixo ist_loja_67_3_, sem importar pool da aplicação, dotenv
  ou credenciais DB_*. Portas 3306 e 3307 são recusadas pelo teste.
- Inicialização por binários já instalados, sem instalar dependências ou serviço.
- Fundação de sessões/pedidos/itens criada a partir dos CREATE TABLE versionados.
  Dependência de ist_livros é uma fixture mínima; não representa auditoria dessa
  tabela real. Catálogo usa os CREATE TABLE da sua migration.
- Executado o bloco completo da migration nova, incluindo os preflights; não
  apenas os CREATE TABLE extraídos.
- **70 cenários aprovados; 71 testes contabilizados pelo Node, incluindo o pai;
  zero falhas, zero ignorados.**

Cobertura: criação e SHOW CREATE TABLE; engine/collation/índices; FKs simples e
compostas; RESTRICT; três unicidades de operações; IDs externos com contextos
distintos; múltiplos NULL no índice de reserva; CHECKs e brechas ternárias;
estados incertos persistidos; JSON inválido/acima do limite; valor inteiro no
limite exato; DATETIME explícito mesmo com fuso de sessão diferente; captura
tardia/divergente; concorrência real entre conexões; bloqueio FOR UPDATE do
pedido; primeira transação confirmada ou revertida; rollback integral após
conflito de operação; rejeição de execução repetida/parcial e fundação ausente
ou divergente; rejeição de FKs/CHECKs desligados, modo não estrito e transação
pendente/autocommit desligado.

SHOW CREATE e todos os registros das três tabelas preservadas foram comparados
antes/depois da migration. Estruturas foram comparadas novamente ao fim dos
testes, desconsiderando somente o contador AUTO_INCREMENT das fixtures.

O processo foi encerrado e o datadir descartável removido com validação do caminho
absoluto. Não ficou servidor temporário ou dado de teste persistido.

## Reprodução

No PowerShell, apontando para binários locais já disponíveis:

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN = 'C:/Program Files/MariaDB 13.0/bin'
node --test tests/lojaPagamentosPersistencia.integration.test.js
```

Sem essa variável, o teste é ignorado explicitamente. Não aponta para instância
preexistente: cria seu próprio processo em loopback. O mesmo teste pode receber
um diretório de binários 10.3.39 quando essa versão estiver disponível.

## Limitações e preservação

**Compatibilidade executada em MariaDB 10.3.39 permanece pendente.** Localizados
somente binários MariaDB 13.0.2 no PATH/Program Files; Docker/Podman não encontrados.
Não houve download ou instalação de outra versão. Sintaxe projetada para 10.3.39
não equivale a homologação nessa versão. A validação ocorreu via mysql2 com remoção
das diretivas DELIMITER, próprias do cliente; o fluxo no cliente CLI 10.3 não foi
testado. JSON_VALID com CHECK já é documentado pelo MariaDB para a linha 10.2:
https://mariadb.com/resources/blog/json-with-mariadb-10-2/

O banco não autentica eventos por si só, não valida a lista permitida de dados
nos JSONs, não calcula hashes canônicos e não implementa a máquina de estados.
Essas garantias, autorização e reconciliação pertencem às próximas etapas.
Não guardar cartão, OAuth, cookies ou CSRF nos campos genéricos.

Banco recuperado e produção não foram acessados. Nenhum dado real, tabela
financeira legada ou arquivo de configuração foi alterado. npm-audit-local.json
foi preservado. Sem commit, push ou deploy. Aplicação em banco real e
versionamento aguardam autorização própria.
