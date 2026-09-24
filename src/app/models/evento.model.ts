// Tipos literais para controle estrito de status e modalidades
export type EventoStatus = 
  | 'Rascunho' 
  | 'Breve' 
  | 'Inscricoes_Abertas' 
  | 'Em_Andamento' 
  | 'Concluido' 
  | 'Cancelado';

export type EventoModalidade = 'Presencial' | 'Virtual' | 'Hibrido';

export type EtapaStatus = 'Pendente' | 'Em_Andamento' | 'Concluido';

// Interface da Tabela Principal: ist_eventos
export interface Evento {
  id: number;
  slug: string;
  nome: string;
  subtitulo?: string;
  categoria: string;
  status: EventoStatus;
  modalidade: EventoModalidade;
  resumo: string;
  descricao_completa?: string;
  imagem_card_url?: string;
  banner_capa_url?: string;
  data_inicio?: string | Date;
  data_fim?: string | Date;
  local_nome?: string;
  endereco?: string;
  cidade?: string;
  estado?: string;
  valor_inscricao?: string;
  link_cta?: string;
  texto_cta?: string;
  destaque: boolean | number;
  criado_em?: string | Date;
  atualizado_em?: string | Date;

  // Relacionamentos opcionais (tabelas filhas retornadas pela API)
  etapas?: EventoEtapa[];
  documentos?: EventoDocumento[];
  programacao?: EventoProgramacao[];
}

// Interface da Tabela Filha: ist_eventos_etapas
export interface EventoEtapa {
  id: number;
  evento_id: number;
  titulo: string;
  descricao?: string;
  data_inicio?: string | Date;
  data_fim?: string | Date;
  status: EtapaStatus;
  ordem: number;
}

// Interface da Tabela Filha: ist_eventos_documentos
export interface EventoDocumento {
  id: number;
  evento_id: number;
  titulo: string;
  arquivo_url: string;
  formato?: string;
  tamanho?: string;
  ordem: number;
}

// Interface da Tabela Filha: ist_eventos_programacao
export interface EventoProgramacao {
  id: number;
  evento_id: number;
  data_horario?: string | Date;
  atracao: string;
  papel_atracao?: string;
  descricao?: string;
  palco_local?: string;
  ordem: number;
}