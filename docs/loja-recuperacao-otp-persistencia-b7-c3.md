# B7-C3 — Fundação de persistência OTP

> Registro histórico preservado. Consulte a seção “Estado atual para consolidação Git” ao final.

## Escopo e estado

Artefato completo: `migrations/ist_loja_download_recuperacao_otp_fundacao.sql`.
Não aplicado à homologação nem à produção. Nenhum serviço OTP, endpoint, envio ou alteração de template.
A tabela `ist_loja_download_recuperacao_direitos` permanece inalterada.

Inspeção: fundação D7.1 (inclusive variante `migrations/production/`),
`lojaDownloadRecuperacaoService.js`, `lojaDownloadRecuperacaoLimpeza.js`,
`lojaDownloadRecuperacaoService.test.js` e fixtures MariaDB existentes.

## Campos e índices

- `tipo`: LINK por padrão para inserts e registros legados; OTP explícito, comparação binária.
- `pedido_id`: FK real INT UNSIGNED/RESTRICT; obrigatório apenas em OTP. Não muda o pedido.
- `versao_protecao`: versão positiva do protocolo criptográfico; legado 1. Não contém chave.
- `invalidado_em`: apenas OTP não consumido, nunca anterior à criação. Não é revogação de sessão.
- `pedido_otp_aberto`: coluna determinística PERSISTENT, NULL para LINK/consumidos/invalidados.
  UNIQUE garante no máximo um OTP aberto por pedido, mesmo entre titulares/versões diferentes.
  Expirar NÃO libera esse slot: substituição exige invalidar explicitamente o anterior na mesma transação.
- `idx_ldr_tipo_pedido_criado`: histórico por tipo/pedido, ordenação determinística por criação/id.
- `idx_ldr_pedido`: suporte à FK e consulta por pedido sem tipo.
- Índices, hashes únicos, ciclo de sessão, tentativas <= 5 e escopo legado são mantidos.

Apenas a CHECK de validade é substituída: LINK exatamente 15 minutos; OTP exatamente 10 minutos.
Nenhuma coluna legada recebe UPDATE; novas colunas têm defaults compatíveis.
Nenhum código é armazenado. O futuro `desafio_hash` OTP precisa ser MAC com chave secreta,
separação de domínio, public_id, pedido e versão. SHA simples de seis dígitos é vulnerável a busca exaustiva.

## Limites persistentes

Uma tabela InnoDB: `ist_loja_download_recuperacao_limites`.
PK `(escopo, versao_chave, chave_hash)`. Sem e-mail/IP em claro, sem FK a desafios.
Chaves HMAC-SHA256 com segredo próprio, separação de domínio e ambiente:

| Escopo | Entrada canônica protegida | Uso futuro |
| --- | --- | --- |
| IP | IP validado por política de proxy confiável | Toda solicitação, inclusive inválida |
| TITULAR | e-mail normalizado + publicId informado | Solicitações/erros do par, inclusive inexistente |
| PEDIDO | identidade do pedido e contexto financeiro autorizado | Orçamento cumulativo entre reenvios, só após associação validada |

A normalização deve preservar as regras atuais de e-mail; não baixar arbitrariamente o local-part.
`solicitacoes`, `falhas`, janela explícita, cooldown e bloqueio sobrevivem ao Node.
O serviço futuro deve impor cinco falhas acumuladas no período, além das cinco por desafio,
sem zerar no reenvio. Proposta inicial a aprovar: janela 10 minutos, cooldown 60 segundos,
3 emissões/par/janela, 20 solicitações/IP/janela; valores não são regras financeiras nem ativados por este DDL.
Rotação de chave deve consultar versões ainda retidas; não pode resetar orçamento.
Contadores unsigned não dispensam UPDATE condicional sob lock e prevenção de overflow.

Solicitação inválida consome IP e par informado; não modifica orçamento de um pedido legítimo,
nem invalida desafio existente. Reenvio só substitui após titularidade, elegibilidade e orçamento
validados. Falha de consulta/envio não prova cancelamento. Conhecimento do par e-mail/pedido
continua sendo um vetor de negação de serviço: cooldown, limite IP e resposta uniforme precisam
ser implementados e homologados antes de expor OTP.

