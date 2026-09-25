import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool as db } from '../config/db.js';
import { sendAccountMail } from '../services/mailService.js';
import {
    buildProfilePhotoUrl,
    processAndStoreProfilePhoto,
    ProfilePhotoValidationError,
    removeStoredProfilePhoto,
    sendStoredProfilePhoto
} from '../services/profilePhotoService.js';
import { validarVideoConcorrente } from '../services/concorrenteVideoService.js';

const BCRYPT_ROUNDS = 12;
const TOKEN_VALIDADE_MINUTOS = 30;
const COOKIE_NAME = process.env.COOKIE_NAME || 'ist_session';
// Sem JWT_SECRET definido no .env, cai em um segredo fixo apenas para nunca derrubar o login em dev;
// em produção o .env DEVE definir JWT_SECRET para os cookies de sessão serem realmente seguros.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';

const buildCookieOptions = () => {
    const maxAgeSeconds = parseInt(process.env.COOKIE_MAXLIFETIME, 10) || 86400;
    const options = {
        secure: process.env.COOKIE_SECURE === 'true',
        httpOnly: process.env.COOKIE_HTTPONLY !== 'false',
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        maxAge: maxAgeSeconds * 1000
    };

    // Aceita apenas hostname puro (ex: istbrasil.org.br ou .istbrasil.org.br);
    // valores com protocolo, porta ou caminho fazem o cookie.serialize() lançar "option domain is invalid"
    const cookieHost = (process.env.COOKIE_HTTP_HOST || '').trim();
    if (cookieHost) {
        if (/^\.?[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(cookieHost)) {
            options.domain = cookieHost;
        } else {
            console.warn(`COOKIE_HTTP_HOST inválido ("${cookieHost}"); ignorando e usando cookie sem domínio explícito.`);
        }
    }

    return options;
};

// A senha chega já em SHA-256 (calculada no front); o backend aplica bcrypt por cima antes de comparar/gravar
const login = async (req, res) => {
    const { email, senha, id_tipo_usuario, manterConectado } = req.body;

    if (!email || !senha) {
        return res.status(400).json({ message: 'Informe e-mail e senha para continuar.' });
    }

    try {
        const [rows] = await db.query('SELECT id_usuario, senha, nome, foto, id_tipo_usuario FROM ist_usuarios WHERE email = ?', [email.trim().toLowerCase()]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'E-mail não cadastrado. Cadastre-se para continuar.' });
        }

        const usuario = rows[0];
        const senhaValida = await bcrypt.compare(senha, usuario.senha);

        if (!senhaValida) {
            return res.status(401).json({ message: 'Senha ou e-mail inválido.' });
        }

        const cookieOptions = buildCookieOptions();
        const maxAgeMs = manterConectado ? cookieOptions.maxAge * 30 : cookieOptions.maxAge;
        const sessionToken = jwt.sign(
            { id_usuario: usuario.id_usuario, id_tipo_usuario: usuario.id_tipo_usuario },
            JWT_SECRET,
            { expiresIn: Math.floor(maxAgeMs / 1000) }
        );

        res.cookie(COOKIE_NAME, sessionToken, {
            ...cookieOptions,
            maxAge: maxAgeMs
        });

        return res.status(200).json({
            id_usuario: usuario.id_usuario,
            id_tipo_usuario: usuario.id_tipo_usuario,
            nome: usuario.nome,
            foto_url: buildProfilePhotoUrl(usuario.foto)
        });
    } catch (error) {
        console.error('Erro no login de usuário:', error);
        return res.status(500).json({ message: 'Erro ao processar login.', error: error.message });
    }
};

// Lista os cargos disponíveis (usado no formulário de cadastro da diretoria)
const listarCargos = async (_req, res) => {
    try {
        const [rows] = await db.query('SELECT id_cargo, nome_cargo FROM ist_cargo ORDER BY nome_cargo');
        return res.status(200).json(rows);
    } catch (error) {
        console.error('Erro ao listar cargos:', error);
        return res.status(500).json({ message: 'Erro ao carregar cargos.', error: error.message });
    }
};

// Checagem rápida usada no passo de confirmação, antes de preencher o restante do formulário
const verificarEmail = async (req, res) => {
    const email = (req.query.email || '').toString().trim().toLowerCase();

    if (!email) {
        return res.status(400).json({ message: 'Informe um e-mail para verificar.' });
    }

    try {
        const [rows] = await db.query('SELECT id_usuario FROM ist_usuarios WHERE email = ?', [email]);
        return res.status(200).json({ disponivel: rows.length === 0 });
    } catch (error) {
        console.error('Erro ao verificar e-mail:', error);
        return res.status(500).json({ message: 'Erro ao verificar e-mail.', error: error.message });
    }
};

const somenteDigitos = (valor) => (valor || '').toString().replace(/\D/g, '');

