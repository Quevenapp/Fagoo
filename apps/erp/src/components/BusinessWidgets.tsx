import {useState,type ReactNode} from 'react';
import {BUSINESS_STATUSES,BUSINESS_STATUS_LABELS,barHeights,moneyText,qtyText,pctText,brDate,brMonth,variation,type BusinessStatus} from '../lib/business-model';
import {CSV_TYPE,XLSX_TYPE,downloadFile,numberCell,textCell,toCsv,toXlsx,type SheetCell} from '../lib/spreadsheet-export';
import StockPrintPreview from './StockPrintPreview';
import {Icon} from './Icon';

/** Building blocks of the Meu Negócio dashboards: Origin KPI cards, tables with Excel | CSV | PDF and "Procurar:", bar charts. */
export type ColumnKind='text'|'money'|'qty'|'pct'|'int'|'date';
export type Column<T>={key:string;label:string;kind?:ColumnKind;value:(row:T)=>string|number|null;title?:string;link?:(row:T)=>string|null};
const numeric=(kind?:ColumnKind)=>kind==='money'||kind==='qty'||kind==='pct'||kind==='int';
export function cellText(kind:ColumnKind|undefined,value:string|number|null){
 if(value===null||value===undefined)return '—';
 if(kind==='money')return moneyText(String(value));if(kind==='qty')return qtyText(String(value));if(kind==='pct')return pctText(String(value));
 if(kind==='date')return brDate(String(value));if(kind==='int')return Number(value).toLocaleString('pt-BR');return String(value);
}
const sheetCell=(kind:ColumnKind|undefined,value:string|number|null):SheetCell=>value===null?textCell(''):numeric(kind)?numberCell(String(value)):textCell(kind==='date'?brDate(String(value)):String(value));
const fold=(v:string)=>v.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();

export function KpiCard({label,value,previous,icon,tone,hint,raw,previousRaw}:{label:string;value:string;previous?:string|null;icon:string;tone:string;hint?:string;raw?:string;previousRaw?:string|null}){
 const change=raw!==undefined?variation(raw,previousRaw??null):null;
 return <article className={`business-kpi business-tone-${tone}`}><span className="business-kpi-icon" aria-hidden="true"><Icon name={icon} size={14}/></span>
  <div><h3>{label}{hint&&<span className="business-hint" title={hint}><Icon name="circle-info" size={10}/><span className="sr-only">{hint}</span></span>}</h3><strong>{value}</strong>
   {previous!==undefined&&<p className="business-kpi-previous">{change&&<span className={change.up?'is-up':'is-down'}><Icon name={change.up?'arrow-up':'arrow-down'} size={9}/>{change.text}</span>}{previous===null?'Sem período de comparação':`Período anterior: ${previous}`}</p>}</div></article>;
}
/** Situação de Venda: chips of the Brufap sales order statuses (Origin labels). */
export function StatusChips({value,onChange,legend='Situação de Venda',idPrefix}:{value:readonly BusinessStatus[];onChange:(next:BusinessStatus[])=>void;legend?:string;idPrefix:string}){
 return <fieldset className="business-statuses"><legend>{legend}</legend>{BUSINESS_STATUSES.map(s=><label key={s} className={value.includes(s)?'is-on':undefined}>
  <input type="checkbox" id={`${idPrefix}-${s}`} checked={value.includes(s)} onChange={e=>onChange(BUSINESS_STATUSES.filter(x=>x===s?e.target.checked:value.includes(x)))}/>{BUSINESS_STATUS_LABELS[s]}</label>)}</fieldset>;
}
export function Empty({text='Nenhum resultado encontrado - Verifique os filtros utilizados.'}:{text?:string}){return <p className="empty-state business-empty">{text}</p>;}

