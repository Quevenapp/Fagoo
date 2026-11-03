// Composições no padrão do Origin (migrações 222/223): a aba "Estrutura" do produto, o saldo virtual e o "Novo Lançamento" da
// composição. Quantidades e preços são texto decimal exato; as contas da tela usam BigInt (nada é arredondado antes da exibição).
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED=/^-?(0|[1-9]\d{0,11})\.\d{6}$/,PRICE=/^(0|[1-9]\d{0,13})\.\d{10}$/,TOTAL=/^(0|[1-9]\d{0,17})\.\d{10}$/;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_STOCK_COMPOSITION');};
function need(value:unknown):asserts value {if(!value)fail();}
const priceOrNull=(value:unknown):value is string|null=>value===null||(typeof value==='string'&&PRICE.test(value));
const storedOrNull=(value:unknown):value is string|null=>value===null||(typeof value==='string'&&STORED.test(value));
const textOrNull=(value:unknown):value is string|null=>value===null||typeof value==='string';

export type CompositionStockType='physical'|'virtual';
export type CompositionPostMode='product'|'components'|'both';
// Origin labels of the Estrutura tab.
export const STOCK_TYPE_LABELS:Record<CompositionStockType,string>={physical:'Físico',virtual:'Virtual'};
export const POST_MODE_LABELS:Record<CompositionPostMode,string>={product:'Produto',components:'Componentes',both:'Produto e componente'};
export const STOCK_TYPE_HELP='Virtual = máximo disponível a partir dos componentes. Físico = a composição tem estoque próprio.';
export const COMPONENT_PROBLEMS:Record<string,string>={not_found:'Componente não encontrado.',not_product:'O componente não é do tipo Produto.',not_simple:'O componente deve ser um produto simples.',
  deleted:'Componente excluído.',inactive:'Componente inativo.',no_unit:'Componente sem unidade.'};
/** The 28 compositions mirrored from Origin arrive without their structure: the owner types it here. */
export const MIRROR_NOTICE='As composições espelhadas do Origin chegam sem a estrutura (o espelho não traz os componentes). Informe os componentes e as quantidades nesta aba e salve o produto; até lá, os lançamentos de estoque desta composição continuam bloqueados.';

export interface CompositionItem {position:number;component_id:string;name:string;code:string|null;unit:string|null;active:boolean;problem:string|null;quantity:string;price:string|null;cost_price:string|null;stock:string|null}
export interface CompositionSettings {update_cost:boolean;update_weight:boolean;update_price:boolean}
export interface CompositionView {
  product:{id:string;name:string;code:string|null;format:string|null;unit:string|null;version:number;price:string|null;cost_price:string|null;default_supplier:boolean};
  stock_visible:boolean;composition:{stock_type:CompositionStockType;post_mode:CompositionPostMode;version:number;updated_at:string}|null;items:CompositionItem[];
  totals:{sale:string;cost:string;unpriced:number;uncosted:number};virtual:{quantity:string;warehouses:{warehouse_id:string;name:string;active:boolean;ignored:boolean;quantity:string}[]}|null;
  used_in:number;settings:CompositionSettings;
}
/** GET /v1/estoque/composicoes/{produto} (projected again here: a late or foreign answer never fills another product). */
export function parseComposition(value:unknown,productId:string):CompositionView {
  need(isObject(value)&&value.scope==='stock_composition'&&value.data_mode==='erp_native'&&isObject(value.product)&&value.product.id===productId&&Array.isArray(value.items)
    &&typeof value.stock_visible==='boolean'&&Number.isInteger(value.used_in)&&isObject(value.settings)&&isObject(value.totals));
  const p=value.product as Record<string,unknown>,c=value.composition as Record<string,unknown>|null,s=value.settings as Record<string,unknown>,t=value.totals as Record<string,unknown>;
  need(typeof p.name==='string'&&textOrNull(p.code)&&textOrNull(p.format)&&textOrNull(p.unit)&&Number.isInteger(p.version)&&priceOrNull(p.price)&&priceOrNull(p.cost_price)&&typeof p.default_supplier==='boolean');
  need(c===null||(isObject(c)&&(c.stock_type==='physical'||c.stock_type==='virtual')&&['product','components','both'].includes(String(c.post_mode))&&Number.isInteger(c.version)&&typeof c.updated_at==='string'));
  need(['update_cost','update_weight','update_price'].every(key=>typeof s[key]==='boolean')&&typeof t.sale==='string'&&TOTAL.test(t.sale)&&typeof t.cost==='string'&&TOTAL.test(t.cost)&&Number.isInteger(t.unpriced)&&Number.isInteger(t.uncosted));
  const items=(value.items as unknown[]).map((item,index)=>{need(isObject(item)&&item.position===index+1&&typeof item.component_id==='string'&&UUID.test(item.component_id)&&typeof item.name==='string'
    &&textOrNull(item.code)&&textOrNull(item.unit)&&typeof item.active==='boolean'&&textOrNull(item.problem)&&typeof item.quantity==='string'&&STORED.test(item.quantity)&&priceOrNull(item.price)
    &&priceOrNull(item.cost_price)&&(value.stock_visible?typeof item.stock==='string'&&STORED.test(item.stock):item.stock===null));
    return {position:item.position as number,component_id:item.component_id as string,name:item.name as string,code:item.code as string|null,unit:item.unit as string|null,active:item.active as boolean,
      problem:item.problem as string|null,quantity:item.quantity as string,price:item.price as string|null,cost_price:item.cost_price as string|null,stock:item.stock as string|null};});
  let virtual:CompositionView['virtual']=null;
  if(value.virtual!==null){const v=value.virtual;need(isObject(v)&&typeof v.quantity==='string'&&STORED.test(v.quantity)&&Array.isArray(v.warehouses));
    virtual={quantity:v.quantity,warehouses:(v.warehouses as unknown[]).map(w=>{need(isObject(w)&&typeof w.warehouse_id==='string'&&typeof w.name==='string'&&typeof w.active==='boolean'&&typeof w.ignored==='boolean'
      &&typeof w.quantity==='string'&&STORED.test(w.quantity));return {warehouse_id:w.warehouse_id as string,name:w.name as string,active:w.active as boolean,ignored:w.ignored as boolean,quantity:w.quantity as string};})};}
  return {product:{id:productId,name:p.name as string,code:p.code as string|null,format:p.format as string|null,unit:p.unit as string|null,version:p.version as number,price:p.price as string|null,
      cost_price:p.cost_price as string|null,default_supplier:p.default_supplier as boolean},stock_visible:value.stock_visible as boolean,
    composition:c&&{stock_type:c.stock_type as CompositionStockType,post_mode:c.post_mode as CompositionPostMode,version:c.version as number,updated_at:c.updated_at as string},items,
    totals:{sale:t.sale as string,cost:t.cost as string,unpriced:t.unpriced as number,uncosted:t.uncosted as number},virtual,used_in:value.used_in as number,
    settings:{update_cost:s.update_cost as boolean,update_weight:s.update_weight as boolean,update_price:s.update_price as boolean}};
}

