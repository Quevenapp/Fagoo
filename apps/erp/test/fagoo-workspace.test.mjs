import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceMenu} from '../src/lib/fagoo-menu.ts';
import {resolveMenu} from '../src/lib/origin-menu.ts';
import {FAGOO_PATHS,FAGOO_ALIASES} from '../src/components/fagoo-icons.ts';
import {FA_ICONS} from '../src/components/fa-icons.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';

test('workspace grouping preserves exactly the resolved destinations for each role',()=>{
 for(const role of ['admin','consulta','vendas','estoque','financeiro','fiscal']){
  const groups=resolveMenu('real',{role,resources:['contacts','products','sales_orders','sales_proposals','purchase_orders','nfe','nfce'],capabilities:{originIntegration:false,originHistory:false}});
  const before=new Set(groups.flatMap(g=>[...g.columns.flatMap(c=>c.items),...(g.footer?[g.footer]:[])]).flatMap(i=>i.to?[i.to]:[]));
  const after=new Set(workspaceMenu(groups).flatMap(g=>g.columns.flatMap(c=>c.items.map(i=>i.to))));
  assert.deepEqual(after,before,role);
 }
 assert.deepEqual(workspaceMenu([]),[]);
});
test('all previously used icon names have an explicit original glyph',()=>{
 for(const name of Object.keys(FA_ICONS))assert.ok(FAGOO_PATHS[FAGOO_ALIASES[name]||name],name);
});
test('list panels are keyboard operable and keep controls mounted while closed',async()=>{
 const view=await mountComponent('NativeListLayout.tsx',{filters:'Filtro preservado',actions:'Ação preservada',children:'Registros'},{location:'/cadastros-reais?cadastro=products'});
 try{
  const aside=label=>view.find(n=>n.type==='aside'&&n.props['aria-label']===label);
  assert.equal(aside('Filtros da listagem').props.hidden,true);
  view.button('Filtros').props.onClick();await view.flush();
  assert.equal(aside('Filtros da listagem').props.hidden,false);
  assert.equal(view.button('Filtros').props['aria-expanded'],true);
  view.button('Ações da listagem').props.onClick();await view.flush();
  assert.equal(aside('Filtros da listagem').props.hidden,true);
  assert.equal(aside('Ações da listagem').props.hidden,false);
  view.find(n=>n.props.className==='native-list-layout fagoo-list-workspace').props.onKeyDown({key:'Escape',preventDefault(){}});await view.flush();
  assert.equal(aside('Ações da listagem').props.hidden,true);
  assert.match(view.text(),/Filtro preservado/);
 }finally{view.unmount();}
});
