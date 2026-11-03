import type { DemoRecord, ModuleDefinition } from '../types';

export const normalized = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');

export function localCalendarDate(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function effectiveDateField(module: ModuleDefinition, params: URLSearchParams) {
  if (['contas-receber', 'contas-pagar'].includes(module.id)) {
    if (params.get('filter.option') === 'Emitidas') return 'date';
    if (['Recebidas', 'Pagas'].includes(params.get('filter.option') || '')) return 'paymentDate';
  }
  return module.dateField;
}

export function filterAndSortRecords(rows: DemoRecord[], module: ModuleDefinition, params: URLSearchParams, referenceDate = localCalendarDate()) {
  const query = normalized(params.get('q')).trim();
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const latestIncluded = ['produtos', 'contatos'].includes(module.id) && normalized(params.get('filter.status')) === 'ultimos incluidos';
  const sort = latestIncluded && !params.get('sort') ? 'date' : module.columns.some(column => column.key === params.get('sort')) ? params.get('sort')! : module.columns[0]?.key || 'id';
  const direction = latestIncluded && !params.get('sort') ? -1 : params.get('direction') === 'desc' ? -1 : 1;
  return rows.filter(row => {
    if (query && ![...module.columns.map(column => column.key), ...(module.fields || []).map(field => field.key), ...(module.searchKeys || [])].some(key => normalized(row[key]).includes(query))) return false;
    if (module.listTabs && String(row[module.listTabs.key] ?? '') !== (params.get(`tab.${module.listTabs.key}`) || module.listTabs.options[0])) return false;
    if (module.filters?.some(filter => {
      const value = params.get(`filter.${filter.key}`);
      if (!value || (latestIncluded && filter.key === 'status')) return false;
      if (module.id === 'contatos' && filter.key === 'status' && value === 'Sem movimento') return row.noMovement !== true;
      if (filter.key === 'option' && ['contas-receber', 'contas-pagar'].includes(module.id)) {
        if (value === 'Emitidas') return false;
        if (value === 'Em aberto') return !(Number(row.balance) > 0);
        if (value === 'Atrasadas') return !(Number(row.balance) > 0 && String(row.dueDate) < referenceDate);
        if (value === 'Recebidas' || value === 'Pagas') return !['Recebido', 'Pago'].includes(String(row.status));
      }
      if (filter.kind === 'text') return !normalized(row[filter.key]).includes(normalized(value).trim());
      if (filter.kind === 'multi') return !value.split('|').filter(Boolean).includes(String(row[filter.key] ?? ''));
      return String(row[filter.key] ?? '') !== value;
    })) return false;
    const dateField = effectiveDateField(module, params);
    if (dateField) {
      const value = String(row[dateField] || '').slice(0, 10);
      if ((from && value < from) || (to && value > to)) return false;
    }
    return true;
  }).sort((left, right) => {
    const a = left[sort]; const b = right[sort];
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction;
    return String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR', { numeric: true, sensitivity: 'base' }) * direction;
  });
}

export function proposalToOrder(proposal: DemoRecord, orders: DemoRecord[], id: string, date: string) {
  const existing = orders.find(order => order.originModule === 'propostas' && order.originId === proposal.id);
  if (existing) return { record: existing, created: false };
  if (!Number.isFinite(Number(proposal.total)) || Number(proposal.total) < 0 || !Number.isSafeInteger(Math.round(Number(proposal.total) * 100))) throw new Error('Confira o total da proposta antes de gerar o pedido.');
  const number = orders.reduce((maximum, order) => Math.max(maximum, Number(String(order.number || '').replace(/\D/g, '')) || 0), 1000) + 1;
  return { created: true, record: {
    ...proposal, id, number: String(number), date, status: 'Em aberto',
    originId: proposal.id, originModule: 'propostas', originLabel: `Proposta ${proposal.number || proposal.id}`,
    stockStatus: 'Não lançado', financialStatus: 'Não lançado', fiscalStatus: 'Não emitida',
  } satisfies DemoRecord };
}

export function csvForRecords(rows: DemoRecord[], columns: ModuleDefinition['columns']) {
  const escape = (value: unknown) => {
    let text = String(value ?? '');
    if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [columns.map(column => escape(column.label)).join(';'),
    ...rows.map(row => columns.map(column => escape(row[column.key])).join(';'))].join('\r\n');
}
