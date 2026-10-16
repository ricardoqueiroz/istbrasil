-- Etapa 67.3: somente a fundacao de pagamentos; sem integracao com provedores.
-- Alvo de sintaxe: MariaDB 10.3.39. Homologacao exige execucao nessa versao.
-- Nesta etapa, executar EXCLUSIVAMENTE em instancia descartavel e isolada.
-- O nome istbrasil nao comprova isolamento: conferir host/porta/datadir antes.
-- Nao aplicar no banco recuperado ou em producao sem autorizacao posterior.
-- Executar na mesma conexao, sem --force e sem transacao pendente.
-- DDL faz COMMIT implicito. Falha parcial exige parar e relatar, nunca retomar.
-- Nenhum ALTER, DROP, carga, trigger, rotina persistida ou referencia ao legado.
-- DATETIME(3): UTC explicito fornecido pelo chamador, sem defaults de fuso local.
-- Valores: centavos inteiros; respostas externas exigem conversao decimal exata.
-- Evidencias/resultados: somente projecoes permitidas, nunca cartao/tokens/segredos.
-- CHECKs nao implementam imutabilidade, maquina de estados ou reconciliacao.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE quantidade INT DEFAULT 0;

    IF DATABASE() IS NULL OR NOT (
        DATABASE() = 'istbrasil' OR DATABASE() REGEXP '^ist_loja_67_3_[0-9a-f]{12}$'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Banco divergente; interromper.';
    END IF;
    IF @@in_transaction <> 0 OR @@autocommit <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exige autocommit e nenhuma transacao pendente.';
    END IF;
    IF @@session.foreign_key_checks <> 1 OR @@session.check_constraint_checks <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'FKs e CHECKs devem estar habilitados.';
    END IF;
    IF FIND_IN_SET('STRICT_TRANS_TABLES', @@sql_mode) = 0
       AND FIND_IN_SET('STRICT_ALL_TABLES', @@sql_mode) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Modo SQL estrito obrigatorio; nao alterar automaticamente.';
    END IF;
    SELECT COUNT(*) INTO quantidade FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name IN (
        'ist_loja_pagamentos', 'ist_loja_pagamento_operacoes', 'ist_loja_pagamento_eventos'
    );
    IF quantidade <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Fundacao existente ou parcial; nao repetir.';
    END IF;
    SELECT COUNT(*) INTO quantidade FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name IN (
        'ist_loja_sessoes', 'ist_loja_pedidos', 'ist_loja_pedido_itens'
    ) AND engine = 'InnoDB' AND table_type = 'BASE TABLE';
    IF quantidade <> 3 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Fundacao de pedidos incompleta ou engine divergente.';
    END IF;
    -- Conferir os 32 campos efetivos da fundacao versionada, inclusive nulabilidade.
    SELECT COUNT(*) INTO quantidade FROM information_schema.columns
    WHERE table_schema = DATABASE() AND (
        (table_name = 'ist_loja_sessoes' AND (
            (column_name = 'id' AND data_type = 'int' AND column_type LIKE '%unsigned%'
                AND is_nullable = 'NO' AND column_key = 'PRI')
            OR (column_name = 'token_hash' AND data_type = 'binary' AND character_maximum_length = 32 AND is_nullable = 'NO')
            OR (column_name IN ('criada_em', 'expira_em') AND data_type = 'datetime' AND datetime_precision = 3 AND is_nullable = 'NO')
            OR (column_name = 'revogada_em' AND data_type = 'datetime' AND datetime_precision = 3 AND is_nullable = 'YES')
        )) OR (table_name = 'ist_loja_pedidos' AND (
            (column_name IN ('id', 'sessao_id', 'versao') AND data_type = 'int' AND column_type LIKE '%unsigned%' AND is_nullable = 'NO')
            OR (column_name IN ('public_id', 'idempotencia_criacao') AND data_type = 'char' AND character_maximum_length = 36 AND collation_name = 'ascii_bin' AND is_nullable = 'NO')
            OR (column_name = 'comprador_email' AND data_type = 'varchar' AND character_maximum_length = 254 AND is_nullable = 'NO')
            OR (column_name = 'estado' AND data_type = 'varchar' AND character_maximum_length = 32 AND collation_name = 'ascii_bin' AND is_nullable = 'NO')
            OR (column_name = 'ambiente' AND data_type = 'varchar' AND character_maximum_length = 16 AND collation_name = 'ascii_bin' AND is_nullable = 'NO')
            OR (column_name = 'moeda' AND data_type = 'char' AND character_maximum_length = 3 AND collation_name = 'ascii_bin' AND is_nullable = 'NO')
            OR (column_name = 'total_centavos' AND data_type = 'bigint' AND column_type LIKE '%unsigned%' AND is_nullable = 'NO')
            OR (column_name = 'solicitacao_hash' AND data_type = 'binary' AND character_maximum_length = 32 AND is_nullable = 'NO')
            OR (column_name IN ('criado_em', 'atualizado_em', 'expira_em') AND data_type = 'datetime' AND datetime_precision = 3 AND is_nullable = 'NO')
            OR (column_name = 'pagamento_confirmado_em' AND data_type = 'datetime' AND datetime_precision = 3 AND is_nullable = 'YES')
            OR (column_name = 'motivo_revisao' AND data_type = 'varchar' AND character_maximum_length = 64 AND is_nullable = 'YES')
        )) OR (table_name = 'ist_loja_pedido_itens' AND (
            (column_name IN ('id', 'pedido_id') AND data_type = 'int' AND column_type LIKE '%unsigned%' AND is_nullable = 'NO')
            OR (column_name = 'produto_id' AND data_type = 'int' AND column_type NOT LIKE '%unsigned%' AND is_nullable = 'NO')
            OR (column_name IN ('posicao', 'quantidade') AND data_type = 'smallint' AND column_type LIKE '%unsigned%' AND is_nullable = 'NO')
            OR (column_name = 'sku_snapshot' AND data_type = 'varchar' AND character_maximum_length = 50 AND is_nullable = 'NO')
            OR (column_name = 'titulo_snapshot' AND data_type = 'text' AND is_nullable = 'NO')
            OR (column_name = 'descricao_snapshot' AND data_type = 'text' AND is_nullable = 'YES')
            OR (column_name = 'tipo_snapshot' AND data_type = 'varchar' AND character_maximum_length = 32 AND is_nullable = 'NO')
            OR (column_name IN ('preco_unitario_centavos', 'subtotal_centavos') AND data_type = 'bigint' AND column_type LIKE '%unsigned%' AND is_nullable = 'NO')
        ))
    );
    IF quantidade <> 32 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Campos da fundacao de pedidos divergentes; revisar esquema.';
    END IF;
    SELECT COUNT(*) INTO quantidade FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name IN (
        'ist_loja_sessoes', 'ist_loja_pedidos', 'ist_loja_pedido_itens'
    ) AND index_name = 'PRIMARY' AND column_name = 'id' AND seq_in_index = 1 AND non_unique = 0;
    IF quantidade <> 3 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PKs da fundacao divergentes.';
    END IF;

    CREATE TABLE ist_loja_pagamentos (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        pedido_id INT UNSIGNED NOT NULL,
        provedor VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        ambiente VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        conta_recebedora VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        estado VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        reserva_ativa TINYINT UNSIGNED NULL,
        moeda CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        valor_centavos BIGINT UNSIGNED NOT NULL,
        capturado_centavos BIGINT UNSIGNED NOT NULL DEFAULT 0,
        reembolsado_centavos BIGINT UNSIGNED NOT NULL DEFAULT 0,
        ordem_externa_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
        captura_externa_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
        versao INT UNSIGNED NOT NULL DEFAULT 1,
        criado_em DATETIME(3) NOT NULL,
        atualizado_em DATETIME(3) NOT NULL,
        expira_em DATETIME(3) NOT NULL,
        capturado_em DATETIME(3) NULL,
        encerrado_em DATETIME(3) NULL,
        motivo_revisao VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_lpg_public_id (public_id),
        UNIQUE KEY uq_lpg_reserva (pedido_id, reserva_ativa),
        UNIQUE KEY uq_lpg_id_pedido (id, pedido_id),
        UNIQUE KEY uq_lpg_id_contexto (id, provedor, ambiente, conta_recebedora),
        UNIQUE KEY uq_lpg_ordem_externa (provedor, ambiente, conta_recebedora, ordem_externa_id),
        UNIQUE KEY uq_lpg_captura_externa (provedor, ambiente, conta_recebedora, captura_externa_id),
        KEY idx_lpg_reconciliacao (estado, atualizado_em, id),
        KEY idx_lpg_expiracao (reserva_ativa, expira_em, id),
        CONSTRAINT fk_lpg_pedido FOREIGN KEY (pedido_id) REFERENCES ist_loja_pedidos (id)
            ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT ck_lpg_identificacao CHECK (
            CHAR_LENGTH(TRIM(public_id)) = 36 AND CHAR_LENGTH(TRIM(provedor)) > 0
            AND CHAR_LENGTH(TRIM(conta_recebedora)) > 0
            AND (ordem_externa_id IS NULL OR CHAR_LENGTH(TRIM(ordem_externa_id)) > 0)
            AND (captura_externa_id IS NULL OR CHAR_LENGTH(TRIM(captura_externa_id)) > 0)
        ),
        CONSTRAINT ck_lpg_ambiente CHECK (BINARY ambiente IN ('sandbox', 'live')),
        CONSTRAINT ck_lpg_estado CHECK (BINARY estado IN (
            'CRIANDO', 'AGUARDANDO_APROVACAO', 'APROVADO', 'CAPTURANDO', 'PENDENTE',
            'DESCONHECIDO', 'CAPTURADO', 'RECUSADO', 'CANCELADO', 'EXPIRADO',
            'PARCIALMENTE_REEMBOLSADO', 'REEMBOLSADO', 'ESTORNADO', 'REVISAO'
        )),
        -- IS NOT NULL explicito: CHECK aceita UNKNOWN; evitar a brecha ternaria.
        CONSTRAINT ck_lpg_reserva CHECK (
            (reserva_ativa IS NOT NULL AND reserva_ativa = 1 AND encerrado_em IS NULL)
            OR (reserva_ativa IS NULL AND encerrado_em IS NOT NULL)
        ),
        -- Incerteza nunca libera a reserva por simples timeout/expiracao local.
        -- REVISAO admite tentativa historica encerrada com evidencia tardia.
        CONSTRAINT ck_lpg_reserva_pendente CHECK (
            BINARY estado NOT IN ('CRIANDO', 'AGUARDANDO_APROVACAO', 'APROVADO',
                'CAPTURANDO', 'PENDENTE', 'DESCONHECIDO')
            OR (reserva_ativa IS NOT NULL AND reserva_ativa = 1)
        ),
        CONSTRAINT ck_lpg_moeda CHECK (BINARY moeda = 'BRL'),
        CONSTRAINT ck_lpg_valor CHECK (valor_centavos > 0 AND valor_centavos <= 9007199254740991),
        CONSTRAINT ck_lpg_reembolso CHECK (reembolsado_centavos <= capturado_centavos),
        CONSTRAINT ck_lpg_versao CHECK (versao > 0),
        CONSTRAINT ck_lpg_datas CHECK (
            atualizado_em >= criado_em AND expira_em > criado_em
            AND (capturado_em IS NULL OR capturado_em >= criado_em)
            AND (encerrado_em IS NULL OR encerrado_em >= criado_em)
        )
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE ist_loja_pagamento_operacoes (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        pagamento_id INT UNSIGNED NOT NULL,
        pedido_id INT UNSIGNED NOT NULL,
        acao VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        chave_idempotencia CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        solicitacao_hash BINARY(32) NOT NULL,
        request_id_provedor CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        estado VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        tentativas SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        execucao_token BINARY(16) NULL,
        execucao_ate DATETIME(3) NULL,
        proxima_tentativa_em DATETIME(3) NULL,
        resultado_json TEXT NULL,
        codigo_erro VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        versao INT UNSIGNED NOT NULL DEFAULT 1,
        criado_em DATETIME(3) NOT NULL,
        atualizado_em DATETIME(3) NOT NULL,
        envio_iniciado_em DATETIME(3) NULL,
        concluido_em DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_lpgo_idempotencia (pedido_id, acao, chave_idempotencia),
        UNIQUE KEY uq_lpgo_acao (pagamento_id, acao),
        UNIQUE KEY uq_lpgo_request_id (request_id_provedor),
        KEY idx_lpgo_pagamento_pedido (pagamento_id, pedido_id),
        KEY idx_lpgo_pendencias (estado, proxima_tentativa_em, id),
        KEY idx_lpgo_execucao (estado, execucao_ate, id),
        CONSTRAINT fk_lpgo_pagamento FOREIGN KEY (pagamento_id, pedido_id)
            REFERENCES ist_loja_pagamentos (id, pedido_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT ck_lpgo_identificacao CHECK (
            CHAR_LENGTH(TRIM(chave_idempotencia)) = 36 AND CHAR_LENGTH(TRIM(request_id_provedor)) = 36
        ),
        CONSTRAINT ck_lpgo_acao CHECK (BINARY acao IN ('CRIAR', 'CAPTURAR')),
        CONSTRAINT ck_lpgo_estado CHECK (BINARY estado IN (
            'PREPARADA', 'EM_EXECUCAO', 'DESCONHECIDA', 'SUCESSO', 'RECUSADA', 'REVISAO'
        )),
        CONSTRAINT ck_lpgo_execucao CHECK (
            (BINARY estado = 'EM_EXECUCAO' AND execucao_token IS NOT NULL
                AND execucao_ate IS NOT NULL AND execucao_ate > atualizado_em)
            OR (BINARY estado <> 'EM_EXECUCAO' AND execucao_token IS NULL AND execucao_ate IS NULL)
        ),
        CONSTRAINT ck_lpgo_versao CHECK (versao > 0),
        CONSTRAINT ck_lpgo_datas CHECK (
            atualizado_em >= criado_em
            AND (envio_iniciado_em IS NULL OR envio_iniciado_em >= criado_em)
            AND (concluido_em IS NULL OR concluido_em >= criado_em)
        ),
        CONSTRAINT ck_lpgo_resultado CHECK (
            resultado_json IS NULL OR (JSON_VALID(resultado_json) = 1 AND OCTET_LENGTH(resultado_json) <= 16384)
        )
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE ist_loja_pagamento_eventos (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        pagamento_id INT UNSIGNED NULL,
        provedor VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        ambiente VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        conta_recebedora VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        origem VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        evento_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        tipo VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        recurso_externo_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
        conteudo_hash BINARY(32) NOT NULL,
        evidencia_json TEXT NOT NULL,
        estado VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        tentativas SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        execucao_token BINARY(16) NULL,
        execucao_ate DATETIME(3) NULL,
        proxima_tentativa_em DATETIME(3) NULL,
        codigo_erro VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        ocorrido_em DATETIME(3) NULL,
        recebido_em DATETIME(3) NOT NULL,
        autenticado_em DATETIME(3) NOT NULL,
        atualizado_em DATETIME(3) NOT NULL,
        processado_em DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_lpge_evento (provedor, ambiente, conta_recebedora, origem, evento_id),
        KEY idx_lpge_contexto (pagamento_id, provedor, ambiente, conta_recebedora),
        KEY idx_lpge_pendencias (estado, proxima_tentativa_em, id),
        KEY idx_lpge_execucao (estado, execucao_ate, id),
        KEY idx_lpge_recurso (provedor, ambiente, conta_recebedora, recurso_externo_id),
        CONSTRAINT fk_lpge_pagamento FOREIGN KEY (pagamento_id, provedor, ambiente, conta_recebedora)
            REFERENCES ist_loja_pagamentos (id, provedor, ambiente, conta_recebedora)
            ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT ck_lpge_identificacao CHECK (
            CHAR_LENGTH(TRIM(provedor)) > 0 AND CHAR_LENGTH(TRIM(conta_recebedora)) > 0
            AND CHAR_LENGTH(TRIM(evento_id)) > 0 AND CHAR_LENGTH(TRIM(tipo)) > 0
            AND (recurso_externo_id IS NULL OR CHAR_LENGTH(TRIM(recurso_externo_id)) > 0)
        ),
        CONSTRAINT ck_lpge_ambiente CHECK (BINARY ambiente IN ('sandbox', 'live')),
        CONSTRAINT ck_lpge_origem CHECK (BINARY origem IN ('WEBHOOK', 'API', 'RECONCILIACAO', 'INTERNO')),
        CONSTRAINT ck_lpge_estado CHECK (BINARY estado IN (
            'RECEBIDO', 'PROCESSANDO', 'PROCESSADO', 'IGNORADO', 'REVISAO'
        )),
        CONSTRAINT ck_lpge_execucao CHECK (
            (BINARY estado = 'PROCESSANDO' AND execucao_token IS NOT NULL
                AND execucao_ate IS NOT NULL AND execucao_ate > atualizado_em)
            OR (BINARY estado <> 'PROCESSANDO' AND execucao_token IS NULL AND execucao_ate IS NULL)
        ),
        CONSTRAINT ck_lpge_datas CHECK (
            autenticado_em >= recebido_em AND atualizado_em >= autenticado_em
            AND (processado_em IS NULL OR processado_em >= autenticado_em)
        ),
        CONSTRAINT ck_lpge_evidencia CHECK (JSON_VALID(evidencia_json) = 1 AND OCTET_LENGTH(evidencia_json) <= 16384)
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
END$$
DELIMITER ;
