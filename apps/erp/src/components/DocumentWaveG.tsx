import { useState } from 'react';
import type { DocumentKind } from '../lib/real-documents-model';
import { Modal } from './Modal';
import './document-wave-g.css';

const NOUNS: Record<DocumentKind, string> = { sales_orders: 'o pedido', purchase_orders: 'o pedido de compra', service_orders: 'a ordem de serviço', sales_proposals: 'a proposta' };

/**
 * 202610200290 Origin alerta azul "Não é possível alterar o pedido, pois já foram realizadas as seguintes ações:" with the links to the
 * Lançamento de Contas and the Lançamento de Estoque of the document; everything stays read-only except Observações and Observações
 * internas, saved by Salvar.
 */
export function DocumentNotesNotice({ kind, effects, onOpen }: { kind: DocumentKind; effects: { finance: boolean; stock: boolean; reservation: boolean; originFinance?: boolean; originInvoice?: boolean }; onOpen: (target: string) => void }) {
  const link = (label: string, target: string) => <a href="#" role="button" className="text-button" onClick={event => { event.preventDefault(); onOpen(target); }}>{label} ↗</a>;
  return <div className="real-notice document-effects-notice" role="note">
    <p>Não é possível alterar {NOUNS[kind]}, pois já foram realizadas as seguintes ações:</p>
    <ul>{effects.finance && <li>{link('Lançamento de Contas', 'document-finance-anchor')}</li>}{effects.stock && <li>{link('Lançamento de Estoque', 'document-stock-anchor')}</li>}
      {effects.reservation && <li>Reserva de estoque</li>}
      {/* 016: effects done in the Origin (no FAGOO posting to open). */}
      {effects.originFinance && <li>Lançamento de Contas (no Origin)</li>}{effects.originInvoice && <li>Nota Fiscal gerada (no Origin)</li>}</ul>
    <p className="real-help">Somente Observações e Observações internas podem ser alteradas e salvas.</p>
  </div>;
}

/** 202610200288 Origin ⋮ Imprimir of the OS: "Imprimir campos customizados na ordem de serviço?" (toggle) before the print. */
export function CustomFieldsPrintQuestion({ onPrint, onCancel }: { onPrint: (include: boolean) => void; onCancel: () => void }) {
  const [include, setInclude] = useState(true);
  return <Modal title="Impressão com campos customizados" onClose={onCancel} actions={<><button type="button" className="primary-button" onClick={() => onPrint(include)}>Imprimir</button><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button></>}>
    <label className="product-switch"><input type="checkbox" role="switch" checked={include} onChange={event => setInclude(event.target.checked)} /><span>Imprimir campos customizados na ordem de serviço?</span></label>
  </Modal>;
}
