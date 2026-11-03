// Gerenciador de transições nos documentos (202610200163): situações padrão (o status-base) e personalizadas (id) de
// pedidos de venda, pedidos de compra e ordens de serviço. Strict checks of every key and of every answer field.
import { STATES } from '../../../packages/erp-domain/src/index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLOR = /^#[0-9a-f]{6}$/;
const ACTIONS = ['post_finance', 'post_stock', 'reverse_finance', 'reverse_stock'];
export const SITUATION_KINDS = Object.freeze(['sales_orders', 'purchase_orders', 'service_orders']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
const name = value => typeof value === 'string' && value.length >= 1 && [...value].length <= 40 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
export class SituationShapeError extends Error {}
// Situações padrão added by later migrations, one group per migration: 245 (Venda Agenciada, Faturado parcialmente) and 291
// (Checkout parcial). A database before a group lists the situações padrão without it.
const LATER = Object.freeze({ sales_orders: Object.freeze([Object.freeze(['agency_sale', 'partially_invoiced']), Object.freeze(['checkout_partial'])]) });
const bad = () => { throw new SituationShapeError('SITUATION_INVALID'); };

/** A situação key the worker accepts: a status-base of the kind, or (managed kinds) the lowercase id of a custom one. */
export const situationKey = (kind, value) => typeof value === 'string' && (Object.hasOwn(STATES[kind] ?? {}, value) || (SITUATION_KINDS.includes(kind) && UUID.test(value)));

/** Situação of a row or document (null outside the managed kinds); the default one is the status itself. */
export function situationValue(value, kind, status) {
  if (value === null) { if (SITUATION_KINDS.includes(kind)) bad(); return null; }
  if (!SITUATION_KINDS.includes(kind) || !keys(value, ['key', 'base_status', 'name', 'color', 'default']) || value.base_status !== status || typeof value.default !== 'boolean'
    || !name(value.name) || typeof value.color !== 'string' || !COLOR.test(value.color) || (value.default ? value.key !== status : !UUID.test(value.key ?? ''))) bad();
  return { key: value.key, base_status: value.base_status, name: value.name, color: value.color, default: value.default };
}
/** Occurrence snapshot (key, name and color of the moment); a later rename never rewrites it. */
export function occurrenceSituation(value, kind) {
  if (value === null || value === undefined) return null;
  if (!SITUATION_KINDS.includes(kind) || !keys(value, ['key', 'name', 'color']) || !situationKey(kind, value.key) || !name(value.name) || typeof value.color !== 'string' || !COLOR.test(value.color)) bad();
  return { key: value.key, name: value.name, color: value.color };
}
/** Actions run by the transition (Estornar/Lançar estoque e contas): done or skipped (nothing active to reverse, already posted). */
export function transitionEffects(value) {
  if (!Array.isArray(value) || value.length > 4) bad();
  const out = value.map(item => {
    if (!object(item) || !ACTIONS.includes(item.action) || !['done', 'skipped'].includes(item.outcome)) bad();
    if (item.outcome === 'done' ? !keys(item, ['action', 'outcome', 'posting_id']) || !UUID.test(item.posting_id ?? '') : !keys(item, ['action', 'outcome'])) bad();
    return item.outcome === 'done' ? { action: item.action, outcome: 'done', posting_id: item.posting_id } : { action: item.action, outcome: 'skipped' };
  });
  if (new Set(out.map(item => item.action)).size !== out.length) bad();
  return out;
}
/** GET /v1/documentos/{tipo}/situacoes: situações (padrão first, by base) and the transitions between them. */
export function situationsPage(value, kind) {
  if (!object(value) || value.kind !== kind || typeof value.adopted !== 'boolean' || !Array.isArray(value.situations) || value.situations.length > 60
    || !Array.isArray(value.transitions) || value.transitions.length > 600 || typeof value.occurrence_date_editable !== 'boolean') bad();
  if (!SITUATION_KINDS.includes(kind) && (value.adopted || value.situations.length || value.transitions.length)) bad();
  const situations = value.situations.map(item => {
    if (!keys(item, ['key', 'base_status', 'name', 'color', 'default', 'active']) || !Object.hasOwn(STATES[kind], item.base_status) || typeof item.default !== 'boolean' || typeof item.active !== 'boolean'
      || !name(item.name) || typeof item.color !== 'string' || !COLOR.test(item.color) || (item.default ? item.key !== item.base_status || !item.active : !UUID.test(item.key ?? ''))) bad();
    return { key: item.key, base_status: item.base_status, name: item.name, color: item.color, default: item.default, active: item.active };
  });
  const known = new Set(situations.map(item => item.key));
  // 202610200245 adds Venda Agenciada and Faturado parcialmente: a database before it lists the earlier situações padrão only.
  const groups = LATER[kind] ?? [], required = Object.keys(STATES[kind]).filter(status => { const group = groups.find(keys => keys.includes(status)); return !group || group.some(key => known.has(key)); });
  if (known.size !== situations.length || (value.adopted && required.some(status => !known.has(status)))) bad();
  const transitions = value.transitions.map(item => {
    if (!keys(item, ['from', 'to', 'active', 'actions']) || !known.has(item.from) || !known.has(item.to) || item.from === item.to || typeof item.active !== 'boolean'
      || !Array.isArray(item.actions) || item.actions.length > 2 || item.actions.some(action => !ACTIONS.includes(action)) || new Set(item.actions).size !== item.actions.length
      || (item.actions.includes('post_stock') && item.actions.includes('reverse_stock')) || (item.actions.includes('post_finance') && item.actions.includes('reverse_finance'))) bad();
    return { from: item.from, to: item.to, active: item.active, actions: [...item.actions] };
  });
  if (new Set(transitions.map(item => `${item.from}>${item.to}`)).size !== transitions.length) bad();
  return { kind, adopted: value.adopted, situations, transitions, occurrence_date_editable: value.occurrence_date_editable };
}
