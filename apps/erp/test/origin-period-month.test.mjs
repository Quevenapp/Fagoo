import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';

// Synthetic only. FIN-006: "Selecionar mês" is a Jan..Dez grid with ‹ ano › navigation, as in Origin.
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
test('period popover selects a month on the Jan..Dez grid and moves the year', async () => {
  const applied = [];
  const view = await mountComponent('OriginList.tsx', { from: '', to: '', today: '2026-10-20', onApply: range => applied.push(range) }, { componentName: 'PeriodPicker', expandChildren: ['CalendarMonth'] });
  try {
    view.find(node => node.type === 'button' && node.props.title === 'Abrir períodos').props.onClick(); await view.flush();
    await view.click('Selecionar mês');
    const months = view.nodes().filter(node => node.type === 'button' && /^[A-Z][a-zç]{2}$/.test(text(node))).map(text);
    assert.deepEqual(months, ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']);
    assert.equal(view.find(node => node.type === 'button' && node.props['aria-label'] === 'Outubro de 2026').props['aria-pressed'], true);
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Ano anterior').props.onClick(); await view.flush();
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Fevereiro de 2025').props.onClick(); await view.flush();
    await view.click('Filtrar');
    assert.deepEqual(applied, [{ from: '2025-02-01', to: '2025-02-28', dateType: undefined }]);
  } finally { view.unmount(); }
});
