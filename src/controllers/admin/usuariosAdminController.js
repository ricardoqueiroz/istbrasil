import { pool as db } from '../../config/db.js';
import {
    cpfValido,
    dataNascimentoValida,
    somenteDigitos,
    textoNormalizado
} from '../../services/usuarioValidationService.js';

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

const CAMPOS_ATUALIZACAO = new Set([
    'nome', 'cpf', 'identidade', 'dataNascimento', 'idTipoUsuario', 'idCargo',
    'idSituacao', 'telefoneCelular', 'logradouro', 'numero', 'complemento',
    'bairro', 'cidade', 'uf', 'cep'
]);

const CAMPOS_OBRIGATORIOS_ATUALIZACAO = [
    'nome', 'cpf', 'dataNascimento', 'idTipoUsuario', 'idCargo',
    'idSituacao', 'telefoneCelular', 'logradouro', 'numero', 'complemento',
    'bairro', 'cidade', 'uf', 'cep'
];

class UsuarioAdminError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

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

const SQL_USUARIO_DETALHE = `SELECT u.id_usuario, u.nome, u.cpf, u.identidade, u.data_nascimento,
        u.id_tipo_usuario, tu.descricao AS tipo,
        u.id_cargo, c.nome_cargo AS cargo,
        u.id_situacao, s.situacao, u.email, u.telefone_celular,
        u.logradouro, u.numero, u.complemento, u.bairro, u.cidade,
        u.uf, u.cep, u.foto, u.curriculo, u.email_confirmado,
        u.celular_confirmado, u.data_cadastro, u.data_atualizacao
 FROM ist_usuarios u
 INNER JOIN ist_tipo_usuario tu ON tu.id_tipo = u.id_tipo_usuario
 LEFT JOIN ist_cargo c ON c.id_cargo = u.id_cargo
 LEFT JOIN ist_situacao s ON s.id_situacao = u.id_situacao
 WHERE u.id_usuario = ?`;

const montarRespostaDetalhe = (row) => ({ usuario: mapearUsuarioDetalhe(row) });

const buscarUsuarioDetalhe = async (executor, idUsuario) => {
    const [rows] = await executor.query(SQL_USUARIO_DETALHE, [idUsuario]);
    return rows[0] || null;
};

const prepararAtualizacaoUsuario = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Payload de usuário inválido.' };
    }
    if (Object.keys(body).some((campo) => !CAMPOS_ATUALIZACAO.has(campo))) {
        return { error: 'Payload de usuário contém campos não permitidos.' };
    }
    if (CAMPOS_OBRIGATORIOS_ATUALIZACAO.some((campo) => !Object.prototype.hasOwnProperty.call(body, campo))) {
        return { error: 'Informe todos os campos obrigatórios do usuário.' };
    }

    const camposTextoObrigatorios = ['nome', 'dataNascimento', 'telefoneCelular', 'logradouro', 'numero', 'bairro', 'cidade', 'uf', 'cep'];
    const camposTextoOpcionais = ['identidade', 'complemento'];
    if (camposTextoObrigatorios.some((campo) => typeof body[campo] !== 'string')
        || camposTextoOpcionais.some((campo) => body[campo] !== undefined && body[campo] !== null && typeof body[campo] !== 'string')
        || (typeof body.cpf !== 'string' && typeof body.cpf !== 'number')) {
        return { error: 'Os dados textuais do usuário são inválidos.' };
    }

    const idTipoUsuario = inteiroPositivo(body.idTipoUsuario);
    const idSituacao = inteiroPositivo(body.idSituacao);
    const idCargo = body.idCargo === null ? null : inteiroPositivo(body.idCargo);
    if (!idTipoUsuario || !idSituacao || (body.idCargo !== null && !idCargo)) {
        return { error: 'Tipo, cargo ou situação inválidos.' };
    }

    const dados = {
        nome: textoNormalizado(body.nome),
        cpf: somenteDigitos(body.cpf),
        identidade: textoNormalizado(body.identidade) || null,
        dataNascimento: textoNormalizado(body.dataNascimento),
        idTipoUsuario,
        idCargo,
        idSituacao,
        telefoneCelular: somenteDigitos(body.telefoneCelular),
        logradouro: textoNormalizado(body.logradouro),
        numero: textoNormalizado(body.numero),
        complemento: textoNormalizado(body.complemento) || null,
        bairro: textoNormalizado(body.bairro),
        cidade: textoNormalizado(body.cidade),
        uf: textoNormalizado(body.uf).toUpperCase(),
        cep: somenteDigitos(body.cep)
    };

    if (!dados.nome || !dados.dataNascimento || !dados.telefoneCelular || !dados.logradouro
        || !dados.numero || !dados.bairro || !dados.cidade || !dados.uf || !dados.cep) {
        return { error: 'Preencha todos os campos obrigatórios.' };
    }
    if (dados.nome.length > 255 || dados.logradouro.length > 255 || dados.numero.length > 20
        || dados.bairro.length > 100 || dados.cidade.length > 100
        || (dados.identidade && dados.identidade.length > 20)
        || (dados.complemento && dados.complemento.length > 100)) {
        return { error: 'Verifique o tamanho dos campos informados.' };
    }
    if (!cpfValido(dados.cpf)) return { error: 'CPF inválido.' };
    if (!dataNascimentoValida(dados.dataNascimento)) return { error: 'Data de nascimento inválida.' };
    if (dados.telefoneCelular.length !== 10 && dados.telefoneCelular.length !== 11) return { error: 'Telefone celular inválido.' };
    if (!/^[A-Z]{2}$/.test(dados.uf)) return { error: 'UF inválida.' };
    if (dados.cep.length !== 8) return { error: 'CEP inválido.' };

    return { data: dados };
};

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
        const usuario = await buscarUsuarioDetalhe(db, idUsuario);
        if (!usuario) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }
        return res.status(200).json(montarRespostaDetalhe(usuario));
    } catch (error) {
        return responderErroInterno(res, 'Erro ao obter usuário administrativo:', error);
    }
};

