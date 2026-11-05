import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codigoSeguro=v=>typeof v==='string'&&/^[A-Z0-9_]{1,64}$/.test(v)?v:'FALHA_INTERNA';

const carregarPadrao=async()=>{
    const [{pool},{criarLojaDownloadDireitosService}]=await Promise.all([
        import('../src/config/db.js'),import('../src/services/lojaDownloadDireitosService.js')
    ]);
    return {pool,criarLojaDownloadDireitosService};
};

// Importar este modulo nao abre banco nem executa reavaliacao. A rotina e
// sempre pontual, exige pedido explicito e nao chama o provider PayPal.
export const executarReavaliacaoDivergenciaFinanceira=async({argv=[],env={},carregar=carregarPadrao,
    saida=linha=>process.stdout.write(`${linha}\n`)}={})=>{
    let pool,pedidoPublicId=null;
    const emitir=v=>saida(JSON.stringify(v));
    try{
        const ambiente=argv[0]==='--autorizar-reavaliacao-divergencia-sandbox'?'sandbox'
            :argv[0]==='--autorizar-reavaliacao-divergencia-live'?'live':null;
        if(argv.length!==3||!ambiente||argv[1]!=='--pedido'||!uuid.test(argv[2]??''))throw Object.assign(Error(),{codigo:'SOLICITACAO_INVALIDA'});
        pedidoPublicId=argv[2];
        const banco=ambiente==='sandbox'?'istbrasil_homolog':'istbrasil',porta=ambiente==='sandbox'?'3307':'3306';
        if(env.NODE_ENV!=='production'||env.DB_HOST!=='127.0.0.1'||env.DB_PORT!==porta||env.DB_NAME!==banco
            ||env.LOJA_AMBIENTE!==ambiente||env.IST_LOJA_PAYPAL_ENV!==ambiente
            ||!/^[2-9A-HJ-NP-Z]{13}$/.test(env.IST_LOJA_PAYPAL_CONTA_RECEBEDORA??''))throw Object.assign(Error(),{codigo:'CONFIGURACAO_INVALIDA'});
        const d=await carregar();pool=d?.pool;
        if(!pool?.query||!pool?.getConnection||typeof d?.criarLojaDownloadDireitosService!=='function')throw Object.assign(Error(),{codigo:'CONFIGURACAO_INVALIDA'});
        const [[identidade]]=await pool.query('SELECT DATABASE() banco,@@port porta,VERSION() versao');
        if(identidade?.banco!==banco||Number(identidade?.porta)!==Number(porta)||!/^10\.3\.39-MariaDB/.test(identidade?.versao??''))throw Object.assign(Error(),{codigo:'BANCO_DIVERGENTE'});
        const [pedidos]=await pool.query(`SELECT id,estado,motivo_revisao FROM ist_loja_pedidos
            WHERE public_id=?`,[pedidoPublicId]);
        if(pedidos.length!==1||pedidos[0].estado!=='REVISAO'||pedidos[0].motivo_revisao!=='DIVERGENCIA_FINANCEIRA')throw Object.assign(Error(),{codigo:'PEDIDO_NAO_ELEGIVEL'});
        const contexto={provedor:'paypal',ambiente,contaRecebedora:env.IST_LOJA_PAYPAL_CONTA_RECEBEDORA};
        const r=await d.criarLojaDownloadDireitosService({db:pool}).reavaliarDireitosDoPedido(pedidos[0].id,contexto);
        emitir({pedidoPublicId,classificacao:r.avaliacao.classificacao,criterioExcepcional:r.avaliacao.criterioExcepcional??null,
            direitosAvaliados:r.direitos.length,direitosAtivados:r.transicoes.filter(x=>x.estado==='ATIVO').length,
            idempotente:r.transicoes.length===0});
        return r.avaliacao.elegivel&&r.avaliacao.criterioExcepcional==='DIVERGENCIA_FINANCEIRA_CAPTURA_COMPROVADA'?0:2;
    }catch(e){emitir({pedidoPublicId,estado:'FALHA',codigo:codigoSeguro(e?.codigo)});return 1;}
    finally{if(pool?.end)try{await pool.end();}catch{/* Processo administrativo pontual. */}}
};

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    process.exitCode=await executarReavaliacaoDivergenciaFinanceira({argv:process.argv.slice(2),env:process.env});
}
