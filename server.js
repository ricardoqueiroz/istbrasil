// const express = require('express');
// require('dotenv').config();
// import express from "express";


import "dotenv/config";
import cors from 'cors';
import path from 'path';
import express from 'express';
const app = express();

// Configurações
app.use(cors());
app.use(express.json());

// --- Seção do Paypal ---
import {
    ApiError,
    CheckoutPaymentIntent,
    Client,
    Environment,
    LogLevel,
    OrdersController,
    PaymentsController,
    PaypalExperienceLandingPage,
    PaypalExperienceUserAction
} from "@paypal/paypal-server-sdk";
import bodyParser from "body-parser";

app.use(bodyParser.json());

const {
    PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET,
} = process.env;

const client = new Client({
    clientCredentialsAuthCredentials: {
        oAuthClientId: PAYPAL_CLIENT_ID,
        oAuthClientSecret: PAYPAL_CLIENT_SECRET,
    },
    timeout: 0,
    environment: Environment.Sandbox,
    logging: {
        logLevel: LogLevel.Info,
        logRequest: { logBody: true },
        logResponse: { logHeaders: true },
    },
});

const ordersController = new OrdersController(client);
const paymentsController = new PaymentsController(client);

// --- Seção de IMPORTAÇÃO de Rotas ---

import bookRoutes from './src/routes/book.routes.js';
import releaseRoutes from './src/routes/releases.routes.js';
import timelineRoutes from './src/routes/timeline.routes.js';
import obraRoutes from './src/routes/obra.routes.js';
import paypalRoutes from './src/routes/paypal.routes.js';

// --- Seção de CONEXÃO de Rotas (app.use) ---
app.use('/api/books', bookRoutes);
app.use('/api/releases', releaseRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/obra', obraRoutes);
app.use('/api/paypal', paypalRoutes);

// SERVE ARQUIVOS PRIVADOS - LIVROS (somente leitura)

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const livrosPath = path.join(__dirname, '/istbrasil.private/products/livros/');
app.use('/istbrasil.private/products/livros/', express.static(livrosPath));
app.use('/api/istbrasil.private/products/livros/', express.static(livrosPath));
console.log('Acessando arquivos privados em: ' + livrosPath);

// SERVE ARQUIVOS PUBLICOS - documentos (somente leitura)
const documentosPath = path.join(__dirname, '/istbrasil.private/documents/');
app.use('/istbrasil.private/documents/', express.static(documentosPath));
app.use('/api/istbrasil.private/documents/', express.static(documentosPath));
console.log('Acessando arquivos públicos em: ' + documentosPath);


// Rota de teste na raiz
app.get('/', (req, res) => {
    res.send('API IST Brasil rodando!');
});

// Porta do banco de dados e inicialização do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Teste a rota aqui: http://localhost:${PORT}/api/books`);
});


// -------------------------------------------------------------
// Exporta o app para testes ou outras utilizações
// -------------------------------------------------------------
/**
 * Create an order to start the transaction.
 * @see https://developer.paypal.com/docs/api/orders/v2/#orders_create
 */
const createOrder = async (cart) => {
   const collect = {
        body: {
            intent: "CAPTURE",
            purchaseUnits: [
                {
                    amount: {
                        currencyCode: "USD",
                        value: "100",
                        breakdown: {
                            itemTotal: {
                                currencyCode: "USD",
                                value: "100",
                            },
                        },
                    },
                    // lookup item details in `cart` from database
                    items: [
                        {
                            name: "T-Shirt",
                            unitAmount: {
                                currencyCode: "USD",
                                value: "100",
                            },
                            quantity: "1",
                            description: "Super Fresh Shirt",
                            sku: "sku01",
                        },
                    ],
                },
            ],
        },
        prefer: "return=minimal",
    };
   

    try {
        const { body, ...httpResponse } = await ordersController.createOrder(
            collect
        );
        // Get more response info...
        // const { statusCode, headers } = httpResponse;
        return {
            jsonResponse: JSON.parse(body),
            httpStatusCode: httpResponse.statusCode,
        };
    } catch (error) {
        if (error instanceof ApiError) {
            // const { statusCode, headers } = error;
            throw new Error(error.message);
        }
    }
};

// createOrder route
app.post("/api/orders", async (req, res) => {
    try {
        // use the cart information passed from the front-end to calculate the order amount detals
        const { cart } = req.body;
        const { jsonResponse, httpStatusCode } = await createOrder(cart);
        res.status(httpStatusCode).json(jsonResponse);
    } catch (error) {
        console.error("Failed to create order:", error);
        res.status(500).json({ error: "Failed to create order." });
    }
});


/**
 * Capture payment for the created order to complete the transaction.
 * @see https://developer.paypal.com/docs/api/orders/v2/#orders_capture
 */
const captureOrder = async (orderID) => {
    const collect = {
        id: orderID,
        prefer: "return=minimal",
    };

    try {
        const { body, ...httpResponse } = await ordersController.captureOrder(
            collect
        );
        // Get more response info...
        // const { statusCode, headers } = httpResponse;
        return {
            jsonResponse: JSON.parse(body),
            httpStatusCode: httpResponse.statusCode,
        };
    } catch (error) {
        if (error instanceof ApiError) {
            // const { statusCode, headers } = error;
            throw new Error(error.message);
        }
    }
};

// captureOrder route
app.post("/api/orders/:orderID/capture", async (req, res) => {
    try {
        const { orderID } = req.params;
        const { jsonResponse, httpStatusCode } = await captureOrder(orderID);
        res.status(httpStatusCode).json(jsonResponse);
    } catch (error) {
        console.error("Failed to create order:", error);
        res.status(500).json({ error: "Failed to capture order." });
    }
});


app.listen(PORT, () => {
    console.log(`Node server listening at http://localhost:${PORT}/`);
});