const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const timelineRoutes = require('./src/routes/timelineRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Rotas
app.use('/api/timeline', timelineRoutes);

// Rota padrão para teste
app.get('/', (req, res) => {
    res.send('API do Instituto Sebastião Tapajós está rodando!');
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
