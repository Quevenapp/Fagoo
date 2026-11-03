# Runtime de prévia DANFE

Leitura isolada de candidatas 050 armazenadas, modelos 55/65 e ambiente 2. Não chama A1, signer, XSD, SOAP ou SEFAZ; não altera SQL nem Storage. A impressão continua sendo uma prévia de homologação sem valor fiscal, inclusive quando o contexto da candidata deixou de ser atual. Não representa um DANFE autorizado.

## Composição

```js
import {createDanfeRuntimeHandler} from './src/handler.mjs';
const danfe = createDanfeRuntimeHandler({
  rpc: signedRpc,
  storage: {read: artifactStorage.read},
  transportSecret, transportKeyId,
  audience: `${audienceBase}-danfe`,
  concurrency: 2,
});
// GET http://runtime.internal/internal/v1/fiscal-danfe/candidates/:uuid/preview
// Ao encerrar a composição:
danfe.dispose();
```

O handler captura a função `storage.read`, copia o segredo HMAC e fornece `.dispose()` para zerar sua cópia, cancelar requisições e impedir novas admissões. Seu limite é de duas leituras concorrentes e 45 segundos incluindo RPC, Storage, renderização e validação da resposta. A composição deve continuar impondo seu limite global de recursos. A renderização síncrona tem entradas limitadas, mas não é preemptiva durante uma chamada JavaScript.

`createDanfeGateway({fetchImpl,now,nonce})` é Web-safe e usa as configurações existentes `ALLOWED_ORIGINS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `A1_RUNTIME`, `A1_TRANSPORT_SECRET`, `A1_TRANSPORT_KEY_ID`, `A1_AUDIENCE`. O nome da configuração compartilhada não dá ao módulo acesso ao certificado: são portas de transporte. Nenhuma variável de KEK/custódia é lida.

## Rota e autorização

Única rota pública: `GET /v1/fiscal-danfe/candidates/:uuid/preview`. UUID canônico minúsculo; sem corpo, query ou fragmento. OPTIONS permite somente essa leitura e headers Authorization/Content-Type. Não há rota de XML, download, chave, assinatura, impressão autorizada ou URL fornecida pelo cliente.

O gateway exige Origin HTTPS exato e sessão Auth não anônima. HMAC SHA-256 usa o esquema `Brufap-Danfe`, domínio `brufap-danfe-request-v1` e audiência terminada em `-danfe`, vinculando ator, método, caminho, nonce, hash do corpo vazio e janela de 60 segundos. Repetir o transporte nessa janela repete apenas uma leitura autorizada, sem concessão single-use ou comando de escrita. Não há retry automático.

O handler chama apenas `erp_fiscal_signed_get(p_user_id,p_candidate_id)`, já service-only. Essa RPC revalida admin/fiscal ativo e emissor da reserva por `require_source`/`require_issuer`; não basta possuir o UUID ou uma sessão Auth. Somente `state=stored` segue para Storage. O objeto é derivado exclusivamente do recibo validado: bucket `brufap-fiscal-artifacts`, caminho `candidates/<id>/<signed_hash>.xml`. O runtime aceita application/octet-stream, até 512.000 bytes, SHA-256 e tamanho exatamente iguais ao artefato registrado. O parser volta a vincular ambiente/modelo/hash/tamanho.

Depois de renderizar, uma segunda chamada à mesma RPC reautoriza o ator/emissor. Recibo e artefato imutáveis precisam ser idênticos; mudanças legítimas de `current` são preservadas separadamente. Revogação, troca de emissor ou falta de confirmação impedem a resposta HTML. Nenhum dado bruto é incluído em erros/logs. A leitura histórica não exige que o A1 ainda esteja ativo ou que as bases ainda sejam atuais; a RPC continua exigindo o emissor autorizado.

## DTO e apresentação

`await publicResult(raw,{candidateId})` retorna `DanfePreview`; tipos estão em `dto.d.mts` e `protocol.d.mts`. Campos exatos:

```text
data_mode:'fiscal_danfe_preview', read_only:true, environment:'2'
candidate_id, candidate_version, model:'55'|'65'
source_sha256, source_size_bytes
html, html_sha256, html_size_bytes, page_count, profile
current:{artifact_current,basis_changed,draft_archived,
         source_cancelled,is_latest_candidate,a1_changed}
authorized:false, authorization_verified:false,
can_emit:false, can_transmit:false
```

HTML UTF-8 até 4 MiB; JSON serializado até 8 MiB, recusado se o escape superar esse limite. Hash/tamanho são conferidos no runtime e novamente no gateway; o cliente pode reutilizar o validador assíncrono. O DTO não expõe XML, refs de A1, fingerprint, lease ou caminhos de Storage. O HTML contém os dados fiscais necessários à prévia, portanto requer sessão e `no-store`.

O HTML incorpora `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`. O validador aceita somente tags inativas usadas pelo renderer, rejeita eventos/links/recursos externos/CSS com URL e aceita apenas larguras fixas de colunas em atributos style. SVG é gerado internamente. Não há scripts, navegação clicável ou fontes remotas. O consumidor deve usar `iframe srcDoc` com sandbox sem `allow-scripts`; `allow-same-origin allow-modals` permite ao pai disparar a impressão. Deve limpar srcDoc no logout/troca de ator e descartar respostas tardias. Essa UI não pertence ao pacote.

`page_count` é explícito para A4/55 e null para 65, dependente do meio de impressão. `DANFE_LAYOUT_UNSUPPORTED` (422) cobre cabeçalhos/linhas/páginas não suportados, sem truncamento. Demais falhas usam allowlist; `recovery_required:false` em todos os erros porque não há mutação. Repetir uma consulta após erro não executa ação fiscal.

## Verificação

```sh
node --test --test-concurrency=1 packages/fiscal-danfe-runtime/test/*.test.mjs
BRUFAP_RUN_WORKERD_TESTS=1 node --test packages/fiscal-danfe-runtime/test/gateway-workerd.test.mjs
BRUFAP_RUN_WORKERD_TESTS=1 node --test packages/fiscal-danfe-runtime/test/composition-workerd.test.mjs
```

Testes cobrem HMAC separado, CORS/Auth, RPC antes/depois, revogação durante Storage, hash/tamanho, DTO e HTML ativo, cancelamento/dispose, concorrência, candidatas históricas e erro de cabeçalho. A interop usa SQL 050 real em PGlite, XML assinado fictício e Storage em memória para 55/65; não altera contagens de candidatas/comandos/tentativas/artefatos, nem chama custódia/XSD durante a prévia. A preparação da fixture usa relatório XSD simulado, explicitamente; não é uma nova validação XSD. O teste workerd empacota somente gateway/auth/protocol/DTO, sem imports Node, e intercepta todos os destinos Auth/runtime. Nenhum teste usa certificado real ou rede de negócio.

A composição workerd também percorreu gateway index, dispatcher e bridge reais até o handler Node com portas fictícias para 55/65. Confirmou duas leituras `signed_get` e uma leitura do objeto, nenhum POST ou operação de A1, com protocolo SEFAZ desativado. O probe de prontidão existente faz apenas GET `/internal/v1/a1` sem autenticação e recebe 401; não abre a credencial. HMAC de outros domínios ou audiência incorreta foi recusado antes de iniciar o contêiner. Resultado do lote isolado: 17 testes Node do runtime, 10 do renderer e quatro workerd executados, todos verdes.

Pacote criado para composição futura. Nenhuma publicação ou wiring de server/bridge/dispatch está incluído neste escopo.
