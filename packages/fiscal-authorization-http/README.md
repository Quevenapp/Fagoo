# Fronteira HTTP isolada da autorização fiscal

Este pacote adapta o serviço local 064 a cinco operações HTTP. Está preparado e testado localmente, sem montagem em Worker, gateway, servidor ou interface publicada. Não fornece sessão, HMAC, credenciais, rede, certificado ou autorização SEFAZ.

`createAuthorizationHttpBoundary({service})`, em `src/handler.mjs`, recebe exatamente as cinco funções do serviço 064 e retorna `(request, {actor, signal?, deadline?}) => Promise<Response>`. A futura composição autenticada é a única responsável por fornecer `actor`. Cabeçalhos e corpo não podem fornecer ou substituir esse ator. A fábrica **não autentica uma sessão nem verifica HMAC**; não deve ser exposta diretamente na rede.

Antes de qualquer montagem pública, a composição deverá validar sessão, permissões, origem e um domínio HMAC próprio, vinculando ator, método, caminho e hash dos bytes. O domínio de protocolo 062 não concede autorização para esta vertical. O serviço e as RPCs continuam responsáveis pela ACL atual; nenhum papel é inferido de um UUID válido.

## Operações

Prefixo fixo: `/v1/fiscal-authorization`.

| Método e caminho | Corpo exato | Serviço |
| --- | --- | --- |
| POST `/preview` | `{candidate_id, signed_hash}` | `preview({actor, candidateId, signedHash}, options)` |
| POST `/run` | `{command_id, candidate_id, signed_hash, expected_identity_version, expected_a1_version, expected_policy_version, confirmed:true}` | Nunca chamado neste lote |
| POST `/recover` | `{command_id}` | `recover({actor, commandId}, options)` |
| GET `/commands/:commandId` | Vazio | `command({actor, commandId}, options)` |
| POST `/candidates/:candidateId/history` | `{limit, before}` | `history({actor, candidateId, limit, before}, options)` |

UUIDs usam representação canônica minúscula. Hashes são SHA-256 hexadecimal minúsculo. Versões são inteiros positivos até `2147483647`. `limit` aceita 1–25; `before` é `null` ou string decimal positiva canônica com até 15 dígitos. Não há conversão de cursor para `Number`. Queries, campos extras, parâmetros opcionais não declarados e métodos alternativos são recusados.

`run` valida o corpo e retorna sempre **503 `AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE`**, com `recovery_required:false` e o mesmo `command_id`. Isso vale inclusive quando a porta injetada é um serviço sintético habilitado. Não existe opção da fábrica para habilitar envio; ela nunca chama `service.run`.

Prévia, leitura e recuperação não dependem da opção de envio do serviço. A prévia mantém `can_prepare:false`, as verificações de assinatura e certificado declaradas pelo serviço e `operational_binding_available:false`. A recuperação trabalha com o comando existente e seus objetos imutáveis. Ela não cria outro comando, não repete automaticamente uma chamada e não reutiliza uma concessão WSDL ou de protocolo.

## Captura, limites e respostas

Ator, contexto, operação, cabeçalhos e referências dos métodos são capturados antes do primeiro `await`. Objetos de configuração/contexto exigem propriedades de dados próprias, sem getters, símbolos ou protótipos personalizados. O corpo é copiado durante leitura limitada e zerado no `finally`. Cada chamada recebe um sinal derivado e prazo capturados; cancelamento externo também interrompe a espera quando uma porta ignora o sinal. Uma resposta tardia não é entregue ao chamador.

O corpo aceita no máximo 4 KiB, `application/json` com charset UTF-8 opcional, decodificação UTF-8 fatal e conteúdo sem compressão. A leitura tem no máximo 10 segundos, dentro do prazo total de até 45 segundos, limitado também pelo prazo recebido. Tamanho declarado e real devem coincidir; fluxo inválido, abortado ou excedido é cancelado. Chunks vazios são recusados para evitar uma sequência sem progresso. GET não aceita corpo.

A resposta inteira tem limite de 128 KiB, com `Cache-Control: no-store`, `Pragma: no-cache`, `nosniff`, CSP sem conteúdo e política de referência `no-referrer`. `dto.mjs` copia apenas JSON limitado, recusa campos desconhecidos e valida relações entre captura histórica, estado atual, evidência compacta e comando solicitado. Não devolve XML, chave fiscal, CNPJ, certificado, envelope, caminhos de Storage, lease, nonce ou contexto privado.

`receipt` permanece histórico; `current` pode indicar A1, identidade ou política alterados. `origin` deve ser explicitamente `synthetic` ou `operational`: não existe fallback. Evidência sintética pode ter estado `authorization_observed`, mas não `authorized_homologation` ou origem TLS verificada. Todos os flags de emissão, transmissão, valor fiscal, estoque, financeiro e repetição de envio continuam falsos, conforme o contrato 064. Uma evidência operacional futura poderá ser lida somente se já corresponder ao contrato do serviço; esta fronteira não pode produzi-la.

Histórico mantém ordem estritamente decrescente por `ordinal`, candidato fixo, comandos/tentativas sem duplicatas e cursor compatível com a página. `recoverable_by_actor` nunca é verdadeiro sem consumo e recuperação pendente. Histórico não prova que o ator possa consultar o comando de outro usuário; a RPC continua autorizando cada leitura.

Erros de SQL usam uma lista fechada: autorização 403, conflito 409, ausência 404 e entrada inválida 400. Texto da exceção, corpo de provedor e getters de erros não são expostos. Falha ou cancelamento após despachar `recover` mantém `recovery_required:true` e o mesmo UUID, inclusive quando a resposta é 403/409; isso não autoriza repetir envio. Uma leitura malsucedida não recebe esse marcador. Resultados `unconfirmed` retornados validamente pelo serviço conservam o recibo conhecido e a necessidade de consulta/recuperação explícita.

## Verificação local

```sh
node --test --test-concurrency=1 packages/fiscal-authorization-http/test/*.test.mjs
```

Os 17 testes cobrem sintaxe, captura antes de espera, aborto, tamanho, UTF-8, cancelamento de stream, fechamento do DTO, erro sanitizado, precisão do cursor, histórico de 25 entradas e envio sempre bloqueado. A interoperabilidade usa uma PGlite sequencial, certificado gerado sinteticamente, Storage em memória e o validador Python/XSD já usado pelo serviço 064. Prova NF-e 55 e NFC-e 65, perda do ACK de `use`, recuperação após mudanças de A1/política/lease e acesso negado a outro ator, sem nova custódia ou transporte.

A fixture exige Python com lxml conforme o pacote `fiscal-authorization`; `BRUFAP_TEST_PYTHON` pode apontar o runtime local. Ausência dessa dependência falha explicitamente. Nenhum teste acessa certificados reais, usa sockets, aplica migrações remotas ou consulta a SEFAZ.
