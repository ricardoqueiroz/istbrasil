import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool as db } from '../config/db.js';
import { FESTIVAL_II } from '../config/festival.js';
import { resolverEventoPorSlug } from '../services/festivalEventoService.js';
import { enviarEmail } from '../services/mailService.js';
import { comporEmailPorChave, EmailComposicaoError } from '../services/emailTemplateService.js';
import {
    buildProfilePhotoUrl,
    processAndStoreProfilePhoto,
    ProfilePhotoValidationError,
    removeStoredProfilePhoto,
    sendStoredProfilePhoto
} from '../services/profilePhotoService.js';
import { validarVideoConcorrente } from '../services/concorrenteVideoService.js';
import {
    cpfValido,
    dataNascimentoValida,
    emailValido,
    somenteDigitos,
    textoNormalizado
} from '../services/usuarioValidationService.js';

const BCRYPT_ROUNDS = 12;
const HASH_BCRYPT_DUMMY = '$2b$12$uKNr.LozCRYbjD.wVvB0deVP/B5NKLDqhYlI3swBl4j3.3y68xLeO';
const TOKEN_VALIDADE_MINUTOS = 30;
const RESPOSTA_NEUTRA_CADASTRO = 'Se for possível concluir o cadastro, enviaremos as instruções para o e-mail informado.';
// Acrescenta a funcao do e-mail ao nome institucional, mantendo o mesmo fallback de mailService.
const remetenteContextual = (contexto) => `${process.env.MAIL_FROM_NAME || 'IST Brasil'} (${contexto})`;
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

const definirCookieSessao = (res, usuario, maxAgeMs) => {
    const sessionToken = jwt.sign(
        { id_usuario: usuario.id_usuario, id_tipo_usuario: usuario.id_tipo_usuario },
        JWT_SECRET,
        { expiresIn: Math.max(1, Math.floor(maxAgeMs / 1000)) }
    );

    res.cookie(COOKIE_NAME, sessionToken, {
        ...buildCookieOptions(),
        maxAge: maxAgeMs
    });
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
            await bcrypt.compare(senha, HASH_BCRYPT_DUMMY);
            return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
        }

        const usuario = rows[0];
        const senhaValida = await bcrypt.compare(senha, usuario.senha);

        if (!senhaValida) {
            return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
        }

        const cookieOptions = buildCookieOptions();
        const maxAgeMs = manterConectado ? cookieOptions.maxAge * 30 : cookieOptions.maxAge;
        definirCookieSessao(res, usuario, maxAgeMs);

        return res.status(200).json({
            id_usuario: usuario.id_usuario,
            id_tipo_usuario: usuario.id_tipo_usuario,
            nome: usuario.nome,
            foto_url: buildProfilePhotoUrl(usuario.foto)
        });
    } catch (error) {
        console.error('Erro no login de usuário:', error);
        return res.status(500).json({ message: 'Não foi possível processar a solicitação no momento.' });
    }
};

