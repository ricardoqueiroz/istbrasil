-- D7.1-B1. Somente fundacao; sem backfill, carga ou alteracao de tabelas existentes.
-- DDL tem COMMIT implicito: parar em qualquer erro, nunca reaplicar parcialmente.
-- Nesta homologacao, SOMENTE instancia descartavel verificada externamente.
-- Nome/variaveis SQL nao substituem a verificacao de identidade pela fixture.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE n INT DEFAULT 0;
    IF DATABASE() IS NULL OR BINARY DATABASE() NOT REGEXP '^ist_loja_67_3_[0-9a-f]{12}$'
       OR NOT (
         (VERSION() REGEXP '^13[.]0[.]2-MariaDB(-|$)'
           AND UPPER(@@version_compile_os) LIKE 'WIN%' AND @@port NOT IN (3306,3307)
           AND REPLACE(@@datadir,CHAR(92),'/') REGEXP '/ist-loja-67-4-[a-z0-9]+/$')
         OR (VERSION() REGEXP '^10[.]3[.]39-MariaDB(-|$)'
           AND @@port=3306 AND BINARY @@datadir='/var/lib/mysql/'
           AND BINARY @@hostname REGEXP '^[0-9a-f]{12}$')
       ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D7.1: destino descartavel nao autorizado'; END IF;
    IF @@in_transaction<>0 OR @@autocommit<>1 OR @@foreign_key_checks<>1 OR @@check_constraint_checks<>1
       OR (FIND_IN_SET('STRICT_TRANS_TABLES',@@sql_mode)=0 AND FIND_IN_SET('STRICT_ALL_TABLES',@@sql_mode)=0)
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D7.1: exige autocommit, modo estrito, FK e CHECK'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name IN ('ist_loja_download_direitos','ist_loja_arquivo_versoes','ist_loja_pedidos')
      AND engine='InnoDB' AND table_type='BASE TABLE';
    IF n<>3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D7.1: prerequisitos ausentes'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema=DATABASE()
      AND table_name IN ('ist_loja_download_direitos','ist_loja_arquivo_versoes')
      AND column_name='id' AND data_type='int' AND column_type LIKE '%unsigned%'
      AND column_key='PRI' AND is_nullable='NO';
    IF n<>2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D7.1: referencias divergentes'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema=DATABASE()
      AND table_name='ist_loja_pedidos' AND column_name='comprador_email'
      AND data_type='varchar' AND character_maximum_length=254 AND is_nullable='NO';
    IF n<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D7.1: contrato de email divergente'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name IN ('ist_loja_download_recuperacoes','ist_loja_download_recuperacao_direitos');
    IF n<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D7.1: estrutura existente/parcial; nao repetir'; END IF;

    CREATE TABLE ist_loja_download_recuperacoes (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      desafio_hash BINARY(32) NOT NULL,
      email_chave BINARY(32) NOT NULL,
      email_normalizado VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NULL,
      criado_em DATETIME(3) NOT NULL,
      desafio_expira_em DATETIME(3) NOT NULL,
      tentativas TINYINT UNSIGNED NOT NULL DEFAULT 0,
      consumido_em DATETIME(3) NULL,
      sessao_hash BINARY(32) NULL,
      sessao_criada_em DATETIME(3) NULL,
      sessao_expira_em DATETIME(3) NULL,
      revogada_em DATETIME(3) NULL,
      PRIMARY KEY(id),
      UNIQUE KEY uq_ldr_public_id(public_id),
      UNIQUE KEY uq_ldr_desafio_hash(desafio_hash),
      UNIQUE KEY uq_ldr_sessao_hash(sessao_hash),
      KEY idx_ldr_email_criado(email_chave,criado_em),
      KEY idx_ldr_desafio_expira(desafio_expira_em),
      KEY idx_ldr_sessao_expira(sessao_expira_em),
      CONSTRAINT ck_ldr_id CHECK(CHAR_LENGTH(TRIM(public_id))=36),
      CONSTRAINT ck_ldr_tentativas CHECK(tentativas<=5),
      CONSTRAINT ck_ldr_desafio_data CHECK(desafio_expira_em=TIMESTAMPADD(MINUTE,15,criado_em)),
      CONSTRAINT ck_ldr_ciclo CHECK(
        (consumido_em IS NULL AND email_normalizado IS NOT NULL
          AND CHAR_LENGTH(email_normalizado) BETWEEN 3 AND 254
          AND sessao_hash IS NULL AND sessao_criada_em IS NULL AND sessao_expira_em IS NULL AND revogada_em IS NULL)
        OR (consumido_em IS NOT NULL AND email_normalizado IS NULL AND tentativas<5
          AND consumido_em>=criado_em AND consumido_em<desafio_expira_em
          AND sessao_hash IS NOT NULL AND sessao_hash<>desafio_hash
          AND sessao_criada_em IS NOT NULL AND sessao_criada_em=consumido_em
          AND sessao_expira_em IS NOT NULL AND sessao_expira_em>sessao_criada_em
          AND sessao_expira_em<=TIMESTAMPADD(HOUR,24,sessao_criada_em)
          AND (revogada_em IS NULL OR revogada_em>=sessao_criada_em)))
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- Escopo adquirido, nao a publicacao atual. Somente INSERT no consumo;
    -- FK/CHECK nao substituem imutabilidade e autorizacao no servico.
    CREATE TABLE ist_loja_download_recuperacao_direitos (
      recuperacao_id INT UNSIGNED NOT NULL,
      direito_id INT UNSIGNED NOT NULL,
      arquivo_versao_id INT UNSIGNED NOT NULL,
      PRIMARY KEY(recuperacao_id,direito_id),
      KEY idx_ldrd_direito(direito_id),
      KEY idx_ldrd_arquivo(arquivo_versao_id),
      CONSTRAINT fk_ldrd_recuperacao FOREIGN KEY(recuperacao_id)
        REFERENCES ist_loja_download_recuperacoes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_ldrd_direito FOREIGN KEY(direito_id)
        REFERENCES ist_loja_download_direitos(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_ldrd_arquivo FOREIGN KEY(arquivo_versao_id)
        REFERENCES ist_loja_arquivo_versoes(id) ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
END$$
DELIMITER ;
