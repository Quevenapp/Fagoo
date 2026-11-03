# Orquestrador privado de distribuição de NF-e

Protótipo local, com portas obrigatórias e testes sintéticos. Não há adaptador de credencial operacional, rede padrão, leitura de ambiente, endpoint, agendador ou ativação de coleta. Não emite NF-e/NFC-e nem envia manifestações.

A ativação da coleta exige um coordenador único por escopo fiscal, homologação e checkpoint NSU confirmado com horário. Se outro coletor estiver ativo, o administrador deve coordenar sua pausa antes de liberar este serviço. O pacote não presume NSU inicial zero, não consulta em paralelo e não transfere automaticamente a responsabilidade pela coleta.

## Contrato local

```js
const batch = createDfeBatchOrchestrator({
  rpc, transport, storage, withAuthorizedCredential,
});
const result = await batch.run({
  actor, commandId, channelId, expectedVersion,
}, { signal, deadline });
```

Os identificadores são UUIDs canônicos; a versão é um inteiro positivo. O mesmo comando deve ser preservado em toda recuperação. `deadline` é um instante em milissegundos, até 90 segundos a partir da chamada; o padrão também é 90 segundos. Uma pequena parte desse prazo fica reservada para registrar a incerteza após falha. Cancelamento interrompe a espera local e bloqueia novas etapas.

As portas são internas e confiáveis; nenhuma recebe dados diretamente de um navegador:

| Porta | Contrato obrigatório |
| --- | --- |
| `rpc(name, args, {signal, deadline})` | RPCs `erp_dfe_*` da migração 045. Retornar o JSON direto e preservar SQLSTATE em `error.code`, sem erro bruto em logs. O ator é imposto pelo orquestrador. O adaptador deve limitar resposta, rejeitar redirecionamentos e respeitar o prazo até ler o corpo. |
| `transport.exchange(plan, {secureContext, signal, deadline})` | Plano atestado do pacote `fiscal-dfe-transport`. Retornar `bytes`, `request_hash`, `wire_hash` e `response_hash` consistentes. Uma única tentativa, sem fallback ou retry. |
| `withAuthorizedCredential(context, callback, options)` | Dependência **não implementada** de política/custódia/autorização A1. Deve revalidar ator, empresa, finalidade e destino imediatamente antes do uso; chamar e **aguardar** o callback no máximo uma vez, fornecendo contexto TLS interno e descartando-o depois. O contexto contém comando, canal/versão, identidade/versão, requisição/hash e validade da reserva. Os testes usam somente uma autorização fictícia. O atual cofre de finalidade offline não fornece essa autorização. |
| `storage.putImmutable(input)` | Recebe bucket fixo, chave derivada, cópia de bytes, `contentType:'application/octet-stream'`, `upsert:false`, `ifNoneMatch:'*'`, sinal e prazo. Deve criar somente se ausente; retornar `{status:200|201|409}`. Nunca substituir conteúdo. Deve consumir/copiar os bytes dentro de sua Promise e encerrar o acesso após abortar. |
| `storage.read(input)` | Mesmo bucket/chave/sinal/prazo; retorna `Response` 200 com corpo binário ou `null` se ausente. Sem redirecionamento. MIME exato, codificação ausente ou `identity`, limite de 8 MiB e comprimento declarado coerente. O orquestrador limita o stream e confere SHA-256 quando conhecido. |

Não existe driver remoto neste pacote. Injetar um driver externo é uma integração futura, que exige revisão própria. As flags `can_query`, `can_manifest`, `can_emit` e `operation_authorized` permanecem `false`; elas não substituem uma política operacional nem impedem código externo arbitrário de acessar a rede.

## Ordem e persistência

1. Reservar o comando 045 e conferir canal, contexto, identidade, coordenação e hash da requisição. Uma tentativa ativa por canal e a reserva com token impedem concorrência; o processo também rejeita chamadas simultâneas do mesmo comando.
2. Ler o diário no caminho fixo `responses/<attemptUUID>/<requestHash>.xml`, dentro do bucket privado `brufap-received-dfe`. Um diário em tentativa ainda não despachada é conflito.
3. Somente uma tentativa `reserved`, sem diário, pode passar pela autorização obrigatória e consumir o ticket persistente. Apenas `dispatch_ticket_issued:true` permite chamar o transporte. Perder a resposta do ticket **não** autoriza repetir a consulta.
4. Recebida uma resposta completa de até 8 MiB, conferir hashes de requisição, envelope e bytes. Gravar imediatamente os bytes originais no diário imutável e reler/conferir hash e tamanho **antes de interpretar XML**. XML inválido também fica preservado para revisão, sem avanço de NSU.
5. Interpretar os mesmos bytes pelo parser isolado e atestado. O planner exige a saída real desse parser. Dados desconhecidos ficam em quarentena; resumo, XML completo e evento mantêm tipos distintos. Isso não prova autenticidade, assinatura, autorização fiscal ou conformidade com XSD.
6. Gravar e reler a resposta e cada documento em `objects/<sha256>.xml`. Tamanho/hash devem coincidir. Só então enviar **um manifesto inteiro** à finalização 045, que valida Storage por metadados e atualiza documentos, recibo e cursor na mesma transação. SQL não inspeciona os bytes: a verificação anterior é obrigação desta fronteira privada.

