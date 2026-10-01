import { pool as db } from '../../config/db.js';

const LIMITE_PADRAO = 25;
const LIMITE_MAXIMO = 100;

const CAMPOS_ORDENACAO = Object.freeze({
    nome: 'u.nome',
    email: 'u.email',
    tipo: 'tu.descricao',
    cargo: 'c.nome_cargo',
    situacao: 's.situacao',
    dataCadastro: 'u.data_cadastro'
});

const inteiroPositivo = (valor) => {
    const numero = Number(valor);
    return Number.isInteger(numero) && numero > 0 ? numero : null;
};

const responderErroInterno = (res, contexto, error) => {
    console.error(contexto, error);
    return res.status(500).json({ message: 'Não foi possível concluir a consulta administrativa.' });
};

const mapearUsuarioLista = (usuario) => ({
    idUsuario: usuario.id_usuario,
    nome: usuario.nome,
    email: usuario.email,
    idTipoUsuario: usuario.id_tipo_usuario,
    tipo: usuario.tipo,
    idCargo: usuario.id_cargo,
    cargo: usuario.cargo,
    idSituacao: usuario.id_situacao,
    situacao: usuario.situacao,
    emailConfirmado: Boolean(usuario.email_confirmado),
    dataCadastro: usuario.data_cadastro
});

const mapearUsuarioDetalhe = (usuario) => ({
    idUsuario: usuario.id_usuario,
    nome: usuario.nome,
    cpf: usuario.cpf,
    identidade: usuario.identidade,
    dataNascimento: usuario.data_nascimento,
    idTipoUsuario: usuario.id_tipo_usuario,
    tipo: usuario.tipo,
    idCargo: usuario.id_cargo,
    cargo: usuario.cargo,
    idSituacao: usuario.id_situacao,
    situacao: usuario.situacao,
    email: usuario.email,
    telefoneCelular: usuario.telefone_celular,
    logradouro: usuario.logradouro,
    numero: usuario.numero,
    complemento: usuario.complemento,
    bairro: usuario.bairro,
    cidade: usuario.cidade,
    uf: usuario.uf,
    cep: usuario.cep,
    foto: usuario.foto,
    curriculo: usuario.curriculo,
    emailConfirmado: Boolean(usuario.email_confirmado),
    celularConfirmado: Boolean(usuario.celular_confirmado),
    dataCadastro: usuario.data_cadastro,
    dataAtualizacao: usuario.data_atualizacao
});

export const listarUsuariosAdmin = async (req, res) => {
    const page = req.query.page === undefined ? 1 : inteiroPositivo(req.query.page);
    const limiteSolicitado = req.query.limit === undefined ? LIMITE_PADRAO : inteiroPositivo(req.query.limit);

    if (!page || !limiteSolicitado) {
        return res.status(400).json({ message: 'Paginação inválida.' });
    }

    const limit = Math.min(limiteSolicitado, LIMITE_MAXIMO);
    const offset = (page - 1) * limit;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    if (search.length > 255) {
        return res.status(400).json({ message: 'A busca deve ter no máximo 255 caracteres.' });
    }

    const filtrosIds = [
        ['idTipoUsuario', 'u.id_tipo_usuario'],
        ['idCargo', 'u.id_cargo'],
        ['idSituacao', 'u.id_situacao']
    ];
    const condicoes = [];
    const parametrosFiltros = [];

    if (search) {
        condicoes.push('(u.nome LIKE ? OR u.email LIKE ?)');
        parametrosFiltros.push(`%${search}%`, `%${search}%`);
    }

    for (const [parametro, coluna] of filtrosIds) {
        if (req.query[parametro] === undefined || req.query[parametro] === '') continue;
        const id = inteiroPositivo(req.query[parametro]);
        if (!id) {
            return res.status(400).json({ message: `Filtro ${parametro} inválido.` });
        }
        condicoes.push(`${coluna} = ?`);
        parametrosFiltros.push(id);
    }

    const sortField = req.query.sortField === undefined ? 'nome' : req.query.sortField;
    if (typeof sortField !== 'string' || !Object.prototype.hasOwnProperty.call(CAMPOS_ORDENACAO, sortField)) {
        return res.status(400).json({ message: 'Campo de ordenação inválido.' });
    }
    const colunaOrdenacao = CAMPOS_ORDENACAO[sortField];

    const sortOrder = req.query.sortOrder === undefined ? 'asc' : String(req.query.sortOrder).toLowerCase();
    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
        return res.status(400).json({ message: 'Direção de ordenação inválida.' });
    }

    const joins = `FROM ist_usuarios u
        INNER JOIN ist_tipo_usuario tu ON tu.id_tipo = u.id_tipo_usuario
        LEFT JOIN ist_cargo c ON c.id_cargo = u.id_cargo
        LEFT JOIN ist_situacao s ON s.id_situacao = u.id_situacao`;
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    try {
        const [totalRows] = await db.query(
            `SELECT COUNT(*) AS total ${joins} ${where}`,
            parametrosFiltros
        );
        const total = Number(totalRows[0]?.total) || 0;

        const [rows] = await db.query(
            `SELECT u.id_usuario, u.nome, u.email, u.id_tipo_usuario,
                    tu.descricao AS tipo, u.id_cargo, c.nome_cargo AS cargo,
                    u.id_situacao, s.situacao, u.email_confirmado, u.data_cadastro
             ${joins}
             ${where}
             ORDER BY ${colunaOrdenacao} ${sortOrder.toUpperCase()}, u.id_usuario ASC
             LIMIT ? OFFSET ?`,
            [...parametrosFiltros, limit, offset]
        );

        return res.status(200).json({
            data: rows.map(mapearUsuarioLista),
            pagination: {
                page,
                limit,
                total,
                totalPages: total === 0 ? 0 : Math.ceil(total / limit)
            }
        });
    } catch (error) {
        return responderErroInterno(res, 'Erro ao listar usuários administrativos:', error);
    }
};

