import { mkdir, rename, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROFILE_PHOTOS_DIRECTORY = path.resolve(__dirname, '../../istbrasil.private/usuarios/fotos');
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_PHOTO_MAX_PIXELS = 40_000_000;
const PROFILE_PHOTO_URL_PREFIX = '/api/usuarios/fotos/';
const CONTROLLED_PHOTO_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export class ProfilePhotoValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProfilePhotoValidationError';
        this.code = 'INVALID_PROFILE_PHOTO';
    }
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: PROFILE_PHOTO_MAX_BYTES,
        files: 1,
        fields: 0,
        parts: 1
    },
    fileFilter: (_req, file, callback) => {
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
            return callback(new ProfilePhotoValidationError('Formato de imagem não permitido.'));
        }

        return callback(null, true);
    }
});

export const profilePhotoUpload = (req, res, next) => {
    upload.single('foto')(req, res, (error) => {
        if (!error) {
            return next();
        }

        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ message: 'A foto deve ter no máximo 5 MB.' });
        }

        if (error instanceof multer.MulterError && error.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ message: 'Envie somente um arquivo no campo foto.' });
        }

        if (error instanceof ProfilePhotoValidationError) {
            return res.status(400).json({ message: error.message });
        }

        console.error('Erro ao receber foto de perfil:', error);
        return res.status(400).json({ message: 'Não foi possível receber a foto.' });
    });
};

export const isControlledProfilePhotoFilename = (filename) => typeof filename === 'string' && CONTROLLED_PHOTO_FILENAME.test(filename);

export const buildProfilePhotoUrl = (filename) => isControlledProfilePhotoFilename(filename)
    ? `${PROFILE_PHOTO_URL_PREFIX}${filename}`
    : null;

export const ensureProfilePhotoDirectory = async () => {
    await mkdir(PROFILE_PHOTOS_DIRECTORY, { recursive: true });
};

export const processAndStoreProfilePhoto = async (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new ProfilePhotoValidationError('Arquivo de foto ausente.');
    }

    let metadata;
    try {
        const image = sharp(buffer, { limitInputPixels: PROFILE_PHOTO_MAX_PIXELS });
        metadata = await image.metadata();

        if (!ALLOWED_FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
            throw new ProfilePhotoValidationError('A foto deve ser JPEG, PNG ou WEBP válida.');
        }

        if (metadata.width * metadata.height > PROFILE_PHOTO_MAX_PIXELS) {
            throw new ProfilePhotoValidationError('As dimensões da foto são muito grandes.');
        }

        const output = await image
            .rotate()
            .resize(800, 800, { fit: 'cover', position: 'centre' })
            .webp({ quality: 83 })
            .toBuffer();

        await ensureProfilePhotoDirectory();

        const filename = `${randomUUID()}.webp`;
        const temporaryPath = path.join(PROFILE_PHOTOS_DIRECTORY, `.${filename}.tmp`);
        const finalPath = path.join(PROFILE_PHOTOS_DIRECTORY, filename);

        try {
            await writeFile(temporaryPath, output, { flag: 'wx' });
            await rename(temporaryPath, finalPath);
        } catch (error) {
            await unlink(temporaryPath).catch(() => {});
            throw error;
        }

        return { filename, finalPath };
    } catch (error) {
        if (error instanceof ProfilePhotoValidationError) {
            throw error;
        }

        console.error('Erro ao processar foto de perfil:', error);
        throw new ProfilePhotoValidationError('A foto é inválida ou não pôde ser processada.');
    }
};

export const removeStoredProfilePhoto = async (filename) => {
    if (!isControlledProfilePhotoFilename(filename)) {
        return;
    }

    const filePath = path.join(PROFILE_PHOTOS_DIRECTORY, filename);
    await unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    });
};

export const sendStoredProfilePhoto = (res, filename) => {
    if (!isControlledProfilePhotoFilename(filename)) {
        return res.status(404).end();
    }

    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filename, { root: PROFILE_PHOTOS_DIRECTORY }, (error) => {
        if (error && !res.headersSent) {
            res.status(error.statusCode === 404 ? 404 : 500).json({
                message: error.statusCode === 404 ? 'Foto não encontrada.' : 'Erro ao carregar foto.'
            });
        }
    });
};
