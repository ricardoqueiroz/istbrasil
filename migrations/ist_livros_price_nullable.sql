-- Fase 1.3: somente homologacao descartavel. Nao autoriza banco persistente.
-- DDL implica COMMIT; executar uma vez e parar em qualquer erro, sem --force.
-- O executor deve comprovar processo/container, mounts, host e porta externamente.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE n INT DEFAULT 0;
    IF VERSION() NOT REGEXP '^(13[.]0[.]2|10[.]3[.]39)-MariaDB(-|$)' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PRICE: versao nao homologada';
    END IF;
    IF DATABASE() IS NULL OR BINARY DATABASE() NOT REGEXP '^ist_loja_67_3_[0-9a-f]{12}$'
       OR NOT (
         (VERSION() LIKE '13.0.2-MariaDB%' AND UPPER(@@version_compile_os) LIKE 'WIN%'
          AND @@port NOT IN (3306,3307)
          AND REPLACE(@@datadir,CHAR(92),'/') REGEXP '/ist-loja-67-4-[a-zA-Z0-9]+/$')
         OR (VERSION() LIKE '10.3.39-MariaDB%' AND @@port=3306
          AND BINARY @@datadir='/var/lib/mysql/' AND BINARY @@hostname REGEXP '^[0-9a-f]{12}$')
       ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PRICE: destino nao autorizado';
    END IF;
    IF @@in_transaction<>0 OR @@autocommit<>1 OR @@foreign_key_checks<>1
       OR @@check_constraint_checks<>1
       OR (FIND_IN_SET('STRICT_TRANS_TABLES',@@sql_mode)=0
           AND FIND_IN_SET('STRICT_ALL_TABLES',@@sql_mode)=0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PRICE: configuracao insegura';
    END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name='ist_livros' AND engine='InnoDB' AND table_type='BASE TABLE';
    IF n<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PRICE: tabela divergente'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name='ist_livros' AND column_name='price'
        AND column_type='decimal(5,2)' AND numeric_precision=5 AND numeric_scale=2
        AND is_nullable='NO' AND column_default IS NULL AND column_comment='' AND extra='';
    IF n<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PRICE: coluna divergente ou ja aplicada'; END IF;
    ALTER TABLE ist_livros MODIFY COLUMN price DECIMAL(5,2) NULL DEFAULT NULL;
    SELECT COUNT(*) INTO n FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name='ist_livros' AND column_name='price'
        AND column_type='decimal(5,2)' AND numeric_precision=5 AND numeric_scale=2
        AND is_nullable='YES' AND (column_default IS NULL OR column_default='NULL')
        AND column_comment='' AND extra='';
    IF n<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PRICE: pos-condicao falhou; interromper'; END IF;
END$$
DELIMITER ;
