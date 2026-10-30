// Fonte única dos placeholders permitidos por chave de modelo. Sem tabela no banco.
export const CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO = 'recuperacao_biblioteca_codigo';
export const ASSUNTO_RECUPERACAO_BIBLIOTECA_CODIGO = 'IST — Código de acesso à sua biblioteca digital';
export const CHAVE_CONFIRMACAO_COMPRA = 'confirmacao_compra';
export const EMAIL_PLACEHOLDERS = Object.freeze({
    [CHAVE_CONFIRMACAO_COMPRA]: Object.freeze(Object.fromEntries([
        ['saudacao','Saudação neutra'], ['comprador_email','E-mail persistido da compra'],
        ['pedido_public_id','Código público necessário à recuperação'], ['pedido_estado','Estado pago do pedido'],
        ['data_compra','Data do pedido'], ['data_pagamento','Data da confirmação'],
        ['pagamento_referencia','Referência pública do pagamento'], ['pagamento_estado','Situação da captura e provedor'],
        ['ambiente','Identificação do ambiente'], ['itens_compra','Produtos, descrições, quantidades e valores históricos'],
        ['total','Total da compra'], ['moeda','Moeda da compra'], ['link_biblioteca','Biblioteca digital'],
        ['link_recuperacao','Recuperação por e-mail e pedido']
    ].map(([nome,descricao])=>[nome,Object.freeze({tipo:nome.startsWith('link_')?'url':'texto',obrigatorio:true,descricao})]))),
    [CHAVE_RECUPERACAO_BIBLIOTECA_CODIGO]: Object.freeze({
        pedido_public_id: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Identificador público do pedido' }),
        codigo: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Código de acesso fornecido pelo backend' }),
        validade_minutos: Object.freeze({ tipo: 'texto', obrigatorio: true, descricao: 'Validade em minutos definida pelo backend' }),
        link_acesso: Object.freeze({ tipo: 'url', obrigatorio: true, descricao: 'Endereço de entrada na biblioteca' })
    }),
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
