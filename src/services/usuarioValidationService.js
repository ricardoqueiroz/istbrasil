export const somenteDigitos = (valor) => (valor || '').toString().replace(/\D/g, '');

export const textoNormalizado = (valor) => typeof valor === 'string' ? valor.trim() : '';

export const emailValido = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const cpfValido = (cpf) => {
    if (!/^\d{11}$/.test(cpf) || /^([0-9])\1{10}$/.test(cpf)) {
        return false;
    }

    let soma = 0;
    for (let indice = 0; indice < 9; indice += 1) {
        soma += Number(cpf[indice]) * (10 - indice);
    }

    let resto = (soma * 10) % 11;
    if (resto === 10) {
        resto = 0;
    }
    if (resto !== Number(cpf[9])) {
        return false;
    }

    soma = 0;
    for (let indice = 0; indice < 10; indice += 1) {
        soma += Number(cpf[indice]) * (11 - indice);
    }

    resto = (soma * 10) % 11;
    if (resto === 10) {
        resto = 0;
    }

    return resto === Number(cpf[10]);
};

export const dataNascimentoValida = (dataNascimento) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataNascimento)) {
        return false;
    }

    const data = new Date(`${dataNascimento}T00:00:00Z`);
    if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== dataNascimento) {
        return false;
    }

    const hoje = new Date().toISOString().slice(0, 10);
    return dataNascimento <= hoje;
};
