import {createHmac,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {normalizarEmailComprador} from './lojaPedidoContratos.js';

export const CONTRATO_OTP=Object.freeze({validadeMs:600000,janelaMs:600000,cooldownMs:60000,
    maxEmissoes:3,maxSolicitacoesIp:20,maxFalhas:5,retencaoMs:604800000,versao:1});
const falhar=codigo=>{throw Object.assign(new Error(codigo),{codigo});};
const utc=n=>new Date(n).toISOString().slice(0,23).replace('T',' ');
const instante=k=>`DATE_FORMAT(${k},'%Y-%m-%dT%H:%i:%s.%fZ') ${k}`;
const ler=v=>v===null?null:Date.parse(v.includes('T')?v:v.replace(' ','T')+'Z');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const igual=(a,b)=>Buffer.isBuffer(a)&&Buffer.isBuffer(b)&&a.length===b.length&&timingSafeEqual(a,b);
const resposta=()=>({aceito:true});

/** Componente interno da fachada de recuperacao. Nao conhece SMTP, HTTP ou cookies.
 * `entrega` contem segredo em memoria: nunca serializar/logar este envelope em HTTP.
 * IP deve vir exclusivamente da infraestrutura confiavel, nunca de body/XFF arbitrario.
 */
export const criarOperacoesOtp=({config,financeiro,transacao,escrever,fixarEscopo,emitirSessao,tempo,emailChave})=>{
    const {chaveCodigo,chaveLimites,sortearCodigo=randomInt}=config;
    if(![chaveCodigo,chaveLimites].every(k=>Buffer.isBuffer(k)&&k.length===32)
       ||igual(chaveCodigo,chaveLimites)||typeof sortearCodigo!=='function')falhar('CONFIGURACAO_INVALIDA');
    const codigoKey=Buffer.from(chaveCodigo),limitesKey=Buffer.from(chaveLimites);
    const contexto=[financeiro.provedor,financeiro.ambiente,financeiro.contaRecebedora];
    const mac=(key,dominio,partes)=>createHmac('sha256',key).update(`ist-loja/recuperacao/otp/${dominio}/v1\0`)
        .update(JSON.stringify([...contexto,...partes])).digest();
    const hashCodigo=(publicId,pedidoId,emailHash,codigo)=>mac(codigoKey,'codigo',[publicId,pedidoId,emailHash.toString('hex'),codigo]);
    const entrada=valor=>{
        const {email,pedidoPublicId,ip}=valor??{};
        if(typeof ip!=='string'||!isIP(ip))falhar('ENTRADA_INVALIDA');
        // URL canonicaliza representacoes IPv6 equivalentes; nao muda politica de proxy.
        const canon=isIP(ip)===6?new URL(`http://[${ip}]/`).hostname:ip;
        let normalizado=null;try{normalizado=normalizarEmailComprador(email);}catch{}
        const pedido=uuid(pedidoPublicId)?pedidoPublicId:null;
        // Entradas malformadas compartilham um bucket limitado, sem guardar valores brutos.
        const par=[normalizado??'INVALIDO',pedido??'INVALIDO'];
        return {email:normalizado,pedidoPublicId:pedido,ip:canon,par};
    };
    const associacao=async(c,e)=>{
        if(!e.email||!e.pedidoPublicId)return null;
        const [[p]]=await c.query(`SELECT id FROM ist_loja_pedidos WHERE public_id=?
            AND BINARY comprador_email=BINARY ? AND ambiente=?`,[e.pedidoPublicId,e.email,financeiro.ambiente]);
        return p??null;
    };
    const bloquearLimites=async(c,e,p)=>{
        const chaves=[['IP',[e.ip]],['TITULAR',e.par],...(p?[['PEDIDO',[e.pedidoPublicId]]]:[])]
            .map(([escopo,partes])=>({escopo,hash:mac(limitesKey,`limite/${escopo}`,partes)}))
            .sort((a,b)=>Buffer.compare(Buffer.from(a.escopo),Buffer.from(b.escopo)));
        const linhas=[];
        for(const k of chaves){
            const n=tempo(),fim=n+CONTRATO_OTP.janelaMs;
            // UPSERT sem mudar contadores; serializa tambem a criacao de buckets ausentes.
            await c.query(`INSERT INTO ist_loja_download_recuperacao_limites
                (escopo,versao_chave,chave_hash,janela_inicio,janela_fim,atualizado_em,retencao_ate)
                VALUES(?,1,?,?,?,?,?) ON DUPLICATE KEY UPDATE versao_chave=versao_chave`,
            [k.escopo,k.hash,utc(n),utc(fim),utc(n),utc(fim+CONTRATO_OTP.retencaoMs)]);
            const [[r]]=await c.query(`SELECT solicitacoes,falhas,${instante('janela_inicio')},${instante('janela_fim')},
                ${instante('reenvio_permitido_em')},${instante('bloqueado_ate')},${instante('atualizado_em')}
                FROM ist_loja_download_recuperacao_limites WHERE escopo=? AND versao_chave=1 AND chave_hash=? FOR UPDATE`,[k.escopo,k.hash]);
            if(n<ler(r.atualizado_em))falhar('RECUPERACAO_INDISPONIVEL');
            if(n>=ler(r.janela_fim)&&n>=(ler(r.bloqueado_ate)??0)){
                r.solicitacoes=0;r.falhas=0;r.janela_inicio=utc(n);r.janela_fim=utc(fim);r.bloqueado_ate=null;
                // Cooldown nunca e reiniciado pela troca de janela.
            }
            linhas.push({...k,...r});
        }
        return linhas;
    };
    const salvarLimites=async(c,linhas)=>{
        const n=tempo();
        for(const r of linhas){
            const reter=Math.max(n,ler(r.janela_fim),ler(r.reenvio_permitido_em)??0,ler(r.bloqueado_ate)??0)+CONTRATO_OTP.retencaoMs;
            await escrever(c,`UPDATE ist_loja_download_recuperacao_limites SET solicitacoes=?,falhas=?,janela_inicio=?,janela_fim=?,
                reenvio_permitido_em=?,bloqueado_ate=?,atualizado_em=?,retencao_ate=? WHERE escopo=? AND versao_chave=1 AND chave_hash=?`,
            [r.solicitacoes,r.falhas,utc(ler(r.janela_inicio)),utc(ler(r.janela_fim)),
                r.reenvio_permitido_em===null?null:utc(ler(r.reenvio_permitido_em)),
                r.bloqueado_ate===null?null:utc(ler(r.bloqueado_ate)),utc(n),utc(reter),r.escopo,r.hash]);
        }
    };
    const permitido=(linhas,emissao)=>{
        const n=tempo();
        return linhas.every(r=>(ler(r.bloqueado_ate)??0)<=n
            &&(r.escopo==='IP'?r.solicitacoes<CONTRATO_OTP.maxSolicitacoesIp:r.falhas<CONTRATO_OTP.maxFalhas)
            &&(!emissao||r.escopo==='IP'||(r.solicitacoes<CONTRATO_OTP.maxEmissoes&&(ler(r.reenvio_permitido_em)??0)<=n)));
    };
    const registrarConsulta=linhas=>{const ip=linhas.find(r=>r.escopo==='IP');if(ip.solicitacoes<4294967295)ip.solicitacoes++;};
    const solicitarCodigo=async(valor,{prepararEntrega}={})=>{
        if(prepararEntrega!==undefined&&typeof prepararEntrega!=='function')falhar('CONFIGURACAO_INVALIDA');
        const e=entrada(valor),publicId=randomUUID();
        const entrega=await transacao(async c=>{
            const p=await associacao(c,e),linhas=await bloquearLimites(c,e,p);
            const ok=permitido(linhas,true);registrarConsulta(linhas);
            // Contabiliza inclusive pares inexistentes; so PEDIDO associado pode ser alterado.
            if(ok)for(const r of linhas.filter(x=>x.escopo!=='IP')){
                r.solicitacoes++;r.reenvio_permitido_em=utc(tempo()+CONTRATO_OTP.cooldownMs);
            }
            await salvarLimites(c,linhas);
            if(!ok||!p)return null;
            const [abertos]=await c.query(`SELECT id FROM ist_loja_download_recuperacoes
                WHERE tipo='OTP' AND pedido_id=? AND consumido_em IS NULL AND invalidado_em IS NULL ORDER BY id FOR UPDATE`,[p.id]);
            const novo={email_normalizado:e.email,email_chave:emailChave(e.email),pedido_id:p.id};
            try{await fixarEscopo(c,novo,false);}catch(err){
                if(['SEM_DIREITOS_ELEGIVEIS','LIMITE_ESCOPO'].includes(err?.codigo))return null;
                throw err;
            }
            const n=tempo(),numero=sortearCodigo(0,1000000);
            if(!Number.isInteger(numero)||numero<0||numero>=1000000)falhar('RECUPERACAO_INDISPONIVEL');
            const codigo=String(numero).padStart(6,'0');
            const entrega={publicId,codigo,email:e.email,pedidoPublicId:e.pedidoPublicId,validadeMinutos:10,
                expiraEm:new Date(n+CONTRATO_OTP.validadeMs).toISOString()};
            // Somente composicao local previamente carregada: nenhuma operacao SMTP aqui.
            if(prepararEntrega)prepararEntrega(entrega);
            for(const r of abertos)await escrever(c,`UPDATE ist_loja_download_recuperacoes SET invalidado_em=?
                WHERE id=? AND consumido_em IS NULL AND invalidado_em IS NULL`,[utc(n),r.id]);
            await escrever(c,`INSERT INTO ist_loja_download_recuperacoes
                (public_id,desafio_hash,email_chave,email_normalizado,criado_em,desafio_expira_em,tipo,pedido_id,versao_protecao)
                VALUES(?,?,?,?,?,?,'OTP',?,1)`,
            [publicId,hashCodigo(publicId,p.id,novo.email_chave,codigo),novo.email_chave,e.email,utc(n),utc(n+CONTRATO_OTP.validadeMs),p.id]);
            return entrega;
        });
        // publicId e resposta sao indistinguiveis para pedidos inexistentes/limitados.
        return {resposta:{...resposta(),publicId},entrega};
    };
    const validarNaConexao=async(c,valor,e)=>{
            const p=await associacao(c,e),linhas=await bloquearLimites(c,e,p);
            const ok=permitido(linhas,false);registrarConsulta(linhas);
            await salvarLimites(c,linhas);
            if(!ok||!p||!uuid(valor?.publicId))return null;
            const [[r]]=await c.query(`SELECT id,public_id,desafio_hash,email_chave,email_normalizado,tentativas,pedido_id,versao_protecao,
                ${instante('criado_em')},${instante('desafio_expira_em')},consumido_em,invalidado_em
                FROM ist_loja_download_recuperacoes WHERE public_id=? AND BINARY tipo=BINARY 'OTP' FOR UPDATE`,[valor.publicId]);
            const n=tempo(),criado=ler(r?.criado_em??null),expira=ler(r?.desafio_expira_em??null);
            if(!r||r.pedido_id!==p.id||r.versao_protecao!==1||r.email_normalizado!==e.email
                ||!igual(r.email_chave,emailChave(e.email))||r.consumido_em!==null||r.invalidado_em!==null
                ||r.tentativas>=5||n<criado||n>=expira||expira-criado!==CONTRATO_OTP.validadeMs)return null;
            if(typeof valor.codigo!=='string'||!/^\d{6}$/.test(valor.codigo)
                ||!igual(r.desafio_hash,hashCodigo(r.public_id,p.id,r.email_chave,valor.codigo))){
                for(const l of linhas.filter(x=>x.escopo!=='IP')){
                    l.falhas++;if(l.falhas>=5)l.bloqueado_ate=l.janela_fim;
                }
                await salvarLimites(c,linhas);
                await escrever(c,`UPDATE ist_loja_download_recuperacoes SET tentativas=tentativas+1,
                    invalidado_em=?
                    WHERE id=? AND consumido_em IS NULL AND invalidado_em IS NULL AND tentativas<5`,
                [r.tentativas+1>=5||linhas.some(l=>l.escopo!=='IP'&&l.falhas>=5)?utc(n):null,r.id]);
                return null; // Commit do erro e dos limites antes da resposta uniforme.
            }
            return emitirSessao(c,r,n,expira);
    };
    const conferir=resultado=>{if(!resultado)falhar('DESAFIO_INVALIDO');return resultado;};
    const validarCodigo=async valor=>{
        const e=entrada(valor);
        return conferir(await transacao(c=>validarNaConexao(c,valor,e)));
    };
    const validarCodigoDoPedido=async valor=>{
        const e=entrada(valor);
        return conferir(await transacao(async c=>{
            // Descoberta observacional; validacao relê o desafio sob lock apos os limites.
            const [[r]]=await c.query(`SELECT r.public_id,r.email_normalizado FROM ist_loja_download_recuperacoes r
                JOIN ist_loja_pedidos p ON p.id=r.pedido_otp_aberto
                WHERE p.public_id=? AND p.ambiente=? AND BINARY r.tipo=BINARY 'OTP'`,
            [e.pedidoPublicId,financeiro.ambiente]);
            const interno={...valor,email:r?.email_normalizado,publicId:r?.public_id};
            return validarNaConexao(c,interno,entrada(interno));
        }));
    };
    return {solicitarCodigo,validarCodigo,validarCodigoDoPedido};
};
