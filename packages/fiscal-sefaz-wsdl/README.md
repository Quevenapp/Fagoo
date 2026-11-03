# Evidência WSDL da SEFAZ-SP

Pacote privado e isolado para obter e inspecionar WSDLs de homologação por GET. Não tem rede padrão, variáveis de ambiente, abertura própria de cofre, rota HTTP ou ativação em produção. O cliente original e o serviço privado opcional051 abaixo têm entradas separadas. Os testes usam respostas e certificados fictícios. Nenhum A1 da empresa foi utilizado neste trabalho.

```js
import {prepareWsdlRequest, createWsdlEvidenceClient} from './src/index.mjs';

const client = createWsdlEvidenceClient({requestImpl, withAuthorizedTlsSession});
const plan = prepareWsdlRequest({
  model: '55', operation: 'protocol', requestId: 'id-interno',
});
const evidence = await client.obtain(plan, {signal, deadline});
```

Modelo, operação e identificador interno são os únicos campos do plano. As operações são `protocol`, `status`, `authorization` e `receipt`; até a operação chamada `authorization` faz **somente GET do WSDL**, sem enviar nota. Endpoint, método, headers, SNI, porta e query são derivados. Um plano é atestado no processo e pode ser consumido uma única vez por cliente. Recriar um plano não autoriza repetir uma operação externa nem substitui um comando persistente.

`requestImpl` é uma dependência obrigatória, com a assinatura de `node:https.request`. O pacote nunca importa esse driver padrão. O driver é uma fronteira confiável: deve preservar as opções de segurança e o destino recebidos. Testes de eventos podem simulá-lo; isso não comprova uma conexão real com a SEFAZ.

`withAuthorizedTlsSession(context, action, {signal, deadline})` também é obrigatória. `context` contém exatamente `purpose:'sefaz-sp-wsdl-readonly-v1'`, `environment:'2'`, `model`, `operation`, `request_id`, `method:'GET'`, `endpoint` com `?WSDL` e `deadline` em milissegundos. A porta deve capturar o ator e a autorização específica fora deste objeto, conferir empresa/A1/destino/finalidade atuais e consumir a autorização antes de chamar `action(SecureContext)`. Deve chamar uma única vez, **aguardar a Promise**, encerrar os recursos e descartar o material antes de resolver. Seu valor de retorno é ignorado. O contexto não é um token autônomo e não deve vir de JSON do navegador. O cliente não chama SQL; o serviço opcional abaixo implementa a ligação privada051.

O callback é assíncrono porque engloba TLS e a leitura; é diferente do callback síncrono da assinatura 050. O pacote recusa callback ausente, duplicado, tardio ou não aguardado. Cancelamento não autoriza retry e nenhuma resposta é entregue antes de a porta finalizar. A implantação futura deve revisar expressamente essa finalidade: o `purpose='offline-homologation'` e o AAD do envelope 041 não são alterados ou promovidos pelo pacote.

## Transporte e inspeção

- Prazo global padrão de 20 segundos, máximo de 30, incluindo espera da porta TLS, handshake, headers, corpo e parser. Um aborto encerra os sockets e a espera; uma porta que ignora o sinal não pode iniciar trabalho tardio pelo callback.
- TLS 1.2/1.3, `rejectUnauthorized:true`, `checkServerIdentity` nativo, SNI fixo, sem agente global, proxy, sessão TLS reutilizada ou retry. O GET só é encerrado depois de `secureConnect` autorizado.
- Resposta HTTP 200, XML UTF-8, sem compressão; headers até 16 KiB e corpo até 512.000 bytes. Tamanho declarado, corpo completo, headers críticos duplicados e representações divergentes são conferidos. Redirecionamentos são recusados sem follow-up.
- DTD, entidades declaradas, CDATA e processing instructions extras são recusados antes do DOM. Comentários inertes são aceitos e ignorados. Há limites de profundidade, nós, atributos e tempo. XML malformado ou que exceda esses limites não produz evidência aceita.
- A interpretação suportada é WSDL 1.1 com bindings SOAP 1.1 e 1.2 Document/Literal, referências locais e endereço idêntico ao serviço fixado. Ela retorna `inspection_status:'supported'`, `code:null`, namespace, bindings e endereços. Isso não equivale a binding revisado.
- XML seguro com imports/includes, headers SOAP, bindings encoded/RPC, endereços diferentes ou estrutura fora do subconjunto retorna `inspection_status:'unsupported'`, código fixo e `target_namespace`, `bindings`, `addresses` nulos. Os bytes originais e seu hash continuam disponíveis **privadamente** para revisão. Nenhuma dependência ou URL do documento é buscada. Não é um validador completo do schema WSDL.

O resultado é **privado**: inclui cópia dos bytes originais, hash SHA-256, tamanho, horário de recebimento, protocolo TLS observado no socket autorizado e inspeção suportada/não suportada. A indicação TLS depende do driver confiável e não afirma validação da credencial cliente, revogação ou autorização fiscal. O chamador passa a ser dono dos bytes e deve persistir com controles próprios ou zerá-los. Não há armazenamento automático. Erros contêm apenas códigos fixos, sem URL arbitrária, certificado, corpo remoto ou texto do driver.

`binding_verified`, `operation_authorized`, `can_query`, `can_emit`, `can_transmit` e `sefaz_authorized` permanecem falsos. Um HTTP 200 ou a extração de uma `soapAction` não torna o contrato revisado. A evidência demanda revisão humana e teste do contrato antes de qualquer transporte SOAP posterior.

## Testes

```sh
node --test packages/fiscal-sefaz-wsdl/test/*.test.mjs
BRUFAP_WSDL_LOOPBACK_TEST=1 node --test packages/fiscal-sefaz-wsdl/test/loopback-mtls.test.mjs
```

O primeiro comando não abre sockets. O segundo requer permissão local para escutar em `127.0.0.1`; o único driver substitui o destino pelo loopback, preservando SNI e a checagem de hostname. O teste usa certificados efêmeros fictícios e cobre mTLS válido, cliente ausente, CA incorreta e hostname incorreto. Não faz DNS externo nem consulta a SEFAZ. O parser reutiliza a dependência `@xmldom/xmldom` já fixada em `packages/fiscal-xml`; não houve mudança de lockfile.

Fontes, alvos e limites de publicação estão no [contrato de evidência](../../docs/integrations/sefaz-sp-wsdl-evidence.md).

## Serviço privado051, sem ligação automática ao runtime

Entradas diretas, sem alteração do `index.mjs` ou dos exports globais:

```js
import {createWsdlRpc} from './src/service-rpc.mjs';
import {createWsdlService, createWsdlPreparationAuthorizer} from './src/service.mjs';

const rpc = createWsdlRpc({projectUrl, serviceKey, fetchImpl});
const authorizePreparation = createWsdlPreparationAuthorizer({rpc});
// A composição do servidor fornece withPreparedTlsSession e usa authorizePreparation
// antes de abrir qualquer envelope. Não há loader/KEK/certificado padrão aqui.
const service = createWsdlService({rpc, storage, requestImpl, withPreparedTlsSession});
await service.run({actor, commandId, model, operation,
  expectedA1Version, expectedIdentityVersion, confirmed:true}, {signal, deadline});
await service.command({actor, commandId}, {signal, deadline});
```

`actor` vem de sessão verificada pelo servidor. `run` captura o corpo antes do primeiro await, consulta o comando, prepara ou recupera somente a mesma tentativa ainda não consumida e cria um plano fixo atestado. Um comando já consumido ou terminal retorna a consulta; não cria outro plano de GET executável. Não há scheduler, POST ao montar uma tela, alteração de contexto/AAD041, SOAP ou SEFAZ padrão.

Portas obrigatórias:

- `rpc(name,args,{signal,deadline})`: somente as cinco RPCs051. O adaptador HTTP tem destino Supabase fixo, corpo16KiB, resposta128KiB, erro8KiB, UTF-8 fatal, JSON estrito, redirecionamento/encoding recusados e SQLSTATE fechado. Não inclui corpo, chave de serviço ou mensagem PostgreSQL em erros.
- `withPreparedTlsSession({actor,execution,context},action,{signal,deadline})`: autoriza novamente a preparação atual **antes** de buscar/abrir o envelope; pode usar `createWsdlPreparationAuthorizer`. Esse helper repete `begin` com a mesma UUID e argumentos derivados da captura, exige `replayed:true`, estado preparado e `execution` integralmente idêntica. Não consome `use`.
- O callback da custódia entrega `{secureContext,metadata,signal,deadline}` temporários. O serviço confere fingerprint/CNPJ/período contra a metadata041 capturada, adequação declarada do loader ao uso TLS e flags falsas. Chama `use` uma única vez, compara todos os campos do grant e só então entrega o contexto ao GET fixo. A custódia deve aguardar a Promise e limpar o material antes de resolver; não pode conservar o contexto TLS.
- `storage.read({bucket,key,signal,deadline})` retorna `Response` binária ou null para ausência confirmada; `storage.putImmutable({bucket,key,bytes,contentType,upsert:false,ifNoneMatch:'*',signal,deadline})` retorna `{status:200|201|409,requires_readback:true}`. O bucket é sempre `brufap-fiscal-artifacts`; caminho `wsdl/<attemptUUID>/<sha256>.xml`. A porta real deve preservar a ausência de overwrite e copiar os bytes antes de awaits. O serviço relê e confere tamanho/SHA-256 antes de `finish`, inclusive se a resposta do PUT se perde.

O prazo total é45s no máximo. Aquisição de contexto/TLS/GET recebe no máximo30s, nunca além da lease restante, e deixa pelo menos1s do orçamento total para finalização. Esse1s é margem mínima, não garantia de conclusão: falta de tempo deixa estado recuperável e impede finalizar após cancelamento. Todas as portas são limitadas também por corrida com deadline/abort, inclusive se uma implementação sintética ignorar o sinal. Callback tardio, duplicado, não aguardado ou referência divergente não pode produzir outro GET. O runtime que encapsula os ports continua responsável por efetivamente abortar I/O, fechar sockets e limpar o contexto nativo.

Os bytes retornados pelo cliente são copiados, novamente inspecionados, persistidos sem upsert e relidos por hash. Dados suportados e estruturas seguras não suportadas conservam os originais; campos extraídos não são inventados em `unsupported`. A evidência do cliente é `client_chain:'not_evaluated'`, `client_profile:'compatible'` e `revocation:'unknown_offline'` neste recorte. Um perfil de confiança adicional precisa composição explícita; não é deduzido de uma conexão TLS bem-sucedida.

### Resultado e recuperação

O resultado compacto sempre contém flags051 falsas, `status`, `command_id`, `recovery_required`, `read_only`, `recovered`, `failure_code`, `receipt`, `current`, `error_code` e `artifact`. `status` pode ser `unconfirmed` quando a consulta de recuperação não pôde confirmar o resultado; nesse caso `current` disponível é apenas a última observação, não prova da ausência de execução. Se `finish` já respondeu e hash, tamanho e evidência foram validados, seu ACK comprova `stored`: uma falha posterior de consulta conserva esse resultado com `recovered:true`. O `current` continua sendo o último snapshot SQL confirmado, como em qualquer leitura; a interface pode atualizá-lo por consulta normal. Se o ACK de `finish` se perdeu e a consulta também falha, o resultado permanece `unconfirmed`. Artefato público contém só `{sha256,size_bytes,inspection_status,inspection_code,created_at}`. Não retorna `execution`, evidência completa, certificado, fingerprint, CNPJ, XML, contexto TLS, nonce, leaseID ou caminho privado. `SERVICE_FAILURE_CODES`, em `src/service-errors.mjs`, é uma allowlist Web-safe para a projeção da futura API.

`command` só consulta. `run` após consumo nunca repete `use`, custódia ou GET. Resposta perdida de `use` deixa consulta pendente/consumida, mesmo que nenhum handshake tenha ocorrido. Resposta perdida de `finish` consulta o comando e só aceita `stored` se tentativa, recibo, hash, tamanho e evidência correspondem à captura daquela execução. Falha de leitura após ACK não repete a escrita.

Depois de uma falha encerrada de aquisição/custódia ou Storage, o serviço consulta primeiro o comando. Apenas se a mesma tentativa continuar aberta e não houver `finish` enviado, pode registrar `fail`: antes do consumo, `failed`; depois, `uncertain`. Não transforma resposta perdida de `begin`, `use` ou `finish` em prova de falha, não substitui `stored` e não faz RPC extra após aborto. `42501` confirmado na recuperação mantém classificação fechada de acesso negado, sem detalhes privados.

Não existe diário de resposta persistente neste serviço. Se o processo morrer depois do consumo e antes de armazenar/concluir, a recuperação não sabe se o servidor recebeu o GET e não reenvia. Objeto privado órfão não é autorização para consultar novamente. Nova consulta exige outra intenção explicitamente confirmada; um diário futuro, se implementado, deverá ter seu próprio contrato de persistência e integridade.

Os testes `service.test.mjs` e `service-rpc.test.mjs` usam PGlite051 real, RPC/Storage e driver HTTPS sintéticos. Cobrem modelos55/65, uso antes do driver, respostas perdidas, Storage divergente, falhas de parser, replay sem GET, cancelamento, callbacks indevidos, captura de argumentos e erros fechados. Não comprovam conexão com a SEFAZ ou corridas PostgreSQL multissessão.
