import axios from 'axios';
import { centavosPagamento, criarFalhaPagamento, classificarFalhaPagamento, erroPagamento, idExterno,
    instantePagamento, normalizarResultadoPagamento, normalizarReconciliacaoPagamento, uuidPagamento } from '../lojaPagamentoContratos.js';

const HOST = 'https://api-m.sandbox.paypal.com';
// Somente metadados HATEOAS: nao configura nem altera o destino REST.
const ORIGENS_HATEOAS_SANDBOX = Object.freeze([
    'https://api-m.sandbox.paypal.com', 'https://api.sandbox.paypal.com'
]);
const ordemValida = v => typeof v === 'string' && /^[A-Z0-9]{1,36}$/.test(v);
const recebedorValido = v => typeof v === 'string' && /^[2-9A-HJ-NP-Z]{13}$/.test(v);
const objeto = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const falhar = (categoria, envio, resultado = null) => { throw criarFalhaPagamento({ categoria, envio, resultado }); };
const decimal = centavos => {
    const n = BigInt(centavosPagamento(centavos));
    return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
};
const lerValor = valor => {
    if (typeof valor !== 'string' || !/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/.test(valor)) throw new Error();
    const [inteiro, fracao = ''] = valor.split('.');
    return centavosPagamento(String(BigInt(inteiro) * 100n + BigInt(fracao.padEnd(2, '0'))));
};
const lerInstante = v => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v)) throw new Error();
    const [segundos, fracao = ''] = v.slice(0, -1).split('.');
    return instantePagamento(`${segundos}.${fracao.padEnd(3, '0')}Z`);
};