/** Origin table of a dashboard: "Procurar:" filters the rows on screen; Excel/CSV/PDF export every row the dashboard returned. */
export function DataTable<T>({title,columns,rows,rowKey,footer,file,note,limit,total}:{title:string;columns:readonly Column<T>[];rows:readonly T[];rowKey:(row:T,index:number)=>string;footer?:(string|null)[];file:string;note?:ReactNode;limit?:number;/** Rows that exist (the answer may carry only the first ones). */total?:number}){
 const [search,setSearch]=useState(''),[printing,setPrinting]=useState(false);
 const term=fold(search.trim()),shown=term?rows.filter(row=>columns.some(c=>{const v=c.value(row);return v!==null&&fold(cellText(c.kind,v)).includes(term);})):rows;
 const sheet=()=>[columns.map(c=>textCell(c.label)),...rows.map(row=>columns.map(c=>sheetCell(c.kind,c.value(row)))),...(footer?[footer.map((v,i)=>v===null?textCell(i===0?'TOTAL':''):sheetCell(columns[i]?.kind,v))]:[])];
 const exportAs=(format:'xlsx'|'csv')=>format==='xlsx'?downloadFile(`${file}.xlsx`,toXlsx(title,sheet()) as unknown as BlobPart,XLSX_TYPE):downloadFile(`${file}.csv`,toCsv(sheet()),CSV_TYPE);
 return <section className="business-table" aria-label={title}>
  <header><h2>{title}</h2><div className="business-table-tools">
   <button type="button" className="secondary-button" disabled={!rows.length} onClick={()=>exportAs('xlsx')}><Icon name="file-excel" size={12}/>Excel</button>
   <button type="button" className="secondary-button" disabled={!rows.length} onClick={()=>exportAs('csv')}><Icon name="file-lines" size={12}/>CSV</button>
   <button type="button" className="secondary-button" disabled={!rows.length} onClick={()=>setPrinting(true)}><Icon name="file-pdf" size={12}/>PDF</button>
   <label className="business-search">Procurar:<input type="search" value={search} maxLength={120} aria-label={`Procurar em ${title}`} onChange={e=>setSearch(e.target.value)}/></label></div></header>
  {rows.length?<div className="table-scroll" tabIndex={0} role="region" aria-label={title}><table className="data-table real-table"><thead><tr>{columns.map(c=><th key={c.key} scope="col" className={numeric(c.kind)?'numeric':undefined} title={c.title}>{c.label}</th>)}</tr></thead>
   <tbody>{shown.map((row,i)=><tr key={rowKey(row,i)}>{columns.map(c=>{const v=c.value(row),href=c.link?.(row);return <td key={c.key} className={numeric(c.kind)?'numeric':undefined}>{href?<a href={href}>{cellText(c.kind,v)}</a>:cellText(c.kind,v)}</td>;})}</tr>)}</tbody>
   {footer&&<tfoot><tr>{footer.map((v,i)=><th key={i} className={numeric(columns[i]?.kind)?'numeric':undefined}>{v===null?(i===0?'TOTAL':''):cellText(columns[i]?.kind,v)}</th>)}</tr></tfoot>}</table></div>:<Empty/>}
  {term&&rows.length>0&&!shown.length&&<p className="real-help">Nenhuma linha contém “{search.trim()}”.</p>}
  {total!==undefined&&rows.length<total?<p className="real-help">Mostrando as {rows.length.toLocaleString('pt-BR')} primeiras de {total.toLocaleString('pt-BR')} linhas; refine os filtros para ver as demais.</p>
   :limit!==undefined&&rows.length>=limit&&<p className="real-help">Mostrando as {limit.toLocaleString('pt-BR')} primeiras linhas; refine os filtros para ver as demais.</p>}
  {note}
  {printing&&<StockPrintPreview title={title} onClose={()=>setPrinting(false)}><h1>{title}</h1><table><thead><tr>{columns.map(c=><th key={c.key} className={numeric(c.kind)?'numeric':undefined}>{c.label}</th>)}</tr></thead>
   <tbody>{rows.map((row,i)=><tr key={rowKey(row,i)}>{columns.map(c=><td key={c.key} className={numeric(c.kind)?'numeric':undefined}>{cellText(c.kind,c.value(row))}</td>)}</tr>)}</tbody>
   {footer&&<tfoot><tr>{footer.map((v,i)=><th key={i} className={numeric(columns[i]?.kind)?'numeric':undefined}>{v===null?(i===0?'TOTAL':''):cellText(columns[i]?.kind,v)}</th>)}</tr></tfoot>}</table></StockPrintPreview>}
 </section>;
}

