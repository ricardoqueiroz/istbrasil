
import 'dotenv/config';
import axios from 'axios';
import { pool as db } from '../config/db.js';

// Variável global para armazenar o access_token e expiração
let PAYPAL_ACCESS_TOKEN = null;
let PAYPAL_ACCESS_TOKEN_EXP = 0;

// Captura as variáveis de ambiente
const { 
    PAYPAL_CLIENT_ID, 
    PAYPAL_CLIENT_SECRET, 
    PAYPAL_ENV 
} = process.env;

// [CORREÇÃO 1] Definição correta da URL base (Sandbox vs Production)
// Se NODE_ENV for 'production', usa a URL live. Caso contrário, usa sandbox.
const PAYPAL_API_URL = (PAYPAL_ENV === 'production')
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

console.log(`[PayPal Controller] Ambiente: ${PAYPAL_ENV || 'development'} | URL: ${PAYPAL_API_URL}`);
// --- Funções Auxiliares ---

async function generateAccessToken() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
        throw new Error("Credenciais do PayPal não encontradas no .env");
    }

    // Se já existe um token válido, retorna ele
    const now = Date.now();
    if (PAYPAL_ACCESS_TOKEN && PAYPAL_ACCESS_TOKEN_EXP > now) {
        console.log("🔑 Usando token de acesso PayPal em cache:" + PAYPAL_ACCESS_TOKEN);
        return PAYPAL_ACCESS_TOKEN;
    }

    const auth = Buffer.from(PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET).toString("base64");
    try {
        console.log("🔑 Gerando novo token de acesso PayPal...");
        console.log(`${PAYPAL_API_URL}/v2/oauth2/token`, "grant_type=client_credentials", {
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        });

        const response = await axios.post(`${PAYPAL_API_URL}/v2/oauth2/token`, "grant_type=client_credentials", {
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        });
        // Calcula expiração (PayPal retorna expires_in em segundos)
        const expiresIn = response.data.expires_in || 3600; // fallback 1h
        PAYPAL_ACCESS_TOKEN = response.data.access_token;
        PAYPAL_ACCESS_TOKEN_EXP = now + (expiresIn - 60) * 1000; // 1 min de margem
        console.log("✅ Token PayPal gerado com sucesso:", PAYPAL_ACCESS_TOKEN);
        return PAYPAL_ACCESS_TOKEN;
    } catch (error) {
        console.error("❌ Erro ao gerar token PayPal:", error.response ? error.response.data : error.message);
        let errorStr = JSON.stringify(error, null, 2);
        console.error("Detalhes do erro:", errorStr);
        throw new Error("Falha na autenticação com PayPal");
    }
}

