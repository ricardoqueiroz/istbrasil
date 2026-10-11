import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../config/db.js';
import router from './projetos.routes.js';

test('API pública de projetos com pool simulado', async () => {
    const original = pool.query;
    const app = express();
    app.use('/api/projetos', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/projetos`;
    const projeto = { id: 1, slug: 'novo_museu_em_santarem', destaque: 1,
        resumo: '<p>Museu <strong>cultural</strong><script>alert(1)</script></p>',
        tipicidade: 'Projetos Especiais', tipologia: 'Museus', data_inicio: null };
    try {
        pool.query = async options => {
            assert.equal(options.dateStrings, true);
            assert.match(options.sql, /tp.id_tipicidade = p.id_tipicidade/);
            assert.match(options.sql, /p.status != 'Cancelado'/);
            assert.match(options.sql, /p.id DESC/);
            return [[projeto]];
        };
        let response = await fetch(base);
        assert.equal(response.status, 200);
        const lista = await response.json();
        assert.equal(lista[0].destaque, true);
        assert.equal(lista[0].resumo, 'Museu cultural');
        assert.equal(lista[0].data_inicio, null);
        let chamadas = 0;
        pool.query = async (options, params) => {
            chamadas++;
            assert.equal(options.dateStrings, true);
            if (chamadas === 1) {
                assert.deepEqual(params, ['novo_museu_em_santarem']);
                assert.match(options.sql, /p.slug = \?/);
                return [[projeto]];
            }
            assert.deepEqual(params, [1]);
            assert.match(options.sql, /ORDER BY ordem ASC, id ASC/);
            return [[{ id: 1, titulo: 'Apresentação', arquivo_url: '/uploads/documentos/projeto.pdf' }]];
        };
        response = await fetch(`${base}/novo_museu_em_santarem`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).documentos.length, 1);
        pool.query = async () => [[]];
        assert.equal((await fetch(`${base}/inexistente`)).status, 404);
        assert.equal((await fetch(`${base}/slug%20invalido`)).status, 400);
        pool.query = async () => { throw new Error('INFORMAÇÃO INTERNA DO BANCO'); };
        response = await fetch(base);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { message: 'Erro ao carregar a lista de projetos.' });
        pool.query = async () => [[projeto, projeto]];
        response = await fetch(`${base}/novo_museu_em_santarem`);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { message: 'Erro ao carregar detalhes do projeto.' });
    } finally {
        pool.query = original;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await pool.end();
    }
});
