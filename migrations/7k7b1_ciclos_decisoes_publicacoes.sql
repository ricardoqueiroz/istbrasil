-- 7K.7B.1: ciclos, decisoes e publicacoes.
-- Migration manual, somente apos revisar o preflight. NAO executar em producao.
-- Compatibilidade alvo: MariaDB 10.3.39 e MySQL 8.0.39.
-- Esta migration NAO e rerunnable. Qualquer execucao parcial exige revisao
-- manual; nao reiniciar o arquivo nem tentar repetir etapas automaticamente.
--
-- O DDL implica commits no MySQL/MariaDB. Execute uma etapa por vez, na mesma
-- conexao: PRECHECK -> DDL ADITIVO -> BACKFILL -> VALIDATION GATE -> DDL FINAL.
-- DDL FINAL: FINAL-A -> VALIDATION-A -> FINAL-B -> VALIDATION-B -> FINAL-C.
-- Aplicacao limpa sobre 7K.6 somente; NAO usar este arquivo para continuar
-- um banco parcialmente migrado. Restauracao exige autorizacao separada.
-- Pare se qualquer preflight/validacao divergir. Nao rode o arquivo inteiro
-- automaticamente. Bloquear escritas 7K.6 antes do DDL ADITIVO e manter a
-- janela de manutencao ate concluir as validacoes finais.
--
-- Pre-requisito: database/7k6a_avaliacoes_schema.sql ja aplicado.
-- Este arquivo nao atualiza ist_eventos.status, nao cria publicacoes e nao
-- implementa regras transacionais de imutabilidade/lifecycle.

-- ============================================================================
-- 0. PREFLIGHT SOMENTE LEITURA
-- ============================================================================
-- Confirme manualmente que as seis tabelas existem, sao InnoDB e correspondem
-- ao DDL 7K.6A mais os dumps versionados. Ausencia/divergencia: PARE.
SELECT t.table_name, t.engine, t.table_collation
FROM information_schema.tables t
WHERE t.table_schema = DATABASE()
  AND t.table_name IN (
    'ist_eventos',
    'ist_eventos_jurados',
    'ist_concorrentes',
    'ist_eventos_criterios_avaliacao',
    'ist_eventos_avaliacoes',
    'ist_eventos_avaliacoes_notas'
  )
ORDER BY t.table_name;

-- Inventario real: nao assumir nomes de constraints/indices.
SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
       kcu.column_name, kcu.referenced_table_name,
       kcu.referenced_column_name, kcu.ordinal_position
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_schema = tc.constraint_schema
 AND kcu.table_name = tc.table_name
 AND kcu.constraint_name = tc.constraint_name
WHERE tc.constraint_schema = DATABASE()
  AND tc.table_name IN (
    'ist_eventos',
    'ist_eventos_jurados',
    'ist_concorrentes',
    'ist_eventos_criterios_avaliacao',
    'ist_eventos_avaliacoes',
    'ist_eventos_avaliacoes_notas'
  )
ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;

SELECT s.table_name, s.index_name, s.non_unique, s.seq_in_index, s.column_name
FROM information_schema.statistics s
WHERE s.table_schema = DATABASE()
  AND s.table_name IN (
    'ist_eventos',
    'ist_eventos_jurados',
    'ist_concorrentes',
    'ist_eventos_criterios_avaliacao',
    'ist_eventos_avaliacoes',
    'ist_eventos_avaliacoes_notas'
  )
ORDER BY s.table_name, s.index_name, s.seq_in_index;

-- A migration e de primeira aplicacao. Qualquer tabela/coluna ja existente
-- com os nomes novos exige revisao manual; nao tentar "retomar" parcialmente.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
    'ist_eventos_julgamentos',
    'ist_eventos_ciclos',
    'ist_eventos_ciclos_jurados',
    'ist_eventos_ciclos_concorrentes',
    'ist_eventos_ciclos_criterios',
    'ist_eventos_decisoes',
    'ist_eventos_decisoes_concorrentes',
    'ist_eventos_decisoes_jurados',
    'ist_eventos_publicacoes',
    'ist_eventos_publicacoes_resultados',
    'ist_eventos_publicacoes_decisoes'
  );

-- Capture counts in this connection before any DDL. Keep this connection open
-- through the backfill and validations.
SET @7k7b1_eval_before := (SELECT COUNT(*) FROM ist_eventos_avaliacoes);
SET @7k7b1_notes_before := (SELECT COUNT(*) FROM ist_eventos_avaliacoes_notas);
SELECT @7k7b1_eval_before AS avaliacoes_antes,
       @7k7b1_notes_before AS notas_antes;

-- O executor deve guardar este resultado fora do banco e comparar por ID
-- depois do BACKFILL e no FINAL AUDIT. Todos os timestamps devem ser identicos.
-- Nao basta comparar contagens, MAX(timestamp) ou checksum agregado.
SELECT id_avaliacao, data_atualizacao
FROM ist_eventos_avaliacoes
ORDER BY id_avaliacao;

-- Resumo por evento e existencia/unicidade do evento II Festival.
SELECT e.id, e.slug, e.nome,
       (SELECT COUNT(*) FROM ist_eventos_criterios_avaliacao c
         WHERE c.id_evento = e.id) AS criterios,
       (SELECT COUNT(*) FROM ist_eventos_avaliacoes a
         WHERE a.id_evento = e.id) AS avaliacoes
FROM ist_eventos e
WHERE EXISTS (SELECT 1 FROM ist_eventos_criterios_avaliacao c
              WHERE c.id_evento = e.id)
   OR EXISTS (SELECT 1 FROM ist_eventos_avaliacoes a
              WHERE a.id_evento = e.id)
ORDER BY e.id;

SELECT COUNT(*) AS ii_festival_eventos
FROM ist_eventos
WHERE slug = 'ii-festival-de-violoes-sebastiao-tapajos';

SELECT e.id, e.slug,
       (SELECT COUNT(*) FROM ist_eventos_criterios_avaliacao c
         WHERE c.id_evento = e.id) AS criterios_ii_festival
FROM ist_eventos e
WHERE e.slug = 'ii-festival-de-violoes-sebastiao-tapajos';
-- Exigir exatamente um evento e ao menos um criterio para o II Festival.
-- Se a consulta anterior retornar zero/mais de uma linha ou criterios = 0: PARE.

-- Cada evento que ja tem avaliacoes, e o II Festival alvo, precisa ter
-- criterios para formar um ciclo julgavel. A contagem deve ser zero.
SELECT e.id, e.slug, COUNT(a.id_avaliacao) AS avaliacoes
FROM ist_eventos e
JOIN ist_eventos_avaliacoes a ON a.id_evento = e.id
LEFT JOIN ist_eventos_criterios_avaliacao c ON c.id_evento = e.id
GROUP BY e.id, e.slug
HAVING COUNT(c.id_criterio) = 0;

-- Todos os resultados abaixo devem ser zero. Se nao forem, PARE antes do DDL.
SELECT 'avaliacao_sem_evento' AS problema, COUNT(*) AS quantidade
FROM ist_eventos_avaliacoes a
LEFT JOIN ist_eventos e ON e.id = a.id_evento
WHERE e.id IS NULL
UNION ALL
SELECT 'avaliacao_jurado_sem_assignment_compativel', COUNT(*)
FROM ist_eventos_avaliacoes a
LEFT JOIN ist_eventos_jurados j
  ON j.id_evento = a.id_evento AND j.id_usuario = a.id_jurado
WHERE j.id_usuario IS NULL
UNION ALL
SELECT 'avaliacao_concorrente_de_outro_evento', COUNT(*)
FROM ist_eventos_avaliacoes a
LEFT JOIN ist_concorrentes c
  ON c.id_concorrente = a.id_concorrente AND c.id_evento = a.id_evento
