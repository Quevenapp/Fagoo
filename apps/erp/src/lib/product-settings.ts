import { parsePreferencesPage } from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import { preferencesPagePath } from './preferences-request';
import type { AccessController } from './real-access';

// Preferências > Cadastros > Configurações de produtos read by the product screens (the page itself is the preferências lane's).
// Applied today: "Origem padrão de tributação de produtos" (new product form), "Código do produto" Sequencial and Sequencial EAN (the
// server numbers a new product without code; the form says so), "Pular etapas no cadastro de produtos" (the "Incluir cadastro" wizard
// when off) and "Exibir localização na tela de produtos" (Localização column of the list). A failed read keeps the Brufap defaults
// (the complete form, manual code); nothing is saved from here.
export type ProductCodeMode = 'manual' | 'sequencial' | 'sequencial_ean';
export interface ProductSettings { origin: string; showLocation: boolean; sequentialCode: boolean; codeMode: ProductCodeMode; eanPrefixValid: boolean; skipSteps: boolean; stockInPriceReport: boolean }
export const DEFAULT_PRODUCT_SETTINGS: ProductSettings = { origin: '', showLocation: false, sequentialCode: false, codeMode: 'manual', eanPrefixValid: false, skipSteps: true, stockInPriceReport: false };
export async function loadProductSettings(controller: Pick<AccessController, 'preferences'>, signal: AbortSignal): Promise<ProductSettings> {
  const raw = await controller.preferences(preferencesPagePath('cadastros-produtos'), { signal });
  const page = parsePreferencesPage(raw, 'cadastros-produtos') as { items: { key: string; value: unknown }[] };
  const value = (key: string) => page.items.find(item => item.key === key)?.value;
  const origin = value('produtos.origem_padrao'), mode = value('produtos.codigo'), prefix = value('produtos.ean_prefixo');
  const codeMode: ProductCodeMode = mode === 'sequencial' || mode === 'sequencial_ean' ? mode : 'manual';
  // Sequencial EAN without a prefix of 7 to 11 digits numbers nothing: the form asks for the code (migration 191 refuses the save).
  const eanPrefixValid = typeof prefix === 'string' && /^\d{7,11}$/.test(prefix);
  return { origin: typeof origin === 'string' && /^[0-8]$/.test(origin) ? origin : '', showLocation: value('produtos.localizacao_tela_produtos') === true,
    sequentialCode: codeMode === 'sequencial' || (codeMode === 'sequencial_ean' && eanPrefixValid), codeMode, eanPrefixValid,
    skipSteps: value('produtos.pular_etapas') !== false, stockInPriceReport: value('produtos.estoque_relatorio_preco') === true };
}

/** Preferências > Empresa > Geral: "Número de casas decimais no peso do produto" (0 a 5, 3 by default), for the product form. */
export async function loadWeightDecimals(controller: Pick<AccessController, 'preferences'>, signal: AbortSignal): Promise<number> {
  const raw = await controller.preferences(preferencesPagePath('empresa-geral'), { signal });
  const page = parsePreferencesPage(raw, 'empresa-geral') as { items: { key: string; value: unknown }[] };
  const value = page.items.find(item => item.key === 'empresa.decimais_peso')?.value;
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 5 ? value as number : 3;
}
