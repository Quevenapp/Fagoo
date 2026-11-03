import assert from 'node:assert/strict';import {test} from 'node:test';import {identityValues,companyData,fiscalInput} from '../src/lib/company-model.ts';import {createAccessController} from '../src/lib/real-access.ts';
test('empty company has no invented defaults and identity validation explains invalid CNPJ/address',()=>{
 const blank=identityValues(null);assert.ok(Object.values(blank).every(value=>value===''));assert.throws(()=>companyData(blank),/Razão social/);
 const valid={...blank,legal_name:'Empresa fictícia',cnpj:'12.ABC.345/01DE-35',postal_code:'13400-000',street:'Rua QA',number:'S/N',district:'Bairro QA',city:'Piracicaba',municipality_code:'3538709',state:'SP'};
 assert.equal(companyData(valid).cnpj,'12ABC34501DE35');assert.throws(()=>companyData({...valid,cnpj:'12ABC34501DE36'}),/dígitos/);assert.throws(()=>companyData({...valid,municipality_code:'3304557'}),/prefixo/);
});
test('CRT requires a distinct confirmation and a reason, supports clearing, and carries both versions',()=>{
 const record={version:2,identity_version:4,crt:null};assert.throws(()=>fiscalInput(null,'3',true,'Conferido'),/Cadastre/);assert.throws(()=>fiscalInput(record,'3',false,'Conferido'),/explicitamente/);assert.throws(()=>fiscalInput(record,'3',true,'x'),/motivo/);
 assert.deepEqual(fiscalInput(record,'3',true,' Conferência sintética '),{expected_version:2,expected_identity_version:4,crt:'3',confirmed:true,reason:'Conferência sintética'});
 assert.equal(fiscalInput(record,'',true,'Retirar confirmação').confirmed,false);assert.equal(fiscalInput(record,'',false,'Retirar confirmação').crt,null);
});
test('company controller keeps bounded private session calls and aborts on logout',async()=>{
 const uid='a0000000-0000-4000-8000-000000000001',session={access_token:'synthetic',user:{id:uid}},auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};let finish,signal;
 const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return new Response(JSON.stringify({user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'}));signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=controller.start();await new Promise(resolve=>setTimeout(resolve,0));
 for(const path of ['/v1/cadastros','https://elsewhere.test','/v1/empresa/../me','/v1/empresa/%2e%2e/me'])await assert.rejects(()=>controller.company(path),error=>error.status===400);
 const pending=controller.company('/v1/empresa/identidade');await controller.logout();assert.equal(signal.aborted,true);finish(new Response('{"private":"late"}'));await assert.rejects(()=>pending,error=>error.name==='AbortError');stop();
});
