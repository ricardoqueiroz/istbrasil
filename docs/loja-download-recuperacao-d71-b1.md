# D7.1-B1 — fundacao persistente da recuperacao

Implementacao interna, sem SMTP, endpoints, cookies, Angular, acesso a PDFs ou
mudanca na autorizacao D6. Nao aplicada ao banco principal. Nenhum backfill.

## Schema e destino

`migrations/ist_loja_download_recuperacao_fundacao.sql` cria somente:

- `ist_loja_download_recuperacoes`: ID interno e UUID publico; SHA-256 do segredo;
  HMAC-SHA-256 do email; email normalizado temporario; datas UTC DATETIME(3);
  contador de 0 a 5; consumo; hash independente da sessao; criacao, expiracao
  absoluta e revogacao da sessao.
- `ist_loja_download_recuperacao_direitos`: chave primaria composta
  (recuperacao_id,direito_id), com a versao de arquivo adquirida fixada.

Tres FKs RESTRICT: recuperacao, direito e versao. Unicidade do UUID e dos hashes.
Indices de email protegido/data, expiracao do desafio e sessao, direito e versao.
CHECKs exigem desafio de 15 minutos, tentativas <=5, sessao de no maximo 24 horas,
datas coerentes e consumo/sessao completos; consumo elimina o email em texto.
FKs/CHECKs nao garantem imutabilidade contra um administrador com DML direto.
O servico nao oferece API para alterar/ampliar o escopo persistido.

Guard restrito aos perfis descartaveis existentes: schema aleatorio, versao
13.0.2/Windows com datadir TEMP e porta distinta de 3306/3307, ou 10.3.39 com
datadir/hostname esperados do container. Exige autocommit, FK/CHECK ativos e modo
estrito; verifica tipos de referencias, prerequisitos e ausencia das duas tabelas.
Nao aceita istbrasil. Identidade SQL nao substitui a verificacao externa da fixture.
DDL tem COMMIT implicito: nao usar --force nem reaplicar estrutura parcial.

## Contratos internos

Fabrica `criarLojaDownloadRecuperacaoService({db,chaveEmail,contextoEsperado,agora})`.
`db` e obrigatorio, sem fallback de pool/credenciais. Chave HMAC obrigatoria de
32 bytes, fornecida pela futura composicao confiavel; sem leitura de ambiente.
Contexto financeiro copiado da composicao, nunca de argumentos do comprador.

- `criarDesafio(email)`: retorna `{publicId,segredo,expiraEm}` APOS COMMIT. Segredo
  aleatorio de 32 bytes, base64url canonico; somente seu hash e persistido.
  Contrato exclusivo do futuro chamador interno de envio, nao um DTO publico.
  Criar desafio nao prova posse do email nem concede sessao/direitos.
- `consumirDesafio(publicId,segredo)`: verifica hash/expiracao/tentativas sob lock;
  retorna `{token,sessao}` somente apos COMMIT confirmado. Token novo independente;
  sessao contem UUID, datas e escopo interno de direito/versao. Nao recebe email
  ou IDs de direitos do cliente. O conhecimento do email sozinho nao consome.
- `obterSessao(token)`: valida hash, revogacao e prazo absoluto; devolve escopo
  fixo. Nao renova prazo, nao procura novas compras e NAO autoriza bytes.
- `revogarSessao(token)`: revogacao persistente e idempotente para a sessao.

SHA-256 tem dominios distintos para segredo e sessao. HMAC de email usa outro
dominio e chave exclusiva; manter essa chave durante a validade dos desafios.
Nenhum segredo e escrito em log ou incluido nos erros sanitizados.

## Email, elegibilidade e teto aprovados

Reutiliza `normalizarEmailComprador`: trim externo, local-part ASCII preservado e
dominio em minusculas, sem equivalencias de pontos, sufixos + ou provedores.
Busca utiliza o indice de email existente e comparacao BINARY adicional, sem
depender da collation case-insensitive dos pedidos. HMAC usa esse mesmo valor.

Teto de 50 candidatos por validacao, aprovado expressamente. Busca LIMIT 51 e
rejeita integralmente o excesso, sem truncamento. O teto acompanha o maximo de
50 da listagem D6 e limita pedidos candidatos/avaliacoes. Tambem conta candidatos
que depois sejam considerados financeiramente inelegiveis: falha conservadora.
O avaliador D6 ainda le as evidencias existentes de cada pedido; nao ha aqui
alteracao ou novo limite para o historico financeiro desse avaliador.

