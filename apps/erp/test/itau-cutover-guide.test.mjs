import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { itauCutoverNumbers } from '../src/lib/itau-cutover-model.ts';
import { cnabProfileData } from '../src/lib/real-cnab-model.ts';
import { mountComponent } from './helpers/component-recovery-harness.mjs';

const oldDocument = globalThis.document;
before(() => { globalThis.document = { activeElement: null }; });
after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
const text = n => Array.isArray(n) ? n.map(text).join('') : n && typeof n === 'object' ? text(n.props?.children) : n == null || typeof n === 'boolean' ? '' : String(n);
const inputFor = (view, label) => view.input(view.find(n => n.type === 'label' && text(n) === label).props.htmlFor);

test('number presentation never supplies a starting point or asserts availability', () => {
  assert.deepEqual(itauCutoverNumbers('', ''), {
    internalSequence: { state: 'missing', value: null },
    ourNumberBase: { state: 'missing', value: null }, availabilityVerified: false,
  });
  for (const input of ['0', '01', '1.0', '1e2', ' 1', '10000000']) assert.equal(itauCutoverNumbers(input, '').internalSequence.state, 'invalid');
  for (const input of ['1', '00000000', '123456789', ' 00000001', '00000001-1']) assert.equal(itauCutoverNumbers('', input).ourNumberBase.state, 'invalid');
  for (const sequence of ['1', '544', '9999999']) {
    const result = itauCutoverNumbers(sequence, '00000123');
    assert.equal(result.internalSequence.value, sequence);
    assert.equal(result.ourNumberBase.value, '00000123');
    assert.equal(result.availabilityVerified, false);
    assert.equal(Object.isFrozen(result), true);
  }
});

test('guide is read-only and separates sequence, bank availability, cutover and legacy limits', async () => {
  const view = await mountComponent('ItauCutoverGuide.tsx', { internalSequence: '', ourNumberBase: '' });
  try {
    assert.equal(view.nodes().filter(n => ['input', 'button', 'form', 'select'].includes(n.type)).length, 0);
    assert.equal((view.text().match(/Não informado/g) || []).length, 2);
    assert.match(view.text(), /não comprova disponibilidade/);
    assert.match(view.text(), /remessas ainda pendentes/);
    assert.match(view.text(), /vínculo bancário comprovado/);
    assert.match(view.text(), /prévia NÃO PAGAR/);
    assert.doesNotMatch(view.text(), /11146/);
    await view.updateProps({ internalSequence: '7', ourNumberBase: '00000123' });
    assert.match(view.text(), /00000123/);
    assert.match(view.text(), /aprovação separada/);
  } finally { view.unmount(); }
});

test('profile integration leaves counters and declarations blank and preserves the exact existing payload', async () => {
  const accountId = '20000000-0000-4000-8000-000000000001', profileId = '10000000-0000-4000-8000-000000000001';
  const calls = [];
  const controller = {
    async finance(path) { calls.push({ method: 'GET', path }); return { items: [{ id: accountId, name: 'CONTA FICTICIA', active: true }], has_more: false, next_cursor: null }; },
    async cnab(path, options = {}) {
      calls.push({ path, ...options });
      const profile = { id: profileId, version: 1 };
      return options.method === 'POST' ? { profile, replayed: false } : { items: [profile] };
    },
  };
  const view = await mountComponent('RealCnab.tsx', { controller, onClose() {}, onSaved() {} }, { componentName: 'ProfileEditor', expandChildren: true });
  try {
    assert.equal(inputFor(view, 'Sequência interna inicial FAGOO *').props.value, '');
    assert.equal(inputFor(view, 'Próximo nosso número · 8 dígitos sem DV *').props.value, '');
    assert.ok(view.nodes().filter(n => n.type === 'input' && n.props.type === 'checkbox').every(n => n.props.checked === false));
    assert.equal(calls.length, 1, 'the guide adds no API calls');
    await view.click('CONTA FICTICIA');
    const fields = [
      ['Nome no arquivo · maiúsculas sem acento *', 'EMPRESA FICTICIA'], ['CNPJ numérico do beneficiário *', '12345678000195'],
      ['Agência · 4 dígitos *', '1234'], ['Conta · 5 dígitos *', '12345'], ['Dígito da conta *', '6'],
      ['Sequência interna inicial FAGOO *', '7'], ['Próximo nosso número · 8 dígitos sem DV *', '00000123'],
      ['Referência da conferência / contrato *', 'REFERENCIA SINTETICA'],
    ];
    for (const [label, value] of fields) await view.change(inputFor(view, label).props.id, value);
    await view.submit();
    assert.equal(calls.length, 1, 'reviewing the form is local');
    await view.click('Salvar perfil');
    const writes = calls.filter(c => c.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/v1/cnab/profiles');
    assert.equal(writes[0].body.expected_version, 0);
    assert.match(writes[0].body.command_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(writes[0].body).sort(), ['command_id', 'data', 'expected_version']);
    assert.deepEqual(writes[0].body.data, cnabProfileData({ account_id: accountId, bank: '341', wallet: '109', agency: '1234', account: '12345', accountDigit: '6', cnpj: '12345678000195', companyName: 'EMPRESA FICTICIA', agreementReference: 'REFERENCIA SINTETICA', ourNumberStart: '00000123', remittanceSequenceStart: '7' }, {}));
  } finally { view.unmount(); }
});

test('Itaú validation names the internal counter and preserves the Inter contract', () => {
  const base = { account_id: 'synthetic', bank: '341', wallet: '109', agency: '1234', account: '12345', accountDigit: '6', cnpj: '12345678000195', companyName: 'EMPRESA FICTICIA', agreementReference: 'TEST', ourNumberStart: '00000123', remittanceSequenceStart: '' };
  assert.throws(() => cnabProfileData(base, {}), /sequência interna inicial FAGOO/);
  assert.throws(() => cnabProfileData({ ...base, bank: '077', wallet: '112', agency: '0001', account: '000123456' }, {}), /próxima sequência confirmada/);
});
