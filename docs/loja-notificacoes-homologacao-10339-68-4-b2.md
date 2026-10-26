# Preparação 68.4-B2.1 — notificações no MariaDB 10.3.39

Esta etapa prepara código; não autoriza nem executa homologação SQL, WSL ou Docker.

## Seleção explícita, sem fallback

As duas suítes de notificações utilizam `lojaNotificacoesFixture.js`. Exigem
`IST_LOJA_NOTIFICACOES_MARIADB` com exatamente `13.0.2` ou `10.3.39`.

- 13.0.2 exige `IST_LOJA_PAGAMENTOS_MARIADB_BIN` absoluto e manifesto ausente.
  A fixture Windows original continua validando a versão antes do bootstrap.
- 10.3.39 exige manifesto no novo diretório fixo e variável de binário ausente.
  Não aceita o manifesto dos executores antigos nem uma porta arbitrária avulsa.
- Ausência de seleção, versões desconhecidas ou configuração ambígua interrompem
  antes de importar/iniciar a fixture. Não são usadas configurações DB_*.

O modo padrão de `lojaCatalogoMariaDB10339.js` continua com seus recursos antigos,
porta 13339, retorno e dados originais. O modo opcional `{financeiroOutbox:true}`
é utilizado apenas pelo novo percurso. Aplica outbox após as migrations de catálogo,
pedidos e pagamentos, disponibiliza pool exclusivo e compras sintéticas com datas
atuais, total de 19000 centavos e destinatário `fixture@example.invalid`.
Sandbox é o padrão; Live é suportado exclusivamente como dado sintético para
comprovar que o worker Sandbox não o processa. Não há PayPal nem SMTP reais.

## Identidade e concorrência

O manifesto fica em `/home/ist_user/.local/state/ist-notificacoes-mariadb10339`.
Contêiner e volume são `ist-notificacoes-mariadb10339` e
`ist-notificacoes-mariadb10339-data`. Credenciais ficam fora do repositório.

O Docker atribui a porta com `127.0.0.1::3306`. Após iniciar, o executor lê o binding
efetivo e grava a porta numérica no manifesto. Não usa a porta antiga 13339 nem
portas compartilhadas conhecidas; se a atribuição não for aceitável, falha sem retry.

Antes de conectar, a fixture compara manifesto com `docker container inspect` e
`docker volume inspect` reais via WSL: ID, imagem por digest, labels/runId,
loopback/porta, mounts, volume e segredo somente leitura. A inspeção Docker usa
root no WSL somente para leitura desses recursos com nomes fixos; não há comando
SQL ou senha na linha de comando. Falha de permissão interrompe sem alternativa.
Executor e inspeção fixam o socket Docker local `/var/run/docker.sock`, ignorando
DOCKER_HOST/DOCKER_CONTEXT herdados para não alcançar um daemon remoto.

Depois de autenticar, confirma versão, hostname derivado do ID, porta interna 3306
e datadir `/var/lib/mysql/`; autenticação incorreta deve ser rejeitada. PROCESS
global é verificado antes do DDL no modo 10.3.39, sem conceder privilégios.
O schema aleatório deve ainda não existir, com prefixo `ist_loja_67_3_` e 12 hex.
Cada conexão obtida do pool é comparada à identidade do observador antes de ser
entregue ao serviço. A porta TCP externa é distinta da porta interna SQL.

As asserções financeiras, barreiras, duas conexões independentes, espera B → A
em INNODB_LOCK_WAITS e unicidade final permanecem obrigatórias. A observação
mantém os ciclos de 220 ms existentes; tempo decorrido não é prova de lock.

## Execução futura — requer autorização separada

Pré-condições: Ubuntu WSL 26.04 x86_64, usuário ist_user, interoperabilidade com
Node Windows, Docker/containerd já ativos e imagem homologada disponível localmente:

`docker.io/library/mariadb@sha256:a4b57b620852e26f2c306c79fd8a61e22c7cd6e55d0a55d5521854ed2c370102`

O executor não instala nem baixa imagem, não inicia serviços e recusa recursos
preexistentes. Cada comando abaixo cria uma instância nova para somente uma suíte:

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-notificacoes-homologar-mariadb10339-wsl.sh outbox
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-notificacoes-homologar-mariadb10339-wsl.sh worker
```

Executar o segundo somente após avaliar o primeiro e confirmar limpeza. Em falha,
parar: contêiner, volume e segredos próprios são preservados, sem repetição ou
limpeza manual automática. Em sucesso, conferir IDs/labels/mounts/porta, remover
somente os recursos próprios e verificar ausência. Docker/containerd permanecem
ativos. O datadir é o volume exclusivo, nunca um diretório MariaDB do host.

Para futura execução 13.0.2, selecionar explicitamente em PowerShell, mantendo
manifesto ausente e sem reutilizar um servidor existente:

```powershell
$env:IST_LOJA_NOTIFICACOES_MARIADB='13.0.2'
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/lojaNotificacoes.integration.test.js
node --test --test-reporter=spec tests/lojaNotificacoesWorker.integration.test.js
```

O binário precisa ser confirmado como 13.0.2 pela fixture. Restaurar posteriormente
as variáveis da sessão. Nenhum desses comandos foi executado nesta preparação.

## Limites

Testes unitários validam seleção e manifestos sintéticos, sem consultar Docker,
WSL, bancos ou rede. Sintaxe não comprova disponibilidade operacional nem compatibilidade
SQL real 10.3.39. Essa pendência permanece até homologação autorizada.
