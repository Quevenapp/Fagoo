import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDocument, INITIAL_STATE } from '../../../packages/erp-domain/src/index.mjs';
import { documentPrintModel, printDecimal, printMoney } from '../src/lib/document-print-model.ts';
import {normalizeCompany} from '../../../packages/erp-domain/src/company.mjs';

const id = 'a0000000-0000-4000-8000-000000000001';
function fixture(kind = 'sales_proposals', patch = {}) {
  const normalized = normalizeDocument(kind, { date: '2026-10-16', contact_id: id,
    items: [{ description: 'Produto sintético <script>não executar</script>', code: 'FICTICIO', unit: 'KG', quantity: '3', unit_price: '1.005', discount_percent: '10' }],
    discount_mode: 'percent', discount_value: '5', freight: '1.20', other_expenses: '0.30',
    installments: [{ due_date: '2026-11-01', amount: '4.08', method: 'Forma fictícia' }],
    notes: 'Observação comercial pública\nSegunda linha', internal_notes: 'INTERNAL_SECRET_MARKER',
    payment_terms: 'Condição comercial sintética', delivery_terms: 'Prazo sintético', ...patch });
  return { ...normalized, id, kind, number: '42', version: 3, status: INITIAL_STATE[kind], source_proposal_id: id,
    contact_snapshot: { id, name: 'Contato no momento do documento', document: 'DOCUMENTO FICTÍCIO', street: 'Rua de teste', number: '1', city: 'Piracicaba', state: 'SP', internal_notes: 'CONTACT_PRIVATE_MARKER' },
    items: normalized.items.map(item => ({ ...item, product_snapshot: { internal: 'PRODUCT_PRIVATE_MARKER' } })) };
}

test('print projection preserves exact rounded totals and displays decimals without Number coercion', () => {
  const model = documentPrintModel(fixture());
  assert.equal(model.items[0].quantity, '3'); assert.equal(model.items[0].price, 'R$ 1,005');
  assert.equal(model.items[0].discount, '10%'); assert.equal(model.items[0].total, 'R$ 2,72');
  assert.equal(model.totals.at(-1).value, 'R$ 4,08'); assert.equal(model.installments[0].amount, 'R$ 4,08');
  assert.equal(model.installments[0].dueDate, '01/11/2026');
  assert.equal(printDecimal('999999999.000001'), '999.999.999,000001');
  assert.equal(printMoney('999999999999.99'), 'R$ 999.999.999.999,99');
  assert.equal(printDecimal('9007199254740993.0001', 2), '9.007.199.254.740.993,0001');
  for (const value of ['NaN', 'Infinity', '1e9', '-1', '1,00']) assert.throws(() => printDecimal(value));
  assert.throws(() => printMoney('1.005'));
});

test('only saved public fields and the captured contact are printable; internal records are excluded', () => {
  const record = fixture(); const model = documentPrintModel(record), serialized = JSON.stringify(model);
  assert.equal(model.contact.name, 'Contato no momento do documento');
  assert.equal(model.contact.address, 'Rua de teste, 1'); assert.equal(model.contact.city, 'Piracicaba / SP');
  assert.match(serialized, /Observação comercial pública/);
  assert.doesNotMatch(serialized, /INTERNAL_SECRET_MARKER|CONTACT_PRIVATE_MARKER|PRODUCT_PRIVATE_MARKER|internal_notes|source_proposal_id|product_snapshot/);
  assert.equal(Object.hasOwn(model, 'id'), false);
});
test('company print projection uses current validated commercial identity, excluding CRT and private metadata',()=>{
 const company={version:2,data:normalizeCompany({legal_name:'Empresa fictícia atual',cnpj:'12ABC34501DE35',postal_code:'13400000',street:'Rua QA',number:'S/N',district:'Bairro QA',city:'Piracicaba',municipality_code:'3538709',state:'SP'}),crt:'PRIVATE_CRT_MARKER',confirmed_by:'PRIVATE_ACTOR_MARKER'};
 const model=documentPrintModel(fixture(),company);assert.equal(model.company.legalName,'Empresa fictícia atual');assert.equal(model.company.version,2);assert.equal(model.company.cnpj,'12ABC34501DE35');
 assert.doesNotMatch(JSON.stringify(model),/PRIVATE_CRT|PRIVATE_ACTOR|confirmed_by|municipality_code/);assert.equal(documentPrintModel(fixture()).company,null);
 assert.throws(()=>documentPrintModel(fixture(),{...company,data:{...company.data,cnpj:'INVALID'}}));
});

test('print fails closed for divergent stored totals or lines instead of silently printing inconsistent values', () => {
  const record = fixture(); record.totals.total = '999.99';
  assert.throws(() => documentPrintModel(record), /PRINT_TOTAL_MISMATCH/);
  const changed = fixture(); changed.items[0].total = '0.00';
  assert.throws(() => documentPrintModel(changed), /PRINT_LINE_MISMATCH/);
});

test('all four commercial types have explicit titles, OS can omit items, cancelled and template states remain visible', () => {
  for (const [kind, title] of [['sales_proposals', 'Proposta comercial / orçamento'], ['sales_orders', 'Pedido de venda'], ['purchase_orders', 'Pedido de compra'], ['service_orders', 'Ordem de serviço']]) {
    const model = documentPrintModel(fixture(kind)); assert.equal(model.title, title);
    assert.equal(model.contactLabel, kind === 'purchase_orders' ? 'Fornecedor' : 'Cliente');
  }
  const service = documentPrintModel(fixture('service_orders', { items: [], installments: [], freight: '0', other_expenses: '0', discount_value: '0', equipment: 'Equipamento fictício', defect: 'Relato público', solution: 'Solução pública' }));
  assert.equal(service.items.length, 0); assert.equal(service.totals.at(-1).value, 'R$ 0,00'); assert.equal(service.service.defect, 'Relato público');
  assert.equal(documentPrintModel({ ...fixture(), status: 'cancelled' }).cancelled, true);
  assert.equal(documentPrintModel(fixture('sales_proposals', { template: true })).template, true);
});

test('long documents retain every item and installment for print pagination', () => {
  const record = fixture('sales_orders', {
    items: Array.from({ length: 250 }, (_, index) => ({ description: `Item sintético ${index + 1} ${'descrição longa '.repeat(10)}`, unit: 'UN', quantity: '0.000001', unit_price: '9999999999.9999', discount_percent: '0' })),
    installments: Array.from({ length: 100 }, (_, index) => ({ due_date: '2026-11-01', amount: '25000.00', method: `Parcela fictícia ${index + 1}` })),
    discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0',
  });
  const model = documentPrintModel(record);
  assert.equal(model.items.length, 250); assert.equal(model.items.at(-1).position, 250);
  assert.equal(model.items.at(-1).quantity, '0,000001'); assert.equal(model.items.at(-1).price, 'R$ 9.999.999.999,9999');
  assert.equal(model.installments.length, 100); assert.equal(model.installments.at(-1).position, 100);
  assert.equal(model.totals.at(-1).value, 'R$ 2.500.000,00');
});
