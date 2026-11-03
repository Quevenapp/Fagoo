// Frente de caixa shortcuts as configured in Origin (Preferências > Vendas > Frente de caixa > Configurações de teclas
// de atalho): Alt + key on Windows/Linux, Ctrl + Shift + key on macOS. The real Frente de caixa reads the configured keys
// (preference pdv.teclas_atalho, one distinct key per action); the demonstration keeps the Origin defaults.
export type PdvAction = 'cliente' | 'pagamento' | 'produto' | 'pesquisa' | 'buscar' | 'excluir' | 'fechar' | 'finalizar' | 'imprimir' | 'nova' | 'favoritos' | 'remover-gtin' | 'sangria' | 'suprimento' | 'trocar-loja' | 'balcao' | 'mesa';
export type PdvKeymap = Record<PdvAction, string>;

export const PDV_SHORTCUTS: readonly { action: PdvAction; key: string; label: string }[] = [
  { action: 'cliente', key: 'C', label: 'Aba de cliente' }, { action: 'pagamento', key: 'B', label: 'Aba de pagamento' }, { action: 'produto', key: 'Z', label: 'Aba de produto' },
  { action: 'pesquisa', key: 'A', label: 'Pesquisa avançada' }, { action: 'buscar', key: 'P', label: 'Buscar venda' }, { action: 'excluir', key: 'Q', label: 'Excluir' },
  { action: 'fechar', key: 'M', label: 'Fechar caixa' }, { action: 'finalizar', key: 'S', label: 'Finalizar' }, { action: 'imprimir', key: 'I', label: 'Imprimir' },
  { action: 'nova', key: 'N', label: 'Nova venda' }, { action: 'favoritos', key: 'G', label: 'Produtos favoritos' }, { action: 'remover-gtin', key: 'R', label: 'Remover produto a partir do GTIN' },
  { action: 'sangria', key: ',', label: 'Sangria' }, { action: 'suprimento', key: '.', label: 'Suprimento' }, { action: 'trocar-loja', key: 'L', label: 'Trocar loja' },
  { action: 'balcao', key: 'T', label: 'Nova venda balcão' }, { action: 'mesa', key: 'V', label: 'Nova venda mesa' },
];
const KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ',', '.'];

/** The configured table (Origin defaults for any missing, repeated or unknown key, so two actions never share a key). */
export function pdvShortcuts(keymap?: Partial<Record<string, unknown>> | null): readonly { action: PdvAction; key: string; label: string }[] {
  if (!keymap) return PDV_SHORTCUTS;
  const chosen = PDV_SHORTCUTS.map(item => typeof keymap[item.action] === 'string' && KEYS.includes(keymap[item.action] as string) ? keymap[item.action] as string : null);
  if (chosen.some(key => key === null) || new Set(chosen).size !== chosen.length) return PDV_SHORTCUTS;
  return PDV_SHORTCUTS.map((item, index) => ({ ...item, key: chosen[index]! }));
}

export function isMac(platform: string) { return /mac/i.test(platform); }
export function shortcutHint(key: string, mac = false) { return mac ? `Ctrl+Shift+${key}` : `Alt+${key}`; }

// Maps a keydown to the configured action. Uses event.code so Alt combinations work on layouts where Alt changes the character.
export function pdvActionFor(event: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; key: string; code?: string }, mac = false,
  shortcuts: readonly { action: PdvAction; key: string }[] = PDV_SHORTCUTS): PdvAction | null {
  const modifier = mac ? event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey : event.altKey && !event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  const fromCode = event.code === 'Comma' ? ',' : event.code === 'Period' ? '.' : event.code?.startsWith('Key') ? event.code.slice(3) : '';
  const key = (fromCode || event.key).toUpperCase();
  return shortcuts.find(item => item.key === key)?.action ?? null;
}
