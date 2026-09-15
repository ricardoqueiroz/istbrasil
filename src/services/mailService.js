import nodemailer from 'nodemailer';

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
    'Parcerias': 'parceria@istbrasil.org.br',
    'Outro': 'contato@istbrasil.org.br',
    'Outro assunto': 'contato@istbrasil.org.br'
};

function getSenderEmail(subject) {
    const normalizedSubject = String(subject || '')
        .replace(/^\[Fale Conosco\]\s*/i, '')
        .trim();

    return senderBySubject[normalizedSubject] || 'contato@istbrasil.org.br';
}

export async function sendMail({ fromName, subject, html, replyTo }) {
    return mailTransporter.sendMail({
        from: `"${fromName}" <${getSenderEmail(subject)}>`,
        to: 'presidencia+contato@istbrasil.org.br',
        subject,
        html,
        replyTo
    });
}
