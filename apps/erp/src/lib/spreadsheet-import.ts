// Importações de Dados (Preferências › Importações de Dados, migration 228): browser side of the import framework.
// The file never leaves the browser: it is read here (CSV, XLSX or XLS, bounded), the columns are related to the template,
// every cell is normalized to the canonical value the Worker accepts, and only the rows are sent, in batches.
// Another lane adopts the framework by adding its template to packages/erp-domain/src/spreadsheet-import.mjs and its row
// handler to erp_preferences.import_item; the screen (SpreadsheetImport) and Consultar gestão de ações work unchanged.
import {IMPORT_BASE,IMPORT_TEMPLATES,IMPORT_SLUGS,IMPORT_BATCH_ITEMS,IMPORT_BATCH_LINES,IMPORT_FILE_ROWS,IMPORT_FILE_BYTES,templateRows,templateHeader,foldHeader,importKindOf,isGroupedKind,
 parseImportBatchResult,captureJobsQuery,parseJobs,captureJobQuery,parseJob,
 type ImportKind,type ImportItem,type ImportResult,type ImportJob,type ImportJobsPage,type ImportJobPage,type ImportJobsQuery,type ImportJobQuery,type ImportBatchResult,type TemplateRows} from '../../../../packages/erp-domain/src/spreadsheet-import.mjs';
import {parseXls,XlsError} from './xls-reader.ts';
import {SHEET_COLUMNS,type ContactTypeItem} from './contact-list-model.ts';
import {importRows as contactImportRows,modelCsv as contactModelCsv,modelXlsx as contactModelXlsx} from './contact-import-model.ts';
import {textCell,toCsv,toXlsx} from './spreadsheet-export.ts';
export {IMPORT_TEMPLATES,IMPORT_SLUGS,IMPORT_BATCH_ITEMS,IMPORT_BATCH_LINES,IMPORT_FILE_ROWS,importKindOf,isGroupedKind,parseImportBatchResult,captureJobsQuery,parseJobs,captureJobQuery,parseJob};
export type {ImportKind,ImportItem,ImportResult,ImportJob,ImportJobsPage,ImportJobPage,ImportJobsQuery,ImportJobQuery,ImportBatchResult,TemplateRows};

export const MAX_COLUMNS=150;
const MAX_INFLATED=64*1024*1024;
export class SheetReadError extends Error{}
const fail=(message:string):never=>{throw new SheetReadError(message);};

