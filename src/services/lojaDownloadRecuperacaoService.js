import {criarOperacoesOtp} from './lojaDownloadRecuperacaoOtp.js';
import {randomBytes, randomUUID, createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {normalizarEmailComprador} from './lojaPedidoContratos.js';
import {avaliarElegibilidadeFinanceiraNaConexao} from './lojaDownloadFinanceiroService.js';

export const CONTRATO_RECUPERACAO = Object.freeze({desafioMs:900000, sessaoMs:86400000, maxTentativas:5, maxCandidatos:50});
const codigos = new Set(['CONFIGURACAO_INVALIDA','ENTRADA_INVALIDA','DESAFIO_INVALIDO','SESSAO_INVALIDA',
    'LIMITE_ESCOPO','SEM_DIREITOS_ELEGIVEIS','RECUPERACAO_INDISPONIVEL','RESULTADO_DESCONHECIDO']);
const falhar = codigo => {throw Object.assign(new Error(codigo), {codigo});};
const destruir = c => {try {c.destroy();} catch {}};
const uuid = v => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const tokenValido = v => typeof v==='string' && /^[A-Za-z0-9_-]{43}$/.test(v)
    && Buffer.from(v,'base64url').toString('base64url')===v;
const hash = (dominio, token) => createHash('sha256').update(`ist-loja/recuperacao/${dominio}/v1\0`)
    .update(Buffer.from(token,'base64url')).digest();
const utc = n => new Date(n).toISOString().slice(0,23).replace('T',' ');
const data = v => {
    if(typeof v!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}000Z$/.test(v))falhar('RECUPERACAO_INDISPONIVEL');
    const n=Date.parse(v);if(!Number.isFinite(n)||new Date(n).toISOString()!==v.slice(0,23)+'Z')falhar('RECUPERACAO_INDISPONIVEL');return n;
};
const instante = k => `DATE_FORMAT(${k},'%Y-%m-%dT%H:%i:%s.%fZ') AS ${k}`;
const campos = `id,public_id,desafio_hash,email_chave,email_normalizado,tentativas,${instante('criado_em')},
    ${instante('desafio_expira_em')},${instante('consumido_em')},sessao_hash,${instante('sessao_criada_em')},
    ${instante('sessao_expira_em')},${instante('revogada_em')}`;

/** Contrato interno. Sem pool padrao, dotenv, SMTP, HTTP, cookies ou PDFs.
 * O chamador futuro deve enviar o segredo somente ao email armazenado na criacao.
 * Consultar sessao retorna escopo, NAO autoriza download nem substitui a D6.
 */
