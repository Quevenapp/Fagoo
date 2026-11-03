import { prepareProtocolQuery } from '../../fiscal-xml/src/index.mjs';
import { buildAccessKey } from '../../fiscal-core/src/identity.mjs';
import { identity } from '../../fiscal-core/test/fixtures.mjs';

const fixtures = {};
for (const [label, changes] of [['55', {}], ['65', { model: '65' }], ['alpha', { cnpj: '12ABC34501DE35' }], ['other', { number: '124' }]]) {
  const value = { ...identity, ...changes };
  fixtures[label] = prepareProtocolQuery({ accessKey: buildAccessKey(value), expectedModel: value.model, environment: '2', requestId: `query_${label}` });
}
process.stdout.write(JSON.stringify(fixtures));
