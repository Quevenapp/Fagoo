// Gerenciador de transições nos documentos (202610200163): situações padrão (o status-base) e personalizadas, e as
// transições configuradas. Sem a leitura (banco anterior a 163 ou falha), as telas seguem as situações padrão do domínio.
import { STATES, TRANSITIONS, type DocumentKind, type DocumentPermissions } from './real-documents-model.ts';
import { effectTransitionAllowed } from './document-effects-model.ts';

export type TransitionAction = 'post_finance' | 'post_stock' | 'reverse_finance' | 'reverse_stock';
export interface DocumentSituation { key: string; base_status: string; name: string; color: string; default: boolean; active: boolean }
export interface SituationTransition { from: string; to: string; active: boolean; actions: TransitionAction[] }
export interface SituationModel { kind: DocumentKind; adopted: boolean; situations: DocumentSituation[]; transitions: SituationTransition[]; occurrence_date_editable: boolean }
/** Situação carried by a row or document read (163); absent before it. */
export interface RowSituation { key: string; base_status: string; name: string; color: string; default: boolean }
export const SITUATION_KINDS: readonly DocumentKind[] = ['sales_orders', 'purchase_orders', 'service_orders'];
export const ACTION_LABELS: Record<TransitionAction, string> = { reverse_stock: 'Estornar estoque', reverse_finance: 'Estornar contas', post_stock: 'Lançar estoque', post_finance: 'Lançar contas' };
const ACTIONS = Object.keys(ACTION_LABELS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLOR = /^#[0-9a-f]{6}$/;

/** The worker already checks the answer strictly; this guards against a foreign or late page. */
export function readSituations(value: unknown, kind: DocumentKind): SituationModel {
  const page = value as SituationModel | null;
  if (!page || page.kind !== kind || typeof page.adopted !== 'boolean' || !Array.isArray(page.situations) || !Array.isArray(page.transitions) || typeof page.occurrence_date_editable !== 'boolean'
    || page.situations.some(item => !item || !Object.hasOwn(STATES[kind], item.base_status) || typeof item.name !== 'string' || !COLOR.test(item.color) || (item.default ? item.key !== item.base_status : !UUID.test(item.key)))
    || page.transitions.some(item => !item || typeof item.from !== 'string' || typeof item.to !== 'string' || typeof item.active !== 'boolean' || !Array.isArray(item.actions) || item.actions.some(action => !ACTIONS.includes(action)))) throw new Error('DOCUMENT_SITUATIONS_INVALID');
  return page;
}
/** The model applies only to the managed kinds once the database adopted them. */
export const managed = (model: SituationModel | null | undefined, kind: DocumentKind): model is SituationModel => Boolean(model && model.kind === kind && model.adopted && SITUATION_KINDS.includes(kind));
export const rowKey = (row: { status: string; situation?: RowSituation | null }) => row.situation?.key ?? row.status;
export function situationOf(model: SituationModel | null | undefined, kind: DocumentKind, key: string): DocumentSituation | null {
  if (managed(model, kind)) return model.situations.find(item => item.key === key) ?? null;
  return Object.hasOwn(STATES[kind], key) ? { key, base_status: key, name: STATES[kind][key]!, color: '#607d8b', default: true, active: true } : null;
}
export const situationName = (model: SituationModel | null | undefined, kind: DocumentKind, key: string) => situationOf(model, kind, key)?.name ?? STATES[kind][key] ?? key;
export const baseOf = (model: SituationModel | null | undefined, kind: DocumentKind, key: string) => situationOf(model, kind, key)?.base_status ?? key;
export function transitionOf(model: SituationModel | null | undefined, kind: DocumentKind, from: string, to: string): SituationTransition | null {
  if (!managed(model, kind)) return (TRANSITIONS[kind][from] ?? []).includes(to) ? { from, to, active: true, actions: [] } : null;
  return model.transitions.find(item => item.from === from && item.to === to) ?? null;
}
type TargetRow = { status: string; situation?: RowSituation | null; template?: boolean; finance_active?: boolean; stock_active?: boolean; receipt_active?: boolean; reservation_active?: boolean | null };
/**
 * Situações the server accepts from the current one: an active transition to an active situação. With active effects (or
 * an active reservation) only the forward moves the SQL guards allow remain, unless the transition reverses the effect.
 */
export function situationTargets(model: SituationModel | null | undefined, kind: DocumentKind, row: TargetRow, effects?: { active: boolean }): string[] {
  const from = rowKey(row), active = effects?.active ?? Boolean(row.finance_active || row.stock_active || row.receipt_active || row.reservation_active);
  const keys = managed(model, kind) ? model.transitions.filter(item => item.from === from && item.active).map(item => item.to).filter(to => situationOf(model, kind, to)?.active) : (TRANSITIONS[kind][row.status] ?? []);
  return keys.filter(to => {
    const base = baseOf(model, kind, to), actions = transitionOf(model, kind, from, to)?.actions ?? [];
    // A receipt or a reservation is never undone by a transition; a posting is, when the transition reverses it.
    const reverses = (!row.stock_active || actions.includes('reverse_stock')) && (!row.finance_active || actions.includes('reverse_finance')) && !row.receipt_active && !row.reservation_active;
    return (!active || effectTransitionAllowed(kind, row.status, base, row.finance_active !== false) || (reverses && base !== row.status)) && !(row.template && base === 'approved');
  });
}
/** Every situação some transition reaches (batch "Mudar situação" offers these; the rows that cannot reach one are skipped). */
export function batchSituationTargets(model: SituationModel | null | undefined, kind: DocumentKind): string[] {
  if (!managed(model, kind)) return Object.keys(STATES[kind]).filter(status => Object.values(TRANSITIONS[kind]).some(targets => targets.includes(status)));
  const reached = new Set(model.transitions.filter(item => item.active).map(item => item.to));
  return model.situations.filter(item => item.active && reached.has(item.key)).map(item => item.key);
}
/** The actions a transition runs, in the order the server runs them (estornos first). */
export function transitionActions(model: SituationModel | null | undefined, kind: DocumentKind, from: string, to: string): TransitionAction[] {
  const actions = transitionOf(model, kind, from, to)?.actions ?? [];
  return (['reverse_stock', 'reverse_finance', 'post_stock', 'post_finance'] as const).filter(action => actions.includes(action));
}
/** Profiles that may run each action (the stock and finance RPCs check the same roles). */
export function actionsAllowed(actions: readonly TransitionAction[], role: string) {
  return actions.every(action => action.endsWith('stock') ? ['admin', 'estoque'].includes(role) : ['admin', 'financeiro'].includes(role));
}
/** Targets whose transition actions the profile can run (the others would only be refused by the server). */
export function runnableTargets(model: SituationModel | null | undefined, kind: DocumentKind, from: string, targets: readonly string[], role: string): string[] {
  return targets.filter(to => actionsAllowed(transitionActions(model, kind, from, to), role));
}
/**
 * 202610200239: the targets Sistema › Usuários leaves the user choose. An OS without "Gerenciar situações" offers none; a pedido in an
 * approval situação of the discount moves only between the approval situações unless the user approves (the server checks again).
 */
export function permittedTargets(kind: DocumentKind, from: string, targets: readonly string[], permissions?: DocumentPermissions | null): string[] {
  if (!permissions) return [...targets];
  if (kind === 'service_orders' && !permissions.service_orders.situations) return [];
  const set = permissions.sales_orders.approval_situations;
  if (kind === 'sales_orders' && !permissions.sales_orders.discount_approver && set.includes(from)) return targets.filter(target => set.includes(target));
  return [...targets];
}
/** Why the user sees fewer (or no) situações, or null. */
export function situationPermissionNote(kind: DocumentKind, from: string, permissions?: DocumentPermissions | null): string | null {
  if (!permissions) return null;
  if (kind === 'service_orders' && !permissions.service_orders.situations) return 'Seu usuário não tem a permissão “Gerenciar situações” das ordens de serviço (Sistema › Usuários › Permissões).';
  if (kind === 'sales_orders' && !permissions.sales_orders.discount_approver && permissions.sales_orders.approval_situations.includes(from))
    return 'Este pedido aguarda a aprovação do desconto: só quem pode desconsiderar o limite de desconto do vendedor muda a situação.';
  return null;
}
/** Honest note of what one change of situação does besides recording the occurrence. */
export function transitionNote(actions: readonly TransitionAction[]) {
  if (!actions.length) return 'A mudança fica registrada nas ocorrências do documento. Estoque, contas e nota fiscal não são lançados por esta ação.';
  return `Esta transição também executa: ${actions.map(action => ACTION_LABELS[action]).join(', ')} (Gerenciador de transições). Os estornos rodam antes da mudança e os lançamentos depois, com a categoria do documento (ou a padrão), as parcelas salvas e a data das Preferências; se faltar algum dado ou permissão, nada muda.`;
}
/** Situação options of the list filter: the active ones plus any already chosen (an inactive one stays selectable to remove it). */
export function filterSituations(model: SituationModel, chosen: readonly string[]): DocumentSituation[] {
  return model.situations.filter(item => item.active || chosen.includes(item.key));
}
/** The row as if it were in situação `key` (the occurrences modal asks the targets of the selected situação). */
export function rowAt<T extends TargetRow>(model: SituationModel | null | undefined, kind: DocumentKind, row: T, key: string): T {
  const situation = situationOf(model, kind, key);
  if (!managed(model, kind) || !situation) return { ...row, status: key, situation: null };
  return { ...row, status: situation.base_status, situation: { key, base_status: situation.base_status, name: situation.name, color: situation.color, default: situation.default } };
}
