import nodemailer from 'nodemailer';
import { normalizarEmailComprador } from './lojaPedidoContratos.js';

// Opt-in independente de NODE_ENV. IP literal evita resolucao DNS e fallback externo.
const opcoesCapturaLocal = env => {
    const flag = env.IST_SMTP_CAPTURA_LOCAL;
    if (flag === undefined || flag === 'false') return null;
    if (flag !== 'true' || !['127.0.0.1', '::1'].includes(env.SMTP_HOST)
        || typeof env.SMTP_PORT !== 'string' || !/^[1-9]\d{0,4}$/.test(env.SMTP_PORT)
        || Number(env.SMTP_PORT) > 65535 || env.SMTP_SECURE !== 'false'
        || env.SMTP_REJECT_UNAUTHORIZED !== 'true' || env.SMTP_USER || env.SMTP_PASS
        || (env.IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO !== undefined
            && env.IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO !== 'relay')) {
        throw new Error('CONFIGURACAO_SMTP_CAPTURA_LOCAL_INVALIDA');
    }
    return { host: env.SMTP_HOST, port: Number(env.SMTP_PORT), secure: false,
        requireTLS: false, ignoreTLS: true, tls: { rejectUnauthorized: true } };
};

export const obterOpcoesSmtpGeral = (env = process.env) => opcoesCapturaLocal(env) ?? {
    // Preservar o transporte legado quando a captura nao estiver habilitada.
    host: env.SMTP_HOST || 'localhost',
    port: Number(env.SMTP_PORT) || 587,
    secure: env.SMTP_SECURE === 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    tls: { rejectUnauthorized: env.SMTP_REJECT_UNAUTHORIZED === 'true' }
};

export const mailTransporter = nodemailer.createTransport(obterOpcoesSmtpGeral());

const senderBySubject = {
    'Dúvida': 'duvida@istbrasil.org.br',
    'Solicitação': 'solicitacao@istbrasil.org.br',
    'Parceria': 'parceria@istbrasil.org.br',
    'Outro assunto': 'contato@istbrasil.org.br'
};

function getSenderEmail(subject) {
    const normalizedSubject = String(subject || '')
        .replace(/^\[Fale Conosco\]\s*/i, '')
        .trim();

    return senderBySubject[normalizedSubject] || 'contato@istbrasil.org.br';
}

export async function enviarEmail({ to, subject, html, text, fromName, fromAddress, replyTo }, transporte = mailTransporter) {
    if (!to || !subject || (!html && !text)) {
        throw new TypeError('Destinatário, assunto e conteúdo do e-mail são obrigatórios.');
    }

    const nomeRemetente = fromName || process.env.MAIL_FROM_NAME || 'IST Brasil';
    const enderecoRemetente = fromAddress || process.env.MAIL_FROM_ADDRESS || 'contato@istbrasil.org.br';
    const mensagem = {
        from: { name: nomeRemetente, address: enderecoRemetente },
        to,
        subject,
        ...(html ? { html } : {}),
        ...(text ? { text } : {}),
        ...(replyTo ? { replyTo } : {})
    };

    return transporte.sendMail(mensagem);
}

// Transporte estrito e sem fallback, reservado a recuperacao. Nao altera o relay legado.
// Criar o transporte nao conecta: nao chamar verify() ou sendMail() na inicializacao.
export function criarEnvioRecuperacaoSmtp({ env = process.env, criarTransporte = nodemailer.createTransport, classificarNaoAceito = false } = {}) {
    const falhar = () => { throw new Error('CONFIGURACAO_SMTP_RECUPERACAO_INVALIDA'); };
    const host = env.SMTP_HOST, porta = env.SMTP_PORT, nome = env.MAIL_FROM_NAME, remetente = env.MAIL_FROM_ADDRESS;
    const captura = opcoesCapturaLocal(env);
    try { if (normalizarEmailComprador(remetente) !== remetente) falhar(); } catch { falhar(); }
    if ((!captura && (typeof host !== 'string' || host.length > 253 || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)
        || !host.includes('.') || host.split('.').some(s => !s || s.length > 63 || s.startsWith('-') || s.endsWith('-'))
        || !['465', '587'].includes(porta) || env.SMTP_SECURE !== (porta === '465' ? 'true' : 'false')
        || env.SMTP_REJECT_UNAUTHORIZED !== 'true')) || typeof criarTransporte !== 'function'
        || typeof remetente !== 'string' || remetente.length > 254
        || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(remetente)
        || typeof nome !== 'string' || !nome.trim() || nome.length > 100 || /[\x00-\x1f\x7f]/.test(nome)) falhar();

    // SMTP_USER, SMTP_PASS
    // modo==login → usuário e senha obrigatórios
    // modo==relay → usuário e senha ausente
    const modo = env.IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO;
    let auth;
    if (modo === 'login') {
        if (typeof env.SMTP_USER !== 'string' || !env.SMTP_USER.trim() || /[\r\n\x00]/.test(env.SMTP_USER)
            || typeof env.SMTP_PASS !== 'string' || !env.SMTP_PASS || /[\r\n\x00]/.test(env.SMTP_PASS)) falhar();
        auth = { user: env.SMTP_USER, pass: env.SMTP_PASS };
    } else if (modo !== 'relay' || env.SMTP_USER || env.SMTP_PASS) falhar();
    let transporte;
    try {
        transporte = criarTransporte({ ...(captura ?? { host, port: Number(porta), secure: porta === '465', requireTLS: true,
            ignoreTLS: false, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: host } }),
            ...(auth ? { auth } : {}), pool: false, logger: false, debug: false,
            connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
            disableFileAccess: true, disableUrlAccess: true });
    } catch { throw new Error('SMTP_RECUPERACAO_INDISPONIVEL'); }
    return async ({ to, subject, text, html }) => {
        try {
            const r = await enviarEmail({ to, subject, text, ...(html===undefined?{}:{html}), fromName: nome, fromAddress: remetente }, transporte);
            if (!Array.isArray(r?.accepted) || !r.accepted.includes(to) || r.rejected?.length || r.pending?.length) throw Error();
            // Nao devolver envelope, resposta do relay, messageId ou link ao chamador.
        } catch(e) {
            const falha=new Error('ENVIO_RECUPERACAO_INDISPONIVEL');
            // Only definite failures before DATA acceptance can be retried.
            if(classificarNaoAceito && (['EAUTH','EDNS'].includes(e?.code)
                ||e?.command==='CONN'&&['ECONNECTION','ETIMEDOUT','ESOCKET'].includes(e?.code)
                ||['AUTH','MAIL FROM','RCPT TO','DATA'].includes(e?.command)
                    &&Number.isInteger(e?.responseCode)&&e.responseCode>=400&&e.responseCode<=599))
                falha.notificacaoNaoEnviada=true;
            throw falha;
        }
    };
}

export async function sendMail({ fromName, subject, html, replyTo }) {
    return enviarEmail({
        fromName,
        fromAddress: getSenderEmail(subject),
        to: 'presidencia@istbrasil.org.br',
        subject,
        html,
        replyTo
    });
}

// Envio genérico para o próprio usuário (ex: confirmação de cadastro), diferente do sendMail acima
// que sempre encaminha para a presidência (fluxo do Fale Conosco).
export async function sendAccountMail({ to, subject, html }) {
    const fromName = process.env.MAIL_FROM_NAME || 'IST Brasil';
    const fromAddress = process.env.MAIL_FROM_ADDRESS || 'contato@istbrasil.org.br';

    return enviarEmail({
        fromName,
        fromAddress,
        to,
        subject,
        html
    });
}

