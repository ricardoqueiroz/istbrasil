// Exclusivo dos testes. Nao e importado por src, nao possui rotas/configuracao.
export const criarPagamentoSimulado = ({ agora = () => new Date(), aoChamar = async () => {} } = {}) => {
    if (process.env.NODE_ENV !== 'test') throw new Error('Simulador exclusivo de NODE_ENV=test');
    const ordens = new Map();
    const requests = new Map();
    const chamadas = { criar: 0, consultar: 0, capturar: 0 };
    let efeitosCaptura = 0;
    const modos = { criacao: 'sucesso', captura: 'integral' };
    const copia = r => structuredClone(r);
    const consultarOrdem = args => ordens.get(args.referencia);
    const aprovado = referencia => {
        const r = ordens.get(referencia);
        if (!r) throw new Error('Fixture inexistente');
        r.estado = 'APROVADO';
    };
    const concluirPendente = referencia => {
        const r = ordens.get(referencia);
        if (r?.estado !== 'PENDENTE') throw new Error('Fixture nao pendente');
        r.estado = 'CAPTURADO'; r.capturadoEm = agora().toISOString(); efeitosCaptura++;
    };
    const encerrar = (referencia, estado) => {
        if (!['CANCELADO', 'EXPIRADO'].includes(estado)) throw new Error('Estado de fixture invalido');
        const r = ordens.get(referencia);
        if (r?.estado !== 'AGUARDANDO_APROVACAO') throw new Error('Fixture ja utilizada');
        r.estado = estado;
    };
    const adaptador = Object.freeze({
        somenteTeste: true,
        async criar(args) {
            chamadas.criar++; await aoChamar('criar', args);
            if (requests.has(args.requestId)) return copia(requests.get(args.requestId));
            if (modos.criacao === 'timeoutAntes') throw new Error('Falha simulada antes da resposta');
            const r = { referencia: args.referencia, ordemId: `ordem-${args.referencia}`, capturaId: null,
                estado: 'AGUARDANDO_APROVACAO', valorCentavos: args.valorCentavos, moeda: args.moeda,
                contaRecebedora: args.contaRecebedora, ambiente: args.ambiente, capturadoEm: null };
            ordens.set(args.referencia, r); requests.set(args.requestId, copia(r));
            if (modos.criacao === 'respostaPerdida') throw new Error('Resposta perdida depois da criacao');
            return copia(r);
        },
        async consultar(args) {
            chamadas.consultar++; await aoChamar('consultar', args);
            const r = consultarOrdem(args);
            return r ? copia(r) : { referencia: args.referencia, ordemId: args.ordemId, capturaId: null,
                estado: 'DESCONHECIDO', valorCentavos: args.valorCentavos, moeda: args.moeda,
                contaRecebedora: args.contaRecebedora, ambiente: args.ambiente, capturadoEm: null };
        },
        async capturar(args) {
            chamadas.capturar++; await aoChamar('capturar', args);
            if (requests.has(args.requestId)) return copia(requests.get(args.requestId));
            const r = consultarOrdem(args);
            if (r?.estado !== 'APROVADO' || r.ordemId !== args.ordemId) throw new Error('Captura sem aprovacao');
            if (modos.captura === 'timeoutAntes') throw new Error('Falha de rede sem resposta');
            if (modos.captura === 'semResposta') await new Promise((_, rejeitar) => {
                if (args.signal.aborted) rejeitar(new Error('Abortado'));
                else args.signal.addEventListener('abort', () => rejeitar(new Error('Abortado')), { once: true });
            });
            if (modos.captura === 'recusada') r.estado = 'RECUSADO';
            else if (modos.captura === 'pendente') { r.estado = 'PENDENTE'; r.capturaId = `captura-${args.referencia}`; }
            else {
                r.estado = 'CAPTURADO'; r.capturaId = `captura-${args.referencia}`;
                r.capturadoEm = agora().toISOString(); efeitosCaptura++;
                if (modos.captura === 'valorDivergente') r.valorCentavos = String(BigInt(r.valorCentavos) + 1n);
                if (modos.captura === 'moedaDivergente') r.moeda = 'USD';
                if (modos.captura === 'recebedorDivergente') r.contaRecebedora = 'outra-conta';
            }
            requests.set(args.requestId, copia(r));
            if (modos.captura === 'respostaPerdida') throw new Error('Resposta perdida depois da captura');
            return copia(r);
        }
    });
    return { adaptador, modos, chamadas, aprovado, concluirPendente, encerrar, get efeitosCaptura() { return efeitosCaptura; } };
};
