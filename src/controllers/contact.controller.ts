import { Request, Response } from 'express';
import { sendMail } from '../app/services/mail.service';

export async function contact(req: Request, res: Response) {
  try {
    const { name, email, subject, message, honeypot } = req.body;

    // Anti-robô simples (honeypot)
    if (honeypot) {
      return res.status(200).json({ success: true });
    }

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Dados obrigatórios ausentes' });
    }

    await sendMail({
      fromName: 'Contato IST Brasil',
      fromEmail: 'contato@istbrasil.org.br',
      subject: `[Fale Conosco] ${subject || 'Mensagem recebida'}`,
      replyTo: `${name} <${email}>`,
      html: `
        <p><strong>Nome:</strong> ${name}</p>
        <p><strong>E-mail:</strong> ${email}</p>
        <p><strong>Assunto:</strong> ${subject}</p>
        <hr>
        <p>${message.replace(/\n/g, '<br>')}</p>
      `
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[Contato] Erro ao enviar e-mail:', err);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
}
