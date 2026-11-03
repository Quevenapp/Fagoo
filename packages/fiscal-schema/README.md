# Validação XSD fiscal offline

Validador Python de candidatos `NFe` 4.00 dos modelos 55 e 65, restrito a homologação (`tpAmb=2`). Usa `lxml==6.1.1` e cinco XSDs oficiais, sem alterações, do pacote **PL 010f v1.04**, publicado em 31/08/2026. Não faz chamadas de rede, transmissão ou consulta à SEFAZ.

O pacote foi obtido em 16/10/2026 na [listagem oficial de esquemas NF-e](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=), pelo [arquivo oficial](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=8ITFuBLltXs=). O ZIP tem SHA-256 `b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998`. A listagem relaciona NT 2025.002 v1.50 e NT 2026.007 v1.00 a este pacote. O manifesto registra a origem, data e hashes individuais.

**Publicação de um XSD não comprova a vigência de todas as regras tributárias nem a aptidão para produção.** O usuário confirmou Simples Nacional; isso não substitui a revisão da tributação de cada operação. CRT, CSOSN, NCM, CFOP e tributos presentes nas fixtures são dados exclusivamente sintéticos de teste, não parâmetros sugeridos para a empresa.

## Uso

```sh
python3 -m pip install -r packages/fiscal-schema/requirements.txt
python3 packages/fiscal-schema/validator.py --model 55 < candidato-homologacao.xml
python3 -m unittest discover -s packages/fiscal-schema/test -p 'test_*.py' -v
```

Os testes também precisam do Node 22.10+ e das dependências locais de `packages/fiscal-xml` (`npm ci --prefix packages/fiscal-xml --ignore-scripts`). Eles geram chaves e certificados fictícios apenas em memória, assinam documentos completos de exemplo e conferem os dois modelos com o XSD. Nenhum certificado da empresa é usado.

CLI: XML por stdin, resultado JSON em stdout; código 0 para estrutura válida ou 2 para rejeição. Importação Python: `Validator().validate(xml_bytes, expected_model="55")`, com exceção `FiscalSchemaError` de código estável. Os diagnósticos incluem somente linha, coluna e categorias libxml; mensagens e caminhos que possam reproduzir dados do XML são excluídos.

O manifesto é fixado por hash no código. Cada XSD é conferido por tamanho e SHA-256 antes de compilar. O resolvedor aceita exclusivamente os bytes já verificados dos cinco arquivos locais. Não há download automático ou confiança em `schemaLocation` informado pelo candidato. Atualizar schemas exige revisão explícita do pacote e do hash do manifesto.

Limites locais: 512.000 bytes UTF-8, 25.000 nós, profundidade 80 e 40 atributos por elemento, alinhados ao módulo de assinatura. DTD, entidades declaradas, comentários, CDATA e instruções adicionais de processamento são recusados. O XML não é reformatado ou normalizado para tentar corrigir uma entrada inválida. Estes limites são política da aplicação, não uma afirmação dos limites legais da SEFAZ.

## O que um resultado válido significa

`xsdValidated: true` significa somente que **aqueles bytes** respeitam o perfil XSD indicado. `xmlDigest` identifica os bytes examinados. O resultado sempre mantém `signatureVerified`, `taxRulesValidated`, `icpBrasilChainValidated`, `revocationChecked`, `sefazAuthorized` e `canTransmit` como `false`.

Os testes mostram deliberadamente que alterar um total para outro decimal válido ainda pode passar no XSD. A conferência criptográfica de `packages/fiscal-xml` deve ocorrer sobre exatamente o mesmo documento; validação aritmética, tributária, cadeia ICP, revogação e autorização são etapas distintas. Não combine relatórios de documentos com hashes diferentes.

O validador de notas não valida XML histórico de produção, `nfeProc`, lote SOAP ou evento de cancelamento. A consulta de protocolo tem um perfil independente descrito abaixo. Não se deve aplicar o schema mais recente indiscriminadamente aos arquivos antigos do Origin. O suporte estrutural ao modelo 65 não conclui a implementação de NFC-e. O pacote irmão `fiscal-xml` monta e verifica o suplemento QR v3 online SP/homologação, e um teste valida seu XML final assinado neste XSD. Representação gráfica do QR, configuração fiscal e comunicação com a SEFAZ permanecem etapas próprias. O XSD isolado permite combinações que regras de negócio posteriores podem rejeitar.

