import express from 'express';
import usuariosController from '../controllers/usuariosController.js';
import { autenticarUsuario } from '../middlewares/authMiddleware.js';
import { profilePhotoUpload } from '../services/profilePhotoService.js';
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
router.get('/me', autenticarUsuario, usuariosController.me);

// GET /api/usuarios/perfil
router.get('/perfil', autenticarUsuario, usuariosController.obterPerfil);

// PUT /api/usuarios/perfil
router.put('/perfil', autenticarUsuario, usuariosController.atualizarPerfil);

// PUT /api/usuarios/perfil/concorrente/participacao
router.put('/perfil/concorrente/participacao', autenticarUsuario, usuariosController.atualizarParticipacaoConcorrente);

// PUT /api/usuarios/perfil/curriculo
router.put('/perfil/curriculo', autenticarUsuario, usuariosController.atualizarCurriculo);

// POST /api/usuarios/perfil/foto
router.post('/perfil/foto', autenticarUsuario, profilePhotoUpload, usuariosController.atualizarFoto);

// GET /api/usuarios/fotos/:arquivo
router.get('/fotos/:arquivo', usuariosController.obterFotoPublica);

// DELETE /api/usuarios/perfil/foto
router.delete('/perfil/foto', autenticarUsuario, usuariosController.removerFoto);

// POST /api/usuarios/logout
router.post('/logout', usuariosController.logout);

export default router;
