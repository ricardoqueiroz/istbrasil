// Tipos literais para controle estrito de status e modalidades
export type ProjetoStatus =
    'Em Planejamento'
  | 'Captação de Recursos'
  | 'Pré-produção'
  | 'Produção'
  | 'Pós-produção'
  | 'Prestação de contas'
  | 'Concluído'
  | 'Cancelado';

export interface ProjetoTipicidade {
  id: number;
  tipicidade: string;
}

export interface ProjetoTipologia {
  id: number;
  id_tipicidade: number;
  tipologia: string;
}

// Interface da Tabela Principal: ist_projetos
export interface Projeto {
  id: number;
  id_tipicidade: number;
  id_tipologia: number;
  tipicidade: string;
  tipologia: string;
  slug: string;
  nome: string;
  subtitulo?: string | null;
  status: ProjetoStatus;
  resumo: string;
  descricao_completa?: string | null;
  imagem_card_url?: string | null;
  banner_capa_url?: string | null;
  data_inicio?: string | null;
  data_fim?: string | null;
  local_nome?: string | null;
  endereco?: string | null;
  cidade?: string | null;
  estado?: string | null;
  mecanismo?: string | null;
  link_cta?: string | null;
  texto_cta?: string | null;
  destaque: boolean;
  criado_em?: string | null;
  atualizado_em?: string | null;

  // Relacionamentos opcionais (tabelas filhas retornadas pela API)
  documentos?: ProjetoDocumento[];
}

// Interface da Tabela Filha: ist_projetos_documentos
export interface ProjetoDocumento {
  id: number;
  projeto_id: number;
  titulo: string;
  arquivo_url: string;
  formato?: string | null;
  tamanho?: string | null;
  ordem: number;
  criado_em?: string | null;
}
