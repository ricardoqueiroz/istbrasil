import { rateLimit } from 'express-rate-limit';

const mensagemLimite = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';

const criarLimitador = ({ windowMs, limit, skipSuccessfulRequests = false }) => rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (_req, res) => res.status(429).json({ message: mensagemLimite })
});

export const limiteAutenticacao = criarLimitador({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true
});

export const limiteEmail = criarLimitador({
    windowMs: 30 * 60 * 1000,
    limit: 5
});

export const limiteToken = criarLimitador({
    windowMs: 15 * 60 * 1000,
    limit: 30
});
