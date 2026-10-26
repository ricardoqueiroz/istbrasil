-- Etapa 68.1: fundacao da outbox. Sem SMTP, backfill ou alteracao de pedidos.
-- NAO executar automaticamente. Aplicacao persistente exige autorizacao separada.
-- Operador deve comprovar externamente host/porta/schema/versao e backup.
-- Estas variaveis sao apenas confirmacoes explicitas, nao prova de isolamento.
-- Exige @ist_loja_681_schema_esperado = DATABASE() e
-- @ist_loja_681_ddl_autorizado = 'CRIAR_OUTBOX_68_1' na mesma sessao.
-- DDL tem COMMIT implicito: em falha parar, inspecionar e nao reaplicar cegamente.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE n INT DEFAULT 0;
    IF DATABASE() IS NULL OR @ist_loja_681_schema_esperado IS NULL
       OR BINARY DATABASE()<>BINARY @ist_loja_681_schema_esperado
       OR @ist_loja_681_ddl_autorizado IS NULL
       OR BINARY @ist_loja_681_ddl_autorizado<>BINARY 'CRIAR_OUTBOX_68_1'
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='68.1: destino nao autorizado'; END IF;
    IF VERSION() NOT REGEXP '^(10[.]3[.]39|13[.]0[.]2)-MariaDB(-|$)'
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='68.1: versao nao prevista'; END IF;
    IF @@in_transaction<>0 OR @@autocommit<>1 OR @@foreign_key_checks<>1 OR @@check_constraint_checks<>1
       OR (FIND_IN_SET('STRICT_TRANS_TABLES',@@sql_mode)=0 AND FIND_IN_SET('STRICT_ALL_TABLES',@@sql_mode)=0)
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='68.1: exige autocommit, modo estrito, FK e CHECK'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name='ist_loja_pedidos' AND table_type='BASE TABLE' AND engine='InnoDB';
    IF n<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='68.1: pedidos ausentes ou engine divergente'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema=DATABASE()
      AND table_name='ist_loja_pedidos' AND (
        (column_name='id' AND data_type='int' AND column_type LIKE '%unsigned%' AND column_key='PRI' AND is_nullable='NO')
        OR (column_name='comprador_email' AND data_type='varchar' AND character_maximum_length=254 AND is_nullable='NO')
        OR (column_name='ambiente' AND data_type='varchar' AND character_maximum_length=16 AND collation_name='ascii_bin' AND is_nullable='NO')
        OR (column_name='estado' AND data_type='varchar' AND character_maximum_length=32 AND collation_name='ascii_bin' AND is_nullable='NO')
        OR (column_name='pagamento_confirmado_em' AND data_type='datetime' AND datetime_precision=3 AND is_nullable='YES'));
    IF n<>5 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='68.1: contrato de pedidos divergente'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='ist_loja_notificacoes';
    IF n<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='68.1: outbox existente; inspecionar antes de repetir'; END IF;

    CREATE TABLE ist_loja_notificacoes (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      pedido_id INT UNSIGNED NOT NULL,
      finalidade VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      ambiente VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      destinatario VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      estado VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDENTE',
      tentativas SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      reserva_token BINARY(32) NULL,
      reserva_ate DATETIME(3) NULL,
      criado_em DATETIME(3) NOT NULL,
      atualizado_em DATETIME(3) NOT NULL,
      processamento_em DATETIME(3) NULL,
      concluido_em DATETIME(3) NULL,
      proxima_tentativa_em DATETIME(3) NULL,
      ultimo_erro_codigo VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      PRIMARY KEY(id),
      UNIQUE KEY uq_lnot_public_id(public_id),
      UNIQUE KEY uq_lnot_pedido_finalidade(pedido_id,finalidade),
      KEY idx_lnot_processamento(ambiente,estado,proxima_tentativa_em,id),
      CONSTRAINT fk_lnot_pedido FOREIGN KEY(pedido_id) REFERENCES ist_loja_pedidos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ck_lnot_public_id CHECK (public_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
      CONSTRAINT ck_lnot_finalidade CHECK (BINARY finalidade=BINARY 'CONFIRMACAO_COMPRA'),
      CONSTRAINT ck_lnot_ambiente CHECK (BINARY ambiente IN ('sandbox','live')),
      CONSTRAINT ck_lnot_email CHECK (CHAR_LENGTH(destinatario) BETWEEN 3 AND 254 AND destinatario NOT REGEXP '[[:space:][:cntrl:]]' AND destinatario LIKE '%@%'),
      CONSTRAINT ck_lnot_estado CHECK (BINARY estado IN ('PENDENTE','PROCESSANDO','ENVIADO','FALHA','INCERTO')),
      CONSTRAINT ck_lnot_reserva CHECK (
        (BINARY estado=BINARY 'PROCESSANDO' AND reserva_token IS NOT NULL AND reserva_ate IS NOT NULL
          AND processamento_em IS NOT NULL AND reserva_ate>processamento_em AND tentativas>0)
        OR (BINARY estado<>BINARY 'PROCESSANDO' AND reserva_token IS NULL AND reserva_ate IS NULL)),
      CONSTRAINT ck_lnot_conclusao CHECK (
        (BINARY estado=BINARY 'ENVIADO' AND processamento_em IS NOT NULL AND concluido_em IS NOT NULL AND tentativas>0 AND ultimo_erro_codigo IS NULL)
        OR (BINARY estado<>BINARY 'ENVIADO' AND concluido_em IS NULL)),
      CONSTRAINT ck_lnot_datas CHECK (atualizado_em>=criado_em
        AND (processamento_em IS NULL OR processamento_em BETWEEN criado_em AND atualizado_em)
        AND (concluido_em IS NULL OR concluido_em BETWEEN processamento_em AND atualizado_em)),
      CONSTRAINT ck_lnot_erro CHECK (ultimo_erro_codigo IS NULL OR ultimo_erro_codigo REGEXP '^[A-Z][A-Z0-9_]{0,63}$')
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name='ist_loja_notificacoes' AND engine='InnoDB';
    IF n<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='68.1: verificacao estrutural falhou'; END IF;
END$$
DELIMITER ;
