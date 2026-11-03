import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createFiscalSchemaRunner} from '../src/index.mjs';
const enabled=process.env.BRUFAP_SCHEMA_PROCESS_TEST==='1';
test('actual pinned Python process validates signed fictitious 55/65 bytes and separates XSD from signature',{skip:!enabled},async()=>{
 const root=new URL('../../fiscal-schema/',import.meta.url),fixtures=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('test/fixture.mjs',root))],{maxBuffer:2000000,env:{PATH:'/usr/bin:/bin'},encoding:'utf8'}));
 const run=createFiscalSchemaRunner({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath:fileURLToPath(new URL('validator.py',root))});
 for(const [model,xml]of[['55',fixtures['55'].xml],['65',fixtures.nfceQrV3.xml]]){
  const bytes=Buffer.from(xml),expectedHash=createHash('sha256').update(bytes).digest('hex');const report=await run(bytes,{expectedModel:model,expectedHash});
  assert.equal(report.ok,true);assert.equal(report.xsdValidated,true);assert.equal(report.signatureVerified,false);assert.equal(report.canEmit,false);assert.equal(report.xmlDigest,expectedHash);
  const invalid=Buffer.from(xml.replace('<vNF>10.00</vNF>','<vNF>not-a-number</vNF>')),rejected=await run(invalid,{expectedModel:model,expectedHash:createHash('sha256').update(invalid).digest('hex')});assert.equal(rejected.ok,false);assert.equal(rejected.code,'XML_XSD_INVALID');assert.ok(rejected.diagnostics.length);
 }
});
