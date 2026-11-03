import { useEffect, useState } from 'react';
import { brDate, parseBrDate, presetRange, type IsoDate, type PeriodPreset } from '../lib/origin-list';
import { PERIOD_TYPES, type ContactListPeriod, type ContactPeriodField } from '../lib/contact-list-model';
import { CalendarMonth } from './OriginList';
import { Icon } from './Icon';

// Popover "Abrir períodos" da listagem de contatos (Origin CL-03): abas Prox. Visita | Sem compras no período, Início do
// período, Fim do período só em Período customizado e os atalhos Hoje, Esta semana, Semana passada, Este mês, Mês
// passado e Período customizado. As outras listagens continuam com o PeriodPicker comum.
const PRESETS: readonly { id: PeriodPreset | 'customizado'; label: string }[] = [{ id: 'hoje', label: 'Hoje' }, { id: 'esta-semana', label: 'Esta semana' },
  { id: 'semana-passada', label: 'Semana passada' }, { id: 'este-mes', label: 'Este mês' }, { id: 'mes-passado', label: 'Mês passado' }, { id: 'customizado', label: 'Período customizado' }];
const presetOf = (from: string, to: string, today: IsoDate) => from && to ? (PRESETS.find(p => p.id !== 'customizado' && presetRange(p.id as PeriodPreset, today).from === from && presetRange(p.id as PeriodPreset, today).to === to)?.id ?? 'customizado') : 'hoje';

export function periodChip(period: ContactListPeriod) {
  const label = PERIOD_TYPES.find(type => type.value === period.field)!.label;
  return `${label}: ${period.from ? brDate(period.from) : '…'} até ${period.to ? brDate(period.to) : '…'}`;
}

export function ContactPeriodPicker({ period, today, onApply }: { period: ContactListPeriod; today: IsoDate; onApply: (period: ContactListPeriod) => void }) {
  const [open, setOpen] = useState(false), [field, setField] = useState<ContactPeriodField>(period.field);
  const [mode, setMode] = useState<PeriodPreset | 'customizado'>('hoje'), [from, setFrom] = useState(''), [to, setTo] = useState(''), [fromText, setFromText] = useState(''), [toText, setToText] = useState('');
  const pick = (id: PeriodPreset | 'customizado', start = from, end = to) => {
    setMode(id);
    if (id !== 'customizado') { const range = presetRange(id, today); setFrom(range.from); setTo(range.to); setFromText(brDate(range.from)); setToText(brDate(range.to)); }
    else { setFrom(start); setTo(end); setFromText(start ? brDate(start) : ''); setToText(end ? brDate(end) : ''); }
  };
  useEffect(() => { if (!open) return; setField(period.field); const preset = presetOf(period.from, period.to, today); pick(preset, period.from, period.to); }, [open]);
  const custom = mode === 'customizado';
  // Outside "Período customizado" the start defines the preset day; the end follows the preset.
  const typed = (text: string, which: 'from' | 'to') => {
    if (which === 'from') setFromText(text); else setToText(text);
    const parsed = parseBrDate(text); if (parsed) (which === 'from' ? setFrom : setTo)(parsed); if (!text.trim()) (which === 'from' ? setFrom : setTo)('');
    setMode('customizado');
  };
  const apply = () => { const [a, b] = from && to && from > to ? [to, from] : [from, to]; onApply({ field, from: a, to: b }); setOpen(false); };
  const label = period.from || period.to ? periodChip(period) : 'Todo o período';
  return <span className="origin-period contact-period">
    <button type="button" className="origin-period-chip" title="Abrir períodos" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="calendar-days" size={12} /><span>{label}</span></button>
    {open && <><button type="button" className="origin-click-catcher" tabIndex={-1} aria-label="Fechar períodos" onClick={() => setOpen(false)} /><div className="origin-period-popover" role="dialog" aria-label="Período">
      <div className="contact-period-tabs" role="tablist">{PERIOD_TYPES.map(type => <button type="button" role="tab" key={type.value} aria-selected={field === type.value} className={field === type.value ? 'active' : undefined} onClick={() => setField(type.value)}>{type.label}</button>)}</div>
      <div className="origin-period-body">
        <div className="origin-period-side"><label>Início do período<input id="contact-period-from" inputMode="numeric" placeholder="dd/mm/aaaa" value={fromText} onChange={event => typed(event.target.value, 'from')} /></label>
          <CalendarMonth title="Início do período" value={from} from={from} to={to} today={today} onPick={date => pick('customizado', date, custom ? (to && to < date ? date : to) : date)} /></div>
        {custom && <div className="origin-period-side"><label>Fim do período<input id="contact-period-to" inputMode="numeric" placeholder="dd/mm/aaaa" value={toText} onChange={event => typed(event.target.value, 'to')} /></label>
          <CalendarMonth title="Fim do período" value={to} from={from} to={to} today={today} onPick={date => pick('customizado', from && from > date ? date : from, date)} /></div>}
        <ul className="origin-period-presets">{PRESETS.map(preset => <li key={preset.id}><button type="button" className={mode === preset.id ? 'active' : ''} aria-pressed={mode === preset.id} onClick={() => pick(preset.id)}>{preset.label}</button></li>)}</ul>
      </div>
      <div className="origin-period-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancelar</button><button type="button" className="primary-button" disabled={!from && !to} onClick={apply}>Filtrar</button></div>
    </div></>}
  </span>;
}
