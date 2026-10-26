// Exclusivo da integracao PM2. Nenhum efeito de processo/rede durante importacao.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

export const erroIsolamento = code => Object.assign(new Error(code), { code });
const exigir = (ok, code) => { if (!ok) throw erroIsolamento(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const dentro = (base, alvo) => alvo === base || alvo.startsWith(base + path.sep);
const contido = (base, alvo) => {
    const relativo = path.relative(base, alvo);
    return relativo === '' || (relativo !== '..' && !relativo.startsWith(`..${path.sep}`) && !path.isAbsolute(relativo));
};
const caminhoRelativoValido = valor => typeof valor === 'string' && valor && !path.isAbsolute(valor)
    && !valor.includes('\\') && !valor.split('/').some(p => !p || p === '.' || p === '..');
export const PORTAS_PROTEGIDAS = Object.freeze([3000, 3001, 4200, 4201, 8080, 8443]);
export const validarPorta = porta => {
    exigir(Number.isInteger(porta) && porta > 0 && porta <= 65535 && !PORTAS_PROTEGIDAS.includes(porta), 'PORTA_NAO_AUTORIZADA');
    return porta;
};

// A promessa original continua observada, mesmo apos timeout/cancelamento.
// O registro permite recusar descarte enquanto uma operacao ainda esta pendente.
export async function limitar(operacao, { ms, signal, pendentes = new Set(),
    codigo = 'OPERACAO_TIMEOUT', timers = { setTimeout, clearTimeout } } = {}) {
    exigir(Number.isFinite(ms) && ms > 0, 'PRAZO_INVALIDO');
    const controle = new AbortController();
    if (signal?.aborted) throw erroIsolamento('OPERACAO_CANCELADA');
    let timer, cancelar;
    const interrupcao = new Promise((_, reject) => {
        cancelar = () => { controle.abort(); reject(erroIsolamento('OPERACAO_CANCELADA')); };
        signal?.addEventListener('abort', cancelar, { once: true });
        timer = timers.setTimeout(() => { controle.abort(); reject(erroIsolamento(codigo)); }, ms);
    });
    const trabalho = Promise.resolve().then(() => {
        if (controle.signal.aborted) throw erroIsolamento('OPERACAO_CANCELADA');
        return operacao(controle.signal);
    });
    pendentes.add(trabalho);
    trabalho.then(() => pendentes.delete(trabalho), () => pendentes.delete(trabalho));
    try { return await Promise.race([trabalho, interrupcao]); }
    finally { timers.clearTimeout(timer); signal?.removeEventListener('abort', cancelar); }
}

export async function semLinks(alvo, { io = fs, uid = process.getuid?.() } = {}) {
    exigir(path.isAbsolute(alvo) && path.resolve(alvo) === alvo, 'CAMINHO_INVALIDO');
    let atual = path.parse(alvo).root;
    for (const parte of alvo.slice(atual.length).split(path.sep).filter(Boolean)) {
        atual = path.join(atual, parte);
        const s = await io.lstat(atual);
        exigir(s.isDirectory() && !s.isSymbolicLink() && [0, uid].includes(s.uid)
            && !(s.mode & 0o022), 'ANCESTRAL_INSEGURO');
    }
    exigir(await io.realpath(alvo) === alvo, 'CAMINHO_NAO_CANONICO');
}

export async function validarRaiz(raiz, { io = fs, uid = process.getuid?.() } = {}) {
    exigir(path.basename(raiz).startsWith('ist-real-pm2-'), 'RAIZ_INVALIDA');
    // /tmp pode ter sticky bit e modo 1777: verificar a raiz propria e sua
    // identidade canonica, sem tratar o temporario compartilhado como privado.
    const s = await io.lstat(raiz);
    exigir(s.isDirectory() && !s.isSymbolicLink() && s.uid === uid
        && (s.mode & 0o7777) === 0o700 && await io.realpath(raiz) === raiz, 'RAIZ_INSEGURA');
}

// Manifesto externo aprovado pelo operador (SHA-256 passado explicitamente).
// {version:1,node:'20.19.6',root,command,pm2Version,
//  files:[{path,sha256,mode}],links:[{path,target,resolved,uid,gid}]}
// Inventario integral, inclusive dependencias e launcher, sem node_modules ativo.
export async function validarInstalacao({ command, manifestPath, manifestSha256 },
    { io = fs, uid = process.getuid?.(), nodeVersion = process.versions.node } = {}) {
    exigir(nodeVersion === '20.19.6' && path.isAbsolute(command ?? '')
        && path.isAbsolute(manifestPath ?? '') && /^[a-f0-9]{64}$/.test(manifestSha256 ?? ''), 'PM2_APROVACAO_INVALIDA');
    const mst = await io.lstat(manifestPath);
    exigir(mst.isFile() && !mst.isSymbolicLink() && mst.nlink === 1 && [0, uid].includes(mst.uid)
        && !(mst.mode & 0o022), 'PM2_MANIFESTO_INSEGURO');
    await semLinks(path.dirname(manifestPath), { io, uid });
    const bytes = await io.readFile(manifestPath);
    exigir(sha(bytes) === manifestSha256, 'PM2_MANIFESTO_DIVERGENTE');
    let m; try { m = JSON.parse(bytes); } catch { throw erroIsolamento('PM2_MANIFESTO_INVALIDO'); }
    exigir(m?.version === 1 && m.node === nodeVersion && m.command === command
        && typeof m.pm2Version === 'string' && /^\d+\.\d+\.\d+$/.test(m.pm2Version)
        && path.isAbsolute(m.root ?? '') && path.resolve(m.root) === m.root
        && m.root !== path.parse(m.root).root && !m.root.split(path.sep).includes('.pm2')
        && !dentro('/var/www', m.root) && !dentro('/usr', m.root)
        && !dentro('/opt', m.root) && dentro(m.root, command)
        && !dentro(m.root, manifestPath)
        && Array.isArray(m.files) && m.files.length > 0
        && (m.links === undefined || Array.isArray(m.links)), 'PM2_INSTALACAO_INVALIDA');
    await semLinks(m.root, { io, uid });
    const raizCanonica = await io.realpath(m.root);
    const seen = new Set(), links = new Map();
    const validarAncestrais = async relativo => {
        let atual = m.root;
        for (const parte of relativo.split('/').slice(0, -1)) {
            atual = path.join(atual, parte);
            const s = await io.lstat(atual);
            exigir(s.isDirectory() && !s.isSymbolicLink() && [0, uid].includes(s.uid)
                && !(s.mode & 0o022), 'PM2_ANCESTRAL_INSEGURO');
        }
    };
    for (const e of m.files) {
        exigir(caminhoRelativoValido(e.path)
            && !seen.has(e.path) && /^[a-f0-9]{64}$/.test(e.sha256) && [0o644, 0o755].includes(e.mode), 'PM2_INVENTARIO_INVALIDO');
        seen.add(e.path);
        await validarAncestrais(e.path);
        const f = path.join(m.root, e.path), s = await io.lstat(f);
        exigir(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && [0, uid].includes(s.uid)
            && (s.mode & 0o7777) === e.mode && sha(await io.readFile(f)) === e.sha256, 'PM2_ARQUIVO_DIVERGENTE');
    }
    for (const e of m.links ?? []) {
        exigir(caminhoRelativoValido(e.path) && caminhoRelativoValido(e.resolved)
            && typeof e.target === 'string' && e.target && !path.isAbsolute(e.target)
            && Number.isSafeInteger(e.uid) && Number.isSafeInteger(e.gid)
            && !seen.has(e.path) && !links.has(e.path) && seen.has(e.resolved), 'PM2_LINK_INVENTARIO_INVALIDO');
        await validarAncestrais(e.path);
        const f = path.join(m.root, e.path), esperado = path.join(m.root, e.resolved);
        let s, alvoTextual, destino;
        try { s = await io.lstat(f); alvoTextual = await io.readlink(f); destino = await io.realpath(f); }
        catch { throw erroIsolamento('PM2_LINK_DIVERGENTE'); }
        // A igualdade lexical rejeita cadeias: o texto precisa apontar diretamente
        // ao arquivo regular inventariado, nao apenas terminar no mesmo realpath.
        const alvoLexico = path.resolve(path.dirname(f), alvoTextual);
        exigir(s.isSymbolicLink() && s.uid === e.uid && s.gid === e.gid && [0, uid].includes(s.uid)
            && alvoTextual === e.target && alvoLexico === esperado
            && contido(raizCanonica, destino) && destino === esperado, 'PM2_LINK_DIVERGENTE');
        const alvo = await io.lstat(esperado);
        exigir(alvo.isFile() && !alvo.isSymbolicLink() && alvo.nlink === 1, 'PM2_LINK_DESTINO_INVALIDO');
        links.set(e.path, e);
    }
    const actual = [], actualLinks = [];
    const visit = async dir => {
        for (const name of await io.readdir(dir)) {
            const f = path.join(dir, name), s = await io.lstat(f);
            const relativo = path.relative(m.root, f).split(path.sep).join('/');
            if (s.isSymbolicLink()) {
                exigir(links.has(relativo), 'PM2_LINK_NAO_INVENTARIADO');
                actualLinks.push(relativo); continue;
            }
            exigir([0, uid].includes(s.uid) && !(s.mode & 0o022), 'PM2_ARVORE_INSEGURA');
            if (s.isDirectory()) await visit(f); else actual.push(relativo);
        }
    };
    await visit(m.root);
    exigir(JSON.stringify(actual.sort()) === JSON.stringify([...seen].sort()), 'PM2_ARQUIVOS_ADICIONAIS');
    exigir(JSON.stringify(actualLinks.sort()) === JSON.stringify([...links.keys()].sort()), 'PM2_LINKS_DIVERGENTES');
    const launcher = m.files.find(e => path.join(m.root, e.path) === command);
    exigir(launcher?.mode === 0o755, 'PM2_LAUNCHER_INVALIDO');
    const packageEntry = m.files.find(e => e.path === 'node_modules/pm2/package.json');
    exigir(packageEntry, 'PM2_PACOTE_AUSENTE');
    const pkg = JSON.parse(await io.readFile(path.join(m.root, packageEntry.path)));
    exigir(pkg.name === 'pm2' && pkg.version === m.pm2Version, 'PM2_PACOTE_DIVERGENTE');
    return m;
}

export async function lerProcesso(pid, { io = fs } = {}) {
    exigir(Number.isSafeInteger(pid) && pid > 0, 'PID_INVALIDO');
    try {
        const base = `/proc/${pid}`, s = await io.stat(base), raw = await io.readFile(`${base}/stat`, 'utf8');
        const inicio = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
        exigir(/^\d+$/.test(inicio ?? ''), 'PROCESSO_INICIO_INVALIDO');
        const p = { pid, uid: s.uid, inicio, cwd: await io.readlink(`${base}/cwd`),
            exe: await io.readlink(`${base}/exe`), args: (await io.readFile(`${base}/cmdline`)).toString().split('\0').filter(Boolean) };
        const depois = await io.readFile(`${base}/stat`, 'utf8');
        exigir(depois.slice(depois.lastIndexOf(')') + 2).split(' ')[19] === inicio, 'PID_REUTILIZADO');
        return p;
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw erroIsolamento('PROCESSO_NAO_OBSERVAVEL'); }
}
export const mesmaIdentidade = (a, b) => !!a && !!b && a.pid === b.pid && a.uid === b.uid
    && a.inicio === b.inicio && a.exe === b.exe;
export function validarProcesso(p, { uid, exe, cwd, script, home } = {}) {
    exigir(p && p.uid === uid && p.exe === exe && (cwd === undefined || p.cwd === cwd)
        && (script === undefined || p.args.some(a => a.includes(script)))
        && (home === undefined || p.args.some(a => a.includes(home))), 'PROCESSO_IDENTIDADE_DIVERGENTE');
    return p;
}

export async function validarListener(p, porta, { io = fs } = {}) {
    validarPorta(porta);
    const sockets = new Set();
    for (const fd of await io.readdir(`/proc/${p.pid}/fd`)) {
        try { const m = /^socket:\[(\d+)\]$/.exec(await io.readlink(`/proc/${p.pid}/fd/${fd}`)); if (m) sockets.add(m[1]); }
        catch (e) { if (e.code !== 'ENOENT') throw erroIsolamento('LISTENER_NAO_OBSERVAVEL'); }
    }
    const alvo = `0100007F:${porta.toString(16).toUpperCase().padStart(4, '0')}`;
    const linhas = (await io.readFile(`/proc/${p.pid}/net/tcp`, 'utf8')).trim().split('\n').slice(1);
    exigir(linhas.some(l => { const c = l.trim().split(/\s+/); return c[1] === alvo && c[3] === '0A' && sockets.has(c[9]); }), 'LISTENER_NAO_PERTENCE_AO_TESTE');
}
export const validarProntidao = (r, { marker, cwd }) => {
    exigir(r && Object.keys(r).sort().join() === 'cwd,marker,pid,port' && r.marker === marker && r.cwd === cwd
        && Number.isSafeInteger(r.pid) && r.pid > 0, 'PRONTIDAO_INVALIDA'); validarPorta(r.port); return r;
};
export async function verificarHttp(r, { marker, cwd, signal, pendentes, fetcher = fetch, timers } = {}) {
    validarProntidao(r, { marker, cwd });
    return limitar(async cancelamento => {
        const response = await fetcher(`http://127.0.0.1:${r.port}/`, { signal: cancelamento, redirect: 'error' });
        exigir(response.status === 200 && !response.redirected, 'HTTP_STATUS_INVALIDO');
        const texto = await response.text();
        exigir(texto === JSON.stringify({ marker, cwd }), 'HTTP_IDENTIDADE_DIVERGENTE');
        return cwd;
    }, { ms: 2000, signal, pendentes, timers, codigo: 'HTTP_TIMEOUT' });
}

export async function executarComando(command, args, { env, signal, pendentes = new Set(), registrar = () => {},
    identificar = lerProcesso, spawn = execFile, timers } = {}) {
    return limitar(cancelamento => new Promise((resolve, reject) => {
        let child;
        child = spawn(command, args, { env, signal: cancelamento, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
            timeout: 10000, windowsHide: true }, (e, stdout) => {
            registrar({ tipo: e ? 'COMANDO_FALHOU' : 'COMANDO_CONCLUIDO', pid: child?.pid ?? null });
            if (e) reject(erroIsolamento('PM2_COMANDO_FALHOU')); else resolve({ stdout });
        });
        registrar({ tipo: 'COMANDO_INICIADO', pid: child.pid ?? null });
        if (child.pid) {
            const observacao = Promise.resolve().then(() => identificar(child.pid)).then(p => {
                if (p) registrar({ tipo: 'COMANDO_IDENTIFICADO', pid: p.pid, identidade: p });
            }).catch(() => registrar({ tipo: 'COMANDO_IDENTIDADE_INCERTA', pid: child.pid }));
            pendentes.add(observacao);
            observacao.then(() => pendentes.delete(observacao), () => pendentes.delete(observacao));
        }
        child.once('error', () => {}); // callback e promessa continuam observados.
    }), { ms: 10000, signal, pendentes, timers, codigo: 'PM2_COMANDO_TIMEOUT' });
}

export const podeRemover = ({ paradaConfirmada, processosRestantes, pendentes, incerto }) =>
    paradaConfirmada === true && processosRestantes === 0 && pendentes === 0 && incerto === false;

// Teardown usa um prazo proprio, independente do cancelamento funcional.
export async function limparIsolado({ parar, observar, remover, preservar, estado, timers } = {}) {
    try {
        await limitar(async signal => {
            await parar(signal);
            const restantes = await observar(signal);
            if (!podeRemover({ ...estado(), paradaConfirmada: true, processosRestantes: restantes }))
                throw erroIsolamento('LIMPEZA_NAO_COMPROVADA');
            if (signal.aborted) throw erroIsolamento('LIMPEZA_TIMEOUT');
            await remover();
        }, { ms: 30000, timers, codigo: 'LIMPEZA_TIMEOUT' });
        return { estado: 'CONCLUIDA' };
    } catch (e) {
        await preservar(e.code ?? 'LIMPEZA_NAO_COMPROVADA');
        return { estado: 'PARCIAL', codigo: e.code ?? 'LIMPEZA_NAO_COMPROVADA' };
    }
}
