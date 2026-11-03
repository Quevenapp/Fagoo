# Assinatura XML fiscal offline

Fundação Node.js 22.10+ para assinatura e verificação de `infNFe` dos modelos 55 e 65, versão 4.00, **somente `tpAmb=2`**. Não gera a nota nem calcula tributos. Não há rede, transmissão, mTLS, Container, acesso a certificados da empresa ou homologação SEFAZ.

## O que foi implementado

- RSA-SHA1/SHA1, C14N inclusiva 1.0 e transformação enveloped no perfil do MOC. A chave RSA tem 2048–4096 bits por política local; não é usado um algoritmo caseiro de assinatura.
- Um único elemento raiz `NFe`, um `infNFe` direto e um único `Id` coerente com a chave calculada a partir da identidade. Namespace, modelo, ambiente, CNPJ, data, série, número e DV precisam coincidir. `ID`, `id`, `xml:id`, notas aninhadas e referências externas não são aceitos.
- Uma assinatura no local previsto, uma referência ao `infNFe`, algoritmos/transforms exatos e apenas certificado final em `KeyInfo`. A verificação recebe **certificado esperado externo**; o certificado candidato deve ser idêntico e nunca escolhe a chave de confiança.
- O conteúdo devolvido como autenticado vem de `xml-crypto.getSignedReferences()` após a verificação. Não se usa um nó de negócio extraído do documento candidato como se já estivesse autenticado.
- Validade temporal, chave privada correspondente, RSA, uso de assinatura, condição de certificado final e CNPJ com DV no SAN OtherName são conferidos. O titular esperado é exato; o emitente esperado também é explícito e deve pertencer à mesma base de CNPJ do titular.
- PFX em memória com MAC obrigatório e criptografia restrita, sem senha em CLI, ambiente, arquivos ou mensagens de erro. O retorno contém um handle opaco; a chave fica num `WeakMap`, e `disposeSigner` invalida o uso futuro.
- Suplemento NFC-e com URL QR Code versão 3 para emissão normal online, SP, homologação. O perfil é explícito; chave e ambiente vêm da identidade assinada, e os dois endereços oficiais são constantes. Não consulta nem transmite à SEFAZ e não desenha o DANFE/QR Code.

## Uso

```js
import {
  loadPfxSigner, signNfeXml, verifyNfeXml, disposeSigner,
} from './src/index.mjs';

// Os bytes vêm de um futuro cofre privado. Não imprimir, serializar ou persistir senha.
const signer = await loadPfxSigner({
  pfxBytes, passwordBytes, expectedHolderCnpj,
  purpose: 'offline-homologation',
});
try {
  const { signedXml, verification } = signNfeXml({
    xml, signer, expectedIssuerCnpj,
  });
  // verification.signatureVerified refere-se apenas à assinatura criptográfica.
  // A verificação independente recebe o certificado fixado no cadastro confiável:
  verifyNfeXml({
    xml: signedXml, expectedCertificate, expectedHolderCnpj, expectedIssuerCnpj,
  });
} finally {
  disposeSigner(signer);
  passwordBytes.fill(0);
}
```

`createSigner` também recebe `privateKey` como `KeyObject` nativo ou material PEM em memória e `certificate` público, com o mesmo perfil e propósito. O handle não sobrevive a JSON/clone. A assinatura revalida o certificado a cada uso. `now` é uma dependência de relógio para teste; em operação futura deve vir do backend confiável, nunca do navegador.

## Entradas e limites deliberados

XML até 512.000 bytes UTF-8, 25.000 nós, profundidade 80 e até 40 atributos por elemento. O parser escala todos os avisos/erros para rejeição. DTD, entidades declaradas, XXE, comentários, CDATA, processing instructions adicionais e controles são rejeitados antes de processamento criptográfico. Aceita uma declaração inicial XML 1.0 em UTF-8 no formato documentado pelo teste. Não há resolução de URI, XSLT, XPath de entrada ou busca de arquivos externos.

