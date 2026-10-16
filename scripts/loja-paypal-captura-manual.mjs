import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextoManual, prepararProviderManual, confereContexto, resumoManual, falhaManual } from './loja-paypal-ordem-manual-contexto.mjs';

export const capturarOrdemManual = async ({ argv = [], env = {}, http,
    saida = linha => process.stdout.write(`${linha}\n`) } = {}) => {
    let c;
    const emitir = r => saida(JSON.stringify(r));
    try {
        c = contextoManual(argv, true);
        const { provider } = prepararProviderManual({ contexto: c, env, http, captura: true });
        emitir({ etapa: 'configuracao', ordemId: c.ordemId, referencia: c.referencia, requestIdCaptura: c.requestId });
        const antes = await provider.consultar(c);
        emitir({ etapa: 'consulta', ...resumoManual(antes) });
        if (!confereContexto(antes, c) || antes.estado !== 'APROVADO' || antes.capturaId !== null) return 1;
        // Unico ponto financeiro. Adaptador reconsulta aprovacao e nao faz retry.
        const r = await provider.capturar(c);
        emitir({ etapa: 'captura', ...resumoManual(r), requestIdCaptura: c.requestId,
            validacao: confereContexto(r, c) ? 'CONSISTENTE' : 'INCONCLUSIVA_OU_DIVERGENTE' });
        return confereContexto(r, c) && r.estado === 'CAPTURADO' ? 0 : 1;
    } catch (e) { emitir({ ...falhaManual(e, c?.ordemId), requestIdCaptura: c?.requestId ?? null }); return 1; }
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await capturarOrdemManual({ argv: process.argv.slice(2), env: process.env });
}
