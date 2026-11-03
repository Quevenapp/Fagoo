// Relatórios de suprimentos no padrão do Origin (migração 146): catálogo com os nomes do Origin, filtros, caminhos da API e as colunas
// de cada relatório. Quantidades e valores ficam como texto decimal exato.
import {readNativeReportCoverage,type NativeReportCoverage} from './document-reports-model.ts';
export const REPORTS_PATH='/relatorios-estoque';
export type ReportId='entradas-saidas'|'transferencias'|'saldos'|'maior-circulacao'|'sem-movimentacao'|'abaixo-minimo'|'visao-financeira'|'movimentacao-produto'
  |'pedidos-compra'|'notas-operacao'|'notas-fornecedor'|'notas-produto'|'notas-evolucao';
export type ReportFilter='period'|'date'|'since'|'warehouse'|'product'|'productRequired'|'limit'|'statuses'|'poGroup';
type Cell='quantity'|'money'|'price'|'text'|'date'|'count'|'quantity4';
export interface ReportColumn {key:string;label:string;kind:Cell}
export interface ReportDefinition {id:ReportId;group:'Controle de Estoque'|'Notas de Entrada'|'Pedidos de Compra';label:string;api:string;filters:ReportFilter[];roles:string[];columns:ReportColumn[];totals?:string[];fixed?:Record<string,string>;help:string}
const STOCK=['admin','consulta','estoque','vendas','fiscal'],COST=['admin','consulta','estoque','fiscal'],PURCHASE=['admin','consulta','financeiro','estoque','fiscal'],
  // The native entry notes (112) are read by administrador and fiscal only, as in Notas fiscais de entrada (113).
  NOTES=['admin','fiscal'];
