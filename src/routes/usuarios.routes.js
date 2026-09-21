import express from 'express';
import usuariosController from '../controllers/usuariosController.js';
const router = express.Router();

// POST /api/usuarios/login
router.post('/login', usuariosController.login);

// GET /api/usuarios/cargos
router.get('/cargos', usuariosController.listarCargos);

// GET /api/usuarios/verificar-email?email=
router.get('/verificar-email', usuariosController.verificarEmail);

// GET /api/usuarios/confirmar-email?token=
router.get('/confirmar-email', usuariosController.confirmarEmail);

// POST /api/usuarios/cadastro
router.post('/cadastro', usuariosController.cadastrar);

// POST /api/usuarios/esqueci-senha
router.post('/esqueci-senha', usuariosController.esqueciSenha);

// GET /api/usuarios/validar-token-senha?token=
router.get('/validar-token-senha', usuariosController.validarTokenSenha);

// POST /api/usuarios/redefinir-senha
router.post('/redefinir-senha', usuariosController.redefinirSenha);

// GET /api/usuarios/me
router.get('/me', usuariosController.me);

// POST /api/usuarios/logout
router.post('/logout', usuariosController.logout);

export default router;
