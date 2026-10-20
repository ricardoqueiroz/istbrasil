import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const montarDownloadsSinteticos = async (admin, publicar = true) => {
    const [[id]] = await admin.query('SELECT DATABASE() banco,@@datadir datadir');
    assert.match(id.banco, /^ist_loja_67_3_[0-9a-f]{12}$/);
    assert.ok(/ist-loja-67-4-/.test(id.datadir) || id.datadir === '/var/lib/mysql/');
    const sql = await readFile(new URL('../../migrations/ist_loja_downloads_fundacao.sql', import.meta.url),'utf8');
    // Construir apenas as estruturas homologadas na fixture, nao executar migration.
    await admin.query('ALTER TABLE ist_loja_pedido_itens ADD UNIQUE KEY uq_lpi_id_produto_download(id,produto_id)');
    for (const ddl of sql.match(/CREATE TABLE ist_loja_(?:arquivo_versoes|download_direitos|download_direito_eventos) \([\s\S]*?\) ENGINE=InnoDB[^;]*;/g)) await admin.query(ddl);
    if (!publicar) return;
    const [produtos] = await admin.query('SELECT id FROM ist_loja_produtos');
    for (const p of produtos) await admin.execute(`INSERT INTO ist_loja_arquivo_versoes
        (public_id,produto_id,arquivo_logico_id,numero_versao,caminho_relativo,tamanho_bytes,sha256,mime,estado,publicacao_atual,criado_em,publicado_em)
        VALUES(?,?,?,1,?,32,UNHEX(REPEAT('ab',32)),'application/pdf','PUBLICADA',1,'2026-01-01','2026-01-01')`,
    [randomUUID(),p.id,randomUUID(),`sintetico-${p.id}.pdf`]);
};

// Somente na instancia descartavel existente. Nao importa ambiente/credenciais reais.
export const expandirCatalogoSintetico = async (admin, { publicar = true } = {}) => {
    const [[id]] = await admin.query('SELECT DATABASE() AS banco,@@port AS porta,@@datadir AS datadir,VERSION() versao,@@hostname hostname');
    assert.match(id.banco, /^ist_loja_67_3_[0-9a-f]{12}$/);
    if (process.env.IST_R2_10339_MANIFEST) {
        assert.match(id.versao,/^10\.3\.39-MariaDB(?:-|$)/);
        assert.equal(Number(id.porta),3306); assert.equal(id.datadir,'/var/lib/mysql/');
        assert.match(id.hostname,/^[0-9a-f]{12}$/); // Identidade independente ja validada pela fixture 10.3.
    } else {
        assert.ok(![3306,3307].includes(Number(id.porta)));
        assert.match(id.datadir, /ist-loja-67-4-/);
    }
    const sql = await readFile(new URL('../../migrations/ist_loja_catalogo_expansao_r2.sql', import.meta.url), 'utf8');
    // Mesmos tres DDLs homologados da R2; somente a carga sintetica difere.
    for (const nome of ['CREATE TABLE ist_loja_perfis_fiscais', 'ALTER TABLE ist_loja_produtos', 'ALTER TABLE ist_livros']) {
        const inicio = sql.indexOf('    ' + nome);
        assert.ok(inicio >= 0);
        await admin.query(sql.slice(inicio, sql.indexOf(';', inicio) + 1));
    }
    await admin.query(`UPDATE ist_loja_produtos p JOIN ist_livros l ON l.id=p.livro_id SET
        p.tipo='DIGITAL',p.titulo=l.title,p.descricao=l.description,p.preco_centavos=CAST(l.price*100 AS UNSIGNED),
        p.moeda=l.currency,p.em_venda=l.onsale,p.disponivel=(l.inventory IN ('Em estoque','Poucas unidades'))`);
    await montarDownloadsSinteticos(admin, publicar);
};
