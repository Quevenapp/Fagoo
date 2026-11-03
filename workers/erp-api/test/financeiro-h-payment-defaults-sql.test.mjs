import test from 'node:test'; import assert from 'node:assert/strict'; import { randomUUID } from 'node:crypto';
import { financeiroHFixture, fails } from './helpers/financeiro-h-fixture.mjs';

// Leva H, lane financeiro (371: CTT-130): forma padrão separada para recebimentos, pagamentos e devoluções, pela finalidade e pelo
// estado ativo. Synthetic data only.
const DATA = { payment_type: '01', condition: null, destination: 'contas', account_id: null, business_days: false, interest_rate: null, fine_rate: null, card_brand: null, card_integration: null,
  card_cnpj: null, auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: 'aliquota', fee_rate: null, fee_fixed: null, settlement_days: null };

test('H 371: one default per purpose, kept to the purpose and to active formas; the gavetas mark the default of the kind', async () => {
  const f = await financeiroHFixture(); try {
    const save = async (description, applicable) => (await f.rpc('erp_catalog_payment_method_save', { p_user_id: f.users.financeiro, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { ...DATA, description, applicable } })).item;
    const act = async (method, action, user = f.users.financeiro) => (await f.rpc('erp_catalog_payment_method_action', { p_user_id: user, p_id: method.id, p_expected_version: method.version, p_command_id: randomUUID(), p_action: action })).item;
    const get = async id => (await f.rpc('erp_catalog_payment_method_get', { p_user_id: f.users.consulta, p_id: id })).item;
    const flags = m => [m.is_default, m.default_receipt, m.default_payment, m.default_return];
    let pix = await save('Pix sintético', 'ambos'), boleto = await save('Boleto sintético', 'recebimentos'), ted = await save('TED sintética', 'pagamentos');
    pix = await act(pix, 'default_recebimentos');
    assert.deepEqual(flags(pix), [true, true, false, false], 'is_default stays the default of recebimentos');
    ted = await act(ted, 'default_pagamentos'); boleto = await act(boleto, 'default_devolucoes');
    // Swapping the default of recebimentos keeps one.
    boleto = await act(boleto, 'default_recebimentos'); pix = await get(pix.id);
    assert.deepEqual([flags(boleto), flags(pix)], [[true, true, false, true], [false, false, false, false]]);
    // The purpose is respected: a forma de pagamentos is never the default of recebimentos nor of devoluções.
    await fails(assert, () => act(ted, 'default_recebimentos'), '22023');
    await fails(assert, () => act(ted, 'default_devolucoes'), '22023');
    await fails(assert, () => act(boleto, 'default_pagamentos'), '22023');
    await fails(assert, () => act(pix, 'default_pagamentos', f.users.consulta), '42501');
    // The gavetas of contas: receivable marks the default of recebimentos, payable the default of pagamentos.
    const kinds = async kind => (await f.rpc('erp_finance_payment_methods', { p_user_id: f.users.consulta, p_kind: kind })).items.filter(i => i.is_default).map(i => i.description);
    assert.deepEqual([await kinds('receivable'), await kinds('payable')], [['Boleto sintético'], ['TED sintética']]);
    // Inactivating takes the forma out of every default; clear_devolucoes removes only the devolução indicator.
    boleto = await act(boleto, 'clear_devolucoes'); assert.deepEqual(flags(boleto), [true, true, false, false]);
    boleto = await act(boleto, 'inactivate'); assert.deepEqual(flags(boleto), [false, false, false, false]);
    await fails(assert, () => act(boleto, 'default_recebimentos'), '22023');
    // Changing the purpose of the saved forma drops the default it no longer serves.
    pix = await act(pix, 'default_pagamentos'); ted = await get(ted.id); assert.equal(ted.default_payment, false);
    pix = (await f.rpc('erp_catalog_payment_method_save', { p_user_id: f.users.financeiro, p_id: pix.id, p_expected_version: pix.version, p_command_id: randomUUID(), p_data: { ...DATA, description: 'Pix sintético', applicable: 'recebimentos' } })).item;
    assert.deepEqual(flags(pix), [false, false, false, false]);
    // The legacy "default" chooses the purpose of the forma; the Worker projects the three flags.
    ted = await act(ted, 'default'); assert.deepEqual(flags(ted), [false, false, true, false]);
    const http = await f.call('/v1/cadastros/formas-pagamento?page=1&size=100', 'GET', undefined, f.users.consulta);
    assert.equal(http.status, 200);
    assert.deepEqual(http.value.items.map(i => [i.description, i.default_receipt, i.default_payment, i.default_return]).sort(), [['Pix sintético', false, false, false], ['TED sintética', false, true, false]]);
    const done = await f.call(`/v1/cadastros/formas-pagamento/${pix.id}/acao`, 'POST', { command_id: randomUUID(), expected_version: pix.version, action: 'default_devolucoes' }, f.users.financeiro);
    assert.deepEqual([done.status, done.value.item.default_return], [200, true]);
    assert.equal((await f.call(`/v1/cadastros/formas-pagamento/${pix.id}/acao`, 'POST', { command_id: randomUUID(), expected_version: 1, action: 'padrao' }, f.users.financeiro)).status, 400);
  } finally { await f.close(); }
});
