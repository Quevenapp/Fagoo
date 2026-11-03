import assert from 'node:assert/strict';import {test} from 'node:test';import {createHandler} from '../src/index.mjs';import {normalizeCompany} from '../../../packages/erp-domain/src/company.mjs';
const user='a0000000-0000-4000-8000-000000000001',command='b0000000-0000-4000-8000-000000000001';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
const data={legal_name:'Empresa QA',cnpj:'12ABC34501DE35',postal_code:'13400000',street:'Rua fictícia',number:'S/N',district:'Bairro fictício',city:'Piracicaba',municipality_code:'3538709',state:'SP'};
const record={version:1,data:normalizeCompany(data),created_at:'2026-10-16T12:00:00Z',updated_at:'2026-10-16T12:00:00Z'};
const envelope={section:'identity',record,data_mode:'erp_native',emission_enabled:false};
function harness(result=envelope,status=200){const calls=[];return{calls,handler:createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/auth/v1/user')?{id:user,user_metadata:{role:'admin'}}:result),{status:url.endsWith('/auth/v1/user')?200:status});}})};}
const request=(path='/v1/empresa/identidade',method='GET',body)=>new Request(`https://api.example.test${path}`,{method,headers:{Authorization:'Bearer synthetic',Origin:'https://erp.example.test',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
test('company identity requests carry only verified actor and exact CAS args; no private response fields',async()=>{
 const h=harness({...envelope,secret:'hidden',record:{...record,updated_by:'hidden'}});const response=await h.handler(request(undefined,'POST',{command_id:command,expected_version:0,data}),env);assert.equal(response.status,200);
 assert.ok(h.calls[1].url.endsWith('/erp_company_save_identity'));assert.deepEqual(JSON.parse(h.calls[1].body),{p_expected_version:0,p_command_id:command,p_data:data,p_user_id:user});assert.doesNotMatch(await response.text(),/hidden|updated_by|secret/);
 const get=harness();assert.equal((await get.handler(request(),env)).status,200);assert.deepEqual(JSON.parse(get.calls[1].body),{p_section:'identity',p_user_id:user});
});
test('fiscal confirmation is explicitly boolean, separate from identity and includes both CAS versions',async()=>{
 const fiscal={section:'fiscal',record:{version:2,identity_version:1,crt:'4',confirmed:true,confirmed_at:'2026-10-16T12:00:00Z',reason:'Conferência sintética',updated_at:'2026-10-16T12:00:00Z'},data_mode:'erp_native',emission_enabled:false};
 const h=harness(fiscal);const body={command_id:command,expected_version:1,expected_identity_version:1,crt:'4',confirmed:true,reason:'Conferência sintética'};
 assert.equal((await h.handler(request('/v1/empresa/fiscal','POST',body),env)).status,200);assert.deepEqual(JSON.parse(h.calls[1].body),{p_expected_version:1,p_expected_identity_version:1,p_command_id:command,p_crt:'4',p_confirmed:true,p_reason:'Conferência sintética',p_user_id:user});
 for(const patch of [{confirmed:false},{confirmed:'true'},{crt:4},{crt:'5'},{crt:null,confirmed:true},{reason:'x'},{expected_identity_version:0},{p_user_id:user},{certificate:'secret'}]){const invalid=harness();assert.equal((await invalid.handler(request('/v1/empresa/fiscal','POST',{...body,...patch}),env)).status,400);assert.equal(invalid.calls.length,0);}
});
test('invalid identity data, routes, size and permissions never expose payloads or accept metadata admin',async()=>{
 for(const patch of [{cnpj:'123'},{municipality_code:'3304557'},{state:'XX'},{crt:'3'},{csc:'secret'},{street:''}]){const h=harness();assert.equal((await h.handler(request(undefined,'POST',{command_id:command,expected_version:0,data:{...data,...patch}}),env)).status,400);assert.equal(h.calls.length,0);}
 for(const [sql,status]of [['42501',403],['22023',400],['40001',409]]){const h=harness({code:sql,message:'PRIVATE_SQL'},400);const response=await h.handler(request(),env);assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/PRIVATE_SQL/);}
 const h=harness();assert.equal((await h.handler(request('/v1/empresa/identidade?q=x'),env)).status,400);assert.equal((await h.handler(request('/v1/empresa/secrets'),env)).status,404);assert.equal((await h.handler(request('/v1/empresa/fiscal','DELETE'),env)).status,405);
 const oversized=request(undefined,'POST',{command_id:command,expected_version:0,data:{...data,legal_name:'x'.repeat(17000)}});assert.equal((await h.handler(oversized,env)).status,400);
 const unauth=request();unauth.headers.delete('Authorization');assert.equal((await h.handler(unauth,env)).status,401);
});
test('response contracts reject emission enabled, malformed identity and fiscal values while preserving empty state',async()=>{
 const empty=harness({...envelope,record:null});assert.equal((await empty.handler(request(),env)).status,200);
 for(const result of [{...envelope,emission_enabled:true},{...envelope,record:{...record,data:{...record.data,cnpj:'bad'}}},{...envelope,record:{...record,version:0}}]){const h=harness(result);assert.equal((await h.handler(request(),env)).status,502);}
 const access=harness({read_identity:true,write_identity:false,read_fiscal:false,write_fiscal:false,data_mode:'erp_native',emission_enabled:false,private:'secret'});const response=await access.handler(request('/v1/empresa'),env);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/private|secret/);
});