## Transações e locks futuros

1. Limites em ordem binária total `(escopo,versao_chave,chave_hash)`; criar linhas ausentes nessa mesma ordem.
2. Recuperações por id crescente; reler estado após adquirir lock.
3. Seguir ordem existente: sessões de compra → pedidos → pagamentos → operações → eventos → direitos,
   cada classe por id crescente; depois vínculos de escopo.
4. Gravar tentativas/orçamento e consumo/invalidação/substituição numa única transação.
   Devolver sessão só após commit conhecido. Nunca transação aninhada, envio SMTP dentro de lock ou operação PayPal.

O fluxo LINK atual começa no desafio e não acessa limites; não introduz ordem inversa.
Limpeza atual bloqueia recuperação antes dos vínculos; não adquire locks financeiros.
Limpeza de limites será independente, por lotes <=100, com releitura de `retencao_ate` sob lock,
sem adquirir desafios depois. Não há job novo nesta fase.
Deadlock/timeout: rollback integral e resposta segura; commit incerto exige observação/recuperação,
não repetição cega. Testes desta etapa exercitam contenção/timeout real, não crash/commit incerto.

## Retenção

Manter política atual: desafio não consumido 7 dias após expiração; sessão consumida 90 dias
após expiração/revogação, excluindo vínculos antes do desafio. Invalidado não dispensa retenção.
Limites: `retencao_ate` >= máximo(janela_fim, atualizado_em, cooldown, bloqueio) + 7 dias,
CHECK imposta pelo banco; exclusão só quando estritamente anterior ao instante de limpeza.
Não expurgar limites no reenvio. Desafios e limites não têm FK entre si para não quebrar limpeza legada.
Retenção implica janela de abuso finita e exige aprovação operacional antes do serviço real.

## Compatibilidade e limitações MariaDB

MariaDB 10.3.39/InnoDB: CHECK, FK completas, DATETIME(3), PERSISTENT determinística e UNIQUE
com múltiplos NULL; sem índice parcial, NOW em coluna gerada, SKIP LOCKED ou recursos MySQL 8.
DDL tem commit implícito e não é transacional/atomicamente reversível nesta versão.
ALTER pode reconstruir/bloquear tabela; exige janela e espaço livre. Dois DDLs podem deixar estado parcial.
As guardas recusam reaplicação, FK/CHECK desabilitadas, modo não estrito e versão divergente.
Não garantem sozinhas que a estrutura de origem seja autêntica: comparar SHOW CREATE com baseline revisado.

**Bloqueio de ativação:** serviço legado só reconhece validade de 15 minutos e não filtra tipo em todos
os caminhos. Antes de qualquer OTP real, atualizar e testar leitores/consumidores LINK para filtrar
`tipo='LINK'`, além de implementar validador OTP dedicado que verifique `invalidado_em` e pedido.
Não criar OTP reais usando o serviço atual. Não há fallback de OTP para LINK.

## Testes e isolamento

`tests/lojaDownloadRecuperacaoOtpPersistencia.test.js` reutiliza a fixture nativa existente.
Sem a seleção explícita abaixo a integração é ignorada; nunca usa .env ou pool da aplicação.

```bash
IST_LOJA_MARIADB_NATIVO_10339=true \
IST_R2_10339_MANIFEST=NATIVO_DESCARTAVEL_10339 \
node --test tests/lojaDownloadRecuperacaoOtpPersistencia.test.js
```

Fixture verifica binário 10.3.39, dono, datadir privado novo, socket exclusivo, PID,
porta 0/skip_networking e banco aleatório antes das escritas; sem fallback TCP/3307.
Bootstrap somente nesse datadir, processo encerrado e diretório removido em teardown.
Dados/segredos de teste sintéticos, sem código numérico real. DDL legado é reutilizado para fixture mínima;
o cenário não homologa novamente toda a migration D7.1 nem todos os fluxos financeiros.
Cobertura: legado, constraints, índices, FK obrigatória, unicidade, consumo condicional único,
contenção real, rollback de invalidação, contadores serializados, retenção e integridade financeira.

