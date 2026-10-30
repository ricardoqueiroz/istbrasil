import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CarrinhoErro, LojaPedido, LojaSolicitacaoPedido } from '../pages/loja/models/loja.model';
import { CARRINHO_STORAGE } from './carrinho.service';
import { LojaService } from './loja.service';

export const PEDIDO_PENDENTE_STORAGE_KEY = 'ist.loja.pedido.pendente';
interface TentativaPedido {
    chave: string;
    entrada: LojaSolicitacaoPedido;
    expiraEm: string;
    totalCotado: number;
}
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idValido = (id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0 && Number(id) <= 2147483647;

// Estado da tentativa separado do carrinho: navegar/recarregar nao troca a chave
// nem o payload de um POST cujo resultado pode ter sido perdido.
@Injectable({ providedIn: 'root' })
export class LojaPedidoService {
    private readonly loja = inject(LojaService);
    private readonly storage = inject(CARRINHO_STORAGE);
    private readonly tentativaEstado = signal<TentativaPedido | null>(null);
    readonly pendente = this.tentativaEstado.asReadonly();
    readonly processando = signal(false);
    readonly erro = signal<CarrinhoErro | null>(null);
    readonly confirmado = signal<LojaPedido | null>(null);
    readonly precoAlterado = signal(false);
    readonly emailConfirmado = signal<string | null>(null);
    private armazenamentoInvalido = false;

    continuarComprando(): void {
        if (!this.processando()) {
            this.confirmado.set(null);
            this.emailConfirmado.set(null);
        }
    }

    constructor() {
        try {
            const texto = this.storage?.getItem(PEDIDO_PENDENTE_STORAGE_KEY);
            if (!texto) return;
            const t = JSON.parse(texto) as TentativaPedido;
            if (!t || !uuidV4.test(t.chave) || typeof t.entrada?.compradorEmail !== 'string'
                || !Array.isArray(t.entrada.produtoIds) || !t.entrada.produtoIds.length || t.entrada.produtoIds.length > 100
                || !t.entrada.produtoIds.every(idValido) || new Set(t.entrada.produtoIds).size !== t.entrada.produtoIds.length
                || !Number.isFinite(Date.parse(t.expiraEm)) || !Number.isSafeInteger(t.totalCotado) || t.totalCotado <= 0) throw new Error();
            this.tentativaEstado.set(t);
        } catch {
            this.armazenamentoInvalido = true;
            this.falhar('TENTATIVA_IRRECUPERAVEL', 'Não foi possível recuperar a tentativa anterior. Não envie outro pedido antes de verificar o resultado com o atendimento.');
        }
    }

    async confirmar(entrada: LojaSolicitacaoPedido, totalCotado: number): Promise<void> {
        if (this.processando() || this.confirmado() || this.armazenamentoInvalido) return;
        const anterior = this.pendente();
        if (anterior && Date.parse(anterior.expiraEm) <= Date.now()) {
            this.falhar('SESSAO_INVALIDA', 'A sessão da tentativa anterior expirou. Não crie outro pedido antes de verificar o resultado com o atendimento.');
            return;
        }
        this.processando.set(true);
        this.erro.set(null);
        let enviado = false;
        try {
            const resposta = await firstValueFrom(this.loja.estabelecerSessao());
            const csrf = resposta.headers.get('X-CSRF-Token');
            const expiraEm = resposta.body?.sessao?.expiraEm;
            if (anterior && (resposta.status !== 200 || expiraEm !== anterior.expiraEm)) {
                this.falhar('SESSAO_INVALIDA', 'Não foi possível reutilizar a sessão original. Habilite os cookies e verifique o pedido anterior com o atendimento antes de criar outro.');
                return;
            }
            if (!csrf || !expiraEm || !Number.isFinite(Date.parse(expiraEm)) || Date.parse(expiraEm) <= Date.now()) {
                this.falhar('SESSAO_INVALIDA', 'Não foi possível estabelecer uma sessão válida. Verifique os cookies e tente novamente.');
                return;
            }
            const tentativa = anterior ?? {
                chave: this.gerarChave(),
                entrada: { produtoIds: [...entrada.produtoIds], compradorEmail: entrada.compradorEmail },
                expiraEm, totalCotado
            };
            // Persistir antes do envio. Se o armazenamento falhar, nenhum POST sai.
            if (!anterior) {
                if (!this.storage) throw new Error('ARMAZENAMENTO');
                this.storage.setItem(PEDIDO_PENDENTE_STORAGE_KEY, JSON.stringify(tentativa));
                this.tentativaEstado.set(tentativa);
            }
            enviado = true;
            const pedido = await firstValueFrom(this.loja.criarPedido(tentativa.entrada, tentativa.chave, csrf));
            this.emailConfirmado.set(tentativa.entrada.compradorEmail);
            this.confirmado.set(pedido);
            this.precoAlterado.set(pedido.totalCentavos !== tentativa.totalCotado);
            this.tentativaEstado.set(null);
            // Uma falha de limpeza nao transforma um pedido confirmado em erro.
            try { this.storage?.removeItem(PEDIDO_PENDENTE_STORAGE_KEY); } catch { /* Replay continua seguro. */ }
        } catch (erro: unknown) {
            const status = erro instanceof HttpErrorResponse ? erro.status : 0;
            const codigo = erro instanceof HttpErrorResponse ? erro.error?.erro?.codigo : undefined;
            // Uma recusa na repeticao nao prova que o POST anterior nao persistiu.
            const recusasConhecidas: Record<string, number> = {
                SOLICITACAO_INVALIDA: 400, IDEMPOTENCIA_INVALIDA: 400, JSON_INVALIDO: 400, CONTEUDO_INVALIDO: 400,
                SESSAO_INVALIDA: 401, ORIGEM_INVALIDA: 403, CSRF_INVALIDO: 403, CORPO_MUITO_GRANDE: 413,
                SELECAO_INVALIDA: 422, EMAIL_INVALIDO: 422, PRODUTO_INDISPONIVEL: 422, LIMITE_REQUISICOES: 429
            };
            if (!anterior && enviado && typeof codigo === 'string'
                && Object.hasOwn(recusasConhecidas, codigo) && recusasConhecidas[codigo] === status) {
                try {
                    this.storage?.removeItem(PEDIDO_PENDENTE_STORAGE_KEY);
                    this.tentativaEstado.set(null);
                } catch { /* Preservar a tentativa se nao puder remover o registro. */ }
            }
            const mensagens: Record<string, string> = {
                SESSAO_INVALIDA: 'Sessão inválida ou expirada. Verifique se os cookies estão habilitados e tente novamente.',
                CSRF_INVALIDO: 'A proteção da solicitação expirou. Tente novamente para obter uma proteção atualizada.',
                PRODUTO_INDISPONIVEL: 'Um ou mais produtos estão indisponíveis. Atualize a cotação e revise o carrinho.',
                EMAIL_INVALIDO: 'Informe um endereço de e-mail válido.',
                CONFLITO_IDEMPOTENCIA: 'A tentativa conflita com um pedido anterior. Não crie outro pedido; entre em contato com o atendimento.',
                ORIGEM_INVALIDA: 'Esta origem não está autorizada a criar pedidos.',
                LIMITE_REQUISICOES: 'Muitas tentativas. Aguarde um minuto antes de tentar novamente.'
            };
            this.falhar(typeof codigo === 'string' ? codigo : 'FALHA_PEDIDO',
                (typeof codigo === 'string' && Object.hasOwn(mensagens, codigo) && mensagens[codigo]) || (enviado || anterior
                    ? 'Não foi possível confirmar o resultado. Tente novamente: a mesma solicitação será reutilizada para evitar duplicação.'
                    : 'Não foi possível preparar o pedido. Verifique a conexão e o armazenamento do navegador e tente novamente.'), status);
        } finally {
            this.processando.set(false);
        }
    }

    private gerarChave(): string {
        // getRandomValues tambem funciona no HTTP local; nunca usar Math.random.
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    private falhar(codigo: string, mensagem: string, status = 0): void {
        this.erro.set({ codigo, mensagem, status });
    }
}
