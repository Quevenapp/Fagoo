// Preferências > Suprimentos > Depósitos no padrão do Origin (migração 105): lista, depósito padrão e saldo desconsiderado.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_WAREHOUSES');};
function need(value:unknown):asserts value {if(!value)fail();}
export interface StockWarehouse {id:string;name:string;active:boolean;version:number;is_default:boolean;ignore_balance:boolean;setting_version:number}
export interface StockWarehousePage {items:StockWarehouse[];page:number;size:number;total:number;default:{warehouse_id:string|null;version:number};can_manage:boolean}
export interface StockWarehouseFilters {query:string;situation:'ativos'|'inativos'|''}
export const WAREHOUSE_PAGE_SIZE=100;
// Origin labels.
export const WAREHOUSE_SEARCH='Pesquisar por descrição';
export const IGNORE_LABEL='Desconsiderar saldo deste depósito';
// Origin's popover also mentions the "Reserva de estoque por depósito" preference, which Brufap does not have: the reservations
// of this warehouse keep protecting its own balance, and only the "Todos" sums (extrato, totalizador, dashboards) leave it out.
export const IGNORE_INFO='O saldo deste depósito fica fora do saldo total (visão "Todos" do extrato, totalizador, dashboards e conferência). As reservas de pedidos neste depósito continuam protegendo o saldo dele.';
export const DEFAULT_LABEL='Depósito padrão';
export function warehousesPath(filters:StockWarehouseFilters,page:number):string {
  if(!Number.isSafeInteger(page)||page<1||filters.query.length>120)throw new Error('INVALID_WAREHOUSE_QUERY');
  const params=new URLSearchParams();
  if(filters.query.trim())params.set('q',filters.query.trim());
  if(filters.situation)params.set('situacao',filters.situation);
  if(page>1)params.set('pagina',String(page));
  const query=params.toString();return `/v1/estoque/depositos${query?`?${query}`:''}`;
}
function warehouse(value:unknown):StockWarehouse {
  need(isObject(value)&&typeof value.id==='string'&&UUID.test(value.id)&&typeof value.name==='string'&&value.name.length>0&&typeof value.active==='boolean'&&Number.isInteger(value.version)
    &&typeof value.is_default==='boolean'&&typeof value.ignore_balance==='boolean'&&Number.isInteger(value.setting_version)&&(!value.is_default||value.active));
  const row=value as Record<string,unknown>;
  return {id:row.id as string,name:row.name as string,active:row.active as boolean,version:row.version as number,is_default:row.is_default as boolean,ignore_balance:row.ignore_balance as boolean,setting_version:row.setting_version as number};
}
export function parseWarehousePage(value:unknown,filters:StockWarehouseFilters,page:number):StockWarehousePage {
  need(isObject(value)&&value.scope==='stock_warehouses'&&value.data_mode==='erp_native'&&value.page===page&&value.size===WAREHOUSE_PAGE_SIZE&&Number.isInteger(value.total)
    &&Array.isArray(value.items)&&typeof value.can_manage==='boolean'&&isObject(value.default));
  const items=(value.items as unknown[]).map(warehouse),standard=value.default as Record<string,unknown>;
  need((standard.warehouse_id===null||(typeof standard.warehouse_id==='string'&&UUID.test(standard.warehouse_id)))&&Number.isInteger(standard.version)
    &&items.every(item=>item.is_default===(item.id===standard.warehouse_id))&&(!filters.situation||items.every(item=>item.active===(filters.situation==='ativos'))));
  return {items,page,size:WAREHOUSE_PAGE_SIZE,total:value.total as number,default:{warehouse_id:standard.warehouse_id as string|null,version:standard.version as number},can_manage:value.can_manage as boolean};
}
export function warehouseSaveBody(name:string,ignore:boolean,current:StockWarehouse|null):Record<string,unknown> {
  const value=name.trim();
  if(!value)throw new Error('Informe a descrição do depósito.');
  if(value.length>200)throw new Error('A descrição pode ter até 200 caracteres.');
  return current?{name:value,ignore_balance:ignore,expected_version:current.version,expected_setting_version:current.setting_version}:{name:value,ignore_balance:ignore};
}
export function parseWarehouseSave(value:unknown,body:Record<string,unknown>,action:'save'|'default'):{warehouse:StockWarehouse;replayed:boolean} {
  need(isObject(value)&&value.scope==='stock_warehouse'&&value.data_mode==='erp_native'&&typeof value.replayed==='boolean'&&isObject(value.receipt)
    &&(value.receipt as Record<string,unknown>).command_id===body.command_id&&(value.receipt as Record<string,unknown>).action===action);
  const result=warehouse(value.warehouse);
  if(action==='save'&&!value.replayed)need(result.name===body.name&&result.ignore_balance===body.ignore_balance);
  if(action==='default'&&!value.replayed)need(result.is_default);
  return {warehouse:result,replayed:value.replayed as boolean};
}
