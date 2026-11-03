import test from 'node:test'; import assert from 'node:assert/strict'; import { randomUUID } from 'node:crypto';
import { financeiroHFixture, fails } from './helpers/financeiro-h-fixture.mjs';

// Leva H, lane financeiro (370: VND-117, PRF-124, VND-310, VND-264): comissão estimada na confirmação comercial, com regra, base e
// percentual congelados na operação, elegível pelo recebimento e ajustada por devolução e cancelamento. Synthetic data only.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
async function setup() {
  const f = await financeiroHFixture();
  const client = (await f.catalog('contacts', { name: 'Cliente Sintético' })).id, sellerContact = (await f.catalog('contacts', { name: 'Vendedora Sintética' })).id;
  const seller = (await f.rpc('erp_catalog_seller_from_contact', { p_user_id: f.users.admin, p_command_id: randomUUID(), p_contact_id: sellerContact })).seller.id;
  await f.db.query("update erp_catalog.seller set commission_rule='parcial',commission_mode='fixa',commission_rate=5 where id=$1", [seller]);
  await f.preference('vendas-propostas', 'propostas.exibir_ipi_st', true);
  const account = (await f.rpc('erp_finance_account_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa sintético', start_on: '2020-01-01', opening_cents: '0' } })).record;
  // Itens 600 + 400, desconto do pedido 100, frete 50, IPI 20 e ICMS ST 10: total 980.
  const order = (body = {}) => f.document('sales_orders', { contact: client, date: today, body: { seller_id: seller, discount_mode: 'amount', discount_value: '100', freight: '50', tax_ipi: '20', tax_icms_st: '10',
    installments: [{ due_date: '2099-01-10', amount: '490.00' }, { due_date: '2099-02-10', amount: '490.00' }], ...body },
    items: [{ description: 'Peça A', quantity: '1', unit_price: '600' }, { description: 'Peça B', quantity: '1', unit_price: '400' }] });
  const operations = id => f.db.query('select state,rule,base_cents::text base,rate::text rate,estimated_cents::text estimated,policy from erp_finance.commission_operation where document_id=$1 order by created_at', [id]).then(r => r.rows);
  const view = async id => (await f.rpc('erp_document_commission_operation', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_document_id: id }));
  const post = async document => {
    const scope = { p_user_id: f.users.admin, p_kind: 'sales_orders', p_document_id: document.id, p_expected_version: document.version };
    const preview = await f.rpc('erp_document_finance_preview', scope);
    return f.rpc('erp_document_finance_post', { ...scope, p_command_id: randomUUID(), p_preview_hash: preview.preview.preview_hash });
  };
  const confirm = async d => f.transition(d.status === 'draft' ? await f.transition(d, 'open') : d, 'verified');
  return { f, client, seller, account, order, operations, view, post, confirm };
}

test('H 370: the estimate is frozen at the commercial confirmation, on net items after discount without frete, IPI and ICMS-ST', async () => {
  const { f, seller, order, operations, view, confirm } = await setup(); try {
    let d = await order();
    assert.deepEqual(await operations(d.id), [], 'saving is not a commercial confirmation');
    d = await confirm(d);
    let ops = await operations(d.id);
    assert.deepEqual(ops.map(o => [o.state, o.rule, o.base, o.rate, o.estimated]), [['active', 'parcial', '90000', '5.000000', '4500']]);
    assert.deepEqual(ops[0].policy, { version: 1, base: 'itens_liquidos', release: 'regra_do_vendedor', additions: ['desconto'] });
    // The seller's rate changes later: the confirmed operation keeps 5%.
    await f.db.query('update erp_catalog.seller set commission_rate=10 where id=$1', [seller]);
    d = await f.transition(d, 'in_progress');
    assert.deepEqual((await operations(d.id)).map(o => [o.state, o.estimated]), [['active', '4500']]);
    await fails(assert, () => f.db.query("update erp_finance.commission_operation set rate=10 where document_id=$1", [d.id]), '55000');
    // Undoing the confirmation ends the operation; confirming again freezes a new one with the rate in force then. One active operation.
    d = await f.transition(d, 'open'); d = await f.transition(d, 'verified');
    assert.deepEqual((await operations(d.id)).map(o => [o.state, o.estimated]), [['superseded', '4500'], ['active', '9000']]);
    const shown = await view(d.id);
    assert.deepEqual([shown.operation.estimated_cents, shown.operation.eligible_cents, shown.operation.rate], ['9000', '0', '10.0000']);
    assert.deepEqual(shown.items.map(i => [i.position, i.item_cents, i.base_cents, i.commission_cents]), [[1, '60000', '54000', '5400'], [2, '40000', '36000', '3600']]);
    // Política with Frete, IPI and ICMS ST marked: only new operations use it.
    await f.preference('vendas-vendas', 'vendas.base_comissao', ['desconto', 'frete', 'icms_st', 'ipi']);
    const other = await confirm(await order({}));
    assert.equal((await operations(other.id))[0].base, '98000');
    assert.equal((await operations(d.id)).at(-1).base, '90000');
    const tab = await f.rpc('erp_document_seller_commission', { p_user_id: f.users.admin, p_kind: 'sales_orders', p_seller_id: seller });
    assert.deepEqual(tab.additions, ['desconto', 'frete', 'icms_st', 'ipi']);
  } finally { await f.close(); }
});

