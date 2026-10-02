import { pool as db } from '../config/db.js';

export const CAMPOS_ORDENACAO_FILA = Object.freeze({
    numeroConcorrente: 'c.numero_concorrente',
    dataInscricao: 'c.data_cadastro',
    nome: 'u.nome'
});

const SQL_BASE_FILA = `FROM ist_concorrentes c
    INNER JOIN ist_usuarios u ON u.id_usuario = c.id_usuario
    INNER JOIN ist_composicao obra1 ON obra1.id_obra = c.id_obra_1
    LEFT JOIN ist_composicao obra2 ON obra2.id_obra = c.id_obra_2
    WHERE c.id_evento = ?
      AND c.aceite_regulamento = 1
      AND c.numero_concorrente IS NOT NULL
      AND TRIM(c.numero_concorrente) <> ''
      AND c.id_obra_1 IS NOT NULL
      AND c.link_video_1 IS NOT NULL
      AND TRIM(c.link_video_1) <> ''`;

const SQL_PROJECAO_CONCORRENTE = `SELECT c.id_concorrente, c.numero_concorrente, u.nome, u.cidade, u.uf,
        c.data_cadastro, c.id_obra_1,
        COALESCE(obra1.titulo, obra1.obra) AS titulo_obra_1, c.link_video_1,
        c.id_obra_2, COALESCE(obra2.titulo, obra2.obra) AS titulo_obra_2,
        c.link_video_2`;

export const consultarFilaJurado = async (idEvento, { page, limit, sort, order }, executor = db) => {
    if (!Object.prototype.hasOwnProperty.call(CAMPOS_ORDENACAO_FILA, sort)) {
        throw new Error('Ordenacao da fila invalida.');
    }
    const coluna = CAMPOS_ORDENACAO_FILA[sort];
    const direcao = order === 'desc' ? 'DESC' : 'ASC';
    const [totalRows] = await executor.query(`SELECT COUNT(*) AS total ${SQL_BASE_FILA}`, [idEvento]);
    const [rows] = await executor.query(
        `${SQL_PROJECAO_CONCORRENTE}
         ${SQL_BASE_FILA}
         ORDER BY ${coluna} ${direcao}, c.id_concorrente ASC
         LIMIT ? OFFSET ?`,
        [idEvento, limit, (page - 1) * limit]
    );

    return { rows, total: Number(totalRows[0]?.total) || 0 };
};

export const consultarConcorrenteJurado = async (idEvento, idParticipacao, executor = db) => {
    const [rows] = await executor.query(
        `${SQL_PROJECAO_CONCORRENTE} ${SQL_BASE_FILA} AND c.id_concorrente = ?`,
        [idEvento, idParticipacao]
    );
    return rows[0] || null;
};