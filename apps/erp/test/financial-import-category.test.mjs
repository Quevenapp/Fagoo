import test from'node:test';import assert from'node:assert/strict';import{importCategoryAllowed,importCategoryPage,importCategoryPath}from'../src/lib/financial-import-category.ts';import{mountComponent}from'./helpers/component-recovery-harness.mjs';
const cat=(suffix,name,kind='both',active=true)=>({id:`11111111-1111-4111-8111-${String(suffix).padStart(12,'0')}`,name,kind,active,version:7,created_at:'2026-10-16T12:00:00Z',updated_at:'2026-10-16T12:00:00Z'});
const page=items=>({entity:'categories',data_mode:'erp_native',limit:25,has_more:false,next_cursor:null,items});
test('039 category projection preserves CAS version, bounds and active compatible choices',()=>{
 const p=importCategoryPage(page([cat(1,'Receita','receivable'),cat(2,'Despesa','payable'),cat(3,'Ambas'),cat(4,'Arquivada','both',false)]));assert.deepEqual(p.items.filter(c=>importCategoryAllowed(c,'receivable')).map(c=>c.name),['Receita','Ambas']);assert.equal(p.items[0].version,7);assert.equal(Object.hasOwn(p.items[0],'created_at'),false);
 for(const mutate of[p=>p.items[0].version='7',p=>p.items[0].kind='bank',p=>p.items[0].name='x'.repeat(201),p=>p.items.push(p.items[0]),p=>p.data_mode='staging_readonly']){const p=page([cat(1,'Teste')]);mutate(p);assert.throws(()=>importCategoryPage(p));}
 assert.equal(new URL(importCategoryPath('A/B%_'),'https://synthetic.invalid').searchParams.get('q'),'A/B%_');
});
test('039 category picker never defaults a decision and supports explicit uncategorized choice',async()=>{
 const choices=[],controller={async finance(){return page([cat(1,'Categoria adequada'),cat(2,'Inativa','both',false),cat(3,'Outro tipo','payable')]);}};
 const ui=await mountComponent('FinancialImportCategoryPicker.tsx',{controller,kind:'receivable',sourceId:'0001',onSelect:c=>choices.push(c),onClose(){} });
 try{assert.equal(choices.length,0);assert.doesNotMatch(ui.text(),/Inativa|Outro tipo/);await ui.click('Categoria adequada');assert.equal(choices[0].version,7);await ui.click('Manter este título sem categoria');assert.equal(choices[1],null);}finally{ui.unmount();}
});
test('039 category picker ignores late search responses and blocked handlers cannot choose or close',async()=>{
 let release;const calls=[],choices=[];let closed=0;const controller={async finance(path,options){calls.push({path,options});if(calls.length===1)return new Promise(resolve=>{release=resolve;});return page([cat(2,'Atual')]);}};
 const ui=await mountComponent('FinancialImportCategoryPicker.tsx',{controller,kind:'receivable',sourceId:'0001',onSelect:c=>choices.push(c),onClose(){closed++;}});
 try{const input=ui.find(n=>n.type==='input');await ui.change(input.props.id,'Atual');await ui.submit();assert.equal(calls[0].options.signal.aborted,true);release(page([cat(1,'Antiga')]));await ui.flush();assert.doesNotMatch(ui.text(),/Antiga/);const old=ui.button('Atual').props.onClick;await ui.updateProps({blocked:true});old();ui.button('Manter este título sem categoria').props.onClick();ui.button('Voltar às escolhas').props.onClick();assert.equal(choices.length,0);assert.equal(closed,0);assert.equal(ui.button('Atual').disabled,true);assert.equal(typeof old,'function');}finally{ui.unmount();}
});
