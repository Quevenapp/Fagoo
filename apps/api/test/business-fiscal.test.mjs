import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../packages/database/migrate.mjs';
import {buildAccessKey} from '../../../packages/fiscal-core/identity.mjs';
import {createFiscalService} from '../src/fiscal/service.mjs';
import {createBusinessService} from '../src/business/service.mjs';
import {handleFiscalRequest} from '../src/fiscal/router.mjs';
import {assertCommittedEventOrdering} from './support/event-ordering.mjs';

const COMPANY='12345678000195',SUPPLIER='11222333000181';
let db,pool,service,business,actor,storage,objects,puts;
before(async()=>{
  if(process.env.FISCAL_TEST_DATABASE_URL){const url=new URL(process.env.FISCAL_TEST_DATABASE_URL);assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.endsWith('_test'));const{Pool}=await import('pg');pool=new Pool({connectionString:url.href});}
  else{db=new PGlite();let pending=Promise.resolve();pool={query:(...a)=>db.query(...a),async connect(){const prior=pending;let unlock;pending=new Promise(r=>{unlock=r;});await prior;return{query:(...a)=>db.query(...a),exec:(...a)=>db.exec(...a),release:unlock};}};}
  await migrate(pool);
});
after(async()=>{await db?.close();await pool?.end?.();});
beforeEach(async()=>{
  await pool.query('TRUNCATE fagoo.company CASCADE');actor={id:'fiscal-test-admin',companyId:randomUUID(),scopes:['*']};await pool.query('INSERT INTO fagoo.company(id,name) VALUES($1,$2)',[actor.companyId,'Comércio fictício']);
  objects=new Map();puts=0;storage={async put(key,bytes){puts++;objects.set(key,Buffer.from(bytes));},async get(key){return objects.get(key);}};
  service=createFiscalService({pool,storage});business=createBusinessService(pool);await service.configure(actor,{command_id:randomUUID(),expected_version:1,document:COMPANY,tax_regime:'simples_nacional'});
});
function fixture({recipient=COMPANY,number='1'}={}){
  const key=buildAccessKey({cUF:'35',cnpj:SUPPLIER,model:'55',environment:'1',series:'1',number,issuedAt:'2026-11-02T12:00:00-03:00',cNF:'12345678',tpEmis:'1'});
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00"><ide><cUF>35</cUF><natOp>Venda de mercadorias</natOp><mod>55</mod><serie>1</serie><nNF>${number}</nNF><dhEmi>2026-11-02T12:00:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>1</finNFe><indFinal>0</indFinal><indPres>9</indPres></ide><emit><CNPJ>${SUPPLIER}</CNPJ><xNome>Fornecedor fictício</xNome><CRT>1</CRT></emit><dest><CNPJ>${recipient}</CNPJ><xNome>Comprador fictício</xNome><indIEDest>1</indIEDest></dest><det nItem="1"><prod><cProd>FOR-CAIXA</cProd><cEAN>SEM GTIN</cEAN><xProd>Produto de teste em caixa</xProd><NCM>39269090</NCM><CFOP>5102</CFOP><uCom>CX</uCom><qCom>2.0000</qCom><vUnCom>120.0000000000</vUnCom><vProd>240.00</vProd><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>240.00</vBC><pIPI>0.00</pIPI><vIPI>0.00</vIPI></IPITrib></IPI></imposto></det><total><ICMSTot><vNF>240.00</vNF></ICMSTot></total><transp><modFrete>9</modFrete></transp><cobr><dup><nDup>001</nDup><dVenc>2026-12-02</dVenc><vDup>240.00</vDup></dup></cobr></infNFe></NFe><protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${key}</chNFe><dhRecbto>2026-11-02T12:00:01-03:00</dhRecbto><nProt>135260000000001</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
}

test('XML import preserves the original privately, exposes uncertainty and has no commercial side effects',async()=>{
  const xml=fixture(),input={command_id:randomUUID(),xml};const result=await service.importXml(actor,input);
  assert.equal(result.invoice.total,'240.00');assert.equal(result.validation.signature_verified,false);assert.equal(result.validation.tax_rules_validated,false);assert.equal(result.validation.sefaz_checked,false);assert.equal(result.items[0].ipi.situation,'50');
  assert.equal((await service.importXml(actor,input)).replayed,true);assert.equal(puts,1);
  const again=await service.importXml(actor,{command_id:randomUUID(),xml});assert.equal(again.already_imported,true);assert.equal(puts,1);
  const download=await service.xml(actor,result.invoice.id);assert.equal(Buffer.from(download.bytes).toString(),xml);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM fagoo.stock_movement')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::integer AS n FROM fagoo.finance_title')).rows[0].n,0);assert.equal((await pool.query("SELECT count(*)::integer AS n FROM fagoo.event WHERE type='invoice.received'")).rows[0].n,1);
});

