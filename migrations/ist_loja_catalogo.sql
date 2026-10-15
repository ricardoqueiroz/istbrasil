-- Catalogo comercial IST. Aplicacao manual, exclusivamente local nesta etapa.
-- Alvo: MariaDB 10.3.39. Executar na mesma conexao e parar no primeiro erro.
-- Nao repetir em caso de execucao parcial. Nao usar cliente com --force.
-- DDL faz commit implicito: o handler desfaz somente a carga, nunca as tabelas.
-- Precos, titulos, descricoes, imagens e arquivos continuam em ist_livros.
-- BEGIN NOT ATOMIC e SIGNAL sao suportados pelo MariaDB 10.3.
DELIMITER $$
BEGIN NOT ATOMIC
    DECLARE elegiveis INT DEFAULT 0;
    DECLARE existentes INT DEFAULT 0;
    DECLARE raiz INT;
    DECLARE musica INT;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    IF DATABASE() IS NULL OR DATABASE() <> 'istbrasil' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Banco selecionado divergente; interromper.';
    END IF;

    SELECT COUNT(*) INTO existentes FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN ('ist_loja_categorias', 'ist_loja_produtos');
    IF existentes <> 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Estrutura comercial existente ou parcial; nao repetir.';
    END IF;

    SELECT COUNT(*) INTO existentes FROM information_schema.tables t
    JOIN information_schema.columns c ON c.table_schema = t.table_schema
      AND c.table_name = t.table_name
    WHERE t.table_schema = DATABASE() AND t.table_name = 'ist_livros'
      AND t.engine = 'InnoDB' AND c.column_name = 'id'
      AND c.data_type = 'int' AND c.column_type NOT LIKE '%unsigned%'
      AND c.column_key = 'PRI';
    IF existentes <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PK de ist_livros deve ser INT signed em InnoDB.';
    END IF;

    SELECT COUNT(*) INTO elegiveis FROM ist_livros
    WHERE ((id = 1 AND BINARY sku = BINARY '9788552911036EN2E')
        OR (id = 2 AND BINARY sku = BINARY '9788552911036PT2E'))
      AND onsale = 1 AND BINARY format = BINARY 'E-Book'
      AND BINARY currency = BINARY 'BRL' AND price > 0
      AND inventory IN ('Em estoque', 'Poucas unidades')
      AND file IS NOT NULL AND CHAR_LENGTH(TRIM(file)) > 0;
    IF elegiveis <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Livros iniciais ausentes ou inelegiveis; nenhuma tabela criada.';
    END IF;

    CREATE TABLE ist_loja_categorias (
        id INT NOT NULL AUTO_INCREMENT,
        nome VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL,
        categoria_pai_id INT NULL,
        ativo TINYINT(1) NOT NULL DEFAULT 1,
        ordem INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_loja_categorias_slug (slug),
        KEY idx_loja_categorias_pai (categoria_pai_id),
        KEY idx_loja_categorias_exibicao (ativo, ordem, id),
        CONSTRAINT fk_loja_categorias_pai FOREIGN KEY (categoria_pai_id)
            REFERENCES ist_loja_categorias (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT ck_loja_categorias_ativo CHECK (ativo IN (0, 1)),
        CONSTRAINT ck_loja_categorias_ordem CHECK (ordem >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE ist_loja_produtos (
        id INT NOT NULL AUTO_INCREMENT,
        categoria_id INT NOT NULL,
        livro_id INT NOT NULL,
        sku VARCHAR(50) NOT NULL,
        ativo TINYINT(1) NOT NULL DEFAULT 1,
        ordem INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_loja_produtos_livro (livro_id),
        UNIQUE KEY uq_loja_produtos_sku (sku),
        KEY idx_loja_produtos_categoria (categoria_id, ativo, ordem, id),
        CONSTRAINT fk_loja_produtos_categoria FOREIGN KEY (categoria_id)
            REFERENCES ist_loja_categorias (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT fk_loja_produtos_livro FOREIGN KEY (livro_id)
            REFERENCES ist_livros (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT ck_loja_produtos_ativo CHECK (ativo IN (0, 1)),
        CONSTRAINT ck_loja_produtos_ordem CHECK (ordem >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    START TRANSACTION;
    INSERT INTO ist_loja_categorias (nome, slug, categoria_pai_id, ordem)
    VALUES ('Livros digitais', 'livros-digitais', NULL, 1);
    SET raiz = LAST_INSERT_ID();
    INSERT INTO ist_loja_categorias (nome, slug, categoria_pai_id, ordem)
    VALUES ('Música', 'musica', raiz, 1);
    SET musica = LAST_INSERT_ID();

    -- Revalidar na propria carga: se um livro mudou, toda a carga e desfeita.
    INSERT INTO ist_loja_produtos (categoria_id, livro_id, sku, ordem)
    SELECT musica, id, sku, id FROM ist_livros
    WHERE ((id = 1 AND BINARY sku = BINARY '9788552911036EN2E')
        OR (id = 2 AND BINARY sku = BINARY '9788552911036PT2E'))
      AND onsale = 1 AND BINARY format = BINARY 'E-Book'
      AND BINARY currency = BINARY 'BRL' AND price > 0
      AND inventory IN ('Em estoque', 'Poucas unidades')
      AND file IS NOT NULL AND CHAR_LENGTH(TRIM(file)) > 0
    ORDER BY id;
    IF ROW_COUNT() <> 2 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Elegibilidade alterada; carga desfeita, revisar DDL parcial.';
    END IF;
    COMMIT;
END$$
DELIMITER ;
