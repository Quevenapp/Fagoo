import test from'node:test';import assert from'node:assert/strict';
import{mountComponent,AccessError}from'./helpers/component-recovery-harness.mjs';
import{createStockOpeningFixture}from'../src/qa/stock-opening-fixture.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
// Modal touches document focus; the harness has no DOM.
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,addEventListener(){},removeEventListener(){}};});test.after(()=>{globalThis.document=previous;});
const mount=f=>mountComponent('RealStockOpening.tsx',{controller:f.controller},{expandChildren:true});
const visible=n=>Array.isArray(n)?n.map(visible).join(''):n&&typeof n==='object'?n.props.hidden?'':visible(n.props.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);
const posts=(f,suffix)=>f.calls.filter(c=>c.method==='POST'&&c.path.endsWith(suffix));
const commandReads=(f,base='/v1/saldo-abertura-estoque/comandos/')=>f.calls.filter(c=>c.path.startsWith(base));
const pageReads=f=>f.calls.filter(c=>c.method==='GET'&&/\/v1\/saldo-abertura-estoque\/\d+\?/.test(c.path));
const hasButton=(v,label)=>v.nodes().some(n=>n.type==='button'&&visible(n)===label);
const openBatch=async v=>{await v.click('Adotar próximo lote');};
const confirmBatch=async v=>{await openBatch(v);await v.change('opening-confirm',true);await v.click('Adotar lote');};

test('100 screen loads linked warehouse, policy and preview; negatives and skipped reasons are explicit',async()=>{const f=createStockOpeningFixture(),v=await mount(f);try{
 assert.deepEqual(f.calls.map(c=>c.path.split('?')[0]),['/v1/saldo-abertura-estoque','/v1/politica-estoque','/v1/saldo-abertura-estoque/700001']);
 assert.equal(v.input('opening-warehouse').props.value,'700001');
 const text=v.text();for(const expected of['Positivos','Zerados','Negativos','Sem produto nativo','Inválidos','Com lançamentos nativos','Estoque negativo não permitido','−2,25','−1','O Origin continua mudando até a virada','unidade do cadastro do produto'])assert.ok(text.includes(expected),expected);
 assert.ok(v.nodes().some(n=>n.props.className==='stock-opening-negative'));
 assert.match(text,/2 par\(es\) pendente\(s\)/);assert.equal(v.button('Adotar próximo lote').disabled,false);
 await v.change('opening-group','invalid');assert.match(pageReads(f).at(-1).path,/grupo=invalid/);
 await v.change('opening-date','2999-01-01');assert.match(v.text(),/não pode estar no futuro/);assert.equal(v.button('Adotar próximo lote').disabled,true);
}finally{v.unmount();}});

test('100 next batch needs explicit confirmation, sends one pinned command, verifies by GET and shows per-item results',async()=>{const f=createStockOpeningFixture(),v=await mount(f);try{
 await openBatch(v);assert.equal(posts(f,'/lote').length,1);assert.deepEqual(posts(f,'/lote')[0].body,{occurred_on:v.input('opening-date').props.value,limit:100});
 assert.match(v.text(),/2 pares serão adotados/);assert.equal(v.button('Adotar lote').disabled,true);assert.equal(posts(f,'/adotar').length,0);
 await v.change('opening-confirm',true);await v.click('Adotar lote');
 assert.equal(posts(f,'/adotar').length,1);assert.equal(commandReads(f).length,1);const body=posts(f,'/adotar')[0].body;
 assert.deepEqual(Object.keys(body).sort(),['command_id','confirmed','items','occurred_on','preview_hash']);assert.deepEqual(body.items.map(i=>i.target),['10.500000','0.000000']);assert.deepEqual(body.items.map(i=>i.unit),['UN','UN']);
 assert.equal(commandReads(f)[0].path.split('/').at(-1),body.command_id);
 assert.match(v.text(),/2 concluídos/);assert.match(v.text(),/Saldo ajustado para 10,5 UN/);assert.match(v.text(),/Saldo zero registrado, sem movimento/);
 await v.click('Fechar');assert.match(v.text(),/0 par\(es\) pendente\(s\)/);assert.match(v.text(),/Adotado \(zero\)/);assert.equal(v.guard().busy,false);
}finally{v.unmount();}});

test('100 the unit shown in the batch is the one confirmed; a later unit change is reported per item and nothing is adopted for it',async()=>{
 const f=createStockOpeningFixture({after:(c,value)=>c.path.endsWith('/lote')?{...value,items:value.items.map(i=>i.product_source_id==='9101'?{...i,product:{...i.product,unit:'CX'}}:i)}:value}),v=await mount(f);try{
 await openBatch(v);assert.match(v.text(),/ajuste 10,5 CX/);await v.change('opening-confirm',true);await v.click('Adotar lote');
 assert.deepEqual(posts(f,'/adotar')[0].body.items.map(i=>[i.product_source_id,i.unit]),[['9101','CX'],['9102','UN']]);
 assert.match(v.text(),/A unidade do cadastro no FAGOO mudou depois da prévia/);assert.equal(f.receipts.has('9101'),false);assert.equal(f.receipts.get('9102').unit,'UN');
}finally{v.unmount();}});

test('100 lost answer keeps the same command; “Conferir resultado” reads it without a second POST',async()=>{const f=createStockOpeningFixture({lostAck:true}),v=await mount(f);try{
 await confirmBatch(v);const body=posts(f,'/adotar')[0].body;assert.match(v.text(),/Não foi possível confirmar o resultado/);assert.match(v.text(),new RegExp(body.command_id));
 assert.equal(hasButton(v,'Reenviar o mesmo comando'),false);assert.equal(v.guard().busy,true);
 await v.click('Fechar');assert.match(v.text(),/Conferir resultado da adoção/);
 await v.click('Conferir resultado');assert.match(v.text(),/2 concluídos/);assert.equal(posts(f,'/adotar').length,1);assert.equal(commandReads(f).length,1);
}finally{v.unmount();}});

