-- B7-C3: somente fundacao. Nao habilita emissao OTP.
-- DDL implica COMMIT; duas etapas nao atomicas. Nao reaplicar estado parcial.
-- Autorizar explicitamente na mesma sessao, apos conferir identidade e backup.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE n INT DEFAULT 0;
    IF DATABASE() IS NULL OR @ist_b7c3_schema IS NULL
       OR BINARY DATABASE()<>BINARY @ist_b7c3_schema
       OR COALESCE(@ist_b7c3_autorizacao,'')<>'FUNDACAO_OTP_B7_C3'
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='B7-C3: destino nao autorizado'; END IF;
    IF VERSION() NOT REGEXP '^10[.]3[.]39-MariaDB(-|$)'
       OR @@in_transaction<>0 OR @@autocommit<>1 OR @@foreign_key_checks<>1 OR @@check_constraint_checks<>1
       OR (FIND_IN_SET('STRICT_TRANS_TABLES',@@sql_mode)=0 AND FIND_IN_SET('STRICT_ALL_TABLES',@@sql_mode)=0)
       THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='B7-C3: versao ou sessao incompativel'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name IN ('ist_loja_download_recuperacoes','ist_loja_download_recuperacao_direitos','ist_loja_pedidos') AND engine='InnoDB';
    IF n<>3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='B7-C3: fundacao ausente'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.check_constraints WHERE constraint_schema=DATABASE()
      AND table_name='ist_loja_download_recuperacoes' AND constraint_name IN ('ck_ldr_desafio_data','ck_ldr_ciclo','ck_ldr_tentativas');
    IF n<>3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='B7-C3: constraints divergentes'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema=DATABASE()
      AND table_name='ist_loja_download_recuperacoes' AND column_name IN ('tipo','pedido_id','versao_protecao','invalidado_em','pedido_otp_aberto');
    IF n<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='B7-C3: estado parcial ou ja aplicado'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='ist_loja_download_recuperacao_limites';
    IF n<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='B7-C3: limites ja existentes'; END IF;

    ALTER TABLE ist_loja_download_recuperacoes
      ADD COLUMN tipo VARCHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'LINK',
      ADD COLUMN pedido_id INT UNSIGNED NULL,
      ADD COLUMN versao_protecao SMALLINT UNSIGNED NOT NULL DEFAULT 1,
      ADD COLUMN invalidado_em DATETIME(3) NULL,
      ADD COLUMN pedido_otp_aberto INT UNSIGNED AS
        (CASE WHEN tipo='OTP' AND consumido_em IS NULL AND invalidado_em IS NULL THEN pedido_id ELSE NULL END) PERSISTENT,
      DROP CONSTRAINT ck_ldr_desafio_data,
      ADD CONSTRAINT ck_ldr_desafio_data CHECK (
        (tipo='LINK' AND desafio_expira_em=TIMESTAMPADD(MINUTE,15,criado_em)) OR
        (tipo='OTP' AND desafio_expira_em=TIMESTAMPADD(MINUTE,10,criado_em))),
      ADD CONSTRAINT ck_ldr_tipo CHECK (
        (tipo='LINK' AND pedido_id IS NULL AND versao_protecao=1 AND invalidado_em IS NULL) OR
        (tipo='OTP' AND pedido_id IS NOT NULL AND versao_protecao>=1)),
      ADD CONSTRAINT ck_ldr_invalidacao CHECK (invalidado_em IS NULL OR
        (tipo='OTP' AND consumido_em IS NULL AND invalidado_em>=criado_em)),
      ADD KEY idx_ldr_tipo_pedido_criado(tipo,pedido_id,criado_em,id),
      ADD KEY idx_ldr_pedido(pedido_id),
      ADD UNIQUE KEY uq_ldr_otp_aberto(pedido_otp_aberto),
      ADD CONSTRAINT fk_ldr_pedido FOREIGN KEY(pedido_id) REFERENCES ist_loja_pedidos(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

    CREATE TABLE ist_loja_download_recuperacao_limites (
      escopo VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      versao_chave SMALLINT UNSIGNED NOT NULL,
      chave_hash BINARY(32) NOT NULL,
      janela_inicio DATETIME(3) NOT NULL,
      janela_fim DATETIME(3) NOT NULL,
      solicitacoes INT UNSIGNED NOT NULL DEFAULT 0,
      falhas INT UNSIGNED NOT NULL DEFAULT 0,
      reenvio_permitido_em DATETIME(3) NULL,
      bloqueado_ate DATETIME(3) NULL,
      atualizado_em DATETIME(3) NOT NULL,
      retencao_ate DATETIME(3) NOT NULL,
      PRIMARY KEY(escopo,versao_chave,chave_hash),
      KEY idx_ldrl_retencao(retencao_ate),
      CONSTRAINT ck_ldrl_escopo CHECK(escopo IN ('IP','TITULAR','PEDIDO')),
      CONSTRAINT ck_ldrl_versao CHECK(versao_chave>=1),
      CONSTRAINT ck_ldrl_datas CHECK(janela_fim>janela_inicio AND atualizado_em>=janela_inicio
        AND retencao_ate>=TIMESTAMPADD(DAY,7,janela_fim)
        AND retencao_ate>=TIMESTAMPADD(DAY,7,atualizado_em)
        AND (reenvio_permitido_em IS NULL OR retencao_ate>=TIMESTAMPADD(DAY,7,reenvio_permitido_em))
        AND (bloqueado_ate IS NULL OR retencao_ate>=TIMESTAMPADD(DAY,7,bloqueado_ate)))
    ) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
END$$
DELIMITER ;
