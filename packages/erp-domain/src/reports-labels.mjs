/** Closed 149 contract, shared by the API boundary and the browser (routes under /v1/sistema):
 * - Relatórios customizados: the base views (same catalog as erp_preferences.report_catalog), the list, the run of one
 *   page of a definition, and the commands Salvar and Excluir;
 * - Etiquetas customizadas: Padrões and Customizadas, the model (Etiqueta, Página, Campos), Salvar, Excluir and the records
 *   to print. */
import { documentNativeCoverage } from './document-mirror.mjs';
export const REPORT_GROUPS=Object.freeze({cadastros:'Cadastros',suprimentos:'Suprimentos',vendas:'Vendas',financas:'Finanças',servicos:'Serviços',preferencias:'Preferências'});
const col=(id,label,type='text')=>Object.freeze({id,label,type});
const DOC=(contact,seller=true)=>[col('numero','Número','int'),col('data','Data','date'),col('contato',contact),col('situacao','Situação'),...(seller?[col('vendedor','Vendedor')]:[]),col('itens','Itens','int'),col('total','Total','money')];
const TITLES=contact=>[col('vencimento','Vencimento','date'),col('emissao','Emissão','date'),col('contato',contact),col('descricao','Histórico'),col('categoria','Categoria'),col('parcela','Parcela'),col('valor','Valor','money'),col('saldo','Saldo','money'),col('situacao','Situação')];
const NOTES=(contact,uf=true)=>[col('numero','Número','int'),col('serie','Série','int'),col('emissao','Data de emissão','date'),col('contato',contact),col('documento','CPF/CNPJ'),...(uf?[col('uf','UF')]:[]),
 col('natureza','Natureza de operação'),col('situacao','Situação'),col('total','Valor total','money'),col('chave','Chave de acesso')];
// 264: one baixa of a conta (Recebimentos / Pagamentos).
const SETTLEMENTS=(day,contact,value)=>[col('data',day,'date'),col('vencimento','Vencimento','date'),col('contato',contact),col('descricao','Histórico'),col('categoria','Categoria'),col('parcela','Parcela'),
 col('conta','Conta financeira'),col('valor',value,'money'),col('juros','Juros','money'),col('multa','Multa','money'),col('desconto','Desconto','money'),col('tarifa','Tarifa','money'),
 col('liquido','Valor líquido','money'),col('situacao','Situação')];
const base=(id,group,title,columns,defaults)=>Object.freeze({base:id,group,title,default_columns:Object.freeze(defaults),columns:Object.freeze(columns)});
// 284: Ficha Financeira (each conta of a contact) and the Ocorrências of a document kind.
const FICHA=(contact,paid)=>[col('contato',contact),col('documento','CPF/CNPJ'),col('emissao','Emissão','date'),col('vencimento','Vencimento','date'),col('descricao','Histórico'),col('parcela','Parcela'),
 col('valor','Valor','money'),col('pago',paid,'money'),col('saldo','Saldo','money'),col('situacao','Situação')];
const OCCURRENCES=proposals=>[col('numero','Número','int'),col('contato','Cliente'),col('data','Data','date'),col('hora','Hora'),col('situacao_anterior','Situação anterior'),col('situacao','Situação'),
 col('ocorrencia','Ocorrência'),...(proposals?[col('proximo_contato','Próximo contato','date')]:[]),col('usuario','Usuário')];
