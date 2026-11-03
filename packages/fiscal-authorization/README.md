# Candidatos de autorização — núcleo e adaptador local

Implementação isolada de 16/10/2026, SP, modelos 55/65, homologação, emissão normal e uma NFe por lote síncrono. O núcleo é puro; os módulos privados `service`, `rpc` e `storage` compõem a migração 064 local por portas obrigatórias. Não há composição com servidor, HTTP público, scheduler, credenciais de ambiente ou transporte operacional. A 064 foi testada localmente e não foi aplicada remotamente neste lote.

## Contrato

`prepareAuthorization` recebe bytes assinados, hash, modelo, emitente, certificado público/fingerprint/titular **vindos do backend autenticado**, instante explícito de verificação e `batchId` decimal canônico de 1 a 15 dígitos. Não aceita `KeyInfo` sem vínculo ao certificado esperado. Verifica assinatura/QR, chave SP, ambiente 2, modelo, emissão normal e série até889; constrói `enviNFe`, `indSinc=1`, preservando a NFe assinada. Apenas a declaração XML externa é retirada quando presente. `batchId` é persistido pela 064 antes do envio; o núcleo não o escolhe nem o reserva.

O retorno é um handle congelado com metadados. `authorizationRequestBytes(handle)` devolve uma cópia independente. Buffers com offset são respeitados, SharedArrayBuffer é recusado, getters de entrada não são executados. Clonar/serializar o handle exige reconstruí-lo a partir das evidências originais; a marca privada é controle local, nunca autenticação ou permissão.

`parseAuthorizationResponse({request,responseBytes})` recebe **somente o elemento fiscal retEnviNFe**, não SOAP. Confere contexto, cardinalidade, recibo, datas e digest quando presente. Classificações:

- `103` com recibo: `receipt_pending`.
- `104` com protocolo individual `100`/`150` e digest correspondente: `authorization_declared`.
- Rejeição individual/lote: `rejected`.
- Duplicidade204/539, 106/217, estados de processamento inesperados: `review_required`.

O código104 isolado não autoriza nada. Nenhuma classificação permite reenviar. O núcleo conserva hash da resposta e metadados mínimos; não retorna `xMotivo`, mensagens livres ou certificado. O adaptador privado preserva bytes inválidos/Fault **no diário antes desta chamada**. O núcleo os recusa, sem normalização.

`composeProcessedNfe({request,response})` só aceita os handles originais vinculados. Gera um **candidato** `nfeProc` preservando a NFe assinada e o protocolo ligado a seu digest, e reconfirma a assinatura no subtree incluído. O wrapper acrescenta apenas o mesmo namespace padrão, sem outros namespaces ou atributosxml. Testes independentes verificam a assinatura usando o documento nfeProc inteiro. A assinatura do eventual protocolo SEFAZ não é validada/atestada neste recorte.

Todos esses resultados mantêm `xsdValidated`, `tlsOriginVerified`, `sefazAuthorized`, `authorizedInHomologation`, `productionAuthorized`, `legalFiscalValue`, `canEmit`, `canTransmit` e `retrySubmissionAllowed` falsos. `signatureVerified:true` significa somente a verificação local da assinatura da NFe. Uma resposta fabricada com100/digest correto continua sem origem comprovada; não pode alimentar estado fiscal autorizado sem o futuro ledger/TLS/validador.

O relógio é explícito e copiado uma vez. Na recuperação histórica, o adaptador usa o instante e o certificado público vinculados à captura persistida; isso não autoriza usar hoje um A1 vencido. O núcleo não abre a chave nem concede uso.

## XSD e proveniência

O ZIP oficial PL010f v1.04 já capturado tem SHA256 `b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998`. Seus cinco arquivos e manifesto permanecem inalterados em `../fiscal-schema/schemas/pl010f-v1.04`. Esse pacote oficial não contém os entrypoints envi/ret/proc, embora seu `leiauteNFe_v4.00.xsd` defina os três tipos.

Os três arquivos em `schema/` são, portanto, **wrappers locais Brufap**: apenas `xs:include` do layout oficial e `xs:element` para `TEnviNFe`, `TRetEnviNFe` e `TNfeProc`. Não se afirmam arquivos oficiais nem alteram restrições dos tipos. Manifesto próprio fixa seus hashes e o hash do manifesto oficial. Resolver só aceita esses bytes verificados; nenhum include/import externo, DTD ou entidade é seguido.

`validator.py` usa lxml, árvore limitada, XSD real e conferências de ambiente/modelo/chave/batch/digest. A validação de estrutura **não verifica criptografia nem origem**. `authorizationDeclared:true` é interpretação da declaração100/150, distinta do sempre falso `authorizedInHomologation`. Erros são códigos fechados; mensagens libxml e conteúdo do XML não saem do processo.

`src/validator.mjs` oferece `createAuthorizationValidator({pythonPath,validatorPath,spawnImpl?})`. Paths locais absolutos obrigatórios; o fonte Python é pinado antes de executar no processo filho, com `-I`, ambiente mínimo e sem shell. Entrada512000 bytes, prazo máximo10s incluindo startup/leitura do fonte, stdout16KiB, stderr8KiB. Abort/timeout matam o processo e descartam saída tardia; o relatório deve corresponder exatamente ao hash e contexto capturados. Não há configuração por env nem instalação de dependência automática. O host precisa de Python/lxml; nenhuma composição de servidor/Docker foi alterada.

## Dependências ainda bloqueantes para envio

