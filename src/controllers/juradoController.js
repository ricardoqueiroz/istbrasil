import { listarEventosAutorizadosJurado } from '../services/juradoAccessService.js';
import { CAMPOS_ORDENACAO_FILA, consultarFilaJurado } from '../services/juradoFilaService.js';

export const listarAcessosJurado = async (req, res) => {
    try {
        const eventos = await listarEventosAutorizadosJurado(req.usuario.id_usuario);
        return res.status(200).json({ eventos });
    } catch (error) {
        console.error('Erro ao consultar acessos de jurado:', error);
        return res.status(500).json({ message: 'Não foi possível consultar os acessos.' });
    }
};

export const obterEventoJurado = (req, res) => {
    return res.status(200).json({ evento: req.eventoJurado });
};

const inteiroPositivo = (valor, padrao) => {
    if (valor === undefined) return padrao;
    if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) return null;
    const numero = Number(valor);
    return Number.isSafeInteger(numero) ? numero : null;
};

export const listarConcorrentesJurado = async (req, res) => {
    const page = inteiroPositivo(req.query.page, 1);
    const limit = inteiroPositivo(req.query.limit, 25);
    if (!page || !limit || limit > 100 || !Number.isSafeInteger((page - 1) * limit)) {
        return res.status(400).json({ message: 'Paginação inválida.' });
    }

    const sort = req.query.sort === undefined ? 'numeroConcorrente' : req.query.sort;
    if (typeof sort !== 'string' || !Object.prototype.hasOwnProperty.call(CAMPOS_ORDENACAO_FILA, sort)) {
        return res.status(400).json({ message: 'Campo de ordenação inválido.' });
    }
    const order = req.query.order === undefined ? 'asc' : req.query.order;
    if (typeof order !== 'string' || (order !== 'asc' && order !== 'desc')) {
        return res.status(400).json({ message: 'Direção de ordenação inválida.' });
    }

    try {
        const { id, slug, nome } = req.eventoJurado;
        const { rows, total } = await consultarFilaJurado(id, { page, limit, sort, order });
        const concorrentes = rows.map((row) => ({
            idParticipacao: row.id_concorrente,
            numeroConcorrente: row.numero_concorrente,
            nome: row.nome,
            cidade: row.cidade,
            uf: row.uf,
            dataInscricao: row.data_cadastro,
            obraPrincipal: { id: row.id_obra_1, titulo: row.titulo_obra_1 },
            linkVideoPrincipal: row.link_video_1,
            obraOpcional: row.id_obra_2 === null ? null : { id: row.id_obra_2, titulo: row.titulo_obra_2 },
            linkVideoOpcional: row.link_video_2 || null
        }));
        return res.status(200).json({
            evento: { id, slug, nome },
            concorrentes,
            pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) }
        });
    } catch (error) {
        console.error('Erro ao consultar fila de jurado:', error);
        return res.status(500).json({ message: 'Não foi possível consultar a fila de concorrentes.' });
    }
};