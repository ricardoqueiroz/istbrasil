-- CTA editorial por status da etapa. Migration manual aditiva, não executada.
-- Antes de aplicar, conferir schema e ausência das seis colunas.
-- DDL implica commit; não repetir após execução parcial sem revisão manual.
ALTER TABLE ist_eventos_etapas
  ADD COLUMN link_etapa_pendente VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT 'Link do CTA quando a etapa estiver pendente' AFTER ordem,
  ADD COLUMN cta_etapa_pendente VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT 'Texto do CTA quando a etapa estiver pendente' AFTER link_etapa_pendente,
  ADD COLUMN link_etapa_andamento VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT 'Link do CTA quando a etapa estiver em andamento' AFTER cta_etapa_pendente,
  ADD COLUMN cta_etapa_andamento VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT 'Texto do CTA quando a etapa estiver em andamento' AFTER link_etapa_andamento,
  ADD COLUMN link_etapa_concluido VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT 'Link do CTA quando a etapa estiver concluída' AFTER cta_etapa_andamento,
  ADD COLUMN cta_etapa_concluido VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT 'Texto do CTA quando a etapa estiver concluída' AFTER link_etapa_concluido;
