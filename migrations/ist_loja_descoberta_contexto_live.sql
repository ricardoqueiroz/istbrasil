-- Etapa 11.1: somente descoberta opcional. Nao executar automaticamente no deploy.
-- Preserva dados/indices. DDL tem COMMIT implicito; exige backup e autorizacao.
-- SET @ist_111_schema = 'schema_explicitamente_autorizado';
-- SET @ist_111_autorizacao = 'DESCOBERTA_LIVE_11_1';
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE definicao LONGTEXT;
    DECLARE quantidade INT;
    IF DATABASE() IS NULL OR @ist_111_schema IS NULL
       OR BINARY DATABASE()<>BINARY @ist_111_schema
       OR COALESCE(@ist_111_autorizacao,'')<>'DESCOBERTA_LIVE_11_1'
       OR VERSION() NOT REGEXP '^10[.]3[.]39-MariaDB(-|$)'
       OR @@in_transaction<>0 OR @@autocommit<>1
       OR @@foreign_key_checks<>1 OR @@check_constraint_checks<>1
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='11.1: destino, versao ou sessao nao autorizados'; END IF;
    SELECT COUNT(*) INTO quantidade FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ist_loja_descoberta_checkpoints' AND ENGINE='InnoDB';
    IF quantidade<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='11.1: tabela ausente ou engine divergente'; END IF;
    SELECT COUNT(*),MAX(CHECK_CLAUSE) INTO quantidade,definicao FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='ist_loja_descoberta_checkpoints'
        AND CONSTRAINT_NAME='ck_ldc_contexto';
    IF quantidade<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='11.1: CHECK ausente ou ambigua'; END IF;
    SET definicao=LOWER(REGEXP_REPLACE(REPLACE(definicao,'`',''),'[[:space:]]',''));
    IF definicao='provedor=''paypal''andambiente=''sandbox''andchar_length(trim(conta_recebedora))>0' THEN
        ALTER TABLE ist_loja_descoberta_checkpoints
          DROP CONSTRAINT ck_ldc_contexto,
          ADD CONSTRAINT ck_ldc_contexto CHECK(provedor='paypal' AND ambiente IN ('sandbox','live') AND CHAR_LENGTH(TRIM(conta_recebedora))>0);
    ELSEIF definicao<>'provedor=''paypal''andambientein(''sandbox'',''live'')andchar_length(trim(conta_recebedora))>0' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='11.1: definicao CHECK divergente; interromper';
    END IF;
END$$
DELIMITER ;

-- Pos-validacao somente leitura.
SELECT CONSTRAINT_NAME,CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='ist_loja_descoberta_checkpoints'
   AND CONSTRAINT_NAME='ck_ldc_contexto';
