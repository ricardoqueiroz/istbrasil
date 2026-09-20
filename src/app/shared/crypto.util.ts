// SHA-256 client-side hash, usado antes de enviar a senha ao backend (nunca em texto puro)
export async function sha256(texto: string): Promise<string> {
    const valor = texto.trim();

    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(valor));
        return Array.from(new Uint8Array(buffer))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    }

    return valor;
}
