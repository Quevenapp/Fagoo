// Sistema › Gerenciador de arquivos (263): the routes of each origin for Baixar arquivo, Miniatura and Excluir anexo, the source
// shown in the list and the thumbnails. Every download is checked by size and SHA-256 before it is offered or shown.
// Self-contained (no imports), so the model also runs under Node in the tests.
export type FileOrigin = 'documentos' | 'contatos' | 'financeiro' | 'produtos' | 'empresa';
export type FileSource = { kind: string; id: string; code: string | null; label: string | null };
export type ManagedFile = { id: string; origin: FileOrigin; filename: string; mime_type: string; size_bytes: number; sha256: string; source: FileSource };
export const ORIGIN_TEXT: Record<FileOrigin, string> = { documentos: 'Documentos', contatos: 'Contatos', financeiro: 'Financeiro', produtos: 'Produtos', empresa: 'Empresa' };
const DOCUMENT_TEXT: Record<string, string> = { sales_proposals: 'Proposta comercial', sales_orders: 'Pedido de venda', purchase_orders: 'Pedido de compra', service_orders: 'Ordem de serviço' };
// 301: Inserir Arquivo, a file of the company without a document (/v1/anexos-empresa/arquivos), with the limits of the attachments.
export const COMPANY_FILES_PATH = '/v1/anexos-empresa/arquivos';
export const COMPANY_FILE_MAX_BYTES = 10 * 1024 * 1024;
export type CompanyFileMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'application/xml' | 'text/plain';
const COMPANY_FILE_TYPES: Record<string, CompanyFileMime> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', xml: 'application/xml', txt: 'text/plain' };
/** The type of a chosen file by its extension: PDF, PNG, JPEG, XML or TXT of up to 10 MB, not empty. */
export function companyFileType(file: Pick<File, 'name' | 'size'>): CompanyFileMime {
  const mime = COMPANY_FILE_TYPES[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
  if (!mime || !/\.[A-Za-z]+$/.test(file.name)) throw new Error('Use um arquivo PDF, PNG, JPEG, XML ou TXT.');
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > COMPANY_FILE_MAX_BYTES) throw new Error('Selecione um arquivo de até 10 MB, que não esteja vazio.');
  return mime;
}
export type CompanyFile = { id: string; filename: string; mime_type: CompanyFileMime; size_bytes: number; sha256: string; status: 'reserved' | 'ready' | 'aborted'; deleted: boolean };
/** The file of a reserve or upload answer, checked against what was sent. */
export function readCompanyFile(value: unknown, sent: { mime: CompanyFileMime; size: number; sha: string }): CompanyFile {
  const row = (value as { file?: CompanyFile } | null)?.file;
  if (!row || typeof row !== 'object' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) || typeof row.filename !== 'string' || !/^arquivo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(pdf|png|jpg|xml|txt)$/.test(row.filename)
    || row.mime_type !== sent.mime || row.size_bytes !== sent.size || row.sha256 !== sent.sha || !['reserved', 'ready', 'aborted'].includes(row.status) || typeof row.deleted !== 'boolean') throw new Error('COMPANY_FILE_INVALID');
  return { id: row.id, filename: row.filename, mime_type: row.mime_type, size_bytes: row.size_bytes, sha256: row.sha256, status: row.status, deleted: row.deleted };
}
/** Thumbnails are read only for PNG and JPEG images of up to 2 MB, at most this many per page. */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024, THUMBNAILS_PER_PAGE = 24;
export const thumbnailable = (f: Pick<ManagedFile, 'mime_type' | 'size_bytes'>) => (f.mime_type === 'image/png' || f.mime_type === 'image/jpeg') && f.size_bytes <= THUMBNAIL_MAX_BYTES;

/** Route of a file in the module that owns it (the module checks its own permissions again). */
export function fileRoute(f: ManagedFile, action: 'download' | 'exclusao'): string {
  switch (f.origin) {
    case 'documentos': return `/v1/documentos/${f.source.kind}/${f.source.id}/anexos/${f.id}/${action}`;
    case 'contatos': return `/v1/anexos-cadastros/contatos/${f.source.id}/${f.id}/${action}`;
    case 'financeiro': return `/v1/anexos-financeiro/${f.source.kind === 'cash_entry' ? 'lancamentos' : 'contas'}/${f.source.id}/${f.id}/${action}`;
    case 'produtos': return `/v1/anexos-cadastros/produtos/${f.source.id}/${f.id}/${action}`;
    // 301: a company file of Inserir Arquivo, or the logo.
    case 'empresa': return f.source.kind === 'company_file' ? `${COMPANY_FILES_PATH}/${f.id}/${action}` : `/v1/anexos-empresa/logo/${f.id}/${action}`;
  }
}
/** "Documento de origem" of the list and the screen that opens it (null when Brufap has no list for it). */
export function sourceText(f: ManagedFile): { text: string; to: string | null } {
  const label = f.source.label ? ` · ${f.source.label}` : '';
  switch (f.origin) {
    case 'documentos': return { text: `${DOCUMENT_TEXT[f.source.kind] ?? 'Documento'} nº ${f.source.code}${label}`, to: `/documentos-empresa?tipo=${f.source.kind}` };
    case 'contatos': return { text: `${f.source.kind === 'contact_photo' ? 'Foto do contato' : 'Contato'}${f.source.code ? ` ${f.source.code}` : ''}${label}`, to: '/cadastros-reais?cadastro=contacts' };
    case 'financeiro': return { text: `${f.source.kind === 'cash_entry' ? 'Lançamento de caixa' : 'Conta'}${label}`, to: null };
    case 'produtos': return { text: `Imagem do produto${f.source.code ? ` ${f.source.code}` : ''}${label}`, to: '/cadastros-reais?cadastro=products' };
    case 'empresa': return f.source.kind === 'company_file' ? { text: 'Arquivo da empresa', to: null } : { text: 'Logo da empresa (Sua marca)', to: '/empresa-configuracoes' };
  }
}
/** A deletion answer of any origin: {attachment|image|logo|file: {id, deleted: true}}. */
export function deletedFile(value: unknown, id: string): boolean {
  const v = value as Record<string, { id?: unknown; deleted?: unknown }> | null;
  const row = v && typeof v === 'object' ? v.attachment ?? v.image ?? v.logo ?? v.file : null;
  return Boolean(row && row.id === id && row.deleted === true);
}
export async function fileDigest(blob: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
}
/** The image as a data: URL (img-src 'self' data: only). */
export async function thumbnailUrl(blob: Blob, mime: string): Promise<string> {
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw new Error('FILE_THUMBNAIL_TYPE');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
