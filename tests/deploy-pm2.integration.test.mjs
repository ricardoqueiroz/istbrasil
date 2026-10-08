import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPm2Adapter } from '../scripts/deploy/production-operation.mjs';

const execute = promisify(execFile);
const command = process.env.PM2_TEST_COMMAND;
const linux = { skip: process.platform !== 'linux' || process.getuid?.() === 0 || !command ? 'Real non-root PM2 test requires PM2_TEST_COMMAND' : false };

test('real PM2 adapter switches cwd/script and verifies HTTP health', linux, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ist-real-pm2-')), home = `${root}/pm2`, name = `ist-api-test-${process.pid}`;
    await fs.chmod(root, 0o700); await fs.mkdir(home, { mode: 0o700 });
    const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const source = `const http=require('node:http');http.createServer((q,r)=>{r.end(process.cwd())}).listen(${port},'127.0.0.1');`;
    for (const id of ['one', 'two']) { await fs.mkdir(`${root}/${id}`, { mode: 0o700 }); await fs.writeFile(`${root}/${id}/server.cjs`, source, { mode: 0o600 }); }
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, PM2_HOME: home, LANG: 'C', LC_ALL: 'C' };
    const run = args => execute(command, args, { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    t.after(async () => { try { await run(['delete', name]); } catch {} try { await run(['kill']); } catch {} await fs.rm(root, { recursive: true, force: true }); });
    await run(['start', `${root}/one/server.cjs`, '--name', name, '--cwd', `${root}/one`]);
    const health = async () => { const response = await fetch(`http://127.0.0.1:${port}/`); assert.equal(response.ok, true); return response.text(); };
    const adapter = createPm2Adapter({ pm2Home: home, name, health, command });
    assert.equal((await adapter.describe()).cwd, `${root}/one`);
    await adapter.switchTo({ cwd: `${root}/two`, script: `${root}/two/server.cjs` });
    assert.equal(await adapter.health(), `${root}/two`);
    const selected = await adapter.describe(); assert.equal(selected.cwd, `${root}/two`); assert.equal(selected.script, `${root}/two/server.cjs`);
});
