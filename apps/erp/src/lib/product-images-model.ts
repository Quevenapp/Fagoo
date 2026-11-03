// Imagens armazenadas do produto (migração 202610200193, `/v1/anexos-cadastros/produtos/{produto}`): o mesmo armazenamento privado e
// o mesmo proxy dos anexos. PNG ou JPEG de até 2 MB, até 20 por produto; os bytes são conferidos pelo tamanho e pelo SHA-256 antes
// do envio e depois do download.
export type StoredImage = { id: string; product_id: string; filename: string; mime_type: 'image/png' | 'image/jpeg'; size_bytes: number; sha256: string;
  status: 'reserved' | 'ready' | 'aborted'; position: number | null; created_at: string; finished_at: string | null; deleted: boolean; owner_name: string | null };
export type StoredImagesPage = { product_id: string; items: StoredImage[]; pending: StoredImage[]; stored_bytes: string; limit: number };
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024, PRODUCT_IMAGE_LIMIT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, SHA = /^[a-f0-9]{64}$/;
function fail(): never { throw new Error('PRODUCT_IMAGES_INVALID'); }

export const productImagesPath = (productId: string, id?: string, action?: 'upload' | 'download' | 'abort' | 'exclusao') =>
  `/v1/anexos-cadastros/produtos/${productId}${id ? `/${id}/${action}` : ''}`;
export const productImagesOrderPath = (productId: string) => `/v1/anexos-cadastros/produtos/${productId}/ordem`;
export function readStoredImage(value: unknown, productId: string): StoredImage {
  const row = value as StoredImage | null;
  if (!row || !UUID.test(row.id) || row.product_id !== productId || !['image/png', 'image/jpeg'].includes(row.mime_type) || !Number.isInteger(row.size_bytes) || row.size_bytes < 1
    || row.size_bytes > PRODUCT_IMAGE_MAX_BYTES || !SHA.test(row.sha256) || !['reserved', 'ready', 'aborted'].includes(row.status) || typeof row.filename !== 'string'
    || typeof row.created_at !== 'string' || typeof row.deleted !== 'boolean' || (row.position !== null && !Number.isInteger(row.position))
    || (row.owner_name !== null && typeof row.owner_name !== 'string')) fail();
  return { ...row };
}
export function readStoredImages(value: unknown, productId: string): StoredImagesPage {
  const page = value as Partial<StoredImagesPage> | null;
  if (!page || page.product_id !== productId || !Array.isArray(page.items) || page.items.length > PRODUCT_IMAGE_LIMIT || !Array.isArray(page.pending)
    || typeof page.stored_bytes !== 'string' || !/^\d{1,13}$/.test(page.stored_bytes)) fail();
  const items = page.items.map(item => readStoredImage(item, productId));
  if (items.some((item, index) => item.status !== 'ready' || item.deleted || item.position !== index + 1)) fail();
  return { product_id: productId, items, pending: page.pending.map(item => readStoredImage(item, productId)), stored_bytes: page.stored_bytes, limit: PRODUCT_IMAGE_LIMIT };
}
/** Origin "anexar arquivos" / arrastar e soltar: PNG or JPEG up to 2 MB, not empty. */
export function imageFileType(file: Pick<File, 'name' | 'size' | 'type'>): 'image/png' | 'image/jpeg' {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const mime = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : null;
  if (!mime) throw new Error(`${file.name}: use uma imagem PNG ou JPEG.`);
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > PRODUCT_IMAGE_MAX_BYTES) throw new Error(`${file.name}: selecione uma imagem de até 2 MB, que não esteja vazia.`);
  return mime;
}
/** "1,2 MB" of the stored images of the product. */
export function storedSize(bytes: string | number) {
  const value = Number(bytes);
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1).replace('.', ',')} KB` : `${(value / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}
/** A data: URL for the preview: the ERP Content-Security-Policy allows img-src 'self' data: only. */
export async function imageDataUrl(blob: Blob, mime: string): Promise<string> {
  if (mime !== 'image/png' && mime !== 'image/jpeg') fail();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
