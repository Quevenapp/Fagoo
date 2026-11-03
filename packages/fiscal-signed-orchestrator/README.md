# Orquestrador privado de candidato assinado

Pacote local que conecta a persistência 050 ao XML unsigned 048, ao signer opaco e ao validador XSD integral. Não contém variáveis de ambiente, cliente HTTP, configuração de rede, leitor de A1, senha, KEK ou transporte SEFAZ. Todas as portas são obrigatórias e explicitamente injetadas. Nenhuma ligação ao runtime de produção é criada por este pacote.

```js
const orchestrator = createSignedFiscalOrchestrator({
  rpc,
  storage: {read, putImmutable},
  withAuthorizedSigner,
  validateXsd,
});
const result = await orchestrator.run({
  actor, commandId, unsignedJobId, unsignedHash, basisHash,
  expectedA1Version,
}, {signal, deadline});
```

O ator vem do chamador autenticado e confiável. UUIDs são strings canônicas minúsculas, hashes são SHA-256 minúsculos e a versão esperada do A1 é um inteiro positivo. A entrada é fechada: não recebe XML, identidade, chave, cNF, série, número, data de emissão, fingerprint, relógio ou caminhos. O prazo total é de no máximo 45 segundos, dentro da lease de 60 segundos da 050; não há renovação ou repetição automática de mutações.

## Portas

- `rpc(name, args, {signal, deadline})`: somente as sete RPCs privadas 050. O orquestrador chama `command`, `begin`, `use`, `finish`, `get` e, em casos determinísticos restritos, `fail`. O ator é colocado pelo orquestrador. A porta `fiscal-signed-rpc` é uma implementação compatível; a chave de serviço nunca passa pelo resultado público.
- `storage.read({bucket,key,signal,deadline})`: retorna `Response` de status 200 e MIME `application/octet-stream`, ou null exclusivamente para ausência comprovada do objeto. `putImmutable` recebe também `bytes`, `contentType`, `upsert:false` e `ifNoneMatch:'*'`. O bucket é sempre `brufap-fiscal-artifacts`, com caminhos fixos `jobs/<uuid>/<sha>.xml` e `candidates/<uuid>/<sha>.xml`. A porta HTTP `fiscal-artifact-storage` suporta esses dois caminhos.
- `withAuthorizedSigner(grant, callback, {signal,deadline})`: abre apenas a credencial cifrada fixada pela autorização privada 050, entrega um signer opaco ao callback e o descarta ao terminar. Não recebe XML ou senha. O callback deste pacote é síncrono e deve ser chamado uma única vez; a porta precisa concluir esse callback antes de retornar `undefined`. Falha, chamada duplicada, chamada tardia e retorno prematuro impedem o prosseguimento.
- `validateXsd(bytes, {expectedModel,expectedHash,signal,deadline})`: valida os bytes finais com o perfil integral `pl010f-v1.04`. A porta `fiscal-schema-runner` é compatível. Um relatório só é aceito com hash, tamanho, modelo, ambiente, manifesto, versão e hash do validador correspondentes, mantendo falsas as afirmações de assinatura, tributação, ICP, revogação e autorização do próprio relatório XSD.

O grant da porta A1 tem exatamente 13 campos, copiados e congelados recursivamente:

```text
actor, command_id, candidate_id, a1_version,
lease_id, lease_until, used_at,
identity, access_key, unsigned_object,
credential_context, credential_metadata, credential_object
```

`credential_object` possui bucket, caminho, hash, tamanho e key_id do envelope cifrado; `credential_context` e `credential_metadata` são os campos exatos da 041. A identidade/chave são as originais 048. Essa projeção é privada: não deve virar resposta de API ou log. Antes de passá-la à porta, o orquestrador confere recibo, lease, objeto, identidade/chave, modelo, ambiente, fingerprint e vínculo de contexto. A porta deve verificar os bytes cifrados, hash, AAD, key_id, contexto e metadata e limpar seus próprios buffers e material de abertura.

O próprio orquestrador também executa `disposeSigner` em `finally`, inclusive quando recebe uma chamada tardia ou duplicada. Isso encerra a capacidade opaca recebida; não prova que uma porta arbitrária descartou cópias internas da chave. A implementação de custódia é parte confiável e revisada do sistema. Não é possível zerar strings imutáveis ou todas as cópias internas do JavaScript; as referências locais ao texto são liberadas e os buffers mantidos pelo pacote são zerados ao concluir.

## Sequência e recuperação

1. Consulta o comando antes de qualquer execução. Um estado terminal devolve histórico e contexto atual, sem nova assinatura. Uma lease ainda vigente devolve `pending`; não é contornada por outro comando.
2. `begin` cria ou retoma explicitamente a intenção; `use` confirma a tentativa, as bases e a seleção A1. Não há troca implícita de certificado ou identidade.
3. Lê os bytes unsigned completos, limitados a 480.000, com SHA-256, tamanho e UTF-8 estrito. Confere identidade e chave contra a autorização persistida.
4. Captura um instante no backend e chama o helper fixo `createSignedHomologationCandidate` durante o callback A1. O helper assina e verifica a referência final; NFC-e recebe o suplemento QR v3 homologado para este perfil. O signer já está descartado quando a etapa XSD começa.
5. Valida o XSD sobre os mesmos bytes finais, limitados a 512.000. Não aceita alteração desses bytes pela porta nem relatório de outro perfil, hash ou modelo.
6. Procura o caminho imutável do candidato. Se ausente, grava uma vez sem upsert e relê integralmente. Uma resposta perdida do PUT só é resolvida por essa leitura exata. Nunca transforma erro de leitura ou acesso negado em ausência.
7. Chama `finish` uma vez, com os três digests e as evidências fixadas, e consulta `get` para obter o estado atual. Se a resposta de `finish` se perder, consulta o mesmo comando e só aceita candidato, hash, tamanho e evidência exatamente iguais aos produzidos.

