import type {AccessState} from './real-access';
import type {StockBalance} from './stock-model';
import {quantityText} from './stock-model.ts';
import {reservationAvailability,reservationCanRead,STOCK_RESERVATIONS_BASE} from './stock-reservations-model.ts';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type AvailabilityWarehouse=Pick<StockBalance,'warehouse_id'|'warehouse_name'|'warehouse_active'>;
export function stockAvailabilityActor(state:AccessState):string|null{
 const member=state.membership;
 return state.phase==='ready'&&member&&UUID.test(member.user_id)&&reservationCanRead(member.role)?member.user_id:null;
}
export function stockAvailabilitySelection(productId:string,warehouseId:string,warehouses:readonly AvailabilityWarehouse[]){
 if(!UUID.test(productId)||!UUID.test(warehouseId)||warehouses.filter(row=>row.warehouse_id===warehouseId).length!==1)throw new Error('STOCK_AVAILABILITY_SELECTION_INVALID');
 return Object.freeze({productId,warehouseId,path:`${STOCK_RESERVATIONS_BASE}/disponibilidade?${new URLSearchParams({product_id:productId,warehouse_id:warehouseId})}`});
}
export type AvailabilitySelection=ReturnType<typeof stockAvailabilitySelection>;
/** Quantities remain exact decimal text; absence never becomes a physical zero. */
export function stockAvailabilityView(raw:unknown,selection:AvailabilitySelection){
 const {position}=reservationAvailability(raw,selection.productId,selection.warehouseId);
 return Object.freeze({state:position.state,unit:position.unit,
  physical:position.physical_quantity===null?'Não conferido':quantityText(position.physical_quantity),
  reserved:quantityText(position.reserved_quantity),
  available:position.available_quantity===null?'Não conferido':quantityText(position.available_quantity),
  note:position.state==='no_movements'?'Não há lançamentos neste depósito. A abertura do estoque ainda precisa ser conferida.':position.state==='review_required'?'O saldo precisa de revisão. A quantidade disponível não está confirmada.':null});
}
