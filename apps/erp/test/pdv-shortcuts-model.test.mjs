import test from 'node:test';
import assert from 'node:assert/strict';
import { PDV_SHORTCUTS, pdvActionFor, shortcutHint } from '../src/lib/pdv-shortcuts.ts';

const key = (code, extra = {}) => ({ altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, key: '', code, ...extra });

test('Origin Frente de caixa shortcut table is complete and in Origin order', () => {
  assert.deepEqual(PDV_SHORTCUTS.map(item => `${item.label}=${item.key}`), [
    'Aba de cliente=C', 'Aba de pagamento=B', 'Aba de produto=Z', 'Pesquisa avançada=A', 'Buscar venda=P', 'Excluir=Q', 'Fechar caixa=M', 'Finalizar=S', 'Imprimir=I',
    'Nova venda=N', 'Produtos favoritos=G', 'Remover produto a partir do GTIN=R', 'Sangria=,', 'Suprimento=.', 'Trocar loja=L', 'Nova venda balcão=T', 'Nova venda mesa=V',
  ]);
  assert.equal(new Set(PDV_SHORTCUTS.map(item => item.key)).size, PDV_SHORTCUTS.length);
});

test('Alt + key triggers on Windows; Ctrl + Shift + key on macOS; plain keys never trigger', () => {
  assert.equal(pdvActionFor(key('KeyS', { altKey: true })), 'finalizar');
  assert.equal(pdvActionFor(key('KeyZ', { altKey: true, key: 'Ω' })), 'produto', 'uses the physical key when Alt changes the character');
  assert.equal(pdvActionFor(key('Comma', { altKey: true })), 'sangria');
  assert.equal(pdvActionFor(key('Period', { altKey: true })), 'suprimento');
  assert.equal(pdvActionFor(key('KeyS')), null);
  assert.equal(pdvActionFor(key('KeyS', { ctrlKey: true, altKey: true })), null);
  assert.equal(pdvActionFor(key('KeyN', { ctrlKey: true, shiftKey: true }), true), 'nova');
  assert.equal(pdvActionFor(key('KeyN', { altKey: true }), true), null);
  assert.equal(shortcutHint('S'), 'Alt+S');
  assert.equal(shortcutHint('S', true), 'Ctrl+Shift+S');
});
