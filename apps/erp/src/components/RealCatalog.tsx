import type { AccessController } from '../lib/real-access';
import type { CatalogEntity } from '../lib/catalog-model';
import { catalogListView, useCatalogList } from './CatalogList';
import type { CatalogEditorProps } from './CatalogEditor';
import { ProductEditor } from './ProductEditor';
import { productListView, useProductList } from './ProductList';
import { ContactEditor } from './ContactEditor';
import { ContactCatalog } from './ContactList';
import ContactModules from './ContactModules';
import { WarehouseEditor } from './WarehouseEditor';
import { useWarehouseList, warehouseListView } from './WarehouseList';
import './product-catalog.css';

// Cadastros (Clientes e Fornecedores, Produtos e Depósitos): routes the list and the form by entity.
// The file map is in docs/integrations/catalog-list-origin.md.

/** The form of the open record. The list keys it by entity, record and version, so it remounts on each of them. */
function Editor(props: CatalogEditorProps) {
  return props.entity === 'products' ? <ProductEditor {...props} /> : props.entity === 'contacts' ? <ContactEditor {...props} /> : <WarehouseEditor {...props} />;
}

export default function Catalog({ controller, initialEntity = 'contacts', onPrepareWarehouses, module, role = '' }: { controller: AccessController; initialEntity?: CatalogEntity; onPrepareWarehouses?:()=>void; module?: string; role?: string }) {
  // Every entity hook runs on every render: on the QA route the entity changes in place, and the hook order must not.
  const list = useCatalogList(controller, initialEntity);
  const products = useProductList(list), warehouses = useWarehouseList(list, onPrepareWarehouses);
  // Cadastros auxiliares da lane contatos (tipos, vendedores, formas de pagamento, funcionários, importação, numeração).
  if (module) return <ContactModules controller={controller} pathname={module} role={role} />;
  // Clientes e fornecedores (contatos lane): its own list component; the hooks above still run for every entity.
  if (list.entity === 'contacts') return <ContactCatalog list={list} Editor={Editor} />;
  const view = list.entity === 'products' ? productListView(list, products) : warehouseListView(list, warehouses);
  return catalogListView(list, view, Editor);
}
