import "dotenv/config";
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import express from 'express';
import bodyParser from "body-parser"; // Importação movida para cima por organização

// Importação das rotas
import bookRoutes from './src/routes/book.routes.js';
import lojaRoutes, { tratarErroLoja } from './src/routes/loja.routes.js';
import releaseRoutes from './src/routes/releases.routes.js';
import timelineRoutes from './src/routes/timeline.routes.js';
import obraRoutes from './src/routes/obra.routes.js';
import contactRoutes from './src/routes/contact.routes.js';
import usuariosRoutes from './src/routes/usuarios.routes.js';
import eventosRoutes from './src/routes/eventos.routes.js';
import projetosRoutes from './src/routes/projetos.routes.js';
import projetosDocumentosRoutes from './src/routes/projetosDocumentos.routes.js';
import adminRoutes from './src/routes/admin.routes.js';
import juradoRoutes from './src/routes/jurado.routes.js';
import { pool } from './src/config/db.js';
import { iniciarRecuperacaoLoja, comporFinanceiroLoja } from './src/services/lojaPagamentoAgendador.js';
import { criarLojaPaypalWebhookRouter } from './src/routes/lojaPaypalWebhook.routes.js';
import { criarLojaCheckoutRouter } from './src/routes/lojaCheckout.routes.js';
import { criarLojaDownloadsRouter } from './src/routes/lojaDownloads.routes.js';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Loga a causa real de crashes que hoje derrubam o processo sem deixar rastro no out.log
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

const app = express();
app.set('trust proxy', 'loopback');

// Configurações
app.use('/api/loja/downloads', criarLojaDownloadsRouter({ db: pool }));
app.use(cors());
app.use(cookieParser());
let financeiroLoja;
const obterFinanceiroLoja = () => financeiroLoja ??= comporFinanceiroLoja({ db: pool, env: process.env });
app.use('/api/loja/checkout', criarLojaCheckoutRouter({ obterFinanceiro: obterFinanceiroLoja }));
app.use('/api/loja/pagamentos/paypal/webhook', criarLojaPaypalWebhookRouter({
    obterFinanceiro: obterFinanceiroLoja, obterWebhookId: () => process.env.IST_LOJA_PAYPAL_WEBHOOK_ID
}));
// Parser e limite da Loja antes dos parsers globais, inclusive para JSON invalido.
app.use('/api/loja', lojaRoutes);
app.use('/api/loja', tratarErroLoja);
app.use(express.json());
app.use(bodyParser.json());
app.use('/api', contactRoutes);


// --- Rotas ---
// URLs comerciais antigas nunca devem cair em um fallback de pagina publica.
app.use((req, res, next) => {
    let caminho;
    try { caminho = decodeURIComponent(req.path); } catch { return next(); }
    if (/^\/(?:api\/)?istbrasil\.private\/products\/livros(?:\/|$)/i.test(caminho)
        || /^\/api\/books\/download(?:\/|$)/i.test(caminho)) {
        return res.status(404).set('Cache-Control', 'no-store').json({ erro: { codigo: 'ROTA_NAO_ENCONTRADA' } });
    }
    next();
});
app.use('/api/books', bookRoutes);
app.use('/api/releases', releaseRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/obra', obraRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/eventos', eventosRoutes);
app.use('/api/projetos', projetosRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/jurado', juradoRoutes);

// --- Arquivos Estáticos ---
app.use('/istbrasil.private/projetos', projetosDocumentosRoutes);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const documentosPath = path.join(__dirname, '/istbrasil.private/documents/');
app.use('/istbrasil.private/documents/', express.static(documentosPath));
app.use('/api/istbrasil.private/documents/', express.static(documentosPath));

// Rota base
app.get('/', (req, res) => {
    res.send('API IST Brasil rodando!');
});

// --- Inicialização do Servidor (APENAS UMA VEZ) ---
const PORT = process.env.PORT || 3000;
let recuperacaoLoja;
const servidor = app.listen(PORT, () => {
    if (!encerrando) recuperacaoLoja = iniciarRecuperacaoLoja({ db: pool, obterFinanceiro: obterFinanceiroLoja });
    console.log(`Server running on port ${PORT}`);
});

let encerrando = false;
const encerrar = () => {
    if (encerrando) return;
    encerrando = true;
    const recuperacaoEncerrada = recuperacaoLoja?.parar() ?? Promise.resolve();
    servidor.close(() => {
        recuperacaoEncerrada.then(() => process.exit(0), () => process.exit(1));
    });
};
process.once('SIGINT', encerrar);
process.once('SIGTERM', encerrar);
