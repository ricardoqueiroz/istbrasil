// Somente dependencias simuladas: nao inicia PM2, HTTP, subprocessos ou bancos.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { limitar, executarComando, verificarHttp, validarPorta, PORTAS_PROTEGIDAS,
    validarProntidao, validarProcesso, mesmaIdentidade, lerProcesso, validarListener,
    validarInstalacao, validarRaiz, podeRemover, limparIsolado } from './fixtures/deployPm2Isolado.mjs';

const clock = () => {
    const callbacks = new Map(); let sequence = 0;
    return {
        setTimeout(fn, ms) { const id = ++sequence; callbacks.set(id, { fn, ms }); return id; },
        clearTimeout(id) { callbacks.delete(id); },
        fire(ms) { for (const [id, c] of [...callbacks]) if (c.ms === ms) { callbacks.delete(id); c.fn(); } },
        get size() { return callbacks.size; },
    };
};
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const code = c => e => e.code === c;
const ready = { marker: 'marcador-sintetico', cwd: '/synthetic/one', pid: 123, port: 35000 };

test('comando PM2 tem limite 10s, cancelamento e erro sanitizado sem spawn real', async () => {
    const timers = clock(), eventos = [], pendentes = new Set(); let signal, options;
    const promise = executarComando('/synthetic/pm2', ['jlist'], {
        timers, pendentes, env: { PM2_HOME: '/synthetic/home' }, registrar: e => eventos.push(e),
        identificar: async () => ({ pid: 42, uid: 1000, inicio: '1', exe: '/node', args: [], cwd: '/synthetic' }),
        spawn: (_cmd, _args, op, cb) => {
            signal = op.signal; options = op;
            op.signal.addEventListener('abort', () => queueMicrotask(() => cb(Error('SEGREDO'))), { once: true });
            return { pid: 42, once() {} };
        },
    });
    const rejected = assert.rejects(promise, code('PM2_COMANDO_TIMEOUT'));
    await flush(); timers.fire(10000); await rejected; await flush();
    assert.equal(options.timeout, 10000); assert.equal(signal.aborted, true);
    assert(eventos.some(e => e.tipo === 'COMANDO_INICIADO' && e.pid === 42));
    assert(!JSON.stringify(eventos).includes('SEGREDO')); assert.equal(pendentes.size, 0);
});

test('health check tem limite 2s e cancela transporte simulado, sem HTTP real', async () => {
    const timers = clock(); let signal, redirect;
    const promise = verificarHttp(ready, { ...ready, timers, fetcher: async (_url, op) => {
        signal = op.signal; redirect = op.redirect;
        return new Promise((_, reject) => op.signal.addEventListener('abort', () => reject(Error('cancelado')), { once: true }));
    } });
    const rejected = assert.rejects(promise, code('HTTP_TIMEOUT'));
    await flush(); timers.fire(2000); await rejected;
    assert.equal(signal.aborted, true); assert.equal(redirect, 'error');
});

test('promise tardia permanece observada e impede remocao enquanto pendente', async () => {
    const timers = clock(), pendentes = new Set(); let rejeitar;
    const promise = limitar(() => new Promise((_, reject) => { rejeitar = reject; }), { ms: 10, timers, pendentes });
    const rejected = assert.rejects(promise, code('OPERACAO_TIMEOUT'));
    await flush(); timers.fire(10); await rejected;
    assert.equal(pendentes.size, 1);
    assert.equal(podeRemover({ paradaConfirmada: true, processosRestantes: 0, pendentes: 1, incerto: false }), false);
    rejeitar(Error('falha tardia')); await flush(); assert.equal(pendentes.size, 0);
});

test('cancelamento previo nao inicia operacao e limite funcional e distinto do teardown', async () => {
    const c = new AbortController(); c.abort(); let called = false;
    await assert.rejects(limitar(() => { called = true; }, { ms: 60000, signal: c.signal }), code('OPERACAO_CANCELADA'));
    assert.equal(called, false);
});

