import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {purchaseFixture,detail,page,source,observed,ACTOR,OTHER,BASE,deferred} from './helpers/purchase-readiness-fixtures.mjs';
const mount=s=>mountComponent('OriginPurchaseReadiness.tsx',{controller:s.controller},{expandChildren:true});
const open=(v,id='100000')=>v.click(`Conferir compra ${id}`);

test('076 list and detail use only GET; exact prices, zero fiscal reference and backup remain distinct',async()=>{
 const s=purchaseFixture(),v=await mount(s);try{
  assert.equal(s.calls.length,1);assert.match(v.text(),/Em aberto/);assert.match(v.text(),/29\/02\/2024/);await open(v);
  assert.equal(s.calls.length,2);assert.ok(s.calls.every(c=>c.method==='GET'&&c.body===undefined));assert.match(v.text(),/12,1234567891/);assert.match(v.text(),/1,234567/);assert.match(v.text(),/Identificador zero, sem vínculo fiscal confirmado/);assert.match(v.text(),/Sem valor declarado/);
  assert.match(v.text(),/A comparação por compra está indisponível/);assert.match(v.text(),/não o histórico desta compra/);assert.match(v.text(),/A importação ainda não está disponível/);
  assert.equal(v.nodes().some(n=>['input','textarea','select'].includes(n.type)),false);assert.equal(v.nodes().some(n=>n.type==='button'&&/Importar|Salvar|Receber|Gerar|Confirmar/.test(String(n.props.children))),false);
  await v.click('Voltar à lista');assert.match(v.text(),/2 compra\(s\) nesta página/);assert.equal(s.calls.length,2);
 }finally{v.unmount();}
});
test('076 search resets the exact cursor; pagination uses pages without implying chronology',async()=>{
 const ids=Array.from({length:27},(_,i)=>String(100000+i)),s=purchaseFixture({ids}),v=await mount(s);try{
  assert.equal(v.button('Página anterior').disabled,true);await v.click('Próxima página');assert.match(s.calls.at(-1).path,/after=100024/);assert.match(v.text(),/Página 2/);assert.match(v.text(),/2 compra\(s\)/);await v.click('Página anterior');
  await v.change('purchase-readiness-query','QA-100026');await v.submit();assert.match(s.calls.at(-1).path,/q=QA-100026/);assert.doesNotMatch(s.calls.at(-1).path,/after=/);assert.match(v.text(),/Página 1/);assert.equal(v.button('Próxima página').disabled,true);
 }finally{v.unmount();}
});
test('076 incomplete observations never become zeros, valid bindings or coverage; source text stays literal',async()=>{
 const s=purchaseFixture({after(call,raw){if(!call.path.startsWith(BASE+'?')){raw.source.capture={state:'absent',profile:null,observed_at:null,response_sha256:null};raw.source.date=observed('0000-00-00');raw.items[0].description=observed('<img src=x onerror=alert(1)>');raw.items[0].unit=observed('CX');raw.items[0].product.valid=false;raw.items[0].product.state='needs_review';raw.items[0].product.active=false;raw.items[0].quantity={state:'invalid',value:null};raw.items[0].quantity_supported=false;raw.commercial.freight=observed(undefined);raw.issues=[{code:'PRICE_CAPTURE_CURRENT_MISSING',field:'itens.valor',position:null},{code:'UNIT_DIFFERS_FROM_LINK',field:'itens.unidade',position:1}];}return raw;}}),v=await mount(s);try{await open(v);assert.match(v.text(),/0000-00-00/);assert.match(v.text(),/Captura exata de preços ainda não registrada/);assert.match(v.text(),/Correspondência precisa de revisão/);assert.match(v.text(),/Cadastro inativo/);assert.match(v.text(),/Unidade do cadastro: UN/);assert.match(v.text(),/Formato não suportado/);assert.match(v.text(),/Não informado na origem/);assert.match(v.text(),/<img src=x onerror=alert\(1\)>/);assert.equal(v.nodes().some(n=>n.type==='img'),false);assert.ok(s.calls.every(c=>c.method==='GET'));}finally{v.unmount();}
});
test('076 list/detail HTTP failures offer a fresh read, never mutations or fabricated absence',async()=>{
 let list=0,lookup=0;const s=purchaseFixture({before(c){if(c.path.startsWith(BASE+'?')&&++list===1)throw new AccessError(503);if(!c.path.includes('?')&&++lookup===1)throw new AccessError(404);}}),v=await mount(s);try{assert.match(v.text(),/Lista indisponível/);assert.doesNotMatch(v.text(),/Nenhuma compra encontrada/);await v.click('Atualizar lista');await open(v);assert.match(v.text(),/não está disponível na observação atual/);await v.click('Tentar consulta novamente');assert.match(v.text(),/Peça sintética/);assert.ok(s.calls.every(c=>c.method==='GET'));}finally{v.unmount();}
});
test('076 a late response after back cannot restore the cancelled detail',async()=>{
 const pending=deferred(),s=purchaseFixture({before(c){if(c.path===BASE+'/100000')return pending.promise;}}),v=await mount(s);try{await open(v);const call=s.calls.at(-1);await v.click('Voltar à lista');assert.equal(call.signal.aborted,true);await open(v,'100001');pending.resolve(detail('100000'));await v.flush();assert.match(v.text(),/Compra QA-100001/);assert.doesNotMatch(v.text(),/Compra QA-100000/);}finally{pending.resolve(detail());v.unmount();}
});
for(const loss of ['role','logout','actor'])test(`076 ${loss} hides data, aborts reads and rejects retained callbacks/late detail`,async()=>{
 const pending=deferred(),s=purchaseFixture({before(c){if(c.path===BASE+'/100000')return pending.promise;}}),v=await mount(s);try{
  const oldOpen=v.button('Conferir compra 100000').props.onClick;await open(v);const call=s.calls.at(-1),count=s.calls.length;
  s.setAccess(loss==='role'?{role:'consulta'}:loss==='logout'?{phase:'signed_out',actor:null}:{actor:OTHER});await v.flush();oldOpen();pending.resolve(detail());await v.flush();assert.equal(call.signal.aborted,true);assert.doesNotMatch(v.text(),/Peça sintética|Fornecedor sintético/);
  if(loss!=='actor')assert.equal(s.calls.length,count);else assert.equal(s.calls.filter(c=>!c.path.includes('?')).length,1);
  if(loss==='role'){s.setAccess({role:'admin'});await v.flush();assert.match(v.text(),/2 compra\(s\)/);assert.equal(s.calls.filter(c=>!c.path.includes('?')).length,1);}
 }finally{pending.resolve(detail());v.unmount();}
});
for(const phase of ['checking','error','signed_out'])test(`076 ${phase} with residual admin membership does not read`,async()=>{const s=purchaseFixture({phase}),v=await mount(s);try{assert.equal(s.calls.length,0);assert.doesNotMatch(v.text(),/QA-100000/);}finally{v.unmount();}});
test('076 a mismatched detail or promoted flags are rejected before display',async()=>{
 for(const change of [raw=>{raw.source.source_id='100001';},raw=>{raw.can_import=true;},raw=>{raw.coverage_certified=true;},raw=>{raw.native_effects=true;}]){
  const s=purchaseFixture({after(c,raw){if(!c.path.includes('?'))change(raw);return raw;}}),v=await mount(s);try{await open(v);assert.match(v.text(),/Não foi possível concluir a consulta/);assert.doesNotMatch(v.text(),/Peça sintética|Fornecedor sintético/);}finally{v.unmount();}
 }
});