const textoNormalizado = (valor) => typeof valor === 'string' ? valor.trim() : '';

const emailValido = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const cpfValido = (cpf) => {
    if (!/^\d{11}$/.test(cpf) || /^([0-9])\1{10}$/.test(cpf)) {
        return false;
    }

    let soma = 0;
    for (let indice = 0; indice < 9; indice += 1) {
        soma += Number(cpf[indice]) * (10 - indice);
    }

    let resto = (soma * 10) % 11;
    if (resto === 10) {
        resto = 0;
    }
    if (resto !== Number(cpf[9])) {
        return false;
    }

    soma = 0;
    for (let indice = 0; indice < 10; indice += 1) {
        soma += Number(cpf[indice]) * (11 - indice);
    }

    resto = (soma * 10) % 11;
    if (resto === 10) {
        resto = 0;
    }

    return resto === Number(cpf[10]);
};

const dataNascimentoValida = (dataNascimento) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataNascimento)) {
        return false;
    }

    const data = new Date(`${dataNascimento}T00:00:00Z`);
    if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== dataNascimento) {
        return false;
    }

    const hoje = new Date().toISOString().slice(0, 10);
    return dataNascimento <= hoje;
};

const CADASTRO_TIPO_MAP = {
    diretoria: { idTipoUsuario: 1, idSituacao: 1, exigeCargo: true },
    concorrente: { idTipoUsuario: 2, idSituacao: 3, exigeCargo: false },
    externo: { idTipoUsuario: 3, idSituacao: 6, exigeCargo: false },
    colaborador: { idTipoUsuario: 4, idSituacao: 8, exigeCargo: true }
};

