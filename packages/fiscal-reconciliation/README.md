# Reconciliação fiscal vinculada à candidata 050

Implementação local com dois perfis separados: o sintético 061 e o operacional 062, **desligado por padrão**. Este pacote não ativa consultas nem publica infraestrutura. Os testes usam somente certificados e transportes sintéticos. Todas as saídas mantêm `operation_authorized`, `can_query`, `can_emit`, `can_transmit` e `sefaz_authorized` falsos. Um protocolo com código 100/150 é uma observação estrutural, não autorização fiscal.

## Portas e uso interno

`createReconciliationService({mode:'synthetic'|'operational',enabled:false,rpc,storage,validateProtocol,withPreparedSession,transport})` em `src/service.mjs` devolve `run`, `command`, `history` e `recover`. Todas as portas são obrigatórias. Não existe fetch, segredo, ambiente, certificado ou scheduler padrão. No modo operacional, `run` exige `enabled:true`; sem isso lança `RECONCILIATION_DISABLED` antes de qualquer IO. Essa opção é configuração privada do servidor, nunca entrada do navegador. `command`, `history` e `recover` continuam disponíveis com a execução desligada.

```text
run = {actor,commandId,candidateId,signedHash,
       expectedIdentityVersion,expectedA1Version,confirmed:true}
command/recover = {actor,commandId}
history = {actor,candidateId,limit,before}
```

O ator vem de autenticação do servidor futuro. A entrada não recebe chave, URL, XML, status, origem remota nem atestação do navegador. O banco deriva esses vínculos da candidata 050 e identidade 048. O A1 atual capturado para uma possível sessão é separado do A1 histórico que assinou a candidata. Mudança comercial posterior não reescreve os bytes históricos nem bloqueia sua reconciliação.

- `rpc(name,args,{signal,deadline})`: seis RPCs por perfil (`erp_fiscal_reconciliation_*` da 061 ou `erp_fiscal_protocol_*` da 062), validadas novamente pelo serviço. `src/rpc.mjs` fornece adaptador HTTP com projeto/chave/driver obrigatórios, limites de 16 KiB na entrada, 128 KiB na resposta e 8 KiB no erro e SQLSTATE fechado. Não possui configuração real.
- `storage.read({bucket,key,signal,deadline})` retorna `Response` limitada ou `null` para ausência comprovada. `putImmutable` recebe também `bytes,sha256,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*'`. ACK é apenas indicação para leitura de conferência. `src/storage.mjs` é a porta HTTP isolada, sem alterar a porta 048/050/051.
- `validateProtocol(bytes,{expectedModel,expectedAccessKey,expectedReferenceDigest,expectedHash,direction,signal,deadline})` usa o novo runner Node em `fiscal-schema-runner/src/protocol.mjs`. O perfil de protocolo e seus hashes são separados do XSD da nota.
- `withPreparedSession({actor,execution,context},action,{signal,deadline})` deve chamar e aguardar `action(session)` exatamente uma vez. O serviço repete begin imediatamente antes da preparação e exige execution idêntica. Para 062, a custódia específica de protocolo reautoriza por `createProtocolPreparationAuthorizer({rpc})` antes de abrir o envelope A1; preserva o AAD histórico e entrega apenas SecureContext, metadados mínimos e escopo. Essa preparação não consome grant: somente o serviço executa use, imediatamente antes do transporte.
- `transport({request,grant},session,{signal,deadline})` recebe o plano local atestado de `prepareReviewedProtocolSoap` e o grant de uso único do perfil correspondente. Em 061 devolve `Response`. Em 062 devolve `{response,tls}`; `createProtocolTransport({requestImpl})` fornece o transporte Node com driver obrigatório, destinos SP fixos e SOAP 1.2. Exige contexto de confiança do loader específico, aguarda TLS autorizado antes de escrever o corpo e fecha socket/agente após a leitura limitada. Não há redirecionamento, fallback de SOAP nem retry. Grant WSDL ou sintético não é aceito.

As portas e sua injeção são uma fronteira interna confiável. WeakSets do builder, hashes de XML e flags false não autenticam um operador nem criam isolamento de rede. O processo Python usa schemas locais e proíbe resolução de rede; o pacote não é um sandbox de sistema operacional.

## Persistência e recuperação

1. Consulta o comando; um comando já consumido jamais volta à preparação/TLS/transporte.
2. Valida hash/tamanho da candidata assinada e monta o request pelo binding SP revisado. Valida `consSitNFe` no XSD próprio.
3. Grava e relê request imutável. Reautoriza preparação via begin idempotente. Consome use do perfil correspondente imediatamente antes da única chamada de transporte.
4. Lê toda a resposta limitada; grava e relê **bytes originais antes do parser**, inclusive XML inválido ou SOAP Fault.
5. Em 062, grava e relê também um recibo de transporte privado: modelo/endpoint fixos, tentativa, hashes/tamanho, identidade TLS observada e fingerprint do certificado. Só então extrai o payload, valida XSD/contexto/digest e registra observação validada ou rejeitada. Nunca promove eventos/cancelamento/autorizações.
6. Finaliza e consulta comando. ACK perdido recupera por leitura. ACK finish confirmado, acompanhado de bytes novamente conferidos, também sustenta recibo stored se a consulta seguinte falhar.

Bucket fixo `brufap-fiscal-artifacts`; somente leitura da candidata 050 e estes caminhos novos:

```text
candidates/<candidateUUID>/<signedHash>.xml          (somente leitura)
reconciliation/<attemptUUID>/requests/<requestHash>.xml
reconciliation/<attemptUUID>/responses/<requestHash>.xml
reconciliation/<attemptUUID>/observations/<requestHash>.json (somente 062; até 8 KiB)
```

