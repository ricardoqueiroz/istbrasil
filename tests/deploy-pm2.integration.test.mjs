import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPm2Adapter } from '../scripts/deploy/production-operation.mjs';
import { erroIsolamento, limitar, validarRaiz, validarInstalacao, lerProcesso,
    mesmaIdentidade, validarProcesso, validarProntidao, validarListener, verificarHttp,
    executarComando, limparIsolado } from './fixtures/deployPm2Isolado.mjs';

const command = process.env.PM2_TEST_COMMAND;
const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 || !command ? 'Real non-root PM2 test requires PM2_TEST_COMMAND' : false };

test('real PM2 adapter switches cwd/script and verifies HTTP health', { ...linux, timeout: 120000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-real-pm2-'));
    const home = path.join(root, 'pm2'), name = `ist-api-test-${process.pid}`;
    const uid = process.getuid();
    const pendentes = new Set(), conhecidos = new Map(), eventos = [];
    let daemon, iniciado = false, incerto = false, aprovado, faseSignal, exe;
    const lembrar = p => { conhecidos.set(`${p.pid}:${p.inicio}`, p); return p; };
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, PM2_HOME: home, LANG: 'C', LC_ALL: 'C' };
    const conferirDaemon = async () => {
        const s = await fs.lstat(home), ps = await fs.lstat(path.join(home, 'pm2.pid'));
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o7777) !== 0o700
            || !ps.isFile() || ps.isSymbolicLink() || ps.nlink !== 1 || ps.uid !== uid || ps.size > 32)
            throw erroIsolamento('PM2_HOME_OU_PIDFILE_INVALIDO');
        const texto = (await fs.readFile(path.join(home, 'pm2.pid'), 'utf8')).trim();
        if (!/^[1-9]\d*$/.test(texto)) throw erroIsolamento('PM2_PID_INVALIDO');
        const p = validarProcesso(await lerProcesso(Number(texto)), { uid, exe, home });
        if (daemon && !mesmaIdentidade(daemon, p)) throw erroIsolamento('PM2_DAEMON_SUBSTITUIDO');
        daemon = lembrar(p); return p;
    };
    const listarProprios = async () => {
        const encontrados = [];
        for (const id of await fs.readdir('/proc')) {
            if (!/^[1-9]\d*$/.test(id) || Number(id) === process.pid) continue;
            let s; try { s = await fs.stat(`/proc/${id}`); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
            if (s.uid !== uid) continue;
            const p = await lerProcesso(Number(id));
            if (p && (p.cwd === root || p.cwd.startsWith(root + '/') || p.args.some(a => a.includes(root))))
                encontrados.push(lembrar(p));
        }
        return encontrados;
    };
    const registrar = e => {
        eventos.push({ tipo: e.tipo, pid: e.pid });
        if (e.tipo === 'COMANDO_FALHOU' || e.tipo === 'COMANDO_IDENTIDADE_INCERTA') incerto = true;
        if (e.identidade) {
            try { lembrar(validarProcesso(e.identidade, { uid, exe })); }
            catch { incerto = true; }
        }
    };
    const comando = async (args, signal, inicial = false) => {
        if (signal?.aborted) throw erroIsolamento('OPERACAO_CANCELADA');
        if (!aprovado || !['start', 'delete', 'jlist', 'kill'].includes(args[0])) throw erroIsolamento('COMANDO_NAO_AUTORIZADO');
        if (args[0] === 'delete' && (args.length !== 2 || args[1] !== name)) throw erroIsolamento('ALVO_NAO_AUTORIZADO');
        if (args[0] === 'kill' && args.length !== 1) throw erroIsolamento('ALVO_NAO_AUTORIZADO');
        if (!inicial) await conferirDaemon();
        await validarInstalacao(aprovado);
        if (signal?.aborted) throw erroIsolamento('OPERACAO_CANCELADA');
        try { return await executarComando(command, args, { env, signal, pendentes, registrar }); }
        catch (e) { incerto = true; throw e; }
    };
    const pausa = signal => limitar(s => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        s.addEventListener('abort', () => { clearTimeout(timer); reject(erroIsolamento('OPERACAO_CANCELADA')); }, { once: true });
    }), { ms: 500, signal, pendentes });

    // Teardown registrado antes de criar qualquer recurso alem da raiz exclusiva.
    t.after(async () => {
        const resultado = await limparIsolado({
            estado: () => ({ pendentes: pendentes.size, incerto }),
            parar: async signal => {
                await validarRaiz(root);
                if (!iniciado) return;
                if (!daemon) { try { await conferirDaemon(); } catch { incerto = true; return; } }
                let atual = await lerProcesso(daemon.pid);
                if (!atual) return; // Nao chamar CLI capaz de recriar daemon.
                if (!mesmaIdentidade(daemon, atual)) throw erroIsolamento('PM2_DAEMON_SUBSTITUIDO');
                await conferirDaemon();
                const proprios = await listarProprios();
                if (proprios.some(p => p.args.some(a => a.includes('/server.cjs')))) await comando(['delete', name], signal);
                atual = await lerProcesso(daemon.pid);
                if (atual) {
                    if (!mesmaIdentidade(daemon, atual)) throw erroIsolamento('PM2_DAEMON_SUBSTITUIDO');
                    await comando(['kill'], signal);
                }
                while (!signal.aborted) {
                    let vivos = 0;
                    for (const p of conhecidos.values()) {
                        const agora = await lerProcesso(p.pid);
                        if (agora && mesmaIdentidade(p, agora)) vivos++;
                        else if (agora) throw erroIsolamento('PID_REUTILIZADO');
                    }
                    if (!vivos && !(await listarProprios()).length) return;
                    await pausa(signal);
                }
                throw erroIsolamento('LIMPEZA_TIMEOUT');
            },
            observar: async signal => {
                if (signal.aborted) throw erroIsolamento('LIMPEZA_TIMEOUT');
                return (await listarProprios()).length;
            },
            remover: async () => { await validarRaiz(root); await fs.rm(root, { recursive: true, force: false }); },
            preservar: async codigo => {
                try { await fs.writeFile(path.join(root, 'DIAGNOSTICO.json'), JSON.stringify({ codigo,
                    eventos: eventos.map(e => ({ tipo: e.tipo, pid: e.pid })),
                    processos: [...conhecidos.values()].map(p => ({ pid: p.pid, uid: p.uid, inicio: p.inicio })),
                    pendentes: pendentes.size }), { flag: 'wx', mode: 0o600 }); } catch { /* Preservar mesmo sem relatorio. */ }
            },
        });
        t.diagnostic(`PM2_LIMPEZA=${resultado.estado}; codigo=${resultado.codigo ?? 'OK'}; raiz=${root}`);
        assert.equal(resultado.estado, 'CONCLUIDA', resultado.codigo);
    });

    await limitar(async signal => {
        faseSignal = signal;
        exe = await fs.realpath(process.execPath);
        await fs.chmod(root, 0o700); await validarRaiz(root);
        aprovado = { command, manifestPath: process.env.PM2_TEST_MANIFEST,
            manifestSha256: process.env.PM2_TEST_MANIFEST_SHA256 };
        await validarInstalacao(aprovado);
        await fs.mkdir(home, { mode: 0o700 });
        const marker = randomBytes(32).toString('hex'), dirs = [path.join(root, 'one'), path.join(root, 'two')];
        for (const dir of dirs) {
            await fs.mkdir(dir, { mode: 0o700 });
            const source = `const fs=require('node:fs');const http=require('node:http');
const marker=${JSON.stringify(marker)},cwd=process.cwd();
const server=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({marker,cwd}));});
server.listen(0,'127.0.0.1',()=>{const port=server.address().port;
if([3000,3001,4200,4201,8080,8443].includes(port)){server.close(()=>process.exit(2));return;}
fs.writeFileSync('READY.json',JSON.stringify({marker,cwd,pid:process.pid,port}),{flag:'wx',mode:0o600});});`;
            await fs.writeFile(path.join(dir, 'server.cjs'), source, { flag: 'wx', mode: 0o600 });
        }
        const pronto = async cwd => {
            while (!signal.aborted) {
                try {
                    const f = path.join(cwd, 'READY.json'), st = await fs.lstat(f);
                    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid || st.size > 2048)
                        throw erroIsolamento('PRONTIDAO_ARQUIVO_INVALIDO');
                    const ready = validarProntidao(JSON.parse(await fs.readFile(f, 'utf8')), { marker, cwd });
                    const p = validarProcesso(await lerProcesso(ready.pid), { uid, exe, cwd, script: path.join(cwd, 'server.cjs') });
                    lembrar(p); await validarListener(p, ready.port);
                    if (!mesmaIdentidade(p, await lerProcesso(p.pid))) throw erroIsolamento('PROCESSO_IDENTIDADE_DIVERGENTE');
                    return ready;
                } catch (e) { if (e.code !== 'ENOENT') throw e; }
                await pausa(signal);
            }
            throw erroIsolamento('OPERACAO_CANCELADA');
        };
        iniciado = true;
        await comando(['start', path.join(dirs[0], 'server.cjs'), '--name', name, '--cwd', dirs[0], '--no-autorestart'], signal, true);
        await conferirDaemon(); await pronto(dirs[0]);
        let cwdEsperado = dirs[0];
        const adapter = createPm2Adapter({ pm2Home: home, name, command,
            executeCommand: async (cmd, args) => {
                if (cmd !== command) throw erroIsolamento('EXECUTAVEL_DIVERGENTE');
                return comando(args, faseSignal);
            },
            health: async () => verificarHttp(await pronto(cwdEsperado), { marker, cwd: cwdEsperado, signal, pendentes }),
        });
        assert.equal((await adapter.describe()).cwd, dirs[0]);
        cwdEsperado = dirs[1];
        await adapter.switchTo({ cwd: dirs[1], script: path.join(dirs[1], 'server.cjs') });
        assert.equal(await adapter.health(), dirs[1]);
        const selected = await adapter.describe(); assert.equal(selected.cwd, dirs[1]);
        assert.equal(selected.script, path.join(dirs[1], 'server.cjs'));
    }, { ms: 60000, signal: t.signal, pendentes, codigo: 'FASE_FUNCIONAL_TIMEOUT' });
});
