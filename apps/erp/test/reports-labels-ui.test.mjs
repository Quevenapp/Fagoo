import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createReportsFixture,REPORTS_QA_USER}from'../src/qa/reports-fixture.ts';
import{brNumber,sumDecimals,labelsPerPage,cellText}from'../src/lib/reports-model.ts';
import{ean13,code128,upca,msi,barRuns,CODE128_PATTERNS}from'../src/lib/barcodes.ts';
import{LABEL_DEFAULTS}from'../../../packages/erp-domain/src/reports-labels.mjs';
import{captureSystemPortRequest}from'../src/lib/system-request.ts';
import{parsePreferencesPath}from'../src/lib/preferences-route.ts';

// Relatórios customizados and Etiquetas customizadas (migration 149). Synthetic data only.
let previous,downloads=[];const urls={create:URL.createObjectURL,revoke:URL.revokeObjectURL};
test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,addEventListener(){},removeEventListener(){},querySelector:()=>null,
 body:{append(){},classList:{add(){},remove(){}}},createElement:()=>({click(){downloads.push(this.download);}})};URL.createObjectURL=()=>'blob:synthetic';URL.revokeObjectURL=()=>{};});
test.after(()=>{globalThis.document=previous;URL.createObjectURL=urls.create;URL.revokeObjectURL=urls.revoke;});
const textOf=n=>Array.isArray(n)?n.map(textOf).join(''):n&&typeof n==='object'?textOf(n.props?.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);
const posts=f=>f.calls.filter(c=>c.method==='POST');
const action=(v,row,label)=>{const walk=x=>Array.isArray(x)?x.map(walk).find(Boolean):x&&typeof x==='object'?(x.type==='button'&&textOf(x)===label?x:walk(x.props?.children)):undefined;
 return walk(v.find(n=>n.type==='li'&&textOf(n).startsWith(row)).props.children);};

