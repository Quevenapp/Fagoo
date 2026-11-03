import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBoletoQaHandler,BOLETO_QA_ORIGIN} from './boleto-preview-server.mjs';
import {boletoItems,boletoPreview} from '../../apps/erp/src/lib/boleto-preview-model.ts';
const handler=await createBoletoQaHandler(),request=(path,o={})=>new Request(BOLETO_QA_ORIGIN+path,{headers:{Origin:'http://127.0.0.1:5173'},...o});
test('066 local QA uses real renderer fixtures, bound source purposes and only read responses',async()=>{
 const response=await handler(request('/fixtures')),catalog=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(catalog.profile,'synthetic-itau-boleto-qa-v1');assert.deepEqual(catalog.fixtures.map(f=>f.purpose),['homologation','operational']);
 for(const f of catalog.fixtures){
  const r=await handler(request(`/${f.purpose}/v1/boletos-itau/remittances/${f.file.id}/items`));assert.equal(r.status,200);
  const rows=boletoItems(await r.json(),f.file,f.purpose),raw=await handler(request(`/${f.purpose}/v1/boletos-itau/${rows.items[0].billing_title_id}/preview`));
  const dto=await boletoPreview(await raw.json(),rows,rows.items[0]);assert.equal(dto.canPay,false);assert.equal(dto.financialMutationPerformed,false);assert.equal(dto.source_purpose,f.purpose);assert.match(dto.html,/NÃO PAGAR/);
 }
});
test('066 QA refuses nonloopback, foreign origins, mutations, queries and unrelated surfaces; page uses real router/provider',async()=>{
 for(const r of [new Request('https://remote.invalid/fixtures'),request('/fixtures',{headers:{Origin:'https://remote.invalid'}}),request('/fixtures?x=1')])assert.equal((await handler(r)).status,403);
 for(const method of ['POST','PUT','DELETE'])assert.equal((await handler(request('/fixtures',{method}))).status,405);
 assert.equal((await handler(request('/v1/cnab'))).status,404);assert.equal((await handler(request('/fixtures',{method:'OPTIONS'}))).headers.get('access-control-allow-methods'),'GET');
 const page=await readFile(new URL('../../apps/erp/src/qa-boleto.tsx',import.meta.url),'utf8');
 assert.match(page,/import\s*\{UnsavedChangesProvider\}\s*from '\.\/hooks\/useUnsavedChanges'/);assert.match(page,/<UnsavedChangesProvider><Qa\/><\/UnsavedChangesProvider>/);assert.match(page,/<RouterProvider router=\{router\}/);assert.match(page,/import\.meta\.env\.DEV/);
 assert.doesNotMatch(page,/createAccessController|signInWithPassword|SUPABASE|method:'POST'/);
});
