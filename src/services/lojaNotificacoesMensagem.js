import {normalizarEmailComprador,CONTRATO_PEDIDO} from './lojaPedidoContratos.js';
import {prepararEmailPorChave} from './emailTemplateService.js';
import {CHAVE_CONFIRMACAO_COMPRA} from '../config/emailPlaceholders.js';

const falhar=()=>{throw Error('RECIBO_INDISPONIVEL');};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const inteiro=v=>{if(!/^(0|[1-9]\d{0,15})$/.test(String(v)))falhar();const n=BigInt(v);if(n>9007199254740991n)falhar();return n;};
const dinheiro=v=>`${new Intl.NumberFormat('pt-BR',{maximumFractionDigits:0}).format(v/100n)},${String(v%100n).padStart(2,'0')}`;
const lerData=v=>{
    if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}000Z$/.test(v))falhar();
    const n=Date.parse(v);if(!Number.isFinite(n)||new Date(n).toISOString()!==v.slice(0,23)+'Z')falhar();return n;
};
const formatarData=n=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'medium',timeZone:'America/Sao_Paulo'}).format(n)+' (America/Sao_Paulo)';
const instante=k=>`DATE_FORMAT(${k},'%Y-%m-%dT%H:%i:%s.%fZ') ${k}`;

// O worker fornece sua conexao READ ONLY apos o COMMIT da reserva. Sem pool,
// SMTP, logs, leituras do catalogo atual ou escrita no nucleo financeiro.
export const criarCompositorConfirmacaoCompra=({origemPublica,ambiente,prepararModelo=prepararEmailPorChave}={})=>{
    let origem;try{origem=new URL(origemPublica);}catch{falhar();}
    if(origem.protocol!=='https:'||origem.origin!==origemPublica||origem.username||origem.password
        ||!['sandbox','live'].includes(ambiente)||typeof prepararModelo!=='function')falhar();
    return async(n,c)=>{
        try{
            if(!c?.query||!Number.isSafeInteger(n?.pedido_id)||n.pedido_id<1||n.finalidade!=='CONFIRMACAO_COMPRA'
                ||n.ambiente!==ambiente||!uuid(n.pedido_public_id)||normalizarEmailComprador(n.destinatario)!==n.destinatario)falhar();
            const [[p]]=await c.query(`SELECT id,public_id,comprador_email,estado,ambiente,moeda,
                CAST(total_centavos AS CHAR) total_centavos,${instante('criado_em')},${instante('pagamento_confirmado_em')}
                FROM ist_loja_pedidos WHERE id=?`,[n.pedido_id]);
            if(!p||p.id!==n.pedido_id||p.public_id!==n.pedido_public_id||p.comprador_email!==n.destinatario
                ||p.estado!=='PAGO'||p.ambiente!==ambiente||p.moeda!==CONTRATO_PEDIDO.moeda)falhar();
            const total=inteiro(p.total_centavos),criado=lerData(p.criado_em),confirmado=lerData(p.pagamento_confirmado_em);
            if(total<=0n||confirmado<criado)falhar();
            const [pagamentos]=await c.query(`SELECT public_id,provedor,ambiente,estado,moeda,
                CAST(valor_centavos AS CHAR) valor_centavos,CAST(capturado_centavos AS CHAR) capturado_centavos,
                CAST(reembolsado_centavos AS CHAR) reembolsado_centavos,${instante('capturado_em')}
                FROM ist_loja_pagamentos WHERE pedido_id=? ORDER BY id`,[p.id]);
            const capturas=pagamentos.filter(pg=>inteiro(pg.capturado_centavos)>0n);
            if(capturas.length!==1)falhar();const pg=capturas[0];
            if(!uuid(pg.public_id)||pg.estado!=='CAPTURADO'||pg.provedor!=='paypal'||pg.ambiente!==ambiente||pg.moeda!==p.moeda
                ||inteiro(pg.valor_centavos)!==total||inteiro(pg.capturado_centavos)!==total||inteiro(pg.reembolsado_centavos)!==0n
                ||lerData(pg.capturado_em)!==confirmado)falhar();
            const [itens]=await c.query(`SELECT posicao,titulo_snapshot,descricao_snapshot,quantidade,
                CAST(preco_unitario_centavos AS CHAR) preco_unitario_centavos,CAST(subtotal_centavos AS CHAR) subtotal_centavos
                FROM ist_loja_pedido_itens WHERE pedido_id=? ORDER BY posicao LIMIT ?`,[p.id,CONTRATO_PEDIDO.maxProdutos+1]);
            if(!itens.length||itens.length>CONTRATO_PEDIDO.maxProdutos)falhar();
            let soma=0n;const posicoes=new Set(),linhas=[];
            for(const i of itens){
                if(!Number.isInteger(i.posicao)||i.posicao<1||posicoes.has(i.posicao)||typeof i.titulo_snapshot!=='string'||!i.titulo_snapshot.trim()
                    ||(i.descricao_snapshot!==null&&typeof i.descricao_snapshot!=='string')||!Number.isInteger(i.quantidade)||i.quantidade<1||i.quantidade>65535)falhar();
                posicoes.add(i.posicao);const unitario=inteiro(i.preco_unitario_centavos),subtotal=inteiro(i.subtotal_centavos);
                if(unitario<=0n||subtotal!==unitario*BigInt(i.quantidade))falhar();soma+=subtotal;
                linhas.push(`${i.posicao}. ${i.titulo_snapshot}\n${i.descricao_snapshot??''}\nQuantidade: ${i.quantidade} | Preço unitário: ${p.moeda} ${dinheiro(unitario)} | Subtotal: ${p.moeda} ${dinheiro(subtotal)}`);
            }
            if(soma!==total)falhar();
            const compor=await prepararModelo(CHAVE_CONFIRMACAO_COMPRA,{db:c});
            const m=compor({saudacao:'Olá,',comprador_email:p.comprador_email,pedido_public_id:p.public_id,pedido_estado:'PAGO',
                data_compra:formatarData(criado),data_pagamento:formatarData(confirmado),pagamento_referencia:pg.public_id,
                pagamento_estado:'CAPTURADO — PayPal',ambiente:ambiente==='sandbox'?'Homologação — PayPal Sandbox — sem cobrança real':'Produção',
                itens_compra:linhas.join('\n\n'),total:dinheiro(total),moeda:p.moeda,
                link_biblioteca:new URL('/loja/biblioteca',origem).href,link_recuperacao:new URL('/loja/biblioteca/recuperar',origem).href});
            return {to:n.destinatario,subject:m.assunto,html:m.html,text:m.text};
        }catch{falhar();}
    };
};