test('149 Relatórios customizados: padrões and customizados, Visualizar with totals and export, Clonar into the editor with Conferir resultado, Configurar and Excluir',async()=>{
 downloads=[];const f=createReportsFixture({lostAck:true}),v=await mountComponent('RealReports.tsx',{controller:f.controller},{expandChildren:['OriginListHeader','ReportTable','Modal']});try{
  for(const label of['Relatórios customizados','Relatórios padrão','Relatório de Vendas','Visão de Contas a Receber · Finanças','Totais — Quantidade: 25','Clone um relatório padrão','Relatório de Recebimentos','Relatório de Venda Parcela','Relatório de Caixa',
   // 284: the other standard reports of Origin.
   'Relatório de Curva ABC de itens de vendas','Relatório de Ficha Financeira a Receber','Relatório de Ocorrências por Venda','Relatório de Transporte por Nota Fiscal'])assert.ok(v.text().includes(label),label);
  // 264: Recebimentos, Pagamentos, Comissões and Caixa join Contas a Receber and Contas a Pagar in Finanças; 284 the two Fichas Financeiras.
  await v.change('reports-group','financas');assert.match(v.text(),/Totais — Quantidade: 8/);await v.change('reports-group','');
  action(v,'Relatório de Vendas','Visualizar').props.onClick();await v.flush();
  assert.match(v.text(),/NúmeroDataClienteSituaçãoTotal1.*01\/10\/2026Ana SintéticaEm abertoR\$ 5,00/s);assert.match(v.text(),/Total \(todos\)R\$ 17,50/);
  await v.click('Exportar CSV');assert.deepEqual(downloads,['relatorio-de-vendas.csv']);assert.match(v.text(),/3 linha\(s\) exportada\(s\)\./);
  const runs=posts(f).filter(c=>c.path==='/v1/sistema/relatorios/execucao');assert.equal(runs.at(-1).body.page,200);
  await v.click('Voltar');action(v,'Relatório de Vendas','Clonar').props.onClick();await v.flush();
  assert.equal(v.input('report-title').props.value,'Relatório de Vendas');assert.match(v.text(),/Após salvar, aparecerá em Relatórios customizados/);
  await v.change('report-title','Vendas por cliente');await v.change('report-add-column','vendedor');await v.click('Incluir coluna');
  v.find(n=>n.props['aria-label']==='Subir Vendedor - Vendas').props.onClick();await v.flush();
  await v.change('report-filter-column','contato');await v.change('report-filter-value','ana');await v.click('Incluir filtro');
  await v.change(`report-user-${REPORTS_QA_USER}`,true);assert.equal(v.nodes().some(n=>n.props.id==='report-user-10000000-0000-4000-8000-000000000149'),false,'administradores veem todos');
  await v.click('Visualizar');assert.match(v.text(),/Total nesta exibição/);assert.match(v.text(),/2 registro\(s\) no limite/);
  await v.click('Salvar');const saved=posts(f).at(-1);assert.equal(saved.path,'/v1/sistema/relatorios');
  assert.deepEqual(saved.body.data,{base:'vendas',title:'Vendas por cliente',columns:['numero','data','contato','situacao','vendedor','total'],filters:[{column:'contato',value:'ana'}],view_limit:2000,with_totals:true,users:[REPORTS_QA_USER]});
  assert.match(v.text(),/Conferir resultado/);await v.click('Conferir resultado');assert.deepEqual(posts(f).at(-1).body,saved.body);
  assert.match(v.text(),/Relatório salvo; ele aparece em Relatórios customizados \(comando já registrado\)\./);assert.match(v.text(),/Vendas por clienteVisão de Vendas · 6 coluna\(s\) · 1 filtro\(s\)/);
  action(v,'Vendas por cliente','Configurar').props.onClick();await v.flush();assert.equal(v.button('Salvar').disabled,true);await v.change('report-limit','3000');await v.click('Salvar');
  assert.match(v.text(),/Limite para visualização de 1 a 2.000/);await v.click('Cancelar');
  action(v,'Vendas por cliente','Excluir').props.onClick();await v.flush();v.find(n=>n.type==='button'&&n.props.className==='danger-button').props.onClick();await v.flush();assert.equal(posts(f).at(-1).path,'/v1/sistema/relatorios/exclusao');assert.match(v.text(),/Relatório excluído\./);
 }finally{v.unmount();}
 // Vendas sees only the bases of the profile and the reports shared with it; no management controls.
 const g=createReportsFixture({role:'vendas',actor:REPORTS_QA_USER});g.reports.push({id:'50000000-0000-4000-8000-000000000099',base:'vendas',title:'Liberado',columns:['numero'],filters:[],view_limit:10,with_totals:false,users:[REPORTS_QA_USER],version:1,updated_at:'2026-10-20T12:00:00Z'});
 const w=await mountComponent('RealReports.tsx',{controller:g.controller},{expandChildren:['OriginListHeader']});try{
  assert.doesNotMatch(w.text(),/Contas a Receber|Clonar|Configurar/);assert.match(w.text(),/LiberadoVisão de Vendas/);
 }finally{w.unmount();}
 assert.equal(brNumber('1234567.5','money'),'R$ 1.234.567,50');assert.equal(brNumber('2.5000'),'2,50');assert.equal(brNumber('-0.1250'),'-0,125');assert.equal(sumDecimals(['1.25','2.5000',null,'-0.75']),'3.0000');
 assert.equal(cellText({id:'d',label:'D',type:'date'},'2026-10-20'),'20/10/2026');
 assert.throws(()=>captureSystemPortRequest('/v1/sistema/relatorios/execucao',{method:'POST',body:{base:'vendas',columns:['x'],filters:[],view_limit:10,offset:0,page:20}}));
 assert.deepEqual(parsePreferencesPath('/preferencias/sistema/relatorios-customizados'),{kind:'screen',screen:'relatorios-customizados'});
});

