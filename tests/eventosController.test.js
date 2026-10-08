import assert from 'node:assert/strict';
import test from 'node:test';
import { pool as db } from '../src/config/db.js';
import controller from '../src/controllers/eventosController.js';

const response = () => ({ statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('detalhe preserva etapas, CTA nullable e DATETIME civil com ordem determinística', async () => {
    const original = db.query;
    const consultas = [];
    const etapa = { id: 2, evento_id: 1, ordem: 1, data_inicio: '2026-10-15 00:00:00',
        link_etapa_pendente: null, cta_etapa_pendente: 'Em breve', link_etapa_andamento: '/cadastro/concorrente',
        cta_etapa_andamento: 'Inscreva-se', link_etapa_concluido: null, cta_etapa_concluido: null };
    db.query = async (query, params) => {
        consultas.push({ query, params });
        const sql = typeof query === 'string' ? query : query.sql;
        if (sql.includes('FROM ist_eventos WHERE')) return [[{ id: 1, slug: 'teste', local_nome: 'Local geral' }]];
        if (sql.includes('FROM ist_eventos_etapas')) return [[etapa]];
        return [[]];
    };
    try {
        const res = response(); await controller.obterEventoPorSlug({ params: { slug: ' teste ' } }, res);
        assert.equal(res.statusCode, 200); assert.deepEqual(res.body.etapas, [etapa]);
        assert.equal(res.body.local_nome, 'Local geral');
        const etapas = consultas.find(c => c.query.sql?.includes('ist_eventos_etapas'));
        assert.match(etapas.query.sql, /SELECT \*.*ORDER BY ordem ASC, data_inicio ASC, id ASC/);
        assert.equal(etapas.query.dateStrings, true); assert.deepEqual(etapas.params, [1]);
        assert.deepEqual(res.body.documentos, []); assert.deepEqual(res.body.programacao, []);
    } finally { db.query = original; }
});

for (const [nome, slug, retorno, codigo] of [
    ['slug ausente', '', [], 400], ['evento ausente', 'ausente', [], 404], ['falha banco', 'erro', null, 500]
]) test(nome, async () => {
    const original = db.query, log = console.error;
    let consultas = 0;
    db.query = async () => { consultas++; if (retorno === null) throw new Error('falha simulada'); return [retorno]; };
    console.error = () => {};
    try {
        const res = response(); await controller.obterEventoPorSlug({ params: { slug } }, res);
        assert.equal(res.statusCode, codigo); assert.equal(typeof res.body.message, 'string');
        if (codigo === 400) assert.equal(consultas, 0);
        if (codigo === 500) assert.equal(res.body.error, 'falha simulada');
    } finally { db.query = original; console.error = log; }
});
