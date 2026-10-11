import { validarLinkCta } from '../eventos/evento-detalhe/evento-cta';
export { validarLinkCta };
export function imagemSegura(url: string | null | undefined): string {
  return validarLinkCta(url)?.link || '/assets/images/eventos/default-event.jpg';
}
export function documentoSeguro(url: string): string | null {
  try { return validarLinkCta(encodeURI(url))?.link || null; } catch { return null; }
}
