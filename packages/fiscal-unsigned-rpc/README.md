# Porta privada de RPC para XML sem assinatura

Adaptador local das sete funções internas da migração 048. A configuração exige origem HTTPS canônica do backend, chave de serviço e driver `fetchImpl` explícitos. Na instalação própria, informe também `supabaseDeployment: 'self-hosted'`, conforme a [validação compartilhada](../backend-config/src/origin.mjs). Não lê variáveis de ambiente, não oferece rede padrão e não publica endpoints. Este pacote não foi ligado a credenciais ou serviços remotos.

```js
const rpc = createFiscalUnsignedRpc({projectUrl, supabaseDeployment: 'self-hosted', serviceKey, fetchImpl});
const executor = createUnsignedXmlOrchestrator({rpc, storage});
```

A função tem a assinatura `rpc(name, args, {signal, deadline})`. `deadline` é um instante absoluto em milissegundos, obrigatório e no máximo 45 segundos à frente. `signal` é opcional. O mesmo prazo cobre envio, resposta e leitura integral do corpo; cancelamento não prova rollback de uma operação enviada.

O ator `p_user_id` é obrigatório em todas as funções e precisa ser UUID canônico. Deve vir da sessão verificada pelo chamador confiável. A porta não autentica usuários nem aceita uma identidade de navegador sem validação anterior. As RPCs voltam a verificar membership e emissor no banco. A chave de serviço pertence ao executor privado e não deve ser enviada ao frontend.

## Contrato de transporte

- Allowlist exata: `erp_fiscal_unsigned_basis`, `begin`, `finish`, `fail`, `get`, `command` e `history`, sempre com o prefixo completo `erp_fiscal_unsigned_`.
- Cada função valida chaves, tipos, UUIDs, versões, hashes e limites próprios. O seed interno aceita apenas `cNF` e `issuedAt`; o calendário é validado sem substituir data antiga de retry. O banco decide frescor e qual identidade foi persistida.
- `history` normaliza somente os defaults documentados `p_limit=25` e `p_before=null`, quando omitidos. Não inventa identidade, número, data ou hash.
- Requisição JSON de até 16 KiB. `basis` e `begin` admitem resposta de até 8 MiB; os outros retornos têm teto de 128 KiB. Erros têm limite separado de 8 KiB.
- Somente POST para `/rest/v1/rpc/<nome permitido>`, origem fixa, sem query string, cookies ou redirecionamento. A URL efetiva também precisa corresponder à solicitada.
- Corpo JSON com UTF-8 estrito, MIME JSON, sem compressão, comprimento coerente e envelope objeto. O orquestrador continua responsável por conferir os campos de domínio, vínculos e gates de cada resposta.
- Não há retry automático. Buffers próprios de requisição/resposta são zerados ao concluir; corpos pendentes são cancelados, inclusive quando os headers chegam após timeout. Strings e objetos JavaScript continuam sujeitos ao gerenciamento normal de memória e não são registrados em log.

Somente os SQLSTATEs `42501`, `40001`, `22023`, `55000` e `P0002` são preservados em `error.code`. Mensagens, detalhes, hints, cabeçalhos e erros livres do provedor/driver não são repassados. `P0002` vem de erro JSON explícito do banco; um HTTP 404 genérico não é considerado comando ausente. Os demais problemas usam códigos fixos `FISCAL_UNSIGNED_RPC_*`, sem `cause` ou conteúdo externo.

Uma falha de transporte após `begin`/`finish` pode ocorrer depois do commit. O executor conserva o mesmo comando e consulta seu estado; esta porta não decide que a escrita foi rejeitada, não consome outro número e não faz uma segunda chamada por conta própria.

## Testes locais

```sh
node --test packages/fiscal-unsigned-rpc/test/*.test.mjs
```

Drivers fictícios cobrem allowlist, argumentos, ator, calendário, limites, UTF-8, redirecionamento, erros sanitizados, prazo de headers/corpo, cancelamento tardio e ausência de retries. A interoperabilidade usa PGlite com a migração 048 e Storage de bytes em memória, sem rede ou certificado real.
