import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import router from './projetosDocumentos.routes.js';

test('documentos públicos de projetos: PDF, HEAD, range e isolamento', async () => {
    const app = express();
    app.use('/istbrasil.private/projetos', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = `${base}/istbrasil.private/projetos/${encodeURIComponent('Novo_Museu_de_Santarém.pdf')}`;
    try {
        let response = await fetch(url, { method: 'HEAD' });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /application\/pdf/);
        assert.ok(Number(response.headers.get('content-length')) > 0);
        response = await fetch(url, { headers: { Range: 'bytes=0-4' } });
        assert.equal(response.status, 206);
        assert.equal(await response.text(), '%PDF-');
        for (const path of ['/istbrasil.private/projetos/', '/istbrasil.private/projetos/ausente.pdf',
            '/istbrasil.private/projetos/.env', '/istbrasil.private/',
            '/istbrasil.private/documents/', '/istbrasil.private/projetos/%2e%2e%2f.env']) {
            response = await fetch(base + path, { redirect: 'manual' });
            assert.equal(response.status, 404, path);
        }
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
