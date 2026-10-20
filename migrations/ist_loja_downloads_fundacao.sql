-- D5.1-B1: somente schema; nenhum backfill ou publicacao de arquivos.
-- DDL faz COMMIT implicito. Executar uma vez, sem --force; parar em falha parcial.
-- Nesta etapa usar EXCLUSIVAMENTE instancia descartavel identificada pelo executor.
-- O nome do schema nao prova isolamento. Nao aplicar no banco principal.
-- Datas DATETIME(3) em UTC. Hash binario; caminhos relativos internos controlados.
-- CHECK/FK nao implementam imutabilidade, transicoes, autorizacao ou auditoria automatica.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE n INT DEFAULT 0;
    -- SQL reduz destinos acidentais, mas nao autentica host cliente/instancia.
    -- Executor deve validar externamente identidade, destino, hash e autorizacao.
    -- Nenhuma variavel de sessao habilita o destino principal.
    IF VERSION() NOT REGEXP '^(13[.]0[.]2|10[.]3[.]39)-MariaDB(-|$)' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: versao MariaDB nao homologada';
    END IF;
    IF DATABASE() IS NULL OR NOT (
      (BINARY DATABASE() REGEXP '^ist_loja_67_3_[0-9a-f]{12}$'
        AND (
          (VERSION() REGEXP '^13[.]0[.]2-MariaDB(-|$)'
            AND UPPER(@@version_compile_os) LIKE 'WIN%'
            AND @@port NOT IN (3306,3307)
            AND REPLACE(@@datadir,CHAR(92),'/') REGEXP '/ist-loja-67-4-[a-z0-9]+/$')
          OR (VERSION() REGEXP '^10[.]3[.]39-MariaDB(-|$)'
            AND @@port=3306 AND BINARY @@datadir='/var/lib/mysql/'
            AND BINARY @@hostname REGEXP '^[0-9a-f]{12}$')
        ))
      OR (BINARY DATABASE()='istbrasil'
        AND VERSION() REGEXP '^13[.]0[.]2-MariaDB(-|$)'
        AND UPPER(@@version_compile_os) LIKE 'WIN%'
        AND (
          (@@port=3306 AND BINARY REPLACE(@@datadir,CHAR(92),'/')='C:/Program Files/MariaDB 13.0/data/')
          OR (@@port NOT IN (3306,3307)
            AND REPLACE(@@datadir,CHAR(92),'/') REGEXP '/ist-loja-67-4-[a-z0-9]+/$')
        ))
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: destino nao autorizado pelo perfil local/descartavel';
    END IF;
    IF @@in_transaction <> 0 OR @@autocommit <> 1
       OR @@session.foreign_key_checks <> 1 OR @@session.check_constraint_checks <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: exige autocommit, FK e CHECK ativos';
    END IF;
    IF FIND_IN_SET('STRICT_TRANS_TABLES',@@sql_mode)=0
       AND FIND_IN_SET('STRICT_ALL_TABLES',@@sql_mode)=0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: exige modo estrito';
    END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name IN
        ('ist_loja_produtos','ist_loja_pedido_itens') AND engine='InnoDB' AND table_type='BASE TABLE';
    IF n<>2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: prerequisitos ausentes'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema=DATABASE() AND (
      (table_name='ist_loja_produtos' AND column_name='id' AND data_type='int'
        AND column_type NOT LIKE '%unsigned%' AND column_key='PRI' AND is_nullable='NO')
      OR (table_name='ist_loja_pedido_itens' AND column_name='id' AND data_type='int'
        AND column_type LIKE '%unsigned%' AND column_key='PRI' AND is_nullable='NO')
      OR (table_name='ist_loja_pedido_itens' AND column_name='produto_id' AND data_type='int'
        AND column_type NOT LIKE '%unsigned%' AND is_nullable='NO'));
    IF n<>3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: tipos de referencia divergentes'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.key_column_usage
      WHERE constraint_schema=DATABASE() AND table_name='ist_loja_pedido_itens'
        AND column_name='produto_id' AND referenced_table_schema=DATABASE()
        AND referenced_table_name='ist_loja_produtos' AND referenced_column_name='id';
    IF n<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: FK de produto ausente'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name IN ('ist_loja_arquivo_versoes','ist_loja_download_direitos','ist_loja_download_direito_eventos');
    IF n<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: estrutura existente ou parcial; nao repetir'; END IF;
    -- Nao adotar indice preexistente inesperado nem criar duplicata equivalente.
    SELECT COUNT(*) INTO n FROM (
      SELECT index_name FROM information_schema.statistics
        WHERE table_schema=DATABASE() AND table_name='ist_loja_pedido_itens'
        GROUP BY index_name HAVING index_name='uq_lpi_id_produto_download'
          OR GROUP_CONCAT(column_name ORDER BY seq_in_index)='id,produto_id'
    ) AS indices;
    IF n<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='D5.1: indice existente; revisar antes de alterar'; END IF;

    ALTER TABLE ist_loja_pedido_itens
      ADD UNIQUE KEY uq_lpi_id_produto_download(id,produto_id);

    CREATE TABLE ist_loja_arquivo_versoes (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      produto_id INT NOT NULL,
      arquivo_logico_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      numero_versao INT UNSIGNED NOT NULL,
      caminho_relativo VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      tamanho_bytes BIGINT UNSIGNED NOT NULL,
      sha256 BINARY(32) NOT NULL,
      mime VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      estado VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'RASCUNHO',
      publicacao_atual TINYINT UNSIGNED NULL DEFAULT NULL,
      criado_em DATETIME(3) NOT NULL,
      publicado_em DATETIME(3) NULL,
      retirado_em DATETIME(3) NULL,
      PRIMARY KEY(id),
      UNIQUE KEY uq_lav_public_id(public_id),
      UNIQUE KEY uq_lav_produto_versao(produto_id,numero_versao),
      UNIQUE KEY uq_lav_produto_atual(produto_id,publicacao_atual),
      UNIQUE KEY uq_lav_id_produto(id,produto_id),
      CONSTRAINT fk_lav_produto FOREIGN KEY(produto_id) REFERENCES ist_loja_produtos(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ck_lav_ids CHECK(CHAR_LENGTH(TRIM(public_id))=36
        AND CHAR_LENGTH(TRIM(arquivo_logico_id))=36 AND numero_versao>0),
      -- Nomes gerados/controlados: sem URL, drive, separadores Windows, percent ou '..'.
      CONSTRAINT ck_lav_caminho CHECK(BINARY caminho_relativo REGEXP '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*[.]pdf$'
        AND BINARY caminho_relativo NOT REGEXP '[^A-Za-z0-9_./-]'),
      CONSTRAINT ck_lav_tamanho CHECK(tamanho_bytes>0 AND tamanho_bytes<=9007199254740991),
      CONSTRAINT ck_lav_mime CHECK(BINARY mime='application/pdf'),
      CONSTRAINT ck_lav_estado CHECK(BINARY estado IN ('RASCUNHO','PUBLICADA','RETIRADA')),
      CONSTRAINT ck_lav_publicacao CHECK(
        (BINARY estado='RASCUNHO' AND publicacao_atual IS NULL AND publicado_em IS NULL AND retirado_em IS NULL)
        OR (BINARY estado='PUBLICADA' AND publicacao_atual IS NOT NULL AND publicacao_atual=1
          AND publicado_em IS NOT NULL AND retirado_em IS NULL)
        OR (BINARY estado='RETIRADA' AND publicacao_atual IS NULL AND publicado_em IS NOT NULL AND retirado_em IS NOT NULL)),
      CONSTRAINT ck_lav_datas CHECK((publicado_em IS NULL OR publicado_em>=criado_em)
        AND (retirado_em IS NULL OR (publicado_em IS NOT NULL AND retirado_em>=publicado_em)))
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- Datas representam a ocorrencia MAIS RECENTE de cada tipo, nao sao apagadas
    -- ao reativar. O historico conserva todas as ocorrencias anteriores.
    CREATE TABLE ist_loja_download_direitos (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      pedido_item_id INT UNSIGNED NOT NULL,
      produto_id INT NOT NULL,
      arquivo_versao_id INT UNSIGNED NOT NULL,
      estado VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'AGUARDANDO_CONFIRMACAO',
      criado_em DATETIME(3) NOT NULL, atualizado_em DATETIME(3) NOT NULL,
      ativado_em DATETIME(3) NULL, suspenso_em DATETIME(3) NULL, revogado_em DATETIME(3) NULL,
      motivo_codigo VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      versao INT UNSIGNED NOT NULL DEFAULT 1,
      PRIMARY KEY(id),
      UNIQUE KEY uq_ldd_public_id(public_id),
      UNIQUE KEY uq_ldd_item(pedido_item_id),
      KEY idx_ldd_item_produto(pedido_item_id,produto_id),
      KEY idx_ldd_arquivo_produto(arquivo_versao_id,produto_id),
      KEY idx_ldd_estado(estado,atualizado_em,id),
      CONSTRAINT fk_ldd_item FOREIGN KEY(pedido_item_id,produto_id)
        REFERENCES ist_loja_pedido_itens(id,produto_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_ldd_arquivo FOREIGN KEY(arquivo_versao_id,produto_id)
        REFERENCES ist_loja_arquivo_versoes(id,produto_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ck_ldd_ids CHECK(CHAR_LENGTH(TRIM(public_id))=36 AND versao>0),
      CONSTRAINT ck_ldd_estado CHECK(BINARY estado IN ('AGUARDANDO_CONFIRMACAO','ATIVO','SUSPENSO','REVOGADO')),
      CONSTRAINT ck_ldd_datas CHECK(atualizado_em>=criado_em
        AND (ativado_em IS NULL OR ativado_em BETWEEN criado_em AND atualizado_em)
        AND (suspenso_em IS NULL OR suspenso_em BETWEEN criado_em AND atualizado_em)
        AND (revogado_em IS NULL OR revogado_em BETWEEN criado_em AND atualizado_em)),
      CONSTRAINT ck_ldd_estado_datas CHECK(
        (BINARY estado='AGUARDANDO_CONFIRMACAO' AND ativado_em IS NULL AND suspenso_em IS NULL
          AND revogado_em IS NULL AND motivo_codigo IS NULL)
        OR (BINARY estado='ATIVO' AND ativado_em IS NOT NULL AND revogado_em IS NULL AND motivo_codigo IS NULL
          AND (suspenso_em IS NULL OR ativado_em>=suspenso_em))
        OR (BINARY estado='SUSPENSO' AND suspenso_em IS NOT NULL AND revogado_em IS NULL
          AND motivo_codigo IS NOT NULL AND (ativado_em IS NULL OR suspenso_em>=ativado_em))
        OR (BINARY estado='REVOGADO' AND revogado_em IS NOT NULL AND motivo_codigo IS NOT NULL
          AND (ativado_em IS NULL OR revogado_em>=ativado_em)
          AND (suspenso_em IS NULL OR revogado_em>=suspenso_em))),
      CONSTRAINT ck_ldd_motivo CHECK(motivo_codigo IS NULL OR CHAR_LENGTH(TRIM(motivo_codigo))>0)
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE ist_loja_download_direito_eventos (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      direito_id INT UNSIGNED NOT NULL,
      direito_versao INT UNSIGNED NOT NULL,
      estado_anterior VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
      estado_novo VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      origem VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      motivo_codigo VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      ator_referencia VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ocorrido_em DATETIME(3) NOT NULL,
      PRIMARY KEY(id),
      UNIQUE KEY uq_ldde_transicao(direito_id,direito_versao),
      CONSTRAINT fk_ldde_direito FOREIGN KEY(direito_id) REFERENCES ist_loja_download_direitos(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ck_ldde_versao CHECK(direito_versao>0),
      CONSTRAINT ck_ldde_anterior CHECK(estado_anterior IS NULL OR BINARY estado_anterior IN
        ('AGUARDANDO_CONFIRMACAO','ATIVO','SUSPENSO','REVOGADO')),
      CONSTRAINT ck_ldde_novo CHECK(BINARY estado_novo IN ('AGUARDANDO_CONFIRMACAO','ATIVO','SUSPENSO','REVOGADO')),
      CONSTRAINT ck_ldde_origem CHECK(BINARY origem IN ('PEDIDO','FINANCEIRO','ADMINISTRACAO')),
      CONSTRAINT ck_ldde_motivo CHECK(CHAR_LENGTH(TRIM(motivo_codigo))>0),
      CONSTRAINT ck_ldde_ator CHECK(BINARY origem<>'ADMINISTRACAO'
        OR (ator_referencia IS NOT NULL AND CHAR_LENGTH(TRIM(ator_referencia))>0))
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
END$$
DELIMITER ;
