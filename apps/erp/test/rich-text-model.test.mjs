import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRuns, cssColor, emptyRichText, formatBlocks, formatRange, normalizeRichText, rangeHas, richFromDom, richTextPlain, PLAIN } from '../src/lib/rich-text-model.ts';

// 202610200270 (synthetic text only): the pure operations of the texto rico editor and the reading of any DOM into the closed structure.
const run = (text, extra = {}) => ({ text, ...PLAIN, ...extra });
const doc = (...blocks) => ({ version: 1, blocks: blocks.map(runs => ({ align: 'left', indent: 0, code: false, runs })) });
// A tiny DOM: elements with nodeName/style/attributes and text nodes; enough for richFromDom.
const t = value => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] });
const el = (name, children = [], style = {}, attributes = {}) => ({ nodeType: 1, nodeName: name, style, childNodes: children, getAttribute: key => attributes[key] ?? null });

test('formatRange: splits the runs at the selection, merges equal neighbours and toggles off when everything already has it', () => {
  const base = doc([run('Instalação no local')]);
  const bold = formatRange(base, { block: 0, offset: 0 }, { block: 0, offset: 10 }, { bold: true });
  assert.deepEqual(bold.blocks[0].runs.map(r => [r.text, r.bold]), [['Instalação', true], [' no local', false]]);
  assert.equal(rangeHas(bold, { block: 0, offset: 2 }, { block: 0, offset: 5 }, 'bold'), true);
  const off = formatRange(bold, { block: 0, offset: 0 }, { block: 0, offset: 10 }, { bold: true });
  assert.deepEqual(off.blocks[0].runs.map(r => [r.text, r.bold]), [['Instalação no local', false]], 'toggled off and merged back');
  // Across blocks, with the selection given backwards.
  const two = doc([run('Primeira')], [run('Segunda linha')]);
  const colored = formatRange(two, { block: 1, offset: 7 }, { block: 0, offset: 4 }, { color: '#c92a2a', size: 14 });
  assert.deepEqual(colored.blocks.map(b => b.runs.map(r => [r.text, r.color, r.size])), [[['Prim', null, null], ['eira', '#c92a2a', 14]], [['Segunda', '#c92a2a', 14], [' linha', null, null]]]);
  assert.equal(formatRange(two, { block: 0, offset: 3 }, { block: 0, offset: 3 }, { bold: true }), two, 'a collapsed selection changes nothing');
  assert.doesNotThrow(() => normalizeRichText(colored));
});

test('formatBlocks: alignment, indent between 0 and 5 and Código for every block of the selection', () => {
  const base = doc([run('a')], [run('b')], [run('c')]);
  const centered = formatBlocks(base, { block: 0, offset: 0 }, { block: 1, offset: 1 }, { align: 'center' });
  assert.deepEqual(centered.blocks.map(b => b.align), ['center', 'center', 'left']);
  let indented = base; for (let i = 0; i < 7; i++) indented = formatBlocks(indented, { block: 2, offset: 0 }, { block: 2, offset: 0 }, { indent: 1 });
  assert.equal(indented.blocks[2].indent, 5);
  assert.equal(formatBlocks(indented, { block: 2, offset: 0 }, { block: 2, offset: 0 }, { indent: -1 }).blocks[2].indent, 4);
  const code = formatBlocks(base, { block: 0, offset: 0 }, { block: 1, offset: 0 }, { code: 'toggle' });
  assert.deepEqual(code.blocks.map(b => b.code), [true, true, false]);
  assert.deepEqual(formatBlocks(code, { block: 0, offset: 0 }, { block: 1, offset: 0 }, { code: 'toggle' }).blocks.map(b => b.code), [false, false, false]);
});

test('richFromDom: any DOM becomes blocks and runs; scripts, images and attributes never pass', () => {
  const root = el('DIV', [
    t('Texto solto'),
    el('DIV', [el('B', [t('Negrito')]), t(' e '), el('SPAN', [t('cor')], { color: 'rgb(201, 42, 42)', backgroundColor: 'rgb(255, 255, 0)', fontSize: '14pt' })], { textAlign: 'center' }),
    el('DIV', [el('I', [t('itálico')]), el('BR'), el('U', [t('sublinhado')])], {}, { 'data-indent': '2' }),
    el('SCRIPT', [t('alert(1)')]), el('IMG', [], {}, { src: 'x' }),
    el('PRE', [t('codigo()')]), el('FONT', [t('antigo')], {}, { color: '#0a0' }), el('SPAN', [t('tamanho 13')], { fontSize: '13pt', fontWeight: '700' }),
    el('DIV', [t('linha\ncom quebra\tetab')]),
  ]);
  const read = richFromDom(root);
  assert.doesNotThrow(() => normalizeRichText(read));
  assert.equal(richTextPlain(read), 'Texto solto\nNegrito e cor\nitálico\nsublinhado\ncodigo()\nantigotamanho 13\nlinha com quebra etab');
  const center = read.blocks[1];
  assert.equal(center.align, 'center');
  assert.deepEqual(center.runs.map(r => [r.text, r.bold, r.color, r.background, r.size]), [['Negrito', true, null, null, null], [' e ', false, null, null, null], ['cor', false, '#c92a2a', '#ffff00', 14]]);
  assert.deepEqual([read.blocks[2].indent, read.blocks[2].runs[0].italic, read.blocks[3].indent, read.blocks[3].runs[0].underline], [2, true, 2, true], 'the <br> keeps the block format');
  assert.equal(read.blocks[4].code, true);
  assert.equal(read.blocks[5].runs[0].color, '#00aa00');
  assert.deepEqual([read.blocks[5].runs[1].size, read.blocks[5].runs[1].bold], [null, true], 'inline FONT and SPAN stay in the block; 13pt is not a Origin size');
  assert.doesNotMatch(JSON.stringify(read), /alert|src|script/i);
  assert.deepEqual(richFromDom(el('DIV', [])), emptyRichText());
});

test('cssColor and compactRuns', () => {
  assert.deepEqual([cssColor('#ABC'), cssColor('rgb(0, 128, 255)'), cssColor('rgba(0,0,0,0)'), cssColor('red'), cssColor(' #0a0b0c ')], ['#aabbcc', '#0080ff', null, null, '#0a0b0c']);
  assert.deepEqual(compactRuns([run('a'), run(''), run('b'), run('c', { bold: true })]).map(r => r.text), ['ab', 'c']);
});
