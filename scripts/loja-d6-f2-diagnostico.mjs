import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Mesmo conjunto amplo da D6-B4-R; apenas concorrencia de arquivos varia.
const amplos=['lojaCatalogoService.test.js','lojaCatalogoTransacional.test.js','lojaCatalogoHttp.test.js','bookController.test.js',
    'lojaCatalogoR33.integration.test.js','lojaPedidoContratos.test.js','lojaPedidoService.test.js','lojaPedidoHttp.test.js',
    'lojaSessaoService.test.js','lojaSessaoHttp.test.js','lojaCheckout.test.js','lojaPagamentoContratos.test.js',
    'lojaPagamentoService.integration.test.js','lojaPagamentoAgendador.test.js','paypalProvider.test.js','lojaPaypalWebhook.test.js',
    'serverComposicao.test.js','lojaArquivoService.test.js','lojaPedidoDireitos.integration.test.js','lojaDownloadFinanceiroService.test.js',
    'lojaDownloadDireitosService.test.js','lojaDownloadHomologacao.integration.test.js','lojaDownloadAutorizacaoService.test.js',
    'lojaDownloadArquivoService.test.js','lojaDownloadsHttp.test.js','lojaDownloadsHttp.integration.test.js','lojaArquivosConfiguracao.test.js',
    'lojaDownloadsRaizPublica.audit.test.js','lojaImagensPublicas.audit.test.js','lojaDownloadPercursoHttp.integration.test.js'];
const direcionados=['lojaDownloadHomologacao.integration.test.js','lojaDownloadDireitosService.test.js',
    'lojaDownloadAutorizacaoService.test.js','lojaDownloadPercursoHttp.integration.test.js'];
const modo=process.argv[2];
if(!['b','c','d'].includes(modo)||!process.env.IST_LOJA_PAGAMENTOS_MARIADB_BIN||process.env.IST_R2_10339_MANIFEST)
    throw Error('Selecionar b/c/d com fixture MariaDB 13 explicitamente habilitada, sem manifesto 10.3.');
const arquivos=(modo==='d'?direcionados:amplos).map(p=>'tests/'+p),concorrencia=modo==='b'?1:2;
const args=['--test','--test-reporter=spec',`--test-concurrency=${concorrencia}`,...arquivos];
const inicio=Date.now();let bruto='',truncado=false;
const filho=spawn(process.execPath,args,{cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,
    env:{...process.env,NODE_ENV:'test',IST_D6_F2_REPETICOES:'1'},stdio:['ignore','pipe','pipe']});
const receber=b=>{if(bruto.length<16*1024*1024)bruto+=b.toString('utf8');else truncado=true;};
filho.stdout.on('data',receber);filho.stderr.on('data',receber);
filho.on('error',()=>{throw Error('EXECUTOR_INDISPONIVEL');});
filho.on('exit',async(codigo,sinal)=>{
    const limpo=bruto.replace(/\u001b\[[0-9;]*m/g,'');
    const numero=nome=>{const ms=[...limpo.matchAll(new RegExp(`(?:ℹ|#) ${nome} (\\d+(?:\\.\\d+)?)`,'g'))];return ms.length?Number(ms.at(-1)[1]):null;};
    const registros=prefixo=>[...limpo.matchAll(new RegExp(prefixo+'(\\{[^\\r\\n]+\\})','g'))].map(m=>JSON.parse(m[1]));
    const diagnosticos=registros('F2_DIAGNOSTICO='),falhas=[...new Set(diagnosticos.map(x=>JSON.stringify(x)))].map(x=>JSON.parse(x));
    const resultado={cenario:modo.toUpperCase(),concorrencia,arquivos,exitCode:codigo,sinal,duracaoMs:Date.now()-inicio,
        tests:numero('tests'),pass:numero('pass'),fail:numero('fail'),skipped:numero('skipped'),
        disputasAprovadas:(limpo.match(/✔ direito ATIVO diante de disputa fica bloqueado/g)??[]).length,
        disputaFalhou:/✖ direito ATIVO diante de disputa fica bloqueado/.test(limpo),ambientes:registros('F2_AMBIENTE='),
        pools:registros('F2_POOL='),diagnosticos:falhas,
        testesFalhos:[...new Set(limpo.split('\n').filter(l=>/^\s*✖ /.test(l)).map(l=>l.replace(/^\s*✖ /,'').replace(/ \([\d.]+ms\)$/,'')))],
        saidaTruncada:truncado};
    const destino=new URL(`../docs/loja-d6-f2-resultado-${modo}.json`,import.meta.url);
    await writeFile(destino,JSON.stringify(resultado,null,2)+'\n');
    console.log(JSON.stringify(resultado,null,2));process.exitCode=codigo??1;
});
