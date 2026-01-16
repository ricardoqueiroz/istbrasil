const db = require('../config/db');

exports.getAllBooks = async (req, res) => {
    console.log('getAllBooks chamado!');
    try {
        const [rows] = await db.execute('SELECT * FROM ist_livros WHERE onsale = 1');
        res.json(rows);
    } catch (error) {
        //res.status(500).json({ message: 'Erro ao buscar livros', error: error.message });
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