/** Same order and content as the SQL catalog (the PGlite test compares them). */
export const REPORT_BASES=Object.freeze([
 base('produtos','cadastros','Produtos',[col('codigo','Código'),col('descricao','Descrição'),col('unidade','Unidade'),col('preco','Preço','decimal'),col('tipo','Tipo'),col('situacao','Situação'),col('gtin','GTIN/EAN'),col('ncm','NCM')],['codigo','descricao','unidade','preco','situacao']),
 base('contatos','cadastros','Clientes e Fornecedores',[col('nome','Nome'),col('fantasia','Fantasia'),col('documento','CPF/CNPJ'),col('ie','IE'),col('cidade','Cidade'),col('uf','UF'),col('telefone','Telefone'),col('celular','Celular'),col('email','E-mail'),
  col('tipos','Tipo de contato'),col('situacao','Situação')],['nome','documento','cidade','uf','telefone','email']),
 base('contas_receber','financas','Contas a Receber',TITLES('Cliente'),['vencimento','contato','descricao','valor','saldo','situacao']),
 base('contas_pagar','financas','Contas a Pagar',TITLES('Fornecedor'),['vencimento','contato','descricao','valor','saldo','situacao']),
 base('vendas','vendas','Vendas',DOC('Cliente'),['numero','data','contato','situacao','total']),
 base('propostas','vendas','Propostas Comerciais',DOC('Cliente'),['numero','data','contato','situacao','total']),
 base('pedidos_compra','suprimentos','Pedidos de Compra',DOC('Fornecedor',false),['numero','data','contato','situacao','total']),
 base('ordens_servico','servicos','Ordens de Serviço',DOC('Cliente'),['numero','data','contato','situacao','total']),
 // 230: the notes of Brufap (NF-e de saída, NF-e de entrada and NFC-e), read by administrador, consulta and fiscal.
 base('notas_saida','vendas','NF-e de saída',NOTES('Cliente'),['numero','serie','emissao','contato','situacao','total']),
 base('notas_entrada','suprimentos','NF-e de entrada',NOTES('Fornecedor'),['numero','serie','emissao','contato','situacao','total']),
 base('nfce','vendas','NFC-e',NOTES('Cliente',false),['numero','serie','emissao','contato','situacao','total']),
 // 264: Recebimentos, Pagamentos, Venda Parcela, Comissões and Caixa (finance and sales data of the other lanes, read-only).
 base('recebimentos','financas','Recebimentos',SETTLEMENTS('Data do recebimento','Cliente','Valor recebido'),['data','contato','descricao','valor','conta']),
 base('pagamentos','financas','Pagamentos',SETTLEMENTS('Data do pagamento','Fornecedor','Valor pago'),['data','contato','descricao','valor','conta']),
 base('venda_parcela','vendas','Venda Parcela',[col('numero','Número da venda','int'),col('data','Data da venda','date'),col('contato','Cliente'),col('situacao','Situação'),col('parcela','Parcela'),
  col('vencimento','Vencimento','date'),col('valor','Valor da parcela','money'),col('forma','Forma de pagamento'),col('observacao','Observação')],['numero','data','contato','parcela','vencimento','valor']),
 base('comissoes','financas','Comissões',[col('vendedor','Vendedor'),col('origem','Origem'),col('pedido','Número do pedido','int'),col('descricao','Descrição'),col('parcela','Valor da parcela','money'),
  col('base','Base de cálculo','money'),col('aliquota','Alíquota (%)','decimal'),col('comissao','Comissão','money'),col('vencimento','Vencimento','date'),col('liberada','Liberada em','date'),col('situacao','Situação')],
  ['vendedor','pedido','base','aliquota','comissao','situacao']),
 base('caixa','financas','Caixa',[col('data','Data','date'),col('conta','Conta financeira'),col('descricao','Histórico'),col('contato','Contato'),col('categoria','Categoria'),col('tipo','Tipo'),
  col('entrada','Entrada','money'),col('saida','Saída','money')],['data','conta','descricao','entrada','saida']),
 // 284 (mixed lane, wave F): the other standard reports of Origin over data Brufap has (Contratos has no module in Brufap; Ordens de
 // Produção, Balanças, Produto Loja, NFS-e and Nota Serviço Parcela are out of scope).
 base('curva_abc','vendas','Curva ABC de itens de vendas',[col('classe','Classe'),col('codigo','Código'),col('descricao','Descrição'),col('quantidade','Quantidade vendida','decimal'),
  col('valor','Valor total','money'),col('percentual','% do total','decimal'),col('acumulado','% acumulado','decimal'),col('pedidos','Pedidos','int')],['classe','codigo','descricao','quantidade','valor','acumulado']),
 base('pessoas_contato','cadastros','Pessoas de Contato',[col('contato','Contato'),col('documento','CPF/CNPJ do contato'),col('nome','Nome'),col('email','E-mail'),col('telefone','Telefone'),
  col('celular','Celular')],['contato','nome','email','telefone']),
 base('ficha_receber','financas','Ficha Financeira a Receber',FICHA('Cliente','Valor recebido'),['contato','vencimento','descricao','valor','pago','saldo','situacao']),
 base('ficha_pagar','financas','Ficha Financeira a Pagar',FICHA('Fornecedor','Valor pago'),['contato','vencimento','descricao','valor','pago','saldo','situacao']),
 base('ocorrencias_propostas','vendas','Ocorrências por Proposta Comercial',OCCURRENCES(true),['numero','contato','data','situacao','ocorrencia','proximo_contato']),
 base('ocorrencias_os','servicos','Ocorrências por Ordem de Serviço',OCCURRENCES(false),['numero','contato','data','situacao','ocorrencia']),
 base('ocorrencias_vendas','vendas','Ocorrências por Venda',OCCURRENCES(false),['numero','contato','data','situacao','ocorrencia']),
 base('transporte_nota','vendas','Transporte por Nota Fiscal',[col('numero','Número','int'),col('serie','Série','int'),col('emissao','Data de emissão','date'),col('contato','Cliente'),
  col('transportador','Transportador'),col('documento_transportador','CPF/CNPJ do transportador'),col('frete','Frete por conta'),col('valor_frete','Valor do frete','money'),col('volumes','Volumes','int'),
  col('especie','Espécie'),col('peso_bruto','Peso bruto','decimal'),col('peso_liquido','Peso líquido','decimal'),col('placa','Placa'),col('rastreamento','Código de rastreamento')],
  ['numero','emissao','contato','transportador','frete','volumes','peso_bruto']),
 base('transporte_venda','vendas','Transporte por Venda',[col('numero','Número','int'),col('data','Data','date'),col('contato','Cliente'),col('situacao','Situação'),col('transportador','Transportador'),
  col('frete','Frete por conta'),col('valor_frete','Valor do frete','money'),col('volumes','Volumes','decimal'),col('peso_bruto','Peso bruto','decimal'),col('prazo','Prazo de entrega (dias)','int'),
  col('rastreamento','Código de rastreamento')],['numero','data','contato','transportador','frete','volumes','peso_bruto']),
]);
/** Report bases of migration 149 (the applied catalog before 230). */
export const REPORT_BASES_149=Object.freeze(REPORT_BASES.slice(0,8));
/** Report bases of migration 230 (the applied catalog before 264). */
export const REPORT_BASES_230=Object.freeze(REPORT_BASES.slice(0,11));
/** Report bases of migration 264 (the applied catalog before 284). */
export const REPORT_BASES_264=Object.freeze(REPORT_BASES.slice(0,16));
export const REPORT_PAGE=200,REPORT_PREVIEW=20,REPORT_MAX_LIMIT=2000,REPORT_DEFAULT_LIMIT=2000,FRAMEWORK_BODY_BYTES=16384;
export class ReportsContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new ReportsContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const input=v=>need(v,400,'ERP_INVALID_INPUT'),query=v=>need(v,400,'ERP_INVALID_QUERY');
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const keys=(v,list)=>plain(v)&&Object.keys(v).length===list.length&&list.every(k=>Object.hasOwn(v,k));
const exact=(v,list,...e)=>need(keys(v,list),...e);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,CONTROL=/[\u0000-\u001f\u007f]/,NUMBER=/^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$/;
export const reportUuid=v=>typeof v==='string'&&UUID.test(v);
const name=(v,max)=>typeof v==='string'&&[...v].length>=1&&[...v].length<=max&&v===v.trim()&&!CONTROL.test(v);
const int=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(v)&&Number.isFinite(Date.parse(v.replace(' ','T')));
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};
// Structural equality: jsonb returns object keys in its own order.
const same=(a,b)=>Array.isArray(a)?Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>same(x,b[i])):plain(a)?plain(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k])):Object.is(a,b);
export const sameJson=same;
export const reportBase=id=>REPORT_BASES.find(b=>b.base===id)??null;
const cell=(type,v)=>v===null||(typeof v==='string'&&(type==='text'?[...v].length<=200&&!CONTROL.test(v):type==='date'?/^\d{4}-\d{2}-\d{2}$/.test(v):type==='int'?/^(0|[1-9][0-9]{0,17})$/.test(v):type==='money'?/^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(v):NUMBER.test(v)));

/** Columns (1..30 known, distinct) and filters (up to 10 {column, value}); numeric columns filter by an exact number. */
function definition(baseId,columns,filters,status=400,code='ERP_INVALID_INPUT'){
 const b=reportBase(baseId);need(b&&Array.isArray(columns)&&columns.length>=1&&columns.length<=30&&new Set(columns).size===columns.length&&columns.every(c=>b.columns.some(k=>k.id===c)),status,code);
 need(Array.isArray(filters)&&filters.length<=10,status,code);
 for(const f of filters){need(keys(f,['column','value'])&&name(f.value,100),status,code);const k=b.columns.find(x=>x.id===f.column);need(k&&(!['money','decimal','int'].includes(k.type)||NUMBER.test(f.value)),status,code);}
 return b;
}
function report(r,dir){exact(r,['id','base','title','columns','filters','view_limit','with_totals','users','version','updated_at']);
 need(reportUuid(r.id)&&name(r.title,80)&&int(r.view_limit,1,REPORT_MAX_LIMIT)&&typeof r.with_totals==='boolean'&&Array.isArray(r.users)&&r.users.length<=100&&r.users.every(reportUuid)
  &&new Set(r.users).size===r.users.length&&[...r.users].sort().every((u,i)=>u===r.users[i])&&int(r.version,1)&&stamp(r.updated_at));
 definition(r.base,r.columns,r.filters,502,'ERP_UPSTREAM_INVALID_RESPONSE');}
