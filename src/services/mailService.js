import nodemailer from 'nodemailer';
import { normalizarEmailComprador } from './lojaPedidoContratos.js';

// Permite usar um relay SMTP externo via variáveis de ambiente,
// caindo de volta para o MTA local (localhost:587) usado em produção quando não configurado.
export const mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    // O Postfix local usa STARTTLS com certificado autoassinado; aceitar aqui é seguro
    // pois a conexão fica restrita ao loopback do próprio servidor.
    tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED === 'true' }
});

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
export function criarEnvioRecuperacaoSmtp({ env = process.env, criarTransporte = nodemailer.createTransport } = {}) {
    const falhar = () => { throw new Error('CONFIGURACAO_SMTP_RECUPERACAO_INVALIDA'); };
    const host = env.SMTP_HOST, porta = env.SMTP_PORT, nome = env.MAIL_FROM_NAME, remetente = env.MAIL_FROM_ADDRESS;
    try { if (normalizarEmailComprador(remetente) !== remetente) falhar(); } catch { falhar(); }
    if (typeof host !== 'string' || host.length > 253 || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)
        || !host.includes('.') || host.split('.').some(s => !s || s.length > 63 || s.startsWith('-') || s.endsWith('-'))
        || !['465', '587'].includes(porta) || env.SMTP_SECURE !== (porta === '465' ? 'true' : 'false')
        || env.SMTP_REJECT_UNAUTHORIZED !== 'true' || typeof criarTransporte !== 'function'
        || typeof remetente !== 'string' || remetente.length > 254
        || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(remetente)
        || typeof nome !== 'string' || !nome.trim() || nome.length > 100 || /[\x00-\x1f\x7f]/.test(nome)) falhar();
    const modo = env.IST_LOJA_RECUPERACAO_SMTP_AUTENTICACAO;
    let auth;
    if (modo === 'login') {
        if (typeof env.SMTP_USER !== 'string' || !env.SMTP_USER.trim() || /[\r\n\x00]/.test(env.SMTP_USER)
            || typeof env.SMTP_PASS !== 'string' || !env.SMTP_PASS || /[\r\n\x00]/.test(env.SMTP_PASS)) falhar();
        auth = { user: env.SMTP_USER, pass: env.SMTP_PASS };
    } else if (modo !== 'relay' || env.SMTP_USER || env.SMTP_PASS) falhar();
    let transporte;
    try {
        transporte = criarTransporte({ host, port: Number(porta), secure: porta === '465', requireTLS: true,
            ignoreTLS: false, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: host },
            ...(auth ? { auth } : {}), pool: false, logger: false, debug: false,
            connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
            disableFileAccess: true, disableUrlAccess: true });
    } catch { throw new Error('SMTP_RECUPERACAO_INDISPONIVEL'); }
    return async ({ to, subject, text }) => {
        try {
            const r = await enviarEmail({ to, subject, text, fromName: nome, fromAddress: remetente }, transporte);
            if (!Array.isArray(r?.accepted) || !r.accepted.includes(to) || r.rejected?.length || r.pending?.length) throw Error();
            // Nao devolver envelope, resposta do relay, messageId ou link ao chamador.
        } catch { throw new Error('ENVIO_RECUPERACAO_INDISPONIVEL'); }
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

