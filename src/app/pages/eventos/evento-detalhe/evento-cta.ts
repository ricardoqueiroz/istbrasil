import { Evento, EventoEtapa, EtapaStatus } from 'src/app/models/evento.model';

export const CTA_TIMEZONE = 'America/Santarem';
type Destino = { tipoLink: 'interno' | 'externo'; link: string };
type Contexto = {
    etapa: EventoEtapa | null;
    statusLabel: string | null;
    contagem: string | null;
    diasRestantes: number | null;
    divergenciaDataStatus: boolean;
    configuracaoIncompleta: boolean;
};
export type EventoCtaResolvido = Contexto & (
    { estado: 'oculto'; texto: null; link: null; tipoLink: null } |
    { estado: 'informativo'; texto: string; link: null; tipoLink: null } |
    ({ estado: 'acao'; texto: string } & Destino)
);

const normalizar = (valor: string | null | undefined): string | null => valor?.trim() || null;

export function validarLinkCta(valor: string | null | undefined): Destino | null {
    const link = normalizar(valor);
    if (!link || /[\s\\\u0000-\u001f\u007f]/.test(link)) return null;
    if (link.startsWith('/')) {
        if (link.startsWith('//')) return null;
        // Impedir formas codificadas de controles, barras invertidas e //host.
        try {
            const decoded = decodeURIComponent(link);
            if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return null;
        } catch { return null; }
        return { tipoLink: 'interno', link };
    }
    if (!/^https?:\/\//i.test(link)) return null;
    try {
        const url = new URL(link);
        return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
            ? { tipoLink: 'externo', link } : null;
    } catch { return null; }
}

// O detalhe entrega DATETIME civil como YYYY-MM-DD HH:mm:ss (dateStrings localizado).
// Não reinterpretar ISO com Z/offset como data civil: a conversão original seria ambígua.
function partesDataCivil(valor: string | Date | null | undefined): number[] | null {
    if (typeof valor !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?)?$/.exec(valor);
    if (!match) return null;
    const [ano, mes, dia, hora = 0, minuto = 0, segundo = 0] = match.slice(1).map(v => v === undefined ? 0 : Number(v));
    const data = new Date(0);
    data.setUTCFullYear(ano, mes - 1, dia);
    data.setUTCHours(hora, minuto, segundo, 0);
    return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia
        && hora <= 23 && minuto <= 59 && segundo <= 59 ? [ano, mes, dia, hora, minuto, segundo] : null;
}

function chaveData(valor: EventoEtapa['data_inicio']): string {
    const partes = partesDataCivil(valor);
    // NULL e datas inválidas primeiro, como NULL em ORDER BY ASC no MariaDB.
    return partes ? partes.map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0')).join('') : '';
}

export function selecionarEtapaRelevante(etapas: readonly EventoEtapa[] | null | undefined): EventoEtapa | null {
    const ordenadas = [...(etapas || [])].sort((a, b) => {
        const ordem = a.ordem - b.ordem;
        const dataA = chaveData(a.data_inicio), dataB = chaveData(b.data_inicio);
        return ordem || (dataA < dataB ? -1 : dataA > dataB ? 1 : 0) || a.id - b.id;
    });
    return ordenadas.find(e => e.status === 'Em_Andamento')
        || ordenadas.find(e => e.status === 'Pendente')
        || ordenadas.filter(e => e.status === 'Concluido').at(-1) || null;
}

function ordinal(ano: number, mes: number, dia: number): number {
    const data = new Date(0);
    data.setUTCFullYear(ano, mes - 1, dia);
    data.setUTCHours(0, 0, 0, 0);
    return data.getTime() / 86400000;
}

export function calcularContagemEtapa(dataInicio: EventoEtapa['data_inicio'], agora: Date): Pick<Contexto, 'contagem' | 'diasRestantes' | 'divergenciaDataStatus'> {
    const semContagem = { contagem: null, diasRestantes: null, divergenciaDataStatus: false };
    const inicio = partesDataCivil(dataInicio);
    if (!inicio || !Number.isFinite(agora.getTime())) return semContagem;
    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: CTA_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(agora);
    const obter = (tipo: string) => Number(partes.find(p => p.type === tipo)?.value);
    const dias = ordinal(inicio[0], inicio[1], inicio[2]) - ordinal(obter('year'), obter('month'), obter('day'));
    if (dias < 0) return { ...semContagem, divergenciaDataStatus: true };
    return { diasRestantes: dias, divergenciaDataStatus: false,
        contagem: dias === 0 ? 'Começa hoje' : dias === 1 ? 'Falta 1 dia' : `Faltam ${dias} dias` };
}

const labels: Record<EtapaStatus, string> = { Pendente: 'Pendente', Em_Andamento: 'Em andamento', Concluido: 'Concluído' };
const campos = {
    Pendente: ['cta_etapa_pendente', 'link_etapa_pendente'],
    Em_Andamento: ['cta_etapa_andamento', 'link_etapa_andamento'],
    Concluido: ['cta_etapa_concluido', 'link_etapa_concluido']
} as const;

export function resolverEventoCta(evento: Evento, agora: Date): EventoCtaResolvido {
    const etapa = selecionarEtapaRelevante(evento.etapas);
    const par = etapa ? campos[etapa.status] : null;
    const texto = normalizar(etapa && par ? etapa[par[0]] : evento.etapas?.length ? null : evento.texto_cta);
    const link = normalizar(etapa && par ? etapa[par[1]] : evento.etapas?.length ? null : evento.link_cta);
    const destino = validarLinkCta(link);
    const contexto: Contexto = {
        etapa, statusLabel: etapa ? labels[etapa.status] : null,
        contagem: null, diasRestantes: null, divergenciaDataStatus: false,
        configuracaoIncompleta: !!link && (!texto || !destino),
        ...(etapa?.status === 'Pendente' ? calcularContagemEtapa(etapa.data_inicio, agora) : {})
    };
    if (!texto) return { ...contexto, estado: 'oculto', texto: null, link: null, tipoLink: null };
    if (!destino) return { ...contexto, estado: 'informativo', texto, link: null, tipoLink: null };
    return { ...contexto, estado: 'acao', texto, ...destino };
}
