import test from'node:test';import assert from'node:assert/strict';
import{mountComponent,AccessError as HarnessAccessError}from'./helpers/component-recovery-harness.mjs';
import{createPreferencesFixture}from'../src/qa/preferences-fixture.ts';
import{preferencePage}from'../../../packages/erp-domain/src/preferences/catalog.mjs';
import{COMPANY_PREFERENCES}from'../src/lib/origin-menu.ts';
import{createActivityFixture}from'../src/qa/activity-fixture.ts';
import{companyFileType,fileRoute,sourceText,deletedFile}from'../src/lib/file-manager-model.ts';
import{createSystemFixture}from'../src/qa/system-fixture.ts';
import{companyData,identityDocumentKind,companyDocumentLabel}from'../src/lib/company-model.ts';
import{documentPrintModel}from'../src/lib/document-print-model.ts';
import{record as documentRecord}from'./helpers/document-commercial-fixtures.mjs';

// Mixed lane, wave G (299-305): synthetic controllers only, no DOM and no network.
let previous;
test.before(()=>{previous=globalThis.document;
 globalThis.document={activeElement:null,documentElement:{dataset:{}},getElementById:()=>null,addEventListener(){},removeEventListener(){},body:{append(){},classList:{add(){},remove(){}}},createElement:()=>({className:'',remove(){}})};});
test.after(()=>{globalThis.document=previous;});
const textOf=x=>Array.isArray(x)?x.map(textOf).join(''):x&&typeof x==='object'?textOf(x.props?.children):x===null||x===undefined||typeof x==='boolean'?'':String(x);
const posts=f=>f.calls.filter(c=>c.method==='POST');
const mountPreferences=(f,id)=>{const page=preferencePage(id);const category=COMPANY_PREFERENCES.find(c=>c.id===page.category);
 return mountComponent('PreferenceSettingsPage.tsx',{controller:f.controller,page,categoryLabel:category.label,categoryTo:`/preferencias/${category.id}`},{expandChildren:true,location:`/preferencias/${page.category}/${page.path}`});};

const PAYING='90000000-0000-4000-8000-000000000001',PICKING='90000000-0000-4000-8000-000000000002',OLD='90000000-0000-4000-8000-000000000003',GONE='90000000-0000-4000-8000-000000000009';
const situation=(id,name,base_status,base_label,active=true)=>({id,kind:'sales_orders',name,base_status,base_label,color:'#ff8800',active});
const SITUATIONS=[situation(PICKING,'Em separação','open','Em aberto'),situation(PAYING,'Aguardando pagamento','verified','Verificado'),situation(OLD,'Antiga','in_progress','Em andamento',false)];

test('299 EST-139 PRF-066 Situações de vendas consideradas offers the custom situações: chosen by id, covered by their default one',async()=>{
 const f=createPreferencesFixture({situations:SITUATIONS}),v=await mountPreferences(f,'suprimentos-estoque');try{
  await v.change('pref-estoque-reserva_por_situacao',true);
  assert.match(v.text(),/Situações personalizadas/);assert.match(v.text(),/Aguardando pagamento/);assert.match(v.text(),/Em separação/);
  // An inactive situação that is not chosen is not offered.
  assert.equal(v.nodes().some(n=>n.props?.id===`pref-estoque-reserva_situacoes-${OLD}`),false);
  await v.change(`pref-estoque-reserva_situacoes-${PAYING}`,true);await v.change(`pref-estoque-reserva_situacoes-${PICKING}`,true);
  // Verificado already considers "Aguardando pagamento": the custom one is checked, disabled and dropped from the value.
  await v.change('pref-estoque-reserva_situacoes-verificado',true);
  const covered=v.input(`pref-estoque-reserva_situacoes-${PAYING}`);assert.equal(covered.props.checked,true);assert.equal(covered.disabled,true);
  await v.click('Salvar');
  const sent=posts(f)[0].body.changes;
  assert.deepEqual(sent.find(c=>c.key==='estoque.reserva_situacoes').value,['verificado',PICKING]);
  assert.deepEqual(sent.find(c=>c.key==='estoque.reserva_por_situacao').value,true);
 }finally{v.unmount();}
 // A stored inactive or removed situação shows and can be unchecked; the custom ids stay ascending after the defaults.
 const g=createPreferencesFixture({situations:SITUATIONS});g.set('estoque.reserva_por_situacao',true);g.set('estoque.reserva_situacoes',['em_aberto',OLD,GONE]);
 const w=await mountPreferences(g,'suprimentos-estoque');try{
  assert.match(w.text(),/Antiga/);assert.match(w.text(),/inativa/);assert.match(w.text(),/Situação não encontrada/);
  // "Em separação" is based on Em aberto, already chosen: it shows as considered.
  assert.equal(w.input(`pref-estoque-reserva_situacoes-${PICKING}`).disabled,true);
  await w.change(`pref-estoque-reserva_situacoes-${GONE}`,false);await w.change(`pref-estoque-reserva_situacoes-${OLD}`,false);
  await w.change(`pref-estoque-reserva_situacoes-${PAYING}`,true);
  await w.click('Salvar');assert.deepEqual(posts(g)[0].body.changes,[{key:'estoque.reserva_situacoes',expected_version:1,value:['em_aberto',PAYING]}]);
 }finally{w.unmount();}
 // Without custom situações the screen says where to create them.
 const h=createPreferencesFixture(),x=await mountPreferences(h,'suprimentos-estoque');try{
  await x.change('pref-estoque-reserva_por_situacao',true);assert.match(x.text(),/Crie em Sistema › Gerenciador de transições/);
 }finally{x.unmount();}
});

