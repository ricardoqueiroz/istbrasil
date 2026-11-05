import { normalizarResultadoPagamento, normalizarReconciliacaoPagamento } from './lojaPagamentoContratos.js';
import { validarEvidenciaAdversa } from './lojaPagamentoAdversoContratos.js';

const id = n => Number.isInteger(n) && n > 0 && n <= 4294967295;
const centavos = v => {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
    return typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v) && BigInt(v) <= 9007199254740991n ? BigInt(v) : null;
};
const data = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}000Z$/.test(v)
    && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const instante = (k, alias = k) => `DATE_FORMAT(${k},'%Y-%m-%dT%H:%i:%s.%fZ') AS ${alias}`;
const externo = v => typeof v === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(v);
const json = v => {
    if (typeof v !== 'string' || Buffer.byteLength(v,'utf8') > 16384) throw Error();
    return JSON.parse(v);
};

/** Interno, sem autorizacao HTTP. Chamador fornece transacao/snapshot coerente.
 * Para futura transicao: locks sessao -> pedido -> pagamentos -> operacoes ->
 * evidencias -> direitos, sob a mesma conexao. Aqui nao adquire locks ou transacao.
 */
export const avaliarElegibilidadeFinanceiraNaConexao = async (conexao, pedidoId, contextoEsperado) => {
    const motivos = new Set(), adversos = new Set();
    let insuficiente = false, contraditoria = false, revisao = false, pendente = false;
    const falta = m => { insuficiente = true; motivos.add(m); };
    const conflito = m => { contraditoria = true; motivos.add(m); };
    const adverso = m => { adversos.add(m); motivos.add(m); };
    const saida = (referencias = null) => ({
        classificacao: adversos.size ? 'ADVERSO' : contraditoria || insuficiente ? 'INCONSISTENTE'
            : revisao ? 'REVISAO' : pendente ? 'PENDENTE' : 'ELEGIVEL',
        elegivel: !adversos.size && !contraditoria && !insuficiente && !revisao && !pendente,
        motivos: [...motivos].sort(), evidenciaAdversaPersistida: [...adversos].sort(),
        evidenciaInsuficiente: insuficiente, evidenciaContraditoria: contraditoria,
        referencias, limiteEvidencia: 'SOMENTE_PERSISTENCIA_LOCAL'
    });
    // Configuracao interna: nunca extrair de body/query/cookie do comprador.
    if (!conexao?.query || !id(pedidoId) || !contextoEsperado || contextoEsperado.provedor !== 'paypal'
        || !['sandbox','live'].includes(contextoEsperado.ambiente) || !externo(contextoEsperado.contaRecebedora)) {
        falta('CONTEXTO_INVALIDO'); return saida();
    }
    try {
        const [[tx]] = await conexao.query('SELECT @@in_transaction AS em_transacao');
        if (Number(tx?.em_transacao) !== 1) { falta('TRANSACAO_AUSENTE'); return saida(); }
        const [[p]] = await conexao.query(`SELECT id,sessao_id,estado,ambiente,moeda,versao,motivo_revisao,
            CAST(total_centavos AS CHAR) total_centavos,${instante('criado_em')},${instante('pagamento_confirmado_em')}
            FROM ist_loja_pedidos WHERE id=?`, [pedidoId]);
        if (!p || p.id !== pedidoId || !id(p.sessao_id)) { falta('PEDIDO_AUSENTE'); return saida(); }
        const [pagamentos] = await conexao.query(`SELECT id,public_id,pedido_id,provedor,ambiente,conta_recebedora,estado,versao,motivo_revisao,
            ordem_externa_id,captura_externa_id,CAST(valor_centavos AS CHAR) valor_centavos,
            CAST(capturado_centavos AS CHAR) capturado_centavos,CAST(reembolsado_centavos AS CHAR) reembolsado_centavos,
            ${instante('criado_em')},${instante('capturado_em')} FROM ist_loja_pagamentos WHERE pedido_id=? ORDER BY id`, [pedidoId]);
        const [ops] = await conexao.query(`SELECT id,pedido_id,pagamento_id,acao,estado,versao,codigo_erro,resultado_json,
            ${instante('envio_iniciado_em')},${instante('concluido_em')}
            FROM ist_loja_pagamento_operacoes WHERE pedido_id=? ORDER BY id`, [pedidoId]);
        const [eventos] = await conexao.query(`SELECT e.id,e.pagamento_id,e.provedor,e.ambiente,e.conta_recebedora,
            e.origem,e.evento_id,e.tipo,e.recurso_externo_id,e.estado,e.codigo_erro,e.evidencia_json,
            ${instante('e.recebido_em','recebido_em')},${instante('e.autenticado_em','autenticado_em')},
            ${instante('e.processado_em','processado_em')} FROM ist_loja_pagamento_eventos e
            JOIN ist_loja_pagamentos pg ON pg.id=e.pagamento_id WHERE pg.pedido_id=? ORDER BY e.id`, [pedidoId]);
        const [itens] = await conexao.query(`SELECT id,produto_id,posicao,tipo_snapshot,quantidade,
            CAST(preco_unitario_centavos AS CHAR) preco_unitario_centavos,CAST(subtotal_centavos AS CHAR) subtotal_centavos
            FROM ist_loja_pedido_itens WHERE pedido_id=? ORDER BY id`, [pedidoId]);
        const [direitos] = await conexao.query(`SELECT d.id,d.pedido_item_id,d.produto_id,d.arquivo_versao_id,d.estado,d.versao,
            v.id versao_id,v.produto_id versao_produto_id,v.estado versao_estado,${instante('v.publicado_em','versao_publicada_em')}
            FROM ist_loja_download_direitos d
            JOIN ist_loja_pedido_itens i ON i.id=d.pedido_item_id LEFT JOIN ist_loja_arquivo_versoes v ON v.id=d.arquivo_versao_id
            WHERE i.pedido_id=? ORDER BY d.id`, [pedidoId]);
        const total = centavos(p.total_centavos);
        if (total === null || total <= 0n) conflito('TOTAL_INVALIDO');
        if (p.moeda !== 'BRL' || p.ambiente !== contextoEsperado.ambiente) conflito('PEDIDO_CONTEXTO_DIVERGENTE');
        const reembolsos = ['PARCIALMENTE_REEMBOLSADO','REEMBOLSADO','ESTORNADO'];
        const capturas = pagamentos.filter(pg => pg.estado === 'CAPTURADO' || (centavos(pg.capturado_centavos) ?? 0n) > 0n);
        if (capturas.length > 1) conflito('CAPTURAS_MULTIPLAS');
        const vistos = new Set();
        for (const pg of pagamentos) {
            if (!id(pg.id) || pg.pedido_id !== p.id) conflito('PAGAMENTO_VINCULO_INVALIDO');
            if (reembolsos.includes(pg.estado) || (centavos(pg.reembolsado_centavos) ?? 0n) > 0n) adverso('REEMBOLSO_OU_ESTORNO_PERSISTIDO');
            if (centavos(pg.reembolsado_centavos) === null || centavos(pg.capturado_centavos) === null) conflito('VALORES_PAGAMENTO_INVALIDOS');
            if (pg.captura_externa_id) {
                if (vistos.has(pg.captura_externa_id)) conflito('CAPTURA_DUPLICADA');
                vistos.add(pg.captura_externa_id);
            }
        }
        const pg = capturas.length === 1 ? capturas[0] : null;
        const candidatas=pg?ops.filter(o=>o.pagamento_id===pg.id && o.acao==='CAPTURAR'):[];
        const confirmadora=candidatas.length===1?candidatas[0]:null;
        // Excecao deliberadamente estreita: os estados de revisao, o motivo e a
        // operacao precisam representar apenas a divergencia de valor observada.
        // As provas externas obrigatorias sao validadas mais abaixo.
        const divergenciaSomenteValor=Boolean(pg&&pagamentos.length===1&&confirmadora
            &&p.estado==='REVISAO'&&p.motivo_revisao==='DIVERGENCIA_FINANCEIRA'
            &&pg.estado==='REVISAO'&&pg.motivo_revisao==='DIVERGENCIA_FINANCEIRA'
            &&confirmadora.estado==='REVISAO'&&confirmadora.codigo_erro==='DIVERGENCIA_FINANCEIRA'
            &&centavos(pg.valor_centavos)===total&&centavos(pg.capturado_centavos)!==null
            &&centavos(pg.capturado_centavos)>0n&&centavos(pg.capturado_centavos)!==total);
        if (reembolsos.includes(p.estado)) adverso('ESTADO_ADVERSO_PEDIDO');
        if (!divergenciaSomenteValor&&(p.estado === 'REVISAO' || p.motivo_revisao !== null)) { revisao=true; motivos.add('REVISAO_FINANCEIRA'); }
        if (p.estado !== 'PAGO'&&!divergenciaSomenteValor) { pendente=true; motivos.add('PEDIDO_NAO_PAGO'); }
        if (p.estado === 'PAGO' && (data(p.pagamento_confirmado_em) === null || data(p.criado_em) === null
            || data(p.pagamento_confirmado_em) < data(p.criado_em))) falta('CONFIRMACAO_AUSENTE_OU_INVALIDA');
        for(const pagamento of pagamentos){
            if (!divergenciaSomenteValor&&(pagamento.estado === 'REVISAO' || pagamento.motivo_revisao !== null)) { revisao=true; motivos.add('REVISAO_FINANCEIRA'); }
            if (['CRIANDO','CAPTURANDO','PENDENTE','DESCONHECIDO','APROVADO','AGUARDANDO_APROVACAO'].includes(pagamento.estado)) {
                pendente=true; motivos.add('PAGAMENTO_NAO_CONFIRMADO');
            }
        }
        if (!pg) { pendente=true; motivos.add('CAPTURA_CONFIRMADA_AUSENTE'); }
        if (p.estado === 'PAGO' && !pg) falta('PAGO_SEM_CAPTURA');
        const valorCapturado=pg?centavos(pg.capturado_centavos):null;
        const checarResultado = (r, alvo, exigirCapturado,valorEsperado=total) => {
            let valido=true;
            if (r.referencia !== alvo.public_id || r.ordemId !== alvo.ordem_externa_id || r.capturaId !== alvo.captura_externa_id
                || r.ambiente !== alvo.ambiente || r.moeda !== p.moeda || centavos(r.valorCentavos) !== valorEsperado) {conflito('RESULTADO_DIVERGENTE');valido=false;}
            if (r.contaRecebedora === null) {falta('RECEBEDOR_OBSERVADO_AUSENTE');valido=false;}
            else if (r.contaRecebedora !== contextoEsperado.contaRecebedora || r.contaRecebedora !== alvo.conta_recebedora) {conflito('RECEBEDOR_OBSERVADO_DIVERGENTE');valido=false;}
            if (exigirCapturado && (r.estado !== 'CAPTURADO' || Date.parse(r.capturadoEm) !== data(alvo.capturado_em))) {conflito('RESULTADO_CAPTURA_INVALIDO');valido=false;}
            return valido;
        };
        const observar = obs => {
            if (['REFUNDED','PARTIALLY_REFUNDED'].includes(obs.statusCaptura) || ['CHARGEBACK','BUYER_COMPLAINT','REFUNDED'].includes(obs.motivoPendencia)) adverso('OBSERVACAO_ADVERSA_PERSISTIDA');
            if (obs.evidencia === 'CONTRADITORIA' || obs.validacao === 'DIVERGENTE' || ['DIVERGENTE','INVALIDA'].includes(obs.associacaoOrdem)) conflito('RECONCILIACAO_CONTRADITORIA');
        };
        const lerResultado = (valor, atual = false) => {
            const bruto=json(valor);
            if (bruto?.resultado !== undefined) {
                const e=normalizarReconciliacaoPagamento(bruto); observar(e.observacao);
                if (atual && (e.observacao.evidencia !== 'PRESENTE' || e.observacao.associacaoOrdem !== 'CONFIRMADA'
                    || e.observacao.validacao !== 'CONSISTENTE' || e.observacao.statusCaptura !== 'COMPLETED')) falta('RECONCILIACAO_INSUFICIENTE');
                return e.resultado;
            }
            return normalizarResultadoPagamento(bruto);
        };
        for (const o of ops) {
            if (o.pedido_id !== p.id || !pagamentos.some(x=>x.id===o.pagamento_id)) conflito('OPERACAO_VINCULO_INVALIDO');
            if (o.estado === 'REVISAO'&&!(divergenciaSomenteValor&&o.id===confirmadora.id)) { revisao=true; motivos.add('REVISAO_FINANCEIRA'); }
            if (['PREPARADA','EM_EXECUCAO','DESCONHECIDA'].includes(o.estado) && o.acao === 'CAPTURAR') { pendente=true; motivos.add('OPERACAO_INCERTA'); }
            if (o.acao === 'CAPTURAR' && o.pagamento_id !== pg?.id && o.resultado_json !== null) {
                try {
                    const r=lerResultado(o.resultado_json);
                    if (r.estado === 'CAPTURADO') conflito('OUTRA_OPERACAO_COM_CAPTURA');
                } catch { falta('OUTRA_CAPTURA_INCONCLUSIVA'); }
            }
        }
        if (pg) {
            // Revisao/efeitos posteriores nao apagam a captura historica. Esses
            // estados ja bloqueiam elegibilidade por revisao ou evidencia adversa.
            if (!['CAPTURADO','REVISAO','PARCIALMENTE_REEMBOLSADO','REEMBOLSADO','ESTORNADO'].includes(pg.estado)) conflito('CAPTURA_NAO_CONFIRMADA');
            if (pg.provedor !== contextoEsperado.provedor || pg.ambiente !== contextoEsperado.ambiente
                || pg.conta_recebedora !== contextoEsperado.contaRecebedora) conflito('PAGAMENTO_CONTEXTO_DIVERGENTE');
            if (!externo(pg.ordem_externa_id) || !externo(pg.captura_externa_id)) falta('IDENTIFICADORES_EXTERNOS_AUSENTES');
            if (centavos(pg.valor_centavos) !== total || (!divergenciaSomenteValor&&centavos(pg.capturado_centavos) !== total)) conflito('VALOR_CAPTURADO_DIVERGENTE');
            if (data(pg.capturado_em) === null || data(pg.criado_em) === null || data(pg.capturado_em) < data(pg.criado_em)
                || (!divergenciaSomenteValor&&data(pg.capturado_em) !== data(p.pagamento_confirmado_em))) conflito('DATAS_CAPTURA_DIVERGENTES');
            if (candidatas.length !== 1) falta('OPERACAO_CAPTURA_AUSENTE_OU_MULTIPLA');
            else {
                if (confirmadora.estado !== 'SUCESSO'&&!(divergenciaSomenteValor&&confirmadora.estado==='REVISAO')) { pendente=true; motivos.add('OPERACAO_NAO_CONCLUIDA'); }
                if (data(confirmadora.envio_iniciado_em) === null || data(confirmadora.concluido_em) === null
                    || data(confirmadora.envio_iniciado_em) > data(pg.capturado_em) || data(confirmadora.concluido_em) < data(pg.capturado_em)) falta('DATAS_OPERACAO_INVALIDAS');
                try { if(!checarResultado(lerResultado(confirmadora.resultado_json,true),pg,true,
                    divergenciaSomenteValor?valorCapturado:total))throw Error(); }
                catch { falta('RESULTADO_CAPTURA_AUSENTE_OU_INVALIDO'); }
            }
        }
        // Eventos antigos PENDING podem ter sido superados por COMPLETED; adversos
        // ou contraditorios permanecem impeditivos. Nao inventar resolucao de disputa.
        const ultimas = new Map(), capturasComprovadas = [];
        let aprovacaoComprovada=false,capturaDivergenteComprovada=false,webhookCapturaComprovado=false,
            revisaoDivergenciaComprovada=false;
        for (const e of eventos) {
            const alvo=pagamentos.find(x=>x.id===e.pagamento_id);
            if (!alvo || e.provedor!==alvo.provedor || e.ambiente!==alvo.ambiente || e.conta_recebedora!==alvo.conta_recebedora) { conflito('EVENTO_CONTEXTO_DIVERGENTE'); continue; }
            if (e.tipo==='REVISAO_FINANCEIRA') {
                if(divergenciaSomenteValor&&alvo.id===pg.id){
                    try{
                        const ev=json(e.evidencia_json),r=ev?.resultado?.resultado??ev?.resultado;
                        if(e.origem!=='INTERNO'||e.estado!=='PROCESSADO'||ev?.motivo!=='DIVERGENCIA_FINANCEIRA'
                            ||data(e.autenticado_em)===null||data(e.processado_em)===null||!r)throw Error();
                        if(!checarResultado(normalizarResultadoPagamento(r),alvo,true,valorCapturado))throw Error();
                        revisaoDivergenciaComprovada=true;
                    }catch{conflito('REVISAO_DIVERGENCIA_INVALIDA');}
                }else { revisao=true; motivos.add('REVISAO_FINANCEIRA'); }
            }
            if (e.origem==='RECONCILIACAO' && ['EVIDENCIA_ADVERSA','REEMBOLSO_COMPROVADO'].includes(e.tipo)) {
                try {
                    const f=validarEvidenciaAdversa(json(e.evidencia_json),alvo,contextoEsperado);
                    if(e.estado!=='PROCESSADO')falta('AVALIACAO_ADVERSA_NAO_CONCLUIDA');
                    if(f.classificacao==='REEMBOLSO_CONFIRMADO')adverso('REEMBOLSO_CONFIRMADO_PERSISTIDO');
                    else if(f.classificacao==='CONTRADITORIA')conflito('EVIDENCIA_ADVERSA_CONTRADITORIA');
                    else {revisao=true;motivos.add(f.classificacao==='RISCO_DISPUTA'?'RISCO_DISPUTA_PERSISTIDO':'EVIDENCIA_ADVERSA_EM_REVISAO');}
                } catch {conflito('EVIDENCIA_ADVERSA_INVALIDA');}
                continue;
            }
            if (e.origem==='WEBHOOK') {
                // Assinatura valida nao e prova financeira; payload nao e resultado normalizado.
                if(divergenciaSomenteValor&&alvo.id===pg.id
                    &&['PAYMENT.CAPTURE.PENDING','PAYMENT.CAPTURE.DENIED','PAYMENT.CAPTURE.DECLINED'].includes(e.tipo)){
                    conflito('WEBHOOK_CAPTURA_IMPEDITIVO');
                }else if(divergenciaSomenteValor&&alvo.id===pg.id&&e.tipo==='PAYMENT.CAPTURE.COMPLETED'){
                    try{
                        const w=json(e.evidencia_json);
                        if(e.estado!=='PROCESSADO'||data(e.autenticado_em)===null||data(e.processado_em)===null
                            ||w?.eventoId!==e.evento_id||w?.tipo!==e.tipo||w?.ordemId!==pg.ordem_externa_id
                            ||w?.capturaId!==pg.captura_externa_id||e.recurso_externo_id!==pg.captura_externa_id)throw Error();
                        webhookCapturaComprovado=true;
                    }catch{conflito('WEBHOOK_CAPTURA_INVALIDO');}
                }else if(e.estado==='REVISAO'){
                    if(e.codigo_erro==='D8_EVIDENCIA_CONTRADITORIA')conflito('EVIDENCIA_ADVERSA_CONTRADITORIA');
                    else {revisao=true;motivos.add('WEBHOOK_EM_REVISAO');}
                }else if (e.estado !== 'PROCESSADO') { pendente=true; motivos.add('WEBHOOK_PROCESSAMENTO_PENDENTE'); }
                continue;
            }
            if (!['API','RECONCILIACAO'].includes(e.origem) || !['CAPTURADO','PENDENTE','DESCONHECIDO','RECUSADO','APROVADO','AGUARDANDO_APROVACAO','CANCELADO','EXPIRADO'].includes(e.tipo)) continue;
            if(divergenciaSomenteValor&&alvo.id===pg.id&&['PENDENTE','DESCONHECIDO','RECUSADO','CANCELADO','EXPIRADO'].includes(e.tipo)){
                conflito('EVENTO_FINANCEIRO_IMPEDIMENTO');
            }
            try {
                const r=lerResultado(e.evidencia_json);
                if (e.origem==='RECONCILIACAO') ultimas.set(e.pagamento_id,{e,r,observacao:json(e.evidencia_json)?.observacao});
                if(divergenciaSomenteValor&&alvo.id===pg.id&&e.tipo==='APROVADO'){
                    if(e.origem!=='API'||e.estado!=='PROCESSADO'||data(e.autenticado_em)===null
                        ||r.estado!=='APROVADO'||r.referencia!==alvo.public_id||r.ordemId!==alvo.ordem_externa_id
                        ||r.capturaId!==null||r.capturadoEm!==null||r.ambiente!==alvo.ambiente||r.moeda!==p.moeda
                        ||centavos(r.valorCentavos)!==total||r.contaRecebedora!==contextoEsperado.contaRecebedora)conflito('APROVACAO_INVALIDA');
                    else aprovacaoComprovada=true;
                }
                if (e.tipo==='CAPTURADO' && pg?.id===alvo.id) {
                    const capturaValida=checarResultado(r,alvo,true,divergenciaSomenteValor?valorCapturado:total);
                    if(divergenciaSomenteValor){
                        const envelopeEvento=json(e.evidencia_json),obs=envelopeEvento?.observacao;
                        const provaApi=e.origem==='API'&&envelopeEvento?.resultado===undefined;
                        const provaReconciliada=e.origem==='RECONCILIACAO'&&obs?.evidencia==='PRESENTE'
                            &&obs?.associacaoOrdem==='CONFIRMADA'&&obs?.validacao==='CONSISTENTE'&&obs?.statusCaptura==='COMPLETED';
                        if(!capturaValida||e.estado!=='PROCESSADO'||data(e.autenticado_em)===null||data(e.processado_em)===null
                            ||(!provaApi&&!provaReconciliada))conflito('CAPTURA_COMPROVADA_INVALIDA');
                        else capturaDivergenteComprovada=true;
                    }
                    if (e.origem==='API' && json(e.evidencia_json)?.resultado===undefined
                        && e.estado==='PROCESSADO' && r.estado==='CAPTURADO'
                        && r.referencia===alvo.public_id && r.ordemId===alvo.ordem_externa_id
                        && r.capturaId===alvo.captura_externa_id && r.ambiente===alvo.ambiente
                        && r.moeda===p.moeda && centavos(r.valorCentavos)===(divergenciaSomenteValor?valorCapturado:total)
                        && r.contaRecebedora===contextoEsperado.contaRecebedora
                        && Date.parse(r.capturadoEm)===data(alvo.capturado_em)
                        && data(e.recebido_em)!==null && data(e.recebido_em)>=data(alvo.capturado_em))
                        capturasComprovadas.push(e);
                }
            } catch { falta('EVENTO_FINANCEIRO_INVALIDO'); }
        }
        let criterioExcepcional=null;
        if(divergenciaSomenteValor){
            if(aprovacaoComprovada&&capturaDivergenteComprovada&&webhookCapturaComprovado&&revisaoDivergenciaComprovada){
                criterioExcepcional='DIVERGENCIA_FINANCEIRA_CAPTURA_COMPROVADA';
                motivos.add(criterioExcepcional);
            }else{
                revisao=true;motivos.add('REVISAO_FINANCEIRA');
                falta('EVIDENCIAS_DIVERGENCIA_INSUFICIENTES');
            }
        }
        if (pg && ultimas.has(pg.id)) {
            const {e,r,observacao}=ultimas.get(pg.id);
            // Apenas uma observacao pre-captura, vinculada e sem captura propria,
            // pode ser superada por prova posterior. observar() ja preservou riscos
            // e contradicoes de TODOS os eventos, inclusive os historicos.
            const anteriorSuperada = e.estado==='PROCESSADO'
                && observacao?.evidencia==='PRESENTE'
                && ['CONFIRMADA','NAO_DEMONSTRADA'].includes(observacao.associacaoOrdem)
                && ['CONSISTENTE','INCONCLUSIVA'].includes(observacao.validacao)
                && [null,'CREATED','SAVED','PAYER_ACTION_REQUIRED','APPROVED','DESCONHECIDO'].includes(observacao.statusOrdem)
                && [null,'PENDING','DESCONHECIDO'].includes(observacao.statusCaptura) && observacao.motivoPendencia===null
                && ['AGUARDANDO_APROVACAO','APROVADO','PENDENTE','DESCONHECIDO'].includes(e.tipo)
                && r.estado===e.tipo && r.capturaId===null && r.capturadoEm===null
                && r.referencia===pg.public_id && r.ordemId===pg.ordem_externa_id
                && r.ambiente===pg.ambiente && r.moeda===p.moeda && centavos(r.valorCentavos)===total
                && (r.contaRecebedora===null || r.contaRecebedora===contextoEsperado.contaRecebedora)
                && data(e.recebido_em)!==null && data(e.recebido_em)<data(pg.capturado_em)
                && capturasComprovadas.some(c=>c.id>e.id && data(c.recebido_em)>data(e.recebido_em));
            try {
                if (!json(e.evidencia_json)?.observacao) falta('RECONCILIACAO_SEM_ENVELOPE');
                if (!anteriorSuperada) checarResultado(lerResultado(e.evidencia_json,true),pg,true);
            } catch { falta('RECONCILIACAO_INVALIDA'); }
        }
        let soma=0n;const produtos=new Set(),posicoes=new Set();
        for(const i of itens){
            const preco=centavos(i.preco_unitario_centavos),subtotal=centavos(i.subtotal_centavos);
            if (!id(i.id)||!id(i.produto_id)||!id(i.posicao)||produtos.has(i.produto_id)||posicoes.has(i.posicao)
                || !['DIGITAL','E-Book'].includes(i.tipo_snapshot)||i.quantidade!==1||preco===null||preco<=0n||subtotal!==preco) conflito('ITEM_CONTRADITORIO');
            produtos.add(i.produto_id);posicoes.add(i.posicao);soma+=subtotal??0n;
            const ds=direitos.filter(d=>d.pedido_item_id===i.id);
            if(ds.length===0)falta('DIREITO_AUSENTE');else if(ds.length!==1)conflito('DIREITO_DUPLICADO');
        }
        if (!itens.length||soma!==total)conflito('SOMA_ITENS_DIVERGENTE');
        for(const d of direitos){
            const i=itens.find(x=>x.id===d.pedido_item_id);
            if(!i||d.produto_id!==i.produto_id||!id(d.id)||!id(d.versao)||!['AGUARDANDO_CONFIRMACAO','ATIVO','SUSPENSO','REVOGADO'].includes(d.estado))conflito('DIREITO_VINCULO_INVALIDO');
            if(!id(d.arquivo_versao_id)||d.versao_id!==d.arquivo_versao_id||d.versao_produto_id!==d.produto_id)conflito('VERSAO_ADQUIRIDA_INVALIDA');
            if(!['PUBLICADA','RETIRADA'].includes(d.versao_estado)||data(d.versao_publicada_em)===null
                ||data(d.versao_publicada_em)>data(p.criado_em))conflito('VERSAO_NAO_PUBLICADA_NA_COMPRA');
        }
        const resultado=saida({pedidoId:p.id,sessaoId:p.sessao_id,pedidoVersao:p.versao,
            pagamentos:pagamentos.map(x=>({id:x.id,versao:x.versao})),operacoes:ops.map(x=>({id:x.id,versao:x.versao})),
            eventosIds:eventos.map(e=>e.id),direitos:direitos.map(d=>({id:d.id,versao:d.versao,estado:d.estado,itemId:d.pedido_item_id,produtoId:d.produto_id,arquivoVersaoId:d.arquivo_versao_id}))});
        return {...resultado,criterioExcepcional};
    } catch {
        falta('LEITURA_FINANCEIRA_INDISPONIVEL');return saida();
    }
};