test('recipient, key integrity, dangerous XML and unavailable private storage are rejected',async()=>{
  await assert.rejects(service.importXml(actor,{command_id:randomUUID(),xml:fixture({recipient:SUPPLIER})}),/INVOICE_RECIPIENT_MISMATCH/);
  await assert.rejects(service.importXml(actor,{command_id:randomUUID(),xml:fixture().replace('<nfeProc','<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><nfeProc')}),/xml_invalid/);
  await assert.rejects(service.importXml(actor,{command_id:randomUUID(),xml:fixture().replace(/NFe([0-9]{43})[0-9]/,'NFe$19')}),/xml_not_authorized|ACCESS_KEY_INVALID|xml_invalid/);
  await assert.rejects(createFiscalService({pool,storage:null}).importXml(actor,{command_id:randomUUID(),xml:fixture()}),/PRIVATE_STORAGE_NOT_CONFIGURED/);
  assert.equal(puts,0);assert.equal((await pool.query('SELECT count(*)::integer AS n FROM fagoo.received_invoice')).rows[0].n,0);
});

test('supplier product candidates retain the packaging conversion and do not silently choose ambiguous names',async()=>{
  const contact=(await business.saveContact(actor,{command_id:randomUUID(),name:'Fornecedor cadastrado',kind:'supplier',document:SUPPLIER})).contact;
  const product=(await business.saveProduct(actor,{command_id:randomUUID(),code:'INTERNO-UN',name:'Produto em unidade',unit:'UN'})).product;
  await business.supplierProduct(actor,product.id,{command_id:randomUUID(),expected_version:1,supplier_id:contact.id,code:'FOR-CAIXA',unit_factor:'12'});
  const result=await service.importXml(actor,{command_id:randomUUID(),xml:fixture()});const detail=await service.detail(actor,result.invoice.id);const candidate=detail.product_candidates.items[0].candidates[0];assert.equal(candidate.product_id,product.id);assert.deepEqual(candidate.matched_by,['supplier_code']);assert.equal(candidate.unit_factor,'12.000000');assert.equal(candidate.unit_requires_review,true);
});

test('another company cannot read the XML and stored object corruption is detected',async()=>{
  const result=await service.importXml(actor,{command_id:randomUUID(),xml:fixture()});await assert.rejects(service.detail({...actor,companyId:randomUUID()},result.invoice.id),/NOT_FOUND/);
  const key=[...objects.keys()][0];objects.set(key,Buffer.from('<modified/>'));await assert.rejects(service.xml(actor,result.invoice.id),/XML_INTEGRITY_FAILED/);
});

test('a different XML cannot replace an imported key, and company identity is locked once documents exist',async()=>{
  await service.importXml(actor,{command_id:randomUUID(),xml:fixture()});await assert.rejects(service.importXml(actor,{command_id:randomUUID(),xml:fixture().replace('Produto de teste em caixa','Descrição modificada')}),/XML_CONFLICT_FOR_ACCESS_KEY/);
  await assert.rejects(service.configure(actor,{command_id:randomUUID(),expected_version:2,document:SUPPLIER,tax_regime:'lucro_real'}),/COMPANY_DOCUMENT_LOCKED/);
});

test('fiscal HTTP adapter enforces JSON, authorization and explicit authentication claims',async()=>{
  const response=await handleFiscalRequest(new Request('https://erp.example/api/v1/invoices/received/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command_id:randomUUID(),xml:fixture()})}),{pool,actor:{...actor,scopes:['fiscal:read']},storage});assert.equal(response.status,403);
  const config=await handleFiscalRequest(new Request('https://erp.example/api/v1/company/fiscal'),{pool,actor,storage});assert.equal(config.status,200);assert.equal((await config.json()).capabilities.xml_import,true);
});

test('PostgreSQL fiscal and commercial events share commit ordering across independent connections',{skip:!process.env.FISCAL_TEST_DATABASE_URL},async()=>{
  await assertCommittedEventOrdering({pool,actor,
    startEarlier:connectionPool=>createFiscalService({pool:connectionPool,storage}).importXml(actor,{command_id:randomUUID(),xml:fixture()}),
    startLater:connectionPool=>createBusinessService(connectionPool).saveProduct(actor,{command_id:randomUUID(),code:'AFTER-INVOICE',name:'Product created after invoice'})
  });
});