export interface ComponentOption {id:string;name:string;code:string|null;unit:string;price:string|null;cost_price:string|null;stock:string|null}
export const componentOptionsPath=(query:string,exclude:string|null)=>`/v1/estoque/composicoes/componentes?${new URLSearchParams({q:query,...(exclude?{excluir:exclude}:{})})}`;
export function parseComponentOptions(value:unknown,query:string):ComponentOption[] {
  need(isObject(value)&&value.scope==='stock_composition_components'&&value.data_mode==='erp_native'&&value.query===query&&Array.isArray(value.items));
  return (value.items as unknown[]).map(item=>{need(isObject(item)&&typeof item.id==='string'&&UUID.test(item.id)&&typeof item.name==='string'&&textOrNull(item.code)&&typeof item.unit==='string'
    &&priceOrNull(item.price)&&priceOrNull(item.cost_price)&&storedOrNull(item.stock));
    return {id:item.id as string,name:item.name as string,code:item.code as string|null,unit:item.unit as string,price:item.price as string|null,cost_price:item.cost_price as string|null,stock:item.stock as string|null};});
}

// ---- Draft of the Estrutura tab (part of the product form and of its unsaved-changes guard) ----
export interface StructureRow {component_id:string;name:string;code:string|null;unit:string|null;quantity:string;price:string|null;cost_price:string|null;stock:string|null;problem:string|null}
export interface StructureDraft {stock_type:CompositionStockType;post_mode:CompositionPostMode;rows:StructureRow[]}
/** Origin opens a new composition with the components moving the stock; a Virtual one always does. */
export const NEW_STRUCTURE:StructureDraft={stock_type:'virtual',post_mode:'components',rows:[]};
export const structureDraft=(view:CompositionView|null):StructureDraft=>!view?.composition?{...NEW_STRUCTURE,rows:[]}:{stock_type:view.composition.stock_type,post_mode:view.composition.post_mode,
  rows:view.items.map(item=>({component_id:item.component_id,name:item.name,code:item.code,unit:item.unit,quantity:quantityDraft(item.quantity),price:item.price,cost_price:item.cost_price,stock:item.stock,problem:item.problem}))};
