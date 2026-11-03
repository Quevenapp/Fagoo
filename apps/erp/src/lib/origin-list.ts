// Pure helpers behind the Origin-style list screens (situation tones, period presets, pagination, range selection).

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'progress' | 'overdue' | 'waiting';
export type BadgeStyle = { tone: BadgeTone; bold: boolean };

const normalize = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Tones observed in Origin on 19/10/2026 (docs/references/origin-interface.md, "Badges observadas").
const TONES: readonly [RegExp, BadgeStyle][] = [
  [/^(abaixo do minimo|acima do maximo|revisar estrutura|ha pontos para revisao|em revisao)/, { tone: 'warning', bold: false }],
  [/^(dentro dos limites|importad[ao])/, { tone: 'success', bold: false }],
  [/^(abertura a conferir)/, { tone: 'waiting', bold: false }],
  [/^(conferencia necessaria|formato nao reconhecido)/, { tone: 'danger', bold: false }],
  [/^(limites nao informados|correcao registrada|estornad[ao])/, { tone: 'neutral', bold: false }],
  [/^autorizada$/, { tone: 'success', bold: true }],
  [/^vence hoje$/, { tone: 'warning', bold: true }],
  [/^(atrasad[ao]|atrasada demais|vencid[ao])/, { tone: 'overdue', bold: false }],
  [/^(emitida danfe|emitida|em andamento|enviad[ao]|processando|em processamento|em contagem)/, { tone: 'progress', bold: false }],
  [/^(registrad[ao]|verificad[ao]|aguardando protocolo|em conferencia|orcad[ao])/, { tone: 'info', bold: false }],
  [/^(nao vinculad[ao]|aguardando|aguardando componentes|pendente de conferencia)/, { tone: 'waiting', bold: false }],
  [/^(rejeitad[ao]|denegad[ao]|nao aprovad[ao]|finalizada sem conserto|falha|com rejeicoes|erro)/, { tone: 'danger', bold: false }],
  [/^(cancelad[ao]|inativ[ao]|excluid[ao]|rascunho|em digitacao|sem movimento|modelos?)$/, { tone: 'neutral', bold: false }],
  [/^(em aberto|aberto|pendente|parcial|atendido parcialmente|recebido parcialmente|parcialmente pago|parcialmente recebido|faturado parcialmente|parcialmente|checkout parcial|venda agenciada|em atendimento|aguardando pagamento|a apurar|gerada)/, { tone: 'warning', bold: false }],
  [/^(atendid[ao]|aprovad[ao]|conclui|finalizad[ao]|servico concluido|recebid[ao]|pag[ao]|ativ[ao]|vinculad[ao]|conferid[ao]|processad[ao]|fechad[ao])/, { tone: 'success', bold: false }],
];

export function badgeStyle(label: unknown): BadgeStyle {
  const value = normalize(label);
  for (const [pattern, style] of TONES) if (pattern.test(value)) return style;
  return { tone: 'neutral', bold: false };
}

export function badgeClass(label: unknown) {
  const { tone, bold } = badgeStyle(label);
  return `status-badge status-${tone}${bold ? ' is-bold' : ''}`;
}

// ---- Dates (local calendar dates as YYYY-MM-DD strings; never Date arithmetic on time zones) ----
export type IsoDate = string;
const pad = (value: number) => String(value).padStart(2, '0');
export const isoDate = (year: number, month: number, day: number): IsoDate => `${year}-${pad(month)}-${pad(day)}`;
export function parseIso(value: IsoDate): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return [year, month, day];
}
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
// 0 = domingo … 6 = sábado
export const weekday = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();
export function addDays(value: IsoDate, amount: number): IsoDate {
  const parts = parseIso(value);
  if (!parts) throw new Error('INVALID_DATE');
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + amount));
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}
export function brDate(value: IsoDate) {
  const parts = parseIso(value);
  return parts ? `${pad(parts[2])}/${pad(parts[1])}/${parts[0]}` : '';
}
export function parseBrDate(value: string): IsoDate | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const iso = isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  return parseIso(iso) ? iso : null;
}

