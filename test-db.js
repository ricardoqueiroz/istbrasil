const db = require('./src/config/db');

async function testConnection() {
    try {
        const [rows] = await db.execute('SELECT 1 as val');
        console.log('Conexão com o banco de dados estabelecida com sucesso!', rows);
        process.exit(0);
    } catch (error) {
        console.error('Erro ao conectar com o banco de dados:', error.message);
        process.exit(1);
    }
}

testConnection();
