# Armazenamento privado de artefatos fiscais

Porta privada usada pelos executores de XML sem assinatura e candidatos assinados das estruturas 048/050. Exige dependências explícitas; não lê ambiente, cofre ou credenciais do usuário e não fornece rede padrão. O caminho adicional de evidência WSDL mantém os mesmos controles de escrita imutável e leitura de conferência.

```js
const storage = createFiscalArtifactStorage({ projectUrl, supabaseDeployment: 'self-hosted', serviceKey, fetchImpl });
await storage.putImmutable({
  bucket: 'brufap-fiscal-artifacts',
  key: `jobs/${jobId}/${sha256}.xml`,
  bytes, contentType: 'application/octet-stream',
  upsert: false, ifNoneMatch: '*', signal, deadline,
});
const response = await storage.read({
  bucket: 'brufap-fiscal-artifacts',
  key: `jobs/${jobId}/${sha256}.xml`, signal, deadline,
});
```

Na instalação própria, informe `supabaseDeployment: 'self-hosted'` e a origem HTTPS canônica do backend, com hostname DNS público e sem porta explícita, credenciais, caminho adicional, query ou fragmento. O modo padrão `hosted` conserva a validação restrita de compatibilidade. A [validação compartilhada](../backend-config/src/origin.mjs) não aceita destinos derivados da requisição do usuário. O bucket e a estrutura do caminho são fixos: `jobs/<uuid>/<sha256>.xml` para a 048, `candidates/<uuid>/<sha256>.xml` para a 050 e `wsdl/<uuid>/<sha256>.xml` para a evidência 051. UUID e SHA-256 usam hexadecimal minúsculo. São recusados outros buckets, extensão diferente, caminhos do cofre A1 ou diário DF-e, percent-encoding, query, fragmento e controles. Os identificadores vêm do job/candidato/tentativa privado, nunca de um caminho livre fornecido pelo navegador.

Os argumentos são capturados antes da primeira etapa assíncrona. Somente propriedades próprias de dados são aceitas; getters, setters, símbolos e opções desconhecidas são recusados sem executá-los. Caminho, URL, prazo e referência do sinal de cancelamento ficam fixados nessa captura. Na gravação, a porta copia os bytes e calcula o hash dessa cópia, que também é enviada e limpa ao concluir. Alterar o objeto de argumentos ou o array original depois da chamada não muda o destino ou o conteúdo. O cancelamento continua associado ao sinal original, inclusive na remoção do listener.

POST usa `x-upsert:false` e `If-None-Match:*`. O hash do conteúdo deve coincidir com o nome antes de enviar. Resposta de criação ou duplicata reconhecida retorna somente `{status,requires_readback:true}`. Isso **não** confirma o artefato: o executor deve reler todos os bytes e conferir hash/tamanho antes de finalizar o job. Conflito não é sobrescrito. Não há retry automático.

GET autenticado aceita somente status 200, MIME `application/octet-stream`, corpo não vazio, codificação ausente/identity e tamanho coerente. Calcula e confere o hash obrigatório do nome antes de devolver uma nova resposta sem headers do provedor. Somente 404 com código `NoSuchKey` representa ausência; bucket inexistente, acesso negado e erros ambíguos são falhas.

Cada chamada tem prazo absoluto obrigatório e teto de 30 segundos, cobrindo headers e leitura do corpo, com cancelamento. O limite da porta/bucket é 8 MiB; a migração 048 impõe um limite adicional de 480.000 bytes ao XML unsigned, e a 050 limita o candidato assinado a 512.000 bytes. O executor deve aplicar o limite menor correspondente antes de gravar. Para `wsdl/`, a própria porta impõe 512.000 bytes tanto na escrita quanto na leitura, inclusive antes de consumir corpo com Content-Length maior. Respostas de erro/ACK são limitadas a 8 KiB. Redirecionamentos não são seguidos; a origem efetiva deve coincidir com o destino. Erros externos não são repassados em mensagem, causa ou logs.

Esta porta garante endereço, limites e integridade dos bytes; não valida XML, XSD, assinatura, tributos, autorização SEFAZ ou vínculo jurídico do documento. O SQL deve vincular o caminho ao job e conferir os metadados do bucket privado. O executor deve revalidar autorização, versões e lease antes de finalizar. Um upload pode permanecer órfão se o processo falhar depois da gravação; este pacote não apaga nem publica o objeto.

## Testes

`node --test packages/fiscal-artifact-storage/test/*.test.mjs`

Dezesseis cenários sintéticos passaram em 16/10/2026: destino, os três caminhos e seu limite específico, hash, escrita imutável, leitura, duplicatas, ausência, erros, redirecionamentos, cancelamento e alterações imediatas dos argumentos durante GET/POST. As regressões verificam também a cópia dos bytes, a limpeza do sinal original e a rejeição de accessors sem executá-los. Não conectam a serviços reais nem validam uma implantação. A implementação conserva o padrão já verificado de [`fiscal-dfe-storage`](../fiscal-dfe-storage/README.md), com caminho fechado e hash de conteúdo obrigatórios em todas as operações.

Referências do provedor: [upload padrão](https://supabase.com/docs/guides/storage/uploads/standard-uploads) e [códigos de erro](https://supabase.com/docs/guides/storage/debugging/error-codes).
