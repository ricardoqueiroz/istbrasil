import express from 'express';
import { fileURLToPath } from 'node:url';

// Somente os documentos públicos de projetos, sem expor a raiz privada.
const documentosPath = fileURLToPath(new URL('../../istbrasil.private/projetos/', import.meta.url));
const router = express.Router();
router.use(express.static(documentosPath, {
    dotfiles: 'deny',
    index: false,
    redirect: false
}));
export default router;
