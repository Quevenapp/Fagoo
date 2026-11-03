import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {fixture,detail,page,id,observed,OTHER,BASE,deferred} from './helpers/sales-history-fixtures.mjs';
const mount=f=>mountComponent('OriginSalesHistory.tsx',{controller:f.controller},{expandChildren:true});
const open=(v,n=1)=>v.click(`Consultar histórico ${100000+n}`);
const textOf=node=>Array.isArray(node)?node.map(textOf).join(''):node&&typeof node==='object'?textOf(node.props?.children):node===null||node===undefined||typeof node==='boolean'?'':String(node);
test('083 actual UI reads only separate historical records, exact observed values and current references',async()=>{
 const f=fixture(),v=await mount(f);try{assert.equal(f.calls.length,1);assert.match(v.text(),/QA-083-01/);assert.doesNotMatch(v.text(),/Atendido|Em aberto/);await open(v);assert.match(v.text(),/12,1234567891/);assert.match(v.text(),/1,234567/);assert.match(v.text(),/1\.21234567891e1/);assert.match(v.text(),/R\$ 14,97/);assert.match(v.text(),/inclusive zero.*não comprova/);
  const captured=v.find(n=>n.props['aria-label']==='Captura histórica imutável'),current=v.find(n=>n.props['aria-label']==='Correspondências atuais');assert.match(textOf(captured),/Cliente demonstrativo preservado|CX/);assert.doesNotMatch(textOf(captured),/Unidade do cadastro atual: UN/);assert.match(textOf(current),/Unidade do cadastro atual: UN/);assert.match(textOf(current),/mudaram após a captura/);assert.doesNotMatch(textOf(current),/12,1234567891/);
  assert.equal(v.nodes().some(n=>['input','textarea','select'].includes(n.type)),false);assert.equal(v.nodes().some(n=>n.type==='button'&&/Salvar|Capturar|Importar|Converter|Duplicar|Pedido nativo|Emitir|Receber/.test(textOf(n))),false);assert.ok(f.calls.every(c=>c.method==='GET'&&c.body===undefined));
  await v.click('Voltar à lista');assert.equal(f.calls.length,2);
 }finally{v.unmount();}
});
test('083 removed origin and changed current bindings do not erase or update the preserved snapshot',async()=>{
 const f=fixture(),v=await mount(f);try{await open(v,2);const old=v.text();assert.match(old,/Origem não disponível na coleta atual/);assert.match(old,/Componente demonstrativo preservado/);assert.match(old,/Correspondência atual precisa de revisão/);await v.click('Atualizar consulta');assert.equal(v.text(),old);assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.body===undefined));}finally{v.unmount();}
});
test('083 page cursors use historical IDs and searching resets the cursor without implying chronology',async()=>{
 const f=fixture({numbers:Array.from({length:27},(_,i)=>i+1)}),v=await mount(f);try{await v.click('Próxima página');assert.match(f.calls.at(-1).path,new RegExp(id(25)));assert.match(v.text(),/Página 2/);assert.match(v.text(),/2 registro/);await v.change('sales-history-query','QA-083-27');await v.submit();assert.match(f.calls.at(-1).path,/q=QA-083-27/);assert.doesNotMatch(f.calls.at(-1).path,/after=/);assert.match(v.text(),/Página 1/);assert.equal(v.button('Próxima página').disabled,true);}finally{v.unmount();}
});
test('083 stale list controls cannot inspect while a detail is selected or after list invalidation',async()=>{
 const f=fixture(),v=await mount(f);try{const old=v.button('Consultar histórico 100002').props.onClick;await open(v);old();await v.flush();assert.equal(f.calls.length,2);await v.click('Voltar à lista');const refresh=v.button('Atualizar lista').props.onClick;refresh();old();await v.flush();assert.equal(f.calls.length,3);assert.doesNotMatch(v.text(),/Cliente demonstrativo preservado/);}finally{v.unmount();}
});
test('083 malformed/missing observations stay explicit and source markup remains text',async()=>{
 const f=fixture({after(c,r){const summary=c.path.includes('?')?r.items[0]:r.snapshot;summary.capture={state:'absent',reason:null,profile:null,observed_at:null,response_sha256:null,numeric_tokens:null,scope:'numeric_itens_valor_only'};summary.date=observed('0000-00-00','string');if(!c.path.includes('?')){r.items[0].price_lexeme=null;r.items[0].description=observed('<img src=x onerror=alert(1)>','string');r.items[0].quantity={state:'invalid',kind:'string',value:'1,23'};r.snapshot.date=observed('0000-00-00','string');}return r;}}),v=await mount(f);try{await open(v);assert.match(v.text(),/Formato não conferido: 1,23/);assert.match(v.text(),/Captura exata de preços ausente/);assert.match(v.text(),/0000-00-00/);assert.match(v.text(),/<img src=x/);assert.equal(v.nodes().some(n=>n.type==='img'||n.props.dangerouslySetInnerHTML),false);assert.match(v.text(),/Não informado na origem|Sem valor declarado/);}finally{v.unmount();}
});
test('083 failed reads can be retried only as reads; a404 never removes the historical row',async()=>{
 let lists=0,details=0;const f=fixture({before(c){if(c.path.includes('?')&&++lists===1)throw new AccessError(503);if(!c.path.includes('?')&&++details===1)throw new AccessError(404);}}),v=await mount(f);try{assert.match(v.text(),/Lista indisponível/);assert.doesNotMatch(v.text(),/Nenhum registro preservado/);await v.click('Atualizar lista');await open(v);assert.match(v.text(),/registro não está disponível/);await v.click('Tentar consulta novamente');assert.match(v.text(),/Cliente demonstrativo preservado/);await v.click('Voltar à lista');assert.match(v.text(),/2 registro/);assert.ok(f.calls.every(c=>c.method==='GET'&&c.body===undefined));}finally{v.unmount();}
});
test('083 back cancels a pending detail and its late result cannot replace a new selection',async()=>{
 const gate=deferred(),f=fixture({before:c=>c.path===BASE+'/'+id(1)?gate.promise:undefined}),v=await mount(f);try{await open(v);const c=f.calls.at(-1);await v.click('Voltar à lista');assert.equal(c.signal.aborted,true);await open(v,2);gate.resolve(detail());await v.flush();assert.match(v.text(),/Venda QA-083-02/);assert.doesNotMatch(v.text(),/Venda QA-083-01/);}finally{gate.resolve(detail());v.unmount();}
});
for(const loss of ['role','actor','logout'])test(`083 ${loss} loss hides old data and rejects retained callbacks and late detail`,async()=>{
 const gate=deferred(),f=fixture({before:c=>c.path===BASE+'/'+id(1)?gate.promise:undefined}),v=await mount(f);try{const old=v.button('Consultar histórico 100001').props.onClick;await open(v);const c=f.calls.at(-1);f.setAccess(loss==='role'?{role:'consulta'}:loss==='actor'?{actor:OTHER}:{actor:null,phase:'signed_out'});await v.flush();old();gate.resolve(detail());await v.flush();assert.equal(c.signal.aborted,true);assert.doesNotMatch(v.text(),/Cliente demonstrativo preservado|Componente demonstrativo preservado/);assert.equal(f.calls.filter(c=>!c.path.includes('?')).length,1);if(loss==='role'){f.setAccess({role:'admin'});await v.flush();assert.match(v.text(),/2 registro/);}}finally{gate.resolve(detail());v.unmount();}
});
for(const phase of ['checking','error','signed_out'])test(`083 residual admin in phase ${phase} cannot start a read`,async()=>{const f=fixture({phase}),v=await mount(f);try{assert.equal(f.calls.length,0);assert.doesNotMatch(v.text(),/QA-083-01/);}finally{v.unmount();}});
test('083 detail identity and effect flags are checked before displaying private historical contents',async()=>{
 for(const change of [r=>r.snapshot.history_id=id(2),r=>r.snapshot.snapshot_hash='e'.repeat(64),r=>r.snapshot.source.source_hash='e'.repeat(64),r=>r.can_convert=true,r=>r.native_effects=true,r=>r.commercial_math_reconciled=true]){const f=fixture({after(c,r){if(!c.path.includes('?'))change(r);return r;}}),v=await mount(f);try{await open(v);assert.match(v.text(),/Não foi possível consultar/);assert.doesNotMatch(v.text(),/Cliente demonstrativo preservado/);}finally{v.unmount();}}
});
test('083 all250 captured items render without loss of exact numeric strings',async()=>{
 const data=detail();data.snapshot.item_count=250;data.snapshot.capture.numeric_tokens=250;data.items=Array.from({length:250},(_,i)=>({...structuredClone(data.items[0]),position:i+1,description:observed('Item preservado '+(i+1),'string')}));data.current.products=Array.from({length:250},(_,i)=>({...structuredClone(data.current.products[0]),position:i+1}));const listed=structuredClone(page([1]));listed.items[0]=data.snapshot;
 const f=fixture({before:c=>c.path.includes('?')?listed:data}),v=await mount(f);try{await open(v);assert.match(v.text(),/250\. Item preservado 250/);const region=v.find(n=>n.props['aria-label']==='Itens da captura histórica');assert.equal((textOf(region).match(/12,1234567891/g)||[]).length,250);assert.equal(f.calls.length,2);}finally{v.unmount();}
});
test('083 replacing a controller for the same actor clears the old detail and aborts its pending read',async()=>{
 const gate=deferred(),old=fixture({before:c=>c.path===BASE+'/'+id(1)?gate.promise:undefined}),fresh=fixture(),v=await mount(old);try{await open(v);const call=old.calls.at(-1);await v.updateProps({controller:fresh.controller});gate.resolve(detail());await v.flush();assert.equal(call.signal.aborted,true);assert.doesNotMatch(v.text(),/Cliente demonstrativo preservado/);assert.equal(fresh.calls.length,1);await open(v,2);assert.match(v.text(),/Venda QA-083-02/);}finally{gate.resolve(detail());v.unmount();}
});
// Model the native closed <details> semantics without asserting browser geometry.
const visibleText=node=>Array.isArray(node)?node.map(visibleText).join(''):node&&typeof node==='object'?(node.type==='details'&&!node.props.open?visibleText([node.props.children].flat(Infinity).find(child=>child?.type==='summary')):visibleText(node.props?.children)):node===null||node===undefined||typeof node==='boolean'?'':String(node);
test('083 compact presentation keeps commercial data visible and technical/current evidence closed without dropping it',async()=>{
 const f=fixture(),v=await mount(f);try{
  await open(v);const root=v.nodes()[0],visible=visibleText(root),all=v.text();
  assert.match(visible,/Histórico de vendas do Origin/);assert.match(visible,/Cliente demonstrativo preservado/);assert.match(visible,/12,1234567891/);assert.match(visible,/R\$ 14,97/);assert.match(visible,/sem recálculo/);assert.match(visible,/mudaram após a captura/);
  assert.doesNotMatch(visible,/bsh_|1\.21234567891e1|Unidade do cadastro atual|não pode ser convertido|sem classificação presumida|ID do cliente/);
  for(const label of ['Sobre este histórico','Correspondências atuais','Detalhes da importação']){const disclosure=v.find(n=>n.type==='details'&&textOf([n.props.children].flat(Infinity).find(c=>c?.type==='summary'))===label);assert.notEqual(disclosure.props.open,true);}
  assert.match(all,/bsh_|1\.21234567891e1/);assert.match(all,/Unidade do cadastro atual: UN/);assert.match(all,/inclusive zero.*não comprova/);assert.match(all,/não podem ser convertidos/);
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.method==='GET'&&c.body===undefined));
 }finally{v.unmount();}
});
for(const capture of ['absent','invalid'])test(`083 compact presentation keeps ${capture} price capture and removed source visible`,async()=>{
 const f=fixture({after(c,r){const summary=c.path.includes('?')?r.items[1]:r.snapshot;summary.capture={state:capture,reason:capture==='invalid'?'OTHER_PROFILE':null,profile:null,observed_at:null,response_sha256:null,numeric_tokens:null,scope:'numeric_itens_valor_only'};if(!c.path.includes('?'))r.items[0].price_lexeme=null;return r;}}),v=await mount(f);
 try{await open(v,2);const visible=visibleText(v.nodes()[0]);assert.match(visible,/Captura exata de preços/);assert.match(visible,/Origem não disponível na coleta atual/);assert.match(visible,/Componente demonstrativo preservado/);assert.match(visible,/sem recálculo/);}finally{v.unmount();}
});
