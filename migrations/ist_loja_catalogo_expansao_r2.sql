-- R2: executar manualmente, em janela sem escritores, com backup conferido.
-- NAO aplicar ao banco principal sem autorizacao expressa posterior.
-- MariaDB 10.3: sintaxe alvo; execucao em 13 nao comprova homologacao em 10.3.
-- Mesma conexao, sem transacao aberta e sem --force. DDL tem commit implicito.
-- Reexecucao/estrutura parcial: recusar ANTES de qualquer mutacao, nunca reparar.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE n INT DEFAULT 0;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
    IF DATABASE() IS NULL OR (DATABASE() <> 'istbrasil'
        AND DATABASE() NOT REGEXP '^ist_loja_67_3_[0-9a-f]{12}$')
        OR @@in_transaction <> 0 OR @@foreign_key_checks <> 1
        OR @@check_constraint_checks <> 1 OR @@autocommit <> 1
        OR FIND_IN_SET('STRICT_TRANS_TABLES', @@sql_mode) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: destino ou sessao invalida';
    END IF;
    SELECT COUNT(*) INTO n FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name='ist_loja_perfis_fiscais';
    IF n <> 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: estrutura existente; nao repetir'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema=DATABASE()
      AND ((table_name='ist_livros' AND column_name='pertence_editora_ist')
        OR (table_name='ist_loja_produtos' AND column_name IN
          ('tipo','titulo','descricao','preco_centavos','moeda','em_venda','disponivel','imagem_url','perfil_fiscal_id')));
    IF n <> 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: estrutura parcial; nao retomar'; END IF;
    SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema=DATABASE()
      AND table_name IN ('ist_livros','ist_loja_produtos','ist_loja_categorias')
      AND column_name='id' AND data_type='int' AND column_type NOT LIKE '%unsigned%' AND column_key='PRI';
    IF n <> 3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: tipos de PK divergentes'; END IF;
    SELECT COUNT(*) INTO n FROM ist_loja_produtos;
    IF n <> 3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: conjunto comercial divergente'; END IF;
    SELECT COUNT(*) INTO n FROM ist_loja_produtos p JOIN ist_livros l ON l.id=p.livro_id
      WHERE ((p.id=1 AND l.id=1 AND BINARY p.sku=BINARY '9788552911036EN2E' AND l.price=95.00)
        OR (p.id=2 AND l.id=2 AND BINARY p.sku=BINARY '9788552911036PT2E' AND l.price=95.00)
        OR (p.id=6 AND l.id=3 AND BINARY p.sku=BINARY 'IST-SANDBOX-CHECKOUT-001' AND l.price=1.00))
      AND BINARY l.sku=BINARY p.sku AND BINARY l.currency=BINARY 'BRL'
      AND BINARY l.format=BINARY 'E-Book' AND l.onsale IN (0,1)
      AND l.inventory IN ('Em estoque','Poucas unidades','Esgotado')
      AND CHAR_LENGTH(TRIM(l.title))>0 AND l.file IS NOT NULL AND CHAR_LENGTH(TRIM(l.file))>0
      AND OCTET_LENGTH(CONVERT(l.title USING utf8mb4))<=65535
      AND BINARY CONVERT(CONVERT(l.title USING utf8mb4) USING latin1)=BINARY l.title
      AND (l.img IS NULL OR BINARY CONVERT(CONVERT(l.img USING utf8mb4) USING latin1)=BINARY l.img);
    IF n <> 3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: dados ou conversao de caracteres divergentes'; END IF;

    CREATE TABLE ist_loja_perfis_fiscais (
      id INT NOT NULL AUTO_INCREMENT, codigo VARCHAR(50) NOT NULL, nome VARCHAR(100) NOT NULL,
      ativo TINYINT(1) NOT NULL DEFAULT 1, ncm VARCHAR(8) NULL, cest VARCHAR(7) NULL,
      codigo_servico VARCHAR(30) NULL, PRIMARY KEY(id),
      UNIQUE KEY uq_loja_perfil_fiscal_codigo(codigo),
      CONSTRAINT ck_loja_perfil_fiscal_ativo CHECK(ativo IN (0,1))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ALTER TABLE ist_loja_produtos
      MODIFY livro_id INT NULL,
      ADD tipo VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD titulo TEXT NULL, ADD descricao LONGTEXT NULL,
      ADD preco_centavos BIGINT UNSIGNED NULL,
      ADD moeda CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD em_venda TINYINT(1) NULL, ADD disponivel TINYINT(1) NULL,
      ADD imagem_url TEXT NULL, ADD perfil_fiscal_id INT NULL,
      ADD CONSTRAINT fk_loja_produto_perfil_fiscal FOREIGN KEY(perfil_fiscal_id)
        REFERENCES ist_loja_perfis_fiscais(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      ADD CONSTRAINT ck_loja_produto_tipo CHECK(tipo IN ('MERCADORIA','SERVICO','DIGITAL')),
      ADD CONSTRAINT ck_loja_produto_preco CHECK(preco_centavos>0 AND preco_centavos<=9007199254740991),
      ADD CONSTRAINT ck_loja_produto_moeda CHECK(moeda='BRL'),
      ADD CONSTRAINT ck_loja_produto_em_venda CHECK(em_venda IN (0,1)),
      ADD CONSTRAINT ck_loja_produto_disponivel CHECK(disponivel IN (0,1));
    ALTER TABLE ist_livros ADD pertence_editora_ist TINYINT(1) NULL DEFAULT NULL,
      ADD CONSTRAINT ck_livro_pertence_editora_ist CHECK(pertence_editora_ist IN (0,1));

    START TRANSACTION;
    UPDATE ist_loja_produtos p JOIN ist_livros l ON l.id=p.livro_id
      SET p.tipo='DIGITAL', p.titulo=CONVERT(l.title USING utf8mb4),
        p.descricao=CONVERT(l.description USING utf8mb4),
        p.preco_centavos=CAST(l.price*100 AS UNSIGNED), p.moeda=l.currency,
        p.em_venda=l.onsale, p.disponivel=(l.inventory IN ('Em estoque','Poucas unidades')),
        p.imagem_url=CONVERT(l.img USING utf8mb4)
      WHERE p.id IN (1,2,6);
    IF ROW_COUNT() <> 3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: carga incompleta'; END IF;
    UPDATE ist_livros SET pertence_editora_ist=CASE id WHEN 1 THEN 1 WHEN 2 THEN 1 WHEN 3 THEN 0 END
      WHERE id IN (1,2,3);
    IF ROW_COUNT() <> 3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: classificacao incompleta'; END IF;
    SELECT COUNT(*) INTO n FROM ist_loja_produtos p JOIN ist_livros l ON l.id=p.livro_id
      WHERE p.id IN (1,2,6) AND p.tipo='DIGITAL'
        AND BINARY p.titulo=BINARY CONVERT(l.title USING utf8mb4)
        AND (BINARY p.descricao <=> BINARY CONVERT(l.description USING utf8mb4))
        AND (BINARY p.imagem_url <=> BINARY CONVERT(l.img USING utf8mb4))
        AND p.preco_centavos=l.price*100 AND BINARY p.moeda=BINARY l.currency
        AND p.em_venda=l.onsale AND p.disponivel=(l.inventory IN ('Em estoque','Poucas unidades'))
        AND p.perfil_fiscal_id IS NULL;
    IF n <> 3 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='R2: conferencia pos-carga falhou'; END IF;
    COMMIT;
    -- Campos novos permanecem opcionais na expansao, conforme R1. R3 nao iniciada.
END$$
DELIMITER ;
