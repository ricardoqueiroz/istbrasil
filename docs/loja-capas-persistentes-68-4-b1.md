# Capas persistentes — 68.4-B1

**Histórico B1:** a normalização posterior substitui os nomes antigos, o fallback
de escrita, a injeção PM2 e a criação automática descritos abaixo. Contrato vigente:
[loja-armazenamento-68-4.md](loja-armazenamento-68-4.md).

## Contrato

URL preservada: `/assets/images/livros/<nome>`. O campo `img` continua contendo
`assets/images/livros/<nome>`, sem atualizar registros de banco.
`CAPAS_LIVROS_PATH=assets/images/livros` continua identificando o caminho público.

A nova configuração `CAPAS_LIVROS_STORAGE_PATH` identifica um diretório físico
absoluto, real, sem symlinks nos componentes, fora da release e separado de
`PRODUCTS_PATH`. Se presente e inválida, não há fallback de escrita ou entrega.
Sem a nova configuração, instalações anteriores mantêm o fluxo legado.

O deploy usa `/var/www/istbrasil.org.br/uploads/livros`, sob o diretório persistente
`uploads` já existente. Prepara somente esse subdiretório (modo 700 quando novo),
sem mudar permissões existentes nem copiar arquivos. Rejeita links e diretórios
uploads/livros graváveis por grupo/outros. Não apaga ou substitui suas imagens.

O adaptador PM2 passa o caminho ao iniciar cada release, inclusive em rollback.
É um vínculo por configuração de ambiente, sem symlink na árvore de assets e sem
alterar os manifestos de releases. A variável do processo prevalece sobre dotenv
no comportamento atual. O exportador Git continua excluindo uploads: nenhum
arquivo enviado deve virar entrada de build ou conteúdo versionado.

## Upload e leitura

O upload mantém a rota administrativa, autenticação, autorização, Origin/CSRF,
limite de 5 MiB, validação de conteúdo/dimensões e conversão WebP. Nomes UUID e
criação exclusiva `wx` impedem sobrescrita; a gravação é sincronizada antes do
sucesso. O diretório configurado precisa existir; um erro não redireciona uploads
silenciosamente para a release.

A entrega consulta o armazenamento persistente primeiro. Apenas quando o arquivo
não existe, consulta os assets legados da release. Links, hardlinks, traversal,
subdiretórios, arquivos grandes e conteúdo sem formato de imagem reconhecido são
recusados. A leitura usa descritor verificado e, onde disponível, O_NOFOLLOW.
Os diretórios devem permanecer sob controle do administrador/usuário da aplicação;
isso não substitui permissões contra troca maliciosa de diretórios durante I/O.

O location Nginx específico encaminha somente `/assets/images/livros/` ao Node,
preservando a URI. Não há fallback SPA nessa rota nem publicação de PDFs privados.
Angular não precisa de rebuild após cada upload. Nginx, PM2 e variáveis do VPS não
foram modificados nesta etapa.

## Deploy, rollback e capas legadas

A publicação e a restauração de `html` não alcançam `uploads/livros`. Ambas as
releases compatíveis leem o mesmo armazenamento; novas capas permanecem disponíveis
após rollback. Rollback para código anterior a esta correção preserva os arquivos
fisicamente, mas pode não saber servi-los: selecionar um alvo compatível.

Antes do primeiro deploy operacional, é necessária migração manual autorizada das
capas enviadas que só existem na release antiga ou em html. Nenhuma migração foi
executada ou automatizada. Procedimento proposto:

1. Identificar release ativa, html e diretório de destino; conferir proprietário,
   caminhos canônicos, ausência de links e permissões. Fazer backup separado.
2. Inventariar nomes seguros, formato real e SHA-256 das imagens nas fontes.
3. Copiar apenas arquivos ausentes, com criação exclusiva e sem sobrescrita.
   Em colisão, comparar bytes/hash: se divergirem, interromper para decisão humana.
4. Validar hashes, nomes e URLs antes de liberar o novo runtime. Manter originais
   e backups; não atualizar referências no banco nem remover arquivos nesta fase.

As capas versionadas continuam disponíveis pelo fallback legado. Arquivos enviados
apenas à release antiga não passam a existir na nova automaticamente: a migração
prévia é condição de implantação sem perda de disponibilidade.

## Limites de validação

Testes locais usam imagens sintéticas, HTTP loopback em portas dinâmicas e duas
árvores de releases compartilhando armazenamento, inclusive retorno à primeira.
Não equivalem à ativação real de PM2, Nginx ou rollback no Linux. São necessárias
validação Linux específica e autorização operacional antes do deploy no VPS.
