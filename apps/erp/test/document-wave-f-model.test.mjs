import test from 'node:test';
import assert from 'node:assert/strict';
import { autoFinanceMessage } from '../src/lib/document-pricing-model.ts';
import { effectReasonText, finishNotice } from '../src/lib/pdv-model.ts';

// Documentos lane, wave F (202610200267), synthetic values only: the automatic contas a pagar of the new pedido de compra and the
// Frente de caixa effects that stay pending with the reason of the refusal.

test('autoFinanceMessage: the pedido de compra speaks of contas a pagar and of Preferências › Suprimentos', () => {
  assert.match(autoFinanceMessage({ outcome: 'done', posting_id: 'x' }, 'purchase_orders'), /^Contas a pagar lançadas automaticamente \(Preferências › Suprimentos › Automação lançamento de contas pagar ao criar novo pedido de compra\)\.$/);
  assert.equal(autoFinanceMessage({ outcome: 'skipped', reason: 'erp_document_finance_no_installments' }, 'purchase_orders'),
    'As contas a pagar não foram lançadas automaticamente: o pedido não tem parcelas; gere as parcelas e use Lançar contas.');
  assert.match(autoFinanceMessage({ outcome: 'skipped', reason: 'erp_finance_invalid_contact' }, 'purchase_orders'), /o fornecedor está inativo/);
  assert.match(autoFinanceMessage({ outcome: 'skipped', reason: 'erp_finance_access_denied' }, 'purchase_orders'), /seu perfil não lança contas/);
  assert.match(autoFinanceMessage({ outcome: 'skipped', reason: 'erp_qualquer' }, 'purchase_orders'), /confira o pedido e use Lançar contas\.$/);
  // The pedido de venda keeps its texts (default kind).
  assert.match(autoFinanceMessage({ outcome: 'done', posting_id: 'x' }), /^Contas a receber lançadas automaticamente/);
  assert.match(autoFinanceMessage({ outcome: 'skipped', reason: 'erp_finance_invalid_contact' }), /o cliente está inativo/);
  assert.equal(autoFinanceMessage(null, 'purchase_orders'), null);
});

test('finishNotice / effectReasonText: the reason of each refused effect, the profile message otherwise', () => {
  const base = { stock: 'posted', finance: 'posted', settled_cents: '1000', open_cents: '0' };
  assert.equal(finishNotice({}), '');
  assert.equal(finishNotice(base), '');
  assert.equal(finishNotice({ ...base, stock: 'pending', finance: 'pending' }), ' O estoque e as contas ficaram pendentes no pedido: o seu perfil não os lança.');
  const refused = finishNotice({ ...base, stock: 'pending', stock_reason: 'warehouse_unavailable', finance: 'pending', finance_reason: 'refused' });
  assert.match(refused, /O estoque ficou pendente no pedido \(use Lançar estoque\): Escolha um depósito ativo para lançar o estoque\./);
  assert.match(refused, /As contas ficaram pendentes no pedido \(use Lançar contas\): O lançamento foi recusado; confira o pedido\./);
  assert.match(finishNotice({ ...base, settle_reason: 'account_invalid' }), /A baixa à vista não foi feita e a parcela ficou em aberto em Contas a receber/);
  assert.equal(effectReasonText(undefined), '');
  assert.equal(effectReasonText('permission_denied'), 'Seu usuário não tem a permissão deste lançamento (Sistema › Usuários › Permissões).');
});