test('H 370: eligible pro rata to the receipt, adjusted by a returned conta and by a cancelled sale; the report shows estimated, eligible, paid and adjusted', async () => {
  const { f, seller, account, order, operations, view, post, confirm } = await setup(); try {
    let d = await confirm(await order());
    const posted = await post(d);
    // The parcelas of the ledger (171) read the frozen base: 450 + 450, commission 22,50 each.
    const rows = (await f.db.query('select base_cents::text base,commission_cents::text c from erp_finance.commission where document_id=$1 order by position', [d.id])).rows;
    assert.deepEqual(rows.map(r => [r.base, r.c]), [['45000', '2250'], ['45000', '2250']]);
    await f.rpc('erp_finance_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'settle', p_data: { id: posted.titles[0].id, expected_version: 1, account_id: account.id, posted_on: today, principal_cents: '49000' } });
    let v = (await view(d.id)).operation;
    assert.deepEqual([v.estimated_cents, v.received_cents, v.eligible_cents, v.adjusted_cents], ['4500', '49000', '2250', '0'], 'half received: R$ 22,50 of R$ 45,00');
    // The second parcela is returned (281): adjustment of its share, once.
    const mark = () => f.db.query("insert into erp_finance.title_return(title_id,source,actor,command_id) values($1,$2,$3,$4) on conflict do nothing", [posted.titles[1].id, { kind: 'document_return', id: 'x', label: 'Devolução sintética' }, f.users.admin, randomUUID()]);
    await mark(); await mark();
    v = (await view(d.id)).operation;
    assert.deepEqual([v.adjusted_cents, v.net_cents, v.eligible_cents, v.adjustments.length], ['-2250', '2250', '2250', 1]);
    // Reprocessing the same confirmation keeps one operation.
    d = await f.transition({ ...d, version: await f.scalar('select version v from erp_documents.document where id=$1', [d.id]) }, 'in_progress');
    assert.equal((await operations(d.id)).filter(o => o.state === 'active').length, 1);
    // A cancelled sale is adjusted to zero.
    const c = await confirm(await order());
    await f.transition(c, 'cancelled');
    const ended = (await f.rpc('erp_finance_commission_report', { p_user_id: f.users.consulta, p_from: today, p_to: today, p_seller_id: null, p_state: 'cancelled', p_page: 1, p_limit: 100 }));
    assert.deepEqual(ended.items.map(i => [i.state, i.estimated_cents, i.adjusted_cents, i.net_cents]), [['cancelled', '4500', '-4500', '0']]);
    // A payment of the seller's statement counts as paid in the report.
    await f.rpc('erp_finance_commission_execute', { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: 'commission_payment',
      p_data: { seller_id: seller, month: `${today.slice(0, 7)}-01`, posted_on: today, account_id: account.id, amount_cents: '2250', description: 'Pagamento sintético' } });
    const report = await f.rpc('erp_finance_commission_report', { p_user_id: f.users.consulta, p_from: today, p_to: today, p_seller_id: seller, p_state: 'all', p_page: 1, p_limit: 100 });
    assert.equal(report.total, 2);
    assert.deepEqual(report.sellers.map(s => [s.name, s.operations, s.estimated_cents, s.adjusted_cents, s.eligible_cents, s.paid_cents]), [['Vendedora Sintética', 2, '9000', '-6750', '2250', '2250']]);
    assert.deepEqual(report.items.map(i => [i.document_number, i.base_cents, i.rate, i.seller_name]), [[d.number, '90000', '5.0000', 'Vendedora Sintética'], [c.number, '90000', '5.0000', 'Vendedora Sintética']]);
    await fails(assert, () => f.rpc('erp_finance_commission_report', { p_user_id: f.users.estoque, p_from: today, p_to: today, p_seller_id: null, p_state: 'all', p_page: 1, p_limit: 100 }), '42501');
    await fails(assert, () => f.rpc('erp_finance_commission_report', { p_user_id: f.users.consulta, p_from: today, p_to: '2099-01-01', p_seller_id: null, p_state: 'all', p_page: 1, p_limit: 100 }), '22023');
    // The Worker: the report and the aba Comissões, projected and checked.
    const http = await f.call(`/v1/financeiro/comissoes-relatorio?from=${today}&to=${today}&vendedor=${seller}`, 'GET', undefined, f.users.consulta);
    assert.equal(http.status, 200);
    assert.deepEqual([http.value.total, http.value.totals.eligible_cents, http.value.items[0].policy.additions], [2, '2250', ['desconto']]);
    assert.equal((await f.call(`/v1/financeiro/comissoes-relatorio?from=${today}`, 'GET', undefined, f.users.consulta)).status, 400);
    const tab = await f.call(`/v1/documentos/sales_orders/${d.id}/comissao`);
    assert.equal(tab.status, 200);
    assert.deepEqual([tab.value.operation.estimated_cents, tab.value.operation.eligible_cents, tab.value.items.length], ['4500', '2250', 2]);
    assert.equal((await f.call(`/v1/documentos/sales_orders/${c.id}/comissao`)).value.operation, null, 'the cancelled sale has no active operation');
    for (const t of ['erp_finance.commission_operation', 'erp_finance.commission_adjustment']) assert.equal(await f.scalar("select has_table_privilege('service_role',$1,'SELECT') v", [t]), false);
  } finally { await f.close(); }
});

test('H 370 refuses to replace a commission function that changed since it was written', async () => {
  const g = await financeiroHFixture({ before: '202610210370' }); try {
    await g.db.exec("create or replace function erp_finance.commission_document(p_document uuid,p_seller uuid,out base_cents bigint,out weighted numeric,out items_cents bigint,out rule text) language plpgsql stable set search_path=pg_catalog as $$ begin end $$");
    await assert.rejects(() => g.migrate('202610210370_commission_operations.sql'), e => e.code === '55000' && /previous_definition_changed/.test(e.message));
  } finally { await g.close(); }
});
