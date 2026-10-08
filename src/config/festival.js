// Local confirmado: etapa 1. Em produção, configurar explicitamente
// FESTIVAL_II_ETAPA_INSCRICOES_ID com o ID daquele ambiente; nunca presumir 1.
const valorEtapa = process.env.FESTIVAL_II_ETAPA_INSCRICOES_ID
    ?? (process.env.NODE_ENV === 'production' ? '' : '1');
const numeroEtapa = /^[1-9]\d*$/.test(valorEtapa) ? Number(valorEtapa) : NaN;
const idEtapaInscricoes = Number.isSafeInteger(numeroEtapa) && numeroEtapa <= 4294967295 ? numeroEtapa : null;

export const FESTIVAL_II = Object.freeze({
    slug: 'ii-festival-de-violoes-sebastiao-tapajos',
    prefixoInscricao: 'FVST2',
    idObraPrincipal: 22,
    idEtapaInscricoes
});
