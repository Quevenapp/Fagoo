import type { DocumentKind } from './real-documents-model';

// Situação colors read from Origin (capture of 19/10/2026, "Pedidos de venda" and "Ordens de serviço").
// Pedidos show a badge in the situação color, OS a colored dot whose title is the name, propostas a neutral badge.
// Purchase orders keep the generic tones of origin-list.ts. Only situações that exist in the Brufap domain appear here.
export const STATUS_COLORS: Partial<Record<DocumentKind, Readonly<Record<string, string>>>> = Object.freeze({
  sales_orders: Object.freeze({ open: '#E9DC40', fulfilled: '#3FB57A', cancelled: '#CBCBCB', in_progress: '#0065F9', agency_sale: '#FF7835', partially_invoiced: '#B83147', partially_fulfilled: '#006361', draft: '#FF66E3', verified: '#85F39E', checkout_partial: '#DEF3FC' }),
  // Origin OS has no Cancelado; the Brufap one uses the pedido gray.
  service_orders: Object.freeze({ open: '#D6CF09', quoted: '#FF0016', service_done: '#1160FF', finalized: '#49B776', rejected: '#ABABAB', approved: '#FC64E8', in_progress: '#FF7B23', waiting_parts: '#241299', no_repair: '#66430B', cancelled: '#CBCBCB' }),
});

export type StatusPresentation = { mode: 'badge'; background: string; text: '#1F2933' | '#FFFFFF' } | { mode: 'dot'; color: string } | { mode: 'neutral' } | { mode: 'tone' };

/** Relative luminance (WCAG) on integer channels; picks the text color with the better contrast. */
export function readableText(hex: string): '#1F2933' | '#FFFFFF' {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error('STATUS_COLOR_INVALID');
  const channel = (offset: number) => { const value = parseInt(match[1]!.slice(offset, offset + 2), 16) / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Contrast against white vs. the dark heading color (#1F2933, luminance ≈ 0.0225).
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / (0.0225 + 0.05)) ? '#FFFFFF' : '#1F2933';
}

export function statusPresentation(kind: DocumentKind, status: string): StatusPresentation {
  if (kind === 'sales_proposals') return { mode: 'neutral' };
  const color = STATUS_COLORS[kind]?.[status];
  if (!color) return { mode: 'tone' };
  return kind === 'service_orders' ? { mode: 'dot', color } : { mode: 'badge', background: color, text: readableText(color) };
}
