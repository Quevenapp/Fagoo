// Synthetic NF-e 4.00 (nfeProc) builder for the "Importar XML NF-e" tests. Every party, product and key is fictitious;
// the key carries a valid check digit and the totals add up like an authorized XML. No real data.
// Wave F of the notas fiscais lane: the NFe is signed by default with the synthetic certificate of the emitter (fiscal-xml-signer.mjs),
// because the import now checks the signature; signature: 'fake' keeps the old placeholder and 'none' leaves the NFe unsigned.
import { signNfe } from './fiscal-xml-signer.mjs';
export const COMPANY = '11222333000181', SUPPLIER = '12345678000195';
export function accessKey({ cnpj = SUPPLIER, series = 1, number = 321, model = '55', code = '12345678' } = {}) {
  const base = `3526${'10'}${cnpj}${model}${String(series).padStart(3, '0')}${String(number).padStart(9, '0')}1${code}`;
  let sum = 0, weight = 2; for (let i = base.length - 1; i >= 0; i--) { sum += Number(base[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const dv = 11 - (sum % 11); return base + String(dv >= 10 ? 0 : dv);
}
const cents = v => Math.round(Number(v) * 100); // test data only: small exact values
const money = c => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** Builds an XML. items: [{ code, name, quantity, price, ean, ipi, icms }] with string amounts. */
export function nfeXml({ emit = SUPPLIER, dest = COMPANY, destCpf = null, tpNF = '1', tpAmb = '1', cStat = '100', series = 1, number = 321, model = '55', crt = '3', items = [{ code: 'FORN-1', name: 'Parafuso sintético', quantity: '10.0000', price: '2.5000', ean: '7891234567895', ipi: '2.50' }],
  freight = '0.00', discount = '0.00', dup = true, withProtocol = true, version = '4.00', extraTotal = 0, transport = true, dest_block = true, signature: signatureMode = 'valid', signer, pay = null, change = null, indFinal = model === '65' ? '1' : '0', indPres = model === '65' ? '1' : '9' } = {}) {
  const key = accessKey({ cnpj: emit, series, number, model });
  let vProd = 0, vIPI = 0, vICMS = 0, vBC = 0;
  const dets = items.map((item, i) => {
    const total = Math.round(Number(item.quantity) * Number(item.price) * 100); vProd += total;
    const ipi = item.ipi ? cents(item.ipi) : 0; vIPI += ipi;
    const icms = Math.round(total * 0.18); vICMS += icms; vBC += total;
    const share = i === items.length - 1 ? cents(freight) - items.slice(0, -1).reduce((s, x) => s + Math.floor(cents(freight) * Math.round(Number(x.quantity) * Number(x.price) * 100) / items.reduce((t, y) => t + Math.round(Number(y.quantity) * Number(y.price) * 100), 0)), 0)
      : Math.floor(cents(freight) * total / items.reduce((t, y) => t + Math.round(Number(y.quantity) * Number(y.price) * 100), 0));
    return `<det nItem="${i + 1}"><prod><cProd>${esc(item.code)}</cProd><cEAN>${item.ean ?? 'SEM GTIN'}</cEAN><xProd>${esc(item.name)}</xProd><NCM>73181500</NCM><CFOP>${tpNF === '1' ? '5102' : '1102'}</CFOP>`
      + `<uCom>UN</uCom><qCom>${item.quantity}</qCom><vUnCom>${item.price}</vUnCom><vProd>${money(total)}</vProd><cEANTrib>${item.ean ?? 'SEM GTIN'}</cEANTrib><uTrib>UN</uTrib><qTrib>${item.quantity}</qTrib><vUnTrib>${item.price}</vUnTrib>`
      + (cents(freight) ? `<vFrete>${money(share)}</vFrete>` : '') + (cents(discount) && i === items.length - 1 ? `<vDesc>${discount}</vDesc>` : '') + `<indTot>1</indTot><xPed>OC-9</xPed></prod>`
      + `<imposto><vTotTrib>0.00</vTotTrib><ICMS>${crt === '3' ? `<ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>${money(total)}</vBC><pICMS>18.00</pICMS><vICMS>${money(icms)}</vICMS></ICMS00>` : '<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>'}</ICMS>`
      + (item.ipi ? `<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>${money(total)}</vBC><pIPI>${(ipi * 100 / total).toFixed(2)}</pIPI><vIPI>${item.ipi}</vIPI></IPITrib></IPI>` : '')
      + `<PIS><PISAliq><CST>01</CST><vBC>${money(total)}</vBC><pPIS>1.65</pPIS><vPIS>${money(Math.round(total * 0.0165))}</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>01</CST><vBC>${money(total)}</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>${money(Math.round(total * 0.076))}</vCOFINS></COFINSAliq></COFINS></imposto>`
      + `<infAdProd>Lote sintético ${i + 1}</infAdProd></det>`;
  }).join('');
  const vNF = vProd - cents(discount) + cents(freight) + vIPI + extraTotal;
  const destXml = dest_block ? `<dest>${destCpf ? `<CPF>${destCpf}</CPF>` : `<CNPJ>${dest}</CNPJ>`}<xNome>Comprador sintético Ltda</xNome><enderDest><xLgr>Rua Sintética</xLgr><nro>100</nro><xBairro>Centro</xBairro><cMun>3538709</cMun><xMun>Piracicaba</xMun><UF>SP</UF><CEP>13400000</CEP><cPais>1058</cPais><xPais>Brasil</xPais><fone>1933334444</fone></enderDest><indIEDest>1</indIEDest><IE>535123456789</IE><email>compras@sintetico.invalid</email></dest>` : '';
  const inf = `<infNFe versao="${version}" Id="NFe${key}"><ide><cUF>35</cUF><cNF>12345678</cNF><natOp>Venda de mercadoria sintética</natOp><mod>${model}</mod><serie>${series}</serie><nNF>${number}</nNF>`
    + `<dhEmi>2026-10-18T09:30:00-03:00</dhEmi><dhSaiEnt>2026-10-18T10:00:00-03:00</dhSaiEnt><tpNF>${tpNF}</tpNF><idDest>1</idDest><cMunFG>3550308</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${key.slice(-1)}</cDV><tpAmb>${tpAmb}</tpAmb><finNFe>1</finNFe><indFinal>${indFinal}</indFinal><indPres>${indPres}</indPres><procEmi>0</procEmi><verProc>sintetico</verProc></ide>`
    + `<emit><CNPJ>${emit}</CNPJ><xNome>Fornecedor sintético S.A.</xNome><xFant>Fornecedor</xFant><enderEmit><xLgr>Av. Sintética</xLgr><nro>2000</nro><xBairro>Distrito</xBairro><cMun>3550308</cMun><xMun>São Paulo</xMun><UF>SP</UF><CEP>01000000</CEP><cPais>1058</cPais><xPais>Brasil</xPais><fone>1130304040</fone></enderEmit><IE>110042490114</IE><CRT>${crt}</CRT></emit>`
    + destXml + dets
    + `<total><ICMSTot><vBC>${money(crt === '3' ? vBC : 0)}</vBC><vICMS>${money(crt === '3' ? vICMS : 0)}</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${money(vProd)}</vProd><vFrete>${freight}</vFrete><vSeg>0.00</vSeg><vDesc>${discount}</vDesc><vII>0.00</vII><vIPI>${money(vIPI)}</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>${money(vNF)}</vNF></ICMSTot></total>`
    + (transport ? `<transp><modFrete>0</modFrete><transporta><CNPJ>98765432000198</CNPJ><xNome>Transportadora sintética</xNome><IE>110042490114</IE><xEnder>Rua do Frete, 1</xEnder><xMun>Campinas</xMun><UF>SP</UF></transporta><vol><qVol>2</qVol><esp>CAIXA</esp><marca>Sintética</marca><pesoL>10.500</pesoL><pesoB>11.250</pesoB></vol></transp>` : '<transp><modFrete>9</modFrete></transp>')
    + (dup ? `<cobr><fat><nFat>321</nFat><vOrig>${money(vNF)}</vOrig><vLiq>${money(vNF)}</vLiq></fat><dup><nDup>001</nDup><dVenc>2026-11-18</dVenc><vDup>${money(vNF)}</vDup></dup></cobr>` : '')
    + `<pag>${(pay ?? [{ tPag: '15', vPag: money(vNF) }]).map(p => `<detPag><tPag>${p.tPag}</tPag><vPag>${p.vPag}</vPag></detPag>`).join('')}${change ? `<vTroco>${change}</vTroco>` : ''}</pag><infAdic><infCpl>Pedido do cliente OC-9. Documento sintético.</infCpl></infAdic></infNFe>`;
  const signature = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>c2ludGV0aWNv</SignatureValue></Signature>';
  const protocol = withProtocol ? `<protNFe versao="4.00"><infProt><tpAmb>${tpAmb}</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><chNFe>${key}</chNFe><dhRecbto>2026-10-18T09:31:05-03:00</dhRecbto><nProt>135260000000777</nProt><digVal>c2ludGV0aWNv</digVal><cStat>${cStat}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>` : '';
  const unsigned = `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe xmlns="http://www.portalfiscal.inf.br/nfe">${inf}${signatureMode === 'fake' ? signature : ''}</NFe>${protocol}</nfeProc>`;
  return { key, total: money(vNF), xml: signatureMode === 'valid' ? signNfe(unsigned, signer === undefined ? {} : { cnpj: signer }).xml : unsigned };
}