// O cadastro legado não envia cadastroTipo; essa ausência continua significando Diretoria temporariamente.
const cadastrar = async (req, res) => {
    const {
        cadastroTipo,
        id_tipo_usuario,
        id_situacao,
        nome,
        email,
        confirmarEmail,
        cpf,
        telefone_celular,
        senha,
        id_cargo,
        identidade,
        data_nascimento,
        logradouro,
        numero,
        complemento,
        bairro,
        cidade,
        uf,
        cep
    } = req.body;

    const tipo = cadastroTipo === undefined ? 'diretoria' : cadastroTipo;
    const regrasTipo = typeof tipo === 'string' ? CADASTRO_TIPO_MAP[tipo] : undefined;

    if (!regrasTipo) {
        return res.status(400).json({ message: 'Tipo de cadastro inválido.' });
    }

    if (id_situacao !== undefined) {
        return res.status(400).json({ message: 'A situação do cadastro não pode ser informada pelo cliente.' });
    }

    if (id_tipo_usuario !== undefined && Number(id_tipo_usuario) !== regrasTipo.idTipoUsuario) {
        return res.status(400).json({ message: 'O tipo de usuário informado não corresponde ao cadastro.' });
    }

    const cargoInformado = id_cargo !== undefined && id_cargo !== null && id_cargo !== '';
    const idCargoNormalizado = cargoInformado ? Number(id_cargo) : null;

    if (!nome?.trim() || !email?.trim() || !senha?.trim() || !cpf?.trim() || !telefone_celular?.trim() || !data_nascimento || !cep?.trim() || !logradouro?.trim() || !numero?.trim() || !bairro?.trim() || !cidade?.trim() || !uf?.trim()) {
        return res.status(400).json({ message: 'Preencha todos os campos obrigatórios.' });
    }

    if (regrasTipo.exigeCargo && (!Number.isInteger(idCargoNormalizado) || idCargoNormalizado <= 0)) {
        return res.status(400).json({ message: 'Informe um cargo válido.' });
    }

    if (!regrasTipo.exigeCargo && cargoInformado) {
        return res.status(400).json({ message: 'Este tipo de cadastro não aceita cargo.' });
    }

    if (confirmarEmail && email.trim().toLowerCase() !== confirmarEmail.trim().toLowerCase()) {
        return res.status(400).json({ message: 'Os e-mails informados não coincidem.' });
    }

    const emailNormalizado = email.trim().toLowerCase();
    const cpfNormalizado = somenteDigitos(cpf);

    if (cpfNormalizado.length !== 11) {
        return res.status(400).json({ message: 'CPF inválido.' });
    }

    if (identidade && identidade.trim().length > 20) {
        return res.status(400).json({ message: 'Identidade deve ter no máximo 20 caracteres.' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_nascimento) || Number.isNaN(new Date(data_nascimento).getTime())) {
        return res.status(400).json({ message: 'Data de nascimento inválida.' });
    }

    if (new Date(data_nascimento) > new Date()) {
        return res.status(400).json({ message: 'Data de nascimento não pode ser no futuro.' });
    }

    let connection;
    let transacaoIniciada = false;
    let cadastroConfirmacao;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transacaoIniciada = true;

        const [existentes] = await connection.query('SELECT id_usuario, email, cpf FROM ist_usuarios WHERE email = ? OR cpf = ?', [emailNormalizado, cpfNormalizado]);

        const emailDuplicado = existentes.find((u) => u.email === emailNormalizado);
        if (emailDuplicado) {
            const erro = new Error('E-mail duplicado');
            erro.code = 'DUPLICATE_EMAIL';
            throw erro;
        }

        const cpfDuplicado = existentes.find((u) => u.cpf === cpfNormalizado);
        if (cpfDuplicado) {
            const erro = new Error('CPF duplicado');
            erro.code = 'DUPLICATE_CPF';
            throw erro;
        }

        const senhaBcrypt = await bcrypt.hash(senha, BCRYPT_ROUNDS);
        const tokenConfirmacao = crypto.randomBytes(32).toString('hex');
        const tokenExpiraEm = new Date(Date.now() + TOKEN_VALIDADE_MINUTOS * 60 * 1000);

        const [result] = await connection.query(
            `INSERT INTO ist_usuarios
                (id_tipo_usuario, id_cargo, id_situacao, senha, nome, cpf, identidade, data_nascimento, email, telefone_celular,
                 logradouro, numero, complemento, bairro, cidade, uf, cep,
                 token_confirmacao, token_expira_em, token_tipo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email')`,
            [
                regrasTipo.idTipoUsuario,
                regrasTipo.exigeCargo ? idCargoNormalizado : null,
                regrasTipo.idSituacao,
                senhaBcrypt,
                nome.trim(),
                cpfNormalizado,
                identidade?.trim() || null,
                data_nascimento,
                emailNormalizado,
                somenteDigitos(telefone_celular),
                logradouro?.trim() || null,
                numero?.trim() || null,
                complemento?.trim() || null,
                bairro?.trim() || null,
                cidade?.trim() || null,
                uf?.trim() || null,
                somenteDigitos(cep) || null,
                tokenConfirmacao,
                tokenExpiraEm
            ]
        );

        if (tipo === 'concorrente') {
            await connection.query(
                `INSERT INTO ist_concorrentes
                    (id_usuario, id_concorrente, id_obra_1, link_video_1, id_obra_2, link_video_2)
                 VALUES (?, NULL, NULL, NULL, NULL, NULL)`,
                [result.insertId]
            );
        }

        await connection.commit();
        transacaoIniciada = false;
        cadastroConfirmacao = { id_usuario: result.insertId, email: emailNormalizado, nome: nome.trim(), token: tokenConfirmacao };
    } catch (error) {
        if (transacaoIniciada) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Erro ao desfazer cadastro de usuário:', rollbackError);
            }
        }

        if (error.code === 'DUPLICATE_EMAIL') {
            return res.status(409).json({ message: 'Este e-mail já está cadastrado. Faça login ou recupere sua senha.' });
        }

        if (error.code === 'DUPLICATE_CPF' || error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'E-mail ou CPF já cadastrado.' });
        }

        if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(400).json({ message: 'Os dados relacionados ao cadastro são inválidos.' });
        }

        console.error('Erro ao cadastrar usuário:', error);
        return res.status(500).json({ message: 'Erro ao cadastrar usuário.' });
    } finally {
        if (connection) {
            connection.release();
        }
    }

    const linkConfirmacao = `${process.env.APP_URL || 'https://www.istbrasil.org.br'}/confirmar-email?token=${cadastroConfirmacao.token}`;

    try {
        await sendAccountMail({
            to: cadastroConfirmacao.email,
            subject: 'Confirme seu e-mail - IST Brasil',
            html: `<p>Olá, ${cadastroConfirmacao.nome}!</p><p>Confirme seu cadastro clicando no link abaixo (válido por ${TOKEN_VALIDADE_MINUTOS} minutos):</p><p><a href="${linkConfirmacao}">${linkConfirmacao}</a></p>`
        });
    } catch (mailError) {
        // O banco já confirmou o cadastro; falha SMTP não desfaz o commit.
        console.error('Erro ao enviar e-mail de confirmação após cadastro confirmado:', mailError.message);
    }

    return res.status(201).json({ id_usuario: cadastroConfirmacao.id_usuario });
};

// Confirmação de e-mail via token enviado no cadastro
const confirmarEmail = async (req, res) => {
    const token = (req.query.token || '').toString().trim();

    if (!token) {
        return res.status(400).json({ message: 'Token não informado.' });
    }

    try {
        const [rows] = await db.query(
            "SELECT id_usuario, token_expira_em FROM ist_usuarios WHERE token_confirmacao = ? AND token_tipo = 'email'",
            [token]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Token inválido.' });
        }

        const usuario = rows[0];

        if (new Date(usuario.token_expira_em) < new Date()) {
            return res.status(410).json({ message: 'Token expirado. Solicite um novo e-mail de confirmação.' });
        }

        await db.query(
            'UPDATE ist_usuarios SET email_confirmado = 1, token_confirmacao = NULL, token_expira_em = NULL, token_tipo = NULL WHERE id_usuario = ?',
            [usuario.id_usuario]
        );

        return res.status(200).json({ message: 'E-mail confirmado com sucesso.' });
    } catch (error) {
        console.error('Erro ao confirmar e-mail:', error);
        return res.status(500).json({ message: 'Erro ao confirmar e-mail.', error: error.message });
    }
};

