import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {RELEASE_NOTES,LATEST_RELEASE,releaseSeen,markReleaseSeen,RELEASE_SEEN_KEY} from '../src/lib/release-notes.ts';
import {HELP_TOPICS,helpTopic,isHelpPath} from '../src/lib/help-content.ts';
import {parseReference,referencePath,parseCep,fillAddress,parseTasks,taskResultText,parseExports,parseExportLink,parseNewInvoices,cnaeCodeOf} from '../src/lib/platform-model.ts';
import {parsePreferencesPath} from '../src/lib/preferences-route.ts';
import {COMPANY_PREFERENCES} from '../src/lib/origin-menu.ts';

// Synthetic data only. Leva H, lane plataforma: help, release notes, Novas NF-es, tasks, export, CEP and official tables.
const uid='a0000000-0000-4000-8000-000000000001';
const snapshot=role=>({phase:'ready',membership:{user_id:uid,role,resources:[]}});

test('PRF-255: the release notes kept in the repository are ordered, dated and about the FAGOO only',()=>{
 assert.equal(LATEST_RELEASE,RELEASE_NOTES[0]);
 for(const [i,note] of RELEASE_NOTES.entries()){
  assert.match(note.version,/^\d{4}\.\d{2}\.\d{2}$/);assert.match(note.date,/^\d{4}-\d{2}-\d{2}$/);assert.ok(note.items.length>0&&note.title);
  if(i)assert.ok(RELEASE_NOTES[i-1].version>note.version,'newest first, no repeated version');
  for(const item of note.items)assert.ok(!/Novidades no Origin/i.test(item));
 }
 const store=new Map(),storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
 assert.equal(releaseSeen(storage),false);markReleaseSeen(storage);assert.equal(store.get(RELEASE_SEEN_KEY),LATEST_RELEASE.version);assert.equal(releaseSeen(storage),true);
 assert.equal(releaseSeen({getItem:()=>{throw new Error('blocked');}}),false,'blocked storage shows the panel');
});