test('149 Etiquetas customizadas: Padrões only clone, the editor previews barcodes, an invalid position blocks Salvar, and printing lays the labels on pages',async()=>{
 const f=createReportsFixture(),v=await mountComponent('RealLabels.tsx',{controller:f.controller},{expandChildren:['OriginListHeader','LabelSvg','Modal']});try{
  for(const label of['Etiquetas customizadas','Padrões (5)','Customizadas (0)','edite ou clone uma etiqueta padrão','Totais — Quantidade: 5'])assert.ok(v.text().includes(label),label);
  // 230: Nota Fiscal labels print the Brufap notes too.
  assert.equal(action(v,'Etiqueta de nota fiscal','Imprimir').props.disabled,false);assert.equal(v.nodes().some(n=>n.type==='button'&&textOf(n)==='Editar'),false);
  action(v,'Etiqueta de produto','Clonar').props.onClick();await v.flush();
  assert.equal(v.input('label-description').props.value,'Etiqueta de produto (cópia)');assert.ok(v.nodes().some(n=>n.type==='svg'&&n.props['aria-label']==='Etiqueta 50 × 30 mm'));
  assert.ok(v.nodes().filter(n=>n.type==='rect').length>20,'EAN-13 bars of the sample');assert.ok(v.nodes().some(n=>n.type==='option'&&n.props.value==='PDF417'&&n.props.disabled));
  assert.ok(v.nodes().some(n=>n.type==='option'&&n.props.value==='qr'&&!n.props.disabled),'231: QR CODE is generated');
  await v.change('label-field-0-x','60');assert.match(v.text(),/Confira as medidas/);assert.equal(v.button('Salvar').disabled,true);
  await v.change('label-field-0-x','3,5');await v.change('label-description','Gôndola');await v.click('Salvar');
  const saved=posts(f).at(-1);assert.equal(saved.body.data.config.fields[0].x,'3.5');assert.equal(saved.body.data.type,'produto');assert.match(v.text(),/Etiqueta salva em Customizadas\./);
  action(v,'Gôndola','Imprimir').props.onClick();await v.flush();await v.change('labels-records-search','caneta');await v.submit(0);
  assert.ok(f.calls.some(c=>c.path==='/v1/sistema/etiquetas/registros?tipo=produto&busca=caneta'));
  await v.change('labels-record-60000000-0000-4000-8000-000000000001',true);await v.change('labels-copies','2');
  const per=labelsPerPage(saved.body.data.config);assert.match(v.text(),new RegExp(`2 etiqueta\\(s\\) em 1 página\\(s\\) de ${per.total}\\.`));
  await v.click('Visualizar impressão');assert.match(v.text(),/Prévia de impressão · 2 etiqueta\(s\)/);assert.equal(v.nodes().filter(n=>n.type==='svg'&&n.props.className==='label-svg').length,2);
 }finally{v.unmount();}
 const g=createReportsFixture({role:'estoque'}),w=await mountComponent('RealLabels.tsx',{controller:g.controller});try{assert.match(w.text(),/Etiquetas customizadas não liberadas/);assert.equal(g.calls.length,0);}finally{w.unmount();}
 // Local encoders.
 assert.ok(CODE128_PATTERNS.slice(0,106).every(p=>[...p].reduce((s,d)=>s+Number(d),0)===11));assert.equal([...CODE128_PATTERNS[106]].reduce((s,d)=>s+Number(d),0),13);
 assert.equal(code128('ABC').length,11*5+13);assert.equal(code128('123456').length,11*5+13,'set C packs pairs');assert.equal(code128('Ç'),null);
 assert.equal(ean13('789123456789'),ean13('7891234567895'));assert.equal(ean13('7891234567890'),null);assert.equal(ean13('7891234567895').length,95);
 assert.equal(upca('03600029145').length,95);assert.equal(msi('1234').length,3+5*12+4);assert.deepEqual(barRuns('0110111'),[[1,2],[4,3]]);
 assert.ok(LABEL_DEFAULTS.every(t=>labelsPerPage(t.config).total>=1));
});

