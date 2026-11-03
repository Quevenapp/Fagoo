import test from 'node:test';
import assert from 'node:assert/strict';
import {createDanfeQaHandler,DANFE_QA_ORIGIN} from './danfe-server.mjs';
import {publicResult} from '../../packages/fiscal-danfe-runtime/src/dto.mjs';
const handler=await createDanfeQaHandler();
const request=(path,o={})=>new Request(DANFE_QA_ORIGIN+path,{headers:{Origin:'http://127.0.0.1:5173'},...o});
test('isolated synthetic QA exposes candidate metadata then only exact GET preview for both models',async()=>{
 const response=await handler(request('/fixtures')),catalog=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),'http://127.0.0.1:5173');
 assert.equal(catalog.profile,'synthetic-danfe-qa-v1');assert.deepEqual(catalog.candidates.map(c=>c.model),['55','65']);assert.ok(catalog.candidates.every(c=>c.html===undefined));
 for(const c of catalog.candidates){const response=await handler(request(`/v1/fiscal-danfe/candidates/${c.candidate_id}/preview`));assert.equal(response.status,200);
  const dto=await publicResult(await response.json(),{candidateId:c.candidate_id});assert.equal(dto.source_sha256,c.artifact.sha256);assert.equal(dto.source_size_bytes,c.artifact.size_bytes);assert.equal(dto.model,c.model);assert.equal(dto.authorized,false);
 }
});
test('QA refuses nonloopback target, foreign origin, arbitrary paths, query and mutation methods',async()=>{
 for(const req of [new Request('https://remote.invalid/fixtures'),request('/fixtures',{headers:{Origin:'https://remote.invalid'}}),request('/fixtures?x=1')])assert.equal((await handler(req)).status,403);
 assert.equal((await handler(request('/fixtures',{method:'POST'}))).status,405);assert.equal((await handler(request('/v1/a1'))).status,404);
 assert.equal((await handler(request('/fixtures',{method:'OPTIONS'}))).headers.get('access-control-allow-methods'),'GET');
});
