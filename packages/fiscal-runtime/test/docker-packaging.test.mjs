import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

test('production Docker COPY rules include the shared QR profile and permit an isolated offline import',async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'brufap-runtime-packaging-'));
 try{
  const dockerfile=await readFile(join(root,'packages/fiscal-runtime/Dockerfile'),'utf8');
  const base=dockerfile.split(/^FROM base AS test$/m)[0];let copied=0;
  // Reproduce the actual two package COPY entries, without importing from the host checkout.
  for(const line of base.split('\n')){
   const fields=line.trim().split(/\s+/);if(fields[0]!=='COPY'||!fields.slice(1,-1).some(s=>/^packages\/fiscal-(?:core|xml)\/src(?:\/|$)/.test(s)))continue;
   const destination=fields.at(-1);assert.match(destination,/^\.\/packages\/fiscal-(?:core|xml)\/src(?:\/|$)/);
   for(const source of fields.slice(1,-1)){
    assert.match(source,/^packages\/fiscal-(?:core|xml)\/src(?:\/|$)/);
    const info=await stat(join(root,source)),target=join(temp,destination,info.isFile()&&destination.endsWith('/')?basename(source):'');
    await mkdir(dirname(target),{recursive:true});await cp(join(root,source),target,{recursive:info.isDirectory()});copied++;
   }
  }
  assert.ok(copied>=3);
  const{expectedNfceSupplement,NFCE_SP_HOMOLOGATION_QR_V3}=await import(pathToFileURL(join(temp,'packages/fiscal-xml/src/nfce-profile.mjs')).href);
  const{cnpjCheckDigits}=await import(pathToFileURL(join(temp,'packages/fiscal-core/src/identity.mjs')).href);
  const identity={cUF:'35',cnpj:'990000000001'+cnpjCheckDigits('990000000001'),model:'65',environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T09:00:00-03:00',cNF:'12345678',tpEmis:'1'};
  const qr=expectedNfceSupplement(identity,NFCE_SP_HOMOLOGATION_QR_V3);assert.equal(qr.version,'3');assert.match(qr.qrCode,/^https:\/\/www\.homologacao\.nfce\.fazenda\.sp\.gov\.br\/qrcode\?p=\d{44}\|3\|2$/);
  assert.throws(()=>expectedNfceSupplement({...identity,environment:'1'},NFCE_SP_HOMOLOGATION_QR_V3));
 }finally{await rm(temp,{recursive:true,force:true});}
});