Por padrão aceita somente `NFe` com `infNFe` e, na verificação, `Signature`. `addNfceOnlineSupplement` recebe uma NFC-e já assinada e verificada, deriva o suplemento e verifica novamente o XML final. `verifyNfeXml` só aceita esse suplemento com `nfceQrProfile: NFCE_SP_HOMOLOGATION_QR_V3`; compara estrutura e valores exatos. O suplemento fica fora de `infNFe`, portanto **não está coberto pela assinatura XML**: o resultado marca `partOfSignature:false`, devolvendo somente valores derivados da identidade autenticada. URLs, parâmetros extras, chave divergente, outro ambiente/UF/modelo ou contingência são recusados.

```js
const complete = addNfceOnlineSupplement({
  xml: signedXml, profile: NFCE_SP_HOMOLOGATION_QR_V3,
  expectedCertificate, expectedHolderCnpj, expectedIssuerCnpj,
});
verifyNfeXml({
  xml: complete.signedXml, nfceQrProfile: NFCE_SP_HOMOLOGATION_QR_V3,
  expectedCertificate, expectedHolderCnpj, expectedIssuerCnpj,
});
```

Rejeita `nfeProc`, SOAP, lotes e eventos. Não há QR versão 2, QR de contingência, impressão DANFE NFC-e nem credenciamento/homologação da empresa. A montagem offline do QR v3 não comprova aceitação pela UF; os bloqueios gerais de emissão permanecem. Restrições de prefixo e formatação são conservadoras; não se pretende ler todo XML fiscal histórico.

PFX: até 128 KiB; senha UTF-8 de 1–1024 bytes; MAC SHA-256; PBES2 com AES-256-CBC/PBKDF2-HMAC-SHA256; 1.000–100.000 iterações; salt de 8–64 bytes. Aceita um certificado final e uma chave cifrada, com conteúdo do certificado aberto ou cifrado. Recusa cadeia embutida com múltiplos certificados, key bag sem criptografia, RC2/3DES, MAC SHA-1, KDFs/algoritmos não previstos e ausência de integridade. **Não afirma compatibilidade com todo A1 existente**; arquivos legados exigirão avaliação específica, nunca fallback automático.

As cópias de senha e buffers temporários controlados pelo pacote são zeradas ao terminar. Node/JavaScript e as bibliotecas podem manter cópias sob coleta de lixo; não existe garantia de apagamento completo de memória. O cofre, isolamento do processo, gestão de acesso e rotação permanecem pendentes. Nenhum segredo é exposto por resultados/erros, e não há logging no código de produção.

## O que sucesso criptográfico não comprova

O resultado sempre marca `xsdValidated`, `taxRulesValidated`, `icpBrasilChainValidated`, `revocationChecked`, `sefazAuthorized` e `canTransmit` como `false`. Os metadados declaram `typeA1Attested:false`: um PFX, por si só, não prova que o certificado pertence à política A1 da ICP-Brasil.

Não foi implementada validação da cadeia contra raízes confiáveis, políticas ICP-Brasil, revogação CRL/OCSP, credenciamento ou titularidade cadastral da empresa. Fixar um certificado é uma decisão de confiança do chamador; aceitar um certificado de teste não o torna fiscalmente apto. O CN/subject não é usado para inventar o CNPJ: o identificador vem apenas do OID SAN específico.

O pacote verifica estrutura de segurança e identidade, **não o XSD fiscal completo**. Suas fixtures são propositalmente mínimas, sem itens/totais/tributos. O pacote irmão [`fiscal-schema`](../fiscal-schema/README.md) já incorpora cinco XSDs oficiais PL 010f v1.04 com hashes fixados e testa documentos sintéticos completos assinados por este módulo. A etapa XSD é separada e offline; não altera os indicadores deste resultado criptográfico nem atesta vigência tributária ou autorização.

## Fontes primárias e versões consultadas em 16/10/2026

