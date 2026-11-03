# Porta privada para RPCs de candidatos assinados

Adaptador local das sete funções da [migração 050](../../docs/integrations/fiscal-signed-candidates-persistence.md). Não publica endpoints, não lê variáveis de ambiente, não fornece driver de rede padrão e não foi ligado ao ambiente remoto. Não abre certificado, assina XML, valida XSD ou acessa Storage.

```js
import {createFiscalSignedRpc} from './src/rpc.mjs';
const rpc = createFiscalSignedRpc({projectUrl, serviceKey, fetchImpl});
const result = await rpc('erp_fiscal_signed_command', {
  p_user_id: verifiedActorId,
  p_command_id: originalCommandId,
}, {signal, deadline});
```

`deadline` é um instante absoluto obrigatório em milissegundos, no máximo 45 segundos à frente. `signal` é opcional. O mesmo prazo cobre headers, leitura completa, JSON e conferência da resposta. O ator obrigatório deve vir da sessão já verificada pelo executor; o adaptador não autentica o usuário. Todas as RPCs reautorizam no banco.

## Fronteira fechada

- Nomes permitidos: `erp_fiscal_signed_begin`, `use`, `finish`, `fail`, `get`, `command` e `history`, sempre com o prefixo completo.
- Argumentos exatos por função. UUIDs canônicos, hashes SHA-256 minúsculos, versões inteiras, enum de falha determinística e evidência de assinatura/XSD/QR são validados antes do envio. Não há coerção de strings numéricas ou getters. `history` só preenche os defaults documentados `p_limit=25` e `p_before=null` quando omitidos.
- Configuração exige URL HTTPS canônica `https://<projeto20caracteres>.supabase.co`, chave de serviço e `fetchImpl` explícitos. A chamada usa somente POST no caminho fixo da RPC, sem query, cookies, redirects ou URL efetiva diferente. Não permite destinos arbitrários.
- Requisição de até 16 KiB, respostas de até 128 KiB e erros de até 8 KiB. JSON exige UTF-8 estrito, MIME compatível, identidade de encoding e comprimento declarado coerente. Limites também se aplicam ao streaming sem `Content-Length`.
- O DTO é validado e reconstruído com campos permitidos. Recibo histórico, estado atual e artefato permanecem separados. `finish` deve devolver o mesmo candidato, hash, tamanho e evidência enviados; `begin`, consultas e paginação ficam vinculados aos IDs e versões solicitados. As flags conservam o contrato 050, sem promover emissão, transmissão, regras tributárias, ICP ou revogação.
- O resultado de `use` é **exclusivamente backend**: contém contexto/metadata da credencial, chave fiscal e referências privadas de objetos. Seus caminhos são derivados e conferidos em buckets fixos. Nunca enviar esse objeto ao navegador nem a logs. A validação do DTO não autentica ou decifra o envelope; o executor ainda deve conferir bytes, AEAD, contexto, certificado e autorização antes de usar o signer.

Somente os SQLSTATEs `42501`, `40001`, `22023`, `55000` e `P0002` são preservados em `FiscalSignedRpcError.code`. O restante usa códigos fixos `FISCAL_SIGNED_RPC_*`. Mensagens, detalhes, hints, corpo de erro, chave de serviço e erros livres do driver não são incorporados a erros, `cause` ou logs. HTTP 404 genérico não equivale a comando ausente: é necessário o SQLSTATE `P0002` explícito.

## Interrupções e recuperação

Não há retries automáticos. Uma resposta perdida após `begin`, `use`, `finish` ou `fail` pode ocorrer depois do commit. Timeout, cancelamento, formato inesperado ou falha de rede não atestam rollback e não devem virar `fail` fiscal. O executor conserva o comando, consulta seu estado e decide a recuperação conforme 050; esta porta não obtém outra lease ou assinatura por conta própria.

Os argumentos e a evidência são capturados antes do primeiro `await`. Buffers próprios são zerados ao concluir; streams e respostas tardias são cancelados, inclusive se o driver ignorar abort. Isso não promete apagar cópias internas do sistema operacional nem strings/objetos gerenciados pelo JavaScript. O retorno privado permanece em memória sob responsabilidade do chamador.

## Verificação sintética

```sh
node --test packages/fiscal-signed-rpc/test/*.test.mjs
```

Testes de transporte cobrem configuração, allowlist, argumentos e evidência, projeção e vínculos, privacidade dos erros, redirects, encoding/UTF-8, limites, prazo, cancelamento e captura de argumentos. A interoperabilidade usa as sete RPCs 050 em PGlite através de `fetchImpl` fictício, modelos 55/65, ACL, bases alteradas e resposta de `finish` perdida seguida de consulta do comando. Recibo assinado histórico continua separado do A1 desativado posteriormente. Nenhuma chave real, rede, emissão, financeiro ou estoque é usado.