test('PRF-287, NFE-187, NFE-222: the Central de ajuda is an internal route with the main flows, coexistence and fiscal guidance',async()=>{
 assert.deepEqual(HELP_TOPICS.map(t=>t.slug),['primeiros-passos','convivencia','notas-fiscais','naturezas-operacao','exportacao']);
 assert.ok(isHelpPath('/ajuda')&&isHelpPath('/ajuda/notas-fiscais')&&!isHelpPath('/ajudas'));
 for(const topic of HELP_TOPICS)for(const section of topic.sections)for(const link of section.links??[]){
  assert.ok(Boolean(link.to)!==Boolean(link.href),link.label);
  if(link.href)assert.match(link.href,/^https:\/\/(www\.nfe\.fazenda\.gov\.br|concla\.ibge\.gov\.br)\//,'only official sources outside the app');
  if(link.to)assert.ok(!/origin\.com/.test(link.to));
 }
 assert.ok(helpTopic('convivencia').sections.some(s=>s.paragraphs.some(p=>/alteração mais recente/.test(p))));
 const index=await mountComponent('HelpCenter.tsx',{},{location:'/ajuda'});
 assert.match(index.text(),/Central de ajuda do FAGOO/);assert.match(index.text(),/Manual de notas fiscais/);assert.match(index.text(),/Novidades/);
 const notes=await mountComponent('HelpCenter.tsx',{},{location:'/ajuda/notas-fiscais'});
 assert.match(notes.text(),/Notas do Origin/);assert.match(notes.text(),/Portal Nacional da NF-e/);
 const natures=await mountComponent('HelpCenter.tsx',{},{location:'/ajuda/naturezas-operacao'});assert.match(natures.text(),/Manual de operações fiscais/);
 const news=await mountComponent('HelpCenter.tsx',{},{location:'/ajuda/novidades',expandChildren:['ReleaseNotesList']});assert.match(news.text(),new RegExp(`Versão ${LATEST_RELEASE.version.replace(/\./g,'\\.')}`));
 const missing=await mountComponent('HelpCenter.tsx',{},{location:'/ajuda/inexistente'});assert.match(missing.text(),/Tema não encontrado/);
});

test('PRF-252: Novas NF-es counts what the server counts and "Marcar como vistas" sends one command',async()=>{
 const calls=[];let total=3;
 const view=()=>({scope:'home_new_invoices',data_mode:'erp_native',since:'2026-10-14T12:00:00Z',seen_before:false,total,synced:2,received:1,as_of:'2026-10-21T12:00:00Z'});
 const controller={getSnapshot:()=>snapshot('fiscal'),async platform(path,options={}){calls.push({path,...options});
  if(path==='/v1/plataforma/novas-nfes/vistas'){total=0;return{scope:'home_new_invoices_seen',seen_at:'2026-10-21T12:00:00Z',replayed:false,view:{...view(),seen_before:true}};}
  return view();}};
 const card=await mountComponent('HomeNewInvoices.tsx',{controller});
 assert.match(card.text(),/3Novas NF-es/);assert.match(card.text(),/2 do histórico importado \(autorizadas ou com DANFE\)/);assert.match(card.text(),/1 recebida da SEFAZ/);assert.match(card.text(),/Rascunhos e homologação não entram/);
 await card.click('Marcar como vistas');
 const post=calls.find(c=>c.method==='POST');assert.match(post.body.command_id,/^[0-9a-f-]{36}$/);
 assert.match(card.text(),/0Novas NF-es/);assert.match(card.text(),/última visualização/);
 assert.throws(()=>parseNewInvoices({...view(),total:-1}));
 const none=await mountComponent('HomeNewInvoices.tsx',{controller:{}});assert.equal(none.text(),'','no card without the API');
});

test('PRF-280: Gestão de ações lists the server tasks with attempts and history',async()=>{
 const task={id:'b0000000-0000-4000-8000-000000000002',purpose:'notifications_generate',operation_id:'notificacoes:2026-10-21T10',status:'done',attempts:1,max_attempts:3,
  created_at:'2026-10-21T13:07:00Z',started_at:'2026-10-21T13:07:01Z',finished_at:'2026-10-21T13:07:02Z',next_attempt_at:null,error_code:null,requested_by_name:null,
  result:{day:'2026-10-21',created:4,members:2},history:[{attempt:1,started_at:'2026-10-21T13:07:01Z',finished_at:'2026-10-21T13:07:02Z',outcome:'done',error_code:null}]};
 const controller={getSnapshot:()=>snapshot('admin'),async platform(path){assert.equal(path,'/v1/plataforma/tarefas');return{scope:'platform_tasks',data_mode:'erp_native',all:true,items:[task]};}};
 const view=await mountComponent('PlatformTasks.tsx',{controller});
 assert.match(view.text(),/Gerar notificações internas/);assert.match(view.text(),/1 de 3/);assert.match(view.text(),/4 notificação\(ões\) nova\(s\) para 2 usuário\(s\)/);
 await view.click('Histórico');assert.match(view.text(),/Tentativa 1/);assert.match(view.text(),/concluída/);
 assert.equal(taskResultText({...task,status:'failed',attempts:3,result:null,error_code:'ERP_EXPORT_TOO_LARGE'}),'Falhou após 3 tentativas (ERP_EXPORT_TOO_LARGE).');
 assert.throws(()=>parseTasks({scope:'platform_tasks',all:true,items:[{...task,purpose:'outra'}]}));
 const broken=await mountComponent('PlatformTasks.tsx',{controller:{platform:async()=>({scope:'x'})}});assert.match(broken.text(),/Não foi possível carregar as tarefas/);
});

test('PRF-029: Backup asks for one export, shows the in-progress refusal and is only for the administrador',async()=>{
 const empty={scope:'platform_exports',data_mode:'erp_native',retention_days:7,link_seconds:120,items:[]};
 const queued={id:'c0000000-0000-4000-8000-000000000003',status:'queued',created_at:'2026-10-21T13:00:00Z',ready_at:null,expires_at:null,size_bytes:null,sha256:null,error_code:null,attempts:0,links:0,requested_by_name:'Admin',summary:null};
 let posts=0;
 const controller={getSnapshot:()=>snapshot('admin'),async platform(path,options={}){
  if(options.method==='POST'){posts++;if(posts>1){const e=new AccessError(409);e.field='export_in_progress';throw e;}return{export:queued,replayed:false,view:{...empty,items:[queued]},data_mode:'erp_native'};}
  return empty;}};
 const page=await mountComponent('CompanyExport.tsx',{controller},{location:'/preferencias/backup/exportacao'});
 assert.match(page.text(),/Nenhuma exportação pedida/);assert.match(page.text(),/link novo de 2 minutos/);
 await page.click('Gerar exportação');assert.match(page.text(),/Exportação pedida/);assert.match(page.text(),/Na fila/);
 assert.equal(page.button('Gerar exportação').props.disabled,true,'one export at a time');
 const other=await mountComponent('CompanyExport.tsx',{controller:{...controller,getSnapshot:()=>snapshot('financeiro')}});assert.match(other.text(),/Backup não liberado/);
 assert.throws(()=>parseExportLink({scope:'platform_export_link',expires_in:120,url:'https://evil.example/x',filename:'brufap-exportacao-2026-10-21-1300.zip'}));
 assert.equal(parseExportLink({scope:'platform_export_link',expires_in:120,url:'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/sign/brufap-exports/exports/x?token=t',filename:'brufap-exportacao-2026-10-21-1300.zip'}).filename,'brufap-exportacao-2026-10-21-1300.zip');
 assert.throws(()=>parseExports({...empty,retention_days:30}));
 assert.deepEqual(parsePreferencesPath('/preferencias/backup/exportacao'),{kind:'backup'});
 const entry=COMPANY_PREFERENCES.find(c=>c.id==='backup').sections[0].entries.find(e=>e.label==='Backup');assert.equal(entry.to,'/preferencias/backup/exportacao');
});

test('NFE-103: Buscar CEP fills only the empty fields and keeps manual entry when the lookup fails',async()=>{
 const address={scope:'cep_lookup',cep:'01001000',street:'Praça da Sé',complement:'lado ímpar',district:'Sé',city:'São Paulo',state:'SP',ibge_code:'3550308',source:'ViaCEP',data_mode:'external_lookup'};
 assert.deepEqual(fillAddress({street:'Rua digitada',district:null,city:'',state:null,complement:null,number:'10'},parseCep(address,'01001-000')),
  {street:'Rua digitada',district:'Sé',city:'São Paulo',state:'SP',complement:'lado ímpar',number:'10'});
 assert.throws(()=>parseCep({...address,cep:'02002000'},'01001000'));
 let found=null;
 const ok=await mountComponent('CepLookupButton.tsx',{id:'cep',cep:'01001-000',onFound:a=>{found=a;},controller:{platform:async path=>{assert.equal(path,'/v1/plataforma/cep/01001000');return address;}}});
 await ok.click('Buscar CEP');assert.equal(found.city,'São Paulo');assert.match(ok.text(),/Confira antes de salvar/);
 const missing=await mountComponent('CepLookupButton.tsx',{id:'cep',cep:'99999999',onFound:()=>assert.fail('nothing to fill'),controller:{platform:async()=>{throw new AccessError(404);}}});
 await missing.click('Buscar CEP');assert.match(missing.text(),/Preencha o endereço manualmente/);
 const short=await mountComponent('CepLookupButton.tsx',{id:'cep',cep:'123',onFound:()=>assert.fail('no call'),controller:{platform:async()=>assert.fail('no call')}});
 await short.click('Buscar CEP');assert.match(short.text(),/8 dígitos/);
});

test('PRF-296, CTT-045, VND-042: official table answers are parsed with their source and version',()=>{
 assert.equal(referencePath('municipios','alta floresta','RO'),'/v1/plataforma/referencias/municipios?q=alta+floresta&uf=RO');
 assert.equal(referencePath('paises','',null),'/v1/plataforma/referencias/paises');
 const dataset={source:'IBGE/CONCLA',source_url:'https://servicodados.ibge.gov.br/api/v2/cnae/subclasses',version:'CNAE 2.3 (subclasses)',fetched_on:'2026-10-21',rows:1332};
 const cnae=parseReference({scope:'reference_search',data_mode:'erp_native',table:'cnae',dataset,items:[{code:'4744-0/01',description:'COMÉRCIO VAREJISTA DE FERRAGENS E FERRAMENTAS',section:'G'}]},'cnae');
 assert.deepEqual(cnae.items[0],{code:'4744-0/01',label:'COMÉRCIO VAREJISTA DE FERRAGENS E FERRAMENTAS',detail:'Seção G'});assert.equal(cnae.dataset.version,'CNAE 2.3 (subclasses)');
 const country=parseReference({scope:'reference_search',table:'paises',dataset,items:[{code:'0230',name:'ALEMANHA'}]},'paises');assert.equal(country.items[0].detail,'cPais 0230');
 assert.throws(()=>parseReference({scope:'reference_search',table:'paises',dataset,items:[{code:'0230',name:'ALEMANHA'}]},'cnae'));
 assert.equal(cnaeCodeOf('4744-0/01 COMÉRCIO'),'4744-0/01');
});
