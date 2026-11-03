/** Bank names by COMPE code, paired with the FAGOO building-columns icon. */
const SHORT_NAMES: Readonly<Record<string, string>> = {
  '001': 'BB', '033': 'Santander', '041': 'Banrisul', '070': 'BRB', '077': 'Inter', '104': 'Caixa', '208': 'BTG', '212': 'Original', '237': 'Bradesco',
  '260': 'Nubank', '290': 'PagBank', '323': 'Mercado Pago', '336': 'C6', '341': 'Itaú', '380': 'PicPay', '422': 'Safra', '633': 'Rendimento', '748': 'Sicredi', '756': 'Sicoob',
};
export interface PaymentBank { code: string; name: string }
/** Short name shown in the badge: the known name of the code, else the code itself. */
export function bankShortName(bank: PaymentBank): string { return SHORT_NAMES[bank.code] ?? bank.code; }
/** Tooltip of the badge: "341 - Itaú Unibanco" (code and the institution name of the conta financeira). */
export function bankTitle(bank: PaymentBank): string { return `${bank.code} - ${bank.name}`; }
