// "Componentes do item (kit)" de um item de pedido de venda ou OS (migração 280, frente de estoque). Quantidades exatas em texto (BigInt).
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED=/^(0|[1-9]\d{0,11})\.\d{6}$/,TOTAL=/^(0|[1-9]\d{0,17})\.\d{12}$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_KIT_COMPONENTS_RESPONSE');};
function need(value:unknown):asserts value {if(!value)fail();}
const units6=(value:string)=>{const [whole,fraction='']=value.split('.');return BigInt(whole+fraction.padEnd(6,'0').slice(0,6));};
export const KIT_COMPONENTS_PATH=(itemId:string)=>`/v1/estoque/composicoes/itens/${itemId}`;
export type KitReason=null|'not_composition'|'no_structure'|'product_only'|'role'|'locked'|'posted'|'reserved'|'invoice';
export const KIT_REASON_TEXT:Record<Exclude<KitReason,null>,string>={not_composition:'O produto do item não é uma composição.',
  no_structure:'A composição não tem estrutura no cadastro (aba Estrutura do produto).',product_only:'A composição lança o estoque dela mesma (“Lançar estoque: Produto”); os componentes não se movimentam.',
  role:'Seu perfil não altera este documento.',locked:'O documento nesta situação não pode ser alterado.',posted:'O estoque do pedido já foi lançado; estorne antes de mudar os componentes.',
  reserved:'O pedido tem uma reserva ativa; libere-a antes de mudar os componentes.',invoice:'O estoque foi lançado pela nota fiscal deste pedido.'};
export interface KitComponent {component_id:string;name:string;code:string|null;unit:string|null;active:boolean;problem:string|null;quantity:string;total:string;stock:string|null}
export interface KitComponentsView {document:{id:string;kind:string;number:string;version:number;status:string;warehouse_id:string|null};
  item:{id:string;position:number;product_id:string;description:string|null;quantity:string;unit:string|null};product:{id:string;name:string;code:string|null;unit:string|null};
  structure:{component_id:string;quantity:string}[];edited:boolean;version:number;stock_visible:boolean;components:KitComponent[];editable:boolean;reason_code:KitReason}
export function parseKitComponents(value:unknown,documentId:string,itemId:string,scope='stock_item_components'):KitComponentsView {
  need(isObject(value)&&value.data_mode==='erp_native'&&value.scope===scope&&isObject(value.document)&&value.document.id===documentId&&isObject(value.item)&&value.item.id===itemId
    &&isObject(value.product)&&Array.isArray(value.structure)&&Array.isArray(value.components)&&typeof value.edited==='boolean'&&Number.isInteger(value.version)
    &&typeof value.stock_visible==='boolean'&&typeof value.editable==='boolean'&&value.editable===(value.reason_code===null)
    &&typeof value.item.quantity==='string'&&STORED.test(value.item.quantity)&&Number.isInteger(value.document.version));
  const kit=units6(value.item.quantity as string);
  const components=(value.components as unknown[]).map(raw=>{need(isObject(raw)&&typeof raw.component_id==='string'&&UUID.test(raw.component_id)&&typeof raw.name==='string'
    &&typeof raw.quantity==='string'&&STORED.test(raw.quantity)&&typeof raw.total==='string'&&TOTAL.test(raw.total)&&(raw.stock===null||typeof raw.stock==='string'&&/^-?(0|[1-9]\d{0,11})\.\d{6}$/.test(raw.stock)));
    need(units6(raw.quantity)*kit===BigInt(raw.total.replace('.','')));
    return {component_id:raw.component_id,name:raw.name,code:(raw.code as string|null)??null,unit:(raw.unit as string|null)??null,active:raw.active===true,problem:(raw.problem as string|null)??null,
      quantity:raw.quantity,total:raw.total,stock:raw.stock as string|null};});
  const d=value.document as Record<string,unknown>,i=value.item as Record<string,unknown>,p=value.product as Record<string,unknown>;
  return {document:{id:documentId,kind:String(d.kind),number:String(d.number),version:d.version as number,status:String(d.status),warehouse_id:(d.warehouse_id as string|null)??null},
    item:{id:itemId,position:Number(i.position),product_id:String(i.product_id),description:(i.description as string|null)??null,quantity:i.quantity as string,unit:(i.unit as string|null)??null},
    product:{id:String(p.id),name:String(p.name),code:(p.code as string|null)??null,unit:(p.unit as string|null)??null},
    structure:(value.structure as {component_id:string;quantity:string}[]).map(s=>({component_id:s.component_id,quantity:s.quantity})),edited:value.edited,version:value.version as number,
    stock_visible:value.stock_visible,components,editable:value.editable,reason_code:value.reason_code as KitReason};
}
// ---- Rows of the modal ----
export interface KitRow {component_id:string;name:string;code:string|null;unit:string|null;stock:string|null;quantity:string}
const draftOf=(value:string)=>{const [whole,fraction='']=value.split('.');const trimmed=fraction.replace(/0+$/,'');return trimmed?`${whole},${trimmed}`:whole!;};
export const kitRows=(view:KitComponentsView):KitRow[]=>view.components.map(c=>({component_id:c.component_id,name:c.name,code:c.code,unit:c.unit,stock:c.stock,quantity:draftOf(c.quantity)}));
export const kitKey=(rows:readonly KitRow[])=>JSON.stringify(rows.map(row=>[row.component_id,row.quantity.trim()]));
/** Qtde Un typed like Origin ("1,5"): positive, up to 6 decimals. */
export function kitQuantity(text:string,name:string):string {
  const value=text.trim();
  if(!/^(0|[1-9]\d{0,11})(?:[.,]\d{1,6})?$/.test(value)||/^0(?:[.,]0+)?$/.test(value))throw new Error(`Informe a Qtde Un de ${name}: positiva, com até 6 casas decimais.`);
  return value.replace(',','.');
}
/** Qtde Total = Qtde Un x quantity of the item, exact; "—" while the row is incomplete. */
export function kitTotal(quantity:string,itemQuantity:string):string {
  let q:string;try{q=kitQuantity(quantity,'');}catch{return '—';}
  const product=units6(q)*units6(itemQuantity),digits=product.toString().padStart(13,'0'),whole=digits.slice(0,-12),fraction=digits.slice(-12).replace(/0+$/,'');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.')}${fraction?`,${fraction}`:''}`;
}
export function kitBody(view:KitComponentsView,rows:readonly KitRow[]|null,commandId?:string):Record<string,unknown> {
  if(!view.editable)throw new Error(KIT_REASON_TEXT[view.reason_code as Exclude<KitReason,null>]);
  if(rows!==null){
    if(!rows.length)throw new Error('Informe ao menos um componente (ou use “Restaurar estrutura”).');
    if(rows.length>100)throw new Error('Informe até 100 componentes.');
    if(new Set(rows.map(row=>row.component_id)).size!==rows.length)throw new Error('Um componente aparece mais de uma vez.');
    if(rows.some(row=>row.component_id===view.item.product_id))throw new Error('A composição não pode ser componente dela mesma.');
  }
  return {...(commandId?{command_id:commandId}:{}),document_id:view.document.id,expected_document_version:view.document.version,expected_version:view.version,
    components:rows===null?null:rows.map(row=>({component_id:row.component_id,quantity:kitQuantity(row.quantity,row.name)}))};
}