## Implantação futura e rollback

Não executar agora. Exigir autorização separada, backup consistente verificado, janela sem uso,
identidade (versão/socket/datadir/porta/banco) e SHOW CREATE antes de alterar.
Selecionar banco explicitamente; na mesma sessão definir `@ist_b7c3_schema` ao nome verificado e
`@ist_b7c3_autorizacao='FUNDACAO_OTP_B7_C3'`; executar arquivo integral com cliente que entenda DELIMITER,
parando no primeiro erro. Variáveis são barreiras contra acidente, não credenciais de autorização.
Nunca escolher banco/host por fallback. Guardar inventário de constraints, índices e contagem/hash legado
antes/depois, verificar equivalência dos dados antigos e escopo. Não criar OTP ainda.

Rollback preferencial antes de ativação: reverter código mantendo esquema aditivo; não há necessidade
de apagar colunas. Reversão física exige autorização, ausência comprovada de OTP/limites em uso e backup;
restaurar CHECK exata de 15 minutos somente após provar que todos os registros a satisfazem, remover FK,
índices/coluna gerada e campos novos e tabela de limites. Não destruir histórico para forçar rollback.
Falha entre DDLs: interromper, registrar SHOW CREATE real e decidir recuperação com revisão;
não reaplicar nem presumir que ROLLBACK desfaz ALTER/CREATE.

Referências oficiais:
- https://mariadb.com/docs/server/reference/sql-statements/data-definition/create/generated-columns
- https://mariadb.com/docs/server/reference/sql-statements/data-definition/constraint
- https://mariadb.com/docs/server/reference/sql-statements/transactions/sql-statements-that-cause-an-implicit-commit

## Estado atual para consolidação Git — 30/10/2026

As seções anteriores preservam o registro da etapa B7-C3 no momento de sua elaboração.
As indicações históricas de “não aplicado” não descrevem o estado operacional posterior.

- **Implementação:** a fundação OTP, o serviço, os endpoints HTTP e a interface Angular estão
  implementados no workspace. A migration de fundação permanece um artefato de criação/evolução
  inicial, não um script de reaplicação em estruturas existentes.
- **Homologação WSL2:** o schema OTP e o backend foram publicados nas etapas B7-C7; a recuperação
  funcional foi aprovada na B7-C8. Esse resultado é histórico e não foi reexecutado nesta consolidação.
- **Correção estrutural específica:** após a recriação da tabela de recuperações, foram identificadas
  seis CHECKs ausentes. A proposta aditiva foi validada com 17 cenários aprovados em MariaDB 10.3.39
  descartável, sem TCP e sem acesso ao banco persistente. O responsável confirmou em 30/10/2026 a
  instalação das seis definições canônicas em `istbrasil_homolog` e `istbrasil`:
  `ck_ldr_id`, `ck_ldr_tentativas`, `ck_ldr_desafio_data`, `ck_ldr_ciclo`, `ck_ldr_tipo` e
  `ck_ldr_invalidacao`. A pendência é considerada resolvida por essa confirmação operacional;
  esta preparação não executou SQL nem fez nova inspeção na VPS.
- **Não reaplicar automaticamente:** a restauração foi uma regularização específica da estrutura
  existente. Não foi criada migration de reaplicação automática, e não se deve executar novamente
  B7-C3 apenas porque seu arquivo passa a ser versionado. Conferir o estado real antes de qualquer DDL.
- **Limites da confirmação:** a presença das CHECKs não afirma mudança de charset, restauração de
  registros anteriores ou equivalência integral de todos os demais metadados. Esses pontos não foram
  alterados nesta preparação.

A evidência de testes das CHECKs é distinta das suítes de persistência OTP e da homologação funcional.
Os logs originais e backups são registros operacionais privados; não incluir dumps, credenciais ou
conteúdo de desafios no Git. O versionamento da migration não autoriza sua execução em nenhum ambiente.
