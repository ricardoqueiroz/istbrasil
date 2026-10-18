import { criarLojaPagamentoService } from './lojaPagamentoService.js';
import { criarPaypalProvider } from './pagamentos/paypalProvider.js';
import { carregarConfiguracaoLojaPedido } from '../config/lojaPedido.js';

// Sem pool proprio, timers ou acesso externo durante importacao.
export const iniciarRecuperacaoLoja = ({ db, env = process.env,
    criarServico = criarLojaPagamentoService, criarAdaptador = criarPaypalProvider,
    agendar = setInterval, cancelar = clearInterval, registrar = mensagem => console.warn(mensagem) } = {}) => {
    const log = mensagem => { try { registrar(mensagem); } catch { /* Logging nao derruba a API. */ } };
    const inativo = () => ({ ativo: false, parar: async () => {} });
    if (env.IST_LOJA_RECUPERACAO_ATIVA !== 'true' || env.NODE_ENV === 'test') return inativo();
    let timer, encerrado = false, emCurso = null;
    try {
        const ambiente = env.IST_LOJA_PAYPAL_ENV;
        const contaRecebedora = env.IST_LOJA_PAYPAL_CONTA_RECEBEDORA;
        // O adaptador existente e Sandbox-only. Nunca converter Live para Sandbox.
        if (ambiente !== 'sandbox' || carregarConfiguracaoLojaPedido(env).ambiente !== ambiente
            || !/^[2-9A-HJ-NP-Z]{13}$/.test(contaRecebedora ?? '') || !db?.getConnection) throw new Error();
        const adaptador = criarAdaptador({ env: { IST_LOJA_PAYPAL_ENV: ambiente,
            IST_LOJA_PAYPAL_CLIENT_ID: env.IST_LOJA_PAYPAL_CLIENT_ID,
            IST_LOJA_PAYPAL_CLIENT_SECRET: env.IST_LOJA_PAYPAL_CLIENT_SECRET } });
        const service = criarServico({ db, adaptador, contexto: { provedor: 'paypal', ambiente, contaRecebedora } });
        if (typeof service?.recuperarPendencias !== 'function') throw new Error();
        const ciclo = () => {
            if (encerrado || emCurso) return;
            emCurso = Promise.resolve().then(() => service.recuperarPendencias({ limite: 10 }))
                .then(resultados => {
                    if (resultados?.some(r => r.erro || r.resultado?.intervencao)) {
                        log('[Loja recuperacao] Ciclo concluido com pendencias; verificar diagnostico interno.');
                    }
                })
                .catch(() => log('[Loja recuperacao] Falha no ciclo; verificar diagnostico interno.'))
                .finally(() => { emCurso = null; });
        };
        timer = agendar(ciclo, 60000);
        timer?.unref?.();
        return { ativo: true, async parar() {
            if (!encerrado) { encerrado = true; cancelar(timer); timer = null; }
            // Sem cancelar operacao financeira em andamento ou fechar pool compartilhado.
            await emCurso;
        } };
    } catch {
        encerrado = true;
        if (timer != null) { try { cancelar(timer); } catch { /* Sem propagar erro de timer. */ } }
        log('[Loja recuperacao] Agendador desativado: configuracao ou inicializacao indisponivel.');
        return inativo();
    }
};