async function getOrderDetails(orderId) {
    const accessToken = await generateAccessToken();
    const response = await axios.get(`${PAYPAL_API_URL}/v2/checkout/orders/${orderId}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });
    return response.data;
}

const safeGet = (val) => (val === undefined ? null : val);

function extractOrderData(resource) {
    const unit = resource.purchase_units && resource.purchase_units[0] ? resource.purchase_units[0] : {};
    const item = unit.items && unit.items[0] ? unit.items[0] : {};
    
    // Dados de Envio e Endereço
    const shipping = unit.shipping || {};
    const address = shipping.address || {};
    const payer = resource.payer || {};
    const payerName = payer.name || {};
    const payerAddress = payer.address || {};
    
    // Dados Financeiros
    const payments = unit.payments || {};
    // Verifica se a captura está dentro de payments ou se o próprio resource é uma captura
    const capture = (payments.captures && payments.captures[0]) ? payments.captures[0] : (resource.status === 'COMPLETED' ? resource : {});
    const grossAmount = resource.gross_amount || unit.amount || {};
    const captureAmount = capture.amount || {};
    const payee = unit.payee || {};
    const sellerProt = capture.seller_protection || {};

    return {
        // Identificação
        order_id: safeGet(resource.id),
        product_id: safeGet(unit.custom_id),
        sku: safeGet(item.sku),
        intent: safeGet(resource.intent),
        status_: safeGet(resource.status),
        
        // Valores e Datas
        purchase_value: safeGet(grossAmount.value),
        purchase_currency_code: safeGet(grossAmount.currency_code),
        create_time: safeGet(resource.create_time),
        update_time: safeGet(resource.update_time),
        
        // Dados do Pagador (Payer)
        payer_id: safeGet(payer.payer_id),
        payer_email: safeGet(payer.email_address),
        payer_name_given: safeGet(payerName.given_name),
        payer_name_surname: safeGet(payerName.surname),
        payer_country_code: safeGet(payerAddress.country_code),

        // Dados de Envio (Shipping)
        shipping_name_full: shipping.name ? safeGet(shipping.name.full_name) : null,
        shipping_address_line_1: safeGet(address.address_line_1),
        shipping_address_line_2: safeGet(address.address_line_2),
        shipping_admin_area_1: safeGet(address.admin_area_1), // Estado
        shipping_admin_area_2: safeGet(address.admin_area_2), // Cidade
        shipping_postal_code: safeGet(address.postal_code),
        shipping_country_code: safeGet(address.country_code),

        // Dados do Recebedor (Payee)
        payee_email: safeGet(payee.email_address),
        payee_merchant_id: safeGet(payee.merchant_id),

        // Referências e Pagamento
        reference_id: safeGet(unit.reference_id),
        payment_id: safeGet(capture.id),
        payment_status: safeGet(capture.status),
        payment_value: safeGet(captureAmount.value),
        payment_currency_code: safeGet(captureAmount.currency_code),
        payment_create_time: safeGet(capture.create_time),
        payment_final_capture: capture.final_capture ? 'true' : 'false',
        
        // Proteção e Links
        seller_prot_status: safeGet(sellerProt.status),
        seller_prot_dispute_cat: sellerProt.dispute_categories ? JSON.stringify(sellerProt.dispute_categories) : null,
        links: resource.links ? JSON.stringify(resource.links) : null
    };
}

async function upsertOrder(orderData) {
    console.log(`📝 Salvando Completo - ID: ${orderData.product_id} | SKU: ${orderData.sku} | Cliente: ${orderData.payer_name_given}`);

    const sql = `
        INSERT INTO ist_orders (
            order_id, product_id, sku, intent, status_, create_time, update_time, 
            purchase_value, purchase_currency_code, 
            payer_id, payer_email, payer_name_given, payer_name_surname, payer_country_code,
            shipping_name_full, shipping_address_line_1, shipping_address_line_2, 
            shipping_admin_area_1, shipping_admin_area_2, shipping_postal_code, shipping_country_code,
            payee_email, payee_merchant_id, payment_status, reference_id,
            payment_id, payment_value, payment_currency_code, payment_create_time, payment_final_capture,
            seller_prot_status, seller_prot_dispute_cat, links
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, 
            ?, ?, 
            ?, ?, ?, ?, ?, 
            ?, ?, ?, 
            ?, ?, ?, ?, 
            ?, ?, ?, ?, 
            ?, ?, ?, ?, ?, 
            ?, ?, ?
        )
        ON DUPLICATE KEY UPDATE 
            status_ = VALUES(status_), 
            update_time = VALUES(update_time),
            payment_status = VALUES(payment_status),
            payment_id = VALUES(payment_id),
            sku = VALUES(sku),
            product_id = VALUES(product_id),
            shipping_address_line_1 = VALUES(shipping_address_line_1),
            shipping_address_line_2 = VALUES(shipping_address_line_2),
            shipping_admin_area_1 = VALUES(shipping_admin_area_1),
            shipping_admin_area_2 = VALUES(shipping_admin_area_2),
            shipping_postal_code = VALUES(shipping_postal_code)
    `;

    const values = [
        orderData.order_id, orderData.product_id, orderData.sku, orderData.intent, orderData.status_, orderData.create_time, orderData.update_time,
        orderData.purchase_value, orderData.purchase_currency_code,
        orderData.payer_id, orderData.payer_email, orderData.payer_name_given, orderData.payer_name_surname, orderData.payer_country_code,
        orderData.shipping_name_full, orderData.shipping_address_line_1, orderData.shipping_address_line_2,
        orderData.shipping_admin_area_1, orderData.shipping_admin_area_2, orderData.shipping_postal_code, orderData.shipping_country_code,
        orderData.payee_email, orderData.payee_merchant_id, orderData.payment_status, orderData.reference_id,
        orderData.payment_id, orderData.payment_value, orderData.payment_currency_code, orderData.payment_create_time, orderData.payment_final_capture,
        orderData.seller_prot_status, orderData.seller_prot_dispute_cat, orderData.links
    ];

    try {
        await db.execute(sql, values);
        console.log(`✅ Pedido ${orderData.order_id} salvo com TODOS os detalhes.`);
    } catch (error) {
        console.error(`❌ Erro SQL ao salvar pedido ${orderData.order_id}:`, error.message);
        throw error;
    }
}

// --- Métodos do Controller ---

const createOrder = async (req, res) => {
    // [CORREÇÃO 2] Garantia de valores seguros
    const { livroId, sku, preco, titulo, imagem, descricao } = req.body;
    
    // Formata o preço para string com 2 casas decimais (Ex: "10.00")
    const valorFormatado = Number(preco).toFixed(2);
    
    // Limita descrição para evitar erros (PayPal aceita max 127 chars em description de item)
    const descricaoSafe = descricao ? String(descricao).substring(0, 120) : '';

    try {
        const accessToken = await generateAccessToken();

        const payload = {
            intent: "CAPTURE",
            purchase_units: [{
                custom_id: String(livroId),
                amount: {
                    currency_code: "BRL",
                    value: valorFormatado,
                    breakdown: { item_total: { currency_code: "BRL", value: valorFormatado } }
                },
                items: [{
                    name: titulo || 'Livro Digital',
                    description: descricaoSafe,
                    sku: sku || `LIVRO-${livroId}`,
                    unit_amount: { currency_code: "BRL", value: valorFormatado },
                    quantity: "1",
                    // image_url: 'https://istbrasil.org.br/' + imagem
                }]
            }],
            application_context: {
                brand_name: "IST Editora",
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING"
            }
        };

        // debug: Log da requisição
        console.log("[PayPal CreateOrder] POST " + PAYPAL_API_URL + "/v2/checkout/orders");
        console.log("[PayPal CreateOrder] Usando Access Token: " + accessToken);    
        console.log("[PayPal CreateOrder] Payload:", JSON.stringify(payload, null, 2));

        const response = await axios.post(`${PAYPAL_API_URL}/v2/checkout/orders`, payload, {
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        });
        res.json(response.data);
    } catch (error) {
        // Log detalhado do erro do PayPal
        let errorStr = JSON.stringify(error);
        console.error("[PayPal CreateOrder] ", errorStr);
        if (error.response) {
            console.error("[PayPal CreateOrder] Status:", error.response.status);
            console.error("[PayPal CreateOrder] StatusText:", error.response.statusText);
            console.error("[PayPal CreateOrder] Headers:", JSON.stringify(error.response.headers, null, 2));
            console.error("[PayPal CreateOrder] Data:", JSON.stringify(error.response.data, null, 2));
            res.status(error.response.status || 500).json({
                error: "Erro ao criar pedido",
                details: error.response.data,
                status: error.response.status,
                statusText: error.response.statusText
            });
        } else if (error.request) {
            console.error("[PayPal CreateOrder] Nenhuma resposta recebida:", error.request);
            res.status(500).json({ error: "Erro ao criar pedido", message: "Nenhuma resposta recebida do PayPal." });
        } else {
            console.error("[PayPal CreateOrder] Erro desconhecido:", error.message);
            res.status(500).json({ error: "Erro ao criar pedido", message: error.message });
        }
    }
};

const captureOrder = async (req, res) => {
    const { orderID } = req.body;
    try {
        const accessToken = await generateAccessToken();

        // Debug: Log da requisição de captura
        console.log(`[CaptureOrder] POST ${PAYPAL_API_URL}/v2/checkout/orders/${orderID}/capture`);
        console.log(`[CaptureOrder] Usando Access Token: ${accessToken}`);
        
        // 1. Captura o pagamento
        const captureResponse = await axios.post(`${PAYPAL_API_URL}/v2/checkout/orders/${orderID}/capture`, {}, {
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        });

        // 2. Busca detalhes completos (para garantir que temos shipping, payer info, etc)
        // Nota: A resposta do capture já traz muitos dados, mas o getOrderDetails traz o estado consolidado.
        const fullOrder = await getOrderDetails(orderID);
        
        // 3. Salva no banco
        const orderData = extractOrderData(fullOrder);
        await upsertOrder(orderData);
        
        // Retorna o objeto capturado ou o fullOrder
        res.json(fullOrder);
        
    } catch (error) {

        let errorStr = JSON.stringify(error, null, 2);
        console.log("Erro CaptureOrder PayPal Response:", errorStr);

        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            console.error("Erro CaptureOrder Genérico:", error.message);
            res.status(500).json({ error: "Erro na captura do pedido." });
        }
    }
};

const handleWebhook = async (req, res) => {
    const evento = req.body;
    console.log(`🪝 Webhook: ${evento.event_type}`);
    try {
        // Verifica se é o evento de pedido completado
        if (evento.event_type === 'CHECKOUT.ORDER.COMPLETED') {
            const orderData = extractOrderData(evento.resource);
            await upsertOrder(orderData);
        }
    } catch (error) {
        console.error("❌ Erro no Webhook:", error.message);
    }
    // Sempre retornar 200 OK para o PayPal não tentar reenviar infinitamente
    res.status(200).send();
};

export default {
    createOrder,
    captureOrder,
    handleWebhook
};