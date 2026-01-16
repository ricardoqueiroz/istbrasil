const axios = require('axios');
const db = require('../config/db'); // Supondo que sua conexão MySQL esteja aqui
require('dotenv').config();

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_URL } = process.env;

// Função auxiliar para gerar Access Token
async function generateAccessToken() {
    const auth = Buffer.from(PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET).toString("base64");
    const response = await axios.post(`${PAYPAL_API_URL}/v1/oauth2/token`, "grant_type=client_credentials", {
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    });
    return response.data.access_token;
}

exports.createOrder = async (req, res) => {
    const { livroId, preco } = req.body; // Recebe dados do front

    try {
        const accessToken = await generateAccessToken();
        
        const response = await axios.post(`${PAYPAL_API_URL}/v2/checkout/orders`, {
            intent: "CAPTURE",
            purchase_units: [{
                amount: {
                    currency_code: "BRL",
                    value: preco 
                },
                description: `Livro ID: ${livroId}`
            }],
        }, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        });

        // Opcional: Salvar pré-venda no MySQL como 'PENDENTE' aqui

        res.json(response.data);
    } catch (error) {
        console.error("Erro ao criar pedido:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Erro ao criar pedido no PayPal" });
    }
};

exports.captureOrder = async (req, res) => {
    const { orderID, livroId } = req.body;

    try {
        const accessToken = await generateAccessToken();
        
        const response = await axios.post(`${PAYPAL_API_URL}/v2/checkout/orders/${orderID}/capture`, {}, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        });

        const transaction = response.data;

        if (transaction.status === 'COMPLETED') {
            // SALVAR NO MYSQL
            const valor = transaction.purchase_units[0].payments.captures[0].amount.value;
            const email = transaction.payer.email_address;

            const sql = "INSERT INTO vendas (paypal_order_id, livro_id, valor, status, cliente_email) VALUES (?, ?, ?, ?, ?)";
            // Atenção: Ajuste a chamada do db conforme sua implementação atual do mysql2
            // db.execute(sql, [orderID, livroId, valor, 'APROVADO', email]); 
            
            console.log("Venda salva com sucesso!");
        }

        res.json(transaction);
    } catch (error) {
        console.error("Erro ao capturar pagamento:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Erro ao capturar pagamento" });
    }
};