O nome do diário de resposta é derivado da tentativa e request; **requestHash e responseHash são diferentes**. Isso permite recuperar sem listar objetos e sem precisar conhecer previamente o hash da resposta. A porta valida hash do corpo antes de cada PUT; request/candidata conferem também o hash do nome. Na resposta, o serviço calcula o hash dos bytes lidos e compara com o ACK/recibo quando disponível. Nenhum PUT sobrescreve objeto existente; bytes divergentes encontrados após um PUT perdido são conflito.

Ausência/conflito do diário depois de use mantém incerteza, nunca reenvia. Em 062, resposta sem recibo de transporte íntegro também permanece incerta; não se reconstrói prova TLS a partir do XML. O recibo JSON deve ter bytes canônicos e vínculos exatos com request, resposta e tentativa. Falha de parser preserva o diário. Falha de infraestrutura do validador mantém recuperação; não afirma que o XML é inválido. Reprocessamento do diário não abre A1 nem chama transporte. Estado `failed_before_dispatch` nunca pode receber artefato externo. `uncertain` só pode virar `stored` com marca de dispatch e vínculos imutáveis.

A recuperação por finish é permitida após lease expirada ou A1 alterado/desativado: exige ACL atual, mesmo emitente, request persistido e diário completo. Não é renovação da autorização de transporte. Novos comandos permanecem ações explícitas; a interface deve distinguir consulta de comando de uma nova consulta externa. `recover` recebe somente commandId, consulta os vínculos privados e processa os diários existentes. Nunca executa begin, use, custódia ou transporte, inclusive quando encontra uma tentativa ainda prepared. `recoverable_by_actor` é derivado pelo SQL; histórico de outro operador não concede recuperação de seu comando.

## Limites e afirmações

Operação de 45 s; preparação/transporte até 20 s e nunca além da lease, reservando 15 s para armazenamento/validação/finalização. Runner até 10 s dentro do prazo recebido. XMLs e envelopes até 512.000 bytes. Cancelamento/dispose de escopo impede novos passos e finish; resposta atrasada é cancelada e ignorada. Resultado incerto não significa que nada foi enviado. Buffers próprios são copiados e zerados na conclusão, sem prometer apagar cópias internas do runtime ou de um driver.

`stored` significa evidência íntegra armazenada. `outcome:'validated'` refere-se apenas ao payload estrutural/contextual. `outcome:'rejected'` guarda resposta original com código fechado, sem motivo/PII/XML na projeção compacta. A origem global identifica o perfil (`synthetic` ou `operational`), sem antecipar o resultado de rede. Somente o artefato 062 concluído contém `tls_origin_verified:true`, apoiado pelo recibo privado de transporte e pelos bytes lidos. Isso não é assinatura de protocolo, autorização fiscal, validação ICP-Brasil do certificado cliente nem prova de publicação atual de LCR. Recibos 061 continuam sintéticos, sem promoção ou reprocessamento contra o novo perfil.

`recovery` e `execution` são DTOs **privados**, com chave/emitente/referências cifradas e lease; não podem ser respostas de HTTP público. `result()` omite esses campos, protocolo detalhado e bytes. O campo `current` é a última leitura confirmada, não uma promessa de estado contínuo. Histórico não é reavaliado como se tivesse sido produzido com bases atuais.

## Testes

```sh
node --test --test-concurrency=1 packages/fiscal-reconciliation/test/*.test.mjs
node --test packages/fiscal-schema-runner/test/protocol.test.mjs
BRUFAP_PROTOCOL_PYTHON=/caminho/absoluto/python3 node --test packages/fiscal-schema-runner/test/protocol-process.test.mjs packages/fiscal-reconciliation/test/ports.test.mjs
```

Fixtures são exclusivamente sintéticas. O teste opt-in usa Python/lxml local e o processo real com entrada por stdin. Os testes de custódia 062 abrem apenas PFX gerado pela própria fixture, com driver HTTPS em memória; não usam A1 real nem rede externa. SQL 050 da fixture registra evidência sintética para construir as relações; isso não é assinatura ou origem bancária/fiscal real.

Contratos: [RPC sintético 061](../../supabase/migrations/202610160061_fiscal_reconciliation.sql), [extensão operacional 062](../../supabase/migrations/202610160062_fiscal_protocol_operational.sql) e [handler do runtime](../fiscal-reconciliation-runtime/src/handler.mjs).

Na entrega original 061, a rodada local passou 36/36 casos, incluindo o Python real. Esses números descrevem a base sintética, não substituem as regressões operacionais 062. O checker `tools/migration/check_fiscal_reconciliation_postgres.mjs` passou 22 corridas em PostgreSQL 17 multissessão com espera de lock observada. Usa apenas a imagem já disponível (`--pull=never`), container de nome aleatório, rede desligada, 256 MiB, tmpfs e cleanup em finally. Nos modelos 55/65 foram registrados 26 comandos sintéticos, 12 consumos e 8 artefatos, mantendo as 2 reservas/2 candidatas do fixture e zero títulos/movimentos de estoque. Não lê certificados; os metadados de assinatura usados para construir a fixture SQL são fictícios.

A regressão de prazo cobre a janela após o consumo do grant e antes do microtask do transporte: o prazo TLS é rechecado no ponto de envio, o driver não inicia com sinal vencido e a recuperação não obtém outro grant.

A extensão 062 passou 48/48 testes do pacote com Python real e mais 2/2 testes leves do sidecar. O checker operacional separado `tools/migration/check_fiscal_protocol_postgres.mjs` passou 22 corridas reais de PostgreSQL, usando exclusivamente metadados sintéticos e sem transporte TLS. O container descartável foi removido. As operações persistidas são definidas na [estrutura SQL 062](../../supabase/migrations/202610160062_fiscal_protocol_operational.sql).
