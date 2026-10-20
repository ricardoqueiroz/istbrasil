import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pool } from '../config/db.js';
import { prepararItensNaConexao, contextoComercialBackend } from './lojaCatalogoService.js';
import { CONTRATO_PEDIDO, criarErroPedido, validarSolicitacaoPedido, validarChaveIdempotencia,
    gerarHashSolicitacaoPedido, pedidoPublico } from './lojaPedidoContratos.js';

const interno = () => criarErroPedido('ERRO_INTERNO');
const temporario = () => criarErroPedido('CONTENCAO_TEMPORARIA');
const uint32 = n => Number.isInteger(n) && n > 0 && n <= 4294967295;
const sqlUtc = iso => iso.slice(0, 23).replace('T', ' ');
const lerUtc = valor => {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}000Z$/.test(valor)) throw interno();
    const iso = valor.slice(0, 23) + 'Z';
    if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw interno();
    return iso;
};
const instanteUtc = agora => {
    const valor = agora();
    if (!(valor instanceof Date) || !Number.isFinite(valor.getTime()) || valor.getUTCFullYear() < 1000 || valor.getUTCFullYear() > 9999) throw interno();
    return valor.toISOString();
};
const inteiroMonetario = valor => {
    if (typeof valor === 'string' && /^\d+$/.test(valor)) valor = Number(valor);
    if (!Number.isSafeInteger(valor) || valor <= 0) throw interno();
    return valor;
};
const transitorio = erro => ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(erro?.code)
    || [1205, 1213].includes(erro?.errno);
