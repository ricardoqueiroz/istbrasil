import "dotenv/config";
import cors from 'cors';
import path from 'path';
import express from 'express';
import bodyParser from "body-parser"; // Importação movida para cima por organização
import {
    Client,
    Environment, // Importante
    LogLevel,
    OrdersController
} from "@paypal/paypal-server-sdk";

// Importação das rotas
import bookRoutes from './src/routes/book.routes.js';
import releaseRoutes from './src/routes/releases.routes.js';
import timelineRoutes from './src/routes/timeline.routes.js';
import obraRoutes from './src/routes/obra.routes.js';
import paypalRoutes from './src/routes/paypal.routes.js';
import contactRoutes from './routes/contact.routes';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const app = express();

// Configurações
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use('/api', contactRoutes);

// --- Configuração do Paypal ---
const {
    PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET,
    PAYPAL_ENV,
    NODE_ENV // Sugestão: Use uma variável de ambiente para definir se é PROD ou DEV
} = process.env;

// Define o ambiente baseando-se em variável ou fixa para Production se for o caso
const paypalEnvironment = (PAYPAL_ENV === 'production') 
    ? Environment.Production 
    : Environment.Sandbox;

const client = new Client({
    clientCredentialsAuthCredentials: {
        oAuthClientId: PAYPAL_CLIENT_ID,
        oAuthClientSecret: PAYPAL_CLIENT_SECRET,
    },
    timeout: 0,
    environment: paypalEnvironment, // <--- AQUI A MÁGICA ACONTECE
    logging: {
        logLevel: LogLevel.Info,
        logRequest: { logBody: true },
        logResponse: { logHeaders: true },
    },
});

// Se você usa o ordersController dentro de paypal.routes.js, 
// certifique-se de estar exportando ou passando este 'client' para lá.
// Se as rotas criam sua própria instância, verifique o arquivo paypal.routes.js também!
export const paypalClient = client; // Exportando caso suas rotas precisem

// --- Rotas ---
app.use('/api/books', bookRoutes);
app.use('/api/releases', releaseRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/obra', obraRoutes);
app.use('/api/paypal', paypalRoutes); // Suas rotas reais do PayPal

// --- Arquivos Estáticos ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const livrosPath = path.join(__dirname, '/istbrasil.private/products/livros/');
app.use('/istbrasil.private/products/livros/', express.static(livrosPath));
// Dica: Geralmente não se expõe a rota /api/ para arquivos estáticos, mas mantive sua lógica
app.use('/api/istbrasil.private/products/livros/', express.static(livrosPath));
console.log('Acessando arquivos privados em: ' + livrosPath);

const documentosPath = path.join(__dirname, '/istbrasil.private/documents/');
app.use('/istbrasil.private/documents/', express.static(documentosPath));
app.use('/api/istbrasil.private/documents/', express.static(documentosPath));

// Rota base
app.get('/', (req, res) => {
    res.send('API IST Brasil rodando!');
});

// --- Inicialização do Servidor (APENAS UMA VEZ) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Ambiente PayPal: ${paypalEnvironment === Environment.Production ? 'PRODUÇÃO (Dinheiro Real)' : 'SANDBOX (Teste)'}`);
});