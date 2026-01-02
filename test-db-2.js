const db = require('./src/config/db');
const fs = require('fs');

async function testConnection() {
    try {
        const [rows] = await db.execute('SELECT 1 as val');
        const result = `Sucesso: ${JSON.stringify(rows)}`;
        fs.writeFileSync('db-test-result.txt', result);
        process.exit(0);
    } catch (error) {
        const result = `Erro: ${error.message}`;
        fs.writeFileSync('db-test-result.txt', result);
        process.exit(1);
    }
}

testConnection();
