# API autenticada do FAGOO ERP

Esta distribuição mantém as rotas `/v1` e as RPCs do ERP. A URL do backend, as origens permitidas e os segredos pertencem à instalação e devem ser configurados antes do deploy. Nenhum domínio, conta ou agendamento operacional é fornecido por padrão.

A consulta do staging Origin é somente leitura. Rotas nativas permitem cadastros, documentos/OS, estoque e financeiro, com comandos explícitos e auditados. Anexos, histórico fiscal, importação revisada, CNAB de homologação e dados da empresa também fazem parte dos módulos. A API não cria usuários, emite notas nem envia arquivos aos bancos. A prévia demonstrativa continua independente dos registros reais.

| Área nativa | Rotas principais | Contrato |
| --- | --- | --- |
| Visão geral | `/v1/inicio` | [Agregados por perfil](../../docs/integrations/erp-home.md) |
| Preparação da virada | `/v1/preparacao-virada` | [Conferência somente leitura](../../docs/integrations/erp-cutover-readiness.md) |
| Conferência financeira da origem | `/v1/conferencia-financeira-origin` | [Valores, identidades e pendências, somente leitura](../../docs/integrations/financial-cutover-review.md) |
| Importação financeira revisada | `/v1/importacao-financeira-origin` | [Prévia administrativa, lote atômico e proveniência permanente](../../docs/integrations/origin-financial-import.md) |
| Duplicação de documentos | `/v1/duplicacao-documentos` | [Nova cópia e vínculo de origem](../../docs/integrations/erp-document-copy.md) |
| Preparação dos itens fiscais | `/v1/preparacao-itens-fiscais` | [Conferência por revisão](../../docs/integrations/fiscal-item-preparation.md) |
| Documento → financeiro | `/v1/documentos/:kind/:id/financeiro` | [Prévia, lançamento e reversão](../../docs/integrations/erp-document-finance.md) |
| Documento → estoque | `/v1/documentos-estoque` | [Prévia, movimento e estorno](../../docs/integrations/erp-document-stock-rpc.md) |
| Cadastros | `/v1/cadastros` | [Catálogo](../../docs/integrations/erp-catalog-rpc.md) |
| Documentos e OS | `/v1/documentos` | [Documentos](../../docs/integrations/erp-documents-rpc.md) |
| Estoque | `/v1/estoque` | [Movimentação e estorno](../../docs/integrations/erp-stock-rpc.md) |
| Financeiro | `/v1/financeiro` | [Títulos, baixas e reversões](../../docs/integrations/erp-finance-rpc.md) |
| Importação | `/v1/importacao-cadastros` | [Conferência de alterações](../../docs/integrations/erp-catalog-import.md) |
| Anexos | `/v1/documentos/:kind/:id/anexos` | [Reserva, envio e download](../../docs/integrations/erp-attachments.md) |
| CNAB 400 | `/v1/cnab` | [Perfis, remessas e retornos](../../docs/integrations/erp-cnab-rpc.md) |
| Empresa | `/v1/empresa`, `/identidade`, `/fiscal` | Migração 016: identidade para membros ativos, edição por admin; confirmação fiscal por admin/fiscal |

As permissões de cada área são consultadas por sua rota base e revalidadas no SQL. Não inferir autorização de escrita a partir da tabela de leitura de staging abaixo. CNAB mantém `productionReady:false` e retornos não realizam baixa automática; configuração fiscal mantém `emission_enabled:false`.

## Autenticação e autorização

Cada chamada exige `Authorization: Bearer <access_token do Supabase Auth>`. O Worker verifica o token por `GET /auth/v1/user` no projeto configurado. Só o UUID retornado por essa verificação é enviado às RPCs internas. Papéis de `user_metadata`, UUIDs informados pelo cliente e usuários anônimos não autorizam acesso.

A migração `202610160004_erp_access.sql` cria a associação privada `erp_access.membership`, inicialmente vazia. Um usuário válido do Auth sem associação ativa recebe `403`. O primeiro administrador precisa ter seu UUID real verificado e receber uma associação explícita por um administrador do banco. Não existe promoção automática do primeiro cadastro nem endpoint de autoinscrição. Atualizações administrativas devem atualizar também `updated_at`.