for (const etapa of ['preparacao', 'ativacao']) test(`falha de ${etapa}: limpeza simulada exige parada e observacao antes de remover`, async () => {
    const events = []; let teardown;
    // Mesmo contrato de t.after: callback registrado ANTES da preparacao.
    const registrarTeardown = fn => { teardown = fn; events.push('registrar'); };
    registrarTeardown(() => limparIsolado({
        parar: async () => { events.push('parar'); }, observar: async () => { events.push('observar'); return 0; },
        estado: () => ({ incerto: false, pendentes: 0 }), remover: async () => { events.push('remover'); },
        preservar: async () => assert.fail('nao deveria preservar'),
    }));
    await assert.rejects((async () => { events.push(etapa); throw Error('FALHA_SIMULADA'); })());
    const result = await teardown();
    assert.equal(result.estado, 'CONCLUIDA'); assert.deepEqual(events, ['registrar', etapa, 'parar', 'observar', 'remover']);
});

test('falha de encerramento do daemon preserva evidencias e nunca remove raiz', async () => {
    let removed = false, preserved;
    const result = await limparIsolado({ parar: async () => { throw Object.assign(Error(), { code: 'DAEMON_NAO_ENCERROU' }); },
        observar: async () => 1, estado: () => ({ pendentes: 0, incerto: false }),
        remover: async () => { removed = true; }, preservar: async c => { preserved = c; } });
    assert.equal(result.estado, 'PARCIAL'); assert.equal(preserved, 'DAEMON_NAO_ENCERROU'); assert.equal(removed, false);
});

test('timeout de limpeza e falha tardia nao provocam remocao posterior', async () => {
    const timers = clock(); let finish, removed = false, preserved = false;
    const promise = limparIsolado({ timers, parar: () => new Promise(r => { finish = r; }), observar: async () => 0,
        estado: () => ({ pendentes: 0, incerto: false }), remover: async () => { removed = true; },
        preservar: async () => { preserved = true; } });
    await flush(); timers.fire(30000); assert.equal((await promise).estado, 'PARCIAL');
    finish(); await flush(); assert.equal(removed, false); assert.equal(preserved, true);
});

test('residuos, incerteza ou promises pendentes impedem descarte', async () => {
    for (const state of [{ incerto: true, pendentes: 0, restantes: 0 }, { incerto: false, pendentes: 1, restantes: 0 },
        { incerto: false, pendentes: 0, restantes: 1 }]) {
        let removed = false;
        const r = await limparIsolado({ parar: async () => {}, observar: async () => state.restantes,
            estado: () => state, remover: async () => { removed = true; }, preservar: async () => {} });
        assert.equal(r.estado, 'PARCIAL'); assert.equal(removed, false);
    }
});

test('identidade divergente e PID reutilizado nao autorizam encerramento', () => {
    const p = { pid: 42, uid: 1000, inicio: '123', exe: '/node', cwd: '/test', args: ['/test/server.cjs'] };
    assert(mesmaIdentidade(p, { ...p }));
    for (const change of [{ uid: 0 }, { inicio: '999' }, { exe: '/other' }, { pid: 43 }]) assert(!mesmaIdentidade(p, { ...p, ...change }));
    assert.throws(() => validarProcesso(p, { uid: 0, exe: '/node' }), code('PROCESSO_IDENTIDADE_DIVERGENTE'));
    assert.throws(() => validarProcesso(p, { uid: 1000, exe: '/node', home: '/pm2/other' }), code('PROCESSO_IDENTIDADE_DIVERGENTE'));
});

test('leitura de identidade usa inicio de execucao e falha fechado em observacao negada', async () => {
    const fields = Array(20).fill('0'); fields[19] = '789';
    const p = await lerProcesso(42, { io: { stat: async () => ({ uid: 1000 }),
        readFile: async f => f.endsWith('/stat') ? '42 (node) ' + fields.join(' ') : Buffer.from('/node\0/test/server.cjs\0'),
        readlink: async f => f.endsWith('/exe') ? '/node' : '/test' } });
    assert.equal(p.inicio, '789'); assert.equal(p.uid, 1000);
    await assert.rejects(lerProcesso(42, { io: { stat: async () => { throw { code: 'EACCES' }; } } }), code('PROCESSO_NAO_OBSERVAVEL'));
});

