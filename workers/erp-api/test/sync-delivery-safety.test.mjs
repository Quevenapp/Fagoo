import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OriginWriter, sendItem, pushOutbox, runOriginTwoWay } from '../src/origin-two-way.mjs';
import { originTwoWayFixture } from './helpers/origin-two-way-fixture.mjs';

const writer = fetchImpl => new OriginWriter('synthetic', { apiOrigin: 'https://api.provider.example', fetchImpl, intervalMs: 0, sleep: async () => {} });
const item = { id: 1, token: 'claim', entity: 'contacts', requests: [{ method: 'POST', path: '/contatos', body: { nome: 'Synthetic' } }] };
const ok = body => new Response(JSON.stringify(body), { status: 201 });

test('a lost mutation response, 5xx, timeout or unreadable success is never replayed', async () => {
  for (const failure of [() => { throw new Error('connection lost'); }, () => new Response('upstream error', { status: 503 }),
    () => new Response('', { status: 408 }), () => new Response('broken json', { status: 201 }),
    () => ({ status: 201, ok: true, text: async () => { throw new Error('stream lost'); } })]) {
    let calls = 0;
    const result = await sendItem(item, { writer: writer(async () => { calls++; return failure(); }), rpc: async () => {} });
    assert.equal(calls, 1);
    assert.equal(result.code, 'ORIGIN_WRITE_UNCONFIRMED');
    assert.equal(result.retry, false);
  }
});

test('a partial create preserves the ID and cannot be retried as a new create', async () => {
  let calls = 0;
  const result = await sendItem({ ...item, requests: [...item.requests, { method: 'PATCH', path: '/contatos/{id}/situacoes', body: { situacao: 'I' } }] },
    { writer: writer(async () => ++calls === 1 ? ok({ data: { id: 7733 } }) : new Response('{}', { status: 404 })), rpc: async () => {} });
  assert.equal(result.code, 'ORIGIN_PARTIAL_WRITE_REVIEW');
  assert.equal(result.origin_id, '7733');
  assert.equal(result.retry, false);
});

test('failure to stage a reread cannot turn a successful mutation into a replay', async () => {
  const result = await sendItem({ ...item, fetch: '/contatos/{id}' }, { writer: writer(async () => ok({ data: { id: 7733, nome: 'Synthetic' } })),
    rpc: async () => { throw new Error('database unavailable'); } });
  assert.equal(result.ok, true);
  assert.equal(result.origin_id, '7733');
});

test('each result is acknowledged before the next claim; an ack failure stops writes', async () => {
  const seen = []; let mutations = 0;
  await assert.rejects(pushOutbox({ writer: writer(async () => { mutations++; return ok({ data: { id: 7733 } }); }), deadline: Infinity, stats: {},
    rpc: async (name, args) => { seen.push(name); if (name === 'erp_sync_claim') { assert.equal(args.p_limit, 1); return [item]; } throw new Error('ack unavailable'); }
  }), /ack unavailable/);
  assert.equal(mutations, 1);
  assert.deepEqual(seen, ['erp_sync_claim', 'erp_sync_ack']);
});

