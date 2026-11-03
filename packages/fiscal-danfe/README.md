# Prévia local de DANFE

Pacote experimental e isolado para representar candidatas assinadas dos modelos 55 e 65, exclusivamente em homologação. Não está conectado ao ERP, ao gateway, ao Storage ou a uma rota de download. Não emite, transmite, consulta a SEFAZ ou abre certificados.

```js
import {extractCandidatePreview, renderCandidateHtml} from './src/index.mjs';
const projection = extractCandidatePreview(bytes, {
  candidate_id, sha256, size_bytes, model: '55', environment: '2',
});
const {html} = renderCandidateHtml(projection);
```

O chamador futuro deverá buscar e autorizar a candidata 050, conferir seu contexto atual e fornecer o hash/tamanho registrados. Estes argumentos são um vínculo de integridade, **não uma atestação de autorização**. O pacote não verifica novamente assinatura, cadeia, XSD ou tributos. Todas as saídas permanecem `authorized:false`, `authorization_verified:false`, `can_emit:false` e `can_transmit:false`.

`inspectDeclaredProtocol` serve somente para distinguir metadados declarados em um arquivo histórico. Seu resultado tem `protocol_evidence:'declared_only'`, `render_authorized:false` e não é aceito pelo renderizador. Um `nfeProc`, `cStat=100`, número de protocolo ou nó `Signature` recebido de uma origem não promove esse arquivo a autorizado.

## Recorte

- XML 4.00, SP, emissão normal, CRT 1, finalidade normal; NF-e 55 retrato e NFC-e 65 online QR versão 3 do perfil de homologação já implementado.
- Este primeiro perfil aceita somente CNPJ e chave de acesso numéricos. O builder já admite outros perfis de identidade, mas CNPJ/chave alfanuméricos ficam recusados na impressão até haver contrato e vetores próprios para a representação e os códigos.
- Grupos ICMS SN 101/102/500; NFC-e 102/500; PIS/COFINS Outr 49; pagamentos 01/15; transporte somente modalidade, conforme o builder nativo. Outros grupos, transportador/volumes, duplicatas, RTC, contingência e regimes não cobertos são recusados, sem omissão silenciosa.
- Quantidades até quatro casas no XML e preços até dez, preservados como strings; valores monetários vêm do XML. A única soma de apresentação é frete + seguro + outras despesas no recibo 65, com `BigInt` de centavos. Não há cálculo de tributos, arredondamento de preços ou uso do cadastro atual.
- 512.000 bytes, 25.000 nós, profundidade 64, 250 itens e 100 páginas 55. Buffers compartilhados são recusados. Nenhum truncamento com reticências. Grupo ou tamanho não coberto exige ampliar o contrato antes de renderizar.
- A paginação 55 calcula o espaço dos nomes, endereços, campos e pagamentos antes de distribuir os itens. Cabeçalho que não deixa espaço seguro para o primeiro item retorna `PRINT_HEADER_TOO_LARGE`, sem produzir HTML. Os limites de texto do XML não garantem que toda combinação caiba neste perfil de impressão.
- HTML estático com CSP, textos escapados e SVGs produzidos internamente. Sem scripts, logos, fontes remotas, links ativos ou carregamento do endereço do QR Code.

O perfil 55 é uma **prévia baseada no MOC 7**, com aviso de não autorização em cada folha, identificação e código de barras repetidos. Não é uma certificação de conformidade de impressão final. A versão 65 usa 80 mm e é completa, com itens; não implementa a opção resumida nem contingência. O meio de impressão ainda precisa de ensaio físico antes de qualquer uso operacional.

## Dependências

`@xmldom/xmldom` 0.9.12 já é usado pelo módulo XML. `qrcode-generator` 2.0.4 é uma dependência nova, fixada no lock local, sem dependências transitivas e com licença MIT ([upstream](https://github.com/kazuhikoarase/qrcode-generator/tree/js2.0.4/js)). Gera somente a matriz QR em memória. O perfil atual é ASCII, subconjunto exato de UTF-8, com correção M. Nenhum payload é enviado a um serviço de QR.

`jsqr` 1.4.0 é somente uma dependência de teste, MIT, para decodificar independentemente a matriz gerada. CODE-128C usa as larguras de símbolos padronizadas do MOC; sua tabela de 107 símbolos foi comparada localmente com ReportLab, além dos testes de chave/checksum/quiet zone.

## Verificação local

```sh
node --test packages/fiscal-danfe/test/print.test.mjs
node packages/fiscal-danfe/test/render-fixtures.mjs /Volumes/Dev/tmp/brufap-danfe-qa
```

As fixtures constroem XML de negócio e assinam com RSA/certificado fictício criados em memória. Não usam o A1 da empresa. O teste valida escape, limites, hash/contexto, separação do histórico, dez casas, 250 itens e leitura do QR por outro decoder. Isso não é teste de autorização, transmissão ou homologação na SEFAZ.

O conversor `test/Dockerfile.print-qa` é somente uma ferramenta local opcional, com WeasyPrint 70.0. Deve rodar com rede desativada, montando apenas a pasta de artefatos fictícios. O fetcher recusa recursos de qualquer URL. Não faz parte da imagem fiscal de produção.

Fontes oficiais, vigência e contrato futuro do histórico: [documento de integração](../../docs/integrations/fiscal-danfe-preview.md).