O limite é de cinco operações de Storage por execução; o percurso normal usa quatro (leitura da origem, busca do candidato, PUT e leitura de conferência). Cada leitura usa um buffer de tamanho previamente limitado, evitando uma lista sem limite de fragmentos. Leitura de cabeçalhos, corpo, RPC, custódia e XSD compartilham cancelamento/prazo. Respostas tardias não iniciam a etapa seguinte. O callback criptográfico síncrono tem tamanho e chave limitados; ele não pode ser interrompido no meio por um timer do JavaScript, portanto os checks de prazo ocorrem imediatamente antes e depois, impedindo I/O posterior fora do prazo.

Apenas uma rejeição XSD completa e corretamente vinculada, ou um XML unsigned estruturalmente inválido após a conferência do hash, chama `fail`. Erro de processo, cofre, porta, timeout, aborto, evidência inválida ou resposta perdida preserva a tentativa recuperável. A recuperação conserva o corpo e a UUID do comando. Se até a consulta inicial do comando falhar, o resultado é `recoverable`/`unconfirmed`: essa falha não prova que uma execução anterior deixou de confirmar.

## Resultado seguro

Os estados são `pending`, `stored`, `failed`, `recoverable` ou `blocked`. O resultado projeta IDs operacionais de comando/candidato/job, modelo, versões, hashes de conteúdo, tamanho do artefato, código fixo de erro e contexto atual. `a1_version` no topo é a versão histórica do recibo; `current.a1_version` pode indicar uma seleção posterior. Não retorna XML, identidade, CNPJ, chave de acesso, lease, UUID de credencial, fingerprint do certificado, caminho cifrado ou key_id.

`signed`, `signature_verified` e `xsd_validated` só ficam verdadeiros para o artefato `stored` confirmado na 050. Quando o resultado é incerto, `signed:null` não é apresentado como confirmação ou rollback. `can_emit`, `can_transmit`, `authorized`, `tax_rules_validated`, `icp_brasil_chain_validated`, `revocation_checked`, `financial_mutation_performed` e `stock_mutation_performed` permanecem falsos em todos os estados. Um histórico confirmado com `current.artifact_current:false` continua histórico, sem prontidão operacional.

## Testes

```sh
node --test packages/fiscal-signed-orchestrator/test/*.test.mjs
```

Os testes usam PGlite com as migrações reais 048/041/050, certificados RSA efêmeros fictícios e Storage em memória. Cobrem ambos os modelos, perda de ACK em begin/PUT/finish, lease e replay, invalidação A1, descarte de signer, callback tardio/duplicado, corpo interrompido, timeout, abortos após commit, evidência adulterada e ausência de confiança promovida. A interoperabilidade adicional percorre as portas RPC e Storage HTTP reais com `fetchImpl` inteiramente sintético.

A maioria dos testes usa um relatório XSD explicitamente simulado para isolar a coordenação e as falhas; não afirma validação estrutural por esse stub. O teste `tools/migration/test_signed_candidates_interop.mjs` executa separadamente a assinatura e o XSD integral em Docker sem rede para NF-e/NFC-e fictícias. A 050 também possui ensaios próprios PGlite e PostgreSQL concorrente. Nenhum teste acessa o A1 instalado, serviços de produção ou a SEFAZ.

O teste opcional abaixo percorre toda a coordenação com a 050 real em memória, reserva/finalização 041, PFX sintético cifrado, loader OpenSSL, porta de custódia real, assinatura NFC-e, QR e XSD integral. Ele exige a imagem local `brufap-fiscal-schema-test:local` já preparada conforme o pacote `fiscal-schema-runner`; o contêiner roda sem rede e com filesystem somente leitura. Se habilitado e indisponível, falha explicitamente em vez de substituir o validador por um stub.

```sh
BRUFAP_SIGNED_FULL_OFFLINE_TEST=1 \
BRUFAP_DOCKER_BIN=/caminho/absoluto/docker \
node --test packages/fiscal-signed-orchestrator/test/full-offline.test.mjs
```

Validação local: 18 testes padrão aprovados, com esse teste omitido por padrão; o teste integral também passou quando habilitado. O replay confirmou o mesmo candidato sem abrir novamente a credencial nem repetir a validação, e os handles e buffers controlados foram descartados.

Permanecem fora deste pacote: autorização operacional de uso do A1, confiança ICP/revogação, regras tributárias completas, envio, consulta SEFAZ, protocolo de autorização e interface pública. Um candidato assinado estruturalmente válido ainda não é uma nota emitida.
