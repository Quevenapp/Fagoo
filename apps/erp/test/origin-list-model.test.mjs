import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeClass, badgeStyle, brDate, monthGrid, opensInNewTab, pageWindow, parseBrDate, periodLabel, presetRange, rangeLabel, selectRange } from '../src/lib/origin-list.ts';

test('situation labels get the Origin badge tones', () => {
  assert.deepEqual(badgeStyle('Autorizada'), { tone: 'success', bold: true });
  assert.deepEqual(badgeStyle('Vence hoje'), { tone: 'warning', bold: true });
  assert.equal(badgeStyle('Em aberto').tone, 'warning');
  assert.equal(badgeStyle('Atrasada').tone, 'overdue');
  assert.equal(badgeStyle('Emitida DANFE').tone, 'progress');
  assert.equal(badgeStyle('Registrada').tone, 'info');
  assert.equal(badgeStyle('Não vinculado').tone, 'waiting');
  assert.equal(badgeStyle('Rejeitada').tone, 'danger');
  assert.equal(badgeStyle('Rascunho').tone, 'neutral');
  assert.equal(badgeStyle('Atendido').tone, 'success');
  assert.equal(badgeStyle('Atendido parcialmente').tone, 'warning');
  assert.equal(badgeStyle('Não aprovado').tone, 'danger');
  assert.equal(badgeStyle('qualquer outro').tone, 'neutral');
  assert.equal(badgeClass('Autorizada'), 'status-badge status-success is-bold');
});

test('period presets follow Origin (weeks start on Sunday) and chip text names the period', () => {
  const today = '2026-10-19'; // segunda-feira
  assert.deepEqual(presetRange('hoje', today), { from: today, to: today });
  assert.deepEqual(presetRange('esta-semana', today), { from: '2026-10-18', to: '2026-10-24' });
  assert.deepEqual(presetRange('semana-passada', today), { from: '2026-10-11', to: '2026-10-17' });
  assert.deepEqual(presetRange('este-mes', today), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(presetRange('mes-passado', today), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(presetRange('mes-passado', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(periodLabel('2026-09-19', '2026-10-19', today, 'Data do pedido'), 'Data do pedido: 19/09/2026 até 19/10/2026');
  assert.equal(periodLabel('2026-10-01', '2026-10-31', today), 'Este mês');
  assert.equal(periodLabel('', '', today), 'Todo o período');
});

test('dates parse and print in dd/mm/aaaa without accepting impossible days', () => {
  assert.equal(brDate('2026-02-28'), '28/02/2026');
  assert.equal(parseBrDate('29/02/2026'), null);
  assert.equal(parseBrDate('29/02/2028'), '2028-02-29');
  assert.equal(parseBrDate('1/2/2026'), null);
});

test('calendar grid has 6 weeks starting on Sunday with leading days of the previous month', () => {
  const grid = monthGrid(2026, 10);
  assert.equal(grid.length, 42);
  assert.deepEqual(grid.slice(0, 5).map(cell => [cell.day, cell.inMonth]), [[27, false], [28, false], [29, false], [30, false], [1, true]]);
  assert.equal(grid.filter(cell => cell.inMonth).length, 31);
});

test('pagination window and range label match the Origin footer', () => {
  assert.deepEqual(pageWindow(1, 4), [1, 2, 3, 4]);
  assert.deepEqual(pageWindow(20, 33, 10), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.deepEqual(pageWindow(33, 33, 10), [24, 25, 26, 27, 28, 29, 30, 31, 32, 33]);
  assert.equal(rangeLabel(1, 100, 322), '1 - 100 de 322');
  assert.equal(rangeLabel(4, 100, 322), '301 - 322 de 322');
  assert.equal(rangeLabel(1, 100, 0), '0 registros');
});

test('shift+click selects the whole range from the last toggled row; plain click toggles one', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  let state = selectRange(ids, new Set(), null, 'b', false);
  assert.deepEqual([...state.selected], ['b']);
  state = selectRange(ids, state.selected, state.anchor, 'e', true);
  assert.deepEqual([...state.selected].sort(), ['b', 'c', 'd', 'e']);
  state = selectRange(ids, state.selected, 'c', 'c', false);
  assert.deepEqual([...state.selected].sort(), ['b', 'd', 'e']);
  state = selectRange(ids, state.selected, 'c', 'a', true);
  assert.deepEqual([...state.selected].sort(), ['d', 'e'], 'range takes the anchor value (unselected) for every row');
  assert.equal(opensInNewTab({ ctrlKey: true }), true);
  assert.equal(opensInNewTab({ button: 1 }), true);
  assert.equal(opensInNewTab({ button: 0 }), false);
});
