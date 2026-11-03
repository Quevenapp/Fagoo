import {createHash} from 'node:crypto';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
import {credentials,HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner} from '../../fiscal-xml/src/index.mjs';
import {createSignedHomologationCandidate} from '../../fiscal-xml/src/signed-candidate.mjs';
export const digest=value=>createHash('sha256').update(value).digest('hex');
let credential;
export async function candidateFixture(options={}){
 credential??=await credentials();const f=businessFixture(options);
 f.completion.additional_information='DOCUMENTO INTEIRAMENTE FICTÍCIO. PRÉVIA SEM VALOR FISCAL. A & B <script>não executar</script> "aspas".';
 const built=buildBusinessXml(f),xml=options.transformUnsigned?options.transformUnsigned(built.unsignedXml):built.unsignedXml,signer=createSigner({...credential,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});let signed;
 try{signed=createSignedHomologationCandidate({xml,signer,expectedIssuerCnpj:HOLDER,expectedModel:options.model||'55',expectedUnsignedHash:digest(xml),expectedCertificateFingerprint:digest(credential.certificateDer),now:NOW});}finally{disposeSigner(signer);}
 const bytes=new TextEncoder().encode(signed.signedXml);
 return {bytes,context:{candidate_id:'a1000000-0000-4000-8000-000000000001',sha256:digest(bytes),size_bytes:bytes.length,model:options.model||'55',environment:'2'},signed,credential};
}
export function changed(f,replace){const bytes=new TextEncoder().encode(replace(new TextDecoder().decode(f.bytes)));return {bytes,context:{...f.context,sha256:digest(bytes),size_bytes:bytes.length}};}
export function maximalHeader(xml){
 for(const[tag,length]of [['xNome',120],['xLgr',120],['nro',60],['xBairro',120],['xMun',120]])xml=xml.replaceAll(new RegExp(`<${tag}>[^<]*</${tag}>`,'g'),`<${tag}>${'W'.repeat(length)}</${tag}>`);
 xml=xml.replaceAll('</nro>',`</nro><xCpl>${'W'.repeat(120)}</xCpl>`);
 return xml.replace(/<pag>.*?<\/pag>/s,'<pag>'+Array.from({length:25},()=>'<detPag><indPag>0</indPag><tPag>01</tPag><vPag>9999999999999.99</vPag></detPag>').join('')+'</pag>');
}
export function boundedLongHeader(xml){
 xml=xml.replaceAll(/<xNome>[^<]*<\/xNome>/g,`<xNome>${'W'.repeat(120)}</xNome>`);
 return xml.replace(/<pag>.*?<\/pag>/s,'<pag>'+Array.from({length:5},()=>'<detPag><indPag>0</indPag><tPag>01</tPag><vPag>2.50</vPag></detPag>').join('')+'</pag>');
}
