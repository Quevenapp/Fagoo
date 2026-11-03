import { buildAccessKey } from '../../../packages/fiscal-core/src/identity.mjs';
import { gzipSync } from 'node:zlib';
export const NS='http://www.portalfiscal.inf.br/nfe';
export const identity=model=>({cUF:'35',cnpj:'11222333000181',model,environment:'1',series:'1',number:'1',issuedAt:'2026-10-16T08:00:00-03:00',cNF:'12345678',tpEmis:model==='65'?'9':'1'});
export const keyFor=model=>buildAccessKey(identity(model));
export function invoice(model='55',extra=''){
 const key=keyFor(model),x=identity(model);return`<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NS}"><NFe><infNFe Id="NFe${key}" versao="4.00"><ide><cUF>35</cUF><mod>${model}</mod><tpAmb>1</tpAmb><serie>1</serie><nNF>1</nNF><dhEmi>${x.issuedAt}</dhEmi><tpEmis>${x.tpEmis}</tpEmis><cNF>12345678</cNF><cDV>${key[43]}</cDV></ide><emit><CNPJ>${x.cnpj}</CNPJ></emit><infAdic><infCpl>SYNTHETIC ARCHIVE FIXTURE${extra}</infCpl></infAdic></infNFe>${model==='65'?'<infNFeSupl><qrCode><![CDATA[https://synthetic.invalid/?p=test&v=3]]></qrCode><urlChave>https://synthetic.invalid/</urlChave></infNFeSupl>':''}<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/></NFe><protNFe><infProt><tpAmb>1</tpAmb><chNFe>${key}</chNFe><nProt>135260000000001</nProt></infProt></protNFe></nfeProc>`;
}
export function event(model='55'){
 const key=keyFor(model);return`<procEventoNFe xmlns="${NS}"><evento><infEvento Id="ID110111${key}01"><tpAmb>1</tpAmb><chNFe>${key}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento></infEvento><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/></evento><retEvento><infEvento><tpAmb>1</tpAmb><chNFe>${key}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><nProt>135260000000002</nProt></infEvento></retEvento></procEventoNFe>`;
}
export const encoded=xml=>({nome:'synthetic.xml',conteudo:gzipSync(Buffer.from(xml)).toString('base64')});