// 301 PRF-238: Inserir Arquivo in the Gerenciador de arquivos.
const settle=async v=>{for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,20));await v.flush();}};
test('301 PRF-238 Inserir Arquivo sends a company file by command, keeps it until Conferir resultado and lists it in the origin Empresa',async()=>{
 assert.equal(companyFileType({name:'Contrato.PDF',size:10}),'application/pdf');assert.equal(companyFileType({name:'foto.jpeg',size:10}),'image/jpeg');
 assert.throws(()=>companyFileType({name:'planilha.xlsx',size:10}),/PDF, PNG, JPEG, XML ou TXT/);assert.throws(()=>companyFileType({name:'grande.pdf',size:10*1024*1024+1}),/até 10 MB/);
 const companyFile={id:'90000000-0000-4000-8000-000000000001',origin:'empresa',filename:'arquivo-x.pdf',mime_type:'application/pdf',size_bytes:3,sha256:'a'.repeat(64),source:{kind:'company_file',id:'90000000-0000-4000-8000-000000000001',code:null,label:'Arquivo da empresa'}};
 assert.equal(fileRoute(companyFile,'download'),'/v1/anexos-empresa/arquivos/90000000-0000-4000-8000-000000000001/download');
 assert.deepEqual(sourceText(companyFile),{text:'Arquivo da empresa',to:null});
 assert.equal(deletedFile({file:{id:companyFile.id,deleted:true}},companyFile.id),true);
 const f=createActivityFixture({failUploadOnce:true}),v=await mountComponent('RealFiles.tsx',{controller:f.controller},{expandChildren:true});try{
  await settle(v);const input=()=>v.nodes().find(n=>n.props?.id==='files-insert-input');
  assert.equal(v.button('Inserir Arquivo').disabled,false);
  // A type outside the attachment limits is refused in the browser, before any request.
  input().props.onChange({target:{files:[new File(['x'],'planilha.xlsx')]}});await settle(v);
  assert.match(v.text(),/Use um arquivo PDF, PNG, JPEG, XML ou TXT/);assert.equal(f.uploads.length,0);
  const pdf=new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
  input().props.onChange({target:{files:[new File([pdf],'Contrato social.pdf',{type:'application/pdf'})]}});await settle(v);
  // The answer of the upload was lost: the same operation stays pending, the screen is locked and the guard holds it.
  assert.match(v.text(),/O envio de Contrato social.pdf precisa ser confirmado/);assert.equal(v.guard().changed,true);assert.equal(v.button('Inserir Arquivo').disabled,true);
  await v.click('Conferir resultado');await settle(v);
  const posts=f.uploads.filter(u=>u.command);assert.equal(posts.length,1,'the reservation is not repeated once its id is known');
  assert.deepEqual(posts[0].body,{command_id:posts[0].command,filename:'Contrato social.pdf',mime_type:'application/pdf',size_bytes:pdf.length,sha256:posts[0].body.sha256});
  assert.equal(f.uploads.filter(u=>u.path.endsWith('/upload')).length,2);
  assert.match(v.text(),/Arquivo Contrato social.pdf incluído/);assert.equal(v.guard().changed,false);
  assert.match(v.text(),/arquivo-Contrato-social\.pdf.*Arquivo da empresa/s);
 }finally{v.unmount();}
 // Descartar o envio cancels a reservation whose bytes never arrived.
 const g=createActivityFixture({uploadFailure:'unsent'}),w=await mountComponent('RealFiles.tsx',{controller:g.controller},{expandChildren:true});try{
  await settle(w);w.nodes().find(n=>n.props?.id==='files-insert-input').props.onChange({target:{files:[new File(['Ata sintética.'],'ata.txt',{type:'text/plain'})]}});await settle(w);
  await w.click('Descartar o envio');await settle(w);
  assert.ok(g.uploads.some(u=>u.path.endsWith('/abort')));assert.match(w.text(),/Envio descartado/);assert.equal(w.guard().changed,false);
 }finally{w.unmount();}
});