| Papel | Entidades permitidas |
| --- | --- |
| `admin`, `consulta` | Todas as nove entidades abaixo |
| `vendas` | `contacts`, `products`, `sales_orders`, `sales_proposals` |
| `financeiro` | `contacts`, `receivables`, `payables` |
| `estoque` | `contacts`, `products`, `purchase_orders` |
| `fiscal` | `contacts`, `products`, `sales_orders`, `purchase_orders`, `nfe`, `nfce` |

Todos os papéis, inclusive `admin`, têm somente leitura **nas rotas de staging**. As rotas nativas possuem sua própria matriz de operações. As permissões são verificadas dentro do banco a cada chamada; desativar a associação bloqueia chamadas seguintes. Os papéis pertencem à única empresa do projeto.

## Contrato para o frontend

`GET /v1/me` responde:

```json
{
  "user_id": "UUID confirmado pelo Supabase Auth",
  "role": "vendas",
  "resources": ["contacts", "products", "sales_orders", "sales_proposals"],
  "data_mode": "staging_readonly"
}
```

`GET /v1/records/:entity` aceita as nove entidades: `contacts`, `products`, `sales_orders`, `purchase_orders`, `sales_proposals`, `receivables`, `payables`, `nfe`, `nfce`.

| Parâmetro opcional | Regra |
| --- | --- |
| `limit` | Inteiro entre 1 e 100; padrão 25 |
| `offset` | Inteiro entre 0 e 100.000; padrão 0 |
| `q` | Até 120 caracteres; busca textual literal em nome, código, número e nome da contraparte |
| `status` | Até 80 caracteres; igualdade com o código original do Origin |
| `from`, `to` | Datas `YYYY-MM-DD`, inclusivas, entre 1900 e 2100; início não pode superar fim |

Parâmetros desconhecidos ou repetidos são rejeitados. Busca não interpreta `%`, `_` ou SQL como comandos. A ordenação é determinística pelo ID textual da origem, e não por data ou valor numérico. Filtros de data usam emissão para títulos/notas e a data do documento para pedidos/propostas. Cadastros sem data não aparecem quando um intervalo é informado.

Exemplo de resposta com dados fictícios:

```json
{
  "entity": "nfce",
  "items": [{
    "id": "90071992547409931234",
    "entity": "nfce",
    "name": null,
    "code": null,
    "number": "900",
    "date": "2026-10-15",
    "due_date": null,
    "status": "6",
    "amount": "123.45",
    "balance": null,
    "counterparty_id": "123",
    "counterparty_name": "Cliente Sintético",
    "model": "65",
    "series": "1",
    "direction": null,
    "last_seen_at": "2026-10-16T02:10:20+00:00"
  }],
  "limit": 25,
  "offset": 0,
  "total": 1,
  "has_more": false,
  "next_offset": null,
  "data_mode": "staging_readonly"
}
```

IDs, números de documento e valores monetários são strings; o frontend deve preservar IDs sem `Number` e tratar valores com aritmética decimal. `amount` corresponde ao preço em produtos, valor em títulos, total em pedidos/propostas e `valorNota` em documentos fiscais. Campos não disponíveis ficam `null`. Os códigos de situação são mantidos como na origem, sem presumir que os mesmos códigos têm igual significado entre módulos.

O resumo de staging inclui apenas os campos do exemplo. CPF/CNPJ, endereço, telefone, e-mail, observações, itens, parcelas, chave fiscal, XML, links DANFE/PDF e payload bruto ficam fora **dessa rota**. Detalhes nativos e downloads privados usam rotas e permissões próprias. Nomes de contatos são visíveis somente aos papéis que podem consultar o recurso correspondente.

Os dados são uma cópia em sincronização; a API não garante completude do histórico nem calcula saldos operacionais. `last_seen_at` indica a última observação do registro no staging. Paginação por offset pode refletir inserções concorrentes entre páginas; não constitui um extrato congelado para auditoria ou fechamento.

## Erros

As respostas usam `{ "error": { "code": "ERP_FORBIDDEN", "request_id": "..." } }`, sem corpo de erro do Supabase, tokens ou dados de registros. O identificador também aparece em `X-Request-Id`.

