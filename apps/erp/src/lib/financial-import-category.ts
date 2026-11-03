export type ImportFinanceKind='receivable'|'payable';
export type ImportCategory={id:string;name:string;version:number;kind:ImportFinanceKind|'both';active:boolean};
export type ImportCategoryPage={items:ImportCategory[];has_more:boolean;next_cursor:string|null};
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fail():never{throw new Error('financial_import_category_invalid_response');}
export function importCategoryPage(value:unknown):ImportCategoryPage{
 if(!object(value)||value.entity!=='categories'||value.data_mode!=='erp_native'||value.limit!==25||!Array.isArray(value.items)||value.items.length>25||typeof value.has_more!=='boolean'||!(value.next_cursor===null||uuid(value.next_cursor))||value.has_more!==(value.next_cursor!==null))fail();
 const seen=new Set();const items=value.items.map(item=>{if(!object(item)||!uuid(item.id)||seen.has(item.id)||typeof item.name!=='string'||!item.name.trim()||Array.from(item.name).length>200||/[\x00-\x1f\x7f]/.test(item.name)||!Number.isInteger(item.version)||Number(item.version)<1||Number(item.version)>2147483647||typeof item.active!=='boolean'||!['receivable','payable','both'].includes(String(item.kind)))fail();seen.add(item.id);return{id:item.id as string,name:item.name,version:item.version as number,kind:item.kind as ImportCategory['kind'],active:item.active};});
 if(value.has_more&&(items.length!==25||value.next_cursor!==items.at(-1)?.id))fail();
 return{items,has_more:value.has_more,next_cursor:value.next_cursor as string|null};
}
export function importCategoryPath(query:string,after:string|null=null):string{if(Array.from(query).length>120||/[\x00-\x1f\x7f]/.test(query)||after!==null&&!uuid(after))throw new Error('financial_import_category_invalid_query');const p=new URLSearchParams({limit:'25'});if(query)p.set('q',query);if(after)p.set('after',after);return`/v1/financeiro/categories?${p}`;}
export function importCategoryAllowed(category:ImportCategory,kind:ImportFinanceKind):boolean{return category.active&&(category.kind==='both'||category.kind===kind);}