// Projecao diagnostica de Payments v2. Nao e resultado financeiro do contrato IST.
const diagnosticoCaptura = d => {
    if (!objeto(d)) falhar('RESPOSTA_INVALIDA', 'ENVIADO');
    let respostaInvalida = false;
    const lerOpcional = (valor, validar) => {
        if (valor === undefined || valor === null) return null;
        try { return validar(valor); } catch { respostaInvalida = true; return null; }
    };
    const identificador = v => { if (!ordemValida(v)) throw new Error(); return v; };
    const capturaId = lerOpcional(d.id, identificador);
    const estados = ['COMPLETED', 'PENDING', 'DECLINED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED'];
    const statusFinanceiro = estados.includes(d.status) ? d.status : 'DESCONHECIDO';
    if (d.amount != null && !objeto(d.amount)) respostaInvalida = true;
    const valorCentavos = lerOpcional(d.amount?.value, lerValor);
    const moeda = lerOpcional(d.amount?.currency_code, v => { if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) throw new Error(); return v; });
    const criadoEm = lerOpcional(d.create_time, lerInstante);
    const atualizadoEm = lerOpcional(d.update_time, lerInstante);
    if (criadoEm && atualizadoEm && atualizadoEm < criadoEm) respostaInvalida = true;
    const ordensRelacionadas = new Set();
    const orderId = d.supplementary_data?.related_ids?.order_id;
    const idRelacionado = lerOpcional(orderId, identificador);
    if (idRelacionado) ordensRelacionadas.add(idRelacionado);
    const motivos = new Set();
    if (orderId != null && !idRelacionado) motivos.add('ORDEM_RELACIONADA_ID_INVALIDO');
    if (d.supplementary_data != null) {
        if (!objeto(d.supplementary_data)) motivos.add('SUPPLEMENTARY_DATA_INVALIDO');
        else if (d.supplementary_data.related_ids != null && !objeto(d.supplementary_data.related_ids)) motivos.add('RELATED_IDS_INVALIDO');
    }
    if (d.links != null && !Array.isArray(d.links)) motivos.add('LINKS_ESTRUTURA_INVALIDA');
    const diagnosticosLinksUp = [];
    for (const [indice, l] of (Array.isArray(d.links) ? d.links : []).entries()) {
        if (l?.rel !== 'up') continue;
        // Projecao somente diagnostica; nunca utilizada para decidir aceitacao.
        const diagnostico = { indice,
            metodo: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(l.method) ? l.method : 'INVALIDO',
            protocolo: 'INVALIDO', hostname: null, porta: null, tipoRecurso: 'DESCONHECIDO',
            possuiCredenciais: false, possuiQuery: false, possuiFragmento: false,
            origemPermitida: false, representacaoCanonica: false, codigos: [] };
        diagnosticosLinksUp.push(diagnostico);
        const rejeitar = codigo => { motivos.add(codigo); diagnostico.codigos.push(codigo); };
        if (l.method !== 'GET') rejeitar('UP_METODO_INVALIDO');
        if (typeof l.href !== 'string') { rejeitar('UP_HREF_TIPO_INVALIDO'); continue; }
        if (l.href.length > 2048) rejeitar('UP_URL_LIMITE_EXCEDIDO');
        if (/\s/.test(l.href)) rejeitar('UP_URL_ESPACOS');
        let valido = l.method === 'GET' && l.href.length <= 2048 && !/\s/.test(l.href);
        try {
            const u = new URL(l.href);
            const ordem = /^\/v2\/checkout\/orders\/([A-Z0-9]{1,36})$/.exec(u.pathname);
            const autorizacao = /^\/v2\/payments\/authorizations\/([A-Z0-9]{1,36})$/.test(u.pathname);
            const origemPermitida = ORIGENS_HATEOAS_SANDBOX.includes(u.origin);
            const representacaoCanonica = origemPermitida && l.href === `${u.origin}${u.pathname}`;
            diagnostico.protocolo = ['https:', 'http:'].includes(u.protocol) ? u.protocol : 'DESCONHECIDO';
            diagnostico.hostname = u.hostname.length <= 253 && /^[a-z0-9.\-\[\]:]+$/.test(u.hostname) ? u.hostname : null;
            diagnostico.porta = /^\d{1,5}$/.test(u.port) ? u.port : null;
            diagnostico.tipoRecurso = ordem ? 'ORDEM' : autorizacao ? 'AUTORIZACAO' : 'DESCONHECIDO';
            diagnostico.possuiCredenciais = Boolean(u.username || u.password);
            diagnostico.possuiQuery = Boolean(u.search);
            diagnostico.possuiFragmento = Boolean(u.hash);
            diagnostico.origemPermitida = origemPermitida;
            diagnostico.representacaoCanonica = representacaoCanonica;
            const verificar = (condicao, codigo) => { if (condicao) { rejeitar(codigo); valido = false; } };
            verificar(!origemPermitida, 'UP_ORIGEM_NAO_PERMITIDA');
            verificar(Boolean(u.username || u.password), 'UP_CREDENCIAIS_PROIBIDAS');
            verificar(Boolean(u.search), 'UP_QUERY_PROIBIDA');
            verificar(Boolean(u.hash), 'UP_FRAGMENTO_PROIBIDO');
            if (!ordem && !autorizacao) {
                verificar(true, /^\/v2\/(checkout\/orders|payments\/authorizations)\//.test(u.pathname)
                    ? 'UP_RECURSO_ID_INVALIDO' : 'UP_CAMINHO_NAO_RECONHECIDO');
            }
            verificar(!representacaoCanonica, 'UP_URL_NAO_CANONICA');
            // up pode identificar a autorizacao pai; seu ID nao e um Order ID.
            // Validar esse relacionamento nao demonstra nem contradiz a ordem.
            if (valido && ordem) ordensRelacionadas.add(ordem[1]);
        } catch { rejeitar('UP_URL_INVALIDA'); }
    }
    for (const diagnostico of diagnosticosLinksUp) diagnostico.codigos = [...new Set(diagnostico.codigos)].sort();
    // Lista fechada de codigos tecnicos: nunca refletir texto arbitrario da API.
    const razoes = ['BUYER_COMPLAINT', 'CHARGEBACK', 'ECHECK', 'INTERNATIONAL_WITHDRAWAL',
        'OTHER', 'PENDING_REVIEW', 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION',
        'REFUNDED', 'TRANSACTION_APPROVED_AWAITING_FUNDING', 'UNILATERAL', 'VERIFICATION_REQUIRED'];
    const detalhes = d.status_details;
    const reason = objeto(detalhes) ? detalhes.reason : undefined;
    const estadoMotivoPendencia = detalhes != null && !objeto(detalhes) ? 'INVALIDO'
        : reason == null ? 'AUSENTE'
            : typeof reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(reason) ? 'INVALIDO'
                : razoes.includes(reason) ? 'INFORMADO' : 'NAO_RECONHECIDO';
    const motivoPendencia = estadoMotivoPendencia === 'INFORMADO' ? reason : null;
    return { recursoDisponivel: true, capturaId, statusFinanceiro, moeda, valorCentavos,
        criadoEm, atualizadoEm, ordensRelacionadas: [...ordensRelacionadas], associacaoInvalida: motivos.size > 0,
        motivosAssociacaoInvalida: [...motivos].sort(), diagnosticosLinksUp,
        motivoPendencia, estadoMotivoPendencia, respostaInvalida };
};

