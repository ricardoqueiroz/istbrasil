# Projetos: recomendações para o banco

Inspeção somente de leitura em 11/10/2026. Nenhuma alteração de schema ou dados foi executada.

- O banco consultado não contém slugs duplicados. `SHOW INDEX FROM ist_projetos` confirmou somente a chave primária e os índices das duas classificações, sem índice único de slug. Recomenda-se revisar novamente as duplicidades e adicionar unicidade de slug em uma migração futura aprovada.
- Não foram encontrados projetos com combinação inconsistente de tipicidade e tipologia. As chaves estrangeiras individuais não garantem essa combinação. Recomenda-se avaliar uma chave estrangeira composta de `(id_tipologia, id_tipicidade)` para uma chave única correspondente em tipologia, após conferir dados e compatibilidade do schema.
- A API exige correspondência das duas classificações no JOIN. Registros inconsistentes não são publicados.
- O slug `novo_museu_em_santarem` foi preservado. Não existe registro com slug `camerata` no banco consultado.
- Antes de qualquer migração, conferir o schema efetivamente utilizado na homologação/produção; os resultados acima se referem à conexão configurada neste workspace.

Consultas utilizadas: agrupamento de `slug` com `HAVING COUNT(*) > 1`, `SHOW INDEX`, consulta do slug `camerata` e LEFT JOIN de projetos com tipologias por ambos os IDs. Nenhum INSERT, UPDATE, DELETE ou ALTER foi executado.