WHERE c.id_concorrente IS NULL
UNION ALL
SELECT 'nota_sem_avaliacao', COUNT(*)
FROM ist_eventos_avaliacoes_notas n
LEFT JOIN ist_eventos_avaliacoes a ON a.id_avaliacao = n.id_avaliacao
WHERE a.id_avaliacao IS NULL
UNION ALL
SELECT 'nota_criterio_evento_divergente', COUNT(*)
FROM ist_eventos_avaliacoes_notas n
JOIN ist_eventos_avaliacoes a ON a.id_avaliacao = n.id_avaliacao
LEFT JOIN ist_eventos_criterios_avaliacao c
  ON c.id_criterio = n.id_criterio AND c.id_evento = a.id_evento
WHERE c.id_criterio IS NULL
UNION ALL
SELECT 'concorrente_sem_usuario', COUNT(*)
FROM ist_concorrentes c
JOIN ist_eventos e ON e.id = c.id_evento
WHERE (EXISTS (SELECT 1 FROM ist_eventos_criterios_avaliacao ca
               WHERE ca.id_evento = c.id_evento)
    OR EXISTS (SELECT 1 FROM ist_eventos_avaliacoes av
               WHERE av.id_evento = c.id_evento)
    OR e.slug = 'ii-festival-de-violoes-sebastiao-tapajos')
  AND NOT EXISTS (SELECT 1 FROM ist_usuarios u
                  WHERE u.id_usuario = c.id_usuario)
UNION ALL
SELECT 'jurado_sem_usuario', COUNT(*)
FROM ist_eventos_jurados j
JOIN ist_eventos e ON e.id = j.id_evento
WHERE (EXISTS (SELECT 1 FROM ist_eventos_criterios_avaliacao ca
               WHERE ca.id_evento = j.id_evento)
    OR EXISTS (SELECT 1 FROM ist_eventos_avaliacoes av
               WHERE av.id_evento = j.id_evento)
    OR e.slug = 'ii-festival-de-violoes-sebastiao-tapajos')
  AND NOT EXISTS (SELECT 1 FROM ist_usuarios u
                  WHERE u.id_usuario = j.id_usuario)
UNION ALL
SELECT 'assignment_ativo_invalido', COUNT(*)
FROM ist_eventos_jurados j
JOIN ist_eventos e ON e.id = j.id_evento
WHERE (EXISTS (SELECT 1 FROM ist_eventos_criterios_avaliacao ca
               WHERE ca.id_evento = j.id_evento)
    OR EXISTS (SELECT 1 FROM ist_eventos_avaliacoes av
               WHERE av.id_evento = j.id_evento)
    OR e.slug = 'ii-festival-de-violoes-sebastiao-tapajos')
  AND j.ativo NOT IN (0, 1)
UNION ALL
SELECT 'obra_1_sem_composicao', COUNT(*)
FROM ist_concorrentes c
JOIN ist_eventos e ON e.id = c.id_evento
LEFT JOIN ist_composicao o ON o.id_obra = c.id_obra_1
WHERE c.id_obra_1 IS NOT NULL
  AND (EXISTS (SELECT 1 FROM ist_eventos_criterios_avaliacao ca
               WHERE ca.id_evento = c.id_evento)
    OR EXISTS (SELECT 1 FROM ist_eventos_avaliacoes av
               WHERE av.id_evento = c.id_evento))
  AND o.id_obra IS NULL
UNION ALL
SELECT 'obra_2_sem_composicao', COUNT(*)
FROM ist_concorrentes c
JOIN ist_eventos e ON e.id = c.id_evento
LEFT JOIN ist_composicao o ON o.id_obra = c.id_obra_2
WHERE c.id_obra_2 IS NOT NULL
  AND (EXISTS (SELECT 1 FROM ist_eventos_criterios_avaliacao ca
               WHERE ca.id_evento = c.id_evento)
    OR EXISTS (SELECT 1 FROM ist_eventos_avaliacoes av
               WHERE av.id_evento = c.id_evento))
  AND o.id_obra IS NULL;

-- Duplicatas logicas devem ser zero. A UNIQUE 7K.6A normalmente ja impede.
SELECT id_evento, id_jurado, id_concorrente, COUNT(*) AS quantidade
FROM ist_eventos_avaliacoes
GROUP BY id_evento, id_jurado, id_concorrente
HAVING COUNT(*) > 1;

-- id_criterio e PK; esta consulta confirma a ausencia de criterios orfaos
-- antes da chave composta evento/criterio usada pelo snapshot.
SELECT COUNT(*) AS criterios_sem_evento
FROM ist_eventos_criterios_avaliacao c
LEFT JOIN ist_eventos e ON e.id = c.id_evento
WHERE e.id IS NULL;

-- A UNIQUE antiga deve ser encontrada exatamente uma vez, sem assumir seu nome.
SELECT s.index_name, COUNT(*) AS colunas,
       GROUP_CONCAT(s.column_name ORDER BY s.seq_in_index SEPARATOR ',') AS colunas_ordenadas
FROM information_schema.statistics s
WHERE s.table_schema = DATABASE()
  AND s.table_name = 'ist_eventos_avaliacoes'
  AND s.non_unique = 0
  AND s.index_name <> 'PRIMARY'
GROUP BY s.index_name
HAVING COUNT(*) = 3
   AND GROUP_CONCAT(s.column_name ORDER BY s.seq_in_index SEPARATOR ',')
       = 'id_evento,id_jurado,id_concorrente';

-- ============================================================================
-- 1. DDL ADITIVO
-- ============================================================================
-- Execute somente depois de confirmar manualmente todos os preflight acima.
-- quantity_classified e NULL enquanto nao configurada; nao existe default 3.

-- id_criterio e PK, portanto o par evento/criterio e unico por construcao.
-- A chave explicita permite a FK composta do snapshot no MariaDB/MySQL.
ALTER TABLE ist_eventos_criterios_avaliacao
  ADD UNIQUE KEY uq_criterio_evento_id (id_evento, id_criterio);

