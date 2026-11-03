# Composição de leitura da autorização fiscal 064

Composição de leitura que exige a estrutura 064 no banco e mantém as políticas operacionais desabilitadas por padrão. A composição permite consultar a candidata assinada e o histórico do ledger 064. Não oferece autorização de envio, transporte SOAP, novo uso de A1 ou habilitação de política. A existência da migração 064 no destino é pré-requisito das leituras; sua ausência falha fechada, sem fabricar histórico vazio.

## Caminho autenticado

`fiscal-gateway` valida a sessão de autenticação (recusa usuário anônimo), a origem HTTPS autorizada e o corpo fechado. Encaminha somente os caminhos conhecidos ao executor privado. O executor/bridge e o servidor Node verificam a assinatura HMAC específica antes de alcançar o serviço. A composição reutiliza `A1_TRANSPORT_SECRET`/`A1_TRANSPORT_KEY_ID`, com domínio `brufap-authorization-request-v1`, esquema `Brufap-Authorization` e audience `${A1_AUDIENCE}-authorization`. A mensagem vincula ator, método, caminho, hash dos bytes, nonce e horário. Assinaturas dos domínios A1, signed, WSDL, reconciliation, DANFE e unsigned não são aceitas aqui.

O ator vem exclusivamente de `/auth/v1/user`, nunca do corpo. A chave service-role permanece no contêiner privado já existente. Não há novo segredo, acesso ao bucket A1, RPC de uso do certificado ou ampliação de grants. As RPCs mantêm a ACL 064: admin/fiscal ativos; leitura de comando exige o ator original, enquanto o histórico público não expõe identidade do ator. `recoverable_by_actor:false` não identifica outro ator: também ocorre em resultados próprios terminados.

## Rotas

Prefixo público `/v1/fiscal-authorization`, prefixo interno `/internal/v1/fiscal-authorization`.

| Método e caminho | Corpo | Comportamento nesta composição |
| --- | --- | --- |
| POST `/preview` | `candidate_id`, `signed_hash` | Consulta 050, lê os bytes assinados existentes, confere hash/tamanho/assinatura/certificado fixado, reconsulta 050 e consulta a política 064. |
| GET `/commands/:uuid` | Ausente | Retorna recibo histórico e contexto atual separados, após ACL. |
| POST `/candidates/:uuid/history` | `limit` de 1 a 25, `before:null` ou string decimal positiva com até 15 dígitos | Lê página estrita, sem efeitos. |
| POST `/recover` | `command_id` | Consulta o comando e verifica ACL; devolve 503 `AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE` com o mesmo comando. Não lê diário, não refaz validação e não altera estado. |
| POST `/run` | Corpo fechado do contratoHTTP 064 | Sempre 503 antes de qualquer RPC ou chamada a `service.run`. O gateway também impede encaminhamento. |

Recuperação indisponível não significa rejeição definitiva de uma tentativa anterior. `recovery_required:true` conserva o comando; nenhum retry automático ocorre. A prévia mantém `can_prepare:false`, `operational_binding_available:false`, `service_enabled:false` e todas as capacidades de emissão/transmissão falsas. Conferência de assinatura e certificado público nos bytes já armazenados não afirma confiança ICP, revogação, regras tributárias ou aceite SEFAZ.

O DTO público é validado novamente no gateway por `fiscal-authorization-http/publicResult`. Não contém XML, CNPJ, chave de acesso, certificado, fingerprint, credencial, lease, nonce, caminho de Storage ou execução privada. Os tipos web estão em `fiscal-authorization-http/src/dto.d.mts`.

## Serviço de leitura e limites

`createAuthorizationReadService({rpc,storage:{read}})` compartilha o algoritmo de leitura do serviço completo por `read-operations.mjs`. Captura as portas e recusa capacidades extras. Sua allowlist contém apenas `erp_fiscal_signed_get`, `erp_fiscal_authorization_preview`, `erp_fiscal_authorization_command` e `erp_fiscal_authorization_history`. Não recebe binding sintético, writer, validador Python, transporte ou custódia. O servidor passa apenas `storage.read`; os algoritmos existentes de envio/recuperação sintéticos continuam testados separadamente.

O corpo público tem no máximo 4 KiB e a resposta 128 KiB, UTF-8 estrito, sem redirecionamento nem conteúdo comprimido. Leitura do corpo/Auth tem 10 s; runtime/serviço 45 s; gateway 60 s; o cliente pode usar 65 s. A autenticação de transporte aceita até 60 s passados e 5 s futuros, sem criar autorização fiscal ou proteção de uso única por si só. Esta composição é somente leitura, inclusive o tratamento de `/recover`.

O limite compartilhado de duas requisições do servidor inclui este domínio. Cancelamento, timeout e `dispose()` fecham admissão e descartam respostas tardias. Segredos copiados são zerados e referências convenientes no ambiente são removidas pela composição existente. Nenhum processo adicional de OpenSSL ou Python é criado por estas leituras.

## Verificação local

- `node --test packages/fiscal-authorization-runtime/test/handler.test.mjs packages/fiscal-authorization-runtime/test/gateway.test.mjs`
- `node --test --test-concurrency=1 packages/fiscal-authorization/test/read-service.test.mjs packages/fiscal-authorization/test/service.test.mjs`
- `node --test packages/fiscal-runtime/test/server-composition.test.mjs`
- Opcional, com Miniflare/esbuild já instalados: `BRUFAP_RUN_WORKERD_TESTS=1 node --test packages/fiscal-authorization-runtime/test/gateway-workerd.test.mjs`. Usa apenas loopback e portas sintéticas, sem rede externa.

As provas cobrem modelos 55/65 com certificado fictício, paridade da extração de leituras, ausência de mutação, ACL, ator, bytes e DTO, mistura de domínios, composição gateway→dispatch→bridge→handler, disposição e prazos. O Dockerfile inclui o teste do handler e da composição, sem fixtures privadas ou novos arquivos de esquema de autorização. Não foi criada política operacional, grant de envio, custódia adicional ou transporte SEFAZ.

## Extensão local de revisão068

A composição de revisão acrescenta GET/POST `/candidates/:uuid/review` e GET `/review-commands/:uuid`. O ator autenticado alcança apenas signed_get, as três RPCs068 e leitura de Storage, com ACL admin/fiscal real. O domínio HMAC continua o mesmo; as rotas antigas e o bloqueio de `/run` permanecem.

Somente as rotas de revisão usam144KiB de request/1MiB de response. O DTO browser-safe (`review-dto.mjs` + tipos) não depende de Node e conserva todas as flags operacionais falsas. Uma resposta perdida após POST mantém UUID e recuperação por GET, sem retry automático. Contrato de entrada e exposição HTTP: [fronteira de revisão 068](../../packages/fiscal-authorization-runtime/src/review-boundary.mjs).
