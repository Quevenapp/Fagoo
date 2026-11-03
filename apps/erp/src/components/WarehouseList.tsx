import { useRef } from 'react';
import type { CatalogEntityView, CatalogList } from './CatalogList';

// Listagem de Depósitos: nome e código, e o atalho do administrador para importar os depósitos do Origin.
const WAREHOUSE_LIST_LABELS = { add: 'Incluir depósito', count: 'Quantidade de depósitos', search: 'Pesquisar cadastros', searchHint: 'Pesquisar por nome ou código', situation: 'Mudar situação de depósitos selecionados' };

/** "Importar depósitos do Origin" passes the shared leave guard and checks the admin session again before navigating. */
export function useWarehouseList(list: CatalogList, onPrepareWarehouses?: () => void) {
  const { controller, navigationGuard } = list;
  const navigationActor = controller.getSnapshot().membership?.user_id, navigationIdentity = useRef({ controller, actor: navigationActor }); navigationIdentity.current = { controller, actor: navigationActor };
  const prepareWarehouses = () => { const allowed = () => navigationIdentity.current.controller === controller && navigationIdentity.current.actor === navigationActor && controller.getSnapshot().phase === 'ready' && controller.getSnapshot().membership?.role === 'admin' && controller.getSnapshot().membership?.user_id === navigationActor; if (allowed() && onPrepareWarehouses) navigationGuard.confirmLeave(() => { if (allowed()) onPrepareWarehouses(); }); };
  return { prepareWarehouses, onPrepareWarehouses };
}
export type WarehouseListState = ReturnType<typeof useWarehouseList>;

export function warehouseListView(list: CatalogList, warehouses: WarehouseListState): CatalogEntityView {
  return {
    labels: WAREHOUSE_LIST_LABELS,
    intro: list.controller.getSnapshot().membership?.role === 'admin' && warehouses.onPrepareWarehouses && <p><button type="button" className="text-button" onClick={warehouses.prepareWarehouses}>Importar depósitos do Origin</button></p>,
    chips: [],
    headers: <>{list.sortHeader('name', 'Nome')}{list.sortHeader('code', 'Código')}</>,
    cells: item => <>{list.nameCell(item)}<td>{item.code || '—'}</td></>,
    rowItems: item => [list.editItem(item), ...list.situationItems(item)],
  };
}
