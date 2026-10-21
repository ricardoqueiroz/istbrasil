import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
const esperar=ms=>new Promise(r=>setTimeout(r,ms));
export async function criarNavegadorSintetico(t){
    const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';await access(chrome);
    const perfil=await mkdtemp(path.join(tmpdir(),'ist-d74-chrome-')),downloads=path.join(perfil,'downloads');await mkdir(downloads);
    const filho=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
        '--ignore-certificate-errors','--disable-background-networking','--disable-component-update','--disable-sync',
        '--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
        '--user-data-dir='+perfil,'about:blank'],{windowsHide:true,stdio:'ignore'});
    let ws,seq=0;const pendentes=new Map(),eventos=[];
    const limpar=async()=>{
        try{if(ws?.readyState===WebSocket.OPEN)await chamar('Browser.close');}catch{}
        ws?.close();
        if(filho.exitCode===null)await Promise.race([new Promise(r=>filho.once('exit',r)),esperar(5000)]);
        if(filho.exitCode===null)filho.kill();
        assert.equal(path.dirname(path.resolve(perfil)),path.resolve(tmpdir()));assert(path.basename(perfil).startsWith('ist-d74-chrome-'));
        await rm(perfil,{recursive:true,force:true,maxRetries:5,retryDelay:200});
    };
    t.after(limpar);
    let endpoint;
    for(let n=0;n<100;n++){try{const [porta,rota]=(await readFile(path.join(perfil,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);endpoint=`ws://127.0.0.1:${porta}${rota}`;break;}catch{await esperar(100);}}
    assert(endpoint,'Chrome de teste nao iniciou; nao usar navegador pessoal.');
    ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
    ws.on('message',bytes=>{
        const m=JSON.parse(bytes);
        if(m.id){const p=pendentes.get(m.id);if(p){clearTimeout(p.timer);pendentes.delete(m.id);m.error?p.reject(Error('CDP_COMANDO_FALHOU')):p.resolve(m.result);}}
        else{
            eventos.push(m);
            if(m.method==='Fetch.requestPaused'){
                const u=m.params.request.url,permitido=u.startsWith('https://localhost:13381/')||u==='https://localhost:13381'||u.startsWith('blob:https://localhost:13381/');
                void chamar(permitido?'Fetch.continueRequest':'Fetch.failRequest',permitido?{requestId:m.params.requestId}:{requestId:m.params.requestId,errorReason:'BlockedByClient'},m.sessionId).catch(()=>{});
            }
        }
    });
    function chamar(method,params={},sessionId){return new Promise((resolve,reject)=>{
        const id=++seq,timer=setTimeout(()=>{pendentes.delete(id);reject(Error('CDP_TIMEOUT_'+method));},10000);
        pendentes.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });}
    const pagina=async()=>{
        const {browserContextId}=await chamar('Target.createBrowserContext');
        await chamar('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,browserContextId,eventsEnabled:true});
        const {targetId}=await chamar('Target.createTarget',{url:'about:blank',browserContextId});
        const {sessionId}=await chamar('Target.attachToTarget',{targetId,flatten:true});
        await chamar('Page.enable',{},sessionId);await chamar('Network.enable',{},sessionId);
        await chamar('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},sessionId);
        const avaliar=async expression=>{
            const r=await chamar('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
            if(r.exceptionDetails)throw Error('EXPRESSAO_NAVEGADOR_FALHOU');return r.result?.value;
        };
        const aguardar=async(expr)=>{for(let n=0;n<150;n++){try{if(await avaliar(expr))return;}catch{}await esperar(100);}throw Error('UI_CONDICAO_NAO_ATINGIDA');};
        const navegar=async rota=>{await chamar('Page.navigate',{url:'https://localhost:13381'+rota},sessionId);};
        const clicar=async texto=>avaliar(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(texto)});if(!b||b.disabled)throw Error();b.click();return true;})()`);
        return{sessionId,browserContextId,avaliar,aguardar,navegar,clicar,chamar:(m,p)=>chamar(m,p,sessionId)};
    };
    return{pagina,eventos,downloads,chamar};
}
