import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {credentials,HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';

const image=process.env.BRUFAP_CACHED_FISCAL_IMAGE;
test('cached production image signs price10 bytes identically to local QRv3 and validates both models offline',{skip:!image,timeout:60000},async()=>{
 assert.match(image,/^sha256:[a-f0-9]{64}$/); // Exact cached image only; no registry authentication or pull.
 const credential=await credentials(),hash=v=>createHash('sha256').update(v).digest('hex');let signer,payload;
 try{
  signer=createSigner({...credential,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});
  const cases=['55','65'].map(model=>{
   const xml=buildBusinessXml(businessFixture({model,quantity:'2.000000',unit_price:'10.1234567891'})).unsignedXml;
   const result=createSignedHomologationCandidate({xml,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(xml),expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW});
   return{model,xml,expected_signed_hash:result.xmlDigest};
  });
  payload=Buffer.from(JSON.stringify({synthetic_fixture:true,holder:HOLDER,now:NOW.toISOString(),private_der:credential.privateDer.toString('base64'),certificate_der:credential.certificateDer.toString('base64'),cases}));
  const script=fileURLToPath(new URL('./image-price-smoke.mjs',import.meta.url));
  const output=await new Promise((resolve,reject)=>{
   const child=spawn(process.env.BRUFAP_DOCKER_BIN??'docker',['run','--rm','-i','--pull=never','--platform','linux/amd64','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','1','--mount',`type=bind,source=${script},target=/app/image-price-smoke.mjs,readonly`,'--entrypoint','node',image,'/app/image-price-smoke.mjs'],{stdio:['pipe','pipe','pipe']});
   const chunks=[];let total=0,errorSize=0;const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
   child.on('error',error=>{clearTimeout(timer);reject(error);});child.stdin.on('error',()=>{});
   child.stdout.on('data',chunk=>{total+=chunk.length;if(total>16384)child.kill('SIGKILL');else chunks.push(chunk);});child.stderr.on('data',chunk=>{errorSize+=chunk.length;if(errorSize>16384)child.kill('SIGKILL');});
   child.on('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error(`SYNTHETIC_CACHED_IMAGE_FAILED exit=${code} stderr_bytes=${errorSize}`));return;}try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('SYNTHETIC_CACHED_IMAGE_RESPONSE_INVALID'));}});
   child.stdin.end(payload);
  });
  assert.deepEqual(output,{synthetic_fixture:true,real_certificate_used:false,network_used:false,results:['55','65'].map(model=>({model,same_signed_bytes:true,signature_verified:true,xsd_validated:true,qr_profile:model==='65'?'sp-homologation-online-qr-v3':null,can_transmit:false}))});
 }finally{if(signer)disposeSigner(signer);credential.privateDer.fill(0);payload?.fill(0);}
});
