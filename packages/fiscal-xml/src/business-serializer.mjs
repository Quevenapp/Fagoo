// Internal serializer shared by the two validated entry points; not a public trust boundary.
import { TOTAL_FIELDS } from '../../fiscal-core/src/business-document.mjs';
import { sha256, need, NS } from './common.mjs';
import { parseStrict } from './xml.mjs';

// Element names and attributes below are code constants. Untrusted text is never XML markup.
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const tag = (name,value) => `<${name}>${escape(value)}</${name}>`;
const optional = (name,value) => value===null?'':tag(name,value);
function address(value,name) {
  return `<${name}>`+tag('xLgr',value.street)+tag('nro',value.number)+optional('xCpl',value.complement)+tag('xBairro',value.district)
    +tag('cMun',value.municipality_code)+tag('xMun',value.city)+tag('UF',value.state)+tag('CEP',value.postal_code)+`</${name}>`;
}
function taxes(item) {
  const c=item.icms,name='ICMSSN'+c.csosn;
  let icms=tag('orig',item.origin)+tag('CSOSN',c.csosn);
  if(c.csosn==='101')icms+=tag('pCredSN',c.credit_rate)+tag('vCredICMSSN',c.credit_amount);
  if(c.csosn==='500') {
    if(c.retention)icms+=tag('vBCSTRet',c.retention.base)+tag('pST',c.retention.rate)+optional('vICMSSubstituto',c.retention.substitute_icms)+tag('vICMSSTRet',c.retention.retained_icms);
    if(c.fcp)icms+=tag('vBCFCPSTRet',c.fcp.base)+tag('pFCPSTRet',c.fcp.rate)+tag('vFCPSTRet',c.fcp.amount);
    if(c.effective)icms+=tag('pRedBCEfet',c.effective.reduction_rate)+tag('vBCEfet',c.effective.base)+tag('pICMSEfet',c.effective.rate)+tag('vICMSEfet',c.effective.amount);
  }
  const other=(name,value)=>`<${name}><${name}Outr>`+tag('CST',value.cst)+tag('vBC',value.base)+tag('p'+name,value.rate)+tag('v'+name,value.amount)+`</${name}Outr></${name}>`;
  return `<imposto><ICMS><${name}>${icms}</${name}></ICMS>`+other('PIS',item.pis)+other('COFINS',item.cofins)+'</imposto>';
}
function product(item) {
  return `<det nItem="${item.position}"><prod>`+tag('cProd',item.code)+tag('cEAN',item.gtin)+tag('xProd',item.description)+tag('NCM',item.ncm)+optional('CEST',item.cest)
    +tag('CFOP',item.cfop)+tag('uCom',item.unit)+tag('qCom',item.quantity)+tag('vUnCom',item.unit_price)+tag('vProd',item.product_amount)
    +tag('cEANTrib',item.gtin_tax)+tag('uTrib',item.tributary.unit)+tag('qTrib',item.tributary.quantity)+tag('vUnTrib',item.tributary.unit_price)
    +(item.freight==='0.00'?'':tag('vFrete',item.freight))+(item.discount==='0.00'?'':tag('vDesc',item.discount))+(item.other==='0.00'?'':tag('vOutro',item.other))
    +tag('indTot','1')+'</prod>'+taxes(item)+'</det>';
}
export function serializeBusinessDocument(r) {
  const i=r.identity,o=r.operation,e=r.issuer,d=r.recipient;
  const ide=tag('cUF','35')+tag('cNF',i.cNF)+tag('natOp',o.nature)+tag('mod',i.model)+tag('serie',i.series)+tag('nNF',i.number)
    +tag('dhEmi',i.issuedAt)+tag('tpNF',o.tpNF)+tag('idDest',o.idDest)+tag('cMunFG',e.address.municipality_code)+tag('tpImp',i.model==='65'?'4':'1')
    +tag('tpEmis','1')+tag('cDV',r.access_key.at(-1))+tag('tpAmb','2')+tag('finNFe',o.finNFe)+tag('indFinal',o.indFinal)+tag('indPres',o.indPres)
    +tag('procEmi','0')+tag('verProc','BRUFAP-BUILDER-1');
  const emitter=tag('CNPJ',e.cnpj)+tag('xNome',e.name)+optional('xFant',e.trade_name)+address(e.address,'enderEmit')+tag('IE',e.ie)+tag('CRT','1');
  const dest=tag(d.document_type,d.document)+tag('xNome',d.name)+address(d.address,'enderDest')+tag('indIEDest',d.indIEDest)+optional('IE',d.ie);
  const payment=r.payments.items.map(p=>'<detPag>'+tag('indPag',p.timing)+tag('tPag',p.type)+tag('vPag',p.amount)+'</detPag>').join('')
    +(r.payments.change==='0.00'?'':tag('vTroco',r.payments.change));
  const unsignedXml=`<NFe xmlns="${NS}"><infNFe Id="NFe${r.access_key}" versao="4.00"><ide>${ide}</ide><emit>${emitter}</emit><dest>${dest}</dest>`
    +r.items.map(product).join('')+'<total><ICMSTot>'+TOTAL_FIELDS.map(k=>tag(k,r.totals[k])).join('')+'</ICMSTot></total>'
    +'<transp>'+tag('modFrete',r.transport_mode)+'</transp><pag>'+payment+'</pag>'
    +(r.additional_information===null?'':'<infAdic>'+tag('infCpl',r.additional_information)+'</infAdic>')+'</infNFe></NFe>';
  // Leave a conservative byte margin for a later signature. Its own full bounds still apply.
  need(Buffer.byteLength(unsignedXml,'utf8')<=480000,'BUSINESS_XML_SIZE_LIMIT');
  parseStrict(unsignedXml);
  return {profile:r.profile,schema_profile:r.schema_profile,binding:r.binding,identity:r.identity,access_key:r.access_key,unsignedXml,
    unsigned_xml_sha256:sha256(unsignedXml),xml_generated:true,operational_effects:false,numbering_reserved:false,tax_rules_validated:false,
    xsd_validated:false,signature_verified:false,authorized:false,can_emit:false,can_transmit:false,pending:[...r.pending],transformations:r.transformations,
    arithmetic_profile:r.arithmetic_profile};
}