export const listarOpcoesUsuariosAdmin = async (_req, res) => {
    try {
        const [[tipos], [cargos], [situacoes]] = await Promise.all([
            db.query('SELECT id_tipo, descricao FROM ist_tipo_usuario ORDER BY descricao, id_tipo'),
            db.query('SELECT id_cargo, nome_cargo FROM ist_cargo ORDER BY nome_cargo, id_cargo'),
            db.query('SELECT id_situacao, situacao, id_tipo FROM ist_situacao ORDER BY id_tipo, situacao, id_situacao')
        ]);

        return res.status(200).json({
            tiposUsuario: tipos.map((tipo) => ({ idTipoUsuario: tipo.id_tipo, tipo: tipo.descricao })),
            cargos: cargos.map((cargo) => ({ idCargo: cargo.id_cargo, cargo: cargo.nome_cargo })),
            situacoes: situacoes.map((situacao) => ({
                idSituacao: situacao.id_situacao,
                situacao: situacao.situacao,
                idTipoUsuario: situacao.id_tipo
            }))
        });
    } catch (error) {
        return responderErroInterno(res, 'Erro ao listar opções administrativas de usuários:', error);
    }
};

export const listarSituacoesUsuarioAdmin = async (req, res) => {
    const idTipoUsuario = inteiroPositivo(req.query.idTipoUsuario);
    if (!idTipoUsuario) {
        return res.status(400).json({ message: 'Tipo de usuário inválido.' });
    }

    try {
        const [rows] = await db.query(
            `SELECT id_situacao, situacao, id_tipo
             FROM ist_situacao
             WHERE id_tipo = ?
             ORDER BY situacao, id_situacao`,
            [idTipoUsuario]
        );

        return res.status(200).json(rows.map((situacao) => ({
            idSituacao: situacao.id_situacao,
            situacao: situacao.situacao,
            idTipoUsuario: situacao.id_tipo
        })));
    } catch (error) {
        return responderErroInterno(res, 'Erro ao listar situações administrativas de usuários:', error);
    }
};

export const obterUsuarioAdmin = async (req, res) => {
    const idUsuario = inteiroPositivo(req.params.id);
    if (!idUsuario) {
        return res.status(400).json({ message: 'ID de usuário inválido.' });
    }

    try {
        const [rows] = await db.query(
            `SELECT u.id_usuario, u.nome, u.cpf, u.identidade, u.data_nascimento,
                    u.id_tipo_usuario, tu.descricao AS tipo,
                    u.id_cargo, c.nome_cargo AS cargo,
                    u.id_situacao, s.situacao, u.email, u.telefone_celular,
                    u.logradouro, u.numero, u.complemento, u.bairro, u.cidade,
                    u.uf, u.cep, u.foto, u.curriculo, u.email_confirmado,
                    u.celular_confirmado, u.data_cadastro, u.data_atualizacao,
                    concorrente.id_usuario AS concorrente_usuario_id,
                    concorrente.id_concorrente, concorrente.id_obra_1,
                    concorrente.link_video_1, concorrente.id_obra_2,
                    concorrente.link_video_2, concorrente.aceite_regulamento,
                    concorrente.confirmacao_inscricao_enviada,
                    concorrente.confirmacao_inscricao_enviada_em,
                    concorrente.data_cadastro AS concorrente_data_cadastro
             FROM ist_usuarios u
             INNER JOIN ist_tipo_usuario tu ON tu.id_tipo = u.id_tipo_usuario
             LEFT JOIN ist_cargo c ON c.id_cargo = u.id_cargo
             LEFT JOIN ist_situacao s ON s.id_situacao = u.id_situacao
             LEFT JOIN ist_concorrentes concorrente ON concorrente.id_usuario = u.id_usuario
             WHERE u.id_usuario = ?`,
            [idUsuario]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        const row = rows[0];
        const resposta = { usuario: mapearUsuarioDetalhe(row) };
        if (row.concorrente_usuario_id !== null && row.concorrente_usuario_id !== undefined) {
            resposta.concorrente = {
                idConcorrente: row.id_concorrente,
                idObra1: row.id_obra_1,
                linkVideo1: row.link_video_1,
                idObra2: row.id_obra_2,
                linkVideo2: row.link_video_2,
                aceiteRegulamento: Boolean(row.aceite_regulamento),
                confirmacaoInscricaoEnviada: Boolean(row.confirmacao_inscricao_enviada),
                confirmacaoInscricaoEnviadaEm: row.confirmacao_inscricao_enviada_em,
                dataCadastro: row.concorrente_data_cadastro
            };
        }

        return res.status(200).json(resposta);
    } catch (error) {
        return responderErroInterno(res, 'Erro ao obter usuário administrativo:', error);
    }
};
