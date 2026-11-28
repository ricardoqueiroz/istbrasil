import 'dotenv/config';

const segredoDesenvolvimento = 'dev-only-insecure-secret';
const segredoConfigurado = process.env.JWT_SECRET;

if (process.env.NODE_ENV === 'production'
    && (!segredoConfigurado?.trim() || segredoConfigurado.trim() === segredoDesenvolvimento)) {
    throw new Error('JWT_SECRET deve ser configurado com um segredo válido em produção.');
}

export const JWT_SECRET = segredoConfigurado || segredoDesenvolvimento;
