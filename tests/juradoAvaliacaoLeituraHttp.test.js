import assert from 'node:assert/strict';
import { test } from 'node:test';
import { obterAvaliacaoJuradoHttpCycleAware as read } from '../src/services/juradoAvaliacaoLeituraHttpService.js';

function fixture(fail = null) {
    const calls = [], error = new Error('synthetic infrastructure failure');
    const step = async name => { calls.push(name); if (fail === name) throw error; };
    const connection = {
        query: sql => step(sql.startsWith('SET ') ? 'isolation' : 'snapshot'),
        commit: () => step('commit'), rollback: () => step('rollback'),
        release() { calls.push('release'); if (fail === 'release') throw error; },
        destroy() { calls.push('destroy'); }
    };
    const pool = { getConnection: async () => { await step('acquire'); return connection; } };
    const dto = { contexto: { idCiclo: 20 }, podeGravar: true };
    const reader = async (...args) => {
        assert.deepEqual(args.slice(0, 3), [{ id: 17 }, 40, 10]);
        assert.equal(args[3], connection);
        await step('reader');
        return dto;
    };
    return { calls, error, dto, connection, run: () => read({ id: 17 }, 40, 10, pool, reader) };
}
test('GET transaction adapter shares one connection, returns exact DTO after confirmed commit', async () => {
    const f = fixture();
    assert.equal(await f.run(), f.dto);
    assert.deepEqual(f.calls, ['acquire', 'isolation', 'snapshot', 'reader', 'commit', 'release']);
});
for (const [failure, calls] of [
    ['acquire', ['acquire']],
    ['isolation', ['acquire', 'isolation', 'destroy']],
    ['snapshot', ['acquire', 'isolation', 'snapshot', 'destroy']],
    ['reader', ['acquire', 'isolation', 'snapshot', 'reader', 'rollback', 'release']],
    ['commit', ['acquire', 'isolation', 'snapshot', 'reader', 'commit', 'rollback', 'destroy']]
]) test('GET adapter preserves ' + failure + ' error and appropriate cleanup', async () => {
    const f = fixture(failure);
    await assert.rejects(f.run(), e => e === f.error);
    assert.deepEqual(f.calls, calls);
});
test('GET adapter destroys connection after rollback failure without replacing original error', async () => {
    const f = fixture('reader');
    f.connection.rollback = async () => { f.calls.push('rollback'); throw new Error('rollback failed'); };
    await assert.rejects(f.run(), e => e === f.error);
    assert.deepEqual(f.calls.slice(-2), ['rollback', 'destroy']);
});
test('GET adapter preserves confirmed result and destroys connection when release fails', async () => {
    const f = fixture('release');
    assert.equal(await f.run(), f.dto);
    assert.deepEqual(f.calls.slice(-2), ['release', 'destroy']);
});
test('GET adapter logger and destroy failures cannot replace original failure', async () => {
    const f = fixture('reader'), original = console.error;
    f.connection.rollback = async () => { throw new Error('rollback failed'); };
    f.connection.destroy = () => { throw new Error('destroy failed'); };
    try {
        console.error = () => { throw new Error('logger failed'); };
        await assert.rejects(f.run(), e => e === f.error);
    } finally { console.error = original; }
});
