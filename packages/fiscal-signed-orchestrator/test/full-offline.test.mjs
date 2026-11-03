// Explicit opt-in only. Entire certificate, password, KEK, database and objects are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fixture,hash} from './fixture.mjs';
import {createSignedCustodyPort} from '../../fiscal-signed-custody/src/index.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import {createFiscalSchemaRunner} from '../../fiscal-schema-runner/src/index.mjs';
import {signerMaterial} from '../../fiscal-xml/src/certificate.mjs';
const enabled=process.env.BRUFAP_SIGNED_FULL_OFFLINE_TEST==='1';
test('full offline: real050+encrypted synthetic PFX+OpenSSL custody+signed NFC-e+official integral XSD',{skip:!enabled,timeout:60000},async()=>{
 const {binary,exportPfx,credentials,PASSWORD}=await import('../../fiscal-vault/test/fixtures.mjs');
 const f=await fixture({model:'65'}),kek=randomBytes(32),credential=await credentials(),handles=[],owned=[];let pfx,sealed;
 try{
  const loader=await createOpenSslLoader({binaryPath:binary}),current=await f.callSql('erp_a1_metadata',{p_user_id:f.users.admin}),company=await f.callSql('erp_company_get',{p_user_id:f.users.admin,p_section:'identity'}),command=randomUUID();
  const reserve=await f.callSql('erp_a1_reserve',{p_user_id:f.users.admin,p_command_id:command,p_request_hash:hash(command),p_action:'configure',p_expected_version:current.current.version,p_expected_identity_version:company.record.version,p_reason:'Certificado sintético no teste offline integral'});
  pfx=await exportPfx(credential);const envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:reserve.context,kekBytes:kek,keyId:'synthetic-offline-v1',loader,now:new Date()});sealed=envelopeBytes(envelope);
  const objectHash=hash(sealed),path=`credentials/${reserve.credential_id}/${objectHash}.json`;
  await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-a1-vault',path,JSON.stringify({size:sealed.length,mimetype:'application/json'})]);
  const configured=await f.callSql('erp_a1_finalize',{p_user_id:f.users.admin,p_command_id:command,p_lease_id:reserve.lease_id,p_metadata:envelope.metadata,p_object_hash:objectHash,p_size_bytes:sealed.length,p_key_id:'synthetic-offline-v1'});
  const withAuthorizedSigner=createSignedCustodyPort({readObject:async(ref,{signal})=>{assert.equal(signal.aborted,false);assert.equal(ref.path,path);assert.equal(ref.hash,objectHash);const result=Buffer.from(sealed);owned.push(result);return result;},loader:{load:async args=>{const result=await loader.load(args);handles.push(result.signer);return result;}},keyring:new Map([['synthetic-offline-v1',kek]])});
  const validatorPath=fileURLToPath(new URL('../../fiscal-schema/validator.py',import.meta.url));let processes=0;
  const validateXsd=createFiscalSchemaRunner({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath,spawnImpl:(program,args,options)=>{
   assert.equal(program,'/opt/fiscal-validator/bin/python3');assert.deepEqual(args,['-I','-B',validatorPath,'--model','65']);processes++;
   return spawn(process.env.BRUFAP_DOCKER_BIN??'/usr/local/bin/docker',['run','--rm','-i','--platform','linux/amd64','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','1','--entrypoint',program,'brufap-fiscal-schema-test:local','-I','-B','/app/packages/fiscal-schema/validator.py','--model','65'],options);
  }});
  const input={...f.input,expectedA1Version:configured.current.version},orchestrator=f.orchestrator({withAuthorizedSigner,validateXsd}),result=await orchestrator.run(input);
  assert.equal(result.status,'stored',JSON.stringify(result));assert.equal(result.signature_verified,true);assert.equal(result.xsd_validated,true);assert.equal(result.a1_version,3);assert.equal(result.current.artifact_current,true);assert.equal(result.can_emit,false);assert.equal(result.can_transmit,false);
  assert.equal(processes,1);assert.equal(handles.length,1);assert.ok(owned.every(bytes=>bytes.every(x=>x===0)));for(const handle of handles)assert.throws(()=>signerMaterial(handle,new Date()),/SIGNER_HANDLE_INVALID_OR_DISPOSED/);
  assert.equal((await orchestrator.run(input)).status,'stored');assert.equal(processes,1);assert.equal(handles.length,1);assert.doesNotMatch(JSON.stringify(result),/BEGIN |credential_|certificate_fingerprint|cnpj|lease_id|key_id|<NFe/);
 }finally{pfx?.fill(0);sealed?.fill(0);kek.fill(0);credential.privateDer.fill(0);await f.close();}
});