Inclui somente ATIVO ou AGUARDANDO_CONFIRMACAO ligado ao email do desafio e com
avaliacao persistida ELEGIVEL, respeitando pedido/item/produto/versao. Versao
adquirida RETIRADA continua permitida se o avaliador a considerar valida.
Suspensos e revogados ficam fora. AGUARDANDO nao e ativado. Compras posteriores
nao ampliam o escopo. Erro SQL absorvido pelo avaliador e detectado e aborta a
transacao, em vez de ser interpretado como ausencia de direitos.

## Transacoes e locks

Conexao limpa, autocommit=1, READ COMMITTED para a proxima transacao. Consumo:
recuperacao -> todas as sessoes originais em ordem de ID -> pedidos em ordem ->
pagamentos -> operacoes -> eventos financeiros -> direitos. Revalida email,
ambiente, sessao e candidatos apos locks. Nao exige login nem sessao original
ainda vigente. Nao modifica nenhuma dessas tabelas; somente as duas novas.

Tentativas invalidas sao persistidas por COMMIT antes do erro DESAFIO_INVALIDO;
a quinta bloqueia o desafio, inclusive contra segredo correto posterior.
Escopo e sessao sao gravados na mesma transacao. Falha antes de COMMIT reverte
tudo. COMMIT sem ACK destroi a conexao e retorna RESULTADO_DESCONHECIDO, sem
token e sem reaplicacao automatica. Se o COMMIT efetivamente ocorreu, o desafio
permanece consumido; deve-se solicitar novo desafio, nao recuperar o segredo.

## Homologacao executada

Sintaxe Node dos arquivos novos e sintaxe bash do executor aprovadas.

Windows/MariaDB 13.0.2 descartavel:

```powershell
$env:IST_LOJA_PAGAMENTOS_MARIADB_BIN='C:\Program Files\MariaDB 13.0\bin'
node --test --test-reporter=spec tests/lojaDownloadRecuperacaoService.test.js tests/lojaDownloadFinanceiroService.test.js
```

73 testes, 73 aprovados, 0 falhas, 0 ignorados: 15 da B1 e 58 da regressao do
avaliador. As duas fixtures confirmaram encerramento e remocao dos datadirs.
Uma rodada inicial detectou expectativa incorreta no TESTE sobre nome do erro
CHECK no mysql2; corrigida para errno MariaDB 4025, como nos testes existentes.
Nao houve alteracao de constraint ou flexibilizacao do erro esperado.

MariaDB 10.3.39 real em Docker/WSL, executado pelo usuario com sudo pessoal:

```bash
sudo bash /mnt/c/inetpub/wwwroot/istbrasil.org.br/scripts/loja-d71b1-homologar-mariadb10339-wsl.sh
```

Saida fornecida: 10.3.39-MariaDB-1:10.3.39+maria~ubu2004, externo
127.0.0.1:13339, interno 3306; 15 testes, 15 aprovados, 0 falhas, 0 ignorados,
CODIGO_DE_SAIDA_TESTES=0. Confirmados descarte de container/volume/segredos e
Docker/containerd parados, sem habilitar inicializacao automatica. Imagem fixada
no executor pelo mesmo digest da infraestrutura R2 homologada.

Cobertura: guards, schema vazio e preservacao das estruturas/dados anteriores,
CHECK/UNIQUE/FKs, expiracao, cinco tentativas, replay, concorrencia, email exato,
outro comprador, estados adversos, pendencia, escopo fixo, limite 50/excesso,
revogacao, rollback parcial e COMMIT incerto antes/depois da persistencia.

## Limites desta entrega

Nenhuma composicao/ativacao no backend; nao aplicar migration no principal.
Nenhuma entrega de email ocorreu: verificacao real da caixa depende da futura
integracao SMTP. Obter sessao nao substitui autorizacao financeira D6 por arquivo.
O executor novo ainda e especifico ao workspace/usuario WSL local existente.

O email em texto e apagado no consumo bem-sucedido. Desafios abandonados,
bloqueados ou expirados precisam de limpeza operacional com prazo de retencao
definido antes da ativacao publica; B1 nao instala agendador nem limpeza automatica.
Essa futura rotina deve operar somente nas duas tabelas novas, em lotes,
removendo escopos antes de recuperacoes encerradas e preservando sessoes vigentes.
Rate limits publicos, anti-enumeracao HTTP e auditoria de envio pertencem as
etapas seguintes. Nenhuma dessas protecoes e presumida existente nesta B1.
