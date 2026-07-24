export const DOCX_RENDERER = Symbol('DOCX_RENDERER');

/** Rendu DOCX à partir de HTML (port). Adaptateur : @turbodocx/html-to-docx. */
export interface DocxRenderer {
  renderDocx(html: string, title: string): Promise<Buffer>;
}
