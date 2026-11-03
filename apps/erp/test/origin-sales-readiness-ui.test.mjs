import test from 'node:test';import assert from 'node:assert/strict';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {salesFixture,detail,page,source,observed,ACTOR,OTHER,BASE,deferred} from './helpers/sales-readiness-fixtures.mjs';
const mount=s=>mountComponent('OriginSalesReadiness.tsx',{controller:s.controller},{expandChildren:true});
const open=(v,id='100000')=>v.click(`Conferir venda ${id}`);

test('081 list and detail use only GET; exact prices, zero fiscal reference and backup remain distinct',async()=>{
 const s=salesFixture(),v=await mount(s);try{
  assert.equal(s.calls.length,1);assert.match(v.text(),/Código observado 0/);assert.doesNotMatch(v.text(),/Em aberto|Atendido/);assert.match(v.text(),/29\/02\/2024/);await open(v);
  assert.equal(s.calls.length,2);assert.ok(s.calls.every(c=>c.method==='GET'&&c.body===undefined));assert.match(v.text(),/12,1234567891/);assert.match(v.text(),/1,234567/);assert.match(v.text(),/Identificador zero, sem vínculo fiscal confirmado/);assert.match(v.text(),/Sem valor declarado/);
  assert.match(v.text(),/15,1234567891/);assert.match(v.text(),/2,5000/);assert.match(v.text(),/não substitui o preço unitário/);assert.match(v.text(),/não define preço líquido/);
  assert.match(v.text(),/A comparação por venda não foi realizada/);assert.match(v.text(),/não o histórico desta venda/);assert.match(v.text(),/A importação ainda não está disponível/);
  assert.equal(v.nodes().some(n=>['input','textarea','select'].includes(n.type)),false);assert.equal(v.nodes().some(n=>n.type==='button'&&/Importar|Salvar|Receber|Gerar|Confirmar/.test(String(n.props.children))),false);
  await v.click('Voltar à lista');assert.match(v.text(),/2 venda\(s\) nesta página/);assert.equal(s.calls.length,2);
 }finally{v.unmount();}
});