test('storedZip: a stored ZIP with CRC-32, UTF-8 names, unique names and the São Paulo time; limits', async () => {
  const { storedZip, zipNames, crc32, ZIP_MAX_FILES } = await import('../src/lib/zip-store.ts');
  const { crc32: nodeCrc } = await import('node:zlib');
  const enc = new TextEncoder(), files = [{ name: 'contrato.pdf', data: enc.encode('%PDF sintético'), modified: new Date('2026-10-20T15:30:10Z') },
    { name: 'contrato.pdf', data: enc.encode('outro'), modified: new Date('2026-10-20T15:30:10Z') }, { name: 'pasta/ação.txt', data: new Uint8Array(0), modified: new Date('2026-10-20T15:30:10Z') }];
  assert.equal(crc32(files[0].data), nodeCrc(files[0].data));
  assert.deepEqual(zipNames(files.map(f => f.name)), ['contrato.pdf', 'contrato (2).pdf', 'pasta_ação.txt']);
  const zip = storedZip(files), view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50); assert.equal(view.getUint16(end + 10, true), 3);
  let at = view.getUint32(end + 16, true); const read = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50); assert.equal(view.getUint16(at + 8, true) & 0x0800, 0x0800, 'UTF-8 names');
    const length = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true), size = view.getUint32(at + 24, true), crc = view.getUint32(at + 16, true);
    const name = new TextDecoder().decode(zip.slice(at + 46, at + 46 + length));
    const dataAt = local + 30 + view.getUint16(local + 26, true), data = zip.slice(dataAt, dataAt + size);
    assert.equal(view.getUint32(local, true), 0x04034b50); assert.equal(crc, nodeCrc(data));
    // 15:30:10 UTC is 12:30:10 in São Paulo: DOS time 12<<11 | 30<<5 | 5.
    assert.equal(view.getUint16(at + 12, true), (12 << 11) | (30 << 5) | 5); assert.equal(view.getUint16(at + 14, true), ((2026 - 1980) << 9) | (10 << 5) | 20);
    read.push([name, new TextDecoder().decode(data)]); at += 46 + length;
  }
  assert.deepEqual(read, [['contrato.pdf', '%PDF sintético'], ['contrato (2).pdf', 'outro'], ['pasta_ação.txt', '']]);
  assert.throws(() => storedZip([]), /ZIP_ENTRIES_INVALID/);
  assert.throws(() => storedZip(Array.from({ length: ZIP_MAX_FILES + 1 }, () => files[1])), /ZIP_ENTRIES_INVALID/);
});

test('readCopyPreview: an OS saved before the groups is copied with each line in the group of its product type (review of wave F)', async () => {
  const { normalizeDocument } = await import('../../../packages/erp-domain/src/index.mjs');
  const { COPY_RESET_FIELDS, readCopyPreview } = await import('../src/lib/document-copy-model.ts');
  const ids = { source: '10000000-0000-4000-8000-0000000000a1', contact: '20000000-0000-4000-8000-0000000000a1', part: '50000000-0000-4000-8000-0000000000a1', service: '50000000-0000-4000-8000-0000000000a2' };
  const line = (id, product, description) => ({ id, product_id: product, description, code: null, unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0', detailed_description: null });
  const lines = [line('40000000-0000-4000-8000-0000000000a1', ids.part, 'Peça sintética'), line('40000000-0000-4000-8000-0000000000a2', ids.service, 'Serviço sintético'), line('40000000-0000-4000-8000-0000000000a3', null, 'Item livre sintético')];
  const normalized = normalizeDocument('service_orders', { date: '2026-10-16', contact_id: ids.contact, items: lines });
  const snapshots = { [ids.part]: { kind: 'P' }, [ids.service]: { kind: 'S' } };
  const source = { ...normalized, items: normalized.items.map(item => ({ ...item, product_snapshot: item.product_id ? snapshots[item.product_id] : null })), id: ids.source, kind: 'service_orders', number: '31', version: 2, status: 'open',
    contact_snapshot: { id: ids.contact, name: 'Contato sintético' }, effect_flags: { finance_active: false, stock_active: false }, source_proposal_id: null, created_at: '2026-10-16T07:00:00Z', updated_at: '2026-10-16T07:00:00Z' };
  const data = { date: '2026-10-17', contact_id: ids.contact, warehouse_id: null, items: lines.map(item => ({ ...item, id: null })), installments: [], template: false, discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0' };
  for (const key of COPY_RESET_FIELDS) if (!['date', 'installments', 'template'].includes(key)) data[key] = null;
  const preview = { source: { id: ids.source, kind: 'service_orders', number: '31', version: 2 }, data, reset_fields: [...COPY_RESET_FIELDS], persisted: false, data_mode: 'erp_native', operational_effects: false };
  const read = readCopyPreview(structuredClone(preview), source);
  assert.deepEqual(read.data.items.map(item => [item.description, item.group, item.quote, item.done]),
    [['Peça sintética', 'part', false, false], ['Serviço sintético', 'service', false, false], ['Item livre sintético', 'part', false, false]]);
  // A source that already has the groups keeps them, Orçar and OK included.
  const grouped = structuredClone(preview); grouped.data.items = grouped.data.items.map((item, index) => ({ ...item, group: index === 1 ? 'service' : 'part', quote: index === 1, done: false }));
  assert.deepEqual(readCopyPreview(grouped, source).data.items.map(item => [item.group, item.quote]), [['part', false], ['service', true], ['part', false]]);
  // Other kinds are not touched.
  const proposal = { ...source, kind: 'sales_proposals' }, plain = structuredClone(preview); plain.source.kind = 'sales_proposals';
  assert.equal(readCopyPreview(plain, proposal).data.items.some(item => Object.hasOwn(item, 'group')), false);
});