test('receive-only never creates a writer or claims outgoing changes', async () => {
  const calls = [];
  const result = await runOriginTwoWay({ env: { ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true', ORIGIN_WRITE_ENABLED: 'false' },
    rpc: async name => { calls.push(name); return { state: 'ready', processed: 0 }; },
    writerFactory: async () => { assert.fail('writer must not be created'); } });
  assert.equal(result.state, 'receive_only');
  assert.deepEqual(calls, ['erp_sync_pull']);
});

let fixture;
after(async () => { await fixture?.close(); });
test('expired delivery and partial writes stay quarantined across sync requests, edits and inbound supersession', async () => {
  fixture = await originTwoWayFixture();
  const f = fixture;
  const contact = await f.catalog('contacts', { name: 'Delivery test', person_type: 'J' });
  const claimed = await f.claim();
  assert.equal(claimed.length, 1);
  await f.db.query("update erp_sync.outbox set claimed_at=now()-interval '11 minutes' where id=$1", [claimed[0].id]);
  assert.deepEqual(await f.claim(), []);
  assert.equal((await f.outbox())[0].review_required, true);
  await f.rpc('erp_sync_request', { p_user_id: f.users.admin });
  assert.deepEqual(await f.claim(), []);
  await f.db.query("select erp_sync.enqueue('contacts',$1,'upsert')", [contact.id]);
  assert.deepEqual(await f.claim(), []);
  await f.db.query("select erp_sync.local_superseded('contacts',$1)", [contact.id]);
  assert.equal((await f.outbox('review_required'))[0].state, 'failed');

  const second = await f.catalog('contacts', { name: 'Partial test', person_type: 'J' });
  const [delivery] = await f.claim();
  await f.ack([{ id: delivery.id, token: delivery.token, ok: false, status: 404, origin_id: '7733', code: 'ORIGIN_PARTIAL_WRITE_REVIEW', error: 'ORIGIN_PARTIAL_WRITE_REVIEW', retry: true }]);
  assert.equal(await f.scalar("select origin_id v from erp_sync.link where entity='contacts' and record_id=$1", [second.id]), '7733');
  assert.equal((await f.outbox('id='+delivery.id))[0].state, 'failed');
  assert.deepEqual(await f.claim(), []);
});

test('receiving a document advances the next local number and rereading an older one never reduces it', async () => {
  const f = fixture;
  await f.stageOrigin('contacts','881100',{id:881100,nome:'Sequence test',situacao:'A',tipo:'J'});
  await f.stageOrigin('products','881101',{id:881101,nome:'Sequence product',codigo:'SEQ',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:10});
  const payload = { id:881102,numero:90000,data:'2026-11-03',total:10,totalProdutos:10,situacao:{id:6,valor:0},contato:{id:881100},
    itens:[{produto:{id:881101},descricao:'Sequence product',unidade:'UN',quantidade:1,valor:10,valorTotal:10,desconto:0}] };
  await f.stageOrigin('sales_orders','881102',payload);
  const result = await f.pull();
  assert.equal(result.failed,0,JSON.stringify(result));
  assert.equal(await f.scalar("select last_number v from erp_documents.numbering where kind='sales_orders'"),90000);
  const contact = await f.scalar("select erp_sync.local_id('contacts','881100') v");
  const product = await f.scalar("select erp_sync.local_id('products','881101') v");
  const next = await f.document('sales_orders',{contact,items:[{product_id:product,description:'Sequence product',quantity:'1',unit_price:'10'}]});
  assert.equal(Number(next.number),90001);
  await f.stageOrigin('sales_orders','881103',{...payload,id:881103,numero:89999});
  await f.pull();
  assert.equal(await f.scalar("select last_number v from erp_documents.numbering where kind='sales_orders'"),90001);
  await assert.rejects(f.rpc('erp_document_numbering_set', { p_user_id:f.users.admin,p_kind:'sales_orders',p_command_id:randomUUID(),
    p_expected_next_number:'90002',p_next_number:'89999' }), /erp_document_number_taken/);
});

test('financial mapping requires a unique match or explicit inbound default and never chooses the first category', async () => {
  const f=fixture;
  const account=(await f.rpc('erp_finance_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'account_save',
    p_data:{expected_version:0,name:'Mapped cash',kind:'cash'}})).record;
  assert.equal(await f.scalar("select erp_sync.account_native('missing') v"),null);
  await f.db.query('update erp_sync.settings set default_account_id=$1',[account.id]);
  assert.equal(await f.scalar("select erp_sync.account_native('missing') v"),account.id);
  await f.db.query("insert into origin_sync.resource_state(resource)values('mapping_test')on conflict do nothing");
  for(const [entity,id,description] of [['ledger_accounts','910031','Mapped cash'],['financial_categories','910032','Unrelated category']]) {
    await f.db.query('insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,$2,$3,$4,$5)',
      [entity,'mapping_test',id,JSON.stringify({id:Number(id),descricao:description}),'e'.repeat(64)]);
  }
  assert.equal(await f.scalar('select erp_sync.account_origin($1) v',[account.id]),'910031');
  await f.stageOrigin('receivables','910033',{id:910033,situacao:1,vencimento:'2026-11-10',valor:10,saldo:10,dataEmissao:'2026-11-03',contato:{id:881100},historico:'Mapping test'});
  await f.pull();
  const title=(await f.db.query("select * from erp_finance.title where id=erp_sync.local_id('receivables','910033')")).rows[0];
  await f.rpc('erp_finance_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'settle',p_data:{id:title.id,expected_version:title.version,
    account_id:account.id,posted_on:'2026-11-03',principal_cents:'1000'}});
  const settlement=await f.scalar('select id v from erp_finance.settlement where title_id=$1',[title.id]);
  await assert.rejects(f.scalar("select erp_sync.settlement_request('receivables',$1) v",[settlement]),/ORIGIN_ACCOUNT_OR_CATEGORY_UNKNOWN/);
  await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('ledger_accounts','mapping_test','910034',$1,$2)",
    [JSON.stringify({id:910034,descricao:'Mapped cash'}),'f'.repeat(64)]);
  assert.equal(await f.scalar('select erp_sync.account_origin($1) v',[account.id]),null,'duplicate names must not choose an arbitrary account');
});

test('mixed installment methods survive receipt and resend; missing or ambiguous mappings block the write', async () => {
  const f=fixture;
  const payload={id:881104,numero:90002,data:'2026-11-03',total:10,totalProdutos:10,situacao:{id:6,valor:0},contato:{id:881100},
    itens:[{produto:{id:881101},descricao:'Sequence product',unidade:'UN',quantidade:1,valor:10,valorTotal:10,desconto:0}],
    parcelas:[{dataVencimento:'2026-11-10',valor:5,formaPagamento:{id:111}},{dataVencimento:'2026-11-20',valor:5,formaPagamento:{id:222}}]};
  await f.stageOrigin('sales_orders','881104',payload);
  assert.equal((await f.pull()).failed,0);
  const id=await f.scalar("select erp_sync.local_id('sales_orders','881104') v");
  const body=await f.scalar('select body v from erp_documents.document where id=$1',[id]);
  assert.deepEqual(body.installments.map(p=>p.payment_reference.source_id),['111','222']);
  const outgoing=await f.scalar("select erp_sync.document_request('sales_orders',$1,'upsert') v",[id]);
  assert.deepEqual(outgoing.requests[0].body.parcelas.map(p=>p.formaPagamento.id),[111,222]);
  const resolve=(installment,base)=>f.scalar('select erp_sync.installment_method($1::jsonb,$2::jsonb) v',[JSON.stringify(installment),JSON.stringify(base)]);
  assert.equal(await resolve({due_date:'2026-11-20',amount:'5'},payload),'222');
  await assert.rejects(resolve({due_date:'2026-11-30',amount:'5'},payload),/ORIGIN_PAYMENT_METHOD_UNKNOWN/);
  await assert.rejects(resolve({due_date:'2026-11-10',amount:'5'},
    {parcelas:[payload.parcelas[0],{...payload.parcelas[0],formaPagamento:{id:333}}]}),/ORIGIN_PAYMENT_METHOD_UNKNOWN/);
  await assert.rejects(resolve({due_date:'2026-11-10',amount:'5',payment_method_id:randomUUID()},payload),/ORIGIN_PAYMENT_METHOD_UNKNOWN/);
});
