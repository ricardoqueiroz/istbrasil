require('dotenv').config();
const mysql = require('mysql2');

// Cria a conexão usando as variáveis do .env
const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

console.log('Tentando conectar ao banco de dados...');

connection.connect((err) => {
  if (err) {
    console.error('❌ Erro ao conectar ao banco de dados:');
    console.error(err.message);
    process.exit(1);
  }

  console.log('✅ Conexão bem-sucedida com o MariaDB via túnel SSH!');
  
  // Faz uma consulta simples para validar
  connection.query('SELECT NOW() AS current_time', (error, results) => {
    if (error) {
      console.error('❌ Erro ao executar a consulta:', error.message);
    } else {
      console.log('🕒 Hora atual no servidor do banco:', results[0].current_time);
    }
    
    // Fecha a conexão
    connection.end();
  });
});