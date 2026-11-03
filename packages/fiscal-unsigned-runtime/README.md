# Serviço privado de XML sem assinatura

Serviço que exige as estruturas de jobs 048 e o bucket privado `brufap-fiscal-artifacts` na instalação. A custódia do A1 permanece separada. Após configurar e implantar gateway e executor, validar CORS, rejeição de sessão ausente e geração autenticada com os serviços privados da instalação. Nenhum identificador de implantação ou dado fiscal acompanha o pacote.

O gateway fiscal verifica a sessão no serviço de autenticação configurado e aceita somente origens configuradas. O ator vem dessa resposta, nunca do corpo do navegador. Uma mensagem HMAC com domínio próprio `brufap-unsigned-request-v1` vincula ator, método, caminho, hash do corpo, nonce e instante. Ela usa o segredo de transporte já autorizado, com audiência terminada em `-unsigned`; tokens do protocolo A1 não são intercambiáveis.

O executor privado executa o builder diretamente no Worker. Não inicia o contêiner A1, não lê KEK ou certificado e não chama a SEFAZ. As portas RPC e Storage usam a chave de serviço já existente no executor; o gateway continua sem essa chave. O bundle usa `node:crypto`, `Buffer` e `xmldom`, exercitados no runtime local workerd com NF-e, NFC-e e 250 itens. A compatibilidade Node é habilitada pela data configurada, conforme a [documentação do Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

## Endpoints

O prefixo público é `/v1/fiscal-unsigned`; a conexão privada usa `/internal/v1/fiscal-unsigned`. Não há rota para XML, download, numeração, certificado, assinatura ou transmissão.

| Método e sufixo | Corpo |
| --- | --- |
| POST `/preview` | `draft_id`, `completion_version` |
| POST `/generate` | `command_id`, `reservation_id`, `draft_id`, `completion_version`, `completion_hash`, `basis_hash` |
| GET `/jobs/:id` | Sem corpo |
| GET `/commands/:id` | Sem corpo |
| POST `/history` | `reservation_id`, `limit` (1–25), `before` (versão ou null) |

Corpos têm até 4 KiB, JSON/UTF-8 estritos e somente as chaves documentadas. Não existe query string ou destino fornecido pelo usuário. Históricos usam cursor explícito. Respostas públicas têm até 128 KiB e passam por projeção de campos: não expõem entrada do builder, XML, identidade, chave fiscal, token da execução, caminho de Storage, credenciais ou mensagem externa. Hashes de complemento/base permitem conferir o vínculo ao recuperar um comando.

## Execução e recuperação

A prévia resolve conteúdo e aritmética antes de reservar. A reserva 046 deve ser criada e confirmada em uma ação separada. Gerar nunca escolhe série, consome outro número ou libera uma reserva. A geração segue o [orquestrador](../fiscal-unsigned-orchestrator/README.md), com criação imutável e leitura integral do arquivo antes de publicar seus metadados.

O nonce não é anunciado como uso único. Replays do token são limitados à janela de 60 segundos, ao mesmo ator/método/caminho/corpo e à autorização atual no banco. Leituras podem repetir; a geração é serializada pelo comando idempotente 048 e pela lease de 60 segundos. A primeira identidade persistida vence. Uma nova assinatura de transporte não transforma o mesmo comando em nova intenção.

O gateway limita a chamada total a 55 segundos, Auth a 10 segundos e entrada a 10 segundos. O executor limita execução e I/O a 45 segundos, com duas chamadas simultâneas por instância. Esse limite não é global na conta Cloudflare; a serialização persistente dos jobs pertence ao banco. RPCs/Storage também verificam prazo e cancelamento durante todo o corpo. Nenhuma camada repete escrita automaticamente.

Após uma resposta incerta, o cliente conserva comando e corpo. Consulta o mesmo comando; se ainda houver execução em andamento, aguarda seu prazo. Uma retomada explícita usa o mesmo comando e a mesma reserva. `xml_generated:null` significa resultado não confirmado; não significa ausência de arquivo. Após ACK, o cliente usa GET para confirmar o estado atual antes de liberar outra edição. Artefatos históricos continuam históricos se as bases mudarem.

Um XML armazenado continua sem assinatura, validação XSD ou autorização de uso. Os indicadores `can_emit` e `can_transmit` permanecem falsos. O fluxo não altera financeiro, estoque ou situação do pedido.

## Verificação

Testes Node usam identidades e dados fictícios, SQL 048 em PGlite, portas HTTP simuladas e segredos gerados apenas no teste. Os ensaios workerd interceptam todas as saídas; destinos inesperados falham sem consultar rede externa. Nenhum certificado real é carregado. O ensaio do executor confirma a execução efetiva do builder e do transporte, sem comprovar Storage remoto ou aceitação fiscal.

```sh
node --test packages/fiscal-unsigned-runtime/test/*.test.mjs
BRUFAP_RUN_WORKERD_TESTS=1 node --test packages/fiscal-unsigned-runtime/test/*workerd.test.mjs
```
