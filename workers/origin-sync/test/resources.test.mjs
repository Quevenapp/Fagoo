import test from 'node:test';
import assert from 'node:assert/strict';
import { API_TIME_ZONE, RESOURCES, buildListParams, getResource, sourceId } from '../src/resources.mjs';

test('all polling variants have unique checkpoints and canonical shared entities', () => {
  assert.equal(new Set(RESOURCES.map((r) => r.id)).size, RESOURCES.length);
  assert.equal(getResource('contacts_deleted').entity, getResource('contacts').entity);
  assert.equal(new Set(RESOURCES.filter((r) => r.id.startsWith('nfe_')).map((r) => r.entity)).size, 1);
  assert.equal(API_TIME_ZONE, 'America/Sao_Paulo');
  assert.ok(Object.isFrozen(RESOURCES));
});

test('products cover all three documented stock partitions and deleted records', () => {
  for (const criterion of [5, 4]) {
    const variants = RESOURCES.filter((r) => r.entity === 'products' && r.baseParams.criterio === criterion);
    assert.deepEqual(variants.map((r) => r.baseParams.filtroSaldoEstoque).sort(), [0, 1, 2]);
    assert.ok(variants.every((r) => r.baseParams.tipo === 'T'));
  }
});

test('deleted polling does not assume a supported deletion timestamp', () => {
  for (const resource of RESOURCES.filter((r) => r.id.includes('_deleted')&&!r.extra)) {
    assert.equal(resource.mode, 'sweep');
    assert.equal(resource.fromParam, null);
    assert.equal(resource.toParam, null);
    const params = buildListParams(resource, { from: 'irrelevant', to: 'irrelevant', limit: 25 });
    assert.equal(params.limite, 25);
    assert.ok(Object.keys(params).every((key) => !key.startsWith('data')));
  }
});

test('receivables have explicit issuance dates and never depend on the one-year default', () => {
  const params = buildListParams('receivables', { from: '2020-02-01', to: '2020-02-29', page: 2, limit: 25 });
  assert.deepEqual(params, { tipoFiltroData: 'E', pagina: 2, limite: 25, dataInicial: '2020-02-01', dataFinal: '2020-02-29' });
  assert.throws(() => buildListParams('receivables'), { code: 'ORIGIN_INVALID_LOCAL_DATE' });
});

test('NF-e includes both directions and explicit cancelled-note variants', () => {
  assert.deepEqual(RESOURCES.filter((r) => r.entity === 'nfe').map((r) => r.baseParams), [
    { tipo: '0' }, { tipo: '1' }, { tipo: '0', situacao: 2 }, { tipo: '1', situacao: 2 },
  ]);
  const params = buildListParams('nfe_out_cancelled', { from: '2026-10-01 00:00:00', to: '2026-10-15 23:59:59' });
  assert.equal(params.dataEmissaoFinal, '2026-10-15 23:59:59');
});

test('sales proposals use historical date sweeps without assuming a modification filter', () => {
  const resource = getResource('sales_proposals');
  assert.equal(resource.entity, 'sales_proposals');
  assert.equal(resource.mode, 'sweep');
  assert.equal(resource.detailPath('00123'), '/propostas-comerciais/00123');
  assert.deepEqual(buildListParams(resource, { from: '2026-10-01', to: '2026-10-31', page: 3, limit: 10 }), {
    pagina: 3, limite: 10, dataInicial: '2026-10-01', dataFinal: '2026-10-31',
  });
  assert.throws(() => buildListParams(resource, { from: '2026-10-01 00:00:00', to: '2026-10-31 23:59:59' }), { code: 'ORIGIN_INVALID_LOCAL_DATE' });
});

test('NFC-e is a distinct entity with datetime emission sweeps and no undocumented status default', () => {
  const resource = getResource('nfce');
  assert.equal(resource.entity, 'nfce');
  assert.notEqual(resource.entity, getResource('nfe_out').entity);
  assert.equal(resource.mode, 'sweep');
  assert.equal(resource.detailPath('12345678901234567890'), '/nfce/12345678901234567890');
  assert.equal(RESOURCES.filter((entry) => entry.entity === 'nfce').length, 1);
  assert.deepEqual(buildListParams(resource, { from: '2026-10-01 00:00:00', to: '2026-10-31 23:59:59', limit: 10 }), {
    pagina: 1, limite: 10, dataEmissaoInicial: '2026-10-01 00:00:00', dataEmissaoFinal: '2026-10-31 23:59:59',
  });
  assert.throws(() => buildListParams(resource, { from: '2026-10-01', to: '2026-10-31' }), { code: 'ORIGIN_INVALID_LOCAL_DATE' });
});

test('modification filters and emission-date sweeps use their documented parameter names', () => {
  const changed = buildListParams('sales_orders', { from: '2026-10-01 00:00:00', to: '2026-10-15 21:00:00' });
  assert.equal(changed.dataAlteracaoInicial, '2026-10-01 00:00:00');
  assert.equal(getResource('purchase_orders').fromParam, 'dataInicial');
  assert.equal(getResource('payables').fromParam, 'dataEmissaoInicial');
});

test('unsafe, timezone-bearing or oversized date ranges fail before HTTP', () => {
  for (const dates of [
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-02', to: '2026-10-01' },
    { from: '2026-01-01', to: '2026-12-31' },
    { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
  ]) assert.throws(() => buildListParams('receivables', dates));
  assert.throws(() => buildListParams('sales_orders', { from: '2026-10-01 24:00:00', to: '2026-10-02 00:00:00' }));
  assert.throws(() => buildListParams('contacts_deleted', { page: 0 }));
  assert.throws(() => buildListParams('contacts_deleted', { limit: 101 }));
});

test('source IDs preserve string precision and reject rounded/injected IDs', () => {
  assert.equal(sourceId('12345678901234567890'), '12345678901234567890');
  assert.equal(sourceId('00123'), '00123');
  assert.equal(getResource('contacts').detailPath(12345678901), '/contatos/12345678901');
  for (const id of [Number.MAX_SAFE_INTEGER + 1, 1.5, 0, -1, '../123', '1?token=secret', 'https://evil.test']) {
    assert.throws(() => getResource('contacts').detailPath(id), { code: 'ORIGIN_INVALID_SOURCE_ID' });
  }
});

test('payment methods cover active and inactive while sellers include explicit deleted sweeps', () => {
  const methods = RESOURCES.filter(resource => resource.entity === 'payment_methods');
  assert.deepEqual(methods.map(resource => resource.baseParams.situacao).sort(), [0, 1]);
  assert.deepEqual(buildListParams('payment_methods_inactive', { limit: 10 }), { situacao: 0, pagina: 1, limite: 10 });
  assert.equal(getResource('sellers').baseParams.situacaoContato, 'T');
  assert.deepEqual(buildListParams('sellers_deleted', { limit: 10 }), { situacaoContato: 'E', pagina: 1, limite: 10 });
  assert.equal(getResource('sellers_deleted').entity, 'sellers');
  assert.equal(getResource('sellers').detailPath('123'), '/vendedores/123');
});
