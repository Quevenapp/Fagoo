import { useEffect, useRef, useState } from 'react';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import type { CatalogListItem } from '../lib/catalog-model';
import { productStockText, type ProductOriginStockPage } from '../lib/product-origin-stock-model';
import { quantityText } from '../lib/stock-model';
import { PrintSheet, type PrintColumn } from './PrintSheet';
import { aborted, errorText } from './catalog-shared';

// "Imprimir" (fa-print) da listagem de produtos: todas as páginas dos filtros atuais (até 5.000 produtos, 100 por leitura),
// com as colunas visíveis, numa prévia A4 impressa pelo navegador. Somente leitura.
export const PRINT_LIMIT = 5000;
const LABELS: Record<string, string> = { code: 'Código', unit: 'Unidade', price: 'Preço', stock: 'Estoque', ncm: 'NCM', brand: 'Marca', stock_min: 'Estoque mínimo', stock_max: 'Estoque máximo', cost_price: 'Preço de Custo', location: 'Localização' };
const NUMERIC = new Set(['price', 'stock_min', 'stock_max', 'cost_price']);
const quantity = (value: unknown) => typeof value === 'string' && /^-?\d+\.\d+$/.test(value) ? quantityText(value) : '';
// 202610220008: Estoque prints both origins with their labels (Origin físico observado | Brufap), never added.
export function printValue(item: CatalogListItem, column: string, origin: ProductOriginStockPage | null = null, byWarehouse = false) {
  if (column === 'price' || column === 'cost_price') return typeof item[column] === 'string' ? decimalMoney(item[column] as string) : '';
  if (column === 'stock') return productStockText(item.stock, item.origin_stock, origin, byWarehouse);
  if (column === 'stock_min' || column === 'stock_max') return quantity(item[column]);
  const value = item[column]; return typeof value === 'string' ? value : '';
}

export function ProductListPrint({ controller, filters, columns, filterText, onClose, title = 'Produtos', subtitle = 'Todas as páginas dos filtros aplicados, com as colunas visíveis.' }: {
  controller: AccessController; filters: Record<string, string>; columns: readonly string[]; filterText: string; onClose: () => void; title?: string; subtitle?: string;
}) {
  const [rows, setRows] = useState<Record<string, string>[] | null>(null), [progress, setProgress] = useState('Lendo os produtos…'), [error, setError] = useState('');
  const actor = useRef(controller.getSnapshot().membership?.user_id);
  const printable = ['name', ...columns.filter(column => column !== 'image' && column !== 'name' && LABELS[column])];
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const items: CatalogListItem[] = [], originPages: (ProductOriginStockPage | null)[] = [];
        for (let page = 1; page <= PRINT_LIMIT / 100; page++) {
          const value = await controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ ...filters, page: String(page), size: '100' })}`, { signal: request.signal }) as { items?: CatalogListItem[]; total?: number; page?: number; origin_stock?: ProductOriginStockPage | null };
          if (request.signal.aborted) return;
          if (!Array.isArray(value.items) || value.page !== page || !Number.isSafeInteger(value.total)) throw new AccessError(502);
          if ((value.total as number) > PRINT_LIMIT) { setError(`A impressão é limitada a ${PRINT_LIMIT.toLocaleString('pt-BR')} produtos. Refine os filtros.`); setProgress(''); return; }
          items.push(...value.items); originPages.push(...value.items.map(() => value.origin_stock ?? null)); setProgress(`Lendo os produtos: ${items.length} de ${value.total}`);
          if (items.length >= (value.total as number) || !value.items.length) break;
        }
        if (controller.getSnapshot().membership?.user_id !== actor.current) return;
        setRows(items.map((item, index) => Object.fromEntries(printable.map(column => [column, column === 'name' ? item.name : printValue(item, column, originPages[index], Boolean(filters.warehouse_id))])))); setProgress('');
      } catch (failure) { if (!request.signal.aborted && !aborted(failure)) { setError(errorText(failure)); setProgress(''); } }
    })();
    return () => request.abort();
  }, [controller]);
  const sheetColumns: PrintColumn[] = printable.map(column => ({ key: column, label: column === 'name' ? 'Descrição' : LABELS[column], numeric: NUMERIC.has(column) }));
  return <PrintSheet title={title} subtitle={subtitle} filters={filterText} columns={sheetColumns} rows={rows} progress={progress} error={error} onClose={onClose} />;
}
