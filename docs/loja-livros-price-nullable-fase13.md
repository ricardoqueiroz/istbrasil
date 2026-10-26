# Fase 1.3: nulabilidade do preco editorial legado

A migration nova `migrations/ist_livros_price_nullable.sql` altera exclusivamente
`price DECIMAL(5,2) NOT NULL` para `DECIMAL(5,2) NULL DEFAULT NULL`.
Nao modifica migrations historicas nem desbloqueia o contrato POST de livros.

## Destino

Nesta fase o SQL aceita somente os perfis descartaveis das fixtures existentes:
MariaDB Windows 13.0.2 com datadir temporario e porta diferente de 3306/3307,
ou MariaDB 10.3.39 em container, schema aleatorio com prefixo permitido.
`istbrasil` e bloqueado. Nome, hostname e datadir nao provam sozinhos isolamento:
o executor deve comprovar processo/container, mounts, host e porta antes de SQL.
Nao ha variavel de sessao que libere destino persistente.

## Executor de teste

PowerShell, somente com os binarios ja instalados:

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/livroPriceNullable.integration.test.js
```

A fixture nao importa dotenv nem credenciais reais; inicia outro processo,
valida versao/porta/datadir antes de criar schema e remove somente seu datadir.
O teste tambem suporta a fixture 10.3.39 quando invocado por executor autorizado
com `IST_R2_10339_MANIFEST`. Nao definir essa variavel para apontar outro banco.
Nao foi criado nem modificado executor WSL nesta fase.

## Evidencia inicial

Executado em 13.0.2-MariaDB, host 127.0.0.1, porta 63211,
schema ist_loja_67_3_0d4c79b69be6. Sete testes aprovados inicialmente.
Hash deterministico dos registros sinteticos antes/depois:
`5aa0a3015bfac4c21458be297763d2fefc72ae465f51695e8cb33f388d314b9a`.
Comparacao integral das linhas e SHOW CREATE TABLE, permitindo somente a mudanca
da clausula price. A fixture encerrou o processo e removeu o datadir.

Regressoes: 167 aprovados, zero falhos e um ignorado (integracao editorial SQL
opcional nao habilitada nessa chamada); contratos administrativos continuam bloqueados.
Uma rodada adicional cobre precisao divergente e FK/CHECK desabilitados.
Resultado final dessa rodada: 8 aprovados, zero falhos/ignorados; 13.0.2-MariaDB,
127.0.0.1:54148, schema ist_loja_67_3_217260ba2c42; mesmo hash historico.
Processo encerrado e datadir removido pela fixture.

## Recuperacao ensaiada

Falha SQL posterior simulada demonstra que ROLLBACK nao desfaz a migration.
Antes de inserir NULLs, o teste restaura explicitamente NOT NULL e compara DDL
e todas as linhas com o estado original; depois reaplica em ambiente sintetico.
Depois de inserir NULLs, nao tentar reverter automaticamente: interromper e decidir
recuperacao baseada em backup validado, sem substituir NULL por zero/preco comercial.
DDL implica COMMIT. Nenhum rollback automatico ou reaplicacao silenciosa.

## Pendencias

WSL retornou E_ACCESSDENIED na inspecao; isolamento 10.3.39 nao comprovado nesta
sessao, portanto nenhum SQL nessa versao foi executado. Homologacao permanece
pendente. Nenhuma instalacao ou tentativa de consertar WSL autorizada implicitamente.
Rejeicao de versoes diferentes esta no guard, mas nao foi exercitada contra outro
servidor real. A aplicacao persistente exige autorizacao e procedimento proprio,
backup/restauracao, janela sem escritores e revisao do guard; este arquivo nao a permite.
