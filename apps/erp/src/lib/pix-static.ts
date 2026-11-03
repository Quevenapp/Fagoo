/** "Pix - QR Code Impresso (QR estático)" da Frente de caixa: o BR Code estático (padrão EMV QRCPS-MPM do Banco Central) com a
 * chave Pix da empresa, o nome, a cidade, o valor e a identificação da venda, mais o CRC16. Só monta o texto para o QR impresso:
 * nenhum banco ou provedor é chamado e o recebimento é conferido manualmente pelo operador. */
export type PixKeyType = 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';
export interface PixStatic { keyType: PixKeyType; key: string; merchantName: string; merchantCity: string; amountCents?: string | null; reference?: string | null }
export const PIX_KEY_TYPES: readonly { value: PixKeyType; label: string }[] = [{ value: 'cpf', label: 'CPF' }, { value: 'cnpj', label: 'CNPJ' }, { value: 'email', label: 'E-mail' },
  { value: 'phone', label: 'Celular' }, { value: 'random', label: 'Chave aleatória' }];

const field = (id: string, value: string) => { if (value.length > 99) throw new Error('PIX_FIELD_TOO_LONG'); return `${id}${String(value.length).padStart(2, '0')}${value}`; };
/** CRC-16/CCITT-FALSE (polinômio 0x1021, início 0xFFFF), em quatro dígitos hexadecimais maiúsculos. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) { crc ^= byte << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
/** The key as the Pix directory stores it (same rules as erp_pos.settings, migration 202610200204). */
export function pixKey(type: PixKeyType, value: string): string {
  const text = value.trim();
  if (type === 'cpf') { const digits = text.replace(/[.\-\s]/g, ''); if (!/^\d{11}$/.test(digits)) throw new Error('Informe o CPF da chave com 11 dígitos.'); return digits; }
  if (type === 'cnpj') { const digits = text.replace(/[.\-/\s]/g, ''); if (!/^\d{14}$/.test(digits)) throw new Error('Informe o CNPJ da chave com 14 dígitos.'); return digits; }
  if (type === 'phone') { const digits = text.replace(/[()\-\s]/g, '').replace(/^\+?/, '+'); const full = /^\+55/.test(digits) ? digits : `+55${digits.slice(1)}`; if (!/^\+\d{12,13}$/.test(full)) throw new Error('Informe o celular da chave com DDD (ex.: +55 11 91234-5678).'); return full; }
  if (type === 'email') { const email = text.toLowerCase(); if (email.length > 77 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Informe um e-mail válido para a chave.'); return email; }
  const random = text.toLowerCase(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(random)) throw new Error('Informe a chave aleatória no formato do Pix (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).'); return random;
}
/** Nome e cidade do recebedor: maiúsculas sem acentos, como no BR Code (até 25 e 15 caracteres). */
export function pixText(value: string, max: number): string {
  const text = value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .,&/-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max).trim();
  if (!text) throw new Error('PIX_TEXT_EMPTY');
  return text;
}
/** BR Code estático. Sem valor ("QR code fixo"), o pagador digita o valor no aplicativo do banco. */
export function pixPayload({ keyType, key, merchantName, merchantCity, amountCents = null, reference = null }: PixStatic): string {
  const account = field('00', 'br.gov.bcb.pix') + field('01', pixKey(keyType, key));
  let amount = '';
  if (amountCents !== null && amountCents !== undefined) {
    if (!/^\d{1,13}$/.test(amountCents) || /^0+$/.test(amountCents)) throw new Error('PIX_AMOUNT_INVALID');
    const cents = BigInt(amountCents); amount = field('54', `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
  }
  const txid = reference ? reference.replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***' : '***';
  const body = field('00', '01') + field('26', account) + field('52', '0000') + field('53', '986') + amount + field('58', 'BR')
    + field('59', pixText(merchantName, 25)) + field('60', pixText(merchantCity, 15)) + field('62', field('05', txid)) + '6304';
  return body + crc16(body);
}
/** Reads the EMV fields back (used to check a payload before printing it). */
export function pixFields(payload: string): Map<string, string> {
  const fields = new Map<string, string>(); let index = 0;
  while (index < payload.length) {
    const id = payload.slice(index, index + 2), length = Number(payload.slice(index + 2, index + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(length) || index + 4 + length > payload.length) throw new Error('PIX_PAYLOAD_INVALID');
    fields.set(id, payload.slice(index + 4, index + 4 + length)); index += 4 + length;
  }
  if (crc16(payload.slice(0, -4)) !== fields.get('63')) throw new Error('PIX_PAYLOAD_INVALID');
  return fields;
}