export type PeriodPreset = 'hoje' | 'esta-semana' | 'semana-passada' | 'este-mes' | 'mes-passado';
export const PERIOD_PRESETS: readonly { id: PeriodPreset | 'selecionar-mes' | 'customizado'; label: string }[] = [
  { id: 'hoje', label: 'Hoje' }, { id: 'esta-semana', label: 'Esta semana' }, { id: 'semana-passada', label: 'Semana passada' },
  { id: 'este-mes', label: 'Este mês' }, { id: 'mes-passado', label: 'Mês passado' }, { id: 'selecionar-mes', label: 'Selecionar mês' },
  { id: 'customizado', label: 'Período customizado' },
];

// Origin weeks start on Sunday (calendar header "Dom Seg Ter Qua Qui Sex Sab").
export function presetRange(preset: PeriodPreset, today: IsoDate): { from: IsoDate; to: IsoDate } {
  const parts = parseIso(today);
  if (!parts) throw new Error('INVALID_DATE');
  const [year, month, day] = parts;
  const sunday = addDays(today, -weekday(year, month, day));
  if (preset === 'hoje') return { from: today, to: today };
  if (preset === 'esta-semana') return { from: sunday, to: addDays(sunday, 6) };
  if (preset === 'semana-passada') return { from: addDays(sunday, -7), to: addDays(sunday, -1) };
  if (preset === 'este-mes') return { from: isoDate(year, month, 1), to: isoDate(year, month, daysInMonth(year, month)) };
  const previousYear = month === 1 ? year - 1 : year, previousMonth = month === 1 ? 12 : month - 1;
  return { from: isoDate(previousYear, previousMonth, 1), to: isoDate(previousYear, previousMonth, daysInMonth(previousYear, previousMonth)) };
}
export function monthRange(year: number, month: number) { return { from: isoDate(year, month, 1), to: isoDate(year, month, daysInMonth(year, month)) }; }
export function matchingPreset(from: IsoDate, to: IsoDate, today: IsoDate): PeriodPreset | null {
  for (const preset of ['hoje', 'esta-semana', 'semana-passada', 'este-mes', 'mes-passado'] as const) {
    const range = presetRange(preset, today);
    if (range.from === from && range.to === to) return preset;
  }
  return null;
}
// Chip text, e.g. "Data do pedido: 19/09/2026 até 19/10/2026"; Origin shows the preset name when it matches.
export function periodLabel(from: IsoDate | '', to: IsoDate | '', today: IsoDate, prefix?: string) {
  if (!from && !to) return prefix ? `${prefix}: todo o período` : 'Todo o período';
  const preset = from && to ? matchingPreset(from, to, today) : null;
  const text = preset && (preset === 'hoje' || preset === 'este-mes') ? PERIOD_PRESETS.find(item => item.id === preset)!.label : `${from ? brDate(from) : '…'} até ${to ? brDate(to) : '…'}`;
  return prefix ? `${prefix}: ${text}` : text;
}

// Calendar month grid with leading/trailing days (always 6 weeks), like Origin's datepicker.
export function monthGrid(year: number, month: number): { date: IsoDate; day: number; inMonth: boolean }[] {
  const first = isoDate(year, month, 1);
  const start = addDays(first, -weekday(year, month, 1));
  return Array.from({ length: 42 }, (_, index) => { const date = addDays(start, index); const parts = parseIso(date)!; return { date, day: parts[2], inMonth: parts[1] === month }; });
}
export const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'] as const;
export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'] as const;

