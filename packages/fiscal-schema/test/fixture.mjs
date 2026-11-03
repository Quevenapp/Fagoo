// A synthetic structural example only. CRT and taxes are NOT company defaults.
import { credentials, HOLDER, NOW } from '../../fiscal-xml/test/fixtures.mjs';
import { addNfceOnlineSupplement, createSigner, signNfeXml, disposeSigner, NFCE_SP_HOMOLOGATION_QR_V3 } from '../../fiscal-xml/src/index.mjs';
import { buildAccessKey } from '../../fiscal-core/src/identity.mjs';

export function fullUnsignedXml(model = '55') {
  const key = buildAccessKey({cUF:'35',cnpj:HOLDER,model,environment:'2',series:'1',number:'1',issuedAt:'2026-10-16T09:00:00-03:00',cNF:'12345678',tpEmis:'1'});
  return `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${key}" versao="4.00">
<ide><cUF>35</cUF><cNF>12345678</cNF><natOp>VENDA FICTICIA DE TESTE</natOp><mod>${model}</mod><serie>1</serie><nNF>1</nNF><dhEmi>2026-10-16T09:00:00-03:00</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>3538709</cMunFG><tpImp>${model === '65' ? '4' : '1'}</tpImp><tpEmis>1</tpEmis><cDV>${key.at(-1)}</cDV><tpAmb>2</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>BRUFAP-TESTE</verProc></ide>
<emit><CNPJ>${HOLDER}</CNPJ><xNome>EMPRESA FICTICIA SEM VALOR FISCAL</xNome><enderEmit><xLgr>RUA FICTICIA</xLgr><nro>1</nro><xBairro>BAIRRO FICTICIO</xBairro><cMun>3538709</cMun><xMun>PIRACICABA</xMun><UF>SP</UF><CEP>13400000</CEP></enderEmit><IE>123456789012</IE><CRT>1</CRT></emit>
<dest><CPF>52998224725</CPF><xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome><indIEDest>9</indIEDest></dest>
<det nItem="1"><prod><cProd>TESTE-001</cProd><cEAN>SEM GTIN</cEAN><xProd>PRODUTO FICTICIO SEM VALOR FISCAL</xProd><NCM>82032090</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>10.0000000000</vUnCom><vProd>10.00</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>1.0000</qTrib><vUnTrib>10.0000000000</vUnTrib><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto></det>
<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>10.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>10.00</vNF></ICMSTot></total>
<transp><modFrete>9</modFrete></transp><pag><detPag><tPag>01</tPag><vPag>10.00</vPag></detPag></pag><infAdic><infCpl>DOCUMENTO SINTETICO SEM VALOR FISCAL</infCpl></infAdic></infNFe></NFe>`;
}

const credential = await credentials();
const signer = createSigner({...credential,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});
try {
  const result = {};
  for (const model of ['55','65']) {
    const signed = signNfeXml({xml:fullUnsignedXml(model),signer,expectedIssuerCnpj:HOLDER,now:NOW});
    result[model] = {xml:signed.signedXml,signatureVerified:signed.verification.signatureVerified};
    if (model === '65') {
      const complete = addNfceOnlineSupplement({xml:signed.signedXml,profile:NFCE_SP_HOMOLOGATION_QR_V3,
        expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedIssuerCnpj:HOLDER,now:NOW});
      result.nfceQrV3 = {xml:complete.signedXml,signatureVerified:complete.verification.signatureVerified};
    }
  }
  process.stdout.write(JSON.stringify(result));
} finally { disposeSigner(signer); }
