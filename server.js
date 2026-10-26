import {armazenamentoLoja} from './src/config/lojaArmazenamentoInicial.js';
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
import { criarAdminRouter } from './src/routes/admin.routes.js';
import { criarLojaAdminRouter } from './src/routes/lojaAdmin.routes.js';
import { criarEntregaCapasLivros } from './src/services/lojaCapaService.js';
import {iniciarNotificacoesLoja} from './src/services/lojaNotificacoesAgendador.js';
import juradoRoutes from './src/routes/jurado.routes.js';
import { pool } from './src/config/db.js';
import { iniciarRecuperacaoLoja, iniciarWorkerAdversoLoja, iniciarDescobertaLoja, comporFinanceiroLoja } from './src/services/lojaPagamentoAgendador.js';
import { criarLojaPaypalWebhookRouter } from './src/routes/lojaPaypalWebhook.routes.js';
import { criarLojaCheckoutRouter } from './src/routes/lojaCheckout.routes.js';
import { criarLojaDownloadsRouter } from './src/routes/lojaDownloads.routes.js';
import { criarLojaDownloadRecuperacaoRouter } from './src/routes/lojaDownloadRecuperacao.routes.js';
import { comporEmailRecuperacao } from './src/services/lojaDownloadRecuperacaoSmtp.js';

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
app.use('/assets/images/livros', criarEntregaCapasLivros({configuracaoCapas:armazenamentoLoja.capas}));
const arquivosLoja = armazenamentoLoja.arquivos;
app.set('trust proxy', 'loopback');

// Configurações
app.use('/api/loja/downloads/recuperacao', criarLojaDownloadRecuperacaoRouter({ db: pool,
    adaptadorEmail: comporEmailRecuperacao({ avisar: codigo => console.warn(codigo) }) }));
app.use('/api/loja/downloads', criarLojaDownloadsRouter({ db: pool, configuracaoArquivos:arquivosLoja }));
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
// Correspondencia pelo proprio Express: mesmas regras de metodo, caixa e barra final.
// Escritas editoriais recebem validacao local depois de autenticacao/Origin/CSRF.
const patchEditorialSemParserGlobal = Symbol('patchEditorialSemParserGlobal');
app.post('/api/admin/loja/livros/:id/versoes-pdf/:versaoPublicId/publicar', (req, _res, next) => {
    req[patchEditorialSemParserGlobal] = true;
    next();
});
app.patch('/api/admin/loja/livros/:id', (req, _res, next) => {
    req[patchEditorialSemParserGlobal] = true;
    next();
});
app.post('/api/admin/loja/livros', (req, _res, next) => {
    req[patchEditorialSemParserGlobal] = true;
    next();
});
app.post('/api/admin/loja/livros/capa', (req, _res, next) => {
    req[patchEditorialSemParserGlobal] = true;
    next();
});
app.post('/api/admin/loja/livros/:id/pdf', (req, _res, next) => {
    req[patchEditorialSemParserGlobal] = true;
    next();
});
app.delete('/api/admin/loja/livros/:id', (req, _res, next) => {
    req[patchEditorialSemParserGlobal] = true;
    next();
});
const jsonGlobal = express.json();
const bodyJsonGlobal = bodyParser.json();
app.use((req, res, next) => req[patchEditorialSemParserGlobal] ? next() : jsonGlobal(req, res, next));
app.use((req, res, next) => req[patchEditorialSemParserGlobal] ? next() : bodyJsonGlobal(req, res, next));
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
app.use('/api/admin', criarAdminRouter({loja:criarLojaAdminRouter({db:pool,configuracaoArquivos:arquivosLoja,configuracaoCapas:armazenamentoLoja.capas})}));
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
let workerAdversoLoja;
let descobertaLoja;
let notificacoesLoja;
const servidor = app.listen(PORT, () => {
    if (!encerrando) recuperacaoLoja = iniciarRecuperacaoLoja({ db: pool, obterFinanceiro: obterFinanceiroLoja });
    if (!encerrando) workerAdversoLoja = iniciarWorkerAdversoLoja({db:pool,obterFinanceiro:obterFinanceiroLoja});
    if (!encerrando) descobertaLoja = iniciarDescobertaLoja({db:pool,obterFinanceiro:obterFinanceiroLoja});
    if (!encerrando) notificacoesLoja = iniciarNotificacoesLoja({db:pool});
    console.log(`Server running on port ${PORT}`);
});

let encerrando = false;
const encerrar = () => {
    if (encerrando) return;
    encerrando = true;
    const recuperacaoEncerrada = Promise.all([recuperacaoLoja?.parar(),workerAdversoLoja?.parar(),descobertaLoja?.parar(),notificacoesLoja?.parar()]);
    servidor.close(() => {
        recuperacaoEncerrada.then(() => process.exit(0), () => process.exit(1));
    });
};
process.once('SIGINT', encerrar);
process.once('SIGTERM', encerrar);
