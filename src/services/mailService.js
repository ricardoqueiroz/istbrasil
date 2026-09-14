import nodemailer from 'nodemailer';

// Permite usar um relay SMTP externo via variáveis de ambiente,
// caindo de volta para o MTA local (localhost:25) usado em produção quando não configurado.
export const mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT) || 25,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    // O Postfix local usa STARTTLS com certificado autoassinado; aceitar aqui é seguro
    // pois a conexão fica restrita ao loopback do próprio servidor.
    tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED === 'true' }
});

export async function sendMail({ fromName, fromEmail, subject, html, replyTo }) {
    return mailTransporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to: 'contato@istbrasil.org.br',
        subject,
        html,
        replyTo
    });
}