test('portas protegidas, nulas e prontidao divergente sao rejeitadas antes de HTTP', async () => {
    for (const port of [...PORTAS_PROTEGIDAS, 0, -1, 65536, '35000']) {
        assert.throws(() => validarPorta(port), code('PORTA_NAO_AUTORIZADA'));
        await assert.rejects(verificarHttp({ ...ready, port }, { ...ready, fetcher: () => assert.fail('HTTP indevido') }));
    }
    assert.equal(validarPorta(35000), 35000);
    assert.throws(() => validarProntidao({ ...ready, marker: 'outro' }, ready), code('PRONTIDAO_INVALIDA'));
});

test('listener precisa ser loopback e possuir socket pertencente ao PID esperado', async () => {
    const io = { readdir: async () => ['5'], readlink: async () => 'socket:[789]',
        readFile: async () => 'header\n0: 0100007F:88B8 00000000:0000 0A 0 0 0 0 0 789\n' };
    await validarListener({ pid: 42 }, 35000, { io });
    await assert.rejects(validarListener({ pid: 43 }, 35001, { io }), code('LISTENER_NAO_PERTENCE_AO_TESTE'));
});

test('marcador incorreto, redirect e status inesperado nao confirmam health check', async () => {
    for (const response of [{ status: 200, text: async () => JSON.stringify({ marker: 'outro', cwd: ready.cwd }) },
        { status: 302, redirected: true, text: async () => '' }]) {
        await assert.rejects(verificarHttp(ready, { ...ready, fetcher: async () => response }));
    }
    assert.equal(await verificarHttp(ready, { ...ready, fetcher: async () => ({ status: 200,
        text: async () => JSON.stringify({ marker: ready.marker, cwd: ready.cwd }) }) }), ready.cwd);
});

test('executavel PM2 relativo, aprovacao ausente, hash adulterado e manifesto link sao rejeitados', async () => {
    const base = path.resolve('synthetic-approved-pm2'), command = path.join(base, 'launcher');
    const manifestPath = path.resolve('synthetic-manifest.json');
    const bytes = Buffer.from('{}'), hash = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(validarInstalacao({ command: 'pm2' }), code('PM2_APROVACAO_INVALIDA'));
    const stat = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid: 1000, mode: 0o600 };
    const io = { lstat: async f => f === manifestPath ? stat : ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o700 }),
        realpath: async f => f, readFile: async () => bytes };
    await assert.rejects(validarInstalacao({ command, manifestPath, manifestSha256: '0'.repeat(64) }, { io, uid: 1000, nodeVersion: '20.19.6' }), code('PM2_MANIFESTO_DIVERGENTE'));
    await assert.rejects(validarInstalacao({ command, manifestPath, manifestSha256: hash }, {
        io: { ...io, lstat: async () => ({ ...stat, isSymbolicLink: () => true }) }, uid: 1000, nodeVersion: '20.19.6' }), code('PM2_MANIFESTO_INSEGURO'));
});

test('raiz propria precisa ser canonica, privada e do usuario esperado', async () => {
    const root = path.resolve('ist-real-pm2-synthetic');
    const io = { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o700 }), realpath: async f => f };
    await validarRaiz(root, { io, uid: 1000 });
    await assert.rejects(validarRaiz(root, { io, uid: 1001 }), code('RAIZ_INSEGURA'));
});

