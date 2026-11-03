import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectBuildFile,privateValues} from './check-erp-build.mjs';
test('build guard rejects QA payloads, maps, local tokens and exact private values without disclosing matches',()=>{
 const secret='synthetic-private-value-for-test';
 for(const[name,body,reason]of [['assets/index.js','const x="QA_SYNTHETIC_FAILURE"','qa_marker'],['assets/index.js','fetch("http://127.0.0.1:9011")','qa_marker'],['qa.html','hello','forbidden_file'],['assets/file.js.map','{}','forbidden_file'],['.env.local','x=y','forbidden_file'],['assets/index.js',secret,'private_value']]){
  const result=inspectBuildFile(name,body,[secret]);assert.ok(result.failures.includes(reason));assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
 }
});
test('build guard allows public configuration without weakening secret checks',()=>{
 assert.deepEqual(inspectBuildFile('assets/index.js','const api="https://api.example.com"; const title="FAGOO";'),{file:'assets/index.js',failures:[]});
 assert.deepEqual(privateValues({SUPABASE_URL:'https://example.supabase.co',nested:{client_secret:'synthetic-client-secret-value',access_token:'synthetic-access-token-value'},publicKey:'public-config-value'}),['synthetic-client-secret-value','synthetic-access-token-value']);
});

test('only supported application entries can enter a browser artifact',()=>{
 for(const name of ['review.html','nested/review.html','nested\\review.html'])assert.deepEqual(inspectBuildFile(name,'hello').failures,['forbidden_file']);
 for(const marker of ['brufap.erp.demo.list.','Restaurar dados de demonstração','Prévia de layout · dados de demonstração','Conhecer a prévia com dados fictícios','Demonstração do layout'])assert.deepEqual(inspectBuildFile('assets/entry.js',marker).failures,['unsupported_entry']);
});

test('A1 deployment keys and synthetic certificate markers cannot enter a browser artifact',()=>{
 const secret='synthetic-fiscal-key-0123456789';
 for(const key of ['transport','fingerprint','kek','A1_TRANSPORT_SECRET','A1_KEK_RING_JSON'])assert.deepEqual(privateValues({[key]:secret}),[secret]);
 assert.deepEqual(privateValues({transport_key_id:'transport-20261016-v1',kek_id:'kek-20261016-v1'}),[]);
 for(const marker of ['BRUFAP_A1_SYNTHETIC_QA_ONLY','A1_QA_LOCAL_ONLY','senha-de-teste'])assert.deepEqual(inspectBuildFile('assets/a1.js',marker).failures,['qa_marker']);
});
