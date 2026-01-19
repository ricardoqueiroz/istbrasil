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
PAYPAL_CLIENT_ID = "AWIY7zKNlVKtB2RYEO-A7RGgXucL0n9lH_OjKouYNttukLOhmoY5tbKAgBjwWbstV1oQCfPKwcJIVDWS";
PAYPAL_CLIENT_SECRET = "EN1c-tO8_lTbQzmQYRcNGigaADQILz8SKySzncONtuAvbGCrfLhacn6O-vIqe1nf9QDCZbq_GzfP7T3t"; 
PAYPAL_API_URL = "https://api-m.paypal.com";

module.exports = {
    pool,
    PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET,
    PAYPAL_API_URL
};