Os limites do parser continuam valendo: até 50 documentos, 8 MiB por resposta/documento, 32 MiB descompactados por lote e limites próprios de gzip/XML. Há no máximo 160 operações de Storage e três renovações locais por execução. Cinquenta documentos distintos usam 105 operações de Storage. O transporte recebe no máximo 20 segundos; o parser, 10, ambos subordinados ao prazo global.

O status 137 preserva o cursor e impõe espera mínima de uma hora. O 656 nunca adota ou reinicia o NSU: gera revisão/pausa e espera mínima de uma hora. Lacunas e outras pendências ficam no recibo. O orquestrador não agenda a próxima consulta, mesmo quando o lote indica documentos adicionais.

## Recuperação e limites de atomicidade

| Situação | Recuperação permitida |
| --- | --- |
| Reserva criada, ticket ainda não consumido | Repetir o mesmo comando; pode obter o ticket uma vez. |
| Ticket consumido, sem diário ou diário conflitante/inválido | Revisão obrigatória. Nunca reenviar a consulta. XML inválido preservado pode ser reinterpretado após uma correção revisada do parser. |
| Diário confirmado, upload de algum objeto falhou | Reabrir a mesma tentativa, reinterpretar os bytes e completar somente arquivos ausentes. Um conflito nunca é sobrescrito. |
| Reserva expirada depois do despacho | Recuperar com novo token e somente leitura/processamento da resposta. O token antigo não finaliza. |
| Finalização confirmada, resposta perdida | Consultar o comando e retornar recibo histórico separado da configuração atual. Se a consulta também falhar, a próxima execução usa o mesmo comando, sem novo envio. |
| Papel ou identidade mudou | RPCs revalidam antes de mutação/replay; não presumir acesso a partir da reserva anterior. |

Storage e Postgres **não** formam uma transação única. Uma queda entre receber os bytes e gravar o diário ainda pode perder a resposta: a tentativa permanece incerta, sem reenvio automático. Arquivos órfãos podem ficar após falhas; este pacote não os apaga. O diário não aparece nas rotas públicas de documentos e não é um XML fiscal completo por definição.

Portas devem respeitar `signal` e `deadline`. Uma RPC já enviada pode ter sido confirmada remotamente mesmo após timeout local; por isso cancelamento não é rollback, e a recuperação mantém o comando/ticket. Callbacks atrasados não iniciam novas etapas. Um adaptador que ignore abort pode concluir sua operação já iniciada; não se deve substituí-lo por uma nova tentativa de consulta.

O diário confia exclusivamente em gravação privada pelo servidor. Seu caminho vincula tentativa e hash da requisição, e os bytes são reinterpretados contra esse contexto; o protocolo de distribuição não inclui uma assinatura do servidor que autentique essa associação. Hashes verificam integridade, não origem SEFAZ.

## Validação local

```sh
node --test packages/fiscal-dfe-orchestrator/test/*.test.mjs
```

Os testes usam PGlite sem `dataDir`, a migração 045 real, dados fictícios, portas de transporte e Storage em memória. Os 30 cenários passaram e incluem integração com a porta HTTP de Storage por driver simulado, além de perda de respostas, conflitos/limites do diário, XML inválido, lote incompleto, ACL/contexto, reserva expirada, ticket concorrente entre duas instâncias, aborto e recuperação sem reenvio. Não cobrem concorrência entre processos PostgreSQL reais ou homologação do serviço SEFAZ.

Referências do contrato: [RPC 045](../../supabase/migrations/202610160045_dfe_distribution.sql), [parser de distribuição](../../packages/fiscal-xml/src/distribution.mjs) e [transporte isolado](../fiscal-dfe-transport/README.md). A estrutura 045 deve estar presente no banco da instalação.
