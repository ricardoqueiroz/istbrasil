# B7-C4 — Serviço OTP interno

> Registro histórico preservado. Consulte a seção “Estado atual para consolidação Git” ao final.

## Integração e pré-requisitos

Não publicado. Não há endpoints, SMTP, cookies novos, Angular ou carregamento de .env.
Aplicar a migration B7-C3 com autorização separada **antes de publicar o serviço modificado**:
os leitores LINK passam a consultar `tipo`, e a criação/consumo também requer os campos novos.
Não existe fallback para schema antigo nem detecção que enfraqueça o isolamento LINK/OTP.

A fachada `criarLojaDownloadRecuperacaoService` mantém seus métodos LINK e de sessão.
A opção interna `otp: {chaveCodigo, chaveLimites}` habilita os métodos abaixo.
As duas chaves devem ser Buffers de 32 bytes, independentes entre si e da chave de e-mail.
A configuração não foi ligada ao ambiente nesta fase. Versão criptográfica suportada: 1.
Rotação de chaves requer etapa futura coordenada, respeitando desafios e budgets vivos;
não trocar chaves para zerar limites ou assumir compatibilidade automática com outras versões.
`sortearCodigo` é injeção para testes; padrão `crypto.randomInt(0,1000000)`.

## Contratos internos

- `solicitarCodigo({email,pedidoPublicId,ip})` retorna
  `{resposta:{aceito:true,publicId}, entrega:null|{publicId,codigo,email,pedidoPublicId,validadeMinutos,expiraEm}}`.
  `publicId` aleatório também é retornado para pedidos inexistentes, inelegíveis ou limitados.
  O envelope `entrega` é exclusivamente interno, em memória, para futura composição SMTP.
  **Nunca serializar/logar esse envelope em HTTP**. Somente devolvê-lo ao compositor após commit confirmado.
- `validarCodigo({email,pedidoPublicId,ip,publicId,codigo})` retorna o contrato existente
  `{token,sessao:{publicId,criadaEm,expiraEm,direitos}}` após commit confirmado.
  Código deve ser string com seis dígitos, preservando zeros à esquerda.
  Desafio inexistente, expirado, consumido, invalidado, titular divergente ou limite excedido:
  `DESAFIO_INVALIDO`. Falhas técnicas: `RECUPERACAO_INDISPONIVEL`; commit/rollback incerto:
  `RESULTADO_DESCONHECIDO`. Sem retries internos.

O futuro adaptador HTTP deve usar somente `resposta`, tratar erros técnicos de forma uniforme,
resolver IP pela política confiável do servidor e preservar CSRF, cookies e anti-enumeração existentes.
O serviço rejeita IP sintaticamente inválido, normaliza IPv6 e não interpreta headers HTTP.
Não aceitar o parâmetro IP do corpo ou de X-Forwarded-For arbitrário.
Respostas uniformes não são garantia de tempo de execução constante; IPs compartilhados podem sofrer throttling.

## Persistência e limites

Código gerado com randomInt, seis dígitos; só HMAC-SHA256 persiste em `desafio_hash`.
MAC separado por domínio/versão e contexto PayPal (provedor, ambiente, conta), publicId,
pedido interno, hash protegido do e-mail e código. Comparação de Buffers com timingSafeEqual.
Sem logs de código, token ou parâmetros.

Mesma tabela de limites B7-C3, chaves HMAC distintas por IP, par e-mail/pedido e pedido associado.
Nenhum IP/e-mail bruto é persistido nessa tabela. Pedidos não associados nunca recebem débito
no bucket PEDIDO e seus desafios não são invalidados. Toda consulta conta no IP, inclusive entrada
malformada, desafio inexistente e tentativas de validar LINK como OTP.

Política da B7-C3: janela de 10 minutos; 20 consultas/IP/janela; três solicitações aceitas por
par/pedido/janela, cooldown de 60 segundos; cinco erros acumulados por par e pedido na janela,
além das cinco tentativas por desafio. Reenvio invalida o OTP aberto e cria outro atomicamente,
sem apagar contadores nem liberar cooldown. Ao esgotar o orçamento acumulado, o desafio atual
é invalidado mesmo que tenha menos de cinco erros próprios. Reiniciar o serviço com as mesmas
chaves não altera o orçamento. Janela expirada permite novo orçamento, respeitando cooldown/bloqueio.

Pedido/e-mail e direitos elegíveis são verificados antes da emissão e novamente no consumo.
Não se altera pedido, pagamento, estado de direito ou evento financeiro.

## Reutilização e ordem de locks

Os dois fluxos usam a mesma transação READ COMMITTED, geração/hash de sessão de 24 horas,
fixação do escopo, consulta e revogação de sessão. Nenhuma transação aninhada.
LINK conserva seu escopo original de compras elegíveis do titular e validade de 15 minutos.
OTP restringe o mesmo mecanismo de escopo ao pedido informado, com validade de dez minutos.
Apenas consumo LINK filtra LINK; os leitores de sessão continuam compartilhados pelos dois tipos.