test('081 detail presents its current observation without treating a changed list snapshot or positive invoice as adoption',async()=>{
 const s=salesFixture({after(c,raw){if(!c.path.includes('?')){raw.source.source_version='3';raw.source.source_hash='c'.repeat(64);raw.source.capture={state:'unbound',profile:'origin-sales-price-json-v1',observed_at:raw.source.last_seen_at,response_sha256:'d'.repeat(64)};raw.source.situation={id:'9',value:observed('1')};raw.invoice_reference={state:'declared',source_id:'9001'};raw.issues=[{code:'PRICE_CAPTURE_CURRENT_MISSING',field:'itens.valor',position:null},{code:'INVOICE_REFERENCE_UNVERIFIED',field:'notaFiscal',position:null}];raw.history.exact_id_rows_uncompared='2';raw.history.backup_rows_without_source_id='28';}return raw;}}),v=await mount(s);
 try{await open(v);assert.match(v.text(),/Código observado 1.*situação ainda não classificada/);assert.match(v.text(),/Referência declarada, sem vínculo fiscal confirmado/);assert.match(v.text(),/Captura de preços não corresponde à observação atual/);assert.match(v.text(),/2 linha\(s\).*não foram comparadas nem adotadas/);assert.match(v.text(),/Versão observada\s*3/);assert.ok(s.calls.every(c=>c.method==='GET'));assert.equal(v.nodes().some(n=>n.type==='button'&&/Importar|Lançar|Reservar|Emitir/.test(String(n.props.children))),false);}
 finally{v.unmount();}
});
test('081 search resets the exact cursor; pagination uses pages without implying chronology',async()=>{
 const ids=Array.from({length:27},(_,i)=>String(100000+i)),s=salesFixture({ids}),v=await mount(s);try{
  assert.equal(v.button('Página anterior').disabled,true);await v.click('Próxima página');assert.match(s.calls.at(-1).path,/after=100024/);assert.match(v.text(),/Página 2/);assert.match(v.text(),/2 venda\(s\)/);await v.click('Página anterior');
  await v.change('sales-readiness-query','QA-100026');await v.submit();assert.match(s.calls.at(-1).path,/q=QA-100026/);assert.doesNotMatch(s.calls.at(-1).path,/after=/);assert.match(v.text(),/Página 1/);assert.equal(v.button('Próxima página').disabled,true);
 }finally{v.unmount();}
});
test('081 incomplete observations never become zeros, valid bindings or coverage; source text stays literal',async()=>{
 const s=salesFixture({after(call,raw){if(!call.path.startsWith(BASE+'?')){raw.source.capture={state:'absent',profile:null,observed_at:null,response_sha256:null};raw.source.date=observed('0000-00-00');raw.items[0].description=observed('<img src=x onerror=alert(1)>');raw.items[0].unit=observed('CX');raw.items[0].product.valid=false;raw.items[0].product.state='needs_review';raw.items[0].product.active=false;raw.items[0].quantity={state:'invalid',value:null};raw.items[0].quantity_supported=false;raw.commercial.freight=observed(undefined);raw.issues=[{code:'PRICE_CAPTURE_CURRENT_MISSING',field:'itens.valor',position:null},{code:'UNIT_DIFFERS_FROM_LINK',field:'itens.unidade',position:1}];}return raw;}}),v=await mount(s);try{await open(v);assert.match(v.text(),/0000-00-00/);assert.match(v.text(),/Captura exata de preços ainda não registrada/);assert.match(v.text(),/Correspondência precisa de revisão/);assert.match(v.text(),/Cadastro inativo/);assert.match(v.text(),/Unidade do cadastro: UN/);assert.match(v.text(),/Formato não suportado/);assert.match(v.text(),/Não informado na origem/);assert.match(v.text(),/<img src=x onerror=alert\(1\)>/);assert.equal(v.nodes().some(n=>n.type==='img'),false);assert.ok(s.calls.every(c=>c.method==='GET'));}finally{v.unmount();}
});
test('081 list/detail HTTP failures offer a fresh read, never mutations or fabricated absence',async()=>{
 let list=0,lookup=0;const s=salesFixture({before(c){if(c.path.startsWith(BASE+'?')&&++list===1)throw new AccessError(503);if(!c.path.includes('?')&&++lookup===1)throw new AccessError(404);}}),v=await mount(s);try{assert.match(v.text(),/Lista indisponível/);assert.doesNotMatch(v.text(),/Nenhuma venda encontrada/);await v.click('Atualizar lista');await open(v);assert.match(v.text(),/não está disponível na observação atual/);await v.click('Tentar consulta novamente');assert.match(v.text(),/Peça sintética/);assert.ok(s.calls.every(c=>c.method==='GET'));}finally{v.unmount();}
});
test('081 a late response after back cannot restore the cancelled detail',async()=>{
 const pending=deferred(),s=salesFixture({before(c){if(c.path===BASE+'/100000')return pending.promise;}}),v=await mount(s);try{await open(v);const call=s.calls.at(-1);await v.click('Voltar à lista');assert.equal(call.signal.aborted,true);await open(v,'100001');pending.resolve(detail('100000'));await v.flush();assert.match(v.text(),/Venda QA-100001/);assert.doesNotMatch(v.text(),/Venda QA-100000/);}finally{pending.resolve(detail());v.unmount();}
});
for(const loss of ['role','logout','actor'])test(`081 ${loss} hides data, aborts reads and rejects retained callbacks/late detail`,async()=>{
 const pending=deferred(),s=salesFixture({before(c){if(c.path===BASE+'/100000')return pending.promise;}}),v=await mount(s);try{
  const oldOpen=v.button('Conferir venda 100000').props.onClick;await open(v);const call=s.calls.at(-1),count=s.calls.length;
  s.setAccess(loss==='role'?{role:'consulta'}:loss==='logout'?{phase:'signed_out',actor:null}:{actor:OTHER});await v.flush();oldOpen();pending.resolve(detail());await v.flush();assert.equal(call.signal.aborted,true);assert.doesNotMatch(v.text(),/Peça sintética|Cliente sintético/);
  if(loss!=='actor')assert.equal(s.calls.length,count);else assert.equal(s.calls.filter(c=>!c.path.includes('?')).length,1);
  if(loss==='role'){s.setAccess({role:'admin'});await v.flush();assert.match(v.text(),/2 venda\(s\)/);assert.equal(s.calls.filter(c=>!c.path.includes('?')).length,1);}
 }finally{pending.resolve(detail());v.unmount();}
});
for(const phase of ['checking','error','signed_out'])test(`081 ${phase} with residual admin membership does not read`,async()=>{const s=salesFixture({phase}),v=await mount(s);try{assert.equal(s.calls.length,0);assert.doesNotMatch(v.text(),/QA-100000/);}finally{v.unmount();}});
test('081 a mismatched detail or promoted flags are rejected before display',async()=>{
 for(const change of [raw=>{raw.source.source_id='100001';},raw=>{raw.can_import=true;},raw=>{raw.coverage_certified=true;},raw=>{raw.native_effects=true;}]){
  const s=salesFixture({after(c,raw){if(!c.path.includes('?'))change(raw);return raw;}}),v=await mount(s);try{await open(v);assert.match(v.text(),/Não foi possível concluir a consulta/);assert.doesNotMatch(v.text(),/Peça sintética|Cliente sintético/);}finally{v.unmount();}
 }
});
