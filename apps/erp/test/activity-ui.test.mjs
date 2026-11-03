import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createActivityFixture}from'../src/qa/activity-fixture.ts';
import{periodRange,todaySP}from'../src/lib/activity-model.ts';
import{resolvePreferences}from'../src/lib/origin-menu.ts';
let previous,clicked=0;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){},body:{append(){}},createElement:()=>({click(){clicked++;},remove(){}})};
 globalThis.URL.createObjectURL??=()=>'blob:synthetic';globalThis.URL.revokeObjectURL??=()=>{};});test.after(()=>{globalThis.document=previous;});
const textOf=n=>Array.isArray(n)?n.map(textOf).join(''):n&&typeof n==='object'?textOf(n.props?.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);

test('118 Registro de atividades starts empty, searches with the Origin filters and shows module and operation names',async()=>{const f=createActivityFixture(),v=await mountComponent('RealActivity.tsx',{controller:f.controller},{expandChildren:true});try{
 assert.match(v.text(),/Nenhuma pesquisa realizada.*Selecione os filtros e clique em Pesquisar/s);assert.equal(f.calls.length,0);
 for(const label of['Filtrar resultados','Período','Módulo','Operação','Usuário','Limpar filtros','Pesquisar','Últimos incluídos','Do mês','Do dia','De um período'])assert.ok(v.text().includes(label),label);
 await v.change('activity-module','estoque');await v.click('Pesquisar');const today=todaySP(),range=periodRange('ultimos',today);
 assert.deepEqual(f.calls,[`/v1/registro-atividades?de=${range.from}&ate=${range.to}&modulo=estoque`]);assert.match(v.text(),/Estoque.*Lançamento.*REF-1.*Entrada sintética/s);
 // 186: the Módulo filter uses the Origin names and order, then the Brufap modules Origin does not list; 232 adds Campos Customizados and Comissão.
 const options=v.find(n=>n.type==='select'&&n.props.id==='activity-module').props.children[1].map(o=>textOf(o));
 assert.deepEqual(options.slice(0,15),['Campos Customizados','Certificado Digital','Caixa','Comissão','Contas a Pagar/Receber','Contato','Estoque','Geração de cobranças','Notas Fiscais','Ordens de Serviço','Pagamento/Recebimento','Pedidos de Compra','Pedidos de Venda','Produto','Propostas Comerciais']);
 assert.ok(options.includes('Meu Negócio')&&!options.includes('Cotações Frenet'));
 await v.change('activity-period','periodo');await v.change('activity-from','2026-10-25');await v.change('activity-to','2026-10-01');await v.click('Pesquisar');assert.match(v.text(),/Informe um período válido/);
 await v.click('Limpar filtros');assert.match(v.text(),/Nenhuma pesquisa realizada/);
}finally{v.unmount();}});

test('118 Consulta de exclusões realizadas lists only deletions of the month with the Origin description',async()=>{const f=createActivityFixture(),v=await mountComponent('RealActivity.tsx',{controller:f.controller,mode:'deletions'},{expandChildren:true});try{
 assert.match(f.calls[0],/operacao=exclusao/);assert.match(v.text(),/Usuários.*Usuário Vendas Sintético excluído pelo usuário Administrador Sintético/s);assert.doesNotMatch(v.text(),/Produto sintético/);
 assert.match(v.text(),/No FAGOO nada é apagado/);
}finally{v.unmount();}});

