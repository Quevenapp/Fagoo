/** Sincronização de mão dupla com o Origin (202610220009-011): situação lida de /v1/sincronizacao-origin e textos da tela. */
export interface OriginSyncIssue { at: string | null; direction: 'push' | 'pull' | 'census'; entity: string | null; record_id: string | null; source_id: string | null; code: string | null; detail: string | null }
export interface OriginSyncRun { id: string; state: 'queued' | 'running' | 'done' | 'failed'; phase: 'push' | 'census' | 'fetch' | 'pull' | 'stock' | 'done'; requested_at: string | null; started_at: string | null; finished_at: string | null; stats: Record<string, number>; error: string | null }
export interface OriginSyncStatus {
  scope: 'origin_sync'; enabled: boolean; actor_configured: boolean;
  push: { pending: number; failed: number; last_sent_at: string | null };
  pull: { pending: number; failed: number; last_applied_at: string | null };
  issues: number; recent_issues: OriginSyncIssue[]; run: OriginSyncRun | null; requested_run?: string;
}
export interface OriginSyncController { originSync: (path: string, options?: { method?: 'GET' | 'POST'; signal?: AbortSignal }) => Promise<unknown> }
export const ORIGIN_SYNC_PATH = '/v1/sincronizacao-origin';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const stamp = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && Number.isFinite(Date.parse(v)));

/** Accepts only the shape the API sends; anything else is a failed read, never a partial status. */
export function readOriginSyncStatus(value: unknown): OriginSyncStatus {
  const bad = () => { throw new Error('ORIGIN_SYNC_INVALID_STATUS'); };
  if (!object(value) || value.scope !== 'origin_sync' || typeof value.enabled !== 'boolean' || typeof value.actor_configured !== 'boolean'
    || !object(value.push) || !object(value.pull) || !count(value.issues) || !Array.isArray(value.recent_issues)) bad();
  const v = value as unknown as OriginSyncStatus;
  for (const side of [v.push, v.pull]) if (!count(side.pending) || !count(side.failed)) bad();
  if (!stamp(v.push.last_sent_at) || !stamp(v.pull.last_applied_at)) bad();
  if (v.run !== null && v.run !== undefined && (!object(v.run) || !['queued', 'running', 'done', 'failed'].includes(v.run.state) || !object(v.run.stats))) bad();
  return { ...v, run: v.run ?? null };
}

export const runActive = (status: OriginSyncStatus | null) => status?.run?.state === 'queued' || status?.run?.state === 'running';

const PHASES: Record<OriginSyncRun['phase'], string> = {
  push: 'Enviando ao Origin o que mudou no FAGOO', census: 'Conferindo no Origin o que foi criado ou excluído lá', fetch: 'Trazendo do Origin o que faltava',
  pull: 'Aplicando no FAGOO o que mudou no Origin', stock: 'Conferindo saldos de estoque', done: 'Concluída',
};
export const ENTITY_LABELS: Record<string, string> = {
  contacts: 'Contato', products: 'Produto', sales_orders: 'Pedido de venda', sales_proposals: 'Proposta', purchase_orders: 'Pedido de compra',
  service_orders: 'Ordem de serviço', receivables: 'Conta a receber', payables: 'Conta a pagar', stock: 'Estoque', stock_balances: 'Estoque',
};
const CODES: Record<string, string> = {
  ORIGIN_API_HAS_NO_SERVICE_ORDER_WRITE: 'A API do Origin não permite gravar ordens de serviço; esta OS fica só no FAGOO.',
  ORIGIN_API_HAS_NO_SETTLEMENT_REVERSAL: 'A API do Origin não estorna baixas: estorne também no Origin.',
  WAREHOUSE_NOT_IN_ORIGIN: 'Depósito sem vínculo com o Origin: o movimento ficou só no FAGOO.',
  ORIGIN_ACCOUNT_OR_CATEGORY_UNKNOWN: 'Sem conta ou categoria do Origin para a baixa.',
  NO_FINANCE_ACCOUNT_FOR_SETTLEMENT: 'Baixa do Origin sem conta financeira no FAGOO: cadastre uma conta.',
  STATUS_UNMAPPED: 'Situação do Origin sem correspondência no FAGOO; a situação atual foi mantida.',
  INSTALLMENTS_NOT_APPLIED: 'As parcelas do Origin não fecham com o total; o documento entrou sem parcelas.',
  CONTACT_NOT_IN_ORIGIN_SYNC: 'O contato deste registro ainda não chegou do Origin.',
  ITEMS_UNAVAILABLE: 'Documento do Origin sem itens válidos.',
  ORIGIN_UNAUTHORIZED: 'A conexão com o Origin expirou: reautorize o aplicativo na integração.',
  ORIGIN_FORBIDDEN: 'O aplicativo do Origin não tem permissão para esta operação.',
  ORIGIN_WRITE_NOT_CONFIGURED: 'A API do FAGOO ainda não recebeu as credenciais do aplicativo do Origin.',
};
export function issueText(issue: OriginSyncIssue): string {
  const what = ENTITY_LABELS[issue.entity ?? ''] ?? 'Registro';
  const side = issue.direction === 'push' ? 'Envio ao Origin' : issue.direction === 'pull' ? 'Recebimento do Origin' : 'Conferência';
  const text = (issue.code && CODES[issue.code]) || issue.detail || issue.code || 'Falha sem detalhe.';
  return `${side} · ${what}${issue.source_id ? ` ${issue.source_id}` : ''}: ${text}`;
}
export function runText(run: OriginSyncRun | null): string {
  if (!run) return 'Nenhuma sincronização pedida ainda.';
  if (run.state === 'queued') return 'Sincronização pedida; começa em instantes.';
  if (run.state === 'running') return `${PHASES[run.phase] ?? 'Em andamento'}…`;
  if (run.state === 'failed') return `A última sincronização parou: ${(run.error && CODES[run.error]) || run.error || 'erro sem código'}.`;
  return 'Última sincronização concluída.';
}
export const when = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
export function statsText(stats: Record<string, number> | undefined): string {
  if (!stats) return '';
  const parts = [[stats.pushed, 'enviados'], [stats.pulled, 'recebidos'], [stats.fetched, 'trazidos'], [stats.deleted_in_origin, 'excluídos no Origin'], [stats.failed, 'com erro']]
    .filter(([n]) => typeof n === 'number' && (n as number) > 0).map(([n, label]) => `${n} ${label}`);
  return parts.join(' · ');
}
