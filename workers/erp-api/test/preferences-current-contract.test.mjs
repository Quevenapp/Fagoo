import test from 'node:test';
import assert from 'node:assert/strict';
import {originTwoWayFixture} from './helpers/origin-two-way-fixture.mjs';
import {STORED_PREFERENCE_PAGES} from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import {parsePreferencesPage} from '../../../packages/erp-domain/src/preferences/dto.mjs';

test('current schema preferences open after default changes without altering existing company choices', async () => {
  const f = await originTwoWayFixture();
  try {
    for (const page of STORED_PREFERENCE_PAGES) {
      const result = await f.rpc('erp_preferences_page', {p_user_id:f.users.admin,p_page:page.id});
      assert.doesNotThrow(() => parsePreferencesPage(result,page.id),page.id);
    }
    const current = await f.rpc('erp_preferences_page', {p_user_id:f.users.admin,p_page:'vendas-vendas'});
    const commission = current.items.find(item=>item.key==='vendas.base_comissao');
    assert.deepEqual(commission.value,['desconto']);
    assert.equal(commission.version,0);
    assert.equal(commission.updated_at,null);
    const invalid = structuredClone(current);
    invalid.items.find(item=>item.key===commission.key).value=['frete'];
    assert.throws(()=>parsePreferencesPage(invalid,'vendas-vendas'));
    const saved = await f.preference('vendas-vendas','vendas.base_comissao',['frete']);
    const after = await f.rpc('erp_preferences_page', {p_user_id:f.users.admin,p_page:'vendas-vendas'});
    assert.doesNotThrow(()=>parsePreferencesPage(after,'vendas-vendas'));
    assert.deepEqual(after.items.find(item=>item.key===commission.key).value,['frete']);
  } finally {await f.close();}
});
