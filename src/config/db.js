const mysql = require('mysql2/promise');

// Configuração do banco de dados
// Substitua pelas suas credenciais reais
const pool = mysql.createPool({
    host: 'localhost',
    user: 'ist_user',
    password: 'iL299WOR@**',
    database: 'istbrasil',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
