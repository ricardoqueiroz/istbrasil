const VIDEO_URL_MAX_LENGTH = 500;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtu.be']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com']);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const validarVideoConcorrente = (valor) => {
    if (typeof valor !== 'string') {
        return null;
    }

    const urlNormalizada = valor.trim();
    if (!urlNormalizada || urlNormalizada.length > VIDEO_URL_MAX_LENGTH) {
        return null;
    }

    let url;
    try {
        url = new URL(urlNormalizada);
    } catch {
        return null;
    }

    if (url.protocol !== 'https:') {
        return null;
    }

    const host = url.hostname.toLowerCase();

    if (YOUTUBE_HOSTS.has(host)) {
        if (host === 'youtu.be') {
            const videoId = url.pathname.split('/').filter(Boolean)[0];
            return videoId && VIDEO_ID_PATTERN.test(videoId) ? urlNormalizada : null;
        }

        if (url.pathname === '/watch') {
            const videoId = url.searchParams.get('v');
            return videoId && VIDEO_ID_PATTERN.test(videoId) ? urlNormalizada : null;
        }

        const segmentos = url.pathname.split('/').filter(Boolean);
        if ((segmentos[0] === 'shorts' || segmentos[0] === 'embed') && VIDEO_ID_PATTERN.test(segmentos[1] || '')) {
            return urlNormalizada;
        }

        return null;
    }

    if (VIMEO_HOSTS.has(host)) {
        const segmentos = url.pathname.split('/').filter(Boolean);
        const videoId = segmentos[0];
        return videoId && /^\d+$/.test(videoId) ? urlNormalizada : null;
    }

    return null;
};
