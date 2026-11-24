import "dotenv/config";
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import express from 'express';
import bodyParser from "body-parser"; // Importação movida para cima por organização

// Importação das rotas
import releaseRoutes from './src/routes/releases.routes.js';
import timelineRoutes from './src/routes/timeline.routes.js';
import obraRoutes from './src/routes/obra.routes.js';
import contactRoutes from './src/routes/contact.routes.js';
import usuariosRoutes from './src/routes/usuarios.routes.js';
import eventosRoutes from './src/routes/eventos.routes.js';
import projetosRoutes from './src/routes/projetos.routes.js';
import projetosDocumentosRoutes from './src/routes/projetosDocumentos.routes.js';
import { criarAdminRouter } from './src/routes/admin.routes.js';
import juradoRoutes from './src/routes/jurado.routes.js';

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

// Respostas antes dos parsers: nenhuma operação comercial ou arquivo é carregado.
app.use((req, res, next) => {
    let caminho;
    try { caminho = decodeURIComponent(req.path); }
    catch { return res.status(400).set('Cache-Control', 'no-store').json({ erro: { codigo: 'CAMINHO_INVALIDO' } }); }
    const privado = /^\/(?:api\/)?istbrasil\.private\/products\/livros(?:\/|$)/i.test(caminho)
        || /^\/api\/books\/download(?:\/|$)/i.test(caminho);
    const comercial = /^\/api\/(?:books|loja)(?:\/|$)/i.test(caminho)
        || /^\/api\/admin\/loja(?:\/|$)/i.test(caminho)
        || /^\/assets\/images\/livros(?:\/|$)/i.test(caminho);
    if (privado || comercial) {
        return res.status(privado ? 404 : 410).set({ 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
            .json({ erro: { codigo: privado ? 'ROTA_NAO_ENCONTRADA' : 'FUNCIONALIDADE_DESATIVADA' } });
    }
    next();
});

app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(bodyParser.json());
app.use('/api', contactRoutes);

// --- Rotas ---
app.use('/api/releases', releaseRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/obra', obraRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/eventos', eventosRoutes);
app.use('/api/projetos', projetosRoutes);
app.use('/api/admin', criarAdminRouter());
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
const servidor = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

let encerrando = false;
const encerrar = () => {
    if (encerrando) return;
    encerrando = true;
    servidor.close(() => process.exit(0));
};
process.once('SIGINT', encerrar);
process.once('SIGTERM', encerrar);