const aderirAoFestivalComoConcorrente = async (req, res) => {
    const idUsuario = req.usuario.id_usuario;
    let connection;
    let transacaoIniciada = false;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transacaoIniciada = true;

        const [usuarioRows] = await connection.query(
            `SELECT id_usuario, id_tipo_usuario, id_situacao, nome, foto
             FROM ist_usuarios
             WHERE id_usuario = ?
             FOR UPDATE`,
            [idUsuario]
        );

        if (usuarioRows.length === 0) {
            await connection.rollback();
            transacaoIniciada = false;
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        const usuario = usuarioRows[0];
        const tipoAtual = Number(usuario.id_tipo_usuario);

        if (tipoAtual !== 2 && tipoAtual !== 3) {
            await connection.rollback();
            transacaoIniciada = false;
            return res.status(403).json({ message: 'Esta conta não pode aderir ao Festival por este fluxo.' });
        }

        if (tipoAtual === 3 && Number(usuario.id_situacao) !== 6) {
            await connection.rollback();
            transacaoIniciada = false;
            return res.status(403).json({ message: 'Esta conta não está apta a aderir ao Festival.' });
        }

        if (tipoAtual === 3) {
            const [promocao] = await connection.query(
                `UPDATE ist_usuarios
                 SET id_tipo_usuario = 2,
                     id_situacao = 3
                 WHERE id_usuario = ?
                   AND id_tipo_usuario = 3`,
                [idUsuario]
            );

            if (promocao.affectedRows !== 1) {
                throw new Error('Não foi possível promover a conta externa para concorrente.');
            }

            usuario.id_tipo_usuario = 2;
            usuario.id_situacao = 3;
        }

        const evento = await resolverEventoPorSlug(FESTIVAL_II.slug, connection);

        const [concorrenteRows] = await connection.query(
            'SELECT id_concorrente FROM ist_concorrentes WHERE id_usuario = ? AND id_evento = ? FOR UPDATE',
            [idUsuario, evento.id]
        );

        if (concorrenteRows.length === 0) {
            await connection.query(
                'INSERT INTO ist_concorrentes (id_usuario, id_evento) VALUES (?, ?)',
                [idUsuario, evento.id]
            );
        }

        await connection.commit();
        transacaoIniciada = false;

        let maxAgeMs = buildCookieOptions().maxAge;
        try {
            const tokenAtual = req.cookies?.[COOKIE_NAME];
            const payloadAtual = tokenAtual ? jwt.verify(tokenAtual, JWT_SECRET) : null;
            const segundosRestantes = Number(payloadAtual?.exp) - Math.floor(Date.now() / 1000);
            if (Number.isFinite(segundosRestantes) && segundosRestantes > 0) {
                maxAgeMs = segundosRestantes * 1000;
            }
        } catch {
            // O middleware já validou a sessão; em caso de dúvida, usa a duração padrão.
        }

        definirCookieSessao(res, usuario, maxAgeMs);

        return res.status(200).json({
            message: tipoAtual === 3 ? 'Adesão ao Festival realizada com sucesso.' : 'A conta já está habilitada como concorrente.',
            usuario: {
                id_usuario: usuario.id_usuario,
                id_tipo_usuario: 2,
                nome: usuario.nome,
                foto_url: buildProfilePhotoUrl(usuario.foto)
            }
        });
    } catch (error) {
        if (transacaoIniciada) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Erro ao desfazer adesão ao Festival:', rollbackError);
            }
        }
        console.error('Erro ao aderir ao Festival:', error);
        return res.status(500).json({ message: 'Não foi possível concluir a adesão ao Festival.' });
    } finally {
        if (connection) {
            connection.release();
        }
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

const formatarDataApresentacao = (valor) => {
    if (valor instanceof Date) {
        const dia = String(valor.getUTCDate()).padStart(2, '0');
        const mes = String(valor.getUTCMonth() + 1).padStart(2, '0');
        return `${dia}/${mes}/${valor.getUTCFullYear()}`;
    }

    const dataIso = String(valor || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(dataIso)
        ? dataIso.split('-').reverse().join('/')
        : 'Não informada';
};

const processarConfirmacaoInscricaoPendente = async (idUsuario) => {
    let snapshot;

    try {
        const evento = await resolverEventoPorSlug(FESTIVAL_II.slug);
        const [rows] = await db.query(
            `SELECT u.nome, u.email, u.telefone_celular, u.data_nascimento, u.cidade, u.uf,
                    c.id_concorrente, c.numero_concorrente, c.id_obra_1, c.link_video_1, c.id_obra_2, c.link_video_2,
                    c.aceite_regulamento, c.confirmacao_inscricao_enviada,
                    obra1.titulo AS titulo_obra_1,
                    obra2.titulo AS titulo_obra_2
             FROM ist_usuarios u
             INNER JOIN ist_concorrentes c ON c.id_usuario = u.id_usuario
             LEFT JOIN ist_composicao obra1 ON obra1.id_obra = c.id_obra_1
             LEFT JOIN ist_composicao obra2 ON obra2.id_obra = c.id_obra_2
             WHERE u.id_usuario = ? AND c.id_evento = ?`,
            [idUsuario, evento.id]
        );
        snapshot = rows[0] || null;
    } catch (error) {
        console.error('[EMAIL_INSCRICAO] Erro ao carregar snapshot da inscrição:', error.message);
        return false;
    }

    if (!snapshot || !Boolean(snapshot.aceite_regulamento)) {
        console.error('[EMAIL_INSCRICAO] Snapshot da inscrição aceito não encontrado.');
        return false;
    }

    if (Boolean(snapshot.confirmacao_inscricao_enviada)) {
        return true;
    }

    const variaveis = {
        nome: String(snapshot.nome || 'Não informado'),
        numero_concorrente: String(snapshot.numero_concorrente || 'Não informado'),
        email: String(snapshot.email || 'Não informado'),
        telefone: String(snapshot.telefone_celular || 'Não informado'),
        data_nascimento: formatarDataApresentacao(snapshot.data_nascimento),
        cidade: String(snapshot.cidade || 'Não informada'),
        uf: String(snapshot.uf || 'Não informada'),
        musica_1: String(snapshot.titulo_obra_1 || 'Não informada'),
        video_1: String(snapshot.link_video_1 || 'Não informado'),
        musica_2: String(snapshot.titulo_obra_2 || 'Não informada'),
        video_2: String(snapshot.link_video_2 || 'Não informado')
    };

    let composicao;
    try {
        composicao = await comporEmailPorChave('confirmacao_inscricao_festival', variaveis);
    } catch (error) {
        const codigo = error instanceof EmailComposicaoError ? error.codigo : 'ERRO_INESPERADO';
        console.error('[EMAIL_COMPOSICAO] chave=confirmacao_inscricao_festival codigo=%s', codigo);
        return false;
    }

    try {
        await enviarEmail({
            to: snapshot.email,
            fromName: remetenteContextual('Confirmação de Inscrição'),
            subject: composicao.assunto,
            html: composicao.html,
            text: composicao.text
        });
    } catch (error) {
        console.error('[EMAIL_ENVIO] Erro ao enviar confirmação da inscrição:', error.message);
        return false;
    }

    try {
        const [result] = await db.query(
            `UPDATE ist_concorrentes
             SET confirmacao_inscricao_enviada = 1,
                 confirmacao_inscricao_enviada_em = NOW()
             WHERE id_concorrente = ?
               AND aceite_regulamento = 1
               AND confirmacao_inscricao_enviada = 0`,
            [snapshot.id_concorrente]
        );

        if (result.affectedRows === 1) {
            return true;
        }

        const [estadoRows] = await db.query(
            'SELECT confirmacao_inscricao_enviada FROM ist_concorrentes WHERE id_concorrente = ?',
            [snapshot.id_concorrente]
        );
        return Boolean(estadoRows[0]?.confirmacao_inscricao_enviada);
    } catch (error) {
        console.error('[EMAIL_INSCRICAO] E-mail enviado, mas a marcação da confirmação falhou:', error.message);
        return false;
    }
};

const liberarLockSequenciaInscricao = async (connection, lockName) => {
    const [rows] = await connection.query(
        'SELECT RELEASE_LOCK(?) AS liberado',
        [lockName]
    );

    if (Number(rows[0]?.liberado) !== 1) {
        throw new Error('Não foi possível liberar o lock da sequência de inscrições.');
    }
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

    if (!emailValido(emailNormalizado)) {
        return res.status(400).json({ message: 'Informe um e-mail válido.' });
    }

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

    const tokenConfirmacao = crypto.randomBytes(32).toString('hex');
    const tokenExpiraEm = new Date(Date.now() + TOKEN_VALIDADE_MINUTOS * 60 * 1000);
    const linkConfirmacao = `${process.env.APP_URL || 'https://www.istbrasil.org.br'}/confirmar-email?token=${tokenConfirmacao}`;

    // Compor antes do INSERT evita criar um usuario que jamais podera ser confirmado.
    let composicaoConfirmacao;
    try {
        composicaoConfirmacao = await comporEmailPorChave('confirmacao_email', { nome: nome.trim(), link: linkConfirmacao });
    } catch (error) {
        if (error instanceof EmailComposicaoError) {
            console.error('[EMAIL_COMPOSICAO] Falha ao compor confirmacao_email:', error.codigo);
        } else {
            console.error('[EMAIL_COMPOSICAO] Erro inesperado ao compor confirmacao_email:', error.message);
        }
        return res.status(500).json({ message: 'Não foi possível concluir o cadastro no momento. Tente novamente mais tarde.' });
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
            const evento = await resolverEventoPorSlug(FESTIVAL_II.slug, connection);
            await connection.query(
                `INSERT INTO ist_concorrentes
                    (id_usuario, id_evento)
                 VALUES (?, ?)`,
                [result.insertId, evento.id]
            );
        }

        await connection.commit();
        transacaoIniciada = false;
        cadastroConfirmacao = { id_usuario: result.insertId, email: emailNormalizado, nome: nome.trim() };
    } catch (error) {
        if (transacaoIniciada) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Erro ao desfazer cadastro de usuário:', rollbackError);
            }
        }

        if (error.code === 'DUPLICATE_EMAIL') {
            return res.status(200).json({ message: RESPOSTA_NEUTRA_CADASTRO });
        }

        if (error.code === 'DUPLICATE_CPF' || error.code === 'ER_DUP_ENTRY') {
            return res.status(200).json({ message: RESPOSTA_NEUTRA_CADASTRO });
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

    try {
        await enviarEmail({
            to: cadastroConfirmacao.email,
            fromName: remetenteContextual('Confirmação de Email'),
            subject: composicaoConfirmacao.assunto,
            html: composicaoConfirmacao.html,
            text: composicaoConfirmacao.text
        });
    } catch (mailError) {
        // O banco já confirmou o cadastro; falha SMTP não desfaz o commit.
        console.error('[EMAIL_ENVIO] Erro ao enviar e-mail de confirmação após cadastro confirmado:', mailError.message);
    }

    return res.status(200).json({ message: RESPOSTA_NEUTRA_CADASTRO });
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

// Passo 1 do "Esqueci a senha": gera token e envia o link de redefinição por e-mail.
// A resposta publica e sempre a mesma para nao revelar se a conta existe.
const RESPOSTA_NEUTRA_SENHA = 'Se o e-mail informado estiver cadastrado, você receberá as instruções para redefinir sua senha.';

const esqueciSenha = async (req, res) => {
    const email = (req.body.email || '').toString().trim().toLowerCase();

    if (!email) {
        return res.status(400).json({ message: 'Informe o e-mail cadastrado.' });
    }

    if (!emailValido(email)) {
        return res.status(400).json({ message: 'Informe um e-mail válido.' });
    }

    try {
        const [rows] = await db.query('SELECT id_usuario, nome FROM ist_usuarios WHERE email = ?', [email]);

        if (rows.length === 0) {
            return res.status(200).json({ message: RESPOSTA_NEUTRA_SENHA });
        }

        const usuario = rows[0];
        const tokenSenha = crypto.randomBytes(32).toString('hex');
        const tokenExpiraEm = new Date(Date.now() + TOKEN_VALIDADE_MINUTOS * 60 * 1000);
        const linkRedefinicao = `${process.env.APP_URL || 'https://www.istbrasil.org.br'}/redefinir-senha?token=${tokenSenha}`;

        // Compor antes do UPDATE evita gravar um token que nunca chegara ao usuario.
        let composicao;
        try {
            composicao = await comporEmailPorChave('redefinicao_senha', { nome: usuario.nome, link: linkRedefinicao });
        } catch (composicaoError) {
            if (composicaoError instanceof EmailComposicaoError) {
                console.error('[EMAIL_COMPOSICAO] chave=redefinicao_senha codigo=%s', composicaoError.codigo);
            } else {
                console.error('[EMAIL_COMPOSICAO] chave=redefinicao_senha falha inesperada:', composicaoError.message);
            }
            return res.status(200).json({ message: RESPOSTA_NEUTRA_SENHA });
        }

        await db.query(
            "UPDATE ist_usuarios SET token_confirmacao = ?, token_expira_em = ?, token_tipo = 'reset_senha' WHERE id_usuario = ?",
            [tokenSenha, tokenExpiraEm, usuario.id_usuario]
        );

        try {
            await enviarEmail({
                to: email,
                fromName: remetenteContextual('Redefinição de Senha'),
                subject: composicao.assunto,
                html: composicao.html,
                text: composicao.text
            });
        } catch (mailError) {
            console.error('[EMAIL_ENVIO] Erro ao enviar e-mail de redefinição de senha:', mailError.message);
            return res.status(200).json({ message: RESPOSTA_NEUTRA_SENHA });
        }

        return res.status(200).json({ message: RESPOSTA_NEUTRA_SENHA });
    } catch (error) {
        console.error('Erro ao solicitar redefinição de senha:', error);
        return res.status(500).json({ message: 'Não foi possível processar a solicitação no momento.' });
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
            const evento = await resolverEventoPorSlug(FESTIVAL_II.slug);
            const [concorrenteRows] = await db.query(
                `SELECT c.id_usuario AS concorrente_usuario_id, c.id_concorrente, c.id_evento,
                        c.numero_concorrente, c.id_obra_1, c.link_video_1,
                    c.id_obra_2, c.link_video_2, c.aceite_regulamento, c.data_cadastro,
                        obra1.titulo AS titulo_obra_1,
                        obra2.titulo AS titulo_obra_2
                 FROM ist_concorrentes c
                 LEFT JOIN ist_composicao obra1 ON obra1.id_obra = c.id_obra_1
                 LEFT JOIN ist_composicao obra2 ON obra2.id_obra = c.id_obra_2
                 WHERE c.id_usuario = ? AND c.id_evento = ?`,
                [idUsuario, evento.id]
            );

            if (concorrenteRows.length === 1 && Number(concorrenteRows[0].concorrente_usuario_id) === Number(idUsuario)
                && Number(concorrenteRows[0].id_evento) === Number(evento.id)
                && Number.isSafeInteger(Number(concorrenteRows[0].id_concorrente))
                && Number(concorrenteRows[0].id_concorrente) > 0) {
                const dadosConcorrente = concorrenteRows[0];
                let idEtapaInscricoes = null;
                if (FESTIVAL_II.idEtapaInscricoes !== null) {
                    const [etapas] = await db.query(
                        'SELECT id, evento_id FROM ist_eventos_etapas WHERE id = ? AND evento_id = ?',
                        [FESTIVAL_II.idEtapaInscricoes, evento.id]
                    );
                    if (etapas.length === 1 && Number(etapas[0].id) === FESTIVAL_II.idEtapaInscricoes
                        && Number(etapas[0].evento_id) === Number(evento.id)) {
                        idEtapaInscricoes = Number(etapas[0].id);
                    }
                }
                concorrente = {
                    idEvento: Number(dadosConcorrente.id_evento),
                    idConcorrente: Number(dadosConcorrente.id_concorrente),
                    idEtapaInscricoes,
                    numeroConcorrente: dadosConcorrente.numero_concorrente,
                    idObra1: dadosConcorrente.id_obra_1,
                    tituloObra1: dadosConcorrente.titulo_obra_1,
                    linkVideo1: dadosConcorrente.link_video_1,
                    idObra2: dadosConcorrente.id_obra_2,
                    tituloObra2: dadosConcorrente.titulo_obra_2,
                    linkVideo2: dadosConcorrente.link_video_2,
                    aceiteRegulamento: Boolean(dadosConcorrente.aceite_regulamento),
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
        uf,
        aceiteRegulamento
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

    let connection;
    let transacaoIniciada = false;

    try {
        const [usuarioRows] = await db.query(
            'SELECT id_tipo_usuario, email, cpf, telefone_celular, email_confirmado, celular_confirmado FROM ist_usuarios WHERE id_usuario = ?',
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
        const concorrente = Number(usuarioAtual.id_tipo_usuario) === 2;
        let aceitePersistido = false;
        let idEventoConcorrente;
        let executor = db;

        if (concorrente) {
            connection = await db.getConnection();
            await connection.beginTransaction();
            transacaoIniciada = true;
            executor = connection;
            const evento = await resolverEventoPorSlug(FESTIVAL_II.slug, connection);
            idEventoConcorrente = evento.id;

            const [concorrenteRows] = await connection.query(
                `SELECT id_obra_1, link_video_1, id_obra_2, link_video_2, aceite_regulamento
                 FROM ist_concorrentes
                 WHERE id_usuario = ? AND id_evento = ?
                 FOR UPDATE`,
                [idUsuario, evento.id]
            );

            if (concorrenteRows.length === 0) {
                await connection.rollback();
                transacaoIniciada = false;
                return res.status(409).json({ message: 'Cadastro de concorrente inconsistente.' });
            }

            const dadosConcorrente = concorrenteRows[0];
            aceitePersistido = Boolean(dadosConcorrente.aceite_regulamento);

            if (!aceitePersistido) {
                if (aceiteRegulamento !== true) {
                    await connection.rollback();
                    transacaoIniciada = false;
                    return res.status(400).json({ message: 'É necessário aceitar o Regulamento do Festival para salvar o perfil.' });
                }

                if (Number(dadosConcorrente.id_obra_1) !== FESTIVAL_II.idObraPrincipal || !validarVideoConcorrente(dadosConcorrente.link_video_1)) {
                    await connection.rollback();
                    transacaoIniciada = false;
                    return res.status(400).json({ message: 'Informe a obra obrigatória e um vídeo válido antes de aceitar o regulamento.' });
                }

                if (dadosConcorrente.id_obra_2 !== null && !validarVideoConcorrente(dadosConcorrente.link_video_2)) {
                    await connection.rollback();
                    transacaoIniciada = false;
                    return res.status(400).json({ message: 'Informe um vídeo válido para a segunda obra antes de aceitar o regulamento.' });
                }
            }
        }

        const [duplicados] = await executor.query(
            'SELECT email, cpf FROM ist_usuarios WHERE (email = ? OR cpf = ?) AND id_usuario <> ?',
            [dados.email, dados.cpf, idUsuario]
        );

        if (duplicados.some((usuario) => textoNormalizado(usuario.email).toLowerCase() === dados.email)) {
            if (transacaoIniciada) {
                await connection.rollback();
                transacaoIniciada = false;
            }
            return res.status(409).json({ message: 'Este e-mail já está cadastrado.' });
        }

        if (duplicados.some((usuario) => somenteDigitos(usuario.cpf) === dados.cpf)) {
            if (transacaoIniciada) {
                await connection.rollback();
                transacaoIniciada = false;
            }
            return res.status(409).json({ message: 'Este CPF já está cadastrado.' });
        }

        await executor.query(
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

        if (concorrente && !aceitePersistido) {
            await connection.query(
                `UPDATE ist_concorrentes
                 SET aceite_regulamento = 1
                 WHERE id_usuario = ? AND id_evento = ?
                   AND aceite_regulamento = 0`,
                [idUsuario, idEventoConcorrente]
            );
            aceitePersistido = true;
        }

        const [atualizados] = await executor.query(
            `SELECT id_usuario, id_tipo_usuario, id_cargo, id_situacao, nome, foto,
                    data_nascimento, cpf, identidade, curriculo, email, email_confirmado,
                    telefone_celular, celular_confirmado, cep, logradouro, numero,
                    complemento, bairro, cidade, uf
             FROM ist_usuarios
             WHERE id_usuario = ?`,
            [idUsuario]
        );

        if (transacaoIniciada) {
            await connection.commit();
            transacaoIniciada = false;
        }

        const confirmacaoInscricaoEnviada = concorrente && aceitePersistido
            ? await processarConfirmacaoInscricaoPendente(idUsuario)
            : null;

        const usuario = atualizados[0];
        return res.status(200).json({
            message: confirmacaoInscricaoEnviada === false
                ? 'Perfil atualizado com sucesso. A confirmação da inscrição permanece pendente.'
                : 'Perfil atualizado com sucesso.',
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
            ...(concorrente ? {
                concorrente: {
                    aceiteRegulamento: aceitePersistido,
                    confirmacaoInscricaoEnviada
                }
            } : {})
        });
    } catch (error) {
        if (transacaoIniciada) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Erro ao desfazer atualização do perfil do concorrente:', rollbackError);
            }
        }

        if (error.code === 'ER_DUP_ENTRY') {
            const mensagem = error.message?.toLowerCase().includes('email')
                ? 'Este e-mail já está cadastrado.'
                : 'Este CPF já está cadastrado.';
            return res.status(409).json({ message: mensagem });
        }

        console.error('Erro ao atualizar perfil do usuário:', error);
        return res.status(500).json({ message: 'Erro ao atualizar perfil.' });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

const atualizarParticipacaoConcorrente = async (req, res) => {
    const idUsuario = req.usuario.id_usuario;
    const payload = req.body || {};
    const { linkVideo1, idObra2, linkVideo2, aceiteRegulamento } = payload;
    const aceiteInformado = Object.prototype.hasOwnProperty.call(payload, 'aceiteRegulamento');
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

    if (aceiteInformado && typeof aceiteRegulamento !== 'boolean') {
        return res.status(400).json({ message: 'O aceite do regulamento deve ser verdadeiro ou falso.' });
    }

    let connection;
    let transacaoIniciada = false;
    let lockSequenciaAdquirido = false;
    let lockSequenciaNome;

    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        transacaoIniciada = true;

        const [usuarioRows] = await connection.query(
            'SELECT id_tipo_usuario FROM ist_usuarios WHERE id_usuario = ?',
            [idUsuario]
        );

        if (usuarioRows.length === 0) {
            await connection.rollback();
            transacaoIniciada = false;
            res.clearCookie(COOKIE_NAME, buildCookieOptions());
            return res.status(401).json({ message: 'Sessão inválida.' });
        }

        if (Number(usuarioRows[0].id_tipo_usuario) !== 2) {
            await connection.rollback();
            transacaoIniciada = false;
            return res.status(403).json({ message: 'A participação do Festival está disponível apenas para concorrentes.' });
        }

        const evento = await resolverEventoPorSlug(FESTIVAL_II.slug, connection);
        lockSequenciaNome = `istbrasil:concorrentes:sequencia:${evento.id}:${FESTIVAL_II.prefixoInscricao}`;

        const [concorrenteRows] = await connection.query(
            `SELECT id_concorrente, numero_concorrente, id_obra_1, aceite_regulamento, confirmacao_inscricao_enviada
             FROM ist_concorrentes
             WHERE id_usuario = ? AND id_evento = ?
             FOR UPDATE`,
            [idUsuario, evento.id]
        );

        if (concorrenteRows.length === 0) {
            await connection.rollback();
            transacaoIniciada = false;
            return res.status(409).json({ message: 'Cadastro de concorrente inconsistente.' });
        }

        let aceitePersistido = Boolean(concorrenteRows[0].aceite_regulamento);
        let confirmacaoInscricaoEnviada = Boolean(concorrenteRows[0].confirmacao_inscricao_enviada);
        const idParticipacao = concorrenteRows[0].id_concorrente;
        let numeroConcorrente = concorrenteRows[0].numero_concorrente || null;

        if (aceiteInformado && !aceitePersistido && aceiteRegulamento !== true) {
            await connection.rollback();
            transacaoIniciada = false;
            return res.status(400).json({ message: 'É necessário aceitar o Regulamento do Festival para concluir a inscrição.' });
        }

        const [obraPrincipalVigenteRows] = await connection.query(
            'SELECT id_obra, titulo, partitura, propria FROM ist_composicao WHERE id_obra = ?',
            [FESTIVAL_II.idObraPrincipal]
        );

        const obraPrincipalVigente = obraPrincipalVigenteRows[0];
        if (!obraPrincipalVigente
            || Number(obraPrincipalVigente.id_obra) !== FESTIVAL_II.idObraPrincipal
            || Number(obraPrincipalVigente.propria) !== 1) {
            await connection.rollback();
            transacaoIniciada = false;
            console.error('Obra principal do concorrente não encontrada ou inelegível em ist_composicao.');
            return res.status(500).json({ message: 'Não foi possível validar a obra principal.' });
        }

        const idObraPrincipalPersistida = aceitePersistido
            ? Number(concorrenteRows[0].id_obra_1)
            : FESTIVAL_II.idObraPrincipal;

        if (!Number.isInteger(idObraPrincipalPersistida) || idObraPrincipalPersistida <= 0) {
            await connection.rollback();
            transacaoIniciada = false;
            return res.status(409).json({ message: 'A inscrição aceita não possui obra principal válida.' });
        }

        let obraPrincipal = obraPrincipalVigente;
        if (idObraPrincipalPersistida !== FESTIVAL_II.idObraPrincipal) {
            const [obraPrincipalHistoricaRows] = await connection.query(
                'SELECT id_obra, titulo, partitura, propria FROM ist_composicao WHERE id_obra = ?',
                [idObraPrincipalPersistida]
            );
            obraPrincipal = obraPrincipalHistoricaRows[0];

            if (!obraPrincipal || Number(obraPrincipal.id_obra) !== idObraPrincipalPersistida) {
                await connection.rollback();
                transacaoIniciada = false;
                return res.status(409).json({ message: 'A obra principal histórica da inscrição não foi encontrada.' });
            }
        }

        let obraSecundaria = null;
        if (segundaObraInformada) {
            if (idObra2Normalizado === idObraPrincipalPersistida) {
                await connection.rollback();
                transacaoIniciada = false;
                return res.status(400).json({ message: 'A segunda obra deve ser diferente da obra principal.' });
            }

            const [obraRows] = await connection.query(
                `SELECT id_obra, titulo
                 FROM ist_composicao
                 WHERE id_obra = ?
                   AND propria = 1
                   AND id_obra <> ?`,
                [idObra2Normalizado, FESTIVAL_II.idObraPrincipal]
            );

            if (obraRows.length === 0) {
                await connection.rollback();
                transacaoIniciada = false;
                return res.status(400).json({ message: 'A segunda obra informada não é elegível.' });
            }

            obraSecundaria = obraRows[0];
        }

        if (aceitePersistido) {
            await connection.query(
                `UPDATE ist_concorrentes
                 SET link_video_1 = ?, id_obra_2 = ?, link_video_2 = ?
                 WHERE id_concorrente = ?`,
                [video1Normalizado, idObra2Normalizado, segundaObraInformada ? video2Normalizado : null, idParticipacao]
            );
        } else {
            await connection.query(
                `UPDATE ist_concorrentes
                 SET id_obra_1 = ?, link_video_1 = ?, id_obra_2 = ?, link_video_2 = ?
                 WHERE id_concorrente = ?`,
                [FESTIVAL_II.idObraPrincipal, video1Normalizado, idObra2Normalizado, segundaObraInformada ? video2Normalizado : null, idParticipacao]
            );
        }

        if (aceiteInformado && !aceitePersistido && aceiteRegulamento === true) {
            if (!numeroConcorrente) {
                const [lockRows] = await connection.query(
                    'SELECT GET_LOCK(?, 10) AS adquirido',
                    [lockSequenciaNome]
                );

                if (Number(lockRows[0]?.adquirido) !== 1) {
                    throw new Error('Não foi possível serializar a geração do número de inscrição.');
                }
                lockSequenciaAdquirido = true;

                const regexPrefixo = `^${FESTIVAL_II.prefixoInscricao}-[0-9]+$`;
                const [sequenciaRows] = await connection.query(
                    `SELECT numero_concorrente
                     FROM ist_concorrentes
                     WHERE id_evento = ? AND numero_concorrente REGEXP ?
                     FOR UPDATE`,
                    [evento.id, regexPrefixo]
                );
                const ultimoNumero = sequenciaRows.reduce((maior, concorrente) => {
                    const sufixo = Number(String(concorrente.numero_concorrente).slice(FESTIVAL_II.prefixoInscricao.length + 1));
                    return Number.isInteger(sufixo) && sufixo > maior ? sufixo : maior;
                }, 0);
                const proximoNumero = ultimoNumero + 1;
                numeroConcorrente = `${FESTIVAL_II.prefixoInscricao}-${String(proximoNumero).padStart(3, '0')}`;
            }

            const [aceiteResult] = numeroConcorrente === concorrenteRows[0].numero_concorrente
                ? await connection.query(
                    `UPDATE ist_concorrentes
                     SET aceite_regulamento = 1
                     WHERE id_concorrente = ?
                       AND aceite_regulamento = 0`,
                    [idParticipacao]
                )
                : await connection.query(
                    `UPDATE ist_concorrentes
                     SET numero_concorrente = ?, aceite_regulamento = 1
                     WHERE id_concorrente = ?
                       AND aceite_regulamento = 0
                       AND numero_concorrente IS NULL`,
                    [numeroConcorrente, idParticipacao]
                );
            aceitePersistido = aceiteResult.affectedRows === 1;

            if (!aceitePersistido) {
                throw new Error('A primeira conclusão da inscrição não foi persistida.');
            }
        }

        await connection.commit();
        transacaoIniciada = false;

        if (lockSequenciaAdquirido) {
            await liberarLockSequenciaInscricao(connection, lockSequenciaNome);
            lockSequenciaAdquirido = false;
        }

        if (aceiteInformado && aceiteRegulamento === true && aceitePersistido && !confirmacaoInscricaoEnviada) {
            confirmacaoInscricaoEnviada = await processarConfirmacaoInscricaoPendente(idUsuario);
        }

        return res.status(200).json({
            message: aceiteInformado && aceiteRegulamento === true && !confirmacaoInscricaoEnviada
                ? 'Participação atualizada com sucesso. A confirmação da inscrição permanece pendente.'
                : 'Participação atualizada com sucesso.',
            concorrente: {
                numeroConcorrente,
                idObra1: idObraPrincipalPersistida,
                tituloObra1: obraPrincipal.titulo,
                linkVideo1: video1Normalizado,
                idObra2: segundaObraInformada ? idObra2Normalizado : null,
                tituloObra2: obraSecundaria?.titulo || null,
                linkVideo2: segundaObraInformada ? video2Normalizado : null,
                aceiteRegulamento: aceitePersistido,
                confirmacaoInscricaoEnviada
            }
        });
    } catch (error) {
        if (transacaoIniciada) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Erro ao desfazer atualização da participação:', rollbackError);
            }
        }
        console.error('Erro ao atualizar participação do concorrente:', error);
        return res.status(500).json({ message: 'Erro ao atualizar participação.' });
    } finally {
        if (connection && lockSequenciaAdquirido) {
            try {
                await liberarLockSequenciaInscricao(connection, lockSequenciaNome);
            } catch (lockError) {
                console.error('Erro ao liberar lock da sequência de inscrições:', lockError);
                connection.destroy();
                connection = null;
            }
        }
        if (connection) {
            connection.release();
        }
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

export default { login, aderirAoFestivalComoConcorrente, listarCargos, cadastrar, confirmarEmail, esqueciSenha, validarTokenSenha, redefinirSenha, me, obterPerfil, atualizarPerfil, atualizarParticipacaoConcorrente, atualizarCurriculo, atualizarFoto, obterFotoPublica, removerFoto, logout };