// Datepicker views (Origin uses the day/month/year/decade/century picker): clicking the title goes one level up.
export type CalendarLevel = 'days' | 'months' | 'years' | 'decades' | 'centuries';
export type CalendarCell = { label: string; year: number; month?: number; level: CalendarLevel; outside: boolean; current: boolean };
export const CALENDAR_UP: Record<CalendarLevel, CalendarLevel> = { days: 'months', months: 'years', years: 'decades', decades: 'centuries', centuries: 'centuries' };
/** Arrow step of each view, in months. */
export const CALENDAR_STEP: Record<CalendarLevel, number> = { days: 1, months: 12, years: 120, decades: 1200, centuries: 12000 };
export const CALENDAR_PREVIOUS: Record<CalendarLevel, string> = { days: 'Mês anterior', months: 'Ano anterior', years: 'Década anterior', decades: 'Século anterior', centuries: 'Milênio anterior' };
export const CALENDAR_NEXT: Record<CalendarLevel, string> = { days: 'Próximo mês', months: 'Próximo ano', years: 'Próxima década', decades: 'Próximo século', centuries: 'Próximo milênio' };
export function calendarHeading(level: CalendarLevel, year: number, month: number): string {
  if (level === 'days') return `${MONTHS[month - 1]} ${year}`;
  if (level === 'months') return String(year);
  const span = level === 'years' ? 10 : level === 'decades' ? 100 : 1000, start = Math.floor(year / span) * span;
  return `${start}-${start + span - 1}`;
}
/** Cells of the month, year, decade and century views; choosing one opens the level below on that period. */
export function calendarCells(level: Exclude<CalendarLevel, 'days'>, year: number, month: number): CalendarCell[] {
  if (level === 'months') return MONTHS.map((name, index) => ({ label: name.slice(0, 3), year, month: index + 1, level: 'days', outside: false, current: index + 1 === month }));
  const span = level === 'years' ? 1 : level === 'decades' ? 10 : 100, start = Math.floor(year / (span * 10)) * span * 10;
  const below: CalendarLevel = level === 'years' ? 'months' : level === 'decades' ? 'years' : 'decades';
  return Array.from({ length: 12 }, (_, index) => {
    const first = start + (index - 1) * span;
    return { label: String(first), year: span === 1 ? first : first + (year % span), month, level: below, outside: index === 0 || index === 11, current: first === Math.floor(year / span) * span };
  });
}

// ---- Pagination "Primeira · Anterior · 4 3 2 1 · Próxima · Última  1 - 100 de 322" ----
export function pageWindow(page: number, pages: number, size = 10): number[] {
  const total = Math.max(1, pages);
  const current = Math.min(total, Math.max(1, page));
  let start = Math.max(1, current - Math.floor(size / 2));
  const end = Math.min(total, start + size - 1);
  start = Math.max(1, end - size + 1);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
export function rangeLabel(page: number, size: number, total: number) {
  if (total <= 0) return '0 registros';
  const first = (page - 1) * size + 1;
  return `${first} - ${Math.min(total, page * size)} de ${total}`;
}

// ---- Row selection: plain click toggles, Shift+click selects the range from the last toggled row ----
export function selectRange(ids: readonly string[], selected: ReadonlySet<string>, anchor: string | null, target: string, shift: boolean): { selected: Set<string>; anchor: string } {
  const next = new Set(selected);
  const targetIndex = ids.indexOf(target);
  const anchorIndex = anchor ? ids.indexOf(anchor) : -1;
  if (shift && anchorIndex >= 0 && targetIndex >= 0) {
    const [from, to] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    const value = next.has(anchor!);
    for (let index = from; index <= to; index++) value ? next.add(ids[index]!) : next.delete(ids[index]!);
    return { selected: next, anchor: target };
  }
  next.has(target) ? next.delete(target) : next.add(target);
  return { selected: next, anchor: target };
}

// Ctrl/Cmd + click or middle click opens the record in a new tab, like Origin's list rows.
export function opensInNewTab(event: { ctrlKey?: boolean; metaKey?: boolean; button?: number }) {
  return Boolean(event.ctrlKey || event.metaKey || event.button === 1);
}
