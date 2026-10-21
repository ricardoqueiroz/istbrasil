const DIA=86400000;
export const RETENCAO_RECUPERACAO=Object.freeze({desafioDias:7,sessaoDias:90,maxLote:100});
const erro=codigo=>Object.assign(new Error(codigo),{codigo});
const utc=n=>new Date(n).toISOString().slice(0,23).replace('T',' ');
// Sem endpoint, timer ou pool proprio. Antes de chamar, o operador verifica
// externamente host/porta/datadir; nome do schema NAO prova identidade.
export const criarLimpezaRecuperacao=({db,bancoEsperado,agora=()=>new Date()}={})=>{
    if(!db?.getConnection||typeof bancoEsperado!=='string'||!/^[a-zA-Z0-9_]{1,64}$/.test(bancoEsperado)
        ||typeof agora!=='function')throw erro('CONFIGURACAO_LIMPEZA_INVALIDA');
    let executando=false;
    const limpar=async({confirmarRetencao=false,limite=100}={})=>{
        if(confirmarRetencao!==true||!Number.isSafeInteger(limite)||limite<1||limite>100||executando)
            throw erro('LIMPEZA_NAO_AUTORIZADA');
        const n=agora();
        if(!(n instanceof Date)||!Number.isFinite(n.getTime())||n.getUTCFullYear()<2000||n.getUTCFullYear()>9998)
            throw erro('CONFIGURACAO_LIMPEZA_INVALIDA');
        const cortes=[utc(n.getTime()-7*DIA),utc(n.getTime()-90*DIA),utc(n.getTime()-90*DIA)];
        const elegivel=`((consumido_em IS NULL AND desafio_expira_em < ?)
            OR (consumido_em IS NOT NULL AND sessao_expira_em < ? AND (revogada_em IS NULL OR revogada_em < ?)))`;
        let c,iniciou=false,commit=false;executando=true;
        try {
            c=await db.getConnection();
            const [[s]]=await c.query(`SELECT DATABASE() banco,VERSION() versao,@@in_transaction tx,@@autocommit ac,
                @@foreign_key_checks fk,@@check_constraint_checks ck,@@sql_mode modo`);
            if(s?.banco!==bancoEsperado||!/^((13\.0\.2)|(10\.3\.39))-MariaDB(?:-|$)/.test(s.versao)
                ||Number(s.tx)!==0||Number(s.ac)!==1||Number(s.fk)!==1||Number(s.ck)!==1
                ||!/(^|,)(STRICT_TRANS_TABLES|STRICT_ALL_TABLES)(,|$)/.test(s.modo))throw Error();
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await c.beginTransaction();iniciou=true;
            // Mesma ordem da B1/B3: recuperacao antes do seu escopo. Sem locks financeiros.
            const [rs]=await c.query(`SELECT id FROM ist_loja_download_recuperacoes WHERE ${elegivel} ORDER BY id LIMIT ? FOR UPDATE`,[...cortes,limite]);
            let vinculos=0;
            for(const r of rs){
                const [v]=await c.query('DELETE FROM ist_loja_download_recuperacao_direitos WHERE recuperacao_id=?',[r.id]);
                if(v.warningStatus||v.affectedRows>50)throw Error();
                vinculos+=v.affectedRows;
                const [d]=await c.query(`DELETE FROM ist_loja_download_recuperacoes WHERE id=? AND ${elegivel}`,[r.id,...cortes]);
                if(d.warningStatus||d.affectedRows!==1)throw Error();
            }
            commit=true;await c.commit();iniciou=false;
            return {recuperacoesRemovidas:rs.length,vinculosRemovidos:vinculos};
        } catch {
            let codigo=commit?'RESULTADO_LIMPEZA_DESCONHECIDO':'LIMPEZA_INDISPONIVEL';
            if(c&&iniciou&&!commit)try{await c.rollback();}catch{codigo='RESULTADO_LIMPEZA_DESCONHECIDO';try{c.destroy();}catch{}c=null;}
            else if(c){try{c.destroy();}catch{}c=null;}
            throw erro(codigo);
        } finally {c?.release();executando=false;}
    };
    return Object.freeze({limpar});
};