const pick=(v,file)=>v.nodes().find(n=>n.props?.id==='files-insert-input').props.onChange({target:{files:[file]}});
// The screen sees the refusals of the fixture as the AccessError of the harness (status and code), as from the real access controller.
const bridged=f=>({...f.controller,async attachments(path,options){try{return await f.controller.attachments(path,options);}
 catch(e){if(typeof e?.status!=='number')throw e;const x=new HarnessAccessError(e.status);if(e.code)x.code=e.code;throw x;}}});
test('301 PRF-238 Inserir Arquivo never drops an attempt whose outcome is unknown, and ends one that has nothing left to discard',async()=>{
 const pdf=new TextEncoder().encode('%PDF-1.4\n%%EOF\n'),file=()=>new File([pdf],'Ata.pdf',{type:'application/pdf'});
 // Another request still holds the upload (409 of the upload itself): the attempt stays, and Conferir resultado completes it later.
 const f=createActivityFixture({uploadFailure:'conflict'}),v=await mountComponent('RealFiles.tsx',{controller:bridged(f)},{expandChildren:true});try{
  await settle(v);pick(v,file());await settle(v);
  assert.match(v.text(),/já foi incluído, está em envio por outra operação/);assert.match(v.text(),/O envio de Ata.pdf precisa ser confirmado/);assert.equal(v.guard().changed,true);
  await v.click('Conferir resultado');await settle(v);
  assert.equal(f.uploads.filter(u=>u.command).length,1);assert.match(v.text(),/Arquivo Ata.pdf incluído/);assert.equal(v.guard().changed,false);
 }finally{v.unmount();}
 // The upload went through but its answer was lost: Descartar o envio is refused (the file is ready) and ends the attempt; the list shows it.
 const g=createActivityFixture({failUploadOnce:true}),w=await mountComponent('RealFiles.tsx',{controller:bridged(g)},{expandChildren:true});try{
  await settle(w);pick(w,file());await settle(w);
  await w.click('Descartar o envio');await settle(w);
  assert.match(w.text(),/O envio não foi descartado: o arquivo já foi incluído/);assert.equal(w.guard().changed,false);
  assert.doesNotMatch(w.text(),/precisa ser confirmado/);assert.match(w.text(),/arquivo-Ata\.pdf/);
 }finally{w.unmount();}
 // The quota of company files: a definitive refusal of the reservation, with its own text.
 const h=createActivityFixture({uploadFailure:'quota'}),x=await mountComponent('RealFiles.tsx',{controller:bridged(h)},{expandChildren:true});try{
  await settle(x);pick(x,file());await settle(x);
  assert.match(x.text(),/limite de 5\.000 envios de arquivos da empresa/);assert.doesNotMatch(x.text(),/precisa ser confirmado/);assert.equal(x.guard().changed,false);
 }finally{x.unmount();}
});

