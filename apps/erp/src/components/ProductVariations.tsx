import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';

type Child = { id: string; name: string; code: string | null; active: boolean; gtin: string | null; price: string | null; attributes: Record<string, string> };
type View = { parent: { id: string; name: string; code: string | null; format: string }; children: Child[] };
const money = (value: string | null) => value === null ? '—' : `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
/** "55,9" → "55.9000" (the canonical unit price of the cadastro), or null. */
const decimalInput = (value: string) => {
  const clean = value.trim().replace(/\./g, '').replace(',', '.');
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  return `${BigInt(whole!)}.${(fraction + '0000').slice(0, 4)}`;
};

/**
 * Leva H (PRD-109, VND-153, 410): as variações do produto com Formato V. O pai só agrupa; cada variação é um produto (SKU filho)
 * com código, preço, GTIN e estoque próprios, criado por "Adicionar variação" com os atributos (Cor, Tamanho...). A venda escolhe o
 * filho, nunca o pai.
 */
export default function ProductVariations({ controller, productId, writable }: { controller: Pick<AccessController, 'catalog'>; productId: string; writable: boolean }) {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [attrs, setAttrs] = useState<{ name: string; value: string }[]>([{ name: 'Cor', value: '' }, { name: 'Tamanho', value: '' }]);
  const [code, setCode] = useState(''), [price, setPrice] = useState(''), [gtin, setGtin] = useState(''), [notice, setNotice] = useState('');
  const command = useRef<{ id: string; body: string } | null>(null);
  useEffect(() => {
    const request = new AbortController();
    void controller.catalog(`/v1/cadastros/products/${productId}/variacoes`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setView(value as View); })
      .catch(failure => { if (!request.signal.aborted && !(failure instanceof DOMException)) setError('Não foi possível consultar as variações.'); });
    return () => request.abort();
  }, [controller, productId, reload]);
  const add = async () => {
    const attributes = Object.fromEntries(attrs.filter(a => a.name.trim() && a.value.trim()).map(a => [a.name.trim(), a.value.trim()]));
    if (!Object.keys(attributes).length) { setError('Informe ao menos um atributo com valor (por exemplo Cor: Azul).'); return; }
    if (!code.trim()) { setError('Informe o código (SKU) da variação.'); return; }
    const priceValue = price.trim() ? decimalInput(price) : null;
    if (price.trim() && !priceValue) { setError('Confira o preço da variação.'); return; }
    if (gtin.trim() && !/^\d{8}$|^\d{12,14}$/.test(gtin.trim())) { setError('O GTIN tem 8, 12, 13 ou 14 dígitos.'); return; }
    const payload = { attributes, code: code.trim(), ...(priceValue ? { price: priceValue } : {}), ...(gtin.trim() ? { gtin: gtin.trim() } : {}) };
    const key = JSON.stringify(payload);
    // A result not confirmed is sent again with the same command; changing the fields starts a new one.
    if (!command.current || command.current.body !== key) command.current = { id: crypto.randomUUID(), body: key };
    setBusy(true); setError(''); setNotice('');
    try {
      await controller.catalog(`/v1/cadastros/products/${productId}/variacoes`, { method: 'POST', body: { command_id: command.current.id, ...payload } });
      command.current = null; setCode(''); setPrice(''); setGtin(''); setAttrs(current => current.map(a => ({ ...a, value: '' }))); setNotice('Variação criada.'); setReload(n => n + 1);
    } catch (failure) {
      const uncertain = !(failure instanceof AccessError) || failure.status >= 500;
      if (!uncertain) command.current = null;
      setError(failure instanceof AccessError && failure.status === 403 ? 'Seu usuário não tem a permissão Salvar variações (Cadastros › Produtos).'
        : failure instanceof AccessError && failure.status === 409 ? 'Já existe uma variação com esses atributos ou esse código.'
          : uncertain ? 'Não foi possível confirmar. Clique de novo: o mesmo comando é reenviado.' : 'Confira os atributos, o código, o preço e o GTIN.');
    } finally { setBusy(false); }
  };
  return <section className="real-editor product-variations" aria-labelledby="variations-title">
    <h3 id="variations-title">Variações</h3>
    <p className="real-help">Este produto só agrupa as variações: ele não é vendido nem movimenta estoque. Cada variação é um produto próprio (SKU), com código, preço, GTIN e estoque.</p>
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    {!view ? !error && <p role="status">Consultando…</p> : view.children.length === 0 ? <p className="empty-state">Nenhuma variação ainda.</p>
      : <table className="data-table"><thead><tr><th scope="col">Variação</th><th scope="col">Código</th><th scope="col" className="numeric">Preço</th><th scope="col">GTIN</th><th scope="col">Situação</th></tr></thead>
        <tbody>{view.children.map(child => <tr key={child.id}><td><a href={`/cadastros-reais?${new URLSearchParams({ cadastro: 'products', registro: child.id })}`} target="_blank" rel="noopener">{Object.entries(child.attributes).map(([k, v]) => `${k}: ${v}`).join(' · ')}</a></td>
          <td>{child.code ?? '—'}</td><td className="numeric">{money(child.price)}</td><td>{child.gtin ?? '—'}</td><td>{child.active ? 'Ativo' : 'Inativo'}</td></tr>)}</tbody></table>}
    {writable && <fieldset disabled={busy} className="product-variation-add"><legend>Adicionar variação</legend>
      {attrs.map((attr, index) => <div className="document-grid" key={index}>
        <div className="form-field"><label htmlFor={`variation-name-${index}`}>Atributo</label><input id={`variation-name-${index}`} maxLength={60} value={attr.name} onChange={event => setAttrs(current => current.map((a, i) => i === index ? { ...a, name: event.target.value } : a))} /></div>
        <div className="form-field"><label htmlFor={`variation-value-${index}`}>Valor</label><input id={`variation-value-${index}`} maxLength={60} value={attr.value} onChange={event => setAttrs(current => current.map((a, i) => i === index ? { ...a, value: event.target.value } : a))} /></div></div>)}
      {attrs.length < 5 && <button type="button" className="text-button" onClick={() => setAttrs(current => [...current, { name: '', value: '' }])}>+ Atributo</button>}
      <div className="document-grid">
        <div className="form-field"><label htmlFor="variation-code">Código (SKU) *</label><input id="variation-code" maxLength={100} value={code} onChange={event => setCode(event.target.value)} /></div>
        <div className="form-field"><label htmlFor="variation-price">Preço</label><input id="variation-price" inputMode="decimal" placeholder="o do produto" value={price} onChange={event => setPrice(event.target.value)} /></div>
        <div className="form-field"><label htmlFor="variation-gtin">GTIN</label><input id="variation-gtin" inputMode="numeric" maxLength={14} value={gtin} onChange={event => setGtin(event.target.value)} /></div></div>
      <button type="button" className="primary-button" onClick={() => void add()}>{busy ? 'Criando…' : 'Adicionar variação'}</button>
    </fieldset>}
  </section>;
}