1. [MOC 7.0 — CONFAZ, §§4.2.3–4.2.5, pp. 52–55](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-visao-geral.pdf): define o CNPJ no OtherName `2.16.76.1.3.3`, assinatura de `infNFe` por `Id`, certificado final, RSA-SHA1/SHA1 e transformações enveloped/C14N. A implementação de SHA-1 está confinada a esse perfil legado exigido; SHA-256 é usado nos digests internos. Não habilitar outros usos genéricos de SHA-1. A validade legal depende das demais verificações fiscais/ICP.
2. [Portal NF-e — Notas Técnicas](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY%3D) e [avisos oficiais](https://www.nfe.fazenda.gov.br/portal/informe.aspx?ehCTG=false&page=0&pagesize=30): foram identificadas a NT 2025.002 v1.52 e alterações de 2026; aviso de 05/10/2026 adia implantação de três NTs para 26/10 em homologação e 16/11 em produção. Não extrapolamos o MOC de 2020 para um schema tributário completo vigente.
3. [Portal NF-e — Esquemas XML](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w%3D): acesso direto concluído em 16/10/2026. O pacote PL 010f v1.04, publicado em 31/08/2026, foi incorporado sem alterações em `fiscal-schema`, com manifesto e hashes. Sua disponibilidade não comprova vigência das regras tributárias nem aptidão para produção.
4. [XML Signature W3C](https://www.w3.org/TR/xmldsig-core/) e [repositório oficial xml-crypto](https://github.com/node-saml/xml-crypto): usados para regras de referências e consumo exclusivo de dados autenticados. A biblioteca usa `node:crypto` para RSA e contém correções recentes de canonicalização/referências.
5. [xmldom — releases](https://github.com/xmldom/xmldom/releases), [PKIjs — PFX](https://pkijs.org/docs/api/classes/PFX/) e [ASN1js](https://github.com/PeculiarVentures/ASN1.js): parser estrito, PKCS#12 com integridade e ASN.1 com limites. Versões fixadas no lockfile: `xml-crypto@6.4.0`, `@xmldom/xmldom@0.9.12`, `pkijs@3.4.1`, `asn1js@3.0.10`; xml-crypto mantém seu parser transitivo corrigido `0.8.15`.
6. [NT 2025.001 v1.03, páginas 8, 11–14](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=NvuzQGYd6E8%3D): suplemento fora da assinatura, QR v3 online com chave/versão/ambiente, sem CSC nos parâmetros dessa versão; aceitação controlada por UF. PDF consultado em 16/10/2026, SHA-256 `333b69f71debe5040585b677b574bb13b39362aa7934b904edc59cdf83cded02`. Os endereços curtos `/qrcode` e `/consulta` de homologação são os publicados pela [SEFAZ-SP](https://portal.fazenda.sp.gov.br/servicos/nfce/Paginas/WebServices.aspx). Isso não remove requisitos cadastrais da empresa nem autoriza emissão.

`node-forge` foi avaliado e removido devido ao [advisory GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), sem versão corrigida no momento da consulta. Não permanece no pacote. A instalação atual reportou zero vulnerabilidades conhecidas; isso não substitui revisão de segurança.

## Testes e próximo transporte

```sh
npm ci --prefix packages/fiscal-xml --ignore-scripts
npm test --prefix packages/fiscal-xml
```

Os testes geram RSA e certificados autoassinados em memória, exclusivamente fictícios. Cobrem modelos 55/65, adulteração, wrapping, Id alternativo, troca de certificado/chave, transformações e algoritmos indevidos, DTD/entidades, limites de XML, CNPJ/validade/KU, descarte de handle, PFX cifrado, senha incorreta, MAC e custo KDF. Nenhuma chave privada ou PFX de fixture é gravado no repositório.

Antes de mTLS: selecionar runtime Node/Container com cofre privado; carregar cadeia ICP e validar revogação; fixar endpoints SEFAZ por UF/modelo/ambiente; proibir redirects e separar timeouts/resultados ambíguos; versionar schemas SOAP/fiscais e reconciliar antes de reenviar. Esse transporte ainda não existe. Não publicar este módulo em frontend/Worker estático nem aceitar atestações de confiança fornecidas pelo cliente.


## Preparação offline de consulta por chave

`prepareProtocolQuery({ accessKey, expectedModel, environment: '2', requestId })` cria o payload `consSitNFe` 4.00 para a chave existente, sem alterar numeração ou gerar outra nota. Valida DV, CNPJ numérico/alfanumérico, modelo, SP, emissão normal e série até 889. Seleciona somente os endpoints de consulta de homologação publicados pela [NF-e SP](https://portal.fazenda.sp.gov.br/servicos/nfe/Paginas/URL-WEBSERVICES.aspx) e [NFC-e SP](https://portal.fazenda.sp.gov.br/servicos/nfce/Paginas/WebServices.aspx). Não aceita endpoint arbitrário, não contém SOAP e não envia requisições.

O pacote `fiscal-schema/protocol_validator.py` confere esse payload e candidatos de resposta no perfil oficial separado PL 010d v1.03. As três verificações JS novas e treze Python de consulta passaram; o total do pacote XML é 27 testes. Um futuro endpoint autenticado deve ainda vincular a chave à empresa autorizada; esta função interna não é controle de acesso. O transporte e a atribuição de confiança SEFAZ continuam pendentes.

## Rascunho SOAP de consulta: interface legada conservada

`protocol-soap.mjs` acrescenta uma preparação e uma extração **offline**, separadas da assinatura. Não contém cliente HTTP, certificado, mTLS, chamada SEFAZ, retry ou alteração do ciclo fiscal.

`prepareProtocolSoapDraft({ accessKey, expectedModel, environment: '2', requestId })` reaproveita a identidade e os endpoints fixados da consulta. Monta `Envelope/Body/nfeDadosMsg/consSitNFe` SOAP 1.2, sem `nfeCabecMsg`. Esta interface foi criada antes da obtenção dos WSDLs SP e conserva seu contrato: `bindingStatus: 'pending-sp-wsdl'`, `bindingVerified: false`, `canTransmit: false` e `soapAction:null`; o content type offline é `application/soap+xml; charset=utf-8`. A revisão posterior foi isolada em um módulo novo, sem mudar os consumidores anteriores.

`extractProtocolSoapCandidate({ envelopeXml, expectedAccessKey, expectedModel, environment: '2' })` aceita apenas o caminho direto `Envelope/Body/nfeResultMsg/retConsSitNFe`, com namespaces exatos, um único resultado e um único retorno. Aceita cabeçalho ausente ou vazio; recusa cabeçalhos ativos, SOAP 1.1, Fault, mensagens duplicadas/aninhadas, XML escapado como texto, atributos de encoding/links e contexto divergente no retorno, protocolo e eventos observados. Os limites estritos existentes se aplicam ao envelope completo: 512.000 bytes UTF-8, 25.000 nós, profundidade 80 e 40 atributos por elemento; DTD/XXE, comentários, CDATA e processing instructions adicionais são recusados.

O retorno contém `payloadXml` **não confiável**, destinado exclusivamente ao backend e à validação independente de `ProtocolValidator`. A serialização da subárvore produz novos bytes; `payloadDigest` identifica esses bytes, e `envelopeDigest` identifica a entrada original. Não confundir os digests ou utilizar o resultado para verificar uma assinatura como se preservasse o documento de origem. Não expor esses XMLs em logs ou no frontend. Os erros contêm somente códigos estáveis, sem motivo fiscal, XML ou corpo de Fault.

`queryContextMatched` refere-se à correspondência de chave/modelo/ambiente/UF e não significa conformidade XSD nem origem autêntica. `requiresProtocolValidation` permanece verdadeiro; `xsdValidated`, `verified`, `tlsOriginVerified`, `signatureVerified`, `sefazAuthorized` e `canTransmit` permanecem falsos. O XSD pode rejeitar um candidato que passou apenas na extração, caso demonstrado nos testes.

### Evidência e lacunas verificadas em 16/10/2026

- [MOC 7.0, §4.2.2 p.52 e §4.4.1 p.64](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-visao-geral.pdf): SOAP 1.2 Document/Literal; eliminação das variáveis do cabeçalho na versão 4.00. A p.64 foi renderizada e inspecionada. SHA-256 do PDF: `f664dcf94b77cabb32311620d85a7eb02cdf86adb2d4632ce178af2572dd2ad1`.
- [NT 2016.002 v1.51, §§2.2–2.4, pp.11–13](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=mqf2EDdt9Ug%3D): método `nfeConsultaNF`, serviço `NFeConsultaProtocolo4` e parâmetros de entrada/saída `nfeDadosMsg`/`nfeResultMsg`. A tabela da p.13 foi renderizada e inspecionada. SHA-256: `4577e541d07173eec79c61cf2e6699c02772da1e46ccebdbd0e233ef1f64112f`. Fonte histórica específica do contrato 4.00; não afirma vigência tributária em 2026.
- [SOAP 1.2 W3C, §§5.1–5.4](https://www.w3.org/TR/soap12-part1/): identidade de Envelope/Body/Fault e regras de estrutura. [Parte 2, §6.5 e apêndice A](https://www.w3.org/TR/soap12-part2/): mídia `application/soap+xml` e parâmetro action. O parser adota um subconjunto conservador, não pretende ser um processador SOAP genérico.
- [NF-e SP](https://portal.fazenda.sp.gov.br/servicos/nfe/Paginas/URL-WEBSERVICES.aspx) e [NFC-e SP](https://portal.fazenda.sp.gov.br/servicos/nfce/Paginas/WebServices.aspx) publicam os endpoints de homologação. As raízes públicas usadas nos testes estão identificadas no [manifesto de confiança](../fiscal-vault/trust/manifest-20261016.json). Material público arquivado não configura automaticamente a confiança TLS do runtime nem atesta revogação, acesso ao serviço ou autorização fiscal. Uma resposta HTTP 403 isolada não comprova a exigência exata de acesso ao WSDL.

O relato de indisponibilidade acima descreve as tentativas iniciais sem certificado. Posteriormente, uma etapa de GET especificamente autorizada preservou os dois WSDLs; sua revisão está descrita abaixo. Nenhuma consulta SOAP foi realizada por estes pacotes.

Nove novos testes Node cobrem envelope/contexto, wrapping, namespaces, duplicidades, Fault, tamanho/encoding e erros sem dados privados. O pacote XML totaliza 36 testes. Dois testes Python em `fiscal-schema/test/test_protocol_soap.py` cruzam o payload montado e o candidato extraído com o XSD fixado dos modelos55/65, mantendo separadas as afirmações de estrutura e confiança.

## Perfil SOAP revisado por hash, ainda offline

`src/protocol-binding.mjs` fixa os snapshots WSDL 55/65 obtidos e revisados em 16/10/2026. Confere hashes/tamanhos, deriva action/Content-Type SOAP 1.2 e preserva os wrappers `nfeDadosMsg`/`nfeResultMsg`. A preparação é atestada no processo; a extração fica vinculada à chave/modelo/ambiente dessa preparação. O módulo não foi exportado no index nem conectado a Worker/runtime/UI. Não inclui driver, rede, A1 ou grant.

O [perfil revisado](src/protocol-binding.mjs) define os bindings aceitos; os [testes de binding](test/protocol-binding.test.mjs) verificam suas restrições. A autorização e a custódia específicas para consulta pertencem à composição do servidor. `bindingReviewed:true` descreve somente revisão local; `bindingVerified`, `canQuery`, `canTransmit` e demais capacidades permanecem falsos. A autorização 051 de GET WSDL não habilita POST SOAP.
