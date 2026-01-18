const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

// Configurações
app.use(cors());
app.use(express.json());

// --- Seção de IMPORTAÇÃO de Rotas ---
const bookRoutes = require('./src/routes/book.routes');
const releaseRoutes = require('./src/routes/releases.routes'); 
const timelineRoutes = require('./src/routes/timeline.routes');
const obraRoutes = require('./src/routes/obra.routes');
const paypalRoutes = require('./src/routes/paypal.routes'); 

// SERVE ARQUIVOS PRIVADOS - LIVROS (somente leitura)
const livrosPath = path.join(__dirname, '/istbrasil.private/products/livros/');
app.use('/istbrasil.private/products/livros/', express.static(livrosPath));
app.use('/api/istbrasil.private/products/livros/', express.static(livrosPath));
console.log('Acessando arquivos privados em: ' + livrosPath);

// SERVE ARQUIVOS PUBLICOS - documentos (somente leitura)
const documentosPath = path.join(__dirname, '/istbrasil.private/documents/');
app.use('/istbrasil.private/documents/', express.static(documentosPath));
app.use('/api/istbrasil.private/documents/', express.static(documentosPath));
console.log('Acessando arquivos públicos em: ' + documentosPath);

// --- Seção de CONEXÃO de Rotas (app.use) ---
app.use('/api/books', bookRoutes);
app.use('/api/releases', releaseRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/obra', obraRoutes);
app.use('/api/paypal', paypalRoutes);

// Rota de teste na raiz
app.get('/', (req, res) => {
    res.send('API IST Brasil rodando!');
});

// Porta do banco de dados e inicialização do servidor
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Teste a rota aqui: http://localhost:3000/api/books`);
});
