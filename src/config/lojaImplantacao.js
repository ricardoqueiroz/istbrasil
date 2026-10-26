import path from 'node:path';

// Layout versionado do Nginx/publicador. Compartilhado com canonicalPaths do deploy.
export const BASE_IMPLANTACAO_IST='/var/www/istbrasil.org.br';
export const PHPMYADMIN_PUBLICO_IST='/usr/share/phpmyadmin';
export const limitesArmazenamentoImplantacao=base=>{
    const juntar=base.startsWith('/')?path.posix.join:path.join;
    return {raizesPublicas:[juntar(base,'html'),juntar(base,'backend-php'),...(base.startsWith('/')?[PHPMYADMIN_PUBLICO_IST]:[])],
        diretoriosDescartaveis:[juntar(base,'.deploy')]};
};
