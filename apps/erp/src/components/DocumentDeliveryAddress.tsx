import type { DeliveryAddress } from '../lib/real-documents-model';
import { DOCUMENT_LIST_UFS } from '../lib/document-list-model';
import { fillAddress, type PlatformPort } from '../lib/platform-model';
import CepLookupButton from './CepLookupButton';

const EMPTY: DeliveryAddress = { name: null, postal_code: null, state: null, city: null, district: null, street: null, number: null, complement: null, country: null };
// Origin "Endereço de entrega" (pedido e proposta), in the order of the capture.
const FIELDS: readonly { key: Exclude<keyof DeliveryAddress, 'state'>; id: string; label: string; max: number; help?: string }[] = [
  { key: 'name', id: 'doc-delivery-name', label: 'Nome', max: 120 }, { key: 'postal_code', id: 'doc-delivery-postal', label: 'CEP', max: 9 },
  { key: 'city', id: 'doc-delivery-city', label: 'Cidade *', max: 100 }, { key: 'district', id: 'doc-delivery-district', label: 'Bairro', max: 100 },
  { key: 'street', id: 'doc-delivery-street', label: 'Endereço *', max: 100, help: 'O tamanho máximo do campo é de 100 caracteres' },
  { key: 'number', id: 'doc-delivery-number', label: 'Número', max: 30 }, { key: 'complement', id: 'doc-delivery-complement', label: 'Complemento', max: 100 },
  { key: 'country', id: 'doc-delivery-country', label: 'País', max: 60 },
];

/** Delivery address different from the billing one; null keeps the contact address (print, NF and list use it). */
export default function DocumentDeliveryAddress({ value, disabled, onChange, invalid, lookup }: { value: DeliveryAddress | null; disabled: boolean; onChange: (value: DeliveryAddress | null) => void; invalid: (id: string) => Record<string, unknown>;
  /** Leva H (NFE-103): "Buscar CEP" fills the empty fields; the address can always be typed by hand. */
  lookup?: Partial<PlatformPort> }) {
  const current = value ?? EMPTY;
  const set = (key: keyof DeliveryAddress, text: string) => onChange({ ...current, [key]: text === '' ? null : text });
  return <fieldset disabled={disabled} className="document-section document-delivery"><legend>Endereço de entrega</legend>
    <label className="document-check"><input id="doc-delivery-different" type="checkbox" checked={value !== null} onChange={event => onChange(event.target.checked ? { ...EMPTY } : null)} />Endereço de entrega diferente da cobrança</label>
    {value && <div className="document-grid">
      {FIELDS.slice(0, 2).map(field => <div className="form-field" key={field.key}><label htmlFor={field.id}>{field.label}</label><input id={field.id} maxLength={field.max} value={current[field.key] ?? ''} {...invalid(field.id)} onChange={event => set(field.key, event.target.value)} /></div>)}
      {lookup && <div className="form-field"><span aria-hidden="true">&nbsp;</span><CepLookupButton id="doc-delivery-cep-lookup" controller={lookup} cep={current.postal_code} disabled={disabled} onFound={address => onChange(fillAddress(current, address))} /></div>}
      <div className="form-field"><label htmlFor="doc-delivery-state">UF</label><select id="doc-delivery-state" value={current.state ?? ''} onChange={event => set('state', event.target.value)}><option value="">UF</option>{DOCUMENT_LIST_UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}</select></div>
      {FIELDS.slice(2).map(field => <div className={`form-field${field.key === 'street' ? ' document-wide' : ''}`} key={field.key}><label htmlFor={field.id}>{field.label}</label><input id={field.id} maxLength={field.max} value={current[field.key] ?? ''} {...invalid(field.id)} onChange={event => set(field.key, event.target.value)} />{field.help && <small>{field.help}</small>}</div>)}
    </div>}
  </fieldset>;
}
