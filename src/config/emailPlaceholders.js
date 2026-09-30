// Fonte única dos placeholders permitidos por chave de modelo. Sem tabela no banco.
export const EMAIL_PLACEHOLDERS = Object.freeze({
    confirmacao_email: Object.freeze({
        nome: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Nome do destinatário' }),
        link: Object.freeze({ tipo: 'url', obrigatorio: true, descricao: 'Link de confirmação' })
    }),
    redefinicao_senha: Object.freeze({
        nome: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Nome do destinatário' }),
        link: Object.freeze({ tipo: 'url', obrigatorio: true, descricao: 'Link de redefinição de senha' })
    }),
    confirmacao_inscricao_festival: Object.freeze({
        nome: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Nome do concorrente' }),
        numero_concorrente: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Número do concorrente' }),
        email: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'E-mail do concorrente' }),
        telefone: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Telefone do concorrente' }),
        data_nascimento: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Data de nascimento do concorrente' }),
        cidade: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Cidade do concorrente' }),
        uf: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'UF do concorrente' }),
        musica_1: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Primeira música inscrita' }),
        video_1: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Vídeo da primeira música' }),
        musica_2: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Segunda música inscrita ou indicação de ausência' }),
        video_2: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Vídeo da segunda música ou indicação de ausência' })
    })
});

export const obterCatalogo = (chave) =>
    Object.prototype.hasOwnProperty.call(EMAIL_PLACEHOLDERS, chave) ? EMAIL_PLACEHOLDERS[chave] : null;
