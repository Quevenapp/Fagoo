# Porta privada de Storage para os lotes recebidos

Adaptador interno ainda sem integração com o produto ou implantação. Recebe explicitamente URL de projeto, chave de serviço e implementação de `fetch`; não lê variáveis de ambiente, arquivos privados, cofre ou credenciais do navegador. Os testes usam respostas em memória e não acessam o Supabase.

```js
const storage = createDfeStorage({ projectUrl, serviceKey, fetchImpl });
// Dependências fornecidas apenas por um futuro runtime de servidor autorizado.
await storage.putImmutable({
  bucket: 'brufap-received-dfe', key, bytes,
  contentType: 'application/octet-stream', upsert: false, ifNoneMatch: '*',
  signal, deadline,
});
const response = await storage.read({ bucket: 'brufap-received-dfe', key, signal, deadline });
```

O contrato encaixa nas portas `putImmutable` e `read` do orquestrador isolado. Apenas dois formatos de caminho são admitidos: `objects/<sha256>.xml` e `responses/<attempt_uuid>/<request_sha256>.xml`. O primeiro é conferido contra o hash dos bytes enviados e recebidos. O segundo preserva a resposta original de uma tentativa, cuja identidade vem da reserva 045; o hash no caminho é o da requisição e não o da resposta. O orquestrador continua responsável por conferir a resposta e vincular seu conteúdo ao contexto e ao manifesto.

O upload usa `POST`, `x-upsert:false` e `If-None-Match:*`, sem método de atualização, exclusão, URL assinada ou publicação. A garantia de não sobrescrever depende do comportamento do Storage para upload sem upsert; o cabeçalho condicional é uma proteção adicional, não uma alegação de suporte a CAS pelo provedor. Um sucesso HTTP apenas retorna `requires_readback:true`; o orquestrador deve ler e conferir hash/tamanho antes de finalizar o lote.

Os [uploads padrão do Supabase](https://supabase.com/docs/guides/storage/uploads/standard-uploads) documentam o conflito de arquivo existente, e os [códigos de erro](https://supabase.com/docs/guides/storage/debugging/error-codes) descrevem a transição entre formatos. Somente códigos exatos de duplicidade aceitos são normalizados para 409 e exigem leitura posterior. A mensagem livre nunca orienta decisões nem é propagada. Um GET retorna `null` apenas para HTTP 404 com `code:NoSuchKey`; erro de bucket, permissão, autenticação ou resposta antiga ambígua bloqueia a operação.

O projeto precisa ter o formato HTTPS `<referência de 20 caracteres>.supabase.co`, sem porta, query, fragmento ou credenciais na URL. Os destinos são derivados internamente. Redirecionamentos são recusados, inclusive resposta com URL efetiva divergente. A chave fica nos cabeçalhos do destino fixo e não aparece no resultado ou em erros. A implementação não registra logs.

Cada chamada tem prazo de parede de até 30 segundos, limitado ainda pelo prazo global informado. O cancelamento cobre headers e corpo; respostas tardias são descartadas. XML tem limite de 8 MiB, MIME binário exato, sem compressão HTTP, tamanho completo e hash conferidos. Respostas de upload/erro têm limite de 8 KiB. São devolvidos somente bytes e cabeçalhos locais de conteúdo, tamanho e `no-store`. Não se repassam cookies ou cabeçalhos internos do provedor.

Não há retry no adaptador. Uma falha de upload pode ter ocorrido depois da gravação; somente a leitura do mesmo caminho imutável permite ao orquestrador recuperar o resultado. Nada autoriza repetir uma consulta SEFAZ. A autenticação do ator, política A1, reserva, coordenação com NFStock, parser e finalização SQL continuam sendo responsabilidades separadas. A chave de serviço é poderosa: este módulo não torna seguro disponibilizá-la no navegador ou a um chamador arbitrário.

## Verificação

```sh
node --test packages/fiscal-dfe-storage/test/storage.test.mjs
```

Onze testes locais cobrem destino e paths estritos, POST/GET autenticados, hashes, journal, duplicidade, ausência versus erro, redirecionamento, limites, resposta truncada, erro sanitizado, prazo de corpo, headers tardios e aborto. Não certificam o comportamento de uma versão específica do Storage em produção. Nenhuma credencial real, consulta fiscal ou gravação remota foi utilizada.
