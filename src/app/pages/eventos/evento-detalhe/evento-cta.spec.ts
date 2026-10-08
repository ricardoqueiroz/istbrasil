import { Evento, EventoEtapa, EtapaStatus } from 'src/app/models/evento.model';
import { calcularContagemEtapa, resolverEventoCta, selecionarEtapaRelevante, validarLinkCta } from './evento-cta';

const agora = new Date('2026-10-07T15:00:00Z');
const etapa = (id: number, status: EtapaStatus = 'Pendente', ordem = id): EventoEtapa => ({
    id, evento_id: 1, titulo: `Etapa ${id}`, status, ordem, data_inicio: '2026-10-15 00:00:00'
});
const evento = (etapas?: EventoEtapa[]): Evento => ({
    id: 1, slug: 'evento', nome: 'Evento', categoria: 'Festival', status: 'Em_Andamento',
    modalidade: 'Presencial', resumo: 'Resumo', destaque: false, etapas,
    texto_cta: 'Legado', link_cta: '/legado'
});

describe('Seleção editorial da etapa', () => {
    it('prioriza andamento mesmo após pendente', () => expect(selecionarEtapaRelevante([etapa(1), etapa(2, 'Em_Andamento')])?.id).toBe(2));
    it('primeira pendente vence sem andamento', () => expect(selecionarEtapaRelevante([etapa(2), etapa(1)])?.id).toBe(1));
    it('última concluída vence', () => expect(selecionarEtapaRelevante([etapa(3, 'Concluido'), etapa(1, 'Concluido')])?.id).toBe(3));
    it('sem etapas retorna null', () => { expect(selecionarEtapaRelevante([])).toBeNull(); expect(selecionarEtapaRelevante(undefined)).toBeNull(); });
    it('várias em andamento usam ordem e id sem mutar o array', () => {
        const etapas = [etapa(8, 'Em_Andamento', 1), etapa(2, 'Em_Andamento', 1)];
        const antes = JSON.stringify(etapas);
        expect(selecionarEtapaRelevante(etapas)?.id).toBe(2);
        expect(JSON.stringify(etapas)).toBe(antes);
    });
    it('data desempata antes do id', () => {
        const a = etapa(1, 'Pendente', 1), b = etapa(2, 'Pendente', 1);
        b.data_inicio = '2026-10-14 00:00:00';
        expect(selecionarEtapaRelevante([a, b])?.id).toBe(2);
    });
    it('data nula vem primeiro, com id como desempate', () => {
        const a = etapa(1), b = etapa(2, 'Pendente', 1); b.data_inicio = null;
        expect(selecionarEtapaRelevante([a, b])?.id).toBe(2);
    });
});

describe('Links do CTA', () => {
    for (const link of ['/cadastro/concorrente', '/eventos/abc']) it(`aceita interno ${link}`, () => expect(validarLinkCta(link)?.tipoLink).toBe('interno'));
    for (const link of ['https://example.com', 'http://example.com']) it(`aceita externo ${link}`, () => expect(validarLinkCta(link)?.tipoLink).toBe('externo'));
    for (const link of ['//example.com', 'javascript:alert(1)', 'data:text/html,x', 'inválida', '', '#', '/\\host', '/%2fhost', '/%00', 'https://', '/erro%']) {
        it(`bloqueia ${link}`, () => expect(validarLinkCta(link)).toBeNull());
    }
});

describe('Resolução CTA', () => {
    for (const [status, sufixo] of [['Pendente', 'pendente'], ['Em_Andamento', 'andamento'], ['Concluido', 'concluido']] as const) {
        it(`usa campos de ${status}`, () => {
            const e = { ...etapa(1, status), [`cta_etapa_${sufixo}`]: ' Texto ', [`link_etapa_${sufixo}`]: ' /eventos/abc ' };
            const cta = resolverEventoCta(evento([e]), agora);
            expect(cta.estado).toBe('acao'); expect(cta.texto).toBe('Texto'); expect(cta.link).toBe('/eventos/abc');
        });
    }
    it('texto sem link informa', () => expect(resolverEventoCta(evento([{ ...etapa(1), cta_etapa_pendente: 'Em breve' }]), agora).estado).toBe('informativo'));
    it('ambos null ocultam sem legado', () => expect(resolverEventoCta(evento([{ ...etapa(1), cta_etapa_pendente: null, link_etapa_pendente: null }]), agora).estado).toBe('oculto'));
    it('link sem texto oculta e marca incompleto', () => {
        const cta = resolverEventoCta(evento([{ ...etapa(1), link_etapa_pendente: '/evento' }]), agora);
        expect(cta.estado).toBe('oculto'); expect(cta.configuracaoIncompleta).toBeTrue(); expect(cta.link).toBeNull();
    });
    it('espaços equivalem a ausência', () => expect(resolverEventoCta(evento([{ ...etapa(1), cta_etapa_pendente: '  ', link_etapa_pendente: '  ' }]), agora).estado).toBe('oculto'));
    it('link inválido preserva texto informativo', () => {
        const cta = resolverEventoCta(evento([{ ...etapa(1), cta_etapa_pendente: 'Texto', link_etapa_pendente: 'javascript:alert(1)' }]), agora);
        expect(cta.estado).toBe('informativo'); expect(cta.configuracaoIncompleta).toBeTrue(); expect(cta.link).toBeNull();
    });
    it('sem etapas usa legado', () => {
        expect(resolverEventoCta(evento([]), agora).texto).toBe('Legado');
        expect(resolverEventoCta(evento(), agora).estado).toBe('acao');
    });
    it('legado também bloqueia protocolo perigoso', () => expect(resolverEventoCta({ ...evento(), link_cta: 'javascript:alert(1)' }, agora).estado).toBe('informativo'));
    it('não conta etapa em andamento nem altera status pendente vencido', () => {
        expect(resolverEventoCta(evento([etapa(1, 'Em_Andamento')]), agora).contagem).toBeNull();
        const e = { ...etapa(1), data_inicio: '2026-10-01' };
        expect(resolverEventoCta(evento([e]), agora).divergenciaDataStatus).toBeTrue(); expect(e.status).toBe('Pendente');
    });
});

describe('Contagem civil America/Santarem', () => {
    for (const [data, texto] of [['2026-10-15', 'Faltam 8 dias'], ['2026-10-08 10:00:00', 'Falta 1 dia'], ['2026-10-07 23:59:59', 'Começa hoje']]) {
        it(texto, () => expect(calcularContagemEtapa(data, agora).contagem).toBe(texto));
    }
    it('passado não produz negativo', () => {
        const c = calcularContagemEtapa('2026-10-06', agora);
        expect(c.contagem).toBeNull(); expect(c.diasRestantes).toBeNull(); expect(c.divergenciaDataStatus).toBeTrue();
    });
    for (const data of [null, undefined, '', 'inválida', '2026-02-30', '2026-10-08 25:00:00', '2026-10-08T00:00:00Z']) {
        it(`ignora data inválida/ambígua ${data}`, () => expect(calcularContagemEtapa(data, agora).contagem).toBeNull());
    }
    it('virada do dia usa Santarém, não UTC ou navegador', () => {
        expect(calcularContagemEtapa('2026-10-08', new Date('2026-10-08T02:59:59Z')).contagem).toBe('Falta 1 dia');
        expect(calcularContagemEtapa('2026-10-08', new Date('2026-10-08T03:00:00Z')).contagem).toBe('Começa hoje');
        expect(calcularContagemEtapa('2026-10-08', new Date('2026-10-07T23:59:59-03:00')).contagem).toBe('Falta 1 dia');
    });
});
