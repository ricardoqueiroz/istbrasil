-- D9-B3: checkpoint de descoberta adversa para producao persistente.
-- Sem backfill, carga ou alteracao de tabelas existentes.
-- DDL tem COMMIT implicito: parar no primeiro erro e nunca reaplicar parcialmente.
-- A autorizacao SQL nao substitui a verificacao externa de identidade e backup.
-- Exige @ist_loja_d9_schema_esperado = 'istbrasil' e
-- @ist_loja_d9_ddl_autorizado = 'CRIAR_DESCOBERTA_ADVERSA_D9_PRODUCAO'
-- definidos explicitamente na mesma sessao.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE n INT DEFAULT 0;
    IF DATABASE() IS NULL OR BINARY DATABASE()<>BINARY 'istbrasil'
       OR @ist_loja_d9_schema_esperado IS NULL
       OR BINARY @ist_loja_d9_schema_esperado<>BINARY 'istbrasil'
       OR BINARY DATABASE()<>BINARY @ist_loja_d9_schema_esperado
       OR @ist_loja_d9_ddl_autorizado IS NULL
       OR BINARY @ist_loja_d9_ddl_autorizado<>BINARY 'CRIAR_DESCOBERTA_ADVERSA_D9_PRODUCAO'
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D9 PROD: destino nao autorizado'; END IF;
    IF VERSION() NOT REGEXP '^10[.]3[.]39-MariaDB(-|$)'
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D9 PROD: versao nao prevista'; END IF;
    IF @@in_transaction<>0 OR @@autocommit<>1 OR @@foreign_key_checks<>1 OR @@check_constraint_checks<>1
       OR (FIND_IN_SET('STRICT_TRANS_TABLES',@@sql_mode)=0 AND FIND_IN_SET('STRICT_ALL_TABLES',@@sql_mode)=0)
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D9 PROD: exige autocommit, modo estrito, FK e CHECK'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name IN ('ist_loja_pagamentos','ist_loja_pagamento_eventos')
      AND engine='InnoDB' AND table_type='BASE TABLE';
    IF n<>2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D9 PROD: prerequisitos ausentes'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name='ist_loja_descoberta_checkpoints';
    IF n<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D9 PROD: estrutura existente; nao repetir'; END IF;

    CREATE TABLE ist_loja_descoberta_checkpoints (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        provedor VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        ambiente VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        conta_recebedora VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        fonte VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        estado VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        inicio_configurado DATETIME(3) NOT NULL,
        ultima_inicio DATETIME(3) NULL,
        ultima_fim DATETIME(3) NULL,
        janela_inicio DATETIME(3) NULL,
        janela_fim DATETIME(3) NULL,
        execucao_token BINARY(16) NULL,
        execucao_ate DATETIME(3) NULL,
        proxima_execucao DATETIME(3) NOT NULL,
        codigo_erro VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        tentativas SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        atualizado_em DATETIME(3) NOT NULL,
        PRIMARY KEY(id),
        UNIQUE KEY uq_ldc_contexto(provedor,ambiente,conta_recebedora,fonte),
        CONSTRAINT ck_ldc_contexto CHECK(provedor='paypal' AND ambiente='sandbox' AND CHAR_LENGTH(TRIM(conta_recebedora))>0),
        CONSTRAINT ck_ldc_fonte CHECK(fonte IN ('NOTIFICACOES','DISPUTAS','TRANSACOES')),
        CONSTRAINT ck_ldc_estado CHECK(estado IN ('PRONTO','EXECUTANDO','REVISAO')),
        CONSTRAINT ck_ldc_reserva CHECK((estado='EXECUTANDO' AND execucao_token IS NOT NULL AND execucao_ate IS NOT NULL
            AND execucao_ate>atualizado_em AND janela_inicio IS NOT NULL AND janela_fim IS NOT NULL)
            OR (estado<>'EXECUTANDO' AND execucao_token IS NULL AND execucao_ate IS NULL)),
        CONSTRAINT ck_ldc_janela CHECK((janela_inicio IS NULL AND janela_fim IS NULL)
            OR (janela_inicio IS NOT NULL AND janela_fim IS NOT NULL AND janela_fim>janela_inicio AND janela_inicio>=inicio_configurado)),
        CONSTRAINT ck_ldc_ultima CHECK((ultima_inicio IS NULL AND ultima_fim IS NULL)
            OR (ultima_inicio IS NOT NULL AND ultima_fim IS NOT NULL AND ultima_fim>ultima_inicio AND ultima_inicio>=inicio_configurado)),
        CONSTRAINT ck_ldc_tentativas CHECK(tentativas<=8)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name='ist_loja_descoberta_checkpoints' AND engine='InnoDB' AND table_type='BASE TABLE';
    IF n<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D9 PROD: verificacao estrutural falhou'; END IF;
END$$
DELIMITER ;
