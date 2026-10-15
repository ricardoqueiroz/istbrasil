import { criarLojaSessaoService } from '../src/services/lojaSessaoService.js';

export const criarAmbiente = () => {
    const registros = new Map();
    const chamadas = [];
    let instante = new Date('2026-10-15T12:34:56.123Z');
    let falha;
    const db = { execute: async (sql, params) => {
        chamadas.push({ sql, params });
        if (falha) throw falha;
        const formatar = (s) => s.replace(' ', 'T') + '000Z';
        if (sql.startsWith('SELECT')) return [[registros.get(params[0].toString('hex'))].filter(Boolean)];
        if (sql.startsWith('INSERT')) {
            const chave = params[0].toString('hex');
            if (registros.has(chave)) throw Object.assign(new Error('duplicado'), { code: 'ER_DUP_ENTRY' });
            const id = registros.size + 1;
            registros.set(chave, { id, criada_em_utc: formatar(params[1]), expira_em_utc: formatar(params[2]), revogada: 0 });
            return [{ insertId: id }];
        }
        if (sql.startsWith('UPDATE')) {
            const linha = registros.get(params[1].toString('hex'));
            if (!linha || linha.revogada) return [{ affectedRows: 0 }];
            linha.revogada = 1;
            return [{ affectedRows: 1 }];
        }
        throw new Error('SQL inesperado');
    } };
    const agora = () => new Date(instante);
    return { db, registros, chamadas, agora, service: criarLojaSessaoService({ db, agora }),
        avancar: (ms) => { instante = new Date(instante.getTime() + ms); },
        falhar: () => { falha = new Error('senha e SQL privados'); } };
};
