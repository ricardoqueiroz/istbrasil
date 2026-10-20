// Instrumentacao exclusiva de teste: nunca registrar message, SQL, parametros,
// config do pool, threadId fisico, stack bruto ou causa aninhada.
export const criarDiagnosticoFinanceiroTeste=({db,registrar,obterCaso=()=>''})=>{
    let conexoes=0,transacoes=0,operacoes=0,tentativa=0,maxAtivas=0;
    const ativas=new Set(),falhas=[];
    const texto=(v,regex,fallback=null)=>typeof v==='string'&&regex.test(v)?v:fallback;
    const diagnosticar=async(e,etapa,c,estado={})=>{
        const conexao=c?.connection??c;
        let sql=null;
        if(c&&!conexao?._closing&&!conexao?._fatalError)try{
            const [[r]]=await c.query('SELECT @@in_transaction transacao,@@autocommit autocommit,@@tx_isolation isolamento');
            sql={transacao:Number(r.transacao),autocommit:Number(r.autocommit),isolamento:texto(r.isolamento,/^[A-Z-]{1,32}$/)};
        }catch{}
        const codigo=texto(e?.code,/^[A-Z0-9_]{1,64}$/),errno=Number.isInteger(e?.errno)?e.errno:null;
        const r={caso:obterCaso(),etapa,tipo:texto(e?.name,/^[A-Za-z]{1,32}$/,'Error'),codigo,
            codigoPublico:texto(e?.codigo,/^[A-Z0-9_]{1,64}$/),sqlstate:texto(e?.sqlState,/^[A-Z0-9]{5}$/),errno,
            deadlock:errno===1213||codigo==='ER_LOCK_DEADLOCK',lockWaitTimeout:errno===1205||codigo==='ER_LOCK_WAIT_TIMEOUT',
            conexaoEncerrada:Boolean(conexao?._closing||conexao?._fatalError||['PROTOCOL_CONNECTION_LOST','ECONNRESET','EPIPE'].includes(codigo)),
            operacao:`O${operacoes}`,tentativa,...estado,sql};
        falhas.push(r);registrar('F2_DIAGNOSTICO='+JSON.stringify(r));
    };
    const etapaSql=sql=>typeof sql!=='string'?'CONSULTA':sql.startsWith('SET TRANSACTION')?'ISOLAMENTO'
        :sql.startsWith('UPDATE ist_loja_download_direitos')?'UPDATE_DIREITO'
        :sql.startsWith('INSERT INTO ist_loja_download_direito_eventos')?'INSERT_EVENTO'
        :/FOR UPDATE/.test(sql)?'SELECT_LOCK':'SELECT';
    const banco={async getConnection(){
        let c;const logica=`C${++conexoes}`;
        try{c=await db.getConnection();}catch(e){await diagnosticar(e,'ADQUIRIR_CONEXAO',null,{conexao:logica});throw e;}
        const estado={conexao:logica,transacaoLogica:null,emTransacaoObservada:false};
        const executar=async(etapa,fn)=>{try{return await fn();}catch(e){await diagnosticar(e,etapa,c,estado);throw e;}};
        return {
            query:(sql,...p)=>executar(etapaSql(sql),()=>c.query(sql,...p)),
            execute:(sql,...p)=>executar(etapaSql(sql),()=>c.execute(sql,...p)),
            beginTransaction:async()=>{
                tentativa++;estado.transacaoLogica=`T${++transacoes}`;
                await executar('BEGIN',()=>c.beginTransaction());estado.emTransacaoObservada=true;ativas.add(logica);maxAtivas=Math.max(maxAtivas,ativas.size);
            },
            commit:async()=>{await executar('COMMIT',()=>c.commit());estado.emTransacaoObservada=false;ativas.delete(logica);},
            rollback:async()=>{await executar('ROLLBACK',()=>c.rollback());estado.emTransacaoObservada=false;ativas.delete(logica);},
            release:()=>c.release(),destroy:()=>{ativas.delete(logica);c.destroy();}
        };
    }};
    return {db:banco,iniciarOperacao(){operacoes++;tentativa=0;},
        registrarErroFacade:e=>diagnosticar(e,'FACHADA',null),
        resumo:()=>({conexoesAdquiridas:conexoes,transacoesIniciadas:transacoes,maxAtivas,ativasFinais:ativas.size,falhas:falhas.length})};
};