test('149 review: a report user who lost access can be unmarked in Configurar',async()=>{
 const STALE='10000000-0000-4000-8000-000000009149',f=createReportsFixture();
 f.reports.push({id:'50000000-0000-4000-8000-000000000149',base:'vendas',title:'Com usuário inativo',columns:['numero'],filters:[],view_limit:10,with_totals:false,users:[STALE,REPORTS_QA_USER].sort(),version:1,updated_at:'2026-10-20T12:00:00Z'});
 const v=await mountComponent('RealReports.tsx',{controller:f.controller},{expandChildren:['OriginListHeader','ReportTable','Modal']});try{
  action(v,'Com usuário inativo','Configurar').props.onClick();await v.flush();
  assert.match(v.text(),/1 usuário\(s\) marcado\(s\) não estão mais ativos\./);await v.click('Desmarcar usuários inativos');
  assert.doesNotMatch(v.text(),/não estão mais ativos/);assert.equal(v.input(`report-user-${REPORTS_QA_USER}`).props.checked,true);
  await v.click('Salvar');assert.deepEqual(posts(f).at(-1).body.data.users,[REPORTS_QA_USER]);assert.match(v.text(),/Relatório alterado\./);
 }finally{v.unmount();}
});

test('149 review: a role change drops the rows asked by the previous role and reloads the list for the new one',async()=>{
 const f=createReportsFixture(),system=f.controller.system;let release;const gate=new Promise(r=>{release=r;});let hold=true;
 f.controller.system=async(path,options)=>{const answer=await system(path,options);if(hold&&path==='/v1/sistema/relatorios/execucao'){hold=false;await gate;}return answer;};
 const v=await mountComponent('RealReports.tsx',{controller:f.controller},{expandChildren:['OriginListHeader','ReportTable','Modal']});try{
  assert.match(v.text(),/Contas a Receber/);action(v,'Relatório de Vendas','Visualizar').props.onClick();await v.flush();assert.doesNotMatch(v.text(),/Ana Sintética/);
  f.setAccess({role:'vendas'});await v.flush();release();await v.flush();
  // The late rows of the administrador never show; the list is the one of Vendas (no Contas a Receber, no Clonar).
  assert.doesNotMatch(v.text(),/Ana Sintética/);assert.match(v.text(),/Relatórios padrão/);assert.doesNotMatch(v.text(),/Contas a Receber|Clonar/);
  assert.equal(f.calls.filter(c=>c.path==='/v1/sistema/relatorios'&&c.method==='GET').length,2);
 }finally{v.unmount();}
});

test('149 review: a report that starts with a money column keeps that column total in both total lines',async()=>{
 const f=createReportsFixture();
 f.reports.push({id:'50000000-0000-4000-8000-000000000150',base:'vendas',title:'Valor primeiro',columns:['total','numero'],filters:[],view_limit:10,with_totals:true,users:[],version:1,updated_at:'2026-10-20T12:00:00Z'});
 const v=await mountComponent('RealReports.tsx',{controller:f.controller},{expandChildren:['OriginListHeader','ReportTable','Modal']});try{
  action(v,'Valor primeiro','Visualizar').props.onClick();await v.flush();
  assert.match(v.text(),/R\$ 17,50Total nesta exibição/);assert.match(v.text(),/R\$ 17,50Total \(todos\)/);
 }finally{v.unmount();}
});

test('custom report displays native coverage while catalog reports without metadata keep their content',async()=>{
 const f=createReportsFixture(),read=f.controller.system;
 f.controller.system=async(path,options)=>{const raw=await read(path,options);return path==='/v1/sistema/relatorios/execucao'&&options.body.base==='vendas'?{...raw,origin:'brufap',mirror_excluded_count:17,coverage:{partial:true,reason:'native_effects_only'}}:raw;};
 const view=await mountComponent('RealReports.tsx',{controller:f.controller},{expandChildren:['OriginListHeader','ReportTable']});
 try{action(view,'Relatório de Vendas','Visualizar').props.onClick();await view.flush();assert.match(view.text(),/Relatório de registros do FAGOO; 17 documentos Origin não entram neste cálculo/);await view.click('Voltar');assert.doesNotMatch(view.text(),/17 documentos Origin/);}finally{view.unmount();}
});
