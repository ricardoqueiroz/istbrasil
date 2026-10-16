import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextoManual, prepararProviderManual, confereContexto, resumoManual, falhaManual } from './loja-paypal-ordem-manual-contexto.mjs';

export const consultarAprovacaoManual = async ({ argv = [], env = {}, http,
    saida = linha => process.stdout.write(`${linha}\n`) } = {}) => {
    let c;
    const emitir = r => saida(JSON.stringify(r));
    try {
        c = contextoManual(argv);
        const { provider, observacao } = prepararProviderManual({ contexto: c, env, http });
        const r = await provider.consultar(c);
        const confere = confereContexto(r, c);
        emitir({ ...resumoManual(r), estadoPayPal: observacao.estadoPayPal,
            validacao: confere ? 'CONSISTENTE' : 'INCONCLUSIVA_OU_DIVERGENTE' });
        if (!confere || !['AGUARDANDO_APROVACAO', 'APROVADO'].includes(r.estado)) return 1;
        if (r.estado === 'APROVADO') return 0; // Nao abre navegador, nao captura.
        emitir({ estadoLink: observacao.link.estado,
            linkAprovacao: observacao.link.estado === 'VALIDO' ? observacao.link.url : null });
        return observacao.link.estado === 'VALIDO' ? 0 : 1;
    } catch (e) { emitir(falhaManual(e, c?.ordemId)); return 1; }
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await consultarAprovacaoManual({ argv: process.argv.slice(2), env: process.env });
}