test('manifesto aprovado exige inventario integral, launcher executavel e versao do pacote', async () => {
    const root = path.resolve('synthetic-approved-install'), command = path.join(root, 'launcher');
    const manifestPath = path.resolve('synthetic-approval.json');
    const contents = new Map([['launcher', Buffer.from('#!/usr/bin/env node\n')],
        ['node_modules/pm2/package.json', Buffer.from(JSON.stringify({ name: 'pm2', version: '6.0.14' }))]]);
    const digest = b => createHash('sha256').update(b).digest('hex');
    const manifest = { version: 1, node: '20.19.6', root, command, pm2Version: '6.0.14',
        files: [...contents].map(([name, bytes]) => ({ path: name, mode: name === 'launcher' ? 0o755 : 0o644, sha256: digest(bytes) })) };
    const bytes = Buffer.from(JSON.stringify(manifest)); let extra = false, corrupt = false;
    const fileStat = mode => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, uid: 1000, mode, nlink: 1 });
    const io = {
        lstat: async f => f === manifestPath ? fileStat(0o600) : contents.has(path.relative(root, f).split(path.sep).join('/'))
            ? fileStat(f === command ? 0o755 : 0o644) : f === path.join(root, 'extra') ? fileStat(0o644)
                : ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o700 }),
        realpath: async f => f,
        readFile: async f => f === manifestPath ? bytes : corrupt && f === command ? Buffer.from('adulterado')
            : contents.get(path.relative(root, f).split(path.sep).join('/')),
        readdir: async f => f === root ? ['launcher', 'node_modules', ...(extra ? ['extra'] : [])]
            : f === path.join(root, 'node_modules') ? ['pm2'] : ['package.json'],
    };
    const input = { command, manifestPath, manifestSha256: digest(bytes) }, options = { io, uid: 1000, nodeVersion: '20.19.6' };
    assert.equal((await validarInstalacao(input, options)).pm2Version, '6.0.14');
    extra = true; await assert.rejects(validarInstalacao(input, options), code('PM2_ARQUIVOS_ADICIONAIS'));
    extra = false; corrupt = true; await assert.rejects(validarInstalacao(input, options), code('PM2_ARQUIVO_DIVERGENTE'));
});

const fixtureLinks = (mutate = () => {}) => {
    const root = path.resolve('synthetic-links-install'), command = path.join(root, 'launcher');
    const manifestPath = path.resolve('synthetic-links-approval.json');
    const contents = new Map([
        ['launcher', Buffer.from('#!/bin/sh\n')],
        ['node_modules/pm2/package.json', Buffer.from(JSON.stringify({ name: 'pm2', version: '6.0.14' }))],
        ['node_modules/pm2/bin/pm2', Buffer.from('#!/usr/bin/env node\n')],
    ]);
    const digest = b => createHash('sha256').update(b).digest('hex');
    const link = { path: 'node_modules/.bin/pm2', target: '../pm2/bin/pm2',
        resolved: 'node_modules/pm2/bin/pm2', uid: 1000, gid: 1000 };
    const state = { contents, links: new Map([[link.path, { ...link }]]), extraLink: false,
        actualTarget: null, broken: false, chain: false, cycle: false, intermediate: false, corrupt: false };
    mutate(state);
    const manifest = { version: 1, node: '20.19.6', root, command, pm2Version: '6.0.14',
        files: [...contents].map(([name, bytes]) => ({ path: name, mode: name === 'launcher' || name.endsWith('/bin/pm2') ? 0o755 : 0o644,
            sha256: digest(bytes) })), links: [...state.links.values()] };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const directories = new Map([
        [root, ['launcher', 'node_modules']],
        [path.join(root, 'node_modules'), ['.bin', 'pm2']],
        [path.join(root, 'node_modules', '.bin'), ['pm2', ...(state.extraLink ? ['extra'] : [])]],
        [path.join(root, 'node_modules', 'pm2'), ['package.json', 'bin']],
        [path.join(root, 'node_modules', 'pm2', 'bin'), ['pm2']],
    ]);
    const rel = f => path.relative(root, f).split(path.sep).join('/');
    const fileStat = mode => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        uid: 1000, gid: 1000, mode, nlink: 1 });
    const dirStat = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
        uid: 1000, gid: 1000, mode: 0o700 };
    const linkStat = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true,
        uid: 1000, gid: 1000, mode: 0o777, nlink: 1 };
    const linkPath = path.join(root, 'node_modules', '.bin', 'pm2');
    const extraPath = path.join(root, 'node_modules', '.bin', 'extra');
    const io = {
        lstat: async f => {
            if (f === manifestPath) return fileStat(0o600);
            if (state.intermediate && f === path.join(root, 'node_modules')) return linkStat;
            if (f === linkPath || state.extraLink && f === extraPath) return linkStat;
            if (directories.has(f) || !f.startsWith(root)) return dirStat;
            if (contents.has(rel(f))) return fileStat(rel(f) === 'launcher' || rel(f).endsWith('/bin/pm2') ? 0o755 : 0o644);
            throw Object.assign(new Error('ausente'), { code: 'ENOENT' });
        },
        realpath: async f => {
            if (f === linkPath) {
                if (state.broken) throw Object.assign(new Error('quebrado'), { code: 'ENOENT' });
                if (state.cycle) throw Object.assign(new Error('ciclo'), { code: 'ELOOP' });
                if (state.chain) return path.join(root, 'node_modules/pm2/bin/pm2');
                const declared = state.links.get(link.path);
                return declared?.target?.startsWith('../../../../') ? path.resolve(root, declared.target) : path.join(root, link.resolved);
            }
            if (f === extraPath) return path.join(root, 'node_modules/pm2/bin/pm2');
            return f;
        },
        readlink: async f => f === extraPath ? '../pm2/bin/pm2'
            : state.chain ? '../pm2-chain' : state.actualTarget ?? state.links.get(link.path)?.target,
        readFile: async f => f === manifestPath ? bytes : state.corrupt && rel(f) === link.resolved
            ? Buffer.from('adulterado') : contents.get(rel(f)),
        readdir: async f => directories.get(f) ?? [],
    };
    return { input: { command, manifestPath, manifestSha256: digest(bytes) },
        options: { io, uid: 1000, nodeVersion: '20.19.6' }, state, link };
};