const settle=async v=>{for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,20));await v.flush();}};
const rowOf=(v,name)=>v.find(n=>n.type==='tr'&&textOf(n).includes(name));
const inRow=(v,name,label)=>{const row=rowOf(v,name),found=[];const walk=x=>{if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object'){if(x.type==='button'&&textOf(x)===label)found.push(x);walk(x.props?.children);}};walk(row.props.children);return found[0];};
test('118/263 Gerenciador de arquivos lists every origin with Miniatura, verifies each download and keeps the source of each file',async()=>{const f=createActivityFixture(),v=await mountComponent('RealFiles.tsx',{controller:f.controller},{expandChildren:true});try{
 await settle(v);
 assert.match(v.text(),/contrato\.pdf.*Administrador Sintético.*3 B.*Pedido de venda nº 1001 · Cliente Sintético/s);assert.match(v.text(),/Imagem do produto CAN-1 · Caneta sintética/);assert.match(v.text(),/Quantidade de arquivos2/);
 const thumb=v.nodes().find(n=>n.type==='img'&&n.props.className==='real-files-thumb');assert.match(thumb.props.src,/^data:image\/png;base64,/);assert.equal(thumb.props.alt,'Miniatura de anexo-caneta.png');
 assert.equal(v.nodes().filter(n=>n.type==='img').length,1,'the PDF has no miniatura');
 const before=f.downloads.length;inRow(v,'contrato.pdf','Baixar arquivo').props.onClick();await settle(v);
 assert.deepEqual(f.downloads.slice(before),['/v1/documentos/sales_orders/40000000-0000-4000-8000-000000000118/anexos/50000000-0000-4000-8000-000000000118/download']);assert.match(v.text(),/Download preparado/);assert.equal(clicked,1);
 // 301 (mixed lane, wave G): Inserir Arquivo sends a company file; public and private stay unavailable (every file is private).
 assert.equal(v.button('Inserir Arquivo').disabled,false);
 for(const label of['Tornar público selecionados','Tornar privado selecionados'])assert.equal(v.button(label).disabled,true,label);
 v.find(n=>n.props['aria-label']==='Abrir filtro').props.onClick();await v.flush();await v.change('files-order','nome');v.find(n=>n.type==='button'&&textOf(n)==='Filtrar').props.onClick();await v.flush();
 assert.equal(f.calls.at(-1),'/v1/gerenciador-arquivos?ordem=nome');assert.match(v.text(),/Ordenação: Nome/);
 v.find(n=>n.props['aria-label']==='Abrir filtro').props.onClick();await v.flush();await v.change('files-origin','produtos');v.find(n=>n.type==='button'&&textOf(n)==='Filtrar').props.onClick();await settle(v);
 assert.equal(f.calls.at(-1),'/v1/gerenciador-arquivos?ordem=nome&origem=produtos');assert.match(v.text(),/Origem: Produtos/);assert.doesNotMatch(v.text(),/contrato\.pdf/);
}finally{v.unmount();}});

test('263 Excluir os anexos selecionados asks first, keeps the commands until "Conferir resultado" and uses the route of each origin; Fazer download takes the selection',async()=>{
 const f=createActivityFixture({failDeleteOnce:true}),v=await mountComponent('RealFiles.tsx',{controller:f.controller},{expandChildren:true});try{
  await settle(v);
  assert.equal(v.find(n=>n.props['aria-label']==='Excluir os anexos selecionados').disabled,true,'nothing selected');
  for(const name of['contrato.pdf','anexo-caneta.png'])v.find(n=>n.type==='input'&&n.props['aria-label']===`Selecionar ${name}`).props.onChange({target:{checked:true}});await v.flush();
  // Documentos lane (wave F): the selection is checked file by file and saved as one ZIP.
  const before=f.downloads.length,made=[],create=URL.createObjectURL;URL.createObjectURL=blob=>{made.push(blob);return'blob:synthetic';};
  try{await v.click('Fazer download');await settle(v);}finally{URL.createObjectURL=create;}
  assert.equal(f.downloads.length-before,2);assert.match(v.text(),/2 arquivos baixados em um ZIP\./);assert.equal(made.length,1);assert.equal(made[0].type,'application/zip');
  v.find(n=>n.props['aria-label']==='Excluir os anexos selecionados').props.onClick();await v.flush();
  assert.match(v.text(),/Excluir 2 arquivos\?/);assert.equal(f.deletions.length,0,'nothing is deleted before the confirmation');
  await v.click('Excluir');await settle(v);
  assert.match(v.text(),/A exclusão de 2 arquivo\(s\) precisa ser confirmada/);assert.equal(v.guard().changed,true);
  await v.click('Conferir resultado');await settle(v);
  const paths=f.deletions.map(d=>d.path);
  assert.deepEqual(paths,['/v1/documentos/sales_orders/40000000-0000-4000-8000-000000000118/anexos/50000000-0000-4000-8000-000000000118/exclusao','/v1/documentos/sales_orders/40000000-0000-4000-8000-000000000118/anexos/50000000-0000-4000-8000-000000000118/exclusao',
   '/v1/anexos-cadastros/produtos/70000000-0000-4000-8000-000000000263/80000000-0000-4000-8000-000000000263/exclusao']);
  assert.equal(f.deletions[0].command,f.deletions[1].command,'the same command is repeated');
  assert.match(v.text(),/Arquivos excluídos/);assert.equal(v.guard().changed,false);assert.match(v.text(),/Nenhum arquivo encontrado/);
 }finally{v.unmount();}
});

test('118 the three screens are administrador-only, in the hub and in the address list',async()=>{
 for(const role of['consulta','vendas','financeiro','estoque','fiscal']){
  for(const[file,props]of[['RealActivity.tsx',{}],['RealActivity.tsx',{mode:'deletions'}],['RealFiles.tsx',{}]]){const f=createActivityFixture({role}),v=await mountComponent(file,{controller:f.controller,...props},{expandChildren:true});try{assert.match(v.text(),/não liberad/);assert.equal(f.calls.length,0);}finally{v.unmount();}}
  // Relatórios customizados (149) is open to every profile: each one sees the reports shared with it, within its own data.
  assert.equal(resolvePreferences({role}).some(c=>c.entries.some(e=>e.to.startsWith('/preferencias/sistema/')&&!['/preferencias/sistema/interface','/preferencias/sistema/relatorios-customizados'].includes(e.to))),false,role);}
 const admin=resolvePreferences({role:'admin'}).flatMap(c=>c.entries.map(e=>e.to));
 for(const to of['/preferencias/sistema/registro-atividades','/preferencias/sistema/consulta-exclusoes','/preferencias/sistema/gerenciador-arquivos','/preferencias/sistema/usuarios'])assert.ok(admin.includes(to),to);
 const f=createActivityFixture(),v=await mountComponent('RealFiles.tsx',{controller:f.controller},{expandChildren:true});try{f.setAccess({role:'vendas'});await v.flush();assert.match(v.text(),/Gerenciador de arquivos não liberado/);}finally{v.unmount();}
});

test('118 an over-long search is a message, never a broken screen; exclusions show the month they cover',async()=>{
 const f=createActivityFixture(),v=await mountComponent('RealFiles.tsx',{controller:f.controller},{expandChildren:true});try{const before=f.calls.length;
  v.find(n=>n.type==='input'&&n.props['aria-label']==='Pesquisar na listagem').props.onChange({target:{value:'x'.repeat(121)}});await v.flush();await v.submit(0);
  assert.match(v.text(),/A pesquisa aceita até 120 caracteres/);assert.equal(f.calls.length,before);assert.match(v.text(),/contrato\.pdf/);}finally{v.unmount();}
 const g=createActivityFixture(),w=await mountComponent('RealActivity.tsx',{controller:g.controller,mode:'deletions'},{expandChildren:true});try{
  const today=todaySP();assert.equal(w.input('deletions-from').props.value,`${today.slice(0,7)}-01`);assert.equal(w.input('deletions-to').props.value,today);
  const before=g.calls.length;w.find(n=>n.type==='input'&&n.props['aria-label']==='Pesquisar na listagem').props.onChange({target:{value:'y'.repeat(121)}});await w.flush();await w.submit(0);
  assert.match(w.text(),/A pesquisa aceita até 120 caracteres/);assert.equal(g.calls.length,before);}finally{w.unmount();}
});

test('148 Registro de atividades opens "Detalhes do registro" with antes e depois; modules without them show no detail',async()=>{const f=createActivityFixture(),v=await mountComponent('RealActivity.tsx',{controller:f.controller},{expandChildren:true});try{
 await v.click('Pesquisar');const stock=v.find(n=>n.type==='tr'&&textOf(n).includes('REF-1'));assert.doesNotMatch(textOf(stock),/Ver detalhe/);
 v.find(n=>n.type==='button'&&textOf(n)==='Ver detalhe'&&/Criação/.test(n.props['aria-label'])).props.onClick();await v.flush();
 assert.ok(f.calls.includes('/v1/registro-atividades/detalhe?origem=catalog&id=1'));
 assert.match(v.text(),/Detalhes do registro.*CampoAntesDepois.*activetruetrue.*nameProduto antigoProduto sintético.*price1\.001\.00/s);
 assert.equal(v.nodes().filter(n=>n.type==='tr'&&n.props.className==='is-changed').length,1);
 await v.click('Fechar');assert.doesNotMatch(v.text(),/Detalhes do registro/);
}finally{v.unmount();}});