// ---- Reading: CSV (";" or ","; UTF-8 or Windows-1252), XLSX (first sheet) and XLS (xls-reader.ts) ----
export function decodeText(bytes:Uint8Array){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('windows-1252').decode(bytes);}}
export function parseCsv(text:string):string[][]{
 const source=text.replace(/^﻿/,''),first=source.split(/\r?\n/,1)[0]??'',separator=(first.match(/;/g)?.length??0)>=(first.match(/,/g)?.length??0)?';':',';
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 for(let i=0;i<source.length;i++){
  const char=source[i]!;
  if(quoted){if(char==='"'){if(source[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=char;continue;}
  if(char==='"'&&cell===''){quoted=true;continue;}
  if(char===separator){row.push(cell);cell='';if(row.length>MAX_COLUMNS)fail('A planilha tem colunas demais.');continue;}
  if(char==='\n'||char==='\r'){if(char==='\r'&&source[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';if(rows.length>IMPORT_FILE_ROWS+1)fail('A planilha tem linhas demais.');continue;}
  cell+=char;
 }
 if(quoted)fail('A planilha tem aspas sem fechamento.');
 if(cell!==''||row.length){row.push(cell);rows.push(row);}
 return rows.filter(cells=>cells.some(v=>v.trim()!==''));
}
const u16=(b:Uint8Array,at:number)=>b[at]!|(b[at+1]!<<8),u32=(b:Uint8Array,at:number)=>(b[at]!|(b[at+1]!<<8)|(b[at+2]!<<16)|(b[at+3]!<<24))>>>0;
async function inflate(data:Uint8Array,method:number,size:number){
 if(size>MAX_INFLATED)fail('A planilha é grande demais.');
 if(method===0)return data;
 if(method!==8||typeof DecompressionStream!=='function')fail('Formato de planilha não suportado. Salve como .xlsx ou .csv.');
 const reader=new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),parts:Uint8Array[]=[];let total=0;
 for(;;){const{done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_INFLATED){await reader.cancel();fail('A planilha é grande demais.');}parts.push(value);}
 const out=new Uint8Array(total);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.byteLength;}return out;
}
async function unzip(bytes:Uint8Array,wanted:(name:string)=>boolean){
 let end=-1;for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--)if(u32(bytes,at)===0x06054b50){end=at;break;}
 if(end<0)fail('O arquivo não é uma planilha .xlsx válida.');
 const count=u16(bytes,end+10),files=new Map<string,string>(),decoder=new TextDecoder('utf-8');let at=u32(bytes,end+16);
 for(let n=0;n<count;n++){
  if(at+46>bytes.length||u32(bytes,at)!==0x02014b50)fail('O arquivo não é uma planilha .xlsx válida.');
  const method=u16(bytes,at+10),compressed=u32(bytes,at+20),size=u32(bytes,at+24),nameLength=u16(bytes,at+28),extra=u16(bytes,at+30),comment=u16(bytes,at+32),local=u32(bytes,at+42);
  const name=decoder.decode(bytes.subarray(at+46,at+46+nameLength));at+=46+nameLength+extra+comment;
  if(!wanted(name))continue;
  if(local+30>bytes.length||u32(bytes,local)!==0x04034b50)fail('O arquivo não é uma planilha .xlsx válida.');
  const start=local+30+u16(bytes,local+26)+u16(bytes,local+28);if(start+compressed>bytes.length)fail('O arquivo não é uma planilha .xlsx válida.');
  files.set(name,decoder.decode(await inflate(bytes.subarray(start,start+compressed),method,size)));
 }
 return files;
}
const entity=(v:string)=>v.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,code:string)=>code[0]==='#'?String.fromCodePoint(code[1]!.toLowerCase()==='x'?parseInt(code.slice(2),16):Number(code.slice(1)))
 :({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[code.toLowerCase()]!);
const runs=(xml:string)=>[...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m=>entity(m[1]!)).join('');
const columnIndex=(ref:string)=>{let n=0;for(const c of ref.replace(/\d+$/,''))n=n*26+c.charCodeAt(0)-64;return n-1;};
export async function readXlsx(bytes:Uint8Array):Promise<string[][]>{
 const files=await unzip(bytes,name=>name==='xl/sharedStrings.xml'||/^xl\/worksheets\/sheet\d+\.xml$/.test(name));
 const sheet=[...files.keys()].filter(n=>n.startsWith('xl/worksheets/')).sort((a,b)=>Number(a.match(/\d+/)![0])-Number(b.match(/\d+/)![0]))[0];
 if(!sheet)fail('A planilha não tem nenhuma aba.');
 const shared=[...(files.get('xl/sharedStrings.xml')??'').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m=>runs(m[1]!)),rows:string[][]=[];
 for(const r of files.get(sheet!)!.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)){
  const row:string[]=[];
  for(const c of(r[1]??'').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
   const attrs=c[1]??'',body=c[2]??'',ref=/\br="([A-Z]+\d+)"/.exec(attrs)?.[1],type=/\bt="(\w+)"/.exec(attrs)?.[1],index=ref?columnIndex(ref):row.length;
   if(index>=MAX_COLUMNS)fail('A planilha tem colunas demais.');
   const raw=/<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
   const value=type==='s'?shared[Number(raw)]??'':type==='inlineStr'?runs(body):type==='b'?(raw==='1'?'Sim':'Não'):raw===undefined?'':entity(raw);
   while(row.length<index)row.push('');row[index]=value;
  }
  rows.push(row);if(rows.length>IMPORT_FILE_ROWS+1)fail('A planilha tem linhas demais.');
 }
 return rows.filter(cells=>cells.some(v=>v.trim()!==''));
}
/** First worksheet as text cells. Numbers stay as written in the file (never floating point). */
export async function readSpreadsheet(name:string,bytes:Uint8Array):Promise<string[][]>{
 if(!bytes.byteLength)fail('O arquivo está vazio.');
 if(bytes.byteLength>IMPORT_FILE_BYTES)fail('A planilha passa de 20 MB. Divida o arquivo e tente de novo.');
 const lower=name.toLowerCase();
 if(lower.endsWith('.xlsx'))return readXlsx(bytes);
 if(lower.endsWith('.csv')||lower.endsWith('.txt'))return parseCsv(decodeText(bytes));
 if(lower.endsWith('.xls')){
  try{const rows=parseXls(bytes,decodeText);if(rows.length>IMPORT_FILE_ROWS+1)fail('A planilha tem linhas demais.');if(rows.some(r=>r.length>MAX_COLUMNS))fail('A planilha tem colunas demais.');return rows;}
  catch(e){if(e instanceof SheetReadError)throw e;if(e instanceof XlsError&&e.reason==='old_version')fail('Esta planilha .XLS é de uma versão anterior ao Excel 97. Salve-a como .XLSX ou .CSV e tente de novo.');return fail('Não foi possível ler a planilha .XLS.');}
 }
 return fail('Selecione uma planilha .XLSX, .XLS ou .CSV.');
}

// ---- Templates of the screen ----
export interface ScreenColumn{label:string;key:string;required:boolean}
export interface ScreenTemplate{kind:ImportKind;slug:string;title:string;noun:readonly [string,string];rule:string;columns:ScreenColumn[];readOnly:readonly string[];
 parse:(cells:readonly (readonly string[])[],mapping:Record<string,string>,context:{types:readonly ContactTypeItem[]})=>TemplateRows;
 model:(format:'xlsx'|'csv')=>Uint8Array|string;identity:(item:ImportItem)=>string}
const CONTACT_READ_ONLY=new Set(['seller_name','finance_category_name','operation_nature_name']);
/** Header with the user's choices: a template label is renamed to the chosen sheet column (or dropped with "Não importar"). */
export function remapHeader(header:readonly string[],labels:readonly string[],mapping:Record<string,string>){
 const out=header.map(h=>String(h??''));
 for(const label of labels){
  if(!Object.hasOwn(mapping,label))continue;
  const own=out.findIndex(h=>foldHeader(h)===foldHeader(label));if(own>=0)out[own]='';
  const chosen=mapping[label];if(!chosen)continue;
  const at=header.findIndex(h=>foldHeader(h)===foldHeader(chosen));if(at>=0)out[at]=label;
 }
 return out;
}
const declarative=(kind:ImportKind):ScreenTemplate=>{
 const t=IMPORT_TEMPLATES[kind];
 return{kind,slug:IMPORT_SLUGS[kind],title:t.title,noun:t.noun,rule:t.rule,readOnly:t.readOnly,
  columns:t.columns!.map(c=>({label:c.label,key:c.key,required:Boolean(c.required||(c.group))})),
  parse:(cells,mapping)=>templateRows(kind,cells,mapping),
  model:format=>{const header=[templateHeader(kind).map(label=>textCell(label))];return format==='xlsx'?toXlsx(t.title.slice(0,31),header):toCsv(header);},
  identity:item=>{const d=item.data as Record<string,unknown>,n=(d.items as unknown[]|undefined)?.length??0;
   // 265: Composição <código> · N componentes, Produto <código> · N campos, <produto> · <fornecedor>.
   if(kind==='compositions')return `Composição ${String(d.code??'—')} · ${n} ${n===1?'componente':'componentes'}`;
   if(kind==='custom_fields')return `Produto ${String(d.code??'—')} · ${n} ${n===1?'campo':'campos'}`;
   if(kind==='product_suppliers')return [d.code,d.supplier_name??d.supplier_document].filter(Boolean).join(' · ')||'—';
   // 300: <produto> · Lote <lote>.
   if(kind==='lots')return [d.code,d.lot?`Lote ${String(d.lot)}`:null].filter(Boolean).join(' · ')||'—';
   return String(isGroupedKind(kind)?`${kind==='nfe'?'Nota':'Pedido'} ${d.number??'—'} · ${n} itens`
   :kind==='products'?[d.code,d.name].filter(Boolean).join(' · ')||'—':kind==='stock_movements'?[d.code,d.warehouse].filter(Boolean).join(' · '):[d.contact_name??d.contact_document,d.description].filter(Boolean).join(' · '));}};
};
// Contatos: the columns of "Exportar para a planilha" of the contatos lane, read by its own row reader (contact-import-model.ts).
const contacts:ScreenTemplate={kind:'contacts',slug:IMPORT_SLUGS.contacts,title:IMPORT_TEMPLATES.contacts.title,noun:IMPORT_TEMPLATES.contacts.noun,rule:IMPORT_TEMPLATES.contacts.rule,
 readOnly:IMPORT_TEMPLATES.contacts.readOnly,columns:SHEET_COLUMNS.filter(([,key])=>!CONTACT_READ_ONLY.has(key)).map(([label,key])=>({label,key,required:key==='name'})),
 parse(cells,mapping,{types}){
  const[header=[],...lines]=cells,labels=SHEET_COLUMNS.map(([label])=>label),renamed=remapHeader(header,labels,mapping);
  const parsed=contactImportRows([renamed,...lines.map(l=>[...l])],types),known=new Set(labels.map(foldHeader));
  return{items:parsed.rows.map(r=>({row:r.row,lines:[r.row],data:r.data as ImportItem['data'],problems:r.problems})),missing:parsed.missingName?['Nome']:[],
   unknown:renamed.filter(h=>h.trim()&&!known.has(foldHeader(h))),readOnly:[...IMPORT_TEMPLATES.contacts.readOnly].filter(l=>renamed.some(h=>foldHeader(h)===foldHeader(l)))};
 },
 model:format=>format==='xlsx'?contactModelXlsx():contactModelCsv(),
 identity:item=>{const d=item.data as Record<string,unknown>;return[d.name,d.document].filter(Boolean).join(' · ')||'—';}};
export const SCREEN_TEMPLATES:Readonly<Record<ImportKind,ScreenTemplate>>={products:declarative('products'),contacts,purchase_orders:declarative('purchase_orders'),
 stock_movements:declarative('stock_movements'),receivables:declarative('receivables'),payables:declarative('payables'),sales_orders:declarative('sales_orders'),nfe:declarative('nfe'),
 compositions:declarative('compositions'),custom_fields:declarative('custom_fields'),product_suppliers:declarative('product_suppliers'),lots:declarative('lots')};
/** Automatic "Relacionar colunas": each field takes the sheet column with its name (accents and case ignored), else none. */
export function autoMapping(template:ScreenTemplate,header:readonly string[]){
 const out:Record<string,string>={};
 for(const c of template.columns){const found=header.find(h=>foldHeader(h)===foldHeader(c.label));out[c.label]=found?String(found).trim():'';}
 return out;
}

// ---- Batches: at most IMPORT_BATCH_ITEMS items and IMPORT_BATCH_LINES lines each ----
export function batches<T extends {lines:number[]}>(items:readonly T[]):T[][]{
 const out:T[][]=[];let current:T[]=[],lines=0;
 for(const item of items){if(current.length&&(current.length>=IMPORT_BATCH_ITEMS||lines+item.lines.length>IMPORT_BATCH_LINES)){out.push(current);current=[];lines=0;}current.push(item);lines+=item.lines.length;}
 if(current.length)out.push(current);return out;
}
export const batchPath=(kind:ImportKind)=>`${IMPORT_BASE}/${IMPORT_SLUGS[kind]}/lote`;
export const jobsPath=(q:ImportJobsQuery)=>`${IMPORT_BASE}?${new URLSearchParams({...(q.status?{situacao:q.status}:{}),limit:String(q.limit),offset:String(q.offset)})}`;
export const jobPath=(q:ImportJobQuery)=>`${IMPORT_BASE}/${q.id}?${new URLSearchParams({...(q.errors?{erros:'1'}:{}),limit:String(q.limit),offset:String(q.offset)})}`;
export const IMPORT_JOBS_SCREEN='/preferencias/sistema/gestao-acoes';
export const importScreen=(kind:ImportKind)=>`/preferencias/importacoes/${IMPORT_SLUGS[kind]}`;

// ---- Texts ----
const FIELD_EXTRA:Record<string,string>={item_code:'Código do produto',name:'Nome',document:'CPF/CNPJ',post_mode:'Lançar estoque'};
export function fieldLabel(kind:ImportKind,field:string|null){
 if(!field)return null;
 const own=SCREEN_TEMPLATES[kind].columns.find(c=>c.key===field)?.label;
 return own??(kind==='products'&&field==='name'?'Descrição':FIELD_EXTRA[field]??field);
}
const REASONS:Record<string,string>={erp_catalog_name_required:'obrigatório para incluir',erp_catalog_duplicate_document:'CPF/CNPJ duplicado não permitido',
 erp_stock_insufficient_or_excess_quantity:'Estoque insuficiente: a política de estoque não permite saldo negativo',erp_stock_reserved_quantity_unavailable:'Quantidade reservada por pedidos de venda',
 erp_finance_invalid_due_date:'Data de vencimento anterior à data de emissão',erp_finance_invalid_contact:'Contato inativo ou inexistente',erp_catalog_contact_not_visible:'Fora da carteira do seu vendedor',
 erp_preferences_import_conflict:'O cadastro mudou durante a importação; importe a linha de novo',erp_preferences_import_duplicate:'Registro duplicado',
 erp_catalog_contact_deleted:'Contato excluído: restaure-o antes de atualizar',erp_catalog_product_deleted:'Produto excluído: restaure-o antes de atualizar',
 erp_catalog_invalid_url:'Endereço inválido (use http:// ou https://)',erp_catalog_invalid_identifier:'Código fora do formato',erp_catalog_invalid_enum:'Opção inválida',
 erp_document_contact_inactive:'Contato inativo',erp_catalog_gtin_invalid:'GTIN/EAN inválido',
 // 265: composições, campos customizados and fornecedores de produtos.
 erp_stock_composition_component_unavailable:'Componente inativo, excluído ou que não é um produto simples com unidade',erp_stock_composition_invalid:'Estrutura inválida (componente repetido ou o próprio produto)',
 erp_stock_composition_has_stock:'A composição tem saldo próprio e não pode passar a Virtual',erp_stock_composition_format_required:'O produto não pode ter o formato Com composição',
 erp_stock_composition_conflict:'A composição mudou durante a importação; importe a linha de novo',erp_catalog_invalid_custom_value:'Valor fora do formato do campo',
 erp_catalog_custom_field_unavailable:'Campo inativo ou que não vale para a categoria do produto',erp_catalog_custom_field_required:'O produto tem um campo customizado obrigatório sem valor',
 erp_catalog_invalid_list:'Lista de fornecedores inválida (até 20, um só padrão)',
 // 300: lotes (erp_stock_lot_import, 258/277).
 erp_stock_lot_control_off:'O produto não tem Controle de lote (aba Estoque do produto) ou não é um produto simples',erp_stock_lot_invalid:'Lote, datas ou Obs. fora do formato (a fabricação vem antes da validade)',
 erp_stock_lot_expiry_required:'Data de validade obrigatória pelas Preferências (Controle de lotes)',erp_stock_lot_manufacture_required:'Data de fabricação obrigatória pelas Preferências (Controle de lotes)',
 erp_stock_product_not_found:'Produto não encontrado',erp_stock_lot_conflict:'O lote mudou durante a importação; importe a linha de novo'};
/** Portuguese text of one refused line: the field when the server names it, then the reason. */
export function reasonText(kind:ImportKind,result:Pick<ImportResult,'reason'|'field'>){
 const reason=result.reason??'',[base]=reason.split(':'),label=fieldLabel(kind,result.field);
 if(base==='erp_preferences_import_not_found')return `${label}: não encontrado no FAGOO`;
 if(base==='erp_preferences_import_ambiguous')return `${label}: há mais de um cadastro com esse valor`;
 if(base==='erp_preferences_import_required')return label==='Depósito'?'Depósito: informe o depósito (não há depósito padrão)':label==='Natureza de operação'?'Natureza de operação: informe a natureza ou defina a padrão em Naturezas de operação':`${label}: obrigatório`;
 if(base==='erp_preferences_import_company_regime')return 'Confirme o regime tributário em Alterar dados da empresa antes de importar notas';
 if(base==='erp_preferences_import_invalid')return label==='Quantidade'?'Quantidade: maior que zero para Entrada e Saída':label==='Lançar estoque'?'Lançar estoque: a composição Virtual lança só os Componentes':`Confira ${label}`;
 if(base==='erp_catalog_contact_required')return `Obrigatório pelas Preferências: ${label}`;
 if(base==='erp_catalog_contact_invalid')return `Confira ${label}`;
 if(base==='erp_catalog_name_required')return `${label??(kind==='products'?'Descrição':'Nome')}: ${REASONS[base]}`;
 const text=REASONS[base!];if(text)return label?`${label}: ${text}`:text;
 return `Linha recusada pelo FAGOO (${reason})`;
}
export const STATUS_TEXT:Record<ImportResult['status'],string>={valid:'Válido',created:'Incluído',updated:'Atualizado',unchanged:'Sem alteração',invalid:'Com erro'};
export const ACTION_TEXT:Record<'create'|'update',string>={create:'Incluir',update:'Atualizar'};
export const JOB_STATUS_TEXT:Record<ImportJob['status'],string>={em_andamento:'Em andamento',concluida:'Concluída'};
export const KIND_TEXT:Record<ImportKind,string>=Object.fromEntries(Object.entries(IMPORT_TEMPLATES).map(([kind,t])=>[kind,t.title])) as Record<ImportKind,string>;
/** A job without a batch for 30 minutes was left behind (the screen was closed): it says so instead of "Em andamento". */
export function jobState(job:Pick<ImportJob,'status'|'updated_at'>,now=Date.now()){
 if(job.status==='concluida')return 'Concluída';
 return now-Date.parse(job.updated_at)>30*60000?'Interrompida':'Em andamento';
}
export const plural=(n:number,[one,many]:readonly [string,string])=>`${n.toLocaleString('pt-BR')} ${n===1?one:many}`;