const indiceDuplicado = erro => {
    if (erro?.code !== 'ER_DUP_ENTRY' && erro?.errno !== 1062) return null;
    const indice = /for key ['`"]([^'`"]+)['`"]/i.exec(erro.sqlMessage ?? erro.message ?? '')?.[1];
    return indice?.split('.').at(-1) ?? null;
};
const descartar = conexao => { try { conexao.destroy(); } catch {} };
const erroSeguro = erro => criarErroPedido(erro?.codigo);

const validarSessaoTemporal = (sessao, agora) => {
    if (!sessao || sessao.revogada !== 0) throw criarErroPedido('SESSAO_INVALIDA');
    const criada = Date.parse(sessao.criadaEm);
    const expira = Date.parse(sessao.expiraEm);
    const atual = Date.parse(agora);
    if (!uint32(sessao.id) || criada > atual || expira <= atual || expira <= criada
        || expira - criada > CONTRATO_PEDIDO.sessaoDuracaoSegundos * 1000) throw criarErroPedido('SESSAO_INVALIDA');
};
const bloquearSessao = async (conexao, id, agora) => {
    const [[linha]] = await conexao.query(`SELECT id,
        DATE_FORMAT(criada_em, '%Y-%m-%dT%H:%i:%s.%fZ') AS criada_em_utc,
        DATE_FORMAT(expira_em, '%Y-%m-%dT%H:%i:%s.%fZ') AS expira_em_utc,
        (revogada_em IS NOT NULL) AS revogada
        FROM ist_loja_sessoes WHERE id = ? FOR UPDATE`, [id]);
    if (!linha) throw criarErroPedido('SESSAO_INVALIDA');
    const sessao = { id: linha.id, criadaEm: lerUtc(linha.criada_em_utc), expiraEm: lerUtc(linha.expira_em_utc), revogada: linha.revogada };
    // O lock pode ter aguardado outra transacao: usar o relogio APOS a leitura.
    validarSessaoTemporal(sessao, instanteUtc(agora));
    return sessao;
};
const procurarPedido = async (conexao, sessaoId, chave) => {
    const [[linha]] = await conexao.query(`SELECT id, public_id, sessao_id, comprador_email, estado, ambiente, moeda,
        total_centavos, solicitacao_hash, versao,
        DATE_FORMAT(criado_em, '%Y-%m-%dT%H:%i:%s.%fZ') AS criado_em_utc,
        DATE_FORMAT(atualizado_em, '%Y-%m-%dT%H:%i:%s.%fZ') AS atualizado_em_utc,
        DATE_FORMAT(expira_em, '%Y-%m-%dT%H:%i:%s.%fZ') AS expira_em_utc
        FROM ist_loja_pedidos WHERE sessao_id = ? AND idempotencia_criacao = ? LIMIT 1`, [sessaoId, chave]);
    if (!linha) return null;
    if (!uint32(linha.id)) throw interno();
    return { ...linha, criado_em: lerUtc(linha.criado_em_utc), atualizado_em: lerUtc(linha.atualizado_em_utc), expira_em: lerUtc(linha.expira_em_utc) };
};
const compararHash = (pedido, hash) => {
    if (!Buffer.isBuffer(pedido.solicitacao_hash) || pedido.solicitacao_hash.length !== 32) throw interno();
    if (!timingSafeEqual(pedido.solicitacao_hash, hash)) throw criarErroPedido('CONFLITO_IDEMPOTENCIA');
};
const lerItens = async (conexao, pedidoId) => {
    const [itens] = await conexao.query(`SELECT produto_id, posicao, sku_snapshot, titulo_snapshot, descricao_snapshot,
        tipo_snapshot, quantidade, preco_unitario_centavos, subtotal_centavos
        FROM ist_loja_pedido_itens WHERE pedido_id = ? ORDER BY posicao`, [pedidoId]);
    return itens;
};
const conferirItens = (itens, ids) => {
    if (!Array.isArray(itens) || itens.length !== ids.length) throw interno();
    const produtos = new Set();
    let total = 0;
    for (const item of itens) {
        if (!ids.includes(item.produto_id) || produtos.has(item.produto_id) || item.quantidade !== 1) throw interno();
        produtos.add(item.produto_id);
        const preco = inteiroMonetario(item.preco_unitario_centavos);
        const subtotal = inteiroMonetario(item.subtotal_centavos);
        if (preco !== subtotal) throw interno();
        total += subtotal;
        if (!Number.isSafeInteger(total)) throw interno();
    }
    return total;
};
const projetarPersistido = (pedido, itens, ids, sessao) => {
    const total = conferirItens(itens, ids);
    if (total !== inteiroMonetario(pedido.total_centavos) || pedido.sessao_id !== sessao.id
        || pedido.expira_em > sessao.expiraEm || pedido.atualizado_em < pedido.criado_em) throw interno();
    return pedidoPublico(pedido, itens);
};

const criarDireitoInicialNaConexao = async (c, itemId, produtoId, versaoId, data, gerarUuid) => {
    const publicId = validarChaveIdempotencia(gerarUuid());
    const [r] = await c.query(`INSERT INTO ist_loja_download_direitos
        (public_id,pedido_item_id,produto_id,arquivo_versao_id,estado,versao,criado_em,atualizado_em)
        VALUES(?,?,?,?,'AGUARDANDO_CONFIRMACAO',1,?,?)`, [publicId,itemId,produtoId,versaoId,data,data]);
    if (!uint32(r.insertId) || r.affectedRows !== 1 || r.warningStatus > 0) throw interno();
    const [e] = await c.query(`INSERT INTO ist_loja_download_direito_eventos
        (direito_id,direito_versao,estado_anterior,estado_novo,origem,motivo_codigo,ocorrido_em)
        VALUES(?,1,NULL,'AGUARDANDO_CONFIRMACAO','PEDIDO','DIREITO_CRIADO',?)`, [r.insertId,data]);
    if (e.affectedRows !== 1 || e.warningStatus > 0) throw interno();
    return { itemId, produtoId, versaoId, publicId };
};
const conferirDireitosDaTentativa = async (c, esperados) => {
    for (const x of esperados) {
        const [rows] = await c.query(`SELECT d.public_id,d.produto_id,d.arquivo_versao_id,
            e.estado_anterior,e.estado_novo,e.origem,e.motivo_codigo
            FROM ist_loja_download_direitos d JOIN ist_loja_download_direito_eventos e
              ON e.direito_id=d.id AND e.direito_versao=1 WHERE d.pedido_item_id=?`, [x.itemId]);
        if (rows.length !== 1 || rows[0].public_id !== x.publicId || rows[0].produto_id !== x.produtoId
            || rows[0].arquivo_versao_id !== x.versaoId || rows[0].estado_anterior !== null
            || rows[0].estado_novo !== 'AGUARDANDO_CONFIRMACAO' || rows[0].origem !== 'PEDIDO'
            || rows[0].motivo_codigo !== 'DIREITO_CRIADO') throw interno();
    }
};

/** Servico INTERNO, sem adapter HTTP.
 * criarPedido(sessaoValidada, solicitacao, chaveIdempotencia)
 * sessaoValidada e contexto confiavel do mecanismo 65.2 (res.locals.sessaoLoja),
 * NUNCA um id vindo do JSON/URL. Revalida a linha sob FOR UPDATE; nao recebe token.
 * ambiente e definido exclusivamente nesta fabrica pelo servidor, fora do payload.
 */
export const criarLojaPedidoService = ({ db = pool, ambiente = CONTRATO_PEDIDO.ambienteInicial,
    agora = () => new Date(), gerarUuid = randomUUID, prepararItens = prepararItensNaConexao,
    contextoComercial = contextoComercialBackend() } = {}) => {
    const obterConexaoConfigurada = async () => {
        const conexao = await db.getConnection();
        try {
            // MariaDB rejeita esta instrucao se houver transacao anterior aberta.
            // Falha aqui nao comprova conexao limpa: nunca devolve-la ao pool.
            await conexao.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            return conexao;
        } catch (erro) {
            descartar(conexao);
            throw erro;
        }
    };
    const reconciliar = async (sessaoId, chave, hash, ids, publicIdCriado = null, direitosEsperados = []) => {
        let conexao;
        let iniciada = false;
        try {
            // Nova conexao e lock da sessao aguardam o desfecho da transacao anterior.
            conexao = await obterConexaoConfigurada();
            iniciada = true;
            await conexao.beginTransaction();
            const sessao = await bloquearSessao(conexao, sessaoId, agora);
            const pedido = await procurarPedido(conexao, sessaoId, chave);
            if (!pedido) throw temporario(); // Nunca repetir cegamente a criacao.
            compararHash(pedido, hash);
            const publico = projetarPersistido(pedido, await lerItens(conexao, pedido.id), ids, sessao);
            if (publicIdCriado !== null) {
                if (pedido.public_id !== publicIdCriado) throw interno();
                await conferirDireitosDaTentativa(conexao, direitosEsperados);
            }
            validarSessaoTemporal(sessao, instanteUtc(agora));
            await conexao.commit();
            iniciada = false;
            return { pedido: publico, criado: publicIdCriado === pedido.public_id };
        } catch (erro) {
            if (conexao && iniciada) {
                try { await conexao.rollback(); }
                catch { descartar(conexao); conexao = null; }
            }
            if (['SESSAO_INVALIDA', 'CONFLITO_IDEMPOTENCIA'].includes(erro?.codigo)) throw erroSeguro(erro);
            throw temporario();
        } finally { if (conexao) conexao.release(); }
    };

    const criarPedidoComResultado = async (sessaoValidada, entrada, chaveIdempotencia) => {
        const solicitacao = validarSolicitacaoPedido(entrada);
        const chave = validarChaveIdempotencia(chaveIdempotencia);
        if (!sessaoValidada || !uint32(sessaoValidada.id)) throw criarErroPedido('SESSAO_INVALIDA');
        const sessaoId = sessaoValidada.id;
        const hash = gerarHashSolicitacaoPedido(solicitacao, ambiente);
        for (let tentativa = 1; tentativa <= 3; tentativa++) {
            let conexao;
            let iniciada = false;
            let commitIniciado = false;
            let publicIdCriado = null;
            const direitosEsperados = [];
            try {
                conexao = await obterConexaoConfigurada();
                iniciada = true;
                await conexao.beginTransaction();
                const sessao = await bloquearSessao(conexao, sessaoId, agora);
                let pedido = await procurarPedido(conexao, sessaoId, chave);
                let publico;
                if (pedido) {
                    compararHash(pedido, hash);
                    publico = projetarPersistido(pedido, await lerItens(conexao, pedido.id), solicitacao.produtoIds, sessao);
                    // Repeticoes devolvem o estado armazenado, mesmo apos a validade
                    // original do pedido; nao renovam datas nem recriam/cotam itens.
                } else {
                    const preparados = await prepararItens(conexao, solicitacao.produtoIds,
                        { ...contextoComercial, ambientePedido: ambiente });
                    if (preparados.moeda !== CONTRATO_PEDIDO.moeda) throw interno();
                    if (!(preparados.versoes instanceof Map)) throw interno();
                    const total = conferirItens(preparados.itens, solicitacao.produtoIds);
                    const criadoEm = instanteUtc(agora);
                    validarSessaoTemporal(sessao, criadoEm);
                    const expiraEm = new Date(Math.min(Date.parse(criadoEm) + CONTRATO_PEDIDO.pedidoValidadeSegundos * 1000, Date.parse(sessao.expiraEm))).toISOString();
                    let publicId;
                    try { publicId = validarChaveIdempotencia(gerarUuid()); } catch { throw interno(); }
                    const [inserido] = await conexao.query(`INSERT INTO ist_loja_pedidos
                        (public_id, sessao_id, comprador_email, estado, ambiente, moeda, total_centavos,
                        idempotencia_criacao, solicitacao_hash, versao, criado_em, atualizado_em, expira_em)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [publicId, sessaoId, solicitacao.compradorEmail, CONTRATO_PEDIDO.estadoInicial, ambiente,
                        CONTRATO_PEDIDO.moeda, total, chave, hash, CONTRATO_PEDIDO.versaoInicial, sqlUtc(criadoEm), sqlUtc(criadoEm), sqlUtc(expiraEm)]);
                    if (!uint32(inserido.insertId) || inserido.warningStatus > 0) throw interno();
                    publicIdCriado = publicId;
                    for (const [indice, item] of preparados.itens.entries()) {
                        const [resultado] = await conexao.query(`INSERT INTO ist_loja_pedido_itens
                            (pedido_id, produto_id, posicao, sku_snapshot, titulo_snapshot, descricao_snapshot,
                            tipo_snapshot, quantidade, preco_unitario_centavos, subtotal_centavos)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [inserido.insertId, item.produto_id, indice + 1, item.sku_snapshot, item.titulo_snapshot,
                            item.descricao_snapshot, item.tipo_snapshot, item.quantidade, item.preco_unitario_centavos, item.subtotal_centavos]);
                        if (!uint32(resultado.insertId) || resultado.affectedRows !== 1 || resultado.warningStatus > 0) throw interno();
                        if (!preparados.versoes.has(item.produto_id)) throw interno();
                        const versaoId = preparados.versoes.get(item.produto_id);
                        if (versaoId !== null) {
                            if (!uint32(versaoId)) throw interno();
                            direitosEsperados.push(await criarDireitoInicialNaConexao(conexao, resultado.insertId,
                                item.produto_id, versaoId, sqlUtc(criadoEm), gerarUuid));
                        }
                    }
                    pedido = await procurarPedido(conexao, sessaoId, chave);
                    if (!pedido || pedido.id !== inserido.insertId || pedido.public_id !== publicId
                        || pedido.comprador_email !== solicitacao.compradorEmail || pedido.ambiente !== ambiente
                        || pedido.estado !== CONTRATO_PEDIDO.estadoInicial || pedido.versao !== CONTRATO_PEDIDO.versaoInicial
                        || pedido.moeda !== CONTRATO_PEDIDO.moeda || pedido.criado_em !== criadoEm
                        || pedido.atualizado_em !== criadoEm || pedido.expira_em !== expiraEm
                        || inteiroMonetario(pedido.total_centavos) !== total) throw interno();
                    compararHash(pedido, hash);
                    const persistidos = await lerItens(conexao, pedido.id);
                    publico = projetarPersistido(pedido, persistidos, solicitacao.produtoIds, sessao);
                    for (const [indice, item] of persistidos.entries()) {
                        const original = preparados.itens[indice];
                        if (item.posicao !== indice + 1 || Object.keys(original).some(campo =>
                            ['preco_unitario_centavos', 'subtotal_centavos'].includes(campo)
                                ? inteiroMonetario(item[campo]) !== original[campo] : item[campo] !== original[campo])) throw interno();
                    }
                    const agoraFinal = instanteUtc(agora);
                    if (agoraFinal < criadoEm || agoraFinal >= expiraEm) throw temporario();
                }
                validarSessaoTemporal(sessao, instanteUtc(agora));
                commitIniciado = true;
                await conexao.commit();
                iniciada = false;
                return { pedido: publico, criado: publicIdCriado !== null };
            } catch (erro) {
                if (commitIniciado) {
                    // Nao sabemos se COMMIT ocorreu. Fechar, nunca devolver ao pool,
                    // e consultar em nova conexao sem emitir INSERT novamente.
                    descartar(conexao); conexao = null;
                    return reconciliar(sessaoId, chave, hash, solicitacao.produtoIds, publicIdCriado, direitosEsperados);
                }
                if (conexao && iniciada) {
                    try { await conexao.rollback(); }
                    catch { descartar(conexao); conexao = null; throw interno(); }
                }
                if (indiceDuplicado(erro) === 'uq_loja_pedidos_sessao_idempotencia') {
                    if (conexao) { conexao.release(); conexao = null; }
                    return reconciliar(sessaoId, chave, hash, solicitacao.produtoIds);
                }
                // public_id, PRIMARY e quaisquer outras colisoes nao sao replay.
                if (transitorio(erro)) {
                    if (tentativa < 3) continue;
                    throw temporario();
                }
                throw erroSeguro(erro);
            } finally { if (conexao) conexao.release(); }
        }
        throw temporario();
    };
    // Interface anterior preservada; o adapter HTTP usa metadado explicito, nao o estado.
    const criarPedido = async (...args) => (await criarPedidoComResultado(...args)).pedido;
    return { criarPedido, criarPedidoComResultado };
};

export const { criarPedido, criarPedidoComResultado } = criarLojaPedidoService();
