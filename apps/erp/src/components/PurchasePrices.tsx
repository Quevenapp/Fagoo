import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { compactDocumentDecimal } from '../lib/document-decimals';
import { normalizeUnitPrice } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { Modal } from './Modal';
import { aborted } from './catalog-shared';

// Pedido de compra com os dados de compra do cadastro de produtos (produtos lane, migração 155), como no Origin:
//  * ao incluir um produto, o preço do item vem do preço sugerido (Preferências > Configurações de pedidos de compra: preço de
//    custo ou de compra do fornecedor; desligado, o da última compra), se o item ainda estiver com o preço posto na inclusão;
//  * no primeiro produto de um pedido sem fornecedor: "O fornecedor padrão desse produto é: X - Você deseja inseri-lo no campo
//    fornecedor?" (Cancelar | Sim, inserir);
//  * ao trocar o fornecedor: "Alterar os preços de compra dos itens de acordo com o novo fornecedor selecionado?".
// Só lê o cadastro; o pedido continua sendo gravado pelo próprio formulário (comando, versão e "Conferir resultado").
type Item = { id?: string | null; product_id?: string | null; unit_price: string };
type Supplier = { id: string; name: string };
type Info = { product_id: string; deleted: boolean; default_supplier: Supplier | null; supplier: { purchase_price: string | null; cost_price: string | null } | null; suggested_price: string | null };
type Dialog = { kind: 'default'; supplier: Supplier } | { kind: 'prices'; supplier: Supplier };
const documentPrice = (value: string | null) => { if (value === null) return null; try { return compactDocumentDecimal(normalizeUnitPrice(value, 10)); } catch { return null; } };

export function usePurchasePrices<T extends Item>({ controller, kind, mayEdit, values, onItems, onSupplier }: {
  controller: AccessController; kind: string; mayEdit: () => boolean; values: () => { contact_id: string; items: T[] }; onItems: (items: T[]) => void; onSupplier: (supplier: Supplier) => void;
}): { added: (lineId: string, productId: string, initialPrice: string) => void; supplierChanged: (next: Supplier | null) => void; dialog: ReactNode } {
  const enabled = kind === 'purchase_orders';
  const [dialog, setDialog] = useState<Dialog | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true), asked = useRef(false), supplier = useRef<string>(enabled ? values().contact_id : ''), mode = useRef<string>('last_purchase');
  const actor = useRef(controller.getSnapshot().membership?.user_id);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const same = () => alive.current && controller.getSnapshot().membership?.user_id === actor.current;
  const read = async (ids: string[], supplierId: string) => {
    const params = new URLSearchParams({ ids: ids.join(','), ...(supplierId ? { fornecedor: supplierId } : {}) });
    const result = await controller.catalog(`/v1/cadastros/products/compras?${params}`) as { mode?: string; items?: Info[] };
    if (!Array.isArray(result.items)) throw new AccessError(502);
    mode.current = result.mode ?? mode.current;
    return result.items;
  };
  const added = (lineId: string, productId: string, initialPrice: string) => {
    if (!enabled) return;
    const supplierId = values().contact_id;
    void read([productId], supplierId).then(items => {
      const info = items.find(item => item.product_id === productId);
      if (!info || !same()) return;
      const price = documentPrice(info.suggested_price), line = values().items.find(item => item.id === lineId);
      if (price !== null && line && line.unit_price === initialPrice && price !== initialPrice && mayEdit()) onItems(values().items.map(item => item.id === lineId ? { ...item, unit_price: price } : item));
      if (!values().contact_id && info.default_supplier && !asked.current && values().items.filter(item => item.product_id).length === 1) { asked.current = true; setDialog({ kind: 'default', supplier: info.default_supplier }); }
    }).catch(failure => { if (!aborted(failure)) { /* The item keeps the price of the inclusion; nothing else changes. */ } });
  };
  const supplierChanged = (next: Supplier | null) => {
    if (!enabled) return;
    const previous = supplier.current; supplier.current = next?.id ?? '';
    if (!next || next.id === previous || !values().items.some(item => item.product_id)) return;
    setMessage(''); setDialog({ kind: 'prices', supplier: next });
  };
  const applyPrices = async (next: Supplier) => {
    const ids = [...new Set(values().items.map(item => item.product_id).filter((id): id is string => Boolean(id)))].slice(0, 100);
    setBusy(true);
    try {
      const infos = await read(ids, next.id);
      if (!same()) return;
      if (!mayEdit()) { setMessage('O pedido não está liberado para edição agora; os preços não foram alterados.'); return; }
      let changed = 0;
      const items = values().items.map(item => {
        const info = infos.find(row => row.product_id === item.product_id);
        if (!info?.supplier) return item;
        const raw = mode.current === 'purchase' || mode.current === 'last_purchase' ? info.supplier.purchase_price ?? info.supplier.cost_price : info.supplier.cost_price ?? info.supplier.purchase_price;
        const price = documentPrice(raw);
        if (price === null || price === item.unit_price) return item;
        changed++; return { ...item, unit_price: price };
      });
      if (changed) onItems(items);
      setDialog(null); setMessage(changed ? `${changed} preço(s) de compra alterado(s) conforme o fornecedor ${next.name}.` : `Nenhum item tem preço cadastrado para o fornecedor ${next.name}; os preços continuam como estavam.`);
    } catch (failure) { if (!aborted(failure) && same()) setMessage('Não foi possível ler os preços do fornecedor. Os preços dos itens continuam como estavam.'); }
    finally { if (alive.current) setBusy(false); }
  };
  if (!enabled) return { added, supplierChanged, dialog: null };
  const view = <>
    {message && <p className="real-help" role="status">{message}</p>}
    {dialog?.kind === 'default' && <Modal title="Fornecedor padrão" onClose={() => setDialog(null)} actions={<><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Cancelar</button>
      <button type="button" className="primary-button" onClick={() => { const chosen = dialog.supplier; setDialog(null); if (!mayEdit() || values().contact_id) return; supplier.current = chosen.id; onSupplier(chosen); }}>Sim, inserir</button></>}>
      <p>O fornecedor padrão desse produto é: <strong>{dialog.supplier.name}</strong></p><p>Você deseja inseri-lo no campo fornecedor?</p></Modal>}
    {dialog?.kind === 'prices' && <Modal title="Alterar preços de compra" onClose={() => { if (!busy) setDialog(null); }} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void applyPrices(dialog.supplier)}>{busy ? 'Alterando…' : 'Sim, alterar'}</button></>}>
      <p>Alterar os preços de compra dos itens de acordo com o novo fornecedor selecionado?</p><p className="real-help">Os itens sem preço cadastrado para {dialog.supplier.name} continuam como estão.</p></Modal>}
  </>;
  return { added, supplierChanged, dialog: view };
}