export const criarLojaDownloadRecuperacaoService = ({db, chaveEmail, contextoEsperado, agora=()=>new Date(), otp}={}) => {
    if(!db?.getConnection || !Buffer.isBuffer(chaveEmail) || chaveEmail.length!==32 || typeof agora!=='function'
       || contextoEsperado?.provedor!=='paypal' || !['sandbox','live'].includes(contextoEsperado.ambiente)
       || typeof contextoEsperado.contaRecebedora!=='string' || !/^[A-Za-z0-9-]{1,128}$/.test(contextoEsperado.contaRecebedora))falhar('CONFIGURACAO_INVALIDA');
    if(otp&&[otp.chaveCodigo,otp.chaveLimites].some(k=>Buffer.isBuffer(k)&&k.equals(chaveEmail)))falhar('CONFIGURACAO_INVALIDA');
    const chave=Buffer.from(chaveEmail), financeiro=Object.freeze({provedor:'paypal',
        ambiente:contextoEsperado.ambiente,contaRecebedora:contextoEsperado.contaRecebedora});
    const tempo=()=>{
        const d=agora();if(!(d instanceof Date)||!Number.isFinite(d.getTime())||d.getUTCFullYear()<1000||d.getUTCFullYear()>9998)falhar('RECUPERACAO_INDISPONIVEL');
        return d.getTime();
    };
    const emailChave=email=>createHmac('sha256',chave).update('ist-loja/recuperacao/email/v1\0').update(email).digest();
    const transacao=async operar=>{
        let c, iniciou=false, commit=false;
        try {
            c=await db.getConnection();
            const [[s]]=await c.query('SELECT @@in_transaction tx,@@autocommit ac');
            if(Number(s?.tx)!==0||Number(s?.ac)!==1)falhar('RECUPERACAO_INDISPONIVEL');
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await c.beginTransaction();iniciou=true;
            const resultado=await operar(c);
            commit=true;await c.commit();iniciou=false;
            // Tokens so saem desta fachada apos ACK do COMMIT. Sem retry/replay cego.
            return resultado;
        } catch(e) {
            if(c&&commit){destruir(c);c=null;falhar('RESULTADO_DESCONHECIDO');}
            if(c&&iniciou)try {await c.rollback();}catch {destruir(c);c=null;falhar('RESULTADO_DESCONHECIDO');}
            else if(c){destruir(c);c=null;}
            falhar(codigos.has(e?.codigo)?e.codigo:'RECUPERACAO_INDISPONIVEL');
        } finally {c?.release();}
    };
    const escrever=async(c,sql,p)=>{const [r]=await c.query(sql,p);if(r.affectedRows!==1||r.warningStatus)falhar('RECUPERACAO_INDISPONIVEL');};
    const criarDesafio=async email=>{
        try {email=normalizarEmailComprador(email);} catch {falhar('ENTRADA_INVALIDA');}
        const segredo=randomBytes(32).toString('base64url'),publicId=randomUUID();
        return transacao(async c=>{
            const n=tempo();
            await escrever(c,`INSERT INTO ist_loja_download_recuperacoes
                (public_id,desafio_hash,email_chave,email_normalizado,criado_em,desafio_expira_em,tipo)
                VALUES(?,?,?,?,?,?,'LINK')`,[publicId,hash('desafio',segredo),emailChave(email),email,utc(n),utc(n+CONTRATO_RECUPERACAO.desafioMs)]);
            return {publicId,segredo,expiraEm:new Date(n+CONTRATO_RECUPERACAO.desafioMs).toISOString()};
        });
    };
    const candidatos=async(c,email,pedidoId=null)=>{
        const [rows]=await c.query(`SELECT d.id,d.pedido_item_id,d.produto_id,d.arquivo_versao_id,p.id pedido_id,p.sessao_id
            FROM ist_loja_pedidos p JOIN ist_loja_pedido_itens i ON i.pedido_id=p.id
            JOIN ist_loja_download_direitos d ON d.pedido_item_id=i.id AND d.produto_id=i.produto_id
            WHERE p.comprador_email=? AND BINARY p.comprador_email=BINARY ? AND p.ambiente=?
              AND (? IS NULL OR p.id=?) AND d.estado IN ('ATIVO','AGUARDANDO_CONFIRMACAO') ORDER BY p.sessao_id,p.id,d.id LIMIT 51`,
        [email,email,financeiro.ambiente,pedidoId,pedidoId]);
        if(rows.length>CONTRATO_RECUPERACAO.maxCandidatos)falhar('LIMITE_ESCOPO');
        return rows;
    };
    const fixarEscopo=async(c,r,persistir=true)=>{
        const email=normalizarEmailComprador(r.email_normalizado);
        if(email!==r.email_normalizado||!Buffer.isBuffer(r.email_chave)||!timingSafeEqual(r.email_chave,emailChave(email)))falhar('RECUPERACAO_INDISPONIVEL');
        const descobertos=await candidatos(c,email,r.pedido_id??null),sessoes=[...new Set(descobertos.map(d=>d.sessao_id))].sort((a,b)=>a-b);
        // Recuperacao -> TODAS as sessoes em ordem -> pedidos em ordem ->
        // pagamentos -> operacoes -> eventos -> direitos. Sem inversao da D6.
        for(const id of sessoes){
            const [[s]]=await c.query('SELECT id FROM ist_loja_sessoes WHERE id=? FOR UPDATE',[id]);
            if(!s)falhar('RECUPERACAO_INDISPONIVEL');
        }
        const pedidos=[...new Set(descobertos.map(d=>d.pedido_id))].sort((a,b)=>a-b);
        for(const id of pedidos){
            const [[p]]=await c.query('SELECT id,sessao_id,comprador_email,ambiente FROM ist_loja_pedidos WHERE id=? FOR UPDATE',[id]);
            if(!p||p.comprador_email!==email||p.ambiente!==financeiro.ambiente
               ||descobertos.some(d=>d.pedido_id===id&&d.sessao_id!==p.sessao_id))falhar('RECUPERACAO_INDISPONIVEL');
        }
        const escopo=[];
        for(const id of pedidos){
            await c.query('SELECT id FROM ist_loja_pagamentos WHERE pedido_id=? ORDER BY id FOR UPDATE',[id]);
            await c.query('SELECT id FROM ist_loja_pagamento_operacoes WHERE pedido_id=? ORDER BY id FOR UPDATE',[id]);
            const [evs]=await c.query(`SELECT e.id FROM ist_loja_pagamento_eventos e JOIN ist_loja_pagamentos pg ON pg.id=e.pagamento_id
                WHERE pg.pedido_id=? ORDER BY e.id`,[id]);
            for(const e of evs)await c.query('SELECT id FROM ist_loja_pagamento_eventos WHERE id=? FOR UPDATE',[e.id]);
            const [ds]=await c.query(`SELECT d.id FROM ist_loja_download_direitos d JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id
                WHERE i.pedido_id=? ORDER BY d.id`,[id]);
            for(const d of ds)await c.query('SELECT id FROM ist_loja_download_direitos WHERE id=? FOR UPDATE',[d.id]);
            let erroSql;
            const a=await avaliarElegibilidadeFinanceiraNaConexao({query:async(...args)=>{
                try{return await c.query(...args);}catch(e){erroSql=e;throw e;}
            }},id,financeiro);
            if(erroSql)throw erroSql; // Avaliador sanitiza SQL; falha tecnica NAO e ausencia de direitos.
            if(a.classificacao!=='ELEGIVEL'||a.elegivel!==true)continue;
            for(const d of descobertos.filter(d=>d.pedido_id===id)){
                const ref=a.referencias?.direitos.find(x=>x.id===d.id);
                if(!ref||ref.itemId!==d.pedido_item_id||ref.produtoId!==d.produto_id||ref.arquivoVersaoId!==d.arquivo_versao_id
                   ||!['ATIVO','AGUARDANDO_CONFIRMACAO'].includes(ref.estado))falhar('RECUPERACAO_INDISPONIVEL');
                escopo.push({direitoId:d.id,arquivoVersaoId:d.arquivo_versao_id});
            }
        }
        // Snapshot fechado nesta validacao; compras posteriores nao ampliam o escopo.
        if(JSON.stringify(await candidatos(c,email,r.pedido_id??null))!==JSON.stringify(descobertos))falhar('RECUPERACAO_INDISPONIVEL');
        if(!escopo.length)falhar('SEM_DIREITOS_ELEGIVEIS');
        if(persistir)for(const d of escopo)await escrever(c,`INSERT INTO ist_loja_download_recuperacao_direitos
            (recuperacao_id,direito_id,arquivo_versao_id) VALUES(?,?,?)`,[r.id,d.direitoId,d.arquivoVersaoId]);
        return escopo;
    };
    const emitirSessao=async(c,r,n,expira)=>{
        const direitos=await fixarEscopo(c,r),fim=tempo();
        if(fim<n||fim>=expira)falhar('DESAFIO_INVALIDO');
        const token=randomBytes(32).toString('base64url');
        await escrever(c,`UPDATE ist_loja_download_recuperacoes SET consumido_em=?,email_normalizado=NULL,
            sessao_hash=?,sessao_criada_em=?,sessao_expira_em=? WHERE id=? AND consumido_em IS NULL AND tentativas<5 AND invalidado_em IS NULL`,
        [utc(fim),hash('sessao',token),utc(fim),utc(fim+CONTRATO_RECUPERACAO.sessaoMs),r.id]);
        return {token,sessao:{publicId:r.public_id,criadaEm:new Date(fim).toISOString(),
            expiraEm:new Date(fim+CONTRATO_RECUPERACAO.sessaoMs).toISOString(),direitos}};
    };
    const consumirDesafio=async(publicId,segredo)=>{
        if(!uuid(publicId))falhar('DESAFIO_INVALIDO');
        const resultado=await transacao(async c=>{
            const [[r]]=await c.query(`SELECT ${campos} FROM ist_loja_download_recuperacoes WHERE public_id=? AND BINARY tipo=BINARY 'LINK' FOR UPDATE`,[publicId]);
            if(!r)return null;
            const n=tempo(),criado=data(r.criado_em),expira=data(r.desafio_expira_em);
            if(r.consumido_em!==null||r.tentativas>=5||n<criado||n>=expira||expira-criado!==CONTRATO_RECUPERACAO.desafioMs)return null;
            if(!tokenValido(segredo)||!Buffer.isBuffer(r.desafio_hash)||!timingSafeEqual(r.desafio_hash,hash('desafio',segredo))){
                await escrever(c,"UPDATE ist_loja_download_recuperacoes SET tentativas=tentativas+1 WHERE id=? AND tipo='LINK' AND tentativas<5 AND consumido_em IS NULL",[r.id]);
                return null; // Commit da tentativa ANTES do erro publico; nunca rollback do contador.
            }
            return emitirSessao(c,r,n,expira);
        });
        if(!resultado)falhar('DESAFIO_INVALIDO');return resultado;
    };
    const sessaoValida=(r,n)=>r&&r.consumido_em!==null&&r.revogada_em===null&&r.sessao_criada_em!==null&&r.sessao_expira_em!==null
        &&data(r.sessao_criada_em)<=n&&data(r.sessao_expira_em)>n
        &&data(r.sessao_expira_em)-data(r.sessao_criada_em)<=CONTRATO_RECUPERACAO.sessaoMs;
    const obterSessao=async token=>{
        if(!tokenValido(token))falhar('SESSAO_INVALIDA');
        return transacao(async c=>{
            const [[r]]=await c.query(`SELECT ${campos} FROM ist_loja_download_recuperacoes WHERE sessao_hash=? FOR UPDATE`,[hash('sessao',token)]);
            if(!sessaoValida(r,tempo()))falhar('SESSAO_INVALIDA');
            const [ds]=await c.query(`SELECT direito_id direitoId,arquivo_versao_id arquivoVersaoId
                FROM ist_loja_download_recuperacao_direitos WHERE recuperacao_id=? ORDER BY direito_id LIMIT 51`,[r.id]);
            if(!ds.length||ds.length>50)falhar('SESSAO_INVALIDA');
            if(!sessaoValida(r,tempo()))falhar('SESSAO_INVALIDA');
            return {publicId:r.public_id,criadaEm:new Date(data(r.sessao_criada_em)).toISOString(),
                expiraEm:new Date(data(r.sessao_expira_em)).toISOString(),direitos:ds};
        });
    };
    const revogarSessao=async token=>{
        if(!tokenValido(token))falhar('SESSAO_INVALIDA');
        return transacao(async c=>{
            const [[r]]=await c.query(`SELECT ${campos} FROM ist_loja_download_recuperacoes WHERE sessao_hash=? FOR UPDATE`,[hash('sessao',token)]);
            if(!r||r.revogada_em!==null)return {revogada:false};
            const n=tempo();if(n<data(r.sessao_criada_em))falhar('SESSAO_INVALIDA');
            await escrever(c,'UPDATE ist_loja_download_recuperacoes SET revogada_em=? WHERE id=? AND revogada_em IS NULL',[utc(n),r.id]);
            return {revogada:true};
        });
    };
    return Object.freeze({criarDesafio,consumirDesafio,obterSessao,revogarSessao,
        ...(otp?criarOperacoesOtp({config:otp,financeiro,transacao,escrever,fixarEscopo,emitirSessao,tempo,emailChave}):{})});
};