| HTTP | Significado |
| --- | --- |
| `400` | Parâmetros inválidos |
| `401` | Token ausente, malformado ou rejeitado pelo Auth |
| `403` | Origem não autorizada, usuário anônimo, associação ausente/inativa ou recurso proibido |
| `404` | Rota/entidade inexistente |
| `405` | Método não permitido naquela rota |
| `408` | Prazo de leitura do corpo excedido, quando limitado pelo módulo |
| `409` | Versão, prévia ou identidade do comando em conflito |
| `502`, `503` | Configuração ou dependência indisponível/resposta inválida |

Todas as respostas têm `Cache-Control: no-store`. O Worker não registra corpos, consultas, JWTs ou dados de usuários.

## Configuração e operação posterior

Configuração em `wrangler.jsonc`: URL pública do projeto e `ALLOWED_ORIGINS`, lista de origens exatas separadas por vírgulas. Sem configuração, pedidos de navegadores com `Origin` são bloqueados. HTTPS e HTTP local são aceitos quando explicitamente configurados. Não há wildcard, autorização por cookie ou CORS com credenciais. Clientes sem `Origin` também precisam de token e associação válidos. Métodos de mutação são liberados apenas nas rotas nativas correspondentes; staging e histórico continuam GET.

O segredo `SUPABASE_SERVICE_ROLE_KEY` pertence exclusivamente ao Worker; nunca deve entrar no bundle, configuração pública ou armazenamento do navegador. O frontend recebe apenas a chave pública do projeto para autenticação. Para staging, o Worker chama `erp_access_me(uuid)` e `erp_read_records(uuid,text,integer,integer,text,text,date,date)`. O lote adicional chama somente as RPCs de catálogo/histórico expressamente enumeradas nos módulos correspondentes. `anon` e `authenticated` não podem executá-las, e nem `service_role` possui acesso direto às tabelas privadas.

A publicação foi realizada após a aplicação da migração 004, configuração do segredo de serviço e liberação da origem da prévia. O endereço `workers.dev` foi habilitado nessa implantação. A criação/verificação do primeiro usuário Auth e sua associação deliberada continuam pendentes. A interface autenticada está documentada em `apps/erp/ACCESS.md`; login real e consulta com associação precisam de verificação própria. Novas entidades de sincronização, como formas de pagamento e vendedores, exigem extensão explícita desta API.

Validação local, executada a partir da raiz:

```sh
node --test workers/erp-api/test/*.test.mjs
npx wrangler deploy --dry-run --config workers/erp-api/wrangler.jsonc
```

Os testes usam PGlite com usuários e registros sintéticos, aplicam 001/002/004 e verificam RLS/grants, associação vazia inicial, matriz de papéis, desativação, consultas inválidas, preservação de IDs longos, projeção sem dados brutos e comportamento HTTP/CORS. Nenhum teste depende de credenciais ou registros reais.

## Cadastros próprios — lote 006

Os registros de `contacts`, `products` e `warehouses` pertencem ao FAGOO, usam UUID interno e não alteram o staging nem o Origin. A importação administrativa é separada, com prévia e aplicação explícita nas rotas da migração 013. Não há importação operacional automática.

| Rota | Operação |
| --- | --- |
| `GET /v1/cadastros` | Permissões `{read,write,data_mode:"erp_native"}` |
| `GET /v1/cadastros/:entity` | Lista com `limit` (1–100, padrão 25), `after` (UUID), `q` (até 120) e `active` (`true`/`false`, omitido para ambos) |
| `GET /v1/cadastros/:entity/:id` | Registro completo permitido do cadastro |
| `POST /v1/cadastros/:entity` | Criação: `{command_id,data}` |
| `PATCH /v1/cadastros/:entity/:id` | Edição parcial: `{command_id,expected_version,data}` |
| `PATCH /v1/cadastros/:entity/:id/active` | Arquivar/reativar: `{command_id,expected_version,active}` |

O corpo aceita até 16 KiB. `command_id` é UUID; repetir o mesmo comando retorna o resultado salvo. Reutilizar um comando com conteúdo diferente ou salvar uma versão desatualizada responde `409`. A UI conserva o comando para repetir a mesma tentativa após falha de conexão. Cancelar uma requisição no navegador não desfaz uma gravação que já tenha sido confirmada no servidor.

