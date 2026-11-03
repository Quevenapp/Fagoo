import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {assertPreview,need,PRINT_LIMITS} from './extract.mjs';
import {code128C,qrCode} from './codes.mjs';
import {escapeHtml as e,decimalPt as d,moneyPt as m,localDate,keyPt,documentPt,addressText,wrap} from './format.mjs';
import {fieldLayout,issuerLayout} from './layout.mjs';
const CSS=readFileSync(new URL('./print.css',import.meta.url),'utf8');
const banner=p=>`<div class="preview">${e(p.banner)}<small>${e(p.bannerNote)}</small></div>`;
const cells=(names,values,cls='row5')=>`<div class="fields ${cls}">${fieldLayout(names,values,cls).cells.map(c=>`<div><span class="caption">${e(c.caption.join('\n'))}</span>${e(c.value.join('\n'))}</div>`).join('')}</div>`;
const freight={'0':'0 - Por conta do remetente','1':'1 - Por conta do destinatário','2':'2 - Por conta de terceiros','3':'3 - Próprio do remetente','4':'4 - Próprio do destinatário','9':'9 - Sem transporte'};
const PAY={'01':'Dinheiro','15':'Boleto bancário'};
const taxNames={pCredSN:'Crédito SN (%)',vCredICMSSN:'Crédito ICMS SN',vBCSTRet:'BC ST retida',pST:'ST (%)',vICMSSubstituto:'ICMS substituto',vICMSSTRet:'ICMS ST retido',vBCFCPSTRet:'BC FCP ST retido',pFCPSTRet:'FCP ST (%)',vFCPSTRet:'FCP ST retido',pRedBCEfet:'Redução BC efetiva (%)',vBCEfet:'BC efetiva',pICMSEfet:'ICMS efetivo (%)',vICMSEfet:'ICMS efetivo'};
function detail(item){
 const out=[`GTIN: ${item.gtin}; GTIN tributável: ${item.tributary.gtin}`,`Tributável: ${d(item.tributary.quantity)} ${item.tributary.unit} × ${d(item.tributary.unit_price)}`];
 if(item.cest)out.push('CEST: '+item.cest);
 for(const[k,label]of Object.entries({freight:'Frete',insurance:'Seguro',discount:'Desconto',other:'Outras despesas'}))if(item[k]!==null)out.push(label+': '+m(item[k]));
 for(const[k,v]of Object.entries(item.tax_details))out.push(taxNames[k]+': '+(k.startsWith('p')?d(v):m(v)));
 for(const[name,t]of Object.entries(item.contributions))out.push(`${name} CST ${t.cst}: BC ${m(t.base)}; alíquota ${d(t.rate)}%; valor ${m(t.amount)}`);
 if(item.total_tax!==null)out.push('Tributos totais: '+m(item.total_tax));if(item.additional)out.push(item.additional);
 return out.join(' · ');
}
const widths=[13,42,13,10,9,7,18,25,18,14,14,9,8],caps=[8,29,8,6,5,4,12,17,12,9,9,5,4];
const headings=['Código','Descrição do produto / serviço','NCM','Orig. / CSOSN','CFOP','Un.','Quantidade','Valor unitário','Valor total','BC ICMS','Valor ICMS','ICMS %','IPI %'];
function printRow(item){
 // Missing ICMS/IPI values stay absent; CSOSN 500 retention is NOT regular ICMS.
 const vals=[item.code,item.description,item.ncm,`${item.origin}/${item.csosn}`,item.cfop,item.unit,d(item.quantity),d(item.unit_price),m(item.product_amount),'-','-','-','-'];
 const lines=vals.map((v,i)=>wrap(v,caps[i])),extra=wrap(detail(item),140);
 return {height:Math.max(...lines.map(l=>l.length))+extra.length+2,html:`<tbody><tr>${lines.map((l,i)=>`<td${i>=6?' class="numeric"':''}>${e(l.join('\n'))}</td>`).join('')}</tr><tr class="detail"><td colspan="13">${e(extra.join('\n'))}</td></tr></tbody>`};
}
function headerGeometry(data,presentation){
 const issuer=issuerLayout({name:data.issuer.name,address:addressText(data.issuer.address)});
 // Includes the largest page counter (100/100), fixed identity panel, warning,
 // barcode and margins. Actual text lines are rendered from these same layouts.
 const common=22+Math.max(56,issuer.height)
  +fieldLayout(['Natureza da operação',presentation.authorizationLabel],[data.nature,presentation.authorizationValue],'row2').height
  +fieldLayout(['Inscrição estadual','IE do substituto tributário','CNPJ'],[data.issuer.ie,data.issuer.ie_st,documentPt(data.issuer.document)],'row3').height;
 const first=20
  +fieldLayout(['Nome / razão social','CNPJ / CPF','Emissão - São Paulo'],[data.recipient.name,documentPt(data.recipient.document),localDate(data.issued_at)],'row3').height
  +fieldLayout(['Endereço','Inscrição estadual'],[addressText(data.recipient.address),data.recipient.ie],'row2').height
  +(data.departure_at?fieldLayout(['Saída / entrada - São Paulo'],[localDate(data.departure_at)],'row1').height:0)
  +fieldLayout(['Base ICMS','Valor ICMS','Base ICMS ST','Valor ICMS ST','Total dos produtos'],['vBC','vICMS','vBCST','vST','vProd'].map(k=>m(data.totals[k])),'row5').height
  +fieldLayout(['Frete','Seguro','Desconto','Outras despesas','IPI','Total da nota'],['vFrete','vSeg','vDesc','vOutro','vIPI','vNF'].map(k=>m(data.totals[k])),'row6').height
  +fieldLayout(['Modalidade de frete','Dados de transporte'],[freight[data.transport_mode],'Sem dados de transportador ou volumes neste XML'],'row2').height
  +fieldLayout(['Forma / valor','Troco'],[data.payments.map(p=>`${PAY[p.type]}: R$ ${m(p.amount)}`).join(' · '),data.change===null?'Não informado':m(data.change)],'row2').height;
 return {common,first};
}
function pages55(data,presentation){
 const geometry=headerGeometry(data,presentation),continuation=Math.floor((287-geometry.common-22)/2.7),initial=Math.floor((287-geometry.common-geometry.first-22)/2.7);
 const pages=[{rows:[],notes:null}],rows=data.items.map(printRow);let used=0,budget=initial;
 need(initial>=rows[0].height&&continuation>=1,'PRINT_HEADER_TOO_LARGE');
 for(const row of rows){need(row.height<=continuation,'PRINT_ROW_TOO_TALL');if(used+row.height>budget){pages.push({rows:[],notes:null});used=0;budget=continuation;}pages.at(-1).rows.push(row);used+=row.height;}
 const info=[data.fiscal_information&&'INFORMAÇÕES FISCAIS\n'+data.fiscal_information,data.additional&&'INFORMAÇÕES COMPLEMENTARES\n'+data.additional].filter(Boolean).join('\n\n');
 if(info){const lines=wrap(info,120),noteBudget=budget;
  // Keep a short complementary block with the last items when the conservative
  // line budget allows it. The full text moves to continuation pages otherwise.
  if(used+Math.ceil(lines.length*3/2.7)+4<=noteBudget)pages.at(-1).notes=lines.join('\n');
  else {const noteLines=Math.floor((287-geometry.common-22)/3);need(noteLines>0,'PRINT_HEADER_TOO_LARGE');for(let i=0;i<lines.length;i+=noteLines)pages.push({rows:[],notes:lines.slice(i,i+noteLines).join('\n')});}
 }
 need(pages.length<=PRINT_LIMITS.pages,'PRINT_PAGE_LIMIT');return pages;
}
function header55(data,index,count,presentation){const issuer=issuerLayout({name:data.issuer.name,address:addressText(data.issuer.address)});return banner(presentation)+`<div class="headline"><div class="issuer"><h2>${e(issuer.name.join('\n'))}</h2><p>${e(issuer.address.join('\n'))}</p></div><div class="identity"><h1>DANFE</h1><p>Documento Auxiliar da Nota Fiscal Eletrônica</p><strong>${data.operation==='1'?'1 - SAÍDA':'0 - ENTRADA'}</strong><strong>Nº ${e(data.number)}</strong><strong>Série ${e(data.series)}</strong><strong>Folha ${index+1}/${count}</strong></div><div class="barcode">${code128C(data.key).svg}<span class="caption">Chave de acesso</span><p class="key">${e(keyPt(data.key))}</p><p class="small-content">${e(presentation.barcodeNote)}</p></div></div>`
 +cells(['Natureza da operação',presentation.authorizationLabel],[data.nature,presentation.authorizationValue],'row2')
 +cells(['Inscrição estadual','IE do substituto tributário','CNPJ'],[data.issuer.ie,data.issuer.ie_st,documentPt(data.issuer.document)],'row3');}