// Passo 1 do "Esqueci a senha": gera token e envia o link de redefinição por e-mail
const esqueciSenha = async (req, res) => {
    const email = (req.body.email || '').toString().trim().toLowerCase();

    if (!email) {
        return res.status(400).json({ message: 'Informe o e-mail cadastrado.' });
    }

    try {
        const [rows] = await db.query('SELECT id_usuario, nome FROM ist_usuarios WHERE email = ?', [email]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'E-mail não cadastrado.' });
        }

        const usuario = rows[0];
        const tokenSenha = crypto.randomBytes(32).toString('hex');
        const tokenExpiraEm = new Date(Date.now() + TOKEN_VALIDADE_MINUTOS * 60 * 1000);

        await db.query(
            "UPDATE ist_usuarios SET token_confirmacao = ?, token_expira_em = ?, token_tipo = 'reset_senha' WHERE id_usuario = ?",
            [tokenSenha, tokenExpiraEm, usuario.id_usuario]
        );

        const linkRedefinicao = `${process.env.APP_URL || 'https://www.istbrasil.org.br'}/redefinir-senha?token=${tokenSenha}`;

        try {
            await sendAccountMail({
                to: email,
                subject: 'Redefinição de senha - IST Brasil',
                html: `<p>Olá, ${usuario.nome}!</p><p>Recebemos uma solicitação para redefinir sua senha. Clique no link abaixo (válido por ${TOKEN_VALIDADE_MINUTOS} minutos):</p><p><a href="${linkRedefinicao}">${linkRedefinicao}</a></p><p>Se você não solicitou isso, ignore este e-mail.</p>`
            });
        } catch (mailError) {
            console.error('Erro ao enviar e-mail de redefinição de senha:', mailError.message);
            return res.status(502).json({ message: 'Não foi possível enviar o e-mail de redefinição. Tente novamente mais tarde.' });
        }

        return res.status(200).json({ message: 'E-mail de redefinição enviado. Verifique sua caixa de entrada.' });
    } catch (error) {
        console.error('Erro ao solicitar redefinição de senha:', error);
        return res.status(500).json({ message: 'Erro ao solicitar redefinição de senha.', error: error.message });
    }
};

// Verifica se o token de redefinição ainda é válido, usado ao abrir a página de nova senha
const validarTokenSenha = async (req, res) => {
    const token = (req.query.token || '').toString().trim();

    if (!token) {
        return res.status(400).json({ message: 'Token não informado.' });
    }

    try {
        const [rows] = await db.query(
            "SELECT token_expira_em FROM ist_usuarios WHERE token_confirmacao = ? AND token_tipo = 'reset_senha'",
            [token]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Token inválido.' });
        }

        if (new Date(rows[0].token_expira_em) < new Date()) {
            return res.status(410).json({ message: 'Token expirado. Solicite a redefinição novamente.' });
        }

        return res.status(200).json({ valido: true });
    } catch (error) {
        console.error('Erro ao validar token de redefinição:', error);
        return res.status(500).json({ message: 'Erro ao validar token.', error: error.message });
    }
};

// Passo 2 do "Esqueci a senha": grava a nova senha (já em SHA-256 do front, com bcrypt por cima)
const redefinirSenha = async (req, res) => {
    const token = (req.body.token || '').toString().trim();
    const novaSenha = (req.body.novaSenha || '').toString().trim();

    if (!token || !novaSenha) {
        return res.status(400).json({ message: 'Token e nova senha são obrigatórios.' });
    }

    try {
        const [rows] = await db.query(
            "SELECT id_usuario, token_expira_em FROM ist_usuarios WHERE token_confirmacao = ? AND token_tipo = 'reset_senha'",
            [token]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Token inválido.' });
        }

        const usuario = rows[0];

        if (new Date(usuario.token_expira_em) < new Date()) {
            return res.status(410).json({ message: 'Token expirado. Solicite a redefinição novamente.' });
        }

        const senhaBcrypt = await bcrypt.hash(novaSenha, BCRYPT_ROUNDS);

        await db.query(
            'UPDATE ist_usuarios SET senha = ?, token_confirmacao = NULL, token_expira_em = NULL, token_tipo = NULL WHERE id_usuario = ?',
            [senhaBcrypt, usuario.id_usuario]
        );

        return res.status(200).json({ message: 'Senha redefinida com sucesso.' });
    } catch (error) {
        console.error('Erro ao redefinir senha:', error);
        return res.status(500).json({ message: 'Erro ao redefinir senha.', error: error.message });
    }
};

