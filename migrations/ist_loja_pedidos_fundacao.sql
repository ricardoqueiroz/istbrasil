-- Etapa 64: fundacao de pedidos. Aplicacao autorizada SOMENTE no banco local.
-- Alvo de sintaxe: MariaDB 10.3.39. Revisar antes de qualquer uso futuro.
-- Executar na mesma conexao, sem transacao pendente e sem --force.
-- DDL faz commit implicito: ROLLBACK NAO remove tabelas criadas.
-- Nao repetir, nem retomar automaticamente, apos qualquer falha parcial.
-- Nenhuma carga inicial, ALTER, DROP ou dependencia de pedidos/vendas legados.
-- DATETIME(3) representa UTC por convencao. A futura camada de servico deve
-- fornecer datas em UTC; DATETIME nao converte fusos automaticamente.
-- Identificadores publicos/idempotencia usam ascii_bin; tokens somente em hash.
-- Estados aprovados: CRIADO, AGUARDANDO_PAGAMENTO, PAGO, CANCELADO, EXPIRADO,
-- PARCIALMENTE_REEMBOLSADO, REEMBOLSADO, ESTORNADO e REVISAO.
-- CHECK valida o vocabulario, nao substitui a futura maquina de estados.
-- Soma dos itens/total, transicoes, autorizacao, validacao de e-mail e geracao
-- criptografica de tokens/identificadores pertencem aos futuros servicos.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE existentes INT DEFAULT 0;

    IF DATABASE() IS NULL OR DATABASE() <> 'istbrasil' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Banco selecionado divergente; interromper.';
    END IF;

    SELECT COUNT(*) INTO existentes FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name IN (
        'ist_loja_sessoes', 'ist_loja_pedidos', 'ist_loja_pedido_itens'
    );
    IF existentes <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Fundacao existente ou parcial; nao repetir a migration.';
    END IF;

    SELECT COUNT(*) INTO existentes FROM information_schema.tables t
    JOIN information_schema.columns c ON c.table_schema = t.table_schema
        AND c.table_name = t.table_name
    WHERE t.table_schema = DATABASE() AND t.table_name = 'ist_loja_produtos'
        AND t.engine = 'InnoDB' AND c.column_name = 'id'
        AND c.data_type = 'int' AND c.column_type NOT LIKE '%unsigned%'
        AND c.column_key = 'PRI';
    IF existentes <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Catalogo exige PK INT signed em InnoDB; revisar esquema.';
    END IF;
    IF @@session.foreign_key_checks <> 1 OR @@session.check_constraint_checks <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'FKs e CHECKs devem estar habilitados antes da execucao.';
    END IF;
    -- O indice completo de e-mail utf8mb4 requer pagina InnoDB >= 8 KiB.
    -- ROW_FORMAT=DYNAMIC evita o limite de 767 bytes de formatos antigos.
    IF @@innodb_page_size < 8192 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Pagina InnoDB insuficiente para indice de e-mail; revisar.';
    END IF;

    CREATE TABLE ist_loja_sessoes (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        token_hash BINARY(32) NOT NULL,
        criada_em DATETIME(3) NOT NULL,
        expira_em DATETIME(3) NOT NULL,
        revogada_em DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_loja_sessoes_token_hash (token_hash),
        KEY idx_loja_sessoes_expira (expira_em),
        CONSTRAINT ck_loja_sessoes_validade CHECK (expira_em > criada_em),
        CONSTRAINT ck_loja_sessoes_revogacao CHECK (revogada_em IS NULL OR revogada_em >= criada_em)
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE ist_loja_pedidos (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        sessao_id INT UNSIGNED NOT NULL,
        comprador_email VARCHAR(254) NOT NULL,
        estado VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        ambiente VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        moeda CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        total_centavos BIGINT UNSIGNED NOT NULL,
        idempotencia_criacao CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        solicitacao_hash BINARY(32) NOT NULL,
        versao INT UNSIGNED NOT NULL DEFAULT 1,
        criado_em DATETIME(3) NOT NULL,
        atualizado_em DATETIME(3) NOT NULL,
        expira_em DATETIME(3) NOT NULL,
        pagamento_confirmado_em DATETIME(3) NULL,
        motivo_revisao VARCHAR(64) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_loja_pedidos_public_id (public_id),
        UNIQUE KEY uq_loja_pedidos_sessao_idempotencia (sessao_id, idempotencia_criacao),
        KEY idx_loja_pedidos_estado_criado (estado, criado_em),
        KEY idx_loja_pedidos_email_criado (comprador_email, criado_em),
        KEY idx_loja_pedidos_sessao_criado (sessao_id, criado_em),
        CONSTRAINT fk_loja_pedidos_sessao FOREIGN KEY (sessao_id)
            REFERENCES ist_loja_sessoes (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT ck_loja_pedidos_ambiente CHECK (BINARY ambiente IN ('sandbox', 'live')),
        CONSTRAINT ck_loja_pedidos_moeda CHECK (BINARY moeda = 'BRL'),
        CONSTRAINT ck_loja_pedidos_total CHECK (total_centavos > 0),
        CONSTRAINT ck_loja_pedidos_versao CHECK (versao > 0),
        CONSTRAINT ck_loja_pedidos_estado CHECK (BINARY estado IN (
            'CRIADO', 'AGUARDANDO_PAGAMENTO', 'PAGO', 'CANCELADO', 'EXPIRADO',
            'PARCIALMENTE_REEMBOLSADO', 'REEMBOLSADO', 'ESTORNADO', 'REVISAO'
        )),
        CONSTRAINT ck_loja_pedidos_atualizacao CHECK (atualizado_em >= criado_em),
        CONSTRAINT ck_loja_pedidos_validade CHECK (expira_em > criado_em),
        CONSTRAINT ck_loja_pedidos_confirmacao CHECK (
            pagamento_confirmado_em IS NULL OR pagamento_confirmado_em >= criado_em
        )
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE ist_loja_pedido_itens (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        pedido_id INT UNSIGNED NOT NULL,
        produto_id INT NOT NULL,
        posicao SMALLINT UNSIGNED NOT NULL,
        sku_snapshot VARCHAR(50) NOT NULL,
        titulo_snapshot TEXT NOT NULL,
        descricao_snapshot TEXT NULL,
        tipo_snapshot VARCHAR(32) NOT NULL,
        quantidade SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        preco_unitario_centavos BIGINT UNSIGNED NOT NULL,
        subtotal_centavos BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_loja_pedido_itens_produto (pedido_id, produto_id),
        UNIQUE KEY uq_loja_pedido_itens_posicao (pedido_id, posicao),
        KEY idx_loja_pedido_itens_produto (produto_id),
        CONSTRAINT fk_loja_pedido_itens_pedido FOREIGN KEY (pedido_id)
            REFERENCES ist_loja_pedidos (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT fk_loja_pedido_itens_produto FOREIGN KEY (produto_id)
            REFERENCES ist_loja_produtos (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT ck_loja_pedido_itens_posicao CHECK (posicao > 0),
        CONSTRAINT ck_loja_pedido_itens_quantidade CHECK (quantidade = 1),
        CONSTRAINT ck_loja_pedido_itens_preco CHECK (preco_unitario_centavos > 0),
        CONSTRAINT ck_loja_pedido_itens_subtotal CHECK (subtotal_centavos = preco_unitario_centavos)
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
END$$
DELIMITER ;