function first55(data){return '<h2>Destinatário / remetente</h2>'+cells(['Nome / razão social','CNPJ / CPF','Emissão - São Paulo'],[data.recipient.name,documentPt(data.recipient.document),localDate(data.issued_at)],'row3')
 +cells(['Endereço','Inscrição estadual'],[addressText(data.recipient.address),data.recipient.ie],'row2')
 +(data.departure_at?cells(['Saída / entrada - São Paulo'],[localDate(data.departure_at)],'row1'):'')
 +'<h2>Cálculo do imposto</h2>'+cells(['Base ICMS','Valor ICMS','Base ICMS ST','Valor ICMS ST','Total dos produtos'],['vBC','vICMS','vBCST','vST','vProd'].map(k=>m(data.totals[k])))
 +cells(['Frete','Seguro','Desconto','Outras despesas','IPI','Total da nota'],['vFrete','vSeg','vDesc','vOutro','vIPI','vNF'].map(k=>m(data.totals[k])),'row6')
 +'<h2>Transportador / volumes transportados</h2>'+cells(['Modalidade de frete','Dados de transporte'],[freight[data.transport_mode],'Sem dados de transportador ou volumes neste XML'],'row2')
 +'<h2>Pagamento informado no XML</h2>'+cells(['Forma / valor','Troco'],[data.payments.map(p=>`${PAY[p.type]}: R$ ${m(p.amount)}`).join(' · '),data.change===null?'Não informado':m(data.change)],'row2');}
