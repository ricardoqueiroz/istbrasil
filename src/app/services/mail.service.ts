import * as nodemailer from 'nodemailer';

export interface SendMailParams {
  fromName: string;
  fromEmail: string;
  subject: string;
  html: string;
  replyTo?: string;
}

export const mailTransporter = nodemailer.createTransport({
  host: 'localhost',
  port: 25,
  secure: false
});

export async function sendMail(params: SendMailParams) {
  const { fromName, fromEmail, subject, html, replyTo } = params;

  return mailTransporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: 'contato@istbrasil.org.br',
    subject,
    html,
    replyTo
  });
}