Escrita de contatos: `admin`, `vendas`, `financeiro`. Escrita de produtos/depósitos: `admin`, `estoque`. Leitura de contatos/produtos segue as permissões de recurso da 004; depósitos são consultáveis por `admin`, `consulta`, `estoque`. Todas essas verificações são repetidas no SQL; não dependem de controles visuais.

A lista responde `{entity,items,limit,has_more,next_cursor,data_mode:"erp_native"}`. Detalhe e mutações respondem `{entity,record,data_mode:"erp_native",replayed?}`. O registro tem `id`, `entity`, `version`, `active`, `name`, `code`, timestamps e campos do cadastro. Preço é string decimal com até 14 inteiros e quatro casas; o CPF/CNPJ/documento é texto e preserva caracteres alfanuméricos. Esta etapa não valida enquadramento tributário ou validade fiscal documental.

Dados pessoais de contato são acessíveis apenas nos cadastros autorizados. A resposta segue lista explícita de campos e não inclui snapshots brutos, auditoria livre ou segredos. `source`, quando presente, contém somente sistema, ID, estado e hashes de origem. A auditoria completa permanece privada no banco.

O teste `catalog-contract.test.mjs` executa o Worker contra as funções reais da migração 006 em PGlite, cobrindo precisão de preço, replay, concorrência, arquivamento, papéis e ausência de efeitos no staging.

## Importação financeira — lote 039

`POST /v1/importacao-financeira-origin/preview` e `/apply` exigem administrador ativo. O corpo é limitado a 64 KiB e até 25 fontes de uma entidade, com hash/versão/observação, categoria explícita e confirmação de revisão das duplicatas anteriores. A aplicação acrescenta UUID do comando, hash da prévia e confirmação. O servidor deriva principal, contato, descrição e datas, exige detalhe específico compatível da 030 nos últimos 60 minutos e revalida tudo sob locks. Lote inteiro, recibo, vínculos e auditoria são atômicos.

`GET /batches/:commandId` devolve o recibo imutável e os títulos atuais separadamente; `GET /origins/:entity/:sourceId` consulta a origem exata. Esses dois caminhos são administrativos. `GET /titles/:titleId/origin` permite somente proveniência mínima aos papéis `admin`, `financeiro` e `consulta`, sem expor o lote ou a evidência privada. Todos os caminhos estão sob o prefixo acima, usam RPCs de serviço e resposta limitada a 1 MiB.

Os cinco RPCs são exclusivos de `service_role`; helpers e tabela de vínculos não possuem grants diretos, e a tabela tem RLS. A origem permanente bloqueia nova importação do mesmo ID, inclusive após cancelamento, e protege o núcleo do título. Reserva CNAB é recusada até existir um contrato de vínculo bancário legado. A API não infere quitação, não migra parciais, não cria baixa nem movimento de caixa. [Contrato completo e limites](../../docs/integrations/origin-financial-import.md).

O conjunto focado 039 passou 26/26 testes SQL/HTTP/interoperabilidade com os parsers da UI. A bateria final da publicação passou 507/507; fixtures são sintéticas, sem chamada Auth ou financeira real.

## Histórico fiscal — lote 007

GET em `/v1/history/backups`, `/v1/history/xml` e `/v1/history/xml/:sha256/download` usa os módulos e RPCs específicos do histórico. Somente `admin`, `consulta` e `fiscal` podem acessar; o SQL revalida o papel em cada chamada. Backups ainda em envio não liberam download.

O download passa pelo Worker com autenticação de usuário e acesso de serviço ao bucket privado. O caminho é fixado pelo hash registrado; não aceita URLs/caminhos arbitrários. Os bytes são limitados a 8 MiB e conferidos por tamanho e SHA-256 antes de retornar como anexo `application/octet-stream`, com `no-store`, `nosniff` e CSP sandbox. Não são gerados links públicos. A verificação estrutural e de hash não equivale a validação de assinatura, XSD ou situação fiscal.

Referências: [validação de usuário pelo Supabase Auth](https://supabase.com/docs/reference/javascript/auth-getuser), [JWTs do Supabase](https://supabase.com/docs/guides/auth/jwts).