CREATE TABLE ist_eventos_julgamentos (
  id_evento INT UNSIGNED NOT NULL,
  id_ciclo_atual INT UNSIGNED DEFAULT NULL,
  id_publicacao_vigente INT UNSIGNED DEFAULT NULL,
  quantidade_classificados INT UNSIGNED DEFAULT NULL,
  versao INT UNSIGNED NOT NULL DEFAULT 1,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_evento),
  CONSTRAINT fk_julgamento_evento FOREIGN KEY (id_evento)
    REFERENCES ist_eventos (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_julgamento_classificados CHECK (
    quantidade_classificados IS NULL OR quantidade_classificados > 0
  ),
  CONSTRAINT ck_julgamento_versao CHECK (versao > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ist_eventos_ciclos (
  id_ciclo INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_evento INT UNSIGNED NOT NULL,
  numero_ciclo INT UNSIGNED NOT NULL,
  estado ENUM('aberto','selado') NOT NULL DEFAULT 'aberto',
  id_ciclo_origem INT UNSIGNED DEFAULT NULL,
  id_publicacao_origem INT UNSIGNED DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  criado_por INT DEFAULT NULL,
  publicado_em DATETIME DEFAULT NULL,
  motivo_reabertura VARCHAR(2000) DEFAULT NULL,
  PRIMARY KEY (id_ciclo),
  UNIQUE KEY uq_ciclo_evento_numero (id_evento, numero_ciclo),
  UNIQUE KEY uq_ciclo_evento_id (id_evento, id_ciclo),
  UNIQUE KEY uq_ciclo_id_evento (id_ciclo, id_evento),
  KEY idx_ciclo_origem_evento (id_evento, id_ciclo_origem),
  CONSTRAINT fk_ciclo_evento FOREIGN KEY (id_evento)
    REFERENCES ist_eventos (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_ciclo_origem FOREIGN KEY (id_evento, id_ciclo_origem)
    REFERENCES ist_eventos_ciclos (id_evento, id_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_ciclo_criado_por FOREIGN KEY (criado_por)
    REFERENCES ist_usuarios (id_usuario) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_ciclo_numero CHECK (numero_ciclo > 0),
  CONSTRAINT ck_ciclo_publicacao_estado CHECK (
    (estado = 'aberto' AND publicado_em IS NULL)
    OR (estado = 'selado' AND publicado_em IS NOT NULL)
  ),
  CONSTRAINT ck_ciclo_reabertura CHECK (
    (numero_ciclo = 1 AND id_ciclo_origem IS NULL
      AND id_publicacao_origem IS NULL AND motivo_reabertura IS NULL)
    OR (numero_ciclo > 1 AND id_ciclo_origem IS NOT NULL
      AND id_publicacao_origem IS NOT NULL
      AND motivo_reabertura IS NOT NULL
      AND CHAR_LENGTH(TRIM(motivo_reabertura)) BETWEEN 1 AND 2000)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ist_eventos_ciclos_jurados (
  id_ciclo INT UNSIGNED NOT NULL,
  id_evento INT UNSIGNED NOT NULL,
  id_usuario INT NOT NULL,
  nome_publico VARCHAR(255) NOT NULL,
  assignment_ativo TINYINT(1) NOT NULL,
  tipo_usuario_origem INT NOT NULL,
  situacao_usuario_origem INT UNSIGNED DEFAULT NULL,
  cargo_usuario_origem INT DEFAULT NULL,
  estado_participacao ENUM('incluido','inelegivel','retirado') NOT NULL DEFAULT 'incluido',
  registrado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_ciclo, id_usuario),
  KEY idx_ciclo_jurado_evento (id_evento, id_usuario),
  CONSTRAINT fk_ciclo_jurado_ciclo FOREIGN KEY (id_evento, id_ciclo)
    REFERENCES ist_eventos_ciclos (id_evento, id_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_ciclo_jurado_usuario FOREIGN KEY (id_usuario)
    REFERENCES ist_usuarios (id_usuario) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_ciclo_jurado_assignment CHECK (assignment_ativo IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- O fingerprint e auxiliar para detectar compatibilidade entre snapshots;
-- os campos materializados individualmente sao a fonte canonica.
CREATE TABLE ist_eventos_ciclos_concorrentes (
  id_ciclo_concorrente INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_ciclo INT UNSIGNED NOT NULL,
  id_evento INT UNSIGNED NOT NULL,
  id_concorrente INT UNSIGNED NOT NULL,
  id_usuario INT NOT NULL,
  numero_concorrente VARCHAR(50) DEFAULT NULL,
  nome_publico VARCHAR(255) NOT NULL,
  id_obra_1 INT UNSIGNED DEFAULT NULL,
  obra_1_publica VARCHAR(255) DEFAULT NULL,
  link_video_1 VARCHAR(500) DEFAULT NULL,
  id_obra_2 INT UNSIGNED DEFAULT NULL,
  obra_2_publica VARCHAR(255) DEFAULT NULL,
  link_video_2 VARCHAR(500) DEFAULT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  estado_participacao ENUM(
    'incluido','desistente','desclassificado','inelegivel'
  ) NOT NULL DEFAULT 'incluido',
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_ciclo_concorrente),
  UNIQUE KEY uq_ciclo_concorrente_origem (id_ciclo, id_concorrente),
  UNIQUE KEY uq_ciclo_concorrente_par (id_ciclo, id_ciclo_concorrente),
  UNIQUE KEY uq_ciclo_numero_publico (id_ciclo, numero_concorrente),
  KEY idx_ciclo_concorrente_evento (id_evento, id_concorrente),
  CONSTRAINT fk_ciclo_concorrente_ciclo FOREIGN KEY (id_evento, id_ciclo)
    REFERENCES ist_eventos_ciclos (id_evento, id_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_ciclo_concorrente_origem FOREIGN KEY (id_concorrente)
    REFERENCES ist_concorrentes (id_concorrente)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_ciclo_concorrente_usuario FOREIGN KEY (id_usuario)
    REFERENCES ist_usuarios (id_usuario) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_ciclo_concorrente_nome CHECK (CHAR_LENGTH(TRIM(nome_publico)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ist_eventos_ciclos_criterios (
  id_criterio_ciclo INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_evento INT UNSIGNED NOT NULL,
  id_ciclo INT UNSIGNED NOT NULL,
  id_criterio_origem INT UNSIGNED NOT NULL,
  nome VARCHAR(150) NOT NULL,
  descricao VARCHAR(1000) DEFAULT NULL,
  ordem TINYINT UNSIGNED NOT NULL,
  peso DECIMAL(5,2) NOT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id_criterio_ciclo),
  UNIQUE KEY uq_ciclo_criterio_origem (id_ciclo, id_criterio_origem),
  UNIQUE KEY uq_ciclo_criterio_ordem (id_ciclo, ordem),
  UNIQUE KEY uq_ciclo_criterio_par (id_ciclo, id_criterio_ciclo),
  KEY idx_ciclo_criterio_evento_origem (id_evento, id_criterio_origem),
  CONSTRAINT fk_ciclo_criterio_ciclo FOREIGN KEY (id_evento, id_ciclo)
    REFERENCES ist_eventos_ciclos (id_evento, id_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_ciclo_criterio_origem
    FOREIGN KEY (id_evento, id_criterio_origem)
    REFERENCES ist_eventos_criterios_avaliacao (id_evento, id_criterio)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_ciclo_criterio_nome CHECK (CHAR_LENGTH(TRIM(nome)) > 0),
  CONSTRAINT ck_ciclo_criterio_ordem CHECK (ordem > 0),
  CONSTRAINT ck_ciclo_criterio_peso CHECK (peso > 0 AND peso <= 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A coluna id_ciclo mantem a ligacao tipada entre avaliacao historica e ciclo.
-- Tornar NOT NULL e adicionar as novas chaves somente na etapa FINAL.
ALTER TABLE ist_eventos_avaliacoes
  ADD COLUMN id_ciclo INT UNSIGNED DEFAULT NULL AFTER id_evento,
  ADD COLUMN numero_tentativa INT UNSIGNED NOT NULL DEFAULT 1 AFTER estado,
  ADD COLUMN id_avaliacao_origem INT UNSIGNED DEFAULT NULL AFTER numero_tentativa;

ALTER TABLE ist_eventos_avaliacoes_notas
  ADD COLUMN id_ciclo INT UNSIGNED DEFAULT NULL,
  ADD COLUMN id_criterio_ciclo INT UNSIGNED DEFAULT NULL;

-- ============================================================================
-- 2. BACKFILL
-- ============================================================================
-- Ciclos iniciais somente para eventos com dados 7K.6. Nenhuma publicacao e
-- inferida do status publico do evento. Apenas o II Festival recebe 3; demais
-- eventos permanecem sem configuracao ate decisao administrativa.
INSERT INTO ist_eventos_julgamentos (id_evento, quantidade_classificados)
SELECT e.id,
       CASE WHEN e.slug = 'ii-festival-de-violoes-sebastiao-tapajos'
            THEN 3 ELSE NULL END
FROM ist_eventos e
WHERE EXISTS (SELECT 1 FROM ist_eventos_criterios_avaliacao c
              WHERE c.id_evento = e.id)
   OR EXISTS (SELECT 1 FROM ist_eventos_avaliacoes a
              WHERE a.id_evento = e.id)
   OR e.slug = 'ii-festival-de-violoes-sebastiao-tapajos';

INSERT INTO ist_eventos_ciclos (id_evento, numero_ciclo, estado, criado_em)
SELECT j.id_evento, 1, 'aberto', CURRENT_TIMESTAMP
FROM ist_eventos_julgamentos j;

UPDATE ist_eventos_julgamentos j
JOIN ist_eventos_ciclos c
  ON c.id_evento = j.id_evento AND c.numero_ciclo = 1
SET j.id_ciclo_atual = c.id_ciclo;

INSERT INTO ist_eventos_ciclos_jurados
  (id_ciclo, id_evento, id_usuario, nome_publico, assignment_ativo,
   tipo_usuario_origem, situacao_usuario_origem, cargo_usuario_origem,
   estado_participacao)
SELECT c.id_ciclo, j.id_evento, j.id_usuario, u.nome, j.ativo,
       u.id_tipo_usuario, u.id_situacao, u.id_cargo, 'incluido'
FROM ist_eventos_ciclos c
JOIN ist_eventos_jurados j ON j.id_evento = c.id_evento
JOIN ist_usuarios u ON u.id_usuario = j.id_usuario
WHERE c.numero_ciclo = 1;

INSERT INTO ist_eventos_ciclos_concorrentes
  (id_ciclo, id_evento, id_concorrente, id_usuario, numero_concorrente,
   nome_publico, id_obra_1, obra_1_publica, link_video_1,
   id_obra_2, obra_2_publica, link_video_2, fingerprint)
SELECT c.id_ciclo, p.id_evento, p.id_concorrente, p.id_usuario,
       p.numero_concorrente, u.nome,
       p.id_obra_1, o1.obra, p.link_video_1,
       p.id_obra_2, o2.obra, p.link_video_2,
       -- Fingerprint auxiliar, nao identidade canonica. Os campos snapshot
       -- continuam sendo comparados individualmente pelo backend.
       SHA2(CONCAT(
         IFNULL(CAST(p.id_concorrente AS CHAR), '<NULL>'), CHAR(31),
         IFNULL(CAST(p.id_usuario AS CHAR), '<NULL>'), CHAR(31),
         IFNULL(p.numero_concorrente, '<NULL>'), CHAR(31),
         IFNULL(u.nome, '<NULL>'), CHAR(31),
         IFNULL(CAST(p.id_obra_1 AS CHAR), '<NULL>'), CHAR(31),
         IFNULL(o1.obra, '<NULL>'), CHAR(31),
         IFNULL(p.link_video_1, '<NULL>'), CHAR(31),
         IFNULL(CAST(p.id_obra_2 AS CHAR), '<NULL>'), CHAR(31),
         IFNULL(o2.obra, '<NULL>'), CHAR(31),
         IFNULL(p.link_video_2, '<NULL>')
       ), 256)
FROM ist_eventos_ciclos c
JOIN ist_concorrentes p ON p.id_evento = c.id_evento
JOIN ist_usuarios u ON u.id_usuario = p.id_usuario
LEFT JOIN ist_composicao o1 ON o1.id_obra = p.id_obra_1
LEFT JOIN ist_composicao o2 ON o2.id_obra = p.id_obra_2
WHERE c.numero_ciclo = 1;

INSERT INTO ist_eventos_ciclos_criterios
  (id_evento, id_ciclo, id_criterio_origem, nome, descricao, ordem, peso)
SELECT c.id_evento, c.id_ciclo, a.id_criterio, a.nome, a.descricao, a.ordem, a.peso
FROM ist_eventos_ciclos c
JOIN ist_eventos_criterios_avaliacao a ON a.id_evento = c.id_evento
WHERE c.numero_ciclo = 1;

UPDATE ist_eventos_avaliacoes a
JOIN ist_eventos_ciclos c
  ON c.id_evento = a.id_evento AND c.numero_ciclo = 1
SET a.id_ciclo = c.id_ciclo,
    a.numero_tentativa = 1,
    a.id_avaliacao_origem = NULL,
    a.data_atualizacao = a.data_atualizacao;

UPDATE ist_eventos_avaliacoes_notas n
JOIN ist_eventos_avaliacoes a ON a.id_avaliacao = n.id_avaliacao
JOIN ist_eventos_ciclos_criterios cc
  ON cc.id_ciclo = a.id_ciclo
 AND cc.id_criterio_origem = n.id_criterio
SET n.id_ciclo = a.id_ciclo,
    n.id_criterio_ciclo = cc.id_criterio_ciclo;

-- ============================================================================
-- 3. VALIDACAO POS-BACKFILL (SOMENTE LEITURA)
-- ============================================================================
-- Todos os desvios devem ser zero. A tabela de publicacoes so sera criada na
-- etapa 5; nenhuma linha de publicacao e inserida em qualquer etapa desta fase.
SELECT @7k7b1_eval_before AS avaliacoes_antes,
       COUNT(*) AS avaliacoes_depois,
       COALESCE(SUM(id_ciclo IS NULL OR numero_tentativa <> 1), 0)
         AS avaliacoes_nao_mapeadas
FROM ist_eventos_avaliacoes;

SELECT @7k7b1_notes_before AS notas_antes,
       COUNT(*) AS notas_depois,
       COALESCE(SUM(id_ciclo IS NULL OR id_criterio_ciclo IS NULL), 0)
         AS notas_nao_mapeadas
FROM ist_eventos_avaliacoes_notas;

-- O resultado deve ser zero: nao criar/remover assignments para fazer a FK
-- passar. Se houver avaliacao sem roster congelado, PARE e revise o mapeamento.
SELECT COUNT(*) AS avaliacoes_sem_jurado_no_roster
FROM ist_eventos_avaliacoes a
LEFT JOIN ist_eventos_ciclos_jurados j
  ON j.id_ciclo = a.id_ciclo AND j.id_usuario = a.id_jurado
WHERE j.id_usuario IS NULL;

SELECT COUNT(*) AS julgamentos_sem_ciclo_atual
FROM ist_eventos_julgamentos
WHERE id_ciclo_atual IS NULL;

SELECT COUNT(*) AS ciclos_iniciais_ausentes
FROM ist_eventos_julgamentos j
LEFT JOIN ist_eventos_ciclos c
  ON c.id_evento = j.id_evento AND c.id_ciclo = j.id_ciclo_atual
WHERE c.id_ciclo IS NULL OR c.numero_ciclo <> 1 OR c.estado <> 'aberto';

SELECT
  (SELECT COUNT(*) FROM ist_eventos_ciclos_jurados) AS roster_jurados_depois,
  (SELECT COUNT(*)
   FROM ist_eventos_ciclos c
   JOIN ist_eventos_jurados j ON j.id_evento = c.id_evento
   WHERE c.numero_ciclo = 1) AS roster_jurados_esperado,
  (SELECT COUNT(*) FROM ist_eventos_ciclos_concorrentes) AS participantes_depois,
  (SELECT COUNT(*)
   FROM ist_eventos_ciclos c
   JOIN ist_concorrentes p ON p.id_evento = c.id_evento
   WHERE c.numero_ciclo = 1) AS participantes_esperado,
  (SELECT COUNT(*) FROM ist_eventos_ciclos_criterios) AS criterios_depois,
  (SELECT COUNT(*)
   FROM ist_eventos_ciclos c
   JOIN ist_eventos_criterios_avaliacao a ON a.id_evento = c.id_evento
   WHERE c.numero_ciclo = 1) AS criterios_esperado;

SELECT COUNT(*) AS avaliacoes_com_ciclo_evento_divergente
FROM ist_eventos_avaliacoes a
LEFT JOIN ist_eventos_ciclos c
  ON c.id_evento = a.id_evento AND c.id_ciclo = a.id_ciclo
WHERE c.id_ciclo IS NULL;

SELECT COUNT(*) AS notas_com_avaliacao_criterio_ciclo_divergente
FROM ist_eventos_avaliacoes_notas n
LEFT JOIN ist_eventos_avaliacoes a
  ON a.id_avaliacao = n.id_avaliacao AND a.id_ciclo = n.id_ciclo
LEFT JOIN ist_eventos_ciclos_criterios cc
  ON cc.id_ciclo = n.id_ciclo
 AND cc.id_criterio_ciclo = n.id_criterio_ciclo
WHERE a.id_avaliacao IS NULL OR cc.id_criterio_ciclo IS NULL;

-- Deve ser zero: validacao redundante e explicita da relacao ciclo/evento e
-- evento/criterio que sera garantida pela FK composta do snapshot.
SELECT COUNT(*) AS criterios_snapshot_evento_divergente
FROM ist_eventos_ciclos_criterios cc
LEFT JOIN ist_eventos_ciclos c
  ON c.id_ciclo = cc.id_ciclo AND c.id_evento = cc.id_evento
LEFT JOIN ist_eventos_criterios_avaliacao origem
  ON origem.id_criterio = cc.id_criterio_origem
 AND origem.id_evento = cc.id_evento
WHERE c.id_ciclo IS NULL OR origem.id_criterio IS NULL;

-- Carry-forward nao e criado no backfill inicial. Esta auditoria deve retornar
-- zero e tambem serve para conferir futuras relacoes antes de operacoes de
-- revisao/manutencao.
-- CASO 1: carry-forward entre ciclos exige ciclo de origem anterior e mesmos
-- jurado/concorrente; compatibilidade de material/criterios e transacional.
-- CASO 2: revisao no ciclo aberto pode apontar para o mesmo ciclo, desde que
-- seja tentativa anterior dos mesmos jurado/concorrente.
-- Backend: rejeitar autorreferencia/ciclos na cadeia, origem futura, revisao
-- sem tentativa anterior e origem nao concluida quando a regra exigir.
-- A ordem de ciclos/tentativas e verificada entre linhas, nao por CHECK local.
-- Avaliacoes concluidas permanecem imutaveis. Revisoes recebem numero_tentativa
-- crescente a partir de 1 dentro de ciclo/jurado/participante. O backend futuro
-- determina inequivocamente a tentativa efetiva. Deve haver no maximo um
-- rascunho para cada combinacao; isso e invariante transacional do service,
-- pois nao ha indice parcial portavel sem workarounds. Autorreferencia de
-- avaliacao-origem tambem e rejeitada pela validacao do service: CHECK nao pode
-- referenciar a PK AUTO_INCREMENT de forma portavel no MariaDB 10.3.
SELECT COUNT(*) AS avaliacoes_origem_invalidas
FROM ist_eventos_avaliacoes destino
LEFT JOIN ist_eventos_avaliacoes origem
  ON origem.id_avaliacao = destino.id_avaliacao_origem
LEFT JOIN ist_eventos_ciclos ciclo_destino
  ON ciclo_destino.id_ciclo = destino.id_ciclo
LEFT JOIN ist_eventos_ciclos ciclo_origem
  ON ciclo_origem.id_ciclo = origem.id_ciclo
WHERE destino.id_avaliacao_origem IS NOT NULL
  AND (
    destino.id_avaliacao_origem = destino.id_avaliacao
    OR origem.id_avaliacao IS NULL
    OR origem.id_jurado <> destino.id_jurado
    OR origem.id_concorrente <> destino.id_concorrente
    OR ciclo_destino.id_ciclo IS NULL
    OR ciclo_origem.id_ciclo IS NULL
    OR ciclo_origem.id_evento <> ciclo_destino.id_evento
    OR ciclo_origem.numero_ciclo > ciclo_destino.numero_ciclo
    OR (origem.id_ciclo = destino.id_ciclo
        AND origem.numero_tentativa >= destino.numero_tentativa)
  );

-- Comparar com o baseline PRECHECK: igualdade exata por id_avaliacao.
-- Se o executor nao tiver o baseline, PARAR antes do DDL FINAL.
SELECT id_avaliacao, data_atualizacao
FROM ist_eventos_avaliacoes
ORDER BY id_avaliacao;

SELECT e.id, e.slug, j.quantidade_classificados
FROM ist_eventos_julgamentos j
JOIN ist_eventos e ON e.id = j.id_evento
WHERE (e.slug = 'ii-festival-de-violoes-sebastiao-tapajos'
       AND (j.quantidade_classificados IS NULL
            OR j.quantidade_classificados <> 3))
   OR (e.slug <> 'ii-festival-de-violoes-sebastiao-tapajos'
       AND j.quantidade_classificados = 3);

-- ============================================================================
-- 4. VALIDATION GATE — TODAS AS CONSULTAS ACIMA DEVEM PASSAR ANTES DO DDL FINAL
-- ============================================================================
-- Esperado: contagens de avaliacoes/notas inalteradas; zero avaliacoes/notas
-- sem mapeamento; zero avaliacoes sem jurado no roster; zero ciclos atuais
-- ausentes; totais de roster/participantes/criterios "depois" iguais aos
-- "esperados"; zero divergencias de evento/ciclo/criterio; zero origens de
-- avaliacao invalidas; somente o II Festival com quantidade_classificados=3.
-- Contagens de erro devem ser zero; contagens antes/depois devem ser iguais.
-- Timestamps data_atualizacao devem ser identicos ao baseline por ID.
-- Se QUALQUER resultado diferir, PARAR e nao executar a etapa 5.

-- ============================================================================
-- 5A. DDL FINAL-A — CHAVES-BASE
-- ============================================================================
-- Somente executar apos aprovacao explicita do VALIDATION GATE acima.

ALTER TABLE ist_eventos_avaliacoes
  MODIFY COLUMN id_ciclo INT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_avaliacao_id_ciclo (id_avaliacao, id_ciclo),
  ADD UNIQUE KEY uq_avaliacao_id_jurado_concorrente (
    id_avaliacao, id_jurado, id_concorrente
  ),
  ADD UNIQUE KEY uq_avaliacao_tentativa (
    id_ciclo, id_jurado, id_concorrente, numero_tentativa
  ),
  ADD KEY idx_avaliacao_evento_ciclo (id_evento, id_ciclo),
  ADD KEY idx_avaliacao_evento_jurado (id_evento, id_jurado),
  ADD KEY idx_avaliacao_ciclo_jurado (id_ciclo, id_jurado),
  ADD KEY idx_avaliacao_ciclo_concorrente (id_ciclo, id_concorrente),
  ADD KEY idx_avaliacao_origem_jurado_concorrente (
    id_avaliacao_origem, id_jurado, id_concorrente
  ),
  ADD CONSTRAINT ck_avaliacao_tentativa CHECK (numero_tentativa > 0);

ALTER TABLE ist_eventos_avaliacoes_notas
  MODIFY COLUMN id_ciclo INT UNSIGNED NOT NULL,
  MODIFY COLUMN id_criterio_ciclo INT UNSIGNED NOT NULL,
  ADD KEY idx_nota_ciclo_avaliacao (id_avaliacao, id_ciclo),
  ADD KEY idx_nota_ciclo_criterio (id_ciclo, id_criterio_ciclo);

ALTER TABLE ist_eventos_julgamentos
  MODIFY COLUMN id_ciclo_atual INT UNSIGNED NOT NULL,
  ADD KEY idx_julgamento_evento_ciclo (id_evento, id_ciclo_atual),
  ADD KEY idx_julgamento_evento_publicacao (id_evento, id_publicacao_vigente);

-- ============================================================================
-- VALIDATION GATE FINAL-A
-- ============================================================================
-- Cada indice abaixo deve retornar exatamente uma linha, com formato e
-- non_unique indicados. Ausencia/divergencia: PARAR, nao executar FINAL-B.
-- A UNIQUE pai tripla deve estar persistida antes da FK autorreferente.
SELECT table_name, index_name, non_unique,
       GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS colunas,
       COUNT(*) AS quantidade_colunas
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND (
    (table_name = 'ist_eventos_avaliacoes' AND index_name IN (
      'uq_avaliacao_id_ciclo','uq_avaliacao_id_jurado_concorrente',
      'uq_avaliacao_tentativa','idx_avaliacao_evento_ciclo',
      'idx_avaliacao_evento_jurado','idx_avaliacao_ciclo_jurado',
      'idx_avaliacao_ciclo_concorrente','idx_avaliacao_origem_jurado_concorrente'
    ))
    OR (table_name = 'ist_eventos_avaliacoes_notas' AND index_name IN (
      'idx_nota_ciclo_avaliacao','idx_nota_ciclo_criterio'
    ))
    OR (table_name = 'ist_eventos_julgamentos' AND index_name IN (
      'idx_julgamento_evento_ciclo','idx_julgamento_evento_publicacao'
    ))
  )
GROUP BY table_name, index_name, non_unique
ORDER BY table_name, index_name;
-- Esperado: 12 linhas. UNIQUEs non_unique=0:
-- uq_avaliacao_id_ciclo: id_avaliacao,id_ciclo (2)
-- uq_avaliacao_id_jurado_concorrente: id_avaliacao,id_jurado,id_concorrente (3)
-- uq_avaliacao_tentativa: id_ciclo,id_jurado,id_concorrente,numero_tentativa (4)
-- Demais non_unique=1, nas mesmas colunas/ordem dos ADD KEY de FINAL-A.

-- Deve ser zero: confirma especificamente a chave pai da FK autorreferente,
-- incluindo unicidade, quantidade exata, ordem e ausencia de prefixos parciais.
SELECT COUNT(*) AS chave_pai_origem_invalida
FROM (
  SELECT 1 AS esperado
) esperado
WHERE NOT EXISTS (
  SELECT 1
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'ist_eventos_avaliacoes'
    AND index_name = 'uq_avaliacao_id_jurado_concorrente'
  GROUP BY index_name
  HAVING COUNT(*) = 3
     AND MIN(non_unique) = 0 AND MAX(non_unique) = 0
     AND COUNT(sub_part) = 0
     AND GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',')
         = 'id_avaliacao,id_jurado,id_concorrente'
);
-- Se chave_pai_origem_invalida <> 0, PARAR antes de FINAL-B.

-- ============================================================================
-- 5B. DDL FINAL-B — FKs DEPENDENTES E TABELAS FINAIS
-- ============================================================================
-- Executar somente apos VALIDATION-A aprovada; NAO repetir FINAL-A.
ALTER TABLE ist_eventos_avaliacoes
  ADD CONSTRAINT fk_avaliacao_ciclo FOREIGN KEY (id_evento, id_ciclo)
    REFERENCES ist_eventos_ciclos (id_evento, id_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT fk_avaliacao_jurado_ciclo
    FOREIGN KEY (id_ciclo, id_jurado)
    REFERENCES ist_eventos_ciclos_jurados (id_ciclo, id_usuario)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT fk_avaliacao_concorrente_ciclo
    FOREIGN KEY (id_ciclo, id_concorrente)
    REFERENCES ist_eventos_ciclos_concorrentes (id_ciclo, id_concorrente)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT fk_avaliacao_origem_jurado_concorrente
    FOREIGN KEY (id_avaliacao_origem, id_jurado, id_concorrente)
    REFERENCES ist_eventos_avaliacoes
      (id_avaliacao, id_jurado, id_concorrente)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE ist_eventos_avaliacoes_notas
  ADD CONSTRAINT fk_nota_ciclo_avaliacao
    FOREIGN KEY (id_avaliacao, id_ciclo)
    REFERENCES ist_eventos_avaliacoes (id_avaliacao, id_ciclo)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT fk_nota_ciclo_criterio
    FOREIGN KEY (id_ciclo, id_criterio_ciclo)
    REFERENCES ist_eventos_ciclos_criterios (id_ciclo, id_criterio_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE ist_eventos_julgamentos
  ADD CONSTRAINT fk_julgamento_ciclo_atual
    FOREIGN KEY (id_evento, id_ciclo_atual)
    REFERENCES ist_eventos_ciclos (id_evento, id_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- id_decisao e AUTO_INCREMENT; MariaDB nao permite referencia-lo em CHECK.
-- A aplicacao futura deve impedir auto-supersessao e ciclos no grafo de
-- supersessao dentro da transacao que registra/substitui decisoes.
CREATE TABLE ist_eventos_decisoes (
  id_decisao INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_ciclo INT UNSIGNED NOT NULL,
  tipo VARCHAR(40) NOT NULL,
  desfecho VARCHAR(30) NOT NULL,
  justificativa VARCHAR(4000) NOT NULL,
  registrado_por INT NOT NULL,
  registrado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id_decisao_substituida INT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (id_decisao),
  UNIQUE KEY uq_decisao_ciclo_par (id_ciclo, id_decisao),
  KEY idx_decisao_registrado_por (registrado_por),
  CONSTRAINT fk_decisao_ciclo FOREIGN KEY (id_ciclo)
    REFERENCES ist_eventos_ciclos (id_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_decisao_usuario FOREIGN KEY (registrado_por)
    REFERENCES ist_usuarios (id_usuario) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_decisao_substituida FOREIGN KEY (id_ciclo, id_decisao_substituida)
    REFERENCES ist_eventos_decisoes (id_ciclo, id_decisao)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_decisao_tipo CHECK (
    tipo IN (
      'empate','desistencia','desclassificacao','alteracao_roster',
      'revisao_avaliacao','administrativa'
    )
  ),
  CONSTRAINT ck_decisao_desfecho CHECK (
    desfecho IN (
      'aplicada','negada','mantido','desclassificado','desistencia',
      'ordem_definida','outro'
    )
  ),
  CONSTRAINT ck_decisao_justificativa CHECK (
    CHAR_LENGTH(TRIM(justificativa)) BETWEEN 1 AND 4000
  ),
  CONSTRAINT ck_decisao_desclassificacao CHECK (
    desfecho <> 'desclassificado'
    OR (tipo = 'desclassificacao' AND CHAR_LENGTH(TRIM(justificativa)) > 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ist_eventos_decisoes_concorrentes (
  id_decisao INT UNSIGNED NOT NULL,
  id_ciclo INT UNSIGNED NOT NULL,
  id_ciclo_concorrente INT UNSIGNED NOT NULL,
  PRIMARY KEY (id_decisao, id_ciclo_concorrente),
  KEY idx_decisao_concorrente_ciclo (id_ciclo, id_ciclo_concorrente),
  CONSTRAINT fk_decisao_concorrente_decisao
    FOREIGN KEY (id_ciclo, id_decisao)
    REFERENCES ist_eventos_decisoes (id_ciclo, id_decisao)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_decisao_concorrente_alvo
    FOREIGN KEY (id_ciclo, id_ciclo_concorrente)
    REFERENCES ist_eventos_ciclos_concorrentes (id_ciclo, id_ciclo_concorrente)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ist_eventos_decisoes_jurados (
  id_decisao INT UNSIGNED NOT NULL,
  id_ciclo INT UNSIGNED NOT NULL,
  id_usuario INT NOT NULL,
  PRIMARY KEY (id_decisao, id_usuario),
  KEY idx_decisao_jurado_ciclo (id_ciclo, id_usuario),
  CONSTRAINT fk_decisao_jurado_decisao
    FOREIGN KEY (id_ciclo, id_decisao)
    REFERENCES ist_eventos_decisoes (id_ciclo, id_decisao)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_decisao_jurado_alvo
    FOREIGN KEY (id_ciclo, id_usuario)
    REFERENCES ist_eventos_ciclos_jurados (id_ciclo, id_usuario)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ist_eventos_publicacoes (
  id_publicacao INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_evento INT UNSIGNED NOT NULL,
  id_ciclo INT UNSIGNED NOT NULL,
  versao INT UNSIGNED NOT NULL,
  publicado_por INT NOT NULL,
  publicado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  chave_idempotencia VARCHAR(128) DEFAULT NULL,
  PRIMARY KEY (id_publicacao),
  UNIQUE KEY uq_publicacao_evento_versao (id_evento, versao),
  UNIQUE KEY uq_publicacao_evento_id (id_evento, id_publicacao),
  UNIQUE KEY uq_publicacao_evento_ciclo_id (id_evento, id_ciclo, id_publicacao),
  UNIQUE KEY uq_publicacao_ciclo (id_ciclo),
  UNIQUE KEY uq_publicacao_ciclo_id (id_ciclo, id_publicacao),
  UNIQUE KEY uq_publicacao_idempotencia (id_evento, chave_idempotencia),
  KEY idx_publicacao_ciclo_evento (id_evento, id_ciclo),
  CONSTRAINT fk_publicacao_ciclo FOREIGN KEY (id_evento, id_ciclo)
    REFERENCES ist_eventos_ciclos (id_evento, id_ciclo)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_publicacao_usuario FOREIGN KEY (publicado_por)
    REFERENCES ist_usuarios (id_usuario) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_publicacao_versao CHECK (versao > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE ist_eventos_ciclos
  ADD CONSTRAINT fk_ciclo_publicacao_origem
    FOREIGN KEY (id_evento, id_ciclo_origem, id_publicacao_origem)
    REFERENCES ist_eventos_publicacoes (id_evento, id_ciclo, id_publicacao)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE ist_eventos_julgamentos
  ADD CONSTRAINT fk_julgamento_publicacao_vigente
    FOREIGN KEY (id_evento, id_publicacao_vigente)
    REFERENCES ist_eventos_publicacoes (id_evento, id_publicacao)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE ist_eventos_publicacoes_resultados (
  id_resultado INT UNSIGNED NOT NULL AUTO_INCREMENT,
  id_publicacao INT UNSIGNED NOT NULL,
  id_ciclo INT UNSIGNED NOT NULL,
  id_ciclo_concorrente INT UNSIGNED NOT NULL,
  numero_publico VARCHAR(50) DEFAULT NULL,
  nome_publico VARCHAR(255) NOT NULL,
  posicao INT UNSIGNED DEFAULT NULL,
  situacao_final ENUM(
    'classificado','nao_classificado','desistente','desclassificado'
  ) NOT NULL,
  media_consolidada DECIMAL(5,2) DEFAULT NULL
    COMMENT 'Valor interno; nao e dado publico por regra funcional',
  PRIMARY KEY (id_resultado),
  UNIQUE KEY uq_resultado_publicacao_participante (id_publicacao, id_ciclo_concorrente),
  UNIQUE KEY uq_resultado_publicacao_posicao (id_publicacao, posicao),
  KEY idx_resultado_ciclo_participante (id_ciclo, id_ciclo_concorrente),
  CONSTRAINT fk_resultado_publicacao FOREIGN KEY (id_ciclo, id_publicacao)
    REFERENCES ist_eventos_publicacoes (id_ciclo, id_publicacao)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_resultado_participante
    FOREIGN KEY (id_ciclo, id_ciclo_concorrente)
    REFERENCES ist_eventos_ciclos_concorrentes (id_ciclo, id_ciclo_concorrente)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ck_resultado_nome CHECK (CHAR_LENGTH(TRIM(nome_publico)) > 0),
  CONSTRAINT ck_resultado_media CHECK (
    media_consolidada IS NULL OR media_consolidada BETWEEN 0 AND 100
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ist_eventos_publicacoes_decisoes (
  id_publicacao INT UNSIGNED NOT NULL,
  id_ciclo INT UNSIGNED NOT NULL,
  id_decisao INT UNSIGNED NOT NULL,
  PRIMARY KEY (id_publicacao, id_decisao),
  KEY idx_publicacao_decisao_ciclo (id_ciclo, id_decisao),
  CONSTRAINT fk_publicacao_decisao_publicacao
    FOREIGN KEY (id_ciclo, id_publicacao)
    REFERENCES ist_eventos_publicacoes (id_ciclo, id_publicacao)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_publicacao_decisao_decisao
    FOREIGN KEY (id_ciclo, id_decisao)
    REFERENCES ist_eventos_decisoes (id_ciclo, id_decisao)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VALIDATION GATE FINAL-B — ANTES DA REMOCAO DA UNIQUE LEGADA
-- ============================================================================
-- Confirmar 11 tabelas novas e suas PK/FK/UNIQUE/CHECK por SHOW CREATE TABLE
-- no FINAL AUDIT abaixo (consultas tambem podem ser executadas neste gate).
-- Confirmar todas as FKs adicionadas em FINAL-B: nomes, colunas em ordem,
-- tabela/colunas pai e RESTRICT/CASCADE conforme cada declaracao acima.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
    'ist_eventos_julgamentos','ist_eventos_ciclos',
    'ist_eventos_ciclos_jurados','ist_eventos_ciclos_concorrentes',
    'ist_eventos_ciclos_criterios','ist_eventos_decisoes',
    'ist_eventos_decisoes_concorrentes','ist_eventos_decisoes_jurados',
    'ist_eventos_publicacoes','ist_eventos_publicacoes_resultados',
    'ist_eventos_publicacoes_decisoes'
  )
ORDER BY table_name;
-- Esperado: exatamente as 11 tabelas acima.

-- A consulta abaixo deve retornar exatamente 7 FKs, nao apenas 7 linhas.
SELECT k.table_name, k.constraint_name, k.ordinal_position, k.column_name,
       k.referenced_table_name, k.referenced_column_name,
       r.update_rule, r.delete_rule
FROM information_schema.key_column_usage k
JOIN information_schema.referential_constraints r
  ON r.constraint_schema = k.constraint_schema
 AND r.table_name = k.table_name AND r.constraint_name = k.constraint_name
WHERE k.constraint_schema = DATABASE()
  AND k.constraint_name IN (
    'fk_avaliacao_ciclo','fk_avaliacao_jurado_ciclo',
    'fk_avaliacao_concorrente_ciclo','fk_avaliacao_origem_jurado_concorrente',
    'fk_nota_ciclo_avaliacao','fk_nota_ciclo_criterio',
    'fk_julgamento_ciclo_atual'
  )
ORDER BY k.table_name, k.constraint_name, k.ordinal_position;

-- Revalidar imediatamente antes do DROP: exatamente 3 linhas com:
-- uq_avaliacao_tentativa: non_unique=0,
--   id_ciclo,id_jurado,id_concorrente,numero_tentativa;
-- uq_avaliacao_id_jurado_concorrente: non_unique=0,
--   id_avaliacao,id_jurado,id_concorrente;
-- idx_avaliacao_evento_jurado: non_unique=1, id_evento,id_jurado.
SELECT index_name, non_unique,
       GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS colunas,
       COUNT(*) AS quantidade_colunas
FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name = 'ist_eventos_avaliacoes'
  AND index_name IN (
    'uq_avaliacao_tentativa','uq_avaliacao_id_jurado_concorrente',
    'idx_avaliacao_evento_jurado'
  )
GROUP BY index_name, non_unique;

-- Zero linhas: nao pode haver duplicidade da nova chave logica.
SELECT id_ciclo, id_jurado, id_concorrente, numero_tentativa, COUNT(*) AS quantidade
FROM ist_eventos_avaliacoes
GROUP BY id_ciclo, id_jurado, id_concorrente, numero_tentativa
HAVING COUNT(*) > 1;

-- Zero erros: roster, participante e ciclo devem estar coerentes.
SELECT COUNT(*) AS avaliacoes_inconsistentes_antes_drop
FROM ist_eventos_avaliacoes a
LEFT JOIN ist_eventos_ciclos c
  ON c.id_ciclo = a.id_ciclo AND c.id_evento = a.id_evento
LEFT JOIN ist_eventos_ciclos_jurados j
  ON j.id_ciclo = a.id_ciclo AND j.id_usuario = a.id_jurado
LEFT JOIN ist_eventos_ciclos_concorrentes p
  ON p.id_ciclo = a.id_ciclo AND p.id_concorrente = a.id_concorrente
WHERE c.id_ciclo IS NULL OR j.id_usuario IS NULL OR p.id_ciclo_concorrente IS NULL;

-- Gate humano obrigatorio: qualquer indice/FK ausente/divergente, contador
-- de erro nao zero ou duplicidade exige PARAR. NAO executar FINAL-C.
-- ============================================================================
-- 5C. DDL FINAL-C — REMOCAO DA UNIQUE LEGADA
-- ============================================================================
-- idx_avaliacao_evento_jurado preserva a FK legada e o prefixo id_evento.
-- As FKs de concorrente/notas mantem seus indices originais. Nenhum desses
-- prefixos e substituido pela UNIQUE de tentativas.
SET @7k7b1_legacy_index := (
  SELECT s.index_name
  FROM information_schema.statistics s
  WHERE s.table_schema = DATABASE()
    AND s.table_name = 'ist_eventos_avaliacoes'
    AND s.non_unique = 0
    AND s.index_name <> 'PRIMARY'
  GROUP BY s.index_name
  HAVING COUNT(*) = 3
     AND GROUP_CONCAT(s.column_name ORDER BY s.seq_in_index SEPARATOR ',')
         = 'id_evento,id_jurado,id_concorrente'
);
-- Esperado: exatamente o nome descoberto no PRECHECK, nunca NULL.
-- Se ausente/ambiguo/divergente, PARAR; nao executar PREPARE/EXECUTE.
SELECT @7k7b1_legacy_index AS indice_legado_a_remover;
SET @7k7b1_drop_legacy := CONCAT(
  'ALTER TABLE ist_eventos_avaliacoes DROP INDEX `',
  REPLACE(@7k7b1_legacy_index, '`', '``'), '`'
);
PREPARE stmt_7k7b1_drop_legacy FROM @7k7b1_drop_legacy;
EXECUTE stmt_7k7b1_drop_legacy;
DEALLOCATE PREPARE stmt_7k7b1_drop_legacy;

-- ============================================================================
-- 6. FINAL AUDIT
-- ============================================================================
-- Conferir SHOW CREATE TABLE e SHOW INDEX das tabelas novas e alteradas;
-- comparar os totais com @7k7b1_eval_before/@7k7b1_notes_before. Confirmar:
-- nenhuma publicacao, apenas o II Festival configurado com 3, zero FK invalidas,
-- UNIQUEs esperadas presentes e a UNIQUE antiga removida pelo nome descoberto.
-- Ciclos selados, transicoes de lifecycle, imutabilidade append-only,
-- completude de avaliacao, politica de desempate e consistencia entre alvos
-- continuam responsabilidade de transacoes/servicos futuros.
SELECT COUNT(*) AS publicacoes_criadas
FROM ist_eventos_publicacoes;

-- Comparar por ID com o baseline PRECHECK: timestamps identicos.
SELECT id_avaliacao, data_atualizacao
FROM ist_eventos_avaliacoes
ORDER BY id_avaliacao;

-- Deve ser zero: a FK composta garante mesmo evento/ciclo/publicacao; a
-- desigualdade numero_ciclo_origem < numero_ciclo e validacao transacional.
SELECT COUNT(*) AS provenance_ciclo_publicacao_invalida
FROM ist_eventos_ciclos destino
LEFT JOIN ist_eventos_ciclos origem
  ON origem.id_evento = destino.id_evento
 AND origem.id_ciclo = destino.id_ciclo_origem
LEFT JOIN ist_eventos_publicacoes p
  ON p.id_evento = destino.id_evento
 AND p.id_ciclo = destino.id_ciclo_origem
 AND p.id_publicacao = destino.id_publicacao_origem
WHERE destino.id_ciclo_origem IS NOT NULL
  AND (
    origem.id_ciclo IS NULL
    OR origem.numero_ciclo >= destino.numero_ciclo
    OR p.id_publicacao IS NULL
  );

-- Deve ser zero; a rejeicao de auto-supersessao/grafos ciclicos e invariante
-- da transacao do backend, pois id_decisao e AUTO_INCREMENT.
SELECT COUNT(*) AS decisoes_autossubstituidas
FROM ist_eventos_decisoes
WHERE id_decisao_substituida = id_decisao;

SELECT table_name, constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE constraint_schema = DATABASE()
  AND table_name LIKE 'ist_eventos_%'
  AND table_name IN (
    'ist_eventos_julgamentos','ist_eventos_ciclos',
    'ist_eventos_ciclos_jurados','ist_eventos_ciclos_concorrentes',
    'ist_eventos_ciclos_criterios','ist_eventos_decisoes',
    'ist_eventos_decisoes_concorrentes','ist_eventos_decisoes_jurados',
    'ist_eventos_publicacoes','ist_eventos_publicacoes_resultados',
    'ist_eventos_publicacoes_decisoes','ist_eventos_avaliacoes',
    'ist_eventos_avaliacoes_notas'
  )
ORDER BY table_name, constraint_type, constraint_name;

SHOW CREATE TABLE ist_eventos_julgamentos;
SHOW CREATE TABLE ist_eventos_ciclos;
SHOW CREATE TABLE ist_eventos_ciclos_jurados;
SHOW CREATE TABLE ist_eventos_ciclos_concorrentes;
SHOW CREATE TABLE ist_eventos_ciclos_criterios;
SHOW CREATE TABLE ist_eventos_decisoes;
SHOW CREATE TABLE ist_eventos_decisoes_concorrentes;
SHOW CREATE TABLE ist_eventos_decisoes_jurados;
SHOW CREATE TABLE ist_eventos_publicacoes;
SHOW CREATE TABLE ist_eventos_publicacoes_resultados;
SHOW CREATE TABLE ist_eventos_publicacoes_decisoes;
SHOW CREATE TABLE ist_eventos_criterios_avaliacao;
SHOW CREATE TABLE ist_eventos_avaliacoes;
SHOW CREATE TABLE ist_eventos_avaliacoes_notas;
