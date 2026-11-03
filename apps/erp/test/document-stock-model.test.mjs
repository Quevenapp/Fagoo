import test from 'node:test';
import assert from 'node:assert/strict';
import {documentStockPreviewInput,documentStockMutationInput} from '../src/lib/document-stock-model.ts';
const document={id:'document',kind:'purchase_orders',version:3};
const preview={action:'post',document,occurred_on:'2026-10-15',reason:'Conferência revisada',preview_hash:'a'.repeat(64),ignored:[{id:'b'},{id:'a'}]};
test('stock bridge requires valid date and reason before preview, including reversal lower date bound',()=>{
 assert.deepEqual(documentStockPreviewInput(document,'2026-10-15','  Conferência revisada  ','2026-10-16'),{expected_document_version:3,occurred_on:'2026-10-15',reason:'Conferência revisada'});
 for(const day of ['2026-02-30','2026-10-17','1899-12-31','15/10/2026'])assert.throws(()=>documentStockPreviewInput(document,day,'Conferência revisada','2026-10-16'));
 for(const reason of ['','  ','x\ntext','x'.repeat(501)])assert.throws(()=>documentStockPreviewInput(document,'2026-10-15',reason,'2026-10-16'));
 assert.throws(()=>documentStockPreviewInput(document,'2026-10-14','Motivo válido','2026-10-16',{state:'active',occurred_on:'2026-10-15',version:1}));
 assert.throws(()=>documentStockPreviewInput(document,'2026-10-15','Motivo válido','2026-10-16',{state:'reversed',occurred_on:'2026-10-15',version:2}));
});
test('posting requires contextual confirmation and exact ignored identifiers, never sends client quantities',()=>{
 assert.throws(()=>documentStockMutationInput(document,preview,false,true));assert.throws(()=>documentStockMutationInput(document,preview,true,false));
 const input=documentStockMutationInput(document,preview,true,true);assert.deepEqual(input.ignored_item_ids,['a','b']);assert.equal(input.expected_document_version,3);assert.equal(input.quantity,undefined);assert.equal(input.items,undefined);
 for(const changed of [{...document,id:'other'},{...document,kind:'sales_orders'},{...document,version:4}])assert.throws(()=>documentStockMutationInput(changed,preview,true,true));
});
test('reversal sends only linked posting CAS, hash and metadata, without replacement quantities',()=>{
 const reversed={...preview,action:'reverse',ignored:[],posting:{id:'posting',document_id:document.id,state:'active',version:1}};
 const input=documentStockMutationInput(document,reversed,true,false);assert.equal(input.expected_posting_version,1);assert.equal(input.ignored_item_ids,undefined);assert.equal(input.quantity,undefined);
 assert.throws(()=>documentStockMutationInput(document,{...reversed,posting:{...reversed.posting,document_id:'other'}},true,false));
});
