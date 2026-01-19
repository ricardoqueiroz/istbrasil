const mysql = require('mysql2/promise');

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

// Configuração Paypal SandBox
// const PAYPAL_CLIENT_ID = "ARW8yGawDLNIBlNh-nUztnLcrW5ApnDF06DKfa1c_HOi-Ho6MQqH4CopEu8waaH0BkMdRkWHSmLQxKIw";
// const PAYPAL_CLIENT_SECRET = "EHOitsjbF7lq-r5BPowDHrbkcneOnRJKzkC9FSYiz8GDPT1NjgLmoWkKBJMt3fuBZo3mdXuSBhP7aVDb";
// const PAYPAL_API_URL = "https://api-m.sandbox.paypal.com";

// Configuração Paypal Produção
PAYPAL_CLIENT_ID = "Af1_adBle8ZCZk850g8lARgATT4CqTuFwzf5AM0jfO0moS2AteqNb18HjXGna_9oRSCUEsTOdinfhjYb";
PAYPAL_CLIENT_SECRET = "EPnZYdwPcdkrrp5r68gzJQGScJKF5i95SVX5DVMqHTEmw5nZRF41NSpWhhMKJ7OS26mi2YRmie_4ne8L"; 
PAYPAL_API_URL = "https://api-m.paypal.com";

module.exports = {
    pool,
    PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET,
    PAYPAL_API_URL
};