test('100 only an authoritative GET 404 enables an explicit resend of the very same body',async()=>{let sends=0;const f=createStockOpeningFixture({before(c){if(c.path.endsWith('/adotar')&&++sends===1)throw new AccessError(503);if(c.path.includes('/comandos/')&&sends===1)throw new AccessError(404);}}),v=await mount(f);try{
 await confirmBatch(v);await v.click('Conferir resultado');assert.match(v.text(),/não comprova que nada foi adotado/);
 const first=posts(f,'/adotar')[0].body;await v.click('Reenviar o mesmo comando');assert.equal(posts(f,'/adotar').length,2);assert.deepEqual(posts(f,'/adotar')[1].body,first);assert.match(v.text(),/2 concluídos/);
}finally{v.unmount();}});

test('100 a definite refusal releases the batch and nothing is reported as adopted',async()=>{const f=createStockOpeningFixture({before(c){if(c.path.endsWith('/adotar'))throw new AccessError(409);}}),v=await mount(f);try{
 await confirmBatch(v);assert.match(v.text(),/Nada foi adotado/);assert.equal(hasButton(v,'Conferir resultado'),false);assert.equal(v.guard().busy,false);
 await v.click('Fechar');assert.equal(v.button('Adotar próximo lote').disabled,false);
}finally{v.unmount();}});

test('100 policy switch needs the explicit confirmation text and a reason; the change is verified by GET',async()=>{const f=createStockOpeningFixture(),v=await mount(f);try{
 assert.match(v.text(),/Não permitido/);await v.change('policy-switch',true);assert.match(v.text(),/Reservas continuam exigindo saldo disponível/);
 assert.equal(v.button('Confirmar alteração da política').disabled,true);await v.change('policy-reason','Venda sem saldo durante a virada');assert.equal(v.button('Confirmar alteração da política').disabled,true);
 await v.change('policy-confirm',true);await v.click('Confirmar alteração da política');
 assert.equal(posts(f,'/v1/politica-estoque').length,1);assert.deepEqual({...posts(f,'/v1/politica-estoque')[0].body,command_id:'x'},{command_id:'x',expected_version:0,allow_negative:true,reason:'Venda sem saldo durante a virada',confirmed:true});
 assert.equal(commandReads(f,'/v1/politica-estoque/comandos/').length,1);assert.match(v.text(),/Estoque negativo permitido a partir de agora/);assert.equal(f.policy.allow_negative,true);
 assert.match(v.text(),/A adotar \(negativo\)/);assert.match(v.text(),/3 par\(es\) pendente\(s\)/);
}finally{v.unmount();}});

test('100 lost policy answer is recovered by GET only',async()=>{const f=createStockOpeningFixture({lostAck:true}),v=await mount(f);try{
 await v.change('policy-switch',true);await v.change('policy-confirm',true);await v.change('policy-reason','Venda sem saldo durante a virada');await v.click('Confirmar alteração da política');
 assert.match(v.text(),/Não foi possível confirmar a alteração da política/);await v.click('Conferir resultado da política');
 assert.equal(posts(f,'/v1/politica-estoque').length,1);assert.match(v.text(),/Estoque negativo permitido a partir de agora/);
}finally{v.unmount();}});

test('100 same administrador losing the role keeps the pending command hidden; restoration only reads it',async()=>{const hold=deferred(),f=createStockOpeningFixture({before:c=>c.path.endsWith('/adotar')?hold.promise:undefined}),v=await mount(f);try{
 await confirmBatch(v);const call=posts(f,'/adotar')[0];f.setAccess({role:'estoque'});await v.flush();assert.equal(call.signal.aborted,true);
 assert.ok(v.nodes().some(n=>n.props.hidden&&n.props.inert&&n.props['aria-hidden']));assert.doesNotMatch(visible(v.nodes()[0]),/Produto sintético/);
 hold.resolve(undefined);await v.flush();f.setAccess({role:'admin'});await v.flush();assert.match(v.text(),new RegExp(call.body.command_id));
 await v.click('Conferir resultado');assert.equal(posts(f,'/adotar').length,1);assert.equal(commandReads(f).length,1);
}finally{hold.resolve(undefined);v.unmount();}});

for(const loss of['actor','logout'])test(`100 ${loss} discards the pending command and late answers`,async()=>{const hold=deferred(),f=createStockOpeningFixture({before:c=>c.path.endsWith('/adotar')?hold.promise:undefined}),v=await mount(f);try{
 await confirmBatch(v);const call=posts(f,'/adotar')[0];f.setAccess(loss==='actor'?{actor:'10000000-0000-4000-8000-000000000002'}:{actor:null,phase:'signed_out'});await v.flush();
 hold.resolve(undefined);await v.flush();assert.doesNotMatch(v.text(),new RegExp(call.body.command_id));assert.equal(posts(f,'/adotar').length,1);assert.equal(commandReads(f).length,0);
}finally{hold.resolve(undefined);v.unmount();}});

for(const role of['consulta','estoque','vendas','fiscal','financeiro'])test(`100 ${role} never reads or adopts`,async()=>{const f=createStockOpeningFixture();f.setAccess({role});const v=await mount(f);try{
 assert.equal(f.calls.length,0);assert.match(v.text(),/administrador/);
}finally{v.unmount();}});