`authorizationBindingStatus(model)` retorna `reviewed_wsdl_required`: os únicos WSDLs locais revisados são de ConsultaProtocolo. Não há pin/action/wrapper autorizado de Autorizacao/RetAutorizacao/Status neste pacote. Nenhuma URL/action é deduzida do binding062. A obtenção/revisão do WSDL apropriado e o contrato SOAP pertencem à etapa coordenada seguinte.

Também permanecem necessários o perfil de regras vigente/RTC, credenciamento por modelo/ambiente, composição operacional de custódia/TLS, política de reconciliação e UI. Ledger, grant de consumo e diário já têm implementação local; sua existência não habilita transmissão. Não basta XSD para autorizar tributação. CSC não é requerido pelo QRv3 online SP selecionado; isso não modifica perfis antigos. Consulte o plano completo em `../../docs/integrations/fiscal-authorization-plan.md`.

## Adaptador privado 064

`createAuthorizationService` em `src/service.mjs` recebe explicitamente RPC, Storage, validador, binding, custódia e transporte. Oferece `preview`, `run`, `recover`, `command` e `history`. O padrão é `enabled:false`. O binding disponível neste recorte tem origem sintética; `mode:'operational'` recusa `run` antes de qualquer RPC mesmo com `enabled:true`. A fixture de transporte é somente memória, sem SOAP roteável ou URL padrão.

`pinnedCandidateCertificate` verifica primeiro hash e tamanho exatos do artefato 050. Depois extrai exatamente um certificado público DER de `KeyInfo`, exige SHA256 igual ao fingerprint histórico do backend e reconfirma assinatura/contexto. Certificado duplicado ou fonte alternativa de chave é recusado. Esse módulo não é exportado pelo índice público e não abre PFX, senha ou chave privada.

`run` grava e relê o request imutável antes de `prepare/use`. O consumo acontece uma vez, depois da preparação de sessão e imediatamente antes do transporte. Os bytes completos da resposta e o sidecar são gravados e relidos antes da interpretação e do XSD, inclusive para HTTP500 ou XML inválido. Um ACK perdido é resolvido por leitura; não causa sobrescrita ou outro envio. HTTP500 nunca produz autorização, mesmo contendo um corpo com100.

`recover` recebe apenas ator/comando e usa contexto privado persistido: `command → request/diário → validação → finish`. Não chama `begin`, `prepare`, `use`, custódia ou transporte. Uma tentativa não consumida permanece sem envio; ausência/conflito do diário exige revisão. Recuperação após lease/A1/política alterados usa os vínculos históricos e a ACL atual. A implementação atual processa somente diários sintéticos; origem operacional futura exige seu binding revisado. `command/history` já conseguem projetar registros de ambas as origens sem consumir grants.

RPC/Storage exigem `projectUrl`, chave de serviço e `fetchImpl` explícitos; não leem env nem possuem fetch padrão. A RPC aceita apenas as oito operações064 e `signed_get`050, projeta DTO privado e sanitiza SQLSTATE. Storage usa bucket fixo, namespace `authorization/`, limite512000 por XML e8192 por sidecar, escrita imutável e readback. O prazo global do serviço é45s; a sessão de transporte é no máximo20s, reservando tempo para persistência/validação. Abort e prazo são rechecados no microtask imediatamente anterior ao transporte.

Os resultados compactos não contêm contexto privado, certificado, CNPJ, chave da nota, XML ou caminhos de Storage. Recibo histórico e estado atual permanecem separados. Resultado sem prova suficiente retorna `unconfirmed` com recuperação necessária e o mesmo comando. O contrato completo e os limites estão em [fiscal-authorization-adapter.md](../../docs/integrations/fiscal-authorization-adapter.md).

## Verificação

A persistência mínima068 está isolada em `src/subset-review-{dto,rpc,reader}.mjs`, sem exports globais ou composição de runtime. SQL aplicada e confirmada em16/10/2026, preservando144 tabelas; runtime/UI não publicados. Guarda declarações imutáveis com CAS/UUID e fornece `readReview` real ao avaliador existente. `save` não significa aprovação fiscal; latest/revisor/validade e fatos do XML são conferidos novamente na leitura. RPCs privadas, envelopes de288KiB e registro canônico de128KiB; nenhum A1, grant ou transporte. Contrato, limites e provas10SQL+12portas+26aplicador+12corridasPG estão em [fiscal-subset-review-068-plan.md](../../docs/integrations/fiscal-subset-review-068-plan.md). O CAS atômico de revisão em eventual `use` permanece fora deste lote; o gate operacional continua fechado.

`node --test --test-concurrency=1 packages/fiscal-authorization/test/*.test.mjs` passou **38/38**; uma regressão posterior de tamanho de histórico passou **1/1**, totalizando39 casos. Usa somente certificados/valores fictícios. O Python de testes pode ser indicado por `BRUFAP_TEST_PYTHON`; não é uma variável do runtime.

Cobertura: núcleo12, certificado público5, portas6 e serviço16; 55/65 e250 itens,103/104/100/150/rejeições, diferenças chave/digest/hash/certificado, declaração de produção, bytes próprios/offset/SharedArrayBuffer/getters, XSD real, assinatura sobre nfeProc inteiro, clone/rebinding, SQL064 real em PGlite através da porta HTTP/DTO, captura antes do await, cancelamento/prazo/saída inválida, ACKs perdidos, conflito de diário e recuperação sem nova custódia. Um histórico conservador de25 resultados terminais com campos largos, serializado como JSONB text, ocupa98.745 bytes e atravessa a RPC/DTO sob o teto131.072. Nenhuma SEFAZ, A1 real, cadastro ou transmissão externa foi acessada. Os testes concorrentes da própria064 estão documentados em [fiscal-authorization-ledger.md](../../docs/integrations/fiscal-authorization-ledger.md).
