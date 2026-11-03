import type { DemoLineItem, DemoRecord, FieldDefinition } from '../types';

const validAmount = (value: unknown) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number.isSafeInteger(Math.round(Number(value) * 100));
const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);

export function netUnitPrice(item: DemoLineItem) {
  const listPrice = item.listPrice ?? item.unitPrice;
  if (!validAmount(listPrice) || !Number.isFinite(item.discount) || item.discount < 0 || item.discount > 100) return NaN;
  const value = Math.round(cents(listPrice) * (1 - item.discount / 100));
  return Number.isSafeInteger(value) ? value / 100 : NaN;
}

export function itemTotal(item: DemoLineItem) {
  if (!Number.isFinite(item.quantity) || item.quantity < 0 || !Number.isFinite(netUnitPrice(item))
      || !Number.isFinite(item.discount) || item.discount < 0 || item.discount > 100) return NaN;
  const value = Math.round(item.quantity * cents(netUnitPrice(item)));
  return Number.isSafeInteger(value) ? value / 100 : NaN;
}

export function itemsTotal(items: DemoLineItem[]) {
  const value = items.reduce((total, item) => total + Math.round(itemTotal(item) * 100), 0);
  return Number.isSafeInteger(value) ? value / 100 : NaN;
}

export function documentTotal(items: DemoLineItem[], values: DemoRecord) {
  if (![values.discount ?? 0, values.freight ?? 0, values.otherExpenses ?? 0].every(validAmount)) return NaN;
  const amount = Math.round(itemsTotal(items) * 100) - cents(values.discount) + cents(values.freight) + cents(values.otherExpenses);
  return Number.isSafeInteger(amount) ? amount / 100 : NaN;
}

export function validDemoItems(value: unknown): value is DemoLineItem[] {
  return Array.isArray(value) && value.length <= 200 && value.every(item => item && typeof item.id === 'string'
    && typeof item.description === 'string' && typeof item.unit === 'string'
    && Number.isFinite(item.quantity) && item.quantity > 0 && validAmount(item.unitPrice)
    && Number.isFinite(item.discount) && item.discount >= 0 && item.discount <= 100
    && Number.isFinite(itemTotal(item)));
}

export function validateDemoForm(fields: FieldDefinition[], values: DemoRecord, items?: DemoLineItem[]) {
  for (const field of fields) {
    const value = values[field.key];
    if (field.required && !String(value ?? '').trim()) return `Preencha o campo ${field.label}.`;
    if (['number', 'money'].includes(field.type || '') && value !== undefined && value !== '') {
      if (!Number.isFinite(Number(value)) || (field.type === 'money' && !Number.isSafeInteger(cents(value)))) return `Informe um valor válido para ${field.label}.`;
      if (field.type === 'money' && Number(value) < 0) return `${field.label} não pode ser negativo.`;
    }
  }
  if (items) {
    if (!validDemoItems(items) || items.some(item => !item.description.trim() || !item.unit.trim())) return 'Confira a descrição, unidade, quantidade, preço e desconto dos itens.';
    const total = documentTotal(items, values);
    if (!Number.isFinite(total)) return 'Confira os valores dos itens, desconto, frete e outras despesas.';
    if (total < 0) return 'O desconto não pode superar o valor do documento.';
  }
  return null;
}
