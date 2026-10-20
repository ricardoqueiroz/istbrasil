// Rotinas de Controller para Livros Digitais (E-books)
import { pool as db } from '../config/db.js';
import path from 'path';
import fs from 'fs';
import { avaliarPoliticaComercial, criarContextoCategorias, imagemPublica, validarProdutoId } from '../services/lojaCatalogoService.js';


// Leitura editorial independente da venda. A oferta e a hierarquia sao lidas no
// mesmo snapshot; somente a politica compartilhada decide se e possivel comprar.
export const criarBookController = ({ banco = db } = {}) => {
    const ler = async (id) => {
        const conexao = await banco.getConnection();
        try {
            await conexao.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await conexao.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            const [categorias] = await conexao.query('SELECT id, categoria_pai_id, ativo FROM ist_loja_categorias ORDER BY id');
            const { caminho } = criarContextoCategorias(categorias);
            const [rows] = await conexao.query(`SELECT l.id, l.title, l.description, l.language, l.format, l.img, l.category,
                p.id AS produto_id, p.sku, p.categoria_id, p.ativo, p.livro_id,
                p.titulo, p.descricao, CAST(p.preco_centavos AS CHAR) AS preco_centavos,
                p.moeda, p.tipo, p.em_venda, p.disponivel,
                l.format AS formato_editorial,
                EXISTS(SELECT 1 FROM ist_loja_arquivo_versoes v WHERE v.produto_id=p.id
                    AND v.estado='PUBLICADA' AND v.publicacao_atual=1) AS versao_publicada
                FROM ist_livros l LEFT JOIN ist_loja_produtos p ON p.livro_id = l.id
                WHERE l.pertence_editora_ist = 1${id === undefined ? '' : ' AND l.id = ?'} ORDER BY l.id`,
            id === undefined ? [] : [id]);
            const livros = rows.map(l => {
                const politica = avaliarPoliticaComercial({ ...l, id: l.produto_id }, caminho);
                return { id: l.id, title: l.title, description: l.description, language: l.language,
                    format: l.format, img: imagemPublica(l.img), category: l.category,
                    comercial: l.produto_id === null ? null : {
                        produtoId: l.produto_id, sku: l.sku, precoCentavos: politica.precoCentavos,
                        moeda: l.moeda, podeComprar: politica.elegivel
                    } };
            });
            await conexao.commit();
            return livros;
        } catch (erro) {
            await conexao.rollback();
            throw erro;
        } finally {
            conexao.release();
        }
    };
    return {
        async getAllBooks(req, res) {
            try { res.json(await ler()); }
            catch { res.status(404).json({ message: 'Erro ao buscar livros' }); }
        },
        async getBookById(req, res) {
            let id;
            try { id = validarProdutoId(req.params.id); }
            catch { return res.status(404).json({ message: 'Livro não encontrado' }); }
            try {
                const rows = await ler(id);
                if (rows.length === 0) return res.status(404).json({ message: 'Livro não encontrado' });
                res.json(rows[0]);
            } catch { res.status(500).json({ message: 'Erro ao buscar livro' }); }
        }
    };
};
const { getAllBooks, getBookById } = criarBookController();

export default {
    getAllBooks,
    getBookById
};
