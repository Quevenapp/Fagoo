/** Reviewed subset only. This is neither a SEFAZ rules catalogue nor permission to send. */
import {createHash} from 'node:crypto';
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const SP_CRT1_RULE_MANIFEST=freeze({
 profile:'sp-crt1-internal-sale-homologation-20261016-v1',
 reviewedOn:'2026-10-16',
 scope:{uf:'SP',environment:'2',crt:'1',models:['55','65'],tpNF:'1',idDest:'1',finNFe:'1',tpEmis:'1',indPres:'1',cfop:['5102','5405'],payment:['01','15']},
 timePolicy:{validFrom:'2026-10-16T00:00:00-03:00',reviewBefore:'2026-10-26T00:00:00-03:00',kind:'fagoo_conservative_review_boundary',officialTaxDeadline:false},
 sources:[
  {id:'moc7',url:'https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-anexo-i-leiaute-e-rv.pdf',sha256:'5eb4cf2010b10b0b62f78197c4eb64025f24535d4c6e61158bc7806dd008f55d',pages:[62,107,108,112,128]},
  {id:'cfop2023',url:'https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=JSxhEY85vRU=',sha256:'18b8ce0d3f5fdf46b32bce5588f9f7bef88e123b07ac3bb1adf855339971f7f8',pages:[6,7]},
  {id:'gtin2021',url:'https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=ENot2yWE72Q=',sha256:'28b7e26b1a515cdd8180084a71c6b8bf4eb6fa7745ecafba878fbeb75547b363',pages:[3,4,11,12,13,46]},
  {id:'simplification2025',url:'https://www.nfe.fazenda.gov.br/Portal/exibirArquivo.aspx?conteudo=NvuzQGYd6E8%3D',sha256:'333b69f71debe5040585b677b574bb13b39362aa7934b904edc59cdf83cded02',pages:[5,9,10,11,14]},
  {id:'rtc2025',url:'https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=HXPO8VLbh4o=',sha256:'54ed893327040a20a4a3c0562d342953542a1dc98e55d73dbe607d6c13d3d416',pages:[6,7,40],note:'Struck production dates are not active rules. New version deltas are distinct from inherited rules.'},
  {id:'sp-nfe-optional',url:'https://portal.fazenda.sp.gov.br/servicos/nfe/Paginas/Regras-de-validacao.aspx',sha256:null,capture:'official_web_text_review',observed:{'N12a-50':'active','N12a-60':'inactive','ZD01-10':'inactive','ZD02-10':'inactive','ZD07-10':'inactive'},note:'Published table has no environment or effective timestamp. No service behavior was tested.'},
  {id:'sp-nfce-optional',url:'https://portal.fazenda.sp.gov.br/servicos/nfce/Paginas/Regras-de-validacao.aspx',sha256:'31b2865edeca833c5186be66b9ca8d36836c02849027be12a8a370d6c5f0bbd0',capture:'official_html_snapshot',observed:{'N12a-50':'inactive','N12a-60':'inactive','YA03-10':'active','YA03-20':'active','ZD01-10':'inactive','ZD02-10':'inactive','ZD07-10':'inactive'},note:'Published table has no environment or effective timestamp. No service behavior was tested.'},
  {id:'sre70',url:'https://legislacao.fazenda.sp.gov.br/Paginas/Portaria-SRE-70-de-2025.aspx',sha256:'2bd26fd65a442d909ba7364e45a38266aabc0048f3c69b4abf15b58212db243c',sections:['articles1-2']},
  {id:'sp-cbenef',url:'https://portal.fazenda.sp.gov.br/servicos/nfe/Paginas/cBenef.aspx',sha256:'679a2da605350a499bb815921bdfb4d9b3b8129eedbc2f19f0e7582f1f56b991',note:'SEM CBENEF deactivated on 2026-07-01.'},
  {id:'lc123',url:'https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp123.htm',sha256:'d3ca8ce91d812d272f7d1ec0aa9440b74be2fb9a9acfdaeda4e6c59fdd7f4bb2',sections:['article23 paragraphs1-4']},
  {id:'sp-credit',url:'https://legislacao.fazenda.sp.gov.br/Paginas/RC20252_2019.aspx',sha256:null,capture:'official_web_text_review',sections:['paragraphs4-9','quoted CGSN140 article60'],note:'Individual administrative response quoting the general credit and disclosure provisions; not a full current CGSN compilation.'},
  {id:'rfb-pis-cofins',url:'https://sped.rfb.gov.br/estatico/A6/44AEB1BBD8AB6403004C3DA1F7F8B1C27E8DE8/Perguntas%20e%20Respostas%20EFD%20Contribui%C3%A7%C3%B5es.pdf',sha256:null,capture:'official_indexed_text_review',note:'Normal unified Simples sales CST49; monophase/ST/export differ. Full PDF fetch unavailable. Question expressly concerns NF-e55; no automatic zero amounts or model65 legal certification.'}
 ],
 exclusions:['No complete tax classification engine','No NCM/CEST or GS1-prefix table snapshot in this module','No CCG lookup','No blanket RTC exemption','No real service validation or authorization','No certificate chain/revocation validation','No source arithmetic/XSD replacement'],
 operationalEnabled:false
});
export const SP_CRT1_RULE_MANIFEST_HASH=createHash('sha256').update(JSON.stringify(SP_CRT1_RULE_MANIFEST)).digest('hex');
