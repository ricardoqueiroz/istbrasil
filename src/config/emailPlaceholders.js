// Fonte única dos placeholders permitidos por chave de modelo. Sem tabela no banco.
export const EMAIL_PLACEHOLDERS = Object.freeze({
    confirmacao_email: Object.freeze({
        nome: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Nome do destinatário' }),
        link: Object.freeze({ tipo: 'url', obrigatorio: true, descricao: 'Link de confirmação' })
    }),
    redefinicao_senha: Object.freeze({
        nome: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Nome do destinatário' }),
        link: Object.freeze({ tipo: 'url', obrigatorio: true, descricao: 'Link de redefinição de senha' })
    })
});

export const obterCatalogo = (chave) =>
    Object.prototype.hasOwnProperty.call(EMAIL_PLACEHOLDERS, chave) ? EMAIL_PLACEHOLDERS[chave] : null;