12 testes cobrem documentos assinados dos dois modelos, ordem/campos/decimais inválidos, fronteiras de confiança entre XSD e assinatura, dados sensíveis em erros, entradas XML proibidas, limites, modelo/ambiente, integridade de cada dependência e CLI. A validação também foi empacotada e testada no contêiner local descrito abaixo; sua ligação ao executor publicado permanece pendente.


## Consulta de protocolo: perfil independente

`protocol_validator.py` valida offline `consSitNFe` e `retConsSitNFe` usando cinco arquivos oficiais imutáveis do **PL 010d v1.03**, listado como vigente em 10/07/2026. As dependências ficam separadas do perfil de notas PL 010f. Manifesto, tamanhos e hashes são fixados; imports externos e resolução de rede são proibidos. [Pacote oficial](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=%2BpBOYTXBtbk%3D).

O contexto exige chave válida, modelo 55/65, SP, emissão normal e homologação. Confere a chave/ambiente no retorno e no protocolo interno, UF, timestamps e, quando fornecido pelo servidor confiável, o `DigestValue` da referência assinada de `infNFe` (SHA-1 em Base64, não o SHA-256 do arquivo inteiro). Protocolos de 15/17 posições são aceitos. Códigos desconhecidos são preservados, sem instrução de reenvio.

Um retorno com `cStat=101` e protocolo original `100` não vira um protocolo de cancelamento. Eventos/retornos legados são sinalizados para reconciliação; suas assinaturas não são verificadas. O resultado sempre mantém `verified`, `tlsOriginVerified`, `signatureVerified`, `sefazAuthorized` e `canTransmit` em `false`. Passar no XSD e conferir contexto não comprova origem SEFAZ nem autoriza uma transição fiscal.

A CLI recebe JSON por stdin com `xml`, `expectedAccessKey`, `expectedModel`, `direction` (`request`/`response`) e `expectedReferenceDigest` opcional. Retorna somente metadados e códigos; omite XML, chave, CNPJ, `xMotivo` e valores de diagnóstico. Esses metadados ainda incluem protocolo/data e pertencem ao backend privado. Limites de bytes/árvore seguem o validador de notas. Não há SOAP, mTLS ou chamadas de rede.

Os 13 testes de consulta, somados aos 12 testes de notas, passaram localmente. Cobrem geração JS validada no XSD, ambos os modelos, chave alfanumérica, correlação de digest, eventos com assinatura fictícia sem ganho de confiança, limites XML, erros sem valores privados, integridade do perfil e CLI. As consultas públicas de WSDL SP não concluíram no runtime local por cadeia TLS não reconhecida; a validação de certificado não foi desativada. O transporte ainda depende de runtime/cofre/cadeia e integração real de homologação.


## Contêiner offline local

O `Dockerfile` usa a imagem Node 24 Bookworm fixada por digest, Python em ambiente virtual e `lxml==6.1.1`. A imagem final contém apenas os validadores e os esquemas públicos; executa como usuário `node`, recebe XML por stdin e devolve o relatório pela CLI. Não expõe HTTP, acessa o cofre ou recebe certificado. O contexto de build possui uma lista explícita de arquivos permitidos.

Em 16/10/2026, os 33 testes estruturais passaram no build e novamente no runtime com rede desabilitada, raiz somente leitura, 256 MiB de memória, um núcleo e 128 processos. As fixtures usam somente certificados fictícios em memória. A imagem final também rejeitou entrada vazia com `XML_SIZE_OR_TYPE_INVALID`, código de saída 2. Um XML NF-e sintético assinado passou pela CLI da imagem final, mantendo `canTransmit=false`. O conjunto de testes comerciais do builder continua separado, pois não é dependência do validador.

```sh
docker build --platform linux/amd64 --target test -f packages/fiscal-schema/Dockerfile -t brufap-fiscal-schema-test:local .
docker build --platform linux/amd64 --target production -f packages/fiscal-schema/Dockerfile -t brufap-fiscal-schema:local .
docker run --rm -i --network none --read-only --tmpfs /tmp:rw,nosuid,noexec,size=64m --memory 256m --cpus 1 --pids-limit 128 brufap-fiscal-schema:local --model 55 < candidato-homologacao.xml
```

A imagem ainda não foi enviada à Cloudflare. O contêiner é um processo offline isolado, não um serviço público nem uma autorização para emitir.