/** What the guard compares: the saved shape, not the display data of each row. */
export const structureKey=(draft:StructureDraft)=>JSON.stringify([draft.stock_type,draft.post_mode,draft.rows.map(row=>[row.component_id,row.quantity.trim()])]);
const quantityDraft=(value:string)=>{const [whole,fraction='']=value.split('.');const trimmed=fraction.replace(/0+$/,'');return trimmed?`${whole},${trimmed}`:whole!;};
/** The structure sent with the product (data.composition). Throws the message to show. */
export function structurePayload(draft:StructureDraft,expectedVersion:number) {
  if(draft.stock_type==='virtual'&&draft.post_mode!=='components')throw new Error('Com o tipo de estoque Virtual, o estoque é lançado nos componentes.');
  if(draft.rows.length>100)throw new Error('A estrutura pode ter até 100 componentes.');
  const seen=new Set<string>();
  const items=draft.rows.map((row,index)=>{
    if(!row.component_id)throw new Error(`Selecione o componente da linha ${index+1}.`);
    if(seen.has(row.component_id))throw new Error(`O componente da linha ${index+1} já está na estrutura.`);seen.add(row.component_id);
    const quantity=row.quantity.trim().replace(',','.');
    if(!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(quantity)||/^0(\.0+)?$/.test(quantity))throw new Error(`Informe a quantidade do componente da linha ${index+1}, maior que zero e com até 6 casas decimais.`);
    return {component_id:row.component_id,quantity};
  });
  return {expected_version:expectedVersion,stock_type:draft.stock_type,post_mode:draft.post_mode,items};
}
// Exact display arithmetic: a price (10 decimals) times a quantity (6 decimals), shown with 2 decimals (half up, like the SQL round).
const units=(value:string,scale:number)=>{const [whole,fraction='']=value.replace(/^-/,'').split('.');return BigInt(whole+fraction.padEnd(scale,'0').slice(0,scale));};
export function lineTotal(price:string|null,quantity:string):bigint|null {
  const q=quantity.trim().replace(',','.');
  if(price===null||!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(q))return null;
  return units(price,10)*units(q,6);
}
export function totalText(value:bigint|null):string {
  if(value===null)return '-';
  const cents=(value+50000000000000n)/100000000000000n; // 16 decimals → 2 decimals, half up (values are never negative)
  const whole=cents/100n,fraction=(cents%100n).toString().padStart(2,'0');
  return `R$ ${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${fraction}`;
}
export const sumTotals=(values:(bigint|null)[])=>values.reduce<bigint>((sum,value)=>sum+(value??0n),0n);

// ---- Novo Lançamento of a composition (POST /v1/estoque/composicoes/{produto}/lancamentos) ----
export interface CompositionLaunchResult {kind:'receipt'|'issue';movement:{id:string};lines:{product_id:string;role:'composition'|'component';quantity:string}[];replayed:boolean}
export function parseCompositionLaunch(value:unknown,productId:string,body:Record<string,unknown>):CompositionLaunchResult {
  need(isObject(value)&&value.scope==='stock_composition_launch'&&value.data_mode==='erp_native'&&value.kind===body.kind&&isObject(value.movement)&&typeof value.movement.id==='string'
    &&isObject(value.composition)&&value.composition.product_id===productId&&Array.isArray(value.lines)&&value.lines.length>0&&typeof value.replayed==='boolean');
  const lines=(value.lines as unknown[]).map(line=>{need(isObject(line)&&typeof line.product_id==='string'&&(line.role==='composition'||line.role==='component')&&typeof line.quantity==='string'&&STORED.test(line.quantity));
    return {product_id:line.product_id as string,role:line.role as 'composition'|'component',quantity:line.quantity as string};});
  return {kind:value.kind as 'receipt'|'issue',movement:{id:(value.movement as Record<string,unknown>).id as string},lines,replayed:value.replayed as boolean};
}
/** Whether the composition receives the common lançamento (its own stock) or the composition lançamento (components). */
export function compositionLaunchMode(view:CompositionView|null):'common'|'composition'|'blocked' {
  if(!view?.composition||view.product.format!=='E')return 'blocked';
  if(view.composition.post_mode==='product')return view.composition.stock_type==='physical'?'common':'blocked';
  return view.items.length?'composition':'blocked';
}

export interface CompositionLaunchRow {movement_id:string;kind:'receipt'|'issue';occurred_on:string;note:string;reversed_by:string|null;lines:{product_id:string;name:string;warehouse_id:string;quantity:string;expected_version:number}[]}
/** GET /v1/estoque/composicoes/{produto}/lancamentos: the lançamentos of the composition with the current version of each position. */
export function parseCompositionLaunches(value:unknown,productId:string):CompositionLaunchRow[] {
  need(isObject(value)&&value.scope==='stock_composition_launches'&&value.data_mode==='erp_native'&&value.product_id===productId&&Array.isArray(value.items));
  return (value.items as unknown[]).map(item=>{need(isObject(item)&&typeof item.movement_id==='string'&&UUID.test(item.movement_id)&&(item.kind==='receipt'||item.kind==='issue')&&typeof item.occurred_on==='string'
    &&typeof item.note==='string'&&(item.reversed_by===null||typeof item.reversed_by==='string')&&Array.isArray(item.lines));
    const lines=(item.lines as unknown[]).map(line=>{need(isObject(line)&&typeof line.product_id==='string'&&typeof line.name==='string'&&typeof line.warehouse_id==='string'&&typeof line.quantity==='string'
      &&STORED.test(line.quantity)&&Number.isInteger(line.expected_version));
      return {product_id:line.product_id as string,name:line.name as string,warehouse_id:line.warehouse_id as string,quantity:line.quantity as string,expected_version:line.expected_version as number};});
    return {movement_id:item.movement_id as string,kind:item.kind as 'receipt'|'issue',occurred_on:item.occurred_on as string,note:item.note as string,reversed_by:item.reversed_by as string|null,lines};});
}