export function parseReports(raw){
 const v=snapshot(raw);exact(v,['scope','data_mode','can_manage','bases','reports','directory']);
 need(v.scope==='reports'&&v.data_mode==='erp_native'&&typeof v.can_manage==='boolean'&&Array.isArray(v.bases)&&v.bases.length<=REPORT_BASES.length&&Array.isArray(v.reports)&&v.reports.length<=200);
 let last=-1;for(const b of v.bases){const i=REPORT_BASES.findIndex(x=>x.base===b?.base);need(i>last&&same(b,REPORT_BASES[i]));last=i;}
 const ids=new Set(),titles=new Set();for(const r of v.reports){report(r);need(v.bases.some(b=>b.base===r.base)&&!ids.has(r.id)&&!titles.has(r.title.toLowerCase()));ids.add(r.id);titles.add(r.title.toLowerCase());}
 if(v.can_manage){need(Array.isArray(v.directory)&&v.directory.length<=500);for(const d of v.directory){exact(d,['user_id','role','label']);need(reportUuid(d.user_id)&&typeof d.role==='string'&&(d.label===null||name(d.label,200)));}}
 else need(v.directory===null);
 return v;
}
/** POST /v1/sistema/relatorios/execucao: {base, columns, filters, view_limit, offset, page} — a read. */
export function captureReportRun(raw){
 const v=snapshot(raw);input(keys(v,['base','columns','filters','view_limit','offset','page']));definition(v.base,v.columns,v.filters);
 input(int(v.view_limit,1,REPORT_MAX_LIMIT)&&int(v.page,1,REPORT_PAGE)&&int(v.offset,0,v.view_limit-1));
 return Object.freeze({base:v.base,columns:Object.freeze([...v.columns]),filters:Object.freeze(v.filters.map(f=>Object.freeze({column:f.column,value:f.value}))),view_limit:v.view_limit,offset:v.offset,page:v.page});
}
export function parseReportRows(raw,run){
 const v=snapshot(raw);let coverage;try{coverage=documentNativeCoverage(v);}catch{need(false);}
 if(coverage.origin)for(const key of ['origin','mirror_excluded_count','coverage'])delete v[key];
 exact(v,['scope','data_mode','base','columns','rows','offset','total_rows','truncated','totals']);const b=reportBase(run.base);
 need(v.scope==='report_rows'&&v.data_mode==='erp_native'&&v.base===run.base&&same(v.columns,[...run.columns])&&v.offset===run.offset&&int(v.total_rows,0,run.view_limit)&&typeof v.truncated==='boolean');
 need(Array.isArray(v.rows)&&v.rows.length<=Math.min(run.page,Math.max(0,v.total_rows-run.offset))&&(v.rows.length>0||v.total_rows<=run.offset));
 const types=run.columns.map(c=>b.columns.find(k=>k.id===c).type);
 for(const row of v.rows)need(Array.isArray(row)&&row.length===types.length&&row.every((x,i)=>cell(types[i],x)));
 exact(v.totals,run.columns.filter((c,i)=>['money','decimal'].includes(types[i])));for(const t of Object.values(v.totals))need(typeof t==='string'&&NUMBER.test(t));
 return {...v,...coverage};
}
/** POST /v1/sistema/relatorios: {command_id, id (null = novo), expected_version, data:{base,title,columns,filters,view_limit,with_totals,users}}. */
export function captureReportSave(raw){
 const v=snapshot(raw);input(keys(v,['command_id','id','expected_version','data'])&&reportUuid(v.command_id)&&(v.id===null||reportUuid(v.id))&&int(v.expected_version,0,2147483646)&&(v.id===null)===(v.expected_version===0));
 const d=v.data;input(keys(d,['base','title','columns','filters','view_limit','with_totals','users'])&&name(d.title,80)&&int(d.view_limit,1,REPORT_MAX_LIMIT)&&typeof d.with_totals==='boolean'
  &&Array.isArray(d.users)&&d.users.length<=100&&d.users.every(reportUuid)&&new Set(d.users).size===d.users.length);definition(d.base,d.columns,d.filters);
 return Object.freeze({command_id:v.command_id,id:v.id,expected_version:v.expected_version,data:Object.freeze({base:d.base,title:d.title,columns:Object.freeze([...d.columns]),
  filters:Object.freeze(d.filters.map(f=>Object.freeze({column:f.column,value:f.value}))),view_limit:d.view_limit,with_totals:d.with_totals,users:Object.freeze([...d.users].sort())})});
}
/** POST /v1/sistema/relatorios/exclusao and /v1/sistema/etiquetas/exclusao: {command_id, items:[{id,expected_version}]}. */
export function captureFrameworkDelete(raw){
 const v=snapshot(raw);input(keys(v,['command_id','items'])&&reportUuid(v.command_id)&&Array.isArray(v.items)&&v.items.length>=1&&v.items.length<=100);
 const ids=new Set();for(const i of v.items){input(keys(i,['id','expected_version'])&&reportUuid(i.id)&&!ids.has(i.id)&&int(i.expected_version,1));ids.add(i.id);}
 return Object.freeze({command_id:v.command_id,items:Object.freeze(v.items.map(i=>Object.freeze({id:i.id,expected_version:i.expected_version})))});
}
/** `operation`: report-save | reports-delete | label-save | labels-delete. */
export function parseFrameworkResult(raw,sent,operation){
 const area=operation.startsWith('report')?'reports':'labels',v=snapshot(raw);exact(v,['scope','data_mode','receipt','replayed']);
 need(v.scope===`${area}_command`&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean');
 const r=v.receipt;exact(r,['command_id','action','target','count','changed_at']);need(r.command_id===sent.command_id&&stamp(r.changed_at));
 if(operation.endsWith('save')){const one=area==='reports'?'report':'label';need(r.action===`${one}_${sent.id===null?'create':'update'}`&&reportUuid(r.target)&&(sent.id===null||r.target===sent.id)&&r.count===1);}
 else need(r.action===`${area}_delete`&&r.target===null&&r.count===sent.items.length);
 return v;
}

// Etiquetas customizadas.
export const LABEL_TYPES=Object.freeze(['contato','produto','nota_fiscal','ordem_servico','pedido_venda']);
export const LABEL_TYPE_LABELS=Object.freeze({contato:'Contato',produto:'Produto',nota_fiscal:'Nota Fiscal',ordem_servico:'Ordem de Serviço',pedido_venda:'Pedidos de Venda'});
export const LABEL_FIELDS=Object.freeze({produto:Object.freeze({codigo:'Código',descricao:'Descrição',preco:'Preço',unidade:'Unidade',gtin:'GTIN/EAN',ncm:'NCM'}),
 contato:Object.freeze({nome:'Nome',fantasia:'Fantasia',documento:'CPF/CNPJ',endereco:'Endereço',bairro:'Bairro',cidade_uf:'Cidade/UF',cep:'CEP',telefone:'Telefone'}),
 pedido_venda:Object.freeze({numero:'Número',data:'Data',cliente:'Cliente',endereco_cliente:'Endereço',cidade_uf:'Cidade/UF',cep:'CEP',total:'Total'}),
 ordem_servico:Object.freeze({numero:'Número',data:'Data',cliente:'Cliente',total:'Total'}),
 nota_fiscal:Object.freeze({numero:'Número',serie:'Série',cliente:'Cliente',endereco_cliente:'Endereço',cidade_uf:'Cidade/UF',chave:'Chave de acesso'})});
/** Types whose records this module reads for printing (230: Nota Fiscal, the NF-e of Brufap). */
export const LABEL_PRINTABLE=Object.freeze(['produto','contato','pedido_venda','ordem_servico','nota_fiscal']);
export const LABEL_FONTS=Object.freeze([['helvetica','Helvetica'],['courier','Courier'],['monospace','Monospace'],['times','Times']]);
/** Barcode formats drawn locally. */
// 231: UPC-E, C93 and QR CODE are generated in the browser too; 283 (wave F): DATA MATRIX (ECC 200). EBCT (Correios) is out of scope and
// PDF417 is not generated (its symbol tables are not in the Brufap).
export const LABEL_BARCODES=Object.freeze([['c128','C128'],['ean13','EAN13'],['upca','UPC-A'],['msi','MSI'],['upce','UPC-E'],['c93','C93'],['qr','QR CODE'],['datamatrix','DATA MATRIX']]);
export const LABEL_BARCODES_UNAVAILABLE=Object.freeze(['EBCT','PDF417']);
export const LABEL_PAGES=Object.freeze({A2:['420','594'],A3:['297','420'],A4:['210','297'],A5:['148','210']});
/** The five Padrões, same content as erp_preferences.label_defaults (the PGlite test compares them). */
export const LABEL_DEFAULTS=Object.freeze([
 Object.freeze({id:'padrao-contato',type:'contato',description:'Etiqueta de contato',config:Object.freeze({label:Object.freeze({width:'100',height:'40',font:'helvetica',font_size:'9',barcode:'c128',barcode_text:true,currency:false,show_labels:false,columns_gap:'3',rows_gap:'0'}),
  page:Object.freeze({size:'A4',width:null,height:null,orientation:'portrait',margin_left:'5',margin_top:'10'}),
  fields:Object.freeze([Object.freeze({field:'nome',x:'4',y:'4',size:'10',bold:true,barcode:false}),Object.freeze({field:'endereco',x:'4',y:'11',size:'9',bold:false,barcode:false}),Object.freeze({field:'bairro',x:'4',y:'17',size:'9',bold:false,barcode:false}),Object.freeze({field:'cidade_uf',x:'4',y:'23',size:'9',bold:false,barcode:false}),Object.freeze({field:'cep',x:'4',y:'29',size:'9',bold:true,barcode:false})])})}),
 Object.freeze({id:'padrao-produto',type:'produto',description:'Etiqueta de produto',config:Object.freeze({label:Object.freeze({width:'50',height:'30',font:'helvetica',font_size:'8',barcode:'ean13',barcode_text:true,currency:true,show_labels:false,columns_gap:'2',rows_gap:'2'}),
  page:Object.freeze({size:'A4',width:null,height:null,orientation:'portrait',margin_left:'5',margin_top:'10'}),
  fields:Object.freeze([Object.freeze({field:'descricao',x:'2',y:'2',size:'8',bold:true,barcode:false}),Object.freeze({field:'preco',x:'2',y:'8',size:'11',bold:true,barcode:false}),Object.freeze({field:'gtin',x:'2',y:'14',size:'8',bold:false,barcode:true})])})}),
 Object.freeze({id:'padrao-nota-fiscal',type:'nota_fiscal',description:'Etiqueta de nota fiscal',config:Object.freeze({label:Object.freeze({width:'100',height:'50',font:'helvetica',font_size:'9',barcode:'c128',barcode_text:true,currency:false,show_labels:true,columns_gap:'3',rows_gap:'0'}),
  page:Object.freeze({size:'A4',width:null,height:null,orientation:'portrait',margin_left:'5',margin_top:'10'}),
  fields:Object.freeze([Object.freeze({field:'numero',x:'4',y:'4',size:'10',bold:true,barcode:false}),Object.freeze({field:'serie',x:'60',y:'4',size:'10',bold:false,barcode:false}),Object.freeze({field:'cliente',x:'4',y:'11',size:'9',bold:false,barcode:false}),Object.freeze({field:'endereco_cliente',x:'4',y:'17',size:'9',bold:false,barcode:false}),Object.freeze({field:'cidade_uf',x:'4',y:'23',size:'9',bold:false,barcode:false}),Object.freeze({field:'chave',x:'4',y:'30',size:'7',bold:false,barcode:true})])})}),
 Object.freeze({id:'padrao-ordem-servico',type:'ordem_servico',description:'Etiqueta de ordem de serviço',config:Object.freeze({label:Object.freeze({width:'100',height:'30',font:'helvetica',font_size:'9',barcode:'c128',barcode_text:true,currency:true,show_labels:true,columns_gap:'3',rows_gap:'0'}),
  page:Object.freeze({size:'A4',width:null,height:null,orientation:'portrait',margin_left:'5',margin_top:'10'}),
  fields:Object.freeze([Object.freeze({field:'numero',x:'4',y:'4',size:'10',bold:true,barcode:false}),Object.freeze({field:'data',x:'60',y:'4',size:'9',bold:false,barcode:false}),Object.freeze({field:'cliente',x:'4',y:'12',size:'9',bold:false,barcode:false}),Object.freeze({field:'total',x:'4',y:'20',size:'9',bold:true,barcode:false})])})}),
 Object.freeze({id:'padrao-pedido-venda',type:'pedido_venda',description:'Etiqueta de pedido de venda',config:Object.freeze({label:Object.freeze({width:'100',height:'50',font:'helvetica',font_size:'9',barcode:'c128',barcode_text:true,currency:true,show_labels:false,columns_gap:'3',rows_gap:'0'}),
  page:Object.freeze({size:'A4',width:null,height:null,orientation:'portrait',margin_left:'5',margin_top:'10'}),
  fields:Object.freeze([Object.freeze({field:'numero',x:'4',y:'4',size:'10',bold:true,barcode:false}),Object.freeze({field:'cliente',x:'4',y:'11',size:'9',bold:false,barcode:false}),Object.freeze({field:'endereco_cliente',x:'4',y:'17',size:'9',bold:false,barcode:false}),Object.freeze({field:'cidade_uf',x:'4',y:'23',size:'9',bold:false,barcode:false}),Object.freeze({field:'cep',x:'4',y:'29',size:'9',bold:true,barcode:false}),Object.freeze({field:'numero',x:'4',y:'36',size:'8',bold:false,barcode:true})])})})
]);
const MM=/^(0|[1-9][0-9]{0,2})(\.[0-9])?$/;
const mm=(v,min,max)=>typeof v==='string'&&MM.test(v)&&Number(v)>=min&&Number(v)<=max;
/** Same rules as erp_preferences.label_check. */
export function labelConfigValid(type,c){
 const fields=LABEL_FIELDS[type];if(!fields||!keys(c,['label','page','fields']))return false;const l=c.label,g=c.page;
 if(!keys(l,['width','height','font','font_size','barcode','barcode_text','currency','show_labels','columns_gap','rows_gap'])||!keys(g,['size','width','height','orientation','margin_left','margin_top']))return false;
 if(!LABEL_FONTS.some(f=>f[0]===l.font)||!LABEL_BARCODES.some(b=>b[0]===l.barcode)||![l.barcode_text,l.currency,l.show_labels].every(x=>typeof x==='boolean'))return false;
 if(!mm(l.width,5,300)||!mm(l.height,5,300)||!mm(l.font_size,4,72)||!mm(l.columns_gap,0,100)||!mm(l.rows_gap,0,100)||!mm(g.margin_left,0,100)||!mm(g.margin_top,0,100))return false;
 if(!['A2','A3','A4','A5','custom'].includes(g.size)||!['portrait','landscape'].includes(g.orientation))return false;
 if(g.size==='custom'?!(mm(g.width,20,999)&&mm(g.height,20,999)):g.width!==null||g.height!==null)return false;
 return Array.isArray(c.fields)&&c.fields.length>=1&&c.fields.length<=20&&c.fields.every(f=>keys(f,['field','x','y','size','bold','barcode'])&&Object.hasOwn(fields,f.field)
  &&mm(f.x,0,Number(l.width))&&mm(f.y,0,Number(l.height))&&mm(f.size,4,72)&&typeof f.bold==='boolean'&&typeof f.barcode==='boolean');
}
export function parseLabels(raw){
 const v=snapshot(raw);exact(v,['scope','data_mode','items']);need(v.scope==='labels'&&v.data_mode==='erp_native'&&Array.isArray(v.items)&&v.items.length>=5&&v.items.length<=105);
 const ids=new Set();v.items.forEach((t,i)=>{exact(t,['id','type','description','default','config','version','updated_at']);
  need(typeof t.id==='string'&&!ids.has(t.id)&&LABEL_TYPES.includes(t.type)&&name(t.description,80)&&typeof t.default==='boolean'&&labelConfigValid(t.type,t.config));
  if(i<5)need(t.default&&t.id===`padrao-${t.type.replace('_','-')}`&&t.version===0&&t.updated_at===null);else need(!t.default&&reportUuid(t.id)&&int(t.version,1)&&stamp(t.updated_at));ids.add(t.id);});
 return v;
}
/** POST /v1/sistema/etiquetas: {command_id, id (null = Clonar/novo), expected_version, data:{type, description, config}}. */
export function captureLabelSave(raw){
 const v=snapshot(raw);input(keys(v,['command_id','id','expected_version','data'])&&reportUuid(v.command_id)&&(v.id===null||reportUuid(v.id))&&int(v.expected_version,0,2147483646)&&(v.id===null)===(v.expected_version===0));
 input(keys(v.data,['type','description','config'])&&LABEL_TYPES.includes(v.data.type)&&name(v.data.description,80)&&labelConfigValid(v.data.type,v.data.config));
 return Object.freeze({command_id:v.command_id,id:v.id,expected_version:v.expected_version,data:v.data});
}
export function captureLabelRecordsQuery(raw={}){query(plain(raw)&&Object.keys(raw).every(k=>['tipo','busca'].includes(k))&&LABEL_PRINTABLE.includes(raw.tipo)&&(raw.busca===undefined||name(raw.busca,60)));
 return Object.freeze({type:raw.tipo,q:raw.busca??null});}
/** GET /v1/sistema/etiquetas/nota?id=<uuid>: the product labels of one note (230), each item with its quantity. */
export function captureLabelInvoiceQuery(raw={}){query(plain(raw)&&Object.keys(raw).length===1&&reportUuid(raw.id));return Object.freeze({id:raw.id});}
export function parseLabelInvoiceProducts(raw,q){
 const v=snapshot(raw);exact(v,['scope','data_mode','invoice','items']);need(v.scope==='label_invoice_products'&&v.data_mode==='erp_native'&&Array.isArray(v.items)&&v.items.length<=990);
 exact(v.invoice,['id','model','number','series']);need(v.invoice.id===q.id&&['55','65'].includes(v.invoice.model)&&(v.invoice.number===null||/^[1-9][0-9]{0,8}$/.test(v.invoice.number))&&/^(0|[1-9][0-9]{0,2})$/.test(v.invoice.series));
 const fields=Object.keys(LABEL_FIELDS.produto);let prior=0;
 for(const i of v.items){exact(i,['position','product_id','quantity','values']);need(int(i.position,1,990)&&i.position>prior&&(i.product_id===null||reportUuid(i.product_id))&&typeof i.quantity==='string'&&/^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$/.test(i.quantity)&&Number(i.quantity)>0);
  prior=i.position;exact(i.values,fields);for(const x of Object.values(i.values))need(x===null||typeof x==='string'&&[...x].length<=200&&!CONTROL.test(x));}
 return v;
}
export function parseLabelRecords(raw,q){
 const v=snapshot(raw);exact(v,['scope','data_mode','type','items']);need(v.scope==='label_records'&&v.data_mode==='erp_native'&&v.type===q.type&&Array.isArray(v.items)&&v.items.length<=100);
 const fields=Object.keys(LABEL_FIELDS[q.type]),ids=new Set();
 for(const i of v.items){exact(i,['id','values']);need(reportUuid(i.id)&&!ids.has(i.id));ids.add(i.id);exact(i.values,fields);for(const x of Object.values(i.values))need(x===null||typeof x==='string'&&[...x].length<=200&&!CONTROL.test(x));}
 return v;
}