export const atualizarUsuarioAdmin = async (req, res) => {
    const idUsuario = inteiroPositivo(req.params.id);
    if (!idUsuario) {
        return res.status(400).json({ message: 'ID de usuário inválido.' });
    }

    const payload = prepararAtualizacaoUsuario(req.body);
    if (payload.error) {
        return res.status(400).json({ message: payload.error });
    }

    const dados = payload.data;
    const idAdministrador = req.usuario.id_usuario;
    let connection;
    let transacaoIniciada = false;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transacaoIniciada = true;

        const [usuarioRows] = await connection.query(
            'SELECT id_usuario, id_tipo_usuario, id_situacao FROM ist_usuarios WHERE id_usuario = ? FOR UPDATE',
            [idUsuario]
        );
        if (usuarioRows.length === 0) throw new UsuarioAdminError(404, 'Usuário não encontrado.');

        const usuarioAtual = usuarioRows[0];
        if (idUsuario === idAdministrador
            && (Number(usuarioAtual.id_tipo_usuario) !== dados.idTipoUsuario
                || Number(usuarioAtual.id_situacao) !== dados.idSituacao)) {
            throw new UsuarioAdminError(403, 'Não é permitido alterar o próprio tipo ou situação.');
        }

        const [tipoRows] = await connection.query('SELECT id_tipo FROM ist_tipo_usuario WHERE id_tipo = ?', [dados.idTipoUsuario]);
        if (tipoRows.length === 0) throw new UsuarioAdminError(404, 'Tipo de usuário não encontrado.');

        if (dados.idCargo !== null) {
            const [cargoRows] = await connection.query('SELECT id_cargo FROM ist_cargo WHERE id_cargo = ?', [dados.idCargo]);
            if (cargoRows.length === 0) throw new UsuarioAdminError(404, 'Cargo não encontrado.');
        }

        const [situacaoRows] = await connection.query(
            'SELECT id_situacao, id_tipo FROM ist_situacao WHERE id_situacao = ?',
            [dados.idSituacao]
        );
        if (situacaoRows.length === 0) throw new UsuarioAdminError(404, 'Situação não encontrada.');
        if (Number(situacaoRows[0].id_tipo) !== dados.idTipoUsuario) {
            throw new UsuarioAdminError(400, 'A situação não é compatível com o tipo de usuário.');
        }

        const [cpfRows] = await connection.query(
            'SELECT id_usuario FROM ist_usuarios WHERE cpf = ? AND id_usuario <> ?',
            [dados.cpf, idUsuario]
        );
        if (cpfRows.length > 0) throw new UsuarioAdminError(409, 'Este CPF já está cadastrado.');

        await connection.query(
            `UPDATE ist_usuarios
             SET nome = ?, cpf = ?, identidade = ?, data_nascimento = ?,
                 id_tipo_usuario = ?, id_cargo = ?, id_situacao = ?,
                 telefone_celular = ?, logradouro = ?, numero = ?, complemento = ?,
                 bairro = ?, cidade = ?, uf = ?, cep = ?
             WHERE id_usuario = ?`,
            [dados.nome, dados.cpf, dados.identidade, dados.dataNascimento,
                dados.idTipoUsuario, dados.idCargo, dados.idSituacao, dados.telefoneCelular,
                dados.logradouro, dados.numero, dados.complemento, dados.bairro,
                dados.cidade, dados.uf, dados.cep, idUsuario]
        );

        const usuarioAtualizado = await buscarUsuarioDetalhe(connection, idUsuario);
        await connection.commit();
        transacaoIniciada = false;
        return res.status(200).json(montarRespostaDetalhe(usuarioAtualizado));
    } catch (error) {
        if (transacaoIniciada) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Erro ao desfazer atualização administrativa de usuário:', rollbackError);
            }
        }
        if (error instanceof UsuarioAdminError) {
            return res.status(error.status).json({ message: error.message });
        }
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Este CPF já está cadastrado.' });
        }
        return responderErroInterno(res, 'Erro ao atualizar usuário administrativo:', error);
    } finally {
        if (connection) connection.release();
    }
};
