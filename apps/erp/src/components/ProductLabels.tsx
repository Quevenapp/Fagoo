import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { decimalMoney } from '../lib/real-access';
import { barRuns } from '../lib/barcodes';
import { LABEL_MODELS, labelSheet, productBarcode, type LabelModel } from '../lib/product-labels';
import './document-print.css';
import './product-registry.css';

// "Imprimir etiquetas" (⋮ da linha) e "Imprimir etiquetas selecionadas" (painel) da listagem de produtos: quantidade por produto,
// modelo (A4 Pimaco ou térmica de 1 coluna) e conteúdo (nome, código, preço e código de barras do GTIN ou do SKU), numa prévia
// impressa pelo navegador. Os modelos com campos posicionados ficam em Preferências > Sistema > Etiquetas customizadas.
export type LabelProduct = { id: string; name: string; code: string | null; price: string | null; gtin: string | null };
type Content = { name: boolean; code: boolean; price: boolean; barcode: boolean };

function Barcode({ product, width }: { product: LabelProduct; width: number }) {
  const code = productBarcode(product.gtin, product.code);
  if (!code) return <span className="product-label-nobarcode">Sem GTIN ou código para o código de barras</span>;
  const runs = barRuns(code.bits);
  return <svg className="product-label-barcode" viewBox={`0 0 ${code.bits.length} 30`} preserveAspectRatio="none" style={{ width: `${width}mm` }} role="img" aria-label={`${code.format} ${code.value}`}>
    {runs.map(([x, w]) => <rect key={x} x={x} y={0} width={w} height={30} />)}</svg>;
}

/** 202610200283 (produtos, EST-018): "uma etiqueta por quantidade" — the caller may prefill the quantity of each product (1 to 999,
 * for example the quantity of the items of the pedidos de compra); any other value starts at 1. The quantities stay editable. */
export function ProductLabels({ products, initialQuantities, onClose }: { products: readonly LabelProduct[]; initialQuantities?: Readonly<Record<string, string>>; onClose: () => void }) {
  const [model, setModel] = useState<LabelModel>(LABEL_MODELS[0]), [content, setContent] = useState<Content>({ name: true, code: true, price: true, barcode: true });
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(products.map(product => {
    const initial = initialQuantities?.[product.id]; return [product.id, initial !== undefined && /^[1-9]\d{0,2}$/.test(initial) ? initial : '1'];
  })));
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const [portal] = useState(() => { const node = document.createElement('div'); node.className = 'document-print-root'; return node; });
  useEffect(() => {
    document.body.append(portal); document.body.classList.add('document-print-open');
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); } };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); document.body.classList.remove('document-print-open'); portal.remove(); };
  }, [portal]);
  const invalid = products.filter(product => !/^([1-9]\d{0,2})$/.test(quantities[product.id] ?? ''));
  const labels = labelSheet(products, quantities);
  const toggle = (key: keyof Content) => setContent(current => ({ ...current, [key]: !current[key] }));
  return createPortal(<div className="document-print-dialog" role="dialog" aria-modal="true" aria-labelledby="product-labels-title">
    <header className="document-print-controls"><div><h2 id="product-labels-title">Imprimir etiquetas · {labels.length} etiqueta(s)</h2><p>{products.length} produto(s). A quantidade vale por produto.</p></div>
      <div className="contact-print-actions">
        <label>Modelo<select id="product-labels-model" value={model.id} onChange={event => setModel(LABEL_MODELS.find(item => item.id === event.target.value) ?? LABEL_MODELS[0])}>{LABEL_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <fieldset className="product-inline"><legend className="real-sr-only">Conteúdo</legend>{([['name', 'Nome'], ['code', 'Código'], ['price', 'Preço'], ['barcode', 'Código de barras']] as const).map(([key, label]) =>
          <label key={key} className="product-check"><input type="checkbox" checked={content[key]} onChange={() => toggle(key)} />{label}</label>)}</fieldset>
        <button type="button" className="primary-button" disabled={!labels.length || invalid.length > 0} onClick={() => window.print()}>Imprimir</button>
        <button type="button" className="secondary-button" onClick={onClose}>Fechar</button></div></header>
    <div className="product-labels-quantities"><table className="data-table"><thead><tr><th scope="col">Produto</th><th scope="col">Código</th><th scope="col">GTIN/EAN</th><th scope="col" className="numeric">Quantidade</th></tr></thead>
      <tbody>{products.map(product => <tr key={product.id}><td>{product.name}</td><td>{product.code ?? '—'}</td><td>{product.gtin ?? '—'}</td>
        <td className="numeric"><input aria-label={`Quantidade de etiquetas de ${product.name}`} inputMode="numeric" maxLength={3} value={quantities[product.id] ?? ''} aria-invalid={invalid.includes(product) || undefined}
          onChange={event => setQuantities(current => ({ ...current, [product.id]: event.target.value.replace(/\D/g, '') }))} /></td></tr>)}</tbody></table>
      {invalid.length > 0 && <p className="real-alert" role="alert">Informe de 1 a 999 etiquetas por produto.</p>}
      {labels.length >= 2000 && <p className="real-help">A impressão vai até 2.000 etiquetas por vez.</p>}</div>
    <div className="document-print-scroll" tabIndex={0} aria-label="Etiquetas para impressão">
      <div className={`product-label-sheet is-${model.id}`} style={{ gridTemplateColumns: `repeat(${model.columns}, ${model.width}mm)` }}>
        {labels.map((product, index) => <div key={`${product.id}:${index}`} className="product-label" style={{ width: `${model.width}mm`, height: `${model.height}mm` }}>
          {content.name && <strong className="product-label-name">{product.name}</strong>}
          {(content.code || content.price) && <span className="product-label-line">{content.code && product.code ? product.code : ''}{content.code && content.price && product.code ? ' · ' : ''}{content.price ? decimalMoney(product.price) : ''}</span>}
          {content.barcode && <Barcode product={product} width={model.width - 6} />}
        </div>)}</div>
    </div>
  </div>, portal);
}
