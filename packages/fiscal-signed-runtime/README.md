# Runtime privado de candidatos assinados

Este pacote adapta a fundação 050 a HTTP. Uma ação explícita pode assinar o XML não assinado já persistido, usando a custódia do A1 no executor Node, conferir assinatura e XSD local e persistir o candidato em Storage privado. O resultado público contém somente metadados. A assinatura não autoriza uma NF-e/NFC-e: não há consulta ou transmissão SEFAZ, download público de XML, API genérica de assinatura, validação tributária, comprovação de cadeia ICP-Brasil ou consulta de revogação neste contrato.

O pacote não lê variáveis de ambiente, não configura séries e não reserva numeração. A composição deve fornecer os ports reais de RPC, Storage, custódia e validador Python. Os testes não utilizam o certificado da empresa, dados de produção ou serviços externos.

## Fronteiras HTTP

| Método e rota pública | Entrada | Efeito |
| --- | --- | --- |
| `POST /v1/fiscal-signed/run` | `command_id`, `unsigned_job_id`, `unsigned_hash`, `basis_hash`, `expected_a1_version` | Executa ou recupera o mesmo comando da 050. |
| `GET /v1/fiscal-signed/commands/:id` | UUID no caminho | Consulta o comando do ator autorizado. |
| `GET /v1/fiscal-signed/candidates/:id` | UUID no caminho | Consulta o candidato autorizado. |
| `POST /v1/fiscal-signed/jobs/:id/history` | `limit` de 1 a 25, `before` inteiro positivo ou `null` | Consulta paginada; nenhuma escrita. |

Campos extras, query strings, XML, ator, chave fiscal, certificado, identidade, lease e opções de execução vindas do navegador são recusados. UUIDs e hashes usam a representação canônica minúscula. O corpo JSON tem no máximo 4 KiB e a resposta 128 KiB. As rotas internas usam o mesmo sufixo sob `/internal/v1/fiscal-signed`.

O gateway autentica o Bearer em `/auth/v1/user`, recusa sessão anônima e vincula o UUID retornado ao HMAC. Não aceita um ator declarado pelo navegador e não interpreta metadados do usuário como permissão. Cada RPC da 050 reautoriza o membro ativo e seu papel admin/fiscal; consultas de comandos também preservam a titularidade exigida pelo SQL. CORS exige uma origem HTTPS explicitamente configurada. Nenhum redirecionamento de Auth ou runtime é seguido.

## Composição

```js
import {createSignedRuntimeHandler} from './src/handler.mjs';

const handler = createSignedRuntimeHandler({
  rpc, storage, withAuthorizedSigner, validateXsd,
  transportSecret, transportKeyId,
  audience: `${a1Audience}-signed`,
  concurrency: 2,
});
```

O factory Node aceita `now` opcional para o relógio de autenticação e exige uma chave de transporte de 32 bytes; mantém cópia própria durante sua vida útil. A composição deve chamar `handler.dispose()` no encerramento: ele fecha a admissão, zera a cópia da chave e aborta requisições ativas, sem alegar desfazer escritas remotas. O dispatcher Node deve construir Requests com a origem fixa `http://runtime.internal`. A composição é responsável por fornecer o `createSignedCustodyPort` e o `createFiscalSchemaRunner` reais; não deve substituir os reports de XSD usados apenas nos testes por um atestado de produção.

O adaptador Web seguro está em `src/gateway.mjs`:

```js
createSignedGateway({fetchImpl, now: Date.now, nonce: () => crypto.randomUUID()})
```

Ele recebe os bindings já existentes: `ALLOWED_ORIGINS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `A1_RUNTIME`, `A1_AUDIENCE`, `A1_TRANSPORT_KEY_ID` e `A1_TRANSPORT_SECRET` (base64 canônico, 32 bytes). Não recebe KEK nem service-role. Encaminha somente ao binding `A1_RUNTIME`, com URL fixa `https://fiscal-runtime.internal/internal/v1/fiscal-signed/...`; a bridge privada transforma a origem para o dispatcher Node. O bundle Web não importa os módulos Node de assinatura, custódia, RPC privado ou XML.

O transporte usa `Brufap-Signed`, domínio HMAC `brufap-signed-request-v1`, audiência `${A1_AUDIENCE}-signed`, ator, nonce, método, caminho, hash exato do corpo e data. A janela é de 60 segundos, admitindo no máximo 5 segundos de adiantamento. A mesma chave física pode servir os protocolos existentes porque domínio e audiência são distintos. **O nonce não é um armazenamento de uso único**: uma entrega pode ser repetida dentro da janela; a idempotência, a autorização renovada e o controle de tentativas são responsabilidade dos comandos e leases da 050.

O handler admite no máximo duas requisições concorrentes e usa prazo de 45 segundos. O gateway tem prazo total de 55 segundos, incluindo Auth com 10 segundos; a leitura de entrada tem 10 segundos. RPC, Storage, custódia e Python devem honrar o sinal e o prazo recebido. Cancelamento descarta respostas tardias, não declara que uma gravação remota foi desfeita.

## Resultado e recuperação

`pending`, `stored` e `failed` trazem o recibo compacto do candidato, hashes de origem/complemento, modelo, versões e metadados do artefato. `a1_version` é a versão histórica do recibo, enquanto `current.a1_version` descreve o estado atual; uma desativação ou troca posterior não reescreve o histórico. `current.artifact_current` é separado da verificação histórica da assinatura e do XSD. Não são publicados identificadores da credencial, fingerprints, referência cifrada, lease, chave fiscal, paths ou bytes XML.

`recoverable` mantém o comando original, `signed: null` e `outcome: "unconfirmed"`. `blocked` usa `signed: false` e `outcome: "not_started"`. Não se infere uma versão histórica de A1 nesses dois estados. Depois de uma falha de transporte após o encaminhamento de `run`, `recovery_required: true` exige consultar ou repetir **o mesmo comando e corpo**; um novo UUID não substitui a tentativa incerta. Um recibo confirmado deve ser seguido de consulta atual antes de apresentar o estado como corrente. As respostas de leitura têm `read_only: true`.

Erros são códigos de uma allowlist, sem mensagens do driver, XML, dados da custódia ou corpo remoto. Todas as respostas usam `no-store`, `nosniff`, CSP restritiva e ausência de referrer. `signature_verified` e `xsd_validated` só são verdadeiros para um candidato persistido que passou pelas verificações locais; `authorized`, `can_emit`, `can_transmit`, `icp_brasil_chain_validated`, `revocation_checked` e `tax_rules_validated` continuam falsos.

## Verificação local

```sh
node --test packages/fiscal-signed-runtime/test/*.test.mjs
BRUFAP_RUN_WORKERD_TESTS=1 node --test packages/fiscal-signed-runtime/test/gateway-workerd.test.mjs
```

Os testes padrão cobrem rotas fechadas, HMAC separado, limites, projeção, recibo versus estado atual, SQL 050 em PGlite com assinatura sintética dos modelos 55 e 65, autorização antes de recuperação, idempotência, concorrência, cancelamento e vazamento de erros. A interoperação do handler usa um report de schema injetado para isolar o transporte; a validação XSD real pertence à suíte do schema runner e à composição do Container. Os testes opcionais workerd compilam o adaptador para ambiente Web e interceptam toda a rede em serviços sintéticos locais, incluindo redirects e sessão anônima. Eles não publicam um Worker.
