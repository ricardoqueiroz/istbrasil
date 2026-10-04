import { AdminAvaliacoesError, CAMPOS_ORDENACAO_ADMIN_AVALIACOES, consultarAndamentoAdmin } from '../../services/adminAvaliacoesService.js';

const inteiroPositivo = (valor) => {
    if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) return null;
    const numero = Number(valor);
    return Number.isSafeInteger(numero) ? numero : null;
};

export const listarAvaliacoesAdmin = async (req, res) => {
    const page = req.query.page === undefined ? 1 : inteiroPositivo(req.query.page);
    const solicitado = req.query.limit === undefined ? 25 : inteiroPositivo(req.query.limit);
    const limit = solicitado ? Math.min(solicitado, 100) : null;
    if (!page || !limit || !Number.isSafeInteger((page - 1) * limit)) {
        return res.status(400).json({ message: 'Pagina\u00e7\u00e3o inv\u00e1lida.' });
    }

    const sortField = req.query.sortField === undefined ? 'numeroConcorrente' : req.query.sortField;
    if (typeof sortField !== 'string' || !Object.prototype.hasOwnProperty.call(CAMPOS_ORDENACAO_ADMIN_AVALIACOES, sortField)) {
        return res.status(400).json({ message: 'Campo de ordena\u00e7\u00e3o inv\u00e1lido.' });
    }
    const order = req.query.sortOrder === undefined ? 'asc' : req.query.sortOrder;
    if (typeof order !== 'string' || !['asc', 'desc'].includes(order.toLowerCase())) {
        return res.status(400).json({ message: 'Dire\u00e7\u00e3o de ordena\u00e7\u00e3o inv\u00e1lida.' });
    }

    try {
        return res.status(200).json(await consultarAndamentoAdmin(req.params.slug, { page, limit, sortField, sortOrder: order.toLowerCase() }));
    } catch (error) {
        if (error instanceof AdminAvaliacoesError) return res.status(error.status).json({ message: error.message });
        console.error('Erro ao consultar andamento administrativo:', error);
        return res.status(500).json({ message: 'N\u00e3o foi poss\u00edvel consultar o andamento das avalia\u00e7\u00f5es.' });
    }
};