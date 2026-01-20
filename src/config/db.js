import mysql from 'mysql2/promise';

// Configuração do banco de dados
const pool = mysql.createPool({
    host: 'localhost',
    user: 'ist_user',
    password: 'iL299WOR@**',
    database: 'istbrasil',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

export { pool };