test('symlink interno inventariado e integro e aceito', async () => {
    const f = fixtureLinks();
    assert.equal((await validarInstalacao(f.input, f.options)).links.length, 1);
});

test('symlink adicional nao inventariado e rejeitado', async () => {
    const f = fixtureLinks(s => { s.extraLink = true; });
    await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_LINK_NAO_INVENTARIADO'));
});

test('symlink inventariado ausente e rejeitado', async () => {
    const f = fixtureLinks();
    f.options.io.lstat = async pathName => {
        if (pathName.endsWith(`${path.sep}.bin${path.sep}pm2`)) throw Object.assign(new Error(), { code: 'ENOENT' });
        return fixtureLinks().options.io.lstat(pathName);
    };
    await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_LINK_DIVERGENTE'));
});

test('alvo textual adulterado e rejeitado', async () => {
    const f = fixtureLinks(s => { s.actualTarget = '../pm2/bin/outro'; });
    await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_LINK_DIVERGENTE'));
});

test('symlink externo e rejeitado por contencao canonica', async () => {
    const f = fixtureLinks(s => { s.links.get('node_modules/.bin/pm2').target = '../../../../outside'; });
    await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_LINK_DIVERGENTE'));
});

test('symlink quebrado e rejeitado', async () => {
    const f = fixtureLinks(s => { s.broken = true; });
    await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_LINK_DIVERGENTE'));
});

test('symlink para arquivo nao inventariado e rejeitado', async () => {
    const f = fixtureLinks(s => { s.links.get('node_modules/.bin/pm2').resolved = 'node_modules/pm2/bin/outro'; });
    await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_LINK_INVENTARIO_INVALIDO'));
});

test('diretorio intermediario convertido em symlink e rejeitado', async () => {
    const f = fixtureLinks(s => { s.intermediate = true; });
    await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_ANCESTRAL_INSEGURO'));
});

test('cadeia ou ciclo de symlinks e rejeitado pela igualdade lexical direta', async () => {
    for (const tipo of ['chain', 'cycle']) {
        const f = fixtureLinks(s => { s[tipo] = true; });
        await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_LINK_DIVERGENTE'));
    }
});

test('arquivo regular adulterado permanece rejeitado com symlink legitimo', async () => {
    const f = fixtureLinks(s => { s.corrupt = true; });
    await assert.rejects(validarInstalacao(f.input, f.options), code('PM2_ARQUIVO_DIVERGENTE'));
});
