import {moneyText,cents,BRAZIL_TILES,mapShade} from '../lib/business-model';

/** Tile map of the Brazilian states (Origin "Filtro por Estados (mapa)" of Dashboard Pedidos de Venda), drawn in local SVG: one
 * square per UF in its approximate place, shaded by the share of the period's value. A tile is a button: choosing it filters the
 * dashboard by that state, choosing it again shows every state. Exterior (EX) is listed beside the map. */
type StateRow={state:string|null;orders:number;total:string};
const SIZE=34,GAP=4;
export function BrazilMap({rows,selected,disabled,onSelect}:{rows:readonly StateRow[];selected:string|null;disabled?:boolean;onSelect:(state:string|null)=>void}){
 const byState=new Map(rows.filter(r=>r.state).map(r=>[r.state!,r])),max=rows.reduce((m,r)=>{const v=r.state?cents(r.total):0n;return v>m?v:m;},0n);
 const exterior=byState.get('EX'),choose=(uf:string)=>{if(!disabled)onSelect(selected===uf?null:uf);};
 return <section className="business-map" aria-label="Filtro por Estados (mapa)"><h2>Filtro por Estados</h2>
  <svg width={7*(SIZE+GAP)} height={8*(SIZE+GAP)} viewBox={`0 0 ${7*(SIZE+GAP)} ${8*(SIZE+GAP)}`}>
   {Object.entries(BRAZIL_TILES).map(([uf,[col,row]])=>{const r=byState.get(uf),shade=mapShade(r?.total,max),label=`${uf}: ${r?`${moneyText(r.total)} em ${r.orders.toLocaleString('pt-BR')} pedido(s)`:'sem pedidos'}`;
    return <g key={uf} role="button" tabIndex={disabled?-1:0} aria-label={label} aria-pressed={selected===uf} aria-disabled={disabled||undefined} className={`business-map-tile business-map-shade-${shade}${selected===uf?' is-selected':''}`}
     transform={`translate(${col*(SIZE+GAP)},${row*(SIZE+GAP)})`} onClick={()=>choose(uf)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(uf);}}}>
     <title>{label}</title><rect width={SIZE} height={SIZE} rx={4}/><text x={SIZE/2} y={SIZE/2} dy="0.35em" textAnchor="middle">{uf}</text></g>;})}
  </svg>
  <p className="real-help">{selected?<>Mostrando {selected}. <button type="button" className="text-button" disabled={disabled} onClick={()=>onSelect(null)}>Todos os estados</button></>:'Escolha um estado no mapa para filtrar.'}
   {exterior?` Exterior: ${moneyText(exterior.total)}.`:''}</p>
 </section>;
}
