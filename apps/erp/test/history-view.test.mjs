import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
// Synthetic backup history only: fictitious keys, no real fiscal data.
const backup='a'.repeat(64);
const item=n=>({id:'b'+String(n).padStart(63,'0'),key:'35261000000000000000'+'55'+'001'+String(n).padStart(9,'0')+'1'+'00000000'+'0',kind:'invoice',model:'55',environment:'2',protocol:'135260000000001',protocol_present:true,signature_present:true,occurrences:n===1?2:1,issues:n===2?['SYNTHETIC']:[],event_type:null});
const fixture=()=>{const calls=[];return{calls,controller:{async history(path){calls.push(path);if(path==='/v1/history/backups')return{data_mode:'backup_readonly',items:[{id:backup,status:'stored',available:true,created_at:'2026-10-01T10:00:00Z',finished_at:'2026-10-01T11:00:00Z',xml_occurrences:400,issues:1}]};
 const p=new URL(path,'https://synthetic.invalid').searchParams,offset=Number(p.get('offset')),limit=Number(p.get('limit'));return{data_mode:'backup_readonly',backup_id:backup,items:[item(1),item(2)],total:322,has_more:offset+limit<322,next_offset:offset+limit,limit,offset};},
 async historyDownload(){assert.fail('no implicit download');}}};};
const mount=(controller,initialModel)=>mountComponent('HistoryView.tsx',{controller,initialModel},{expandChildren:['NativeListLayout','OriginPagination','AppliedChips']});
test('Origin list wording, number/badges and read-only GET pagination for Notas Fiscais de Saída',async()=>{
 const f=fixture(),view=await mount(f.controller,'55');
 try{
  const text=view.text();
  assert.match(text,/Notas Fiscais de Saída/);assert.match(text,/Somente consulta/);assert.match(text,/Homologação/);assert.match(text,/Quantidade de arquivos XML322/);
  assert.match(text,/000001Série 1/);assert.match(text,/1 - 25 de 322/);assert.match(text,/Modelo: NF-e/);
  assert.deepEqual(view.nodes().filter(n=>n.type==='span'&&String(n.props.className||'').startsWith('status-badge')).map(n=>[n.props.className,n.props.children]),[['status-badge status-success','Importado'],['status-badge status-warning','Revisar estrutura']]);
  assert.match(f.calls.at(-1),/model=55/);assert.match(f.calls.at(-1),/offset=0/);
  await view.click('Próxima');assert.match(f.calls.at(-1),/offset=25/);
  await view.click('Última');assert.match(f.calls.at(-1),/offset=300/);
  await view.click('Primeira');assert.match(f.calls.at(-1),/offset=0/);
  await view.change('history-query','3526');assert.doesNotMatch(f.calls.at(-1),/q=/);await view.submit();assert.match(f.calls.at(-1),/q=3526/);assert.match(view.text(),/Pesquisa: 3526/);
  await view.change('history-kind','invoice');assert.match(f.calls.at(-1),/kind=invoice/);assert.match(view.text(),/Quantidade de notas322/);
  await view.change('history-model','65');assert.match(view.text(),/Nota fiscal de consumidor eletrônica \(NFC-e\)/);assert.match(view.text(),/Quantidade de notas fiscais322/);
  await view.click('Limpar filtros');assert.match(view.text(),/Histórico fiscal do Origin/);assert.doesNotMatch(f.calls.at(-1),/q=|model=|kind=/);
  assert.ok(f.calls.every(path=>path.startsWith('/v1/history/')));
 }finally{view.unmount();}
});
test('pagination never requests an offset beyond the server limit',async()=>{
 const f=fixture(),controller={...f.controller,async history(path){const value=await f.controller.history(path);return path.startsWith('/v1/history/xml')?{...value,total:5000000,has_more:true}:value;}},view=await mount(controller,'65');
 try{await view.click('Última');assert.match(f.calls.at(-1),/offset=100000(&|$)/);assert.match(view.text(),/Nota fiscal de consumidor eletrônica \(NFC-e\)/);}
 finally{view.unmount();}
});
