import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDemoStore, newDemoId, nextDemoNumber } from '../hooks/useDemoStore';
import { PDV_SHORTCUTS, isMac, pdvActionFor, shortcutHint, type PdvAction } from '../lib/pdv-shortcuts';
import { money } from './LineItemsEditor';
import { Icon } from './Icon';
import './demo-pdv.css';

type Step = 'produto' | 'cliente' | 'pagamento';
type CartItem = { id: string; description: string; code: string; quantity: number; unitPrice: number; discount: number };

// Demo "Frente de caixa" in the Origin layout. Synthetic only: no NFC-e, no cash movement, no stock posting.
export default function DemoPdv({ notify }: { notify: (message: string) => void }) {
  const { records, save } = useDemoStore();
  const mac = isMac(globalThis.navigator?.platform || '');
  const hint = (key: string) => shortcutHint(key, mac);
  const products = useMemo(() => (records.produtos || []).filter(row => row.status !== 'Excluídos'), [records.produtos]);
  const [step, setStep] = useState<Step>('produto');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<(typeof products)[number] | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [discount, setDiscount] = useState('0');
  const [comment, setComment] = useState('');
  const [customer, setCustomer] = useState('');
  const [payment, setPayment] = useState('Dinheiro');
  const [received, setReceived] = useState('');
  const [showFavorites, setShowFavorites] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saleSearch, setSaleSearch] = useState('');
  const productInput = useRef<HTMLInputElement>(null), saleInput = useRef<HTMLInputElement>(null), customerInput = useRef<HTMLInputElement>(null), paymentSelect = useRef<HTMLSelectElement>(null);
  const total = Math.round(cart.reduce((sum, item) => sum + item.quantity * item.unitPrice - item.discount, 0) * 100) / 100;
  const change = Math.max(0, Math.round((Number(received.replace(',', '.')) || 0) * 100 - total * 100) / 100);
  const matches = query.trim() ? products.filter(row => `${row.description} ${row.sku} ${row.barcode || ''}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6) : [];
  const favorites = products.slice(0, 8);
  const sales = (records['frente-caixa'] || []).filter(row => !saleSearch.trim() || `${row.number} ${row.customer}`.toLowerCase().includes(saleSearch.trim().toLowerCase())).slice(0, 12);
  const reset = () => { setCart([]); setCustomer(''); setReceived(''); setSelected(null); setQuery(''); setStep('produto'); };
  const insert = () => {
    if (!selected) { notify('Escolha um produto para inserir.'); return; }
    const unitPrice = Number(selected.price) || 0;
    setCart([...cart, { id: newDemoId(), description: String(selected.description), code: String(selected.sku || ''), quantity, unitPrice, discount: Math.max(0, Number(discount.replace(',', '.')) || 0) }]);
    setSelected(null); setQuery(''); setQuantity(1); setDiscount('0'); setComment(''); productInput.current?.focus();
  };
  const finish = () => {
    if (!cart.length) { notify('Inclua ao menos um produto antes de finalizar.'); return; }
    const rows = records['frente-caixa'] || [];
    save('frente-caixa', { id: newDemoId(), number: nextDemoNumber(rows), date: new Date().toISOString().slice(0, 10), customer: customer.trim() || 'Consumidor não identificado (demo)', paymentMethod: payment, total, status: 'Finalizado', _items: JSON.stringify(cart.map(item => ({ ...item, unit: 'UN' }))) });
    notify('Venda finalizada nesta demonstração. Nenhuma NFC-e foi emitida.'); reset();
  };
  const run = (action: PdvAction) => {
    if (action === 'produto') { setStep('produto'); setTimeout(() => productInput.current?.focus()); }
    else if (action === 'cliente') { setStep('cliente'); setTimeout(() => customerInput.current?.focus()); }
    else if (action === 'pagamento') { setStep('pagamento'); setTimeout(() => paymentSelect.current?.focus()); }
    else if (action === 'buscar') saleInput.current?.focus();
    else if (action === 'nova' || action === 'balcao' || action === 'mesa') { reset(); notify('Nova venda iniciada.'); }
    else if (action === 'excluir') { reset(); notify('Venda excluída nesta demonstração.'); }
    else if (action === 'finalizar') finish();
    else if (action === 'favoritos') { setStep('produto'); setShowFavorites(value => !value); }
    else if (action === 'pesquisa') { setStep('produto'); setTimeout(() => productInput.current?.focus()); }
    else if (action === 'imprimir') window.print();
    else if (action === 'remover-gtin') { setCart(items => items.slice(0, -1)); notify('Último produto removido.'); }
    else notify('Operação de caixa indisponível na demonstração.');
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { const action = pdvActionFor(event, mac); if (action) { event.preventDefault(); run(action); } else if (event.key === 'Escape') { setShowShortcuts(false); setMenuOpen(false); setShowFavorites(false); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  const stepButton = (id: Step, label: string, key: string) => <button type="button" role="tab" aria-selected={step === id} className={step === id ? 'active' : ''} onClick={() => run(id)}>{label} ({hint(key)})</button>;
  return <div className="demo-pdv">
    <header className="pdv-topbar">
      <button type="button" className="pdv-menu-button" aria-label="Abrir menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Icon name="bars" size={15} /></button>
      <span className="pdv-store"><span className="pdv-store-avatar" aria-hidden="true">F</span>FAGOO</span>
      <button type="button" className="pdv-open-cash" onClick={() => notify('Abertura de caixa indisponível na demonstração.')}><Icon name="shuffle" size={11} />Abrir caixa</button>
      <span className="pdv-warning"><Icon name="triangle-exclamation" size={12} />Demonstração: o caixa não movimenta dinheiro nem emite NFC-e.</span>
      <button type="button" className="pdv-info" title="Teclas de atalho" aria-label="Teclas de atalho" onClick={() => setShowShortcuts(true)}><Icon name="circle-info" size={15} /></button>
    </header>
    {menuOpen && <><button type="button" className="origin-drawer-backdrop" aria-label="Fechar menu" onClick={() => setMenuOpen(false)} /><nav className="origin-drawer" aria-label="Menu"><Link to="/inicio"><Icon name="house" size={13} />Início</Link><Link to="/vendas">Pedidos de venda</Link><Link to="/nfce">NFC-e</Link><Link to="/controle-caixa">Controle de caixa</Link><Link to="/configuracoes"><Icon name="gear" size={13} />Preferências</Link></nav></>}
    <div className="pdv-body">
      <section className="pdv-sale" aria-label="Venda">
        <header className="pdv-sale-header"><h1>Venda</h1><input ref={saleInput} type="search" aria-label="Buscar venda" placeholder={`Buscar venda - (${hint('P')})`} value={saleSearch} onChange={event => setSaleSearch(event.target.value)} /><button type="button" className="pdv-new" onClick={() => run('nova')}>Nova venda ({hint('N')})</button>
          <span className="pdv-ops"><button type="button" aria-label="Operações" title="Operações" onClick={() => setMenuOpen(false)}><Icon name="ellipsis" size={14} /></button><span className="pdv-ops-menu" role="menu"><button type="button" role="menuitem" onClick={() => run('sangria')}>Sangria ({hint(',')})</button><button type="button" role="menuitem" onClick={() => run('suprimento')}>Suprimento ({hint('.')})</button><button type="button" role="menuitem" onClick={() => run('fechar')}>Fechar caixa ({hint('M')})</button><button type="button" role="menuitem" onClick={() => run('imprimir')}>Imprimir ({hint('I')})</button><button type="button" role="menuitem" onClick={() => notify('Devolução indisponível na demonstração.')}>Gerar devolução</button></span></span>
        </header>
        <nav className="pdv-steps" role="tablist" aria-label="Etapas da venda">{stepButton('produto', 'Produto', 'Z')}{stepButton('cliente', 'Cliente', 'C')}{stepButton('pagamento', 'Pagamento', 'B')}</nav>
        <div className="pdv-columns">
          <div className="pdv-form">
            {step === 'produto' && <>
              <label>Lista de preço<select defaultValue="Nenhuma lista"><option>Nenhuma lista</option></select></label>
              <label className="pdv-toggle"><input type="checkbox" role="switch" />Leitor de código de barras</label>
              <div className="pdv-search"><input ref={productInput} type="search" aria-label="Pesquisar produto" placeholder="Pesquise por código, descrição ou GTIN" value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} onKeyDown={event => { if (event.key === 'Enter' && matches[0]) { event.preventDefault(); setSelected(matches[0]); setQuery(String(matches[0].description)); } }} />
                {matches.length > 0 && !selected && <ul className="pdv-suggestions" role="listbox">{matches.map(row => <li key={row.id}><button type="button" onClick={() => { setSelected(row); setQuery(String(row.description)); }}>{String(row.description)}<small>Cód: {String(row.sku)}</small></button></li>)}</ul>}</div>
              <button type="button" className="pdv-favorites-button" onClick={() => run('favoritos')}><Icon name="star" size={11} />Ver favoritos ({hint('G')})</button>
              {showFavorites && <div className="pdv-favorites">{favorites.map(row => <button type="button" key={row.id} onClick={() => { setSelected(row); setQuery(String(row.description)); setShowFavorites(false); }}>{String(row.description)}</button>)}</div>}
              <div className="pdv-product"><div className="pdv-image" aria-hidden="true"><Icon name="image" size={64} /></div>
                <div className="pdv-product-fields"><p className="pdv-list-value">Valor da lista aplicado: <strong>{selected ? money(selected.price) : money(0)}</strong></p>
                  <label>Quantidade<span className="pdv-qty"><button type="button" aria-label="Diminuir quantidade" onClick={() => setQuantity(Math.max(1, quantity - 1))}>-</button><input inputMode="numeric" value={quantity} onChange={event => setQuantity(Math.max(1, Number(event.target.value) || 1))} /><button type="button" aria-label="Aumentar quantidade" onClick={() => setQuantity(quantity + 1)}>+</button></span></label>
                  <label>Desconto<input inputMode="decimal" value={discount} onChange={event => setDiscount(event.target.value)} /></label>
                  <label>Valor unitário<input readOnly value={selected ? money(selected.price) : ''} /></label>
                  <label>Sub total<input readOnly value={selected ? money(Math.max(0, quantity * (Number(selected.price) || 0) - (Number(discount.replace(',', '.')) || 0))) : ''} /></label>
                  <label className="pdv-wide">Comentário<textarea rows={2} value={comment} onChange={event => setComment(event.target.value)} /></label>
                  <button type="button" className="primary-button" onClick={insert}>Inserir</button></div></div>
            </>}
            {step === 'cliente' && <div className="pdv-grid"><label className="pdv-wide">Nome *<input ref={customerInput} value={customer} onChange={event => setCustomer(event.target.value)} placeholder="Consumidor não identificado" /></label><label>Tipo<select defaultValue="Pessoa física"><option>Pessoa jurídica</option><option>Pessoa física</option><option>Estrangeiro</option></select></label><label>CPF/CNPJ<input placeholder="Não informe dados reais" /></label><label>Fantasia<input /></label></div>}
            {step === 'pagamento' && <div className="pdv-grid"><label>Forma de pagamento<select ref={paymentSelect} value={payment} onChange={event => setPayment(event.target.value)}><option>Dinheiro</option><option>Cartão de crédito</option><option>Cartão de débito</option><option>Pix</option></select></label><label>Total recebido em dinheiro<input inputMode="decimal" value={received} onChange={event => setReceived(event.target.value)} /></label><p className="pdv-totals">Sub total <strong>{money(total)}</strong></p><p className="pdv-totals">Troco em dinheiro <strong>{money(change)}</strong></p><p className="pdv-totals is-total">Total da venda <strong>{money(total)}</strong></p></div>}
          </div>
          <div className="pdv-items" aria-label="Itens da venda">{cart.length === 0 ? <div className="pdv-empty"><Icon name="cash-register" size={72} /></div> : <table className="data-table"><thead><tr><th>Produto</th><th className="numeric">Qtde</th><th className="numeric">Valor</th><th><span className="sr-only">Remover</span></th></tr></thead><tbody>{cart.map(item => <tr key={item.id}><td>{item.description}<small>Cód: {item.code}</small></td><td className="numeric">{item.quantity}</td><td className="numeric">{money(item.quantity * item.unitPrice - item.discount)}</td><td><button type="button" className="origin-kebab" aria-label={`Remover ${item.description}`} onClick={() => setCart(cart.filter(other => other.id !== item.id))}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table>}</div>
        </div>
        <footer className="pdv-footer"><button type="button" className="secondary-button" onClick={() => run('excluir')}>Excluir venda ({hint('Q')})</button><button type="button" className="primary-button" onClick={finish}>Finalizar venda ({hint('S')})</button><span className="pdv-total">Total <strong>{money(total)}</strong></span></footer>
      </section>
      <aside className="pdv-orders" aria-label="Pedidos do caixa"><h2><Icon name="cash-register" size={13} />Pedidos</h2>{sales.length === 0 ? <p>Nenhum pedido cadastrado</p> : <ul>{sales.map(row => <li key={row.id}><strong>{String(row.number)}</strong><span>{String(row.customer)}</span><span>{money(row.total)}</span></li>)}</ul>}</aside>
    </div>
    {showShortcuts && <div className="modal-backdrop" role="presentation" onClick={() => setShowShortcuts(false)}><div className="modal pdv-shortcuts" role="dialog" aria-modal="true" aria-labelledby="pdv-shortcuts-title" onClick={event => event.stopPropagation()}><div className="modal-header"><h2 id="pdv-shortcuts-title">Lista de atalhos</h2><button type="button" className="icon-button" aria-label="Fechar" onClick={() => setShowShortcuts(false)}><Icon name="xmark" size={14} /></button></div><ul>{PDV_SHORTCUTS.map(item => <li key={item.action}><span>{item.label}</span><kbd>{hint(item.key)}</kbd></li>)}</ul></div></div>}
  </div>;
}