/** Vertical bars, one group per bucket and one bar per series; exact values in the titles. */
export function BarChart({title,buckets,series,labels,money=true,height=160}:{title:string;buckets:readonly string[];series:readonly{label:string;tone:string;values:readonly string[]}[];labels?:(bucket:string,index:number)=>string;money?:boolean;height?:number}){
 const all=series.flatMap(s=>s.values),heights=barHeights(all,height),per=buckets.length,step=Math.max(per>31?12:per>12?18:28,series.length*8+6),width=Math.max(per*step,120),bar=Math.max(3,Math.floor((step-6)/Math.max(series.length,1)));
 const every=Math.max(1,Math.ceil(per/12)),text=(v:string)=>money?moneyText(v):qtyText(v);
 if(!per||all.every(v=>/^-?0(\.0+)?$/.test(v)))return <section className="business-chart" aria-label={title}><h2>{title}</h2><Empty/></section>;
 return <section className="business-chart" aria-label={title}><h2>{title}</h2>
  <div className="business-legend">{series.map(s=><span key={s.label}><i className={`business-swatch business-tone-${s.tone}`}/>{s.label}</span>)}</div>
  <div className="business-chart-scroll" tabIndex={0} role="img" aria-label={title}>
   <svg width={width} height={height+28} viewBox={`0 0 ${width} ${height+28}`} aria-hidden="true">{buckets.map((bucket,i)=><g key={bucket} transform={`translate(${i*step+3},0)`}>
    {series.map((s,j)=>{const h=heights[j*per+i]!;return <rect key={s.label} className={`business-bar business-tone-${s.tone}`} x={j*bar} y={height-h} width={bar-1} height={h}><title>{`${labels?labels(bucket,i):bucket} · ${s.label}: ${text(s.values[i]!)}`}</title></rect>;})}
    {i%every===0&&<text x={0} y={height+16} className="business-axis">{labels?labels(bucket,i):bucket}</text>}</g>)}
    <line x1={0} y1={height} x2={width} y2={height} className="business-baseline"/></svg></div>
 </section>;
}
export const dayLabel=(day:string)=>day.slice(8,10)+'/'+day.slice(5,7);
export const monthLabel=(month:string)=>brMonth(month);
export function StatusPanel({rows}:{rows:readonly{status:BusinessStatus;orders:number;total:string}[]}){
 return <section className="business-card" aria-label="Situação"><h2>Situação</h2><ul className="business-status-list">{rows.map(r=><li key={r.status}><span>{BUSINESS_STATUS_LABELS[r.status]}</span><strong>{r.orders.toLocaleString('pt-BR')}</strong><small>{moneyText(r.total)}</small></li>)}</ul></section>;
}
/** FATURAMENTO SEM FRETE · PREÇO DE CUSTO · MARGEM BRUTA · IMPOSTOS · TAXA VENDA · LUCRO. */
export function IndicatorsPanel({value}:{value:{revenue_without_freight:string;cost:string|null;gross_margin:string|null;gross_margin_pct:string|null;lines_without_cost:number|null;taxes?:string|null;profit?:string|null}}){
 const noCost='Seu perfil não consulta o preço de custo (custo médio do estoque, fornecedor padrão e compras).';
 const items:[string,string,string|undefined][]=[['FATURAMENTO SEM FRETE',moneyText(value.revenue_without_freight),undefined],
  ['PREÇO DE CUSTO',value.cost===null?'—':moneyText(value.cost),value.cost===null?noCost:'Custo médio do estoque de cada produto vendido (sem ele, o preço de custo do fornecedor padrão ou o da última compra).'],
  ['MARGEM BRUTA',value.gross_margin===null?'—':`${moneyText(value.gross_margin)}${value.gross_margin_pct?` (${pctText(value.gross_margin_pct)})`:''}`,value.gross_margin===null?noCost:'Faturamento sem frete menos o preço de custo.'],
  ['IMPOSTOS',value.taxes?moneyText(value.taxes):'—',value.taxes?'Faturamento sem frete de cada pedido × alíquota de imposto de Ajustes (estimativa; não muda a nota fiscal).':'A alíquota de imposto de Ajustes ainda não está disponível.'],
  ['TAXA VENDA','—','Sem taxas de marketplace: marketplaces estão fora do escopo do FAGOO.'],
  ['LUCRO',value.profit?moneyText(value.profit):'—',value.profit?'Faturamento sem frete menos preço de custo e impostos.':value.cost===null?noCost:'Depende da alíquota de imposto de Ajustes.']];
 return <section className="business-card" aria-label="Indicadores"><h2>Indicadores</h2><dl className="business-indicators">{items.map(([label,text,hint])=><div key={label}><dt>{label}{hint&&<span className="business-hint" title={hint}><Icon name="circle-info" size={10}/><span className="sr-only">{hint}</span></span>}</dt><dd>{text}</dd></div>)}</dl>
  {value.lines_without_cost?<p className="real-help">{value.lines_without_cost} item(ns) sem preço de custo (produto sem compra registrada) ficam fora do custo.</p>:null}</section>;
}