// Somente configuracao e contexto confiaveis do backend. Nenhum efeito ao importar.
// Transporte injetado deve obedecer a interface axios.request; nunca vem de HTTP publico.
// Referencia e o public_id da tentativa, ligado ao pedido pelo nucleo IST.
export const criarPaypalProvider = ({ env = process.env, http = axios.create(), agora = Date.now, timeoutMs = 4000 } = {}) => {
    const ambiente = env?.IST_LOJA_PAYPAL_ENV;
    const clientId = env?.IST_LOJA_PAYPAL_CLIENT_ID;
    const clientSecret = env?.IST_LOJA_PAYPAL_CLIENT_SECRET;
    if (ambiente !== 'sandbox' || typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(clientId)
        || typeof clientSecret !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(clientSecret)
        || typeof http?.request !== 'function' || typeof agora !== 'function'
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw erroPagamento('CONFIGURACAO_INVALIDA');
    let token = null, validoAte = 0, renovacao = null;

    const requisitar = config => http.request({ ...config, url: `${HOST}${config.url}`,
        timeout: timeoutMs, maxRedirects: 0, proxy: false, responseType: 'json',
        maxContentLength: 262144, maxBodyLength: 16384,
        transitional: { silentJSONParsing: false }, validateStatus: () => true });
    const obterToken = async () => {
        if (token && agora() < validoAte) return token;
        if (!renovacao) renovacao = (async () => {
            const inicio = agora(); let resposta;
            try {
                resposta = await requisitar({ method: 'POST', url: '/v1/oauth2/token',
                    auth: { username: clientId, password: clientSecret },
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                    data: 'grant_type=client_credentials' });
            } catch (e) { falhar(e?.code === 'ERR_BAD_RESPONSE' || e instanceof SyntaxError ? 'RESPOSTA_INVALIDA' : 'INFRAESTRUTURA', 'NAO_ENVIADO'); }
            const d = resposta?.data;
            if (['invalid_client', 'unauthorized_client', 'invalid_token'].includes(d?.error)
                || d?.name === 'AUTHENTICATION_FAILURE') falhar('AUTENTICACAO', 'NAO_ENVIADO');
            if (resposta?.status === 429 || resposta?.status >= 500) falhar('INFRAESTRUTURA', 'NAO_ENVIADO');
            if (resposta?.status !== 200 || !objeto(d) || typeof d.token_type !== 'string' || d.token_type.toLowerCase() !== 'bearer'
                || typeof d.access_token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(d.access_token)
                || !Number.isInteger(d.expires_in) || d.expires_in < 1 || d.expires_in > 86400) falhar('RESPOSTA_INVALIDA', 'NAO_ENVIADO');
            validoAte = inicio + d.expires_in * 1000 - Math.min(30000, d.expires_in * 100);
            if (agora() >= validoAte) falhar('INFRAESTRUTURA', 'NAO_ENVIADO');
            token = d.access_token;
            return token;
        })().finally(() => { renovacao = null; });
        return renovacao;
    };
    const validar = (args, metodo) => {
        try {
            if (!objeto(args) || args.ambiente !== 'sandbox' || !recebedorValido(args.contaRecebedora)
                || args.moeda !== 'BRL' || (args.signal && typeof args.signal.addEventListener !== 'function')) throw new Error();
            uuidPagamento(args.referencia);
            const valorCentavos = centavosPagamento(args.valorCentavos);
            if (BigInt(valorCentavos) < 1n || BigInt(valorCentavos) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
            if (metodo !== 'consultar') uuidPagamento(args.requestId);
            if (metodo === 'capturar' && !ordemValida(args.ordemId)) throw new Error();
            if (args.ordemId != null && !ordemValida(args.ordemId)) throw new Error();
            if (args.capturaId != null && !ordemValida(args.capturaId)) throw new Error();
            return { referencia: args.referencia, ambiente: 'sandbox', valorCentavos, moeda: args.moeda,
                contaRecebedora: args.contaRecebedora, ordemId: args.ordemId ?? null, capturaId: args.capturaId ?? null,
                requestId: args.requestId, signal: args.signal };
        } catch { falhar('VALIDACAO_LOCAL', 'NAO_ENVIADO'); }
    };
    const parcial = a => ({ estado: 'DESCONHECIDO', referencia: a.referencia, ambiente: 'sandbox',
        ordemId: a.ordemId, capturaId: null, valorCentavos: null, moeda: null, contaRecebedora: null, capturadoEm: null });

    // Projeta somente fatos permitidos; nunca retorna payer, payment_source, links ou payload bruto.
    // Uma unica purchase_unit/captura e esperada para o fluxo CAPTURE desta integracao.
    const normalizar = (d, a) => {
        const r = parcial(a);
        try {
            if (!objeto(d)) throw new Error();
            if (d.id != null) { if (!ordemValida(d.id)) throw new Error(); r.ordemId = d.id; }
            if (d.intent != null && d.intent !== 'CAPTURE') throw new Error();
            if (d.purchase_units === undefined) return normalizarResultadoPagamento(r);
            if (!Array.isArray(d.purchase_units) || d.purchase_units.length !== 1 || !objeto(d.purchase_units[0])) throw new Error();
            const u = d.purchase_units[0];
            // Extrair IDs antes dos demais fatos: montante malformado nao deve
            // descartar um recurso valido ja recebido na mesma resposta.
            if (u.payments != null && !objeto(u.payments)) throw new Error();
            const capturas = u.payments?.captures ?? [];
            if (!Array.isArray(capturas) || capturas.length > 1) throw new Error();
            const c = capturas[0];
            if (c != null) {
                if (!objeto(c)) throw new Error();
                if (c.id != null) { if (!ordemValida(c.id)) throw new Error(); r.capturaId = c.id; }
            }
            const ref = u.reference_id ?? u.custom_id;
            if (ref != null) { if (!idExterno(ref)) throw new Error(); r.referencia = ref; }
            if (u.custom_id != null && u.reference_id != null && u.custom_id !== u.reference_id) throw new Error();
            if (u.payee != null && !objeto(u.payee)) throw new Error();
            if (u.payee?.merchant_id != null) {
                if (!recebedorValido(u.payee.merchant_id)) throw new Error(); r.contaRecebedora = u.payee.merchant_id;
            }
            const moeda = v => { if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) throw new Error(); return v; };
            const lerMontante = m => {
                if (!objeto(m)) throw new Error();
                return { valor: m.value == null ? null : lerValor(m.value), moeda: m.currency_code == null ? null : moeda(m.currency_code) };
            };
            let montante = null;
            if (u.amount != null) { montante = lerMontante(u.amount); r.valorCentavos = montante.valor; r.moeda = montante.moeda; }
            if (u.payments?.authorizations?.length) throw new Error();
            if (c != null) {
                let capturado = null;
                if (c.amount != null) {
                    capturado = lerMontante(c.amount); r.valorCentavos = capturado.valor; r.moeda = capturado.moeda;
                    if (montante && ((montante.valor !== null && capturado.valor !== null && montante.valor !== capturado.valor)
                        || (montante.moeda !== null && capturado.moeda !== null && montante.moeda !== capturado.moeda))) throw new Error();
                }
                const completa = ref != null && ordemValida(d.id) && r.valorCentavos !== null && r.moeda && r.contaRecebedora;
                if (c.status === 'COMPLETED' && d.status === 'COMPLETED' && completa && r.capturaId && capturado?.valor !== null && capturado?.valor !== undefined
                    && capturado.moeda && c.final_capture === true) {
                    r.capturadoEm = lerInstante(c.update_time ?? c.create_time); r.estado = 'CAPTURADO';
                } else if (c.status === 'PENDING' && completa) r.estado = 'PENDENTE';
                else if (c.status === 'DECLINED' && completa) r.estado = 'RECUSADO';
                // REFUNDED/FAILED/estados futuros nao confirmam captura nem recusa definitiva.
            } else if (ref != null && ordemValida(d.id) && r.valorCentavos !== null && r.moeda && r.contaRecebedora) {
                if (d.status === 'APPROVED') r.estado = 'APROVADO';
                else if (['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED'].includes(d.status)) r.estado = 'AGUARDANDO_APROVACAO';
            }
            return normalizarResultadoPagamento(r);
        } catch {
            r.estado = 'DESCONHECIDO'; r.capturadoEm = null;
            if (!r.ordemId) r.capturaId = null;
            falhar('RESPOSTA_INVALIDA', 'ENVIADO', normalizarResultadoPagamento(r));
        }
    };
    const trocar = async (a, method, url, data) => {
        if (a.signal?.aborted) falhar('INFRAESTRUTURA', 'NAO_ENVIADO');
        const acesso = await obterToken();
        if (a.signal?.aborted) falhar('INFRAESTRUTURA', 'NAO_ENVIADO');
        let resposta;
        try {
            resposta = await requisitar({ method, url, signal: a.signal, data,
                headers: { Authorization: `Bearer ${acesso}`, Accept: 'application/json', 'Content-Type': 'application/json',
                    ...(method === 'POST' ? { 'PayPal-Request-Id': a.requestId, Prefer: 'return=representation' } : {}) } });
        } catch (e) {
            if (e?.response) resposta = e.response;
            else falhar(e?.code === 'ERR_BAD_RESPONSE' || e instanceof SyntaxError ? 'RESPOSTA_INVALIDA' : 'INFRAESTRUTURA', 'INDETERMINADO');
        }
        const d = resposta?.data;
        if (resposta?.status >= 200 && resposta.status < 300) return normalizar(d, a);
        // Nomes/codigos oficiais, nunca descricao, stack ou corpo da excecao.
        const issues = Array.isArray(d?.details) ? d.details.map(v => v?.issue) : [];
        let categoria = 'OPERACAO';
        if (d?.name === 'AUTHENTICATION_FAILURE' || ['invalid_token', 'invalid_client'].includes(d?.error)) {
            if (token === acesso) { token = null; validoAte = 0; } categoria = 'AUTENTICACAO';
        } else if (resposta?.status === 429 || resposta?.status >= 500 || d?.name === 'INTERNAL_SERVER_ERROR') categoria = 'INFRAESTRUTURA';
        else if (!objeto(d) || (d?.name === 'INVALID_REQUEST' && !issues.includes('INSTRUMENT_DECLINED'))) categoria = 'RESPOSTA_INVALIDA';
        // INSTRUMENT_DECLINED/ORDER_NOT_APPROVED/RESOURCE_NOT_FOUND e HTTP 422 nao
        // comprovam ausencia de efeitos. Nao fabricar RECUSADO nem repetir POST.
        let evidencia;
        try { evidencia = normalizar(d, a); }
        catch (e) { evidencia = classificarFalhaPagamento(e).resultado; }
        evidencia = { ...(evidencia ?? parcial(a)), estado: 'DESCONHECIDO', capturadoEm: null };
        falhar(categoria, 'ENVIADO', normalizarResultadoPagamento(evidencia));
    };
    const consultarValidado = a => a.ordemId ? trocar(a, 'GET', `/v2/checkout/orders/${a.ordemId}`) : Promise.resolve(normalizarResultadoPagamento(parcial(a)));
    // Leitura de recursos fixos. Nenhuma URL do provedor/comprador e executada.
    const lerRecursoReconciliacao = async (a, caminho) => {
        if (a.signal?.aborted) falhar('INFRAESTRUTURA', 'NAO_ENVIADO');
        const acesso = await obterToken();
        if (a.signal?.aborted) falhar('INFRAESTRUTURA', 'NAO_ENVIADO');
        let resposta;
        try {
            resposta = await requisitar({ method: 'GET', url: caminho, signal: a.signal,
                headers: { Authorization: `Bearer ${acesso}`, Accept: 'application/json' } });
        } catch (e) {
            if (e?.response) resposta = e.response;
            else falhar(e?.code === 'ERR_BAD_RESPONSE' || e instanceof SyntaxError ? 'RESPOSTA_INVALIDA' : 'INFRAESTRUTURA', 'INDETERMINADO');
        }
        const d = resposta?.data;
        if (resposta?.status === 200) {
            if (!objeto(d)) falhar('RESPOSTA_INVALIDA', 'ENVIADO');
            return d;
        }
        if (resposta?.status === 404 && d?.name === 'RESOURCE_NOT_FOUND') return null;
        if (d?.name === 'AUTHENTICATION_FAILURE' || ['invalid_client', 'invalid_token'].includes(d?.error)) {
            if (token === acesso) { token = null; validoAte = 0; }
            falhar('AUTENTICACAO', 'ENVIADO');
        }
        falhar(resposta?.status === 429 || resposta?.status >= 500 ? 'INFRAESTRUTURA' : 'OPERACAO', 'ENVIADO');
    };
    const reconciliar = async args => {
        const a = validar(args, 'consultar');
        if (args.provedor != null && args.provedor !== 'paypal') falhar('VALIDACAO_LOCAL', 'NAO_ENVIADO');
        let r = parcial(a);
        const obs = { evidencia: 'AUSENTE', associacaoOrdem: 'NAO_DEMONSTRADA', validacao: 'INCONCLUSIVA',
            statusOrdem: null, statusCaptura: null, motivoPendencia: null };
        const concluir = () => normalizarReconciliacaoPagamento({ resultado: r, observacao: obs });
        const contradicao = associacao => {
            r.estado = 'DESCONHECIDO'; r.capturadoEm = null;
            obs.evidencia = 'CONTRADITORIA'; obs.validacao = 'DIVERGENTE';
            if (associacao) obs.associacaoOrdem = associacao;
            return concluir();
        };
        if (!a.ordemId) return concluir();
        const d = await lerRecursoReconciliacao(a, `/v2/checkout/orders/${a.ordemId}`);
        if (!d) return concluir();
        obs.evidencia = 'PRESENTE';
        obs.statusOrdem = ['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED', 'APPROVED', 'COMPLETED', 'VOIDED'].includes(d.status) ? d.status : 'DESCONHECIDO';
        try { r = normalizar(d, a); }
        catch (e) { r = classificarFalhaPagamento(e).resultado ?? parcial(a); }
        // Uma ordem sozinha nunca confirma uma captura neste caminho.
        r = { ...r, estado: 'DESCONHECIDO', capturadoEm: null };
        if (!ordemValida(d.id)) return concluir();
        if (d.id !== a.ordemId) return contradicao('DIVERGENTE');
        if (!Array.isArray(d.purchase_units) || d.purchase_units.length !== 1 || !objeto(d.purchase_units[0])) return contradicao('INVALIDA');
        const u = d.purchase_units[0];
        if ((d.intent != null && d.intent !== 'CAPTURE') || (u.payments != null && !objeto(u.payments))) return contradicao('INVALIDA');
        const cs = u.payments?.captures ?? [];
        if (!Array.isArray(cs) || cs.length > 1 || (cs.length && !objeto(cs[0]))
            || (u.payments?.authorizations != null && (!Array.isArray(u.payments.authorizations)
                || u.payments.authorizations.length))) return contradicao('INVALIDA');
        const embutida = cs[0];
        if (embutida && !ordemValida(embutida.id)) return contradicao('INVALIDA');
        if (embutida?.custom_id != null && embutida.custom_id !== a.referencia) return contradicao('DIVERGENTE');
        if (a.capturaId && embutida && a.capturaId !== embutida.id) return contradicao('DIVERGENTE');
        const ref = u.reference_id ?? u.custom_id;
        if ((ref != null && ref !== a.referencia) || (u.reference_id != null && u.custom_id != null && u.reference_id !== u.custom_id)) return contradicao('DIVERGENTE');
        const capturaId = a.capturaId ?? embutida?.id;
        if (!capturaId) {
            const semCaptura = normalizar(d, a);
            const confere = semCaptura.valorCentavos === a.valorCentavos && semCaptura.moeda === a.moeda
                && semCaptura.contaRecebedora === a.contaRecebedora;
            if ((semCaptura.valorCentavos !== null && semCaptura.valorCentavos !== a.valorCentavos)
                || (semCaptura.moeda !== null && semCaptura.moeda !== a.moeda)
                || (semCaptura.contaRecebedora !== null && semCaptura.contaRecebedora !== a.contaRecebedora)) return contradicao();
            if (confere && ref != null) r = semCaptura;
            return concluir(); // Ordem identificada nao demonstra associacao com captura inexistente.
        }
        const c = await lerRecursoReconciliacao(a, `/v2/payments/captures/${capturaId}`);
        if (!c) return concluir();
        const diag = diagnosticoCaptura(c);
        obs.statusCaptura = diag.statusFinanceiro;
        obs.motivoPendencia = diag.motivoPendencia;
        if (diag.capturaId !== capturaId) return contradicao(diag.capturaId ? 'DIVERGENTE' : 'INVALIDA');
        if (diag.associacaoInvalida) return contradicao('INVALIDA');
        if (diag.ordensRelacionadas.some(id => id !== a.ordemId)) return contradicao('DIVERGENTE');
        obs.associacaoOrdem = embutida || diag.ordensRelacionadas.includes(a.ordemId) ? 'CONFIRMADA' : 'NAO_DEMONSTRADA';
        if (c.custom_id != null && c.custom_id !== a.referencia) return contradicao('DIVERGENTE');
        if (embutida?.status != null && embutida.status !== c.status
            && !(embutida.status === 'PENDING' && c.status === 'COMPLETED')) return contradicao();
        if (embutida?.final_capture != null && c.final_capture != null && embutida.final_capture !== c.final_capture) return contradicao();
        if (diag.respostaInvalida) return contradicao('INVALIDA');
        const montante = m => m == null ? { valor: null, moeda: null } : (() => {
            if (!objeto(m)) throw new Error();
            if (m.currency_code != null && (typeof m.currency_code !== 'string' || !/^[A-Z]{3}$/.test(m.currency_code))) throw new Error();
            return { valor: m.value == null ? null : lerValor(m.value), moeda: m.currency_code ?? null };
        })();
        let ordemValor, embutidaValor, recebedor;
        try {
            ordemValor = montante(u.amount); embutidaValor = montante(embutida?.amount);
            for (const p of [u.payee, c.payee]) if (p != null && (!objeto(p) || (p.merchant_id != null && !recebedorValido(p.merchant_id)))) throw new Error();
            recebedor = c.payee?.merchant_id ?? u.payee?.merchant_id ?? null;
        } catch { return contradicao('INVALIDA'); }
        if ([ordemValor.valor, embutidaValor.valor, diag.valorCentavos].some(v => v !== null && v !== a.valorCentavos)
            || [ordemValor.moeda, embutidaValor.moeda, diag.moeda].some(v => v !== null && v !== a.moeda)
            || [u.payee?.merchant_id, c.payee?.merchant_id].some(v => v != null && v !== a.contaRecebedora)) return contradicao();
        r = { ...r, ordemId: d.id, capturaId: diag.capturaId, valorCentavos: diag.valorCentavos,
            moeda: diag.moeda, contaRecebedora: recebedor };
        const completa = obs.associacaoOrdem === 'CONFIRMADA' && ref != null && recebedor != null
            && ordemValor.valor !== null && ordemValor.moeda !== null && diag.valorCentavos !== null && diag.moeda !== null;
        if (!completa) return concluir();
        // Preservar os requisitos financeiros anteriores usando somente fatos observados.
        const combinado = normalizar({ ...d, purchase_units: [{ ...u,
            payee: c.payee?.merchant_id ? c.payee : u.payee, payments: { captures: [c] } }] }, a);
        // DECLINED/FAILED/refundos continuam inconclusivos: nao provar ausencia de efeitos por GET isolado.
        if (['CAPTURADO', 'PENDENTE'].includes(combinado.estado)) {
            r = combinado; obs.validacao = 'CONSISTENTE';
        }
        return concluir();
    };
    return Object.freeze({
        reconciliar,
        // Leitura auxiliar: sem normalizar para CAPTURADO/PAGO, sem consultar banco
        // e sem criar operacao financeira. OAuth compartilha cache e single-flight.
        async consultarCaptura({ capturaId, ambiente, signal } = {}) {
            if (ambiente !== 'sandbox' || !ordemValida(capturaId) || (signal && typeof signal.addEventListener !== 'function')) {
                falhar('VALIDACAO_LOCAL', 'NAO_ENVIADO');
            }
            if (signal?.aborted) falhar('INFRAESTRUTURA', 'NAO_ENVIADO');
            const acesso = await obterToken();
            if (signal?.aborted) falhar('INFRAESTRUTURA', 'NAO_ENVIADO');
            let resposta;
            try {
                resposta = await requisitar({ method: 'GET', url: `/v2/payments/captures/${capturaId}`, signal,
                    headers: { Authorization: `Bearer ${acesso}`, Accept: 'application/json' } });
            } catch (e) {
                if (e?.response) resposta = e.response;
                else falhar(e?.code === 'ERR_BAD_RESPONSE' || e instanceof SyntaxError ? 'RESPOSTA_INVALIDA' : 'INFRAESTRUTURA', 'INDETERMINADO');
            }
            const d = resposta?.data;
            if (resposta?.status === 200) return diagnosticoCaptura(d);
            if (resposta?.status === 404 && d?.name === 'RESOURCE_NOT_FOUND') return { recursoDisponivel: false };
            if (d?.name === 'AUTHENTICATION_FAILURE' || ['invalid_client', 'invalid_token'].includes(d?.error)) {
                if (token === acesso) { token = null; validoAte = 0; }
                falhar('AUTENTICACAO', 'ENVIADO');
            }
            falhar(resposta?.status === 429 || resposta?.status >= 500 ? 'INFRAESTRUTURA' : 'OPERACAO', 'ENVIADO');
        },
        async criar(args) {
            const a = validar(args, 'criar');
            // Recebedor explicito e referencia da tentativa, sem dados pessoais.
            return trocar(a, 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{
                reference_id: a.referencia, custom_id: a.referencia, payee: { merchant_id: a.contaRecebedora },
                amount: { currency_code: a.moeda, value: decimal(a.valorCentavos) }
            }] });
        },
        async consultar(args) { return consultarValidado(validar(args, 'consultar')); },
        async capturar(args) {
            const a = validar(args, 'capturar');
            // O nucleo tambem valida aprovacao. Aqui nao confiar em flags do chamador.
            const r = await consultarValidado(a);
            if (r.estado !== 'APROVADO' || r.referencia !== a.referencia || r.ordemId !== a.ordemId
                || r.contaRecebedora !== a.contaRecebedora || r.valorCentavos !== a.valorCentavos || r.moeda !== a.moeda
                || (a.capturaId && r.capturaId !== a.capturaId)) return r;
            return trocar(a, 'POST', `/v2/checkout/orders/${a.ordemId}/capture`, {});
        }
    });
};