// 302 PRF-294: Tipo da Pessoa = Pessoa Física keeps a CPF in the identity of the company.
test('302 PRF-294 with Pessoa Física the identity asks the CPF, warns about a stored CNPJ and sends the CPF with the reason',async()=>{
 const base={legal_name:'Produtor Sintético',trade_name:'',cnpj:'529.982.247-25',ie:'',postal_code:'13400000',street:'Estrada',number:'S/N',complement:'',district:'Rural',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:'',email:''};
 assert.equal(companyData(base,'cpf').cnpj,'52998224725');assert.throws(()=>companyData(base,'cnpj'),/Confira o CNPJ/);assert.throws(()=>companyData({...base,cnpj:'11222333000181'},'cpf'),/Confira o CPF/);
 assert.equal(identityDocumentKind('fisica','11.222.333/0001-81','11222333000181'),'any');assert.equal(identityDocumentKind('fisica','52998224725','11222333000181'),'cpf');
 assert.equal(identityDocumentKind(null,'x',null),'any');assert.equal(identityDocumentKind('juridica','x',null),'cnpj');
 assert.deepEqual([companyDocumentLabel('52998224725'),companyDocumentLabel('11222333000181')],['CPF','CNPJ']);
 const extra={person_type:'fisica',ie_exempt:false,municipal_registration:null,suframa:null,cnae:null,company_size:null,segments:['comercio'],revenue:null,employees:null,contacts:null,mobile:null,billing_email:null,site:null,substitute_ies:[]};
 const calls=[];const identity={legal_name:'Produtor Sintético',trade_name:null,cnpj:'11222333000181',ie:null,postal_code:'13400000',street:'Estrada',number:'S/N',complement:null,district:'Rural',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:null,email:null};
 const port={async company(path,options={}){calls.push({path,...options});
  if(path==='/v1/empresa')return{read_identity:true,write_identity:true,read_fiscal:false,write_fiscal:false,data_mode:'erp_native',emission_enabled:false};
  if(options.method==='POST')return{section:'identity',record:{version:2,data:{...identity,cnpj:options.body.data.cnpj},created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:00Z'},replayed:false,data_mode:'erp_native',emission_enabled:false};
  const last=calls.filter(c=>c.method==='POST').at(-1);
  return{section:'identity',record:{version:last?2:1,data:{...identity,...(last?{cnpj:last.body.data.cnpj}:{})},created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:00Z'},data_mode:'erp_native',emission_enabled:false};}};
 const f=createSystemFixture({extra}),v=await mountComponent('CompanySettings.tsx',{controller:{...port,...f.controller}},{location:'/empresa-configuracoes',expandChildren:true});try{
  for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,10));await v.flush();}
  assert.match(v.text(),/O Tipo da Pessoa é Pessoa Física, mas a identidade traz um CNPJ/);
  assert.ok(v.nodes().some(n=>n.type==='label'&&n.props.htmlFor==='company-cnpj'&&textOf(n.props.children)==='CPF *'));
  // The address alone still saves with the stored CNPJ (the server keeps an unchanged document).
  await v.change('company-street','Estrada Nova');await v.submit(0);
  assert.equal(calls.filter(c=>c.method==='POST').at(-1).body.data.cnpj,'11222333000181');
  for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,10));await v.flush();}
  await v.click('Corrigir dados bloqueados');await v.change('company-cnpj','11.222.333/0001-81');await v.change('company-cnpj','529.982.247-25');
  await v.change('company-locked-reason','CPF do produtor rural');await v.submit(0);
  const post=calls.filter(c=>c.method==='POST').at(-1);assert.deepEqual([post.body.data.cnpj,post.body.reason],['52998224725','CPF do produtor rural']);
 }finally{v.unmount();}
});

// 302 PRF-294: the prints of the documents and of the Frente de caixa label the document of a company of Pessoa Física as CPF.
test('302 PRF-294 the document and PDV prints say CPF for a company of Pessoa Física and CNPJ otherwise',async()=>{
 const identity=document=>({version:3,created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:00Z',data:{legal_name:'Produtor Sintético',trade_name:null,cnpj:document,ie:null,postal_code:'13400000',
  street:'Estrada',number:'S/N',complement:null,district:'Rural',city:'Piracicaba',municipality_code:'3538709',state:'SP',phone:null,email:null}});
 for(const[document,label]of[['52998224725','CPF'],['11222333000181','CNPJ']]){
  const model=documentPrintModel(documentRecord('sales_orders'),identity(document));
  for(const componentName of['DocumentPrintSheet','DocumentReceiptSheet']){
   const view=await mountComponent('DocumentPrintPreview.tsx',{model,format:'80mm'},{componentName});
   try{assert.match(view.text(),new RegExp(`${label}: ${document}`),componentName);}finally{view.unmount();}
  }
  const pdv=await mountComponent('PdvReceiptPrint.tsx',{job:{kind:'move',move:'withdrawal',store:'Loja Sintética',operator:'Operador Sintético',amount_cents:'1000',note:null,at:'2026-10-20T12:00:00Z'},
   receipt:{font_size:12},order:'insercao',company:{name:'Produtor Sintético',cnpj:document}},{componentName:'PdvReceiptSheet'});
  try{assert.match(pdv.text(),new RegExp(`Produtor Sintético${label}: ${document}Sangria de caixa`));}finally{pdv.unmount();}
 }
});