// Checagem de sessão: o middleware já validou o JWT e preencheu req.usuario.
const me = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id_usuario, nome, foto, id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?', [req.usuario.id_usuario]);

        if (rows.length === 0) {
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        const usuario = rows[0];

        return res.status(200).json({
            id_usuario: usuario.id_usuario,
            id_tipo_usuario: usuario.id_tipo_usuario,
            nome: usuario.nome,
            foto_url: buildProfilePhotoUrl(usuario.foto)
        });
    } catch (error) {
        res.clearCookie(COOKIE_NAME, buildCookieOptions());
        return res.status(401).json({ message: 'Sessão expirada ou inválida.' });
    }
};

const obterPerfil = async (req, res) => {
    const idUsuario = req.usuario.id_usuario;

    try {
        const [usuarioRows] = await db.query(
            `SELECT id_usuario, id_tipo_usuario, id_cargo, id_situacao, nome, foto,
                    data_nascimento, cpf, identidade, curriculo, email, email_confirmado,
                    telefone_celular, celular_confirmado, cep, logradouro, numero,
                    complemento, bairro, cidade, uf
             FROM ist_usuarios
             WHERE id_usuario = ?`,
            [idUsuario]
        );

        if (usuarioRows.length === 0) {
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        const usuario = usuarioRows[0];
        let concorrente = null;

        if (Number(usuario.id_tipo_usuario) === 2) {
            const [concorrenteRows] = await db.query(
                `SELECT c.id_usuario AS concorrente_usuario_id,
                        c.id_concorrente, c.id_obra_1, c.link_video_1,
                        c.id_obra_2, c.link_video_2, c.data_cadastro,
                        obra1.titulo AS titulo_obra_1,
                        obra2.titulo AS titulo_obra_2
                 FROM ist_concorrentes c
                 LEFT JOIN ist_composicao obra1 ON obra1.id_obra = c.id_obra_1
                 LEFT JOIN ist_composicao obra2 ON obra2.id_obra = c.id_obra_2
                 WHERE c.id_usuario = ?`,
                [idUsuario]
            );

            if (concorrenteRows.length > 0 && concorrenteRows[0].concorrente_usuario_id !== null) {
                const dadosConcorrente = concorrenteRows[0];
                concorrente = {
                    idConcorrente: dadosConcorrente.id_concorrente,
                    idObra1: dadosConcorrente.id_obra_1,
                    tituloObra1: dadosConcorrente.titulo_obra_1,
                    linkVideo1: dadosConcorrente.link_video_1,
                    idObra2: dadosConcorrente.id_obra_2,
                    tituloObra2: dadosConcorrente.titulo_obra_2,
                    linkVideo2: dadosConcorrente.link_video_2,
                    dataCadastro: dadosConcorrente.data_cadastro
                };
            }
        }

        return res.status(200).json({
            usuario: {
                idUsuario: usuario.id_usuario,
                idTipoUsuario: usuario.id_tipo_usuario,
                idCargo: usuario.id_cargo,
                idSituacao: usuario.id_situacao,
                nome: usuario.nome,
                foto: usuario.foto,
                fotoUrl: buildProfilePhotoUrl(usuario.foto),
                dataNascimento: usuario.data_nascimento,
                cpf: usuario.cpf,
                identidade: usuario.identidade,
                curriculo: usuario.curriculo,
                email: usuario.email,
                emailConfirmado: usuario.email_confirmado,
                telefoneCelular: usuario.telefone_celular,
                celularConfirmado: usuario.celular_confirmado,
                cep: usuario.cep,
                logradouro: usuario.logradouro,
                numero: usuario.numero,
                complemento: usuario.complemento,
                bairro: usuario.bairro,
                cidade: usuario.cidade,
                uf: usuario.uf
            },
            concorrente
        });
    } catch (error) {
        console.error('Erro ao obter perfil do usuário:', error);
        return res.status(500).json({ message: 'Erro ao carregar perfil.' });
    }
};

const atualizarPerfil = async (req, res) => {
    const idUsuario = req.usuario.id_usuario;
    const {
        nome,
        email,
        cpf,
        identidade,
        telefoneCelular,
        dataNascimento,
        cep,
        logradouro,
        numero,
        complemento,
        bairro,
        cidade,
        uf
    } = req.body || {};

    const dados = {
        nome: textoNormalizado(nome),
        email: textoNormalizado(email).toLowerCase(),
        cpf: somenteDigitos(cpf),
        identidade: textoNormalizado(identidade) || null,
        telefoneCelular: somenteDigitos(telefoneCelular),
        dataNascimento: textoNormalizado(dataNascimento),
        cep: somenteDigitos(cep),
        logradouro: textoNormalizado(logradouro),
        numero: textoNormalizado(numero),
        complemento: textoNormalizado(complemento) || null,
        bairro: textoNormalizado(bairro),
        cidade: textoNormalizado(cidade),
        uf: textoNormalizado(uf).toUpperCase()
    };

    if (!dados.nome || !dados.email || !dados.cpf || !dados.telefoneCelular || !dados.dataNascimento || !dados.cep || !dados.logradouro || !dados.numero || !dados.bairro || !dados.cidade || !dados.uf) {
        return res.status(400).json({ message: 'Preencha todos os campos obrigatórios.' });
    }

    if (dados.nome.length > 255 || dados.email.length > 255 || dados.logradouro.length > 255 || dados.numero.length > 20 || dados.bairro.length > 100 || dados.cidade.length > 100 || dados.uf.length !== 2) {
        return res.status(400).json({ message: 'Verifique o tamanho dos campos informados.' });
    }

    if (!emailValido(dados.email)) {
        return res.status(400).json({ message: 'Informe um e-mail válido.' });
    }

    if (!cpfValido(dados.cpf)) {
        return res.status(400).json({ message: 'CPF inválido.' });
    }

    if (dados.telefoneCelular.length !== 10 && dados.telefoneCelular.length !== 11) {
        return res.status(400).json({ message: 'Telefone celular inválido.' });
    }

    if (!dataNascimentoValida(dados.dataNascimento)) {
        return res.status(400).json({ message: 'Data de nascimento inválida.' });
    }

    if (dados.cep.length !== 8) {
        return res.status(400).json({ message: 'CEP inválido.' });
    }

    if (!/^[A-Z]{2}$/.test(dados.uf)) {
        return res.status(400).json({ message: 'UF inválida.' });
    }

    try {
        const [usuarioRows] = await db.query(
            'SELECT email, cpf, telefone_celular, email_confirmado, celular_confirmado FROM ist_usuarios WHERE id_usuario = ?',
            [idUsuario]
        );

        if (usuarioRows.length === 0) {
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        const usuarioAtual = usuarioRows[0];
        const emailAtual = textoNormalizado(usuarioAtual.email).toLowerCase();
        const telefoneAtual = somenteDigitos(usuarioAtual.telefone_celular);
        const emailMudou = dados.email !== emailAtual;
        const telefoneMudou = dados.telefoneCelular !== telefoneAtual;

        const [duplicados] = await db.query(
            'SELECT email, cpf FROM ist_usuarios WHERE (email = ? OR cpf = ?) AND id_usuario <> ?',
            [dados.email, dados.cpf, idUsuario]
        );

        if (duplicados.some((usuario) => textoNormalizado(usuario.email).toLowerCase() === dados.email)) {
            return res.status(409).json({ message: 'Este e-mail já está cadastrado.' });
        }

        if (duplicados.some((usuario) => somenteDigitos(usuario.cpf) === dados.cpf)) {
            return res.status(409).json({ message: 'Este CPF já está cadastrado.' });
        }

        await db.query(
            `UPDATE ist_usuarios
             SET nome = ?, email = ?, cpf = ?, identidade = ?, telefone_celular = ?,
                 data_nascimento = ?, cep = ?, logradouro = ?, numero = ?, complemento = ?,
                 bairro = ?, cidade = ?, uf = ?, email_confirmado = ?, celular_confirmado = ?
             WHERE id_usuario = ?`,
            [
                dados.nome,
                dados.email,
                dados.cpf,
                dados.identidade,
                dados.telefoneCelular,
                dados.dataNascimento,
                dados.cep,
                dados.logradouro,
                dados.numero,
                dados.complemento,
                dados.bairro,
                dados.cidade,
                dados.uf,
                emailMudou ? 0 : usuarioAtual.email_confirmado,
                telefoneMudou ? 0 : usuarioAtual.celular_confirmado,
                idUsuario
            ]
        );

        const [atualizados] = await db.query(
            `SELECT id_usuario, id_tipo_usuario, id_cargo, id_situacao, nome, foto,
                    data_nascimento, cpf, identidade, curriculo, email, email_confirmado,
                    telefone_celular, celular_confirmado, cep, logradouro, numero,
                    complemento, bairro, cidade, uf
             FROM ist_usuarios
             WHERE id_usuario = ?`,
            [idUsuario]
        );

        const usuario = atualizados[0];
        return res.status(200).json({
            message: 'Perfil atualizado com sucesso.',
            usuario: {
                idUsuario: usuario.id_usuario,
                idTipoUsuario: usuario.id_tipo_usuario,
                idCargo: usuario.id_cargo,
                idSituacao: usuario.id_situacao,
                nome: usuario.nome,
                foto: usuario.foto,
                fotoUrl: buildProfilePhotoUrl(usuario.foto),
                dataNascimento: usuario.data_nascimento,
                cpf: usuario.cpf,
                identidade: usuario.identidade,
                curriculo: usuario.curriculo,
                email: usuario.email,
                emailConfirmado: usuario.email_confirmado,
                telefoneCelular: usuario.telefone_celular,
                celularConfirmado: usuario.celular_confirmado,
                cep: usuario.cep,
                logradouro: usuario.logradouro,
                numero: usuario.numero,
                complemento: usuario.complemento,
                bairro: usuario.bairro,
                cidade: usuario.cidade,
                uf: usuario.uf
            }
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            const mensagem = error.message?.toLowerCase().includes('email')
                ? 'Este e-mail já está cadastrado.'
                : 'Este CPF já está cadastrado.';
            return res.status(409).json({ message: mensagem });
        }

        console.error('Erro ao atualizar perfil do usuário:', error);
        return res.status(500).json({ message: 'Erro ao atualizar perfil.' });
    }
};

const atualizarParticipacaoConcorrente = async (req, res) => {
    const idUsuario = req.usuario.id_usuario;
    const { linkVideo1, idObra2, linkVideo2 } = req.body || {};
    const video1Normalizado = validarVideoConcorrente(linkVideo1);

    if (!video1Normalizado) {
        return res.status(400).json({ message: 'Informe um vídeo HTTPS válido para a primeira obra.' });
    }

    const segundaObraInformada = idObra2 !== undefined && idObra2 !== null && idObra2 !== '';
    const idObra2Normalizado = segundaObraInformada ? Number(idObra2) : null;

    if (segundaObraInformada && (!Number.isInteger(idObra2Normalizado) || idObra2Normalizado <= 0)) {
        return res.status(400).json({ message: 'A segunda obra informada é inválida.' });
    }

    const video2Normalizado = validarVideoConcorrente(linkVideo2);

    const video2Informado = linkVideo2 !== undefined
        && linkVideo2 !== null
        && !(typeof linkVideo2 === 'string' && !linkVideo2.trim());

    if (!segundaObraInformada && video2Informado) {
        return res.status(400).json({ message: 'Não informe vídeo sem selecionar a segunda obra.' });
    }

    if (segundaObraInformada && !video2Normalizado) {
        return res.status(400).json({ message: 'Informe um vídeo HTTPS válido para a segunda obra.' });
    }

    try {
        const [usuarioRows] = await db.query(
            'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?',
            [idUsuario]
        );

        if (usuarioRows.length === 0) {
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        if (Number(usuarioRows[0].id_tipo_usuario) !== 2) {
            return res.status(403).json({ message: 'A participação do Festival está disponível apenas para concorrentes.' });
        }

        const [concorrenteRows] = await db.query(
            'SELECT id_usuario FROM ist_concorrentes WHERE id_usuario = ?',
            [idUsuario]
        );

        if (concorrenteRows.length === 0) {
            return res.status(409).json({ message: 'Cadastro de concorrente inconsistente.' });
        }

        const [obraPrincipalRows] = await db.query(
            'SELECT id_obra, titulo FROM ist_composicao WHERE id_obra = ?',
            [63]
        );

        if (obraPrincipalRows.length === 0) {
            console.error('Obra principal 63 não encontrada em ist_composicao.');
            return res.status(500).json({ message: 'Não foi possível validar a obra principal.' });
        }

        let obraSecundaria = null;
        if (segundaObraInformada) {
            const [obraRows] = await db.query(
                `SELECT id_obra, titulo
                 FROM ist_composicao
                 WHERE id_obra = ?
                   AND propria = 1
                   AND partitura IS NOT NULL
                   AND id_obra <> ?`,
                [idObra2Normalizado, 63]
            );

            if (obraRows.length === 0) {
                return res.status(400).json({ message: 'A segunda obra informada não é elegível.' });
            }

            obraSecundaria = obraRows[0];
        }

        await db.query(
            `UPDATE ist_concorrentes
             SET id_obra_1 = ?, link_video_1 = ?, id_obra_2 = ?, link_video_2 = ?
             WHERE id_usuario = ?`,
            [63, video1Normalizado, idObra2Normalizado, segundaObraInformada ? video2Normalizado : null, idUsuario]
        );

        return res.status(200).json({
            message: 'Participação atualizada com sucesso.',
            concorrente: {
                idObra1: 63,
                tituloObra1: obraPrincipalRows[0].titulo,
                linkVideo1: video1Normalizado,
                idObra2: segundaObraInformada ? idObra2Normalizado : null,
                tituloObra2: obraSecundaria?.titulo || null,
                linkVideo2: segundaObraInformada ? video2Normalizado : null
            }
        });
    } catch (error) {
        console.error('Erro ao atualizar participação do concorrente:', error);
        return res.status(500).json({ message: 'Erro ao atualizar participação.' });
    }
};

const atualizarCurriculo = async (req, res) => {
    const idUsuario = req.usuario.id_usuario;
    const payload = req.body || {};
    const camposAceitos = ['curriculo'];

    if (Object.keys(payload).some((campo) => !camposAceitos.includes(campo))) {
        return res.status(400).json({ message: 'Payload de currículo inválido.' });
    }

    const valorRecebido = payload.curriculo;
    if (valorRecebido !== null && typeof valorRecebido !== 'string') {
        return res.status(400).json({ message: 'O currículo deve ser texto ou nulo.' });
    }

    const curriculo = valorRecebido === null ? null : valorRecebido.trim() || null;
    if (curriculo && curriculo.length > 10000) {
        return res.status(400).json({ message: 'O currículo deve ter no máximo 10.000 caracteres.' });
    }

    try {
        const [usuarioRows] = await db.query(
            'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?',
            [idUsuario]
        );

        if (usuarioRows.length === 0) {
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        if (![1, 2, 4].includes(Number(usuarioRows[0].id_tipo_usuario))) {
            return res.status(403).json({ message: 'Este tipo de usuário não possui currículo editável.' });
        }

        await db.query(
            'UPDATE ist_usuarios SET curriculo = ? WHERE id_usuario = ?',
            [curriculo, idUsuario]
        );

        return res.status(200).json({
            message: 'Currículo atualizado com sucesso.',
            curriculo
        });
    } catch (error) {
        console.error('Erro ao atualizar currículo do usuário:', error);
        return res.status(500).json({ message: 'Erro ao atualizar currículo.' });
    }
};

const atualizarFoto = async (req, res) => {
    const idUsuario = req.usuario.id_usuario;

    if (!req.file) {
        return res.status(400).json({ message: 'Envie uma foto para continuar.' });
    }

    try {
        const [usuarioRows] = await db.query('SELECT foto FROM ist_usuarios WHERE id_usuario = ?', [idUsuario]);

        if (usuarioRows.length === 0) {
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        const fotoAnterior = usuarioRows[0].foto;
        const novoArquivo = await processAndStoreProfilePhoto(req.file.buffer);

        try {
            await db.query('UPDATE ist_usuarios SET foto = ? WHERE id_usuario = ?', [novoArquivo.filename, idUsuario]);
        } catch (error) {
            await removeStoredProfilePhoto(novoArquivo.filename).catch((cleanupError) => {
                console.error('Erro ao limpar nova foto após falha no banco:', cleanupError);
            });
            throw error;
        }

        if (fotoAnterior && fotoAnterior !== novoArquivo.filename) {
            try {
                await removeStoredProfilePhoto(fotoAnterior);
            } catch (error) {
                console.warn('Não foi possível remover a foto anterior do usuário:', error);
            }
        }

        return res.status(200).json({
            message: 'Foto atualizada com sucesso.',
            foto: novoArquivo.filename,
            foto_url: buildProfilePhotoUrl(novoArquivo.filename)
        });
    } catch (error) {
        if (error instanceof ProfilePhotoValidationError) {
            return res.status(400).json({ message: error.message });
        }

        console.error('Erro ao atualizar foto do usuário:', error);
        return res.status(500).json({ message: 'Erro ao atualizar foto.' });
    }
};

const obterFotoPublica = (req, res) => sendStoredProfilePhoto(res, req.params.arquivo);

const removerFoto = async (req, res) => {
    const idUsuario = req.usuario.id_usuario;

    try {
        const [usuarioRows] = await db.query('SELECT foto FROM ist_usuarios WHERE id_usuario = ?', [idUsuario]);

        if (usuarioRows.length === 0) {
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        const fotoAnterior = usuarioRows[0].foto;

        if (!fotoAnterior) {
            return res.status(200).json({ message: 'Foto removida com sucesso.', foto: null, foto_url: null });
        }

        await db.query('UPDATE ist_usuarios SET foto = NULL WHERE id_usuario = ?', [idUsuario]);

        try {
            await removeStoredProfilePhoto(fotoAnterior);
        } catch (error) {
            console.warn('Não foi possível remover a foto do usuário após atualizar o banco:', error);
        }

        return res.status(200).json({ message: 'Foto removida com sucesso.', foto: null, foto_url: null });
    } catch (error) {
        console.error('Erro ao remover foto do usuário:', error);
        return res.status(500).json({ message: 'Erro ao remover foto.' });
    }
};

// Logout: expira o cookie de sessão no navegador
const logout = async (_req, res) => {
    res.clearCookie(COOKIE_NAME, buildCookieOptions());
    return res.status(200).json({ message: 'Logout realizado com sucesso.' });
};

export default { login, listarCargos, verificarEmail, cadastrar, confirmarEmail, esqueciSenha, validarTokenSenha, redefinirSenha, me, obterPerfil, atualizarPerfil, atualizarParticipacaoConcorrente, atualizarCurriculo, atualizarFoto, obterFotoPublica, removerFoto, logout };
