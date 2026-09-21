import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool as db } from '../config/db.js';
import { sendAccountMail } from '../services/mailService.js';

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

        if (id_tipo_usuario && usuario.id_tipo_usuario !== Number(id_tipo_usuario)) {
            const [tipos] = await db.query('SELECT descricao FROM ist_tipo_usuario WHERE id_tipo = ?', [usuario.id_tipo_usuario]);
            const descricao = tipos[0]?.descricao || 'outro perfil';

            return res.status(403).json({
                message: `Você já está cadastrado como ${descricao}. Procure o suporte para mais informações.`
            });
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
            foto_url: usuario.foto || null
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

// Cadastro de Diretoria (id_tipo_usuario = 1); a senha chega em SHA-256 (calculada no front)
// e o backend aplica bcrypt (com salt) por cima antes de gravar.
const cadastrar = async (req, res) => {
    const { nome, email, confirmarEmail, cpf, telefone_celular, senha, id_cargo, identidade, data_nascimento, logradouro, numero, complemento, bairro, cidade, uf, cep } = req.body;

    if (!nome?.trim() || !email?.trim() || !senha?.trim() || !cpf?.trim() || !telefone_celular?.trim() || !id_cargo || !data_nascimento) {
        return res.status(400).json({ message: 'Preencha todos os campos obrigatórios.' });
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

    try {
        const [existentes] = await db.query('SELECT id_usuario, email, cpf FROM ist_usuarios WHERE email = ? OR cpf = ?', [emailNormalizado, cpfNormalizado]);

        const emailDuplicado = existentes.find((u) => u.email === emailNormalizado);
        if (emailDuplicado) {
            return res.status(409).json({ message: 'Este e-mail já está cadastrado. Faça login ou recupere sua senha.' });
        }

        const cpfDuplicado = existentes.find((u) => u.cpf === cpfNormalizado);
        if (cpfDuplicado) {
            return res.status(409).json({ message: 'Este CPF já está cadastrado.' });
        }

        const senhaBcrypt = await bcrypt.hash(senha, BCRYPT_ROUNDS);
        const tokenConfirmacao = crypto.randomBytes(32).toString('hex');
        const tokenExpiraEm = new Date(Date.now() + TOKEN_VALIDADE_MINUTOS * 60 * 1000);

        // id_tipo_usuario = 1 (Diretoria) e id_situacao = 1 (Normal) são fixados pelo backend, nunca pelo cliente
        const [result] = await db.query(
            `INSERT INTO ist_usuarios
                (id_tipo_usuario, id_cargo, id_situacao, senha, nome, cpf, identidade, data_nascimento, email, telefone_celular,
                 logradouro, numero, complemento, bairro, cidade, uf, cep,
                 token_confirmacao, token_expira_em, token_tipo)
             VALUES (1, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email')`,
            [
                id_cargo,
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

        const linkConfirmacao = `${process.env.APP_URL || 'https://www.istbrasil.org.br'}/confirmar-email?token=${tokenConfirmacao}`;

        try {
            await sendAccountMail({
                to: emailNormalizado,
                subject: 'Confirme seu e-mail - IST Brasil',
                html: `<p>Olá, ${nome.trim()}!</p><p>Confirme seu cadastro clicando no link abaixo (válido por ${TOKEN_VALIDADE_MINUTOS} minutos):</p><p><a href="${linkConfirmacao}">${linkConfirmacao}</a></p>`
            });
        } catch (mailError) {
            // Cadastro já foi salvo; falha no envio de e-mail não deve derrubar a resposta de sucesso
            console.error('Erro ao enviar e-mail de confirmação:', mailError.message);
        }

        return res.status(201).json({ id_usuario: result.insertId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'E-mail ou CPF já cadastrado.' });
        }

        console.error('Erro ao cadastrar usuário:', error);
        return res.status(500).json({ message: 'Erro ao cadastrar usuário.', error: error.message });
    }
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

// Checagem de sessão: lê o cookie assinado (JWT) e retorna os dados atuais do usuário
const me = async (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];

    if (!token) {
        return res.status(401).json({ message: 'Não autenticado.' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);

        const [rows] = await db.query('SELECT id_usuario, nome, foto, id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?', [payload.id_usuario]);

        if (rows.length === 0) {
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        const usuario = rows[0];

        return res.status(200).json({
            id_usuario: usuario.id_usuario,
            id_tipo_usuario: usuario.id_tipo_usuario,
            nome: usuario.nome,
            foto_url: usuario.foto || null
        });
    } catch (error) {
        res.clearCookie(COOKIE_NAME, buildCookieOptions());
        return res.status(401).json({ message: 'Sessão expirada ou inválida.' });
    }
};

// Logout: expira o cookie de sessão no navegador
const logout = async (_req, res) => {
    res.clearCookie(COOKIE_NAME, buildCookieOptions());
    return res.status(200).json({ message: 'Logout realizado com sucesso.' });
};

export default { login, listarCargos, verificarEmail, cadastrar, confirmarEmail, esqueciSenha, validarTokenSenha, redefinirSenha, me, logout };
