import {carregarCaminhosDoEnv,criarArmazenamentoLoja} from './lojaArmazenamento.js';

// Before HTTP listen; never creates directories or changes permissions.
export const armazenamentoLoja=criarArmazenamentoLoja({env:carregarCaminhosDoEnv()});
try{await armazenamentoLoja.validar();}
catch(e){throw Error(e.message);}