Locks: limites em ordem binária IP → PEDIDO → TITULAR; desafios existentes por id crescente;
depois sessões de compra → pedidos → pagamentos → operações → eventos → direitos,
como no mecanismo existente. Emissão verifica elegibilidade sem persistir vínculos de sessão;
consumo fixa os vínculos e marca consumo na mesma transação. Desafio novo é inserido sob o
bucket PEDIDO já bloqueado, depois de verificar elegibilidade; não disputa uma recuperação existente.
Unicidade B7-C3 mantém no máximo um OTP aberto por pedido.

Erros de código são confirmados na transação antes de lançar DESAFIO_INVALIDO.
Falha de escrita reverte invalidação, contadores e sessão/vínculos juntos.
Commit incerto destrói conexão e não expõe código/token; não repetir cegamente validação ou emissão.
Pode haver desafio/sessão consumido no banco sem token entregue: é uma indisponibilidade segura,
a ser tratada pelo fluxo posterior, nunca pelo retorno de um segredo sem ACK de commit.

## Validação

Testes em `tests/lojaDownloadRecuperacaoOtpService.test.js`, com fixture existente, dados sintéticos,
MariaDB 10.3.39 descartável, socket privado, porta 0/TCP desabilitado, sem pool/.env da aplicação.
O teste reusa o DDL legado para montar a fixture e executa B7-C3 somente nesse banco verificado.

```bash
IST_LOJA_MARIADB_NATIVO_10339=true \
IST_R2_10339_MANIFEST=NATIVO_DESCARTAVEL_10339 \
node --test tests/lojaDownloadRecuperacaoOtpService.test.js
```

Sem seleção explícita, integração é ignorada. Não há fallback para homologação.
Cobre zeros, HMAC, expiração, cinco erros, reenvio, quotas, concorrência real, LINK,
isolamento, escopo, rollback de escrita/escopo e falhas simuladas de ACK antes/depois do commit real.
Não simula crash do servidor MariaDB ou todos os deadlocks possíveis.

## Pendências

1. Revisar serviço, política e contratos internos.
2. Autorizar implantação da migration e código em etapa separada, com backup/rollback coordenados.
3. Integrar HTTP: respostas uniformes, transporte seguro de publicId, CSRF/cookies existentes, IP confiável.
4. Integrar compositor administrativo B7-C2 e transporte SMTP estrito após commit, sem logs de envelope.
   Não há fila ou garantia de entrega adicionada: falha SMTP deve respeitar cooldown e quotas.
5. Homologar fluxo com Mailpit e teste funcional de direitos/downloads; nenhuma mensagem enviada nesta fase.

## Estado atual para consolidação Git — 30/10/2026

O texto anterior preserva o escopo original da B7-C4. As pendências ali enumeradas foram tratadas
nas etapas posteriores; não significam que o sistema atual continue sem HTTP, SMTP ou Angular.

- **Implementação:** a fachada de recuperação e o módulo OTP estão integrados. Permanecem geração
  criptográfica de seis dígitos, persistência HMAC, validade de dez minutos, cinco erros, limites
  persistentes, consumo único e emissão de sessão somente após commit conhecido. LINK conserva seu
  fluxo e validade de 15 minutos, com separação explícita entre os tipos.
- **Testes existentes:** as suítes de persistência, serviço e HTTP usam dados sintéticos e MariaDB
  descartável ou mocks. A cobertura inclui reenvio, concorrência, escopo, rollback e commit incerto.
  Esta preparação apenas inspeciona e verifica estaticamente os artefatos; não reexecuta essas suítes.
- **Publicação na homologação:** backend e configuração foram ativados nas etapas B7-C7, seguidos
  da publicação Angular. O registro B7-C8 informa recuperação aprovada, validação do código, cookie,
  escopo do pedido, acesso à biblioteca/download e rejeição de reutilização. Trata-se de resultado
  anterior à regularização estrutural mais recente, não de nova homologação nesta preparação.
- **Schema:** a instalação das seis CHECKs canônicas foi confirmada pelo responsável nos dois bancos
  em 30/10/2026. Ver a seção de estado atual do documento B7-C3; não há reaplicação automática.
- **Produção/live:** o serviço admite contexto financeiro sandbox ou live, mas isso não comprova
  implantação ou teste funcional live na VPS. A confirmação estrutural do responsável não equivale
  à publicação de código, configuração de SMTP/chaves ou autorização de envios em produção.

As chaves de e-mail, OTP e limites são independentes e pertencem ao ambiente, nunca ao repositório.
Preservar os controles e a capacidade de recuperação de transações incertas. Nenhum endpoint, sessão,
SMTP, registro financeiro ou direito digital foi acionado por esta preparação documental.