const product:ReportColumn[]=[{key:'code',label:'Código',kind:'text'},{key:'name',label:'Descrição',kind:'text'},{key:'unit',label:'Un',kind:'text'}];
const grouped=(label:string,extra:ReportColumn[]):ReportColumn[]=>[{key:'label',label,kind:'text'},...extra];
export const REPORTS:ReportDefinition[]=[
  {id:'entradas-saidas',group:'Controle de Estoque',label:'Entradas e Saídas de Estoque',api:'entradas-saidas',filters:['period','warehouse','product'],roles:STOCK,
    columns:[...product,{key:'entries',label:'Entradas',kind:'quantity'},{key:'exits',label:'Saídas',kind:'quantity'},{key:'balances',label:'Balanços',kind:'quantity'},{key:'net',label:'Saldo do período',kind:'quantity'}],totals:['entries','exits','balances','net'],
    help:'Por produto, no período. Sem depósito escolhido, valem os depósitos considerados: uma transferência entre eles se anula. Balanço aparece em coluna própria.'},
  {id:'transferencias',group:'Controle de Estoque',label:'Transferência de Estoque',api:'transferencias',filters:['period','warehouse'],roles:STOCK,
    columns:[{key:'occurred_on',label:'Data',kind:'date'},...product,{key:'quantity',label:'Quantidade',kind:'quantity'},{key:'source_name',label:'Depósito de origem',kind:'text'},{key:'destination_name',label:'Depósito de destino',kind:'text'},{key:'note',label:'Observações',kind:'text'}],
    help:'Cada transferência entre depósitos do período, com o depósito de origem e o de destino.'},
  {id:'saldos',group:'Controle de Estoque',label:'Saldos em Estoque',api:'saldos',filters:['date','warehouse'],roles:STOCK,columns:[...product,{key:'quantity',label:'Saldo',kind:'quantity'}],totals:['quantity'],
    help:'O saldo de cada produto na data escolhida, pela data dos lançamentos.'},
  {id:'maior-circulacao',group:'Controle de Estoque',label:'Produtos com Maior Circulação',api:'maior-circulacao',filters:['period','warehouse','limit'],roles:STOCK,
    columns:[...product,{key:'entries',label:'Entradas',kind:'quantity'},{key:'exits',label:'Saídas',kind:'quantity'},{key:'moved',label:'Movimentado',kind:'quantity'},{key:'launches',label:'Lançamentos',kind:'count'}],
    help:'Os produtos mais movimentados (entradas mais saídas, sem balanços) no período.'},
  {id:'sem-movimentacao',group:'Controle de Estoque',label:'Produtos sem Movimentação',api:'sem-movimentacao',filters:['since','warehouse'],roles:STOCK,
    columns:[...product,{key:'quantity',label:'Estoque',kind:'quantity'},{key:'last_movement',label:'Último lançamento',kind:'date'}],help:'Produtos com estoque e sem nenhum lançamento desde a data.'},
  {id:'abaixo-minimo',group:'Controle de Estoque',label:'Produtos Abaixo do Estoque Mínimo',api:'abaixo-minimo',filters:['warehouse'],roles:STOCK,
    columns:[...product,{key:'stock_min',label:'Estoque mínimo',kind:'quantity'},{key:'stock_max',label:'Estoque máximo',kind:'quantity'},{key:'quantity',label:'Estoque atual',kind:'quantity'},{key:'missing',label:'Faltante',kind:'quantity'}],
    help:'Produtos ativos com estoque menor que o estoque mínimo do cadastro.'},
  {id:'visao-financeira',group:'Controle de Estoque',label:'Visão Financeira do Estoque',api:'visao-financeira',filters:['warehouse'],roles:COST,
    columns:[...product,{key:'quantity',label:'Estoque',kind:'quantity'},{key:'average_cost',label:'Custo médio',kind:'price'},{key:'cost_value',label:'Valor de custo',kind:'money'},{key:'sale_price',label:'Preço de venda',kind:'price'},{key:'sale_value',label:'Valor de venda',kind:'money'},{key:'margin',label:'Diferença',kind:'money'}],
    totals:['quantity','cost_value','sale_value','margin'],help:'Custo médio do FAGOO (Preferências › Suprimentos › Estoque) e preço de venda do cadastro. Usa preços de compra.'},
  {id:'movimentacao-produto',group:'Controle de Estoque',label:'Movimentação de um Produto',api:'movimentacao-produto',filters:['productRequired','period','warehouse'],roles:STOCK,
    columns:[{key:'date',label:'Data',kind:'date'},{key:'entries',label:'Entradas',kind:'quantity'},{key:'exits',label:'Saídas',kind:'quantity'},{key:'balance',label:'Saldo',kind:'quantity'}],totals:['entries','exits'],
    help:'Saldo antes do período, entradas, saídas e saldo ao fim de cada dia com lançamento, com o gráfico do saldo.'},
  {id:'notas-operacao',group:'Notas de Entrada',label:'Relatório de Notas de Entrada por Operação',api:'notas-entrada',fixed:{agrupar:'operacao'},filters:['period'],roles:NOTES,
    columns:grouped('Natureza de operação',[{key:'notes',label:'Notas',kind:'count'},{key:'value',label:'Valor',kind:'money'}]),totals:['notes','value'],help:'Notas de entrada do FAGOO pela data de emissão, sem as excluídas, canceladas e denegadas.'},
  {id:'notas-fornecedor',group:'Notas de Entrada',label:'Relatório de Notas de Entrada por Fornecedor',api:'notas-entrada',fixed:{agrupar:'fornecedor'},filters:['period'],roles:NOTES,
    columns:grouped('Fornecedor',[{key:'code',label:'CNPJ/CPF',kind:'text'},{key:'notes',label:'Notas',kind:'count'},{key:'value',label:'Valor',kind:'money'}]),totals:['notes','value'],help:'Notas de entrada do FAGOO pela data de emissão, por fornecedor.'},
  {id:'notas-produto',group:'Notas de Entrada',label:'Relatório de Notas de Entrada por Produto',api:'notas-entrada',fixed:{agrupar:'produto'},filters:['period'],roles:NOTES,
    columns:grouped('Produto',[{key:'code',label:'Código',kind:'text'},{key:'notes',label:'Notas',kind:'count'},{key:'quantity',label:'Quantidade',kind:'quantity4'},{key:'value',label:'Valor',kind:'money'}]),help:'Itens das notas de entrada do FAGOO pela data de emissão, por produto.'},
  {id:'notas-evolucao',group:'Notas de Entrada',label:'Evolução de Notas Fiscais de Compra',api:'notas-entrada',fixed:{agrupar:'evolucao'},filters:['period'],roles:NOTES,
    columns:grouped('Mês',[{key:'notes',label:'Notas',kind:'count'},{key:'value',label:'Valor',kind:'money'}]),totals:['notes','value'],help:'Quantidade e valor das notas de entrada do FAGOO mês a mês.'},
  {id:'pedidos-compra',group:'Pedidos de Compra',label:'Relatório de Pedidos de Compras',api:'pedidos-compra',filters:['period','statuses','poGroup'],roles:PURCHASE,
    columns:grouped('Fornecedor / Produto',[{key:'code',label:'Código',kind:'text'},{key:'orders',label:'Pedidos',kind:'count'},{key:'quantity',label:'Quantidade',kind:'quantity'},{key:'value',label:'Valor',kind:'money'}]),totals:['orders','quantity','value'],
    help:'Pedidos de compra do FAGOO pela data do pedido, agrupados por fornecedor ou por produto.'},
];
export const reportById=(id:string|null)=>REPORTS.find(report=>report.id===id)??null;
export const reportParam=(search:string)=>reportById(new URLSearchParams(search).get('relatorio'));
export const reportAllowed=(report:ReportDefinition,role:string|undefined)=>report.roles.includes(role??'');
export const reportBlockReason=(report:ReportDefinition)=>report.roles===COST?'Usa preços de compra, que seu perfil não consulta.':report.roles===NOTES?'Somente administrador e fiscal veem as notas de entrada do FAGOO.':report.roles===PURCHASE?'Somente quem consulta pedidos de compra vê este relatório.':'Seu perfil não consulta o estoque.';
export const PURCHASE_STATUSES:[string,string][]=[['open','Em aberto'],['in_progress','Em andamento'],['partially_fulfilled','Atendido parcialmente'],['fulfilled','Atendido'],['cancelled','Cancelado']];
export interface ReportFilters {from:string;to:string;date:string;warehouse:string;productId:string;limit:string;statuses:string[];poGroup:'fornecedor'|'produto'}
export function defaultReportFilters(today:string):ReportFilters {return {from:`${today.slice(0,8)}01`,to:today,date:today,warehouse:'',productId:'',limit:'50',statuses:['open','in_progress','partially_fulfilled','fulfilled'],poGroup:'fornecedor'};}
const DAY=/^\d{4}-\d{2}-\d{2}$/;
export const INVALID_REPORT_FILTERS='Filtros inválidos!';
/** API path of a report with its filters; invalid filters throw "Filtros inválidos!" before any request. */
export function reportPath(report:ReportDefinition,filters:ReportFilters,offset=0):string {
  const params=new URLSearchParams(),fail=():never=>{throw new Error(INVALID_REPORT_FILTERS);};
  for(const filter of report.filters){
    if(filter==='period'){if(!DAY.test(filters.from)||!DAY.test(filters.to)||filters.from>filters.to)fail();params.set('de',filters.from);params.set('ate',filters.to);}
    if(filter==='date'||filter==='since'){if(!DAY.test(filters.date))fail();params.set('data',filters.date);}
    if(filter==='warehouse'&&filters.warehouse)params.set('warehouse_id',filters.warehouse);
    if(filter==='product'&&filters.productId)params.set('product_id',filters.productId);
    if(filter==='productRequired'){if(!filters.productId)throw new Error('Selecione o produto.');params.set('product_id',filters.productId);}
    if(filter==='limit'){if(!/^[1-9]\d{0,2}$/.test(filters.limit)||Number(filters.limit)>500)fail();params.set('limite',filters.limit);}
    if(filter==='statuses'){if(!filters.statuses.length)throw new Error('Escolha ao menos uma situação.');params.set('situacoes',filters.statuses.join(','));}
    if(filter==='poGroup')params.set('agrupar',filters.poGroup);
  }
  for(const [key,value] of Object.entries(report.fixed??{}))params.set(key,value);
  if(offset)params.set('offset',String(offset));
  // The product movement path keeps product_id first (the worker accepts any order).
  return `/v1/estoque/relatorios/${report.api}?${params}`;
}
export interface ReportResult extends NativeReportCoverage {items:Record<string,unknown>[];total:number|null;offset:number|null;limit:number|null;totals:Record<string,unknown>|null;opening?:string;closing?:string;product?:{code:string|null;name:string;unit:string|null};cost_basis?:string}
export function parseReport(value:unknown,report:ReportDefinition):ReportResult {
  const v=value as Record<string,unknown>|null;
  if(!v||typeof v!=='object'||v.data_mode!=='erp_native'||v.report!==report.api)throw new Error('INVALID_REPORT');
  const items=report.id==='movimentacao-produto'?v.days:v.items;
  if(!Array.isArray(items)||!items.every(item=>item&&typeof item==='object'))throw new Error('INVALID_REPORT');
  return {items:items as Record<string,unknown>[],total:typeof v.total==='number'?v.total:null,offset:typeof v.offset==='number'?v.offset:null,limit:typeof v.limit==='number'?v.limit:null,
    totals:v.totals&&typeof v.totals==='object'?v.totals as Record<string,unknown>:null,...(typeof v.opening==='string'?{opening:v.opening}:{}),...(typeof v.closing==='string'?{closing:v.closing}:{}),
    ...(v.product&&typeof v.product==='object'?{product:v.product as ReportResult['product']}:{}),...(typeof v.cost_basis==='string'?{cost_basis:v.cost_basis}:{}),...readNativeReportCoverage(v)};
}
/** Points of the "Movimentação de um Produto" chart: opening, then the balance at the end of each day (exact strings in, SVG numbers out). */
export function chartPoints(opening:string,days:readonly {date:string;balance:string}[],width:number,height:number):{x:number;y:number;label:string;value:string}[] {
  const values=[opening,...days.map(day=>day.balance)].map(value=>Number(value));
  const min=Math.min(0,...values),max=Math.max(0,...values),span=max-min||1,step=values.length>1?width/(values.length-1):0;
  return values.map((value,index)=>({x:Math.round(index*step*100)/100,y:Math.round((height-((value-min)/span)*height)*100)/100,label:index===0?'Saldo anterior':days[index-1]!.date,value:index===0?opening:days[index-1]!.balance}));
}
