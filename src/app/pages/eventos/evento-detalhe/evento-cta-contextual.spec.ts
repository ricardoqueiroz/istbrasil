import { Evento } from 'src/app/models/evento.model';
import { UsuarioLogado } from 'src/app/shared/auth.service';
import { PerfilResponse } from '../../perfil/models/perfil.model';
import { resolverEventoCta } from './evento-cta';
import { FESTIVAL_II_SLUG, personalizarEventoCta } from './evento-cta-contextual';

describe('CTA contextual Festival II', () => {
    const evento: Evento = { id: 1, slug: FESTIVAL_II_SLUG, nome: 'Festival', categoria: 'Festival',
        status: 'Em_Andamento', modalidade: 'Virtual', resumo: '', destaque: false,
        etapas: [{ id: 1, evento_id: 1, titulo: 'Título editorial alterado', ordem: 8, status: 'Em_Andamento',
            cta_etapa_andamento: 'CTA padrão', link_etapa_andamento: '/padrao' }] };
    const usuario: UsuarioLogado = { id_usuario: 7, id_tipo_usuario: 2, nome: 'Concorrente', foto_url: null };
    const perfil = { usuario: { idUsuario: 7, idTipoUsuario: 2 }, concorrente: {
        idEvento: 1, idConcorrente: 17, idEtapaInscricoes: 1
    } } as PerfilResponse;
    const padrao = resolverEventoCta(evento, new Date('2026-10-07T12:00:00Z'));
    const executar = (u: UsuarioLogado | null = usuario, p: PerfilResponse | null = perfil, e: Evento = evento) =>
        personalizarEventoCta(padrao, e, u, p);
    it('visitante mantém padrão', () => expect(executar(null)).toBe(padrao));
    it('externo mantém padrão', () => expect(executar({ ...usuario, id_tipo_usuario: 3 })).toBe(padrao));
    it('perfil ausente mantém padrão', () => expect(executar(usuario, null)).toBe(padrao));
    it('sem inscrição mantém padrão', () => expect(executar(usuario, { ...perfil, concorrente: null })).toBe(padrao));
    it('perfil de outro usuário mantém padrão', () => expect(executar({ ...usuario, id_usuario: 8 })).toBe(padrao));
    it('perfil não concorrente mantém padrão', () => expect(executar(usuario, { ...perfil, usuario: { ...perfil.usuario, idTipoUsuario: 3 } })).toBe(padrao));
    it('participação de outro evento mantém padrão', () => expect(executar(usuario, { ...perfil, concorrente: { ...perfil.concorrente!, idEvento: 2 } })).toBe(padrao));
    it('outro festival mantém padrão', () => expect(executar(usuario, perfil, { ...evento, slug: 'outro-festival' })).toBe(padrao));
    for (const status of ['Pendente', 'Concluido'] as const) it(`${status} não personaliza`, () => {
        const e = { ...evento, etapas: [{ ...evento.etapas![0], status }] };
        const cta = resolverEventoCta(e, new Date());
        expect(personalizarEventoCta(cta, e, usuario, perfil)).toBe(cta);
    });
    it('outra etapa em andamento não personaliza', () => expect(executar(usuario, { ...perfil, concorrente: { ...perfil.concorrente!, idEtapaInscricoes: 2 } })).toBe(padrao));
    it('etapa de outro evento não personaliza', () => {
        const cta = { ...padrao, etapa: { ...padrao.etapa!, evento_id: 2 } };
        expect(personalizarEventoCta(cta, evento, usuario, perfil)).toBe(cta);
    });
    for (const idEtapaInscricoes of [null, undefined, 0]) it(`configuração ${idEtapaInscricoes} mantém padrão`, () =>
        expect(executar(usuario, { ...perfil, concorrente: { ...perfil.concorrente!, idEtapaInscricoes } })).toBe(padrao));
    it('participação sem ID válido mantém padrão', () => expect(executar(usuario, { ...perfil, concorrente: { ...perfil.concorrente!, idConcorrente: 0 } })).toBe(padrao));
    it('usa ID, preserva contexto e não muta dados editoriais', () => {
        const antes = JSON.stringify({ evento, padrao, perfil });
        const cta = executar();
        expect(cta.estado).toBe('acao'); expect(cta.texto).toBe('Enviar seu vídeo');
        expect(cta.link).toBe('/cadastro/concorrente/videos'); expect(cta.tipoLink).toBe('interno');
        expect(cta.etapa).toBe(padrao.etapa); expect(cta.statusLabel).toBe(padrao.statusLabel);
        expect(JSON.stringify({ evento, padrao, perfil })).toBe(antes);
    });
});
