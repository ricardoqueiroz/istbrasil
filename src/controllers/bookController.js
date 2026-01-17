// ROtinas de Controller para Livros Digitais (E-books)
const { pool: db } = require('../config/db');
const path = require('path');
const fs = require('fs');

// [3.2] Sugestão de Caminho Seguro: Fora da pasta pública do site (public_html ou www)
// Em um servidor Ubuntu padrão, uma boa prática é: /var/www/istbrasil_private/products/livros/
// Ou na home do usuário: /home/ubuntu/apps/istbrasil/products/livros/
const PRODUCTS_PATH = process.env.PRODUCTS_PATH || '/var/www/istbrasil_private/products/livros/';

exports.getAllBooks = async (req, res) => {
    console.log('getAllBooks chamado!');
    try {
        const [rows] = await db.execute('SELECT * FROM ist_livros WHERE onsale = 1');
        res.json(rows);
    } catch (error) {
        res.status(404).json({ message: 'Erro ao buscar livros', error: error.message });
    }
};

exports.getBookById = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.execute('SELECT * FROM ist_livros WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Livro não encontrado' });
        }
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar livro', error: error.message });
    }
};

// [2.1] e [2.2] Lógica de Download
exports.downloadBook = async (req, res) => {
    const { sku } = req.params; // Recebe o SKU (ou poderia ser orderId para mais segurança)

    try {
        // [2.1] Consultando a tabela ist_livros
        const [rows] = await db.execute('SELECT file, title FROM ist_livros WHERE sku LIKE ?', [sku]);

        if (rows.length === 0 || !rows[0].file) {
            return res.status(404).json({ message: 'Arquivo não encontrado para este produto.' });
        }

        const filename = rows[0].file;
        const filePath = path.join(PRODUCTS_PATH, filename);

        // Verifica se o arquivo existe fisicamente
        if (!fs.existsSync(filePath)) {
            console.error(`Arquivo físico não encontrado: ${filePath}`);
            return res.status(404).json({ message: 'Arquivo indisponível no servidor.' });
        }

        // [2.2] Faz o download do arquivo
        // [3.1] Magic Link: Aqui você poderia gerar um link assinado temporário (ex: AWS S3 presigned URL)
        // Para este servidor local, enviamos o arquivo diretamente (stream).
        res.download(filePath, filename, (err) => {
            if (err) {
                console.error('Erro no download:', err);
                // Não envie resposta JSON aqui se o header já foi enviado
            }
        });

    } catch (error) {
        console.error('Erro no controller de download:', error);
        res.status(500).json({ message: 'Erro interno ao processar download.' });
    }
};