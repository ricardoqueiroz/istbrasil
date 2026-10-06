import { pool as db } from '../config/db.js';
import { obterAvaliacaoJuradoCycleAware } from './juradoAvaliacaoLeituraService.js';

const logCleanup = etapa => {
    try { console.error('Falha de cleanup de leitura HTTP de avaliacao cycle-aware.', { etapa }); }
    catch { /* Logging nao substitui a operacao ou o cleanup. */ }
};

// Adapter de infraestrutura: o reader continua sem gerenciar transacao.
// Mesmo protocolo de snapshot/cleanup da navegacao, sem queries de dominio adicionais.
export const obterAvaliacaoJuradoHttpCycleAware = async (
    evento, idParticipacao, idUsuario, poolExecutor = db, reader = obterAvaliacaoJuradoCycleAware
) => {
    let connection;
    let started = false;
    let reusable = false;
    let commitAttempted = false;
    let destroyed = false;
    const destruir = () => {
        reusable = false;
        if (destroyed) return;
        destroyed = true;
        try { connection.destroy(); } catch { logCleanup('destroy'); }
    };
    try {
        connection = await poolExecutor.getConnection();
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        started = true;
        reusable = true;
        const dto = await reader(evento, idParticipacao, idUsuario, connection);
        commitAttempted = true;
        reusable = false;
        await connection.commit();
        started = false;
        reusable = true;
        return dto;
    } catch (error) {
        if (connection && started) {
            try {
                await connection.rollback();
                reusable = !commitAttempted;
            } catch {
                reusable = false;
                logCleanup('rollback');
            }
        }
        throw error;
    } finally {
        if (connection) {
            if (!reusable) destruir();
            else {
                try { connection.release(); }
                catch {
                    logCleanup('release');
                    destruir();
                }
            }
        }
    }
};
