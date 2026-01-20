// Rotinas de Controller para Livros Digitais (E-books)
import { pool as db } from '../config/db.js';
import path from 'path';
import fs from 'fs';

const PRODUCTS_PATH = process.env.PRODUCTS_PATH || '/var/www/istbrasil_private/products/livros/';

const getAllBooks = async (req, res) => {
    console.log('getAllBooks chamado!');
    try {
        const [rows] = await db.execute('SELECT * FROM ist_livros WHERE onsale = 1');
        res.json(rows);
    } catch (error) {
        res.status(404).json({ message: 'Erro ao buscar livros', error: error.message });
    }
};

const getBookById = async (req, res) => {
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

const downloadBook = async (req, res) => {
    const { sku } = req.params;
    try {
        const [rows] = await db.execute('SELECT file, title FROM ist_livros WHERE sku LIKE ?', [sku]);

        if (rows.length === 0 || !rows[0].file) {
            return res.status(404).json({ message: 'Arquivo não encontrado para este produto.' });
        }

        const filename = rows[0].file;
        const filePath = path.join(PRODUCTS_PATH, filename);

        if (!fs.existsSync(filePath)) {
            console.error(`Arquivo físico não encontrado: ${filePath}`);
            return res.status(404).json({ message: 'Arquivo indisponível no servidor.' });
        }

        res.download(filePath, filename, (err) => {
            if (err) {
                console.error('Erro no download:', err);
            }
        });

    } catch (error) {
        console.error('Erro no controller de download:', error);
        res.status(500).json({ message: 'Erro interno ao processar download.' });
    }
};

export default {
    getAllBooks,
    getBookById,
    downloadBook
};