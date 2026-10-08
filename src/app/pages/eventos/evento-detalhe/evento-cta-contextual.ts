import { Evento } from 'src/app/models/evento.model';
import { UsuarioLogado } from 'src/app/shared/auth.service';
import { PerfilResponse } from '../../perfil/models/perfil.model';
import { EventoCtaResolvido } from './evento-cta';

// Mesmo slug canônico de FESTIVAL_II; o ID dependente do ambiente vem do perfil validado.
export const FESTIVAL_II_SLUG = 'ii-festival-de-violoes-sebastiao-tapajos';

export function personalizarEventoCta(padrao: EventoCtaResolvido, evento: Evento,
    usuario: UsuarioLogado | null, perfil: PerfilResponse | null): EventoCtaResolvido {
    const participacao = perfil?.concorrente;
    const etapa = padrao.etapa;
    if (!usuario || usuario.id_tipo_usuario !== 2 || perfil?.usuario.idUsuario !== usuario.id_usuario
        || perfil.usuario.idTipoUsuario !== 2 || evento.slug !== FESTIVAL_II_SLUG
        || !participacao || participacao.idEvento !== evento.id
        || !Number.isSafeInteger(participacao.idConcorrente) || participacao.idConcorrente! <= 0
        || !etapa || etapa.evento_id !== evento.id || etapa.status !== 'Em_Andamento'
        || !Number.isSafeInteger(participacao.idEtapaInscricoes) || participacao.idEtapaInscricoes! <= 0
        || etapa.id !== participacao.idEtapaInscricoes) return padrao;
    return { ...padrao, estado: 'acao', texto: 'Enviar seu vídeo',
        link: '/cadastro/concorrente/videos', tipoLink: 'interno' };
}
