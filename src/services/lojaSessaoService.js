import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../config/db.js';
import { CONTRATO_PEDIDO, criarErroPedido } from './lojaPedidoContratos.js';

const duracaoMs = CONTRATO_PEDIDO.sessaoDuracaoSegundos * 1000;
export const tokenSessaoValido = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    && Buffer.from(token, 'base64url').length === 32 && Buffer.from(token, 'base64url').toString('base64url') === token;

export const hashTokenSessao = (token) => {
    if (!tokenSessaoValido(token)) throw criarErroPedido('SESSAO_INVALIDA');
    return createHash('sha256').update(token, 'utf8').digest();
};

export const criarTokenCsrf = (token, segredo) => {
    if (!tokenSessaoValido(token)) throw criarErroPedido('SESSAO_INVALIDA');
    if (!Buffer.isBuffer(segredo) || segredo.length !== 32) throw criarErroPedido('ERRO_INTERNO');
    return createHmac('sha256', segredo).update('ist-loja/csrf/v1\0', 'utf8')
        .update(Buffer.from(token, 'base64url')).digest('base64url');
};

export const csrfValido = (csrf, token, segredo) => {
    if (!tokenSessaoValido(csrf)) return false;
    const esperado = Buffer.from(criarTokenCsrf(token, segredo), 'base64url');
    return timingSafeEqual(Buffer.from(csrf, 'base64url'), esperado);
};

const dataAtual = (agora) => {
    const data = agora();
    if (!(data instanceof Date) || !Number.isFinite(data.getTime())) throw criarErroPedido('ERRO_INTERNO');
    return new Date(data.getTime());
};
const sqlUtc = (data) => data.toISOString().slice(0, 23).replace('T', ' ');
const lerUtc = (valor) => {
    // DATE_FORMAT retorna seis casas; DATETIME(3) preenche as ultimas com zero.
    // Evita que mysql2 interprete DATETIME no fuso local do processo.
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}000Z$/.test(valor)) throw criarErroPedido('ERRO_INTERNO');
    const iso = valor.slice(0, 23) + 'Z';
    if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw criarErroPedido('ERRO_INTERNO');
    return iso;
};

export const criarLojaSessaoService = ({ db = pool, agora = () => new Date(), aleatorio = randomBytes } = {}) => {
    const consultar = async (sql, params) => {
        try { return await db.execute(sql, params); } catch { throw criarErroPedido('ERRO_INTERNO'); }
    };
    const obterSessao = async (token) => {
        const hash = hashTokenSessao(token);
        const [linhas] = await consultar(`SELECT id,
            DATE_FORMAT(criada_em, '%Y-%m-%dT%H:%i:%s.%fZ') AS criada_em_utc,
            DATE_FORMAT(expira_em, '%Y-%m-%dT%H:%i:%s.%fZ') AS expira_em_utc,
            (revogada_em IS NOT NULL) AS revogada
            FROM ist_loja_sessoes WHERE token_hash = ? LIMIT 1`, [hash]);
        const linha = linhas[0];
        if (!linha || linha.revogada !== 0) throw criarErroPedido('SESSAO_INVALIDA');
        if (!Number.isInteger(linha.id) || linha.id <= 0 || linha.id > 4294967295) throw criarErroPedido('ERRO_INTERNO');
        const criadaEm = lerUtc(linha.criada_em_utc);
        const expiraEm = lerUtc(linha.expira_em_utc);
        const instante = dataAtual(agora).getTime();
        if (Date.parse(criadaEm) > instante || Date.parse(expiraEm) <= instante
            || Date.parse(expiraEm) <= Date.parse(criadaEm) || Date.parse(expiraEm) - Date.parse(criadaEm) > duracaoMs) {
            throw criarErroPedido('SESSAO_INVALIDA');
        }
        return { id: linha.id, criadaEm, expiraEm };
    };
    const estabelecerSessao = async (tokenAnterior) => {
        if (tokenSessaoValido(tokenAnterior)) {
            try { return { nova: false, token: tokenAnterior, sessao: await obterSessao(tokenAnterior) }; }
            catch (erro) { if (erro.codigo !== 'SESSAO_INVALIDA') throw erro; }
        }
        for (let tentativa = 0; tentativa < 3; tentativa++) {
            const bytes = aleatorio(32);
            if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw criarErroPedido('ERRO_INTERNO');
            const token = bytes.toString('base64url');
            const criada = dataAtual(agora);
            const expira = new Date(criada.getTime() + duracaoMs);
            let resultado;
            try {
                [resultado] = await db.execute(`INSERT INTO ist_loja_sessoes (token_hash, criada_em, expira_em, revogada_em)
                    VALUES (?, ?, ?, NULL)`, [hashTokenSessao(token), sqlUtc(criada), sqlUtc(expira)]);
            } catch (erro) {
                if (erro.code === 'ER_DUP_ENTRY' || erro.errno === 1062) continue;
                throw criarErroPedido('ERRO_INTERNO');
            }
            if (!Number.isInteger(resultado.insertId) || resultado.insertId <= 0 || resultado.insertId > 4294967295) throw criarErroPedido('ERRO_INTERNO');
            return { nova: true, token, sessao: { id: resultado.insertId, criadaEm: criada.toISOString(), expiraEm: expira.toISOString() } };
        }
        throw criarErroPedido('ERRO_INTERNO');
    };
    const revogarSessao = async (token) => {
        const hash = hashTokenSessao(token);
        const instante = sqlUtc(dataAtual(agora));
        const [resultado] = await consultar(`UPDATE ist_loja_sessoes SET revogada_em = ?
            WHERE token_hash = ? AND revogada_em IS NULL AND criada_em <= ?`, [instante, hash, instante]);
        return resultado.affectedRows > 0;
    };
    return { estabelecerSessao, obterSessao, revogarSessao };
};