function danfe55(data,presentation){const pages=pages55(data,presentation);return {page_count:pages.length,body:pages.map((p,i)=>`<section class="page">${header55(data,i,pages.length,presentation)}${i===0?first55(data):''}${p.rows.length?`<h2>Dados dos produtos / serviços</h2><table class="items"><colgroup>${widths.map(w=>`<col style="width:${w}mm">`).join('')}</colgroup><thead><tr>${headings.map(h=>`<th>${e(h)}</th>`).join('')}</tr></thead>${p.rows.map(r=>r.html).join('')}</table>`:''}${p.notes?'<h2>Dados adicionais</h2><div class="notes">'+e(p.notes)+'</div>':''}<div class="footer"><span>${e(presentation.footer55)}</span><span>Folha ${i+1}/${pages.length}</span></div></section>`).join('')};}
function danfe65(data,presentation){
 const line=(label,value,cls='')=>`<div class="line ${cls}"><span>${e(label)}</span><span>${e(value)}</span></div>`;
 const adjustments=BigInt(data.totals.vFrete.replace('.',''))+BigInt(data.totals.vSeg.replace('.',''))+BigInt(data.totals.vOutro.replace('.',''));
 const adjustmentString=String(adjustments).padStart(3,'0').replace(/(..)$/,'.$1');
 const body=`<article class="receipt">${banner(presentation)}<header class="issuer center"><h1>${e(data.issuer.name)}</h1><p>CNPJ ${e(documentPt(data.issuer.document))}</p><p>${e(addressText(data.issuer.address))}</p><p>Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</p></header><table><colgroup><col style="width:35%"><col style="width:35%"><col style="width:30%"></colgroup><thead><tr><th colspan="3">Código / descrição</th></tr><tr><th>Qtde. / unidade</th><th class="numeric">Valor unitário</th><th class="numeric">Valor total</th></tr></thead>${data.items.map(item=>`<tbody><tr><td colspan="3" class="product">${e(item.code+' - '+item.description)}</td></tr><tr><td>${e(d(item.quantity)+' '+item.unit)}</td><td class="numeric">${e(d(item.unit_price))}</td><td class="numeric">${e(m(item.product_amount))}</td></tr>${item.additional?'<tr><td colspan="3">'+e(item.additional)+'</td></tr>':''}</tbody>`).join('')}</table>`
 +line('Qtde. total de itens',String(data.items.length))+line('Valor total R$',m(data.totals.vProd))
 +(adjustments!==0n?line('Acréscimos R$',m(adjustmentString)):'')+(data.totals.vDesc!=='0.00'?line('Desconto R$',m(data.totals.vDesc)):'')+line('Valor a pagar R$',m(data.totals.vNF),'total')
 +'<h2>Forma de pagamento / valor pago R$</h2>'+data.payments.map(p=>line(PAY[p.type],m(p.amount))).join('')+line('Troco R$',data.change===null?'Não informado':m(data.change))
 +`<section class="center"><p>Consulta pela chave de acesso - homologação</p><p class="url">${e(data.consultation)}</p><p class="key">${e(keyPt(data.key))}</p><div class="consumer"><strong>CONSUMIDOR ${data.recipient.document.length===14?'CNPJ':'CPF'}: ${e(documentPt(data.recipient.document))}</strong><p>${e(data.recipient.name)}</p><p>${e(addressText(data.recipient.address))}</p></div><div class="qr">${qrCode(data.qr).svg}</div><p><strong>NFC-e nº ${e(data.number)} · Série ${e(data.series)}</strong></p><p>${e(localDate(data.issued_at))} - São Paulo</p><p><strong>${e(presentation.receiptProtocol)}</strong></p><p>EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL</p></section>`
 +(data.fiscal_information?`<div class="notes">${e(data.fiscal_information)}</div>`:'')+(data.additional?`<div class="notes">${e(data.additional)}</div>`:'')+`</article><div class="receipt-print-footer">${e(presentation.footer65)}<br>${e(presentation.footer65Note)}</div>`;
 return {body,page_count:null};
}
/** Internal layout only; callers own trust checks. Presentation consists of escaped text,
 * never raw HTML. No authorization claims or public DTO are produced here. */
export function renderDocumentLayout(value,presentation){
 const data=assertPreview(value),render=data.model==='55'?danfe55(data,presentation):danfe65(data,presentation);
 const css=CSS+(data.model==='65'?'\n@page{size:80mm 297mm;margin:2mm 2mm 8mm}':'');
 const html=`<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${e(presentation.title)} - modelo ${data.model} - sem valor fiscal</title><style>${css}</style></head><body>${render.body}</body></html>`;
 need(Buffer.byteLength(html)<=4*1024*1024,'PRINT_OUTPUT_LIMIT');return Object.freeze({html,sha256:createHash('sha256').update(html).digest('hex'),page_count:render.page_count});
}
