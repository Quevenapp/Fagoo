# API de negócio do FAGOO

Base pública: `/api/v1`. Todos os endpoints exigem uma identidade autenticada. A empresa e o ator são derivados da sessão ou credencial da integração no servidor; o corpo não aceita `company_id` nem `actor_id` para elevar acesso.

Valores decimais são strings. Quantidades usam até seis casas; preços unitários, até dez; totais monetários, duas. O arredondamento do item ocorre depois de multiplicar a quantidade pelo preço unitário. Não converta valores financeiros para ponto flutuante para executar operações.

Cada alteração exige um `command_id` UUID novo. Repita o mesmo identificador e o mesmo corpo se a resposta se perder. A repetição devolve `replayed:true` e não repete efeitos. Reutilizar o identificador com outro corpo, operação ou ator devolve conflito. Edições e efeitos sobre pedidos exigem `expected_version`; leia novamente o recurso quando houver `VERSION_CONFLICT`.

## Consultas

| Método e caminho | Filtros | Resposta/escopo |
|---|---|---|
| `GET /products` | `q`, `limit`, `cursor` | Produtos; `catalog:read` |
| `GET /products/{id}` | — | `{product,suppliers}`; `catalog:read` |
| `GET /contacts` | `q`, `kind`, `limit`, `cursor` | Clientes/fornecedores; `catalog:read` |
| `GET /warehouses` | — | Depósitos; `stock:read` |
| `GET /price-rules` | `limit`, `cursor` | Regras comerciais; `catalog:read` |
| `GET /orders` | `kind=sale\|purchase`, `limit`, `cursor` | Pedidos; `orders:read` |
| `GET /orders/{id}` | — | `{order,items,receipts,finance?}`; financeiro requer `finance:read` |
| `GET /stock` | `warehouse_id`, `product_id`, `limit`, `cursor` | Quantidade física, reservada e disponível; `stock:read` |
| `GET /stock/movements` | `warehouse_id`, `product_id`, `from`, `to`, `limit`, `cursor` | Entradas/saídas e preço da compra relacionada; `stock:read` |
| `GET /payables` e `/receivables` | `limit`, `cursor` | Parcelas e situação; `finance:read` |
| `GET /commerce/customer-context` | `contact_id`, `product_id`, `quantity`, `payment_terms` | Compra anterior e preço aplicável atual; `orders:read` e `catalog:read` |
| `GET /analytics/sales-series` | `from`, `to`, `group=product_day\|customer_product_month`, `limit`, `cursor` | Série de vendas efetivamente concluídas; `analytics:read` |
| `GET /analytics/replenishment-context` | `from`, `to`, `limit`, `cursor` | Saldos, reservas, vendas, compras pendentes, custos e parâmetros; `analytics:read` e `stock:read` |
| `GET /analytics/overview` | — | Indicadores; `analytics:read`, `finance:read` e `stock:read` |
| `GET /invoices/received` | `limit`, `cursor` | Metadados de notas; `fiscal:read` |
| `GET /commands/{id}` | — | Resultado do próprio comando; `orders:read` |

Listas paginadas respondem `{items,total,has_more,next_cursor,as_of,consistency,coverage}`. O limite padrão é 100 e o máximo é 1000. Consuma todas as páginas; `coverage.partial:false` significa que não houve corte silencioso por um limite de painel, não que a primeira página seja todo o conjunto. Os cursores estão vinculados aos filtros. Alterações concorrentes podem mudar listas com `consistency:live`; não são snapshots contábeis. O horário de corte é obtido do PostgreSQL para não depender da sincronização do relógio do processo da API.

As séries comerciais usam datas em `America/Sao_Paulo`. Pedidos em rascunho, apenas confirmados ou cancelados não contam como venda concluída. Reversões cancelam o efeito comercial e permanecem na auditoria. Reposição retorna dados e limitações; a previsão e a otimização podem ser executadas pelo agente externo. O custo cadastral não inclui frete ou tributos ainda não configurados.

## Comandos

| Método e caminho | Campos além de `command_id` | Escopos |
|---|---|---|
| `POST /products` | `code,name,unit?,sale_price?,cost_price?,stock_min?,stock_max?,ncm?,gtin?,lead_days?,pack_quantity?` | `catalog:write` |
| `PATCH /products/{id}` | `expected_version` e os campos alterados | `catalog:write` |
| `POST /products/{id}/suppliers` | `expected_version,supplier_id,code?,description?,unit_factor?,price?,lead_days?` | `catalog:write` |
| `POST /contacts` | `name,kind,document?,payment_terms?` | `catalog:write` |
| `PATCH /contacts/{id}` | `expected_version` e os campos alterados | `catalog:write` |
| `POST /warehouses` | `name` | `stock:write` |
| `POST /price-rules` | `name,product_id,unit_price,contact_id?,payment_terms?,minimum_quantity?,valid_from?,valid_until?,priority?,active?` | `pricing:write` |
| `PATCH /price-rules/{id}` | `expected_version` e campos alterados | `pricing:write` |
| `POST /orders` | `kind,contact_id,warehouse_id,items,payment_terms?,expected_on?` | `orders:write` |
| `POST /orders/{id}/confirm` | `expected_version` | `orders:write`; venda também `stock:write` |
| `POST /orders/{id}/fulfill` | `expected_version,confirmed:true` | `orders:write` e `stock:write` |
| `POST /orders/{id}/receipts` | `expected_version,confirmed:true,items:[{item_id,quantity}]` | `stock:write` |
| `POST /orders/{id}/finance` | `expected_version,installments:[{due_on,amount}]` | `finance:write` |
| `POST /stock/adjustments` | `warehouse_id,product_id,quantity,reason,expected_version` | `stock:write` |
| `POST /orders/{id}/cancel` | `expected_version,reason` | `orders:write`; venda reservada também `stock:write` |
| `POST /orders/{id}/reverse-fulfillment` | `expected_version,confirmed:true,reason` | `orders:write` e `stock:write` |
| `POST /orders/{id}/receipts/{receiptId}/reverse` | `expected_version,confirmed:true,reason` | `stock:write` |
| `POST /orders/{id}/finance/{postingId}/reverse` | `expected_version,expected_posting_version,confirmed:true,reason` | `finance:write` |

Itens de pedido: `{product_id,quantity,unit_price?,unit_factor?}`. O tipo do contato deve corresponder à operação. Compra pode registrar conversão de embalagem com `unit_factor`; venda usa a unidade base do produto. A conversão não pode perder precisão. Ao omitir `unit_price` em uma venda, o servidor aplica as regras comerciais; alterar o preço calculado exige `pricing:override`.

Em compras, se `unit_factor` for diferente de1, `unit_price` é obrigatório e representa o preço da embalagem comprada. O custo por unidade base do cadastro só é usado como padrão quando o fator é1. Exemplo: uma caixa com12 unidades deve informar o preço da caixa; o servidor não presume que o custo unitário seja esse preço.

Regras comerciais priorizam cliente específico, condição de pagamento específica, maior prioridade e maior quantidade mínima aplicável, nessa ordem. A vigência usa a data da empresa. Regras empatadas com preços diferentes retornam `PRICE_RULE_AMBIGUOUS` para correção. A confirmação revalida o preço vigente quando o ator não possui permissão de negociação.

Venda: rascunho → confirmação e reserva → entrega confirmada e baixa. Compra: rascunho → confirmação → recebimentos parciais → recebimento completo. Lançar financeiro é uma operação independente, exige parcelas cujo total corresponda ao pedido e não realiza pagamento nem recebimento de dinheiro. Reverter estoque também não desfaz automaticamente obrigações financeiras. Títulos liquidados impedem o estorno do lançamento.

Ajustes recebem delta assinado. Para um saldo ainda inexistente, use `expected_version:0`; para os demais, leia `/stock` com depósito e produto específicos. Não é possível reduzir o saldo abaixo das reservas. Sem depósito selecionado, a consulta agrega saldos e não retorna uma versão utilizável para ajuste.

## Eventos e retomada

`GET /events?after=sequencia&limit=100` exige `events:read` e responde `{items,has_more,next_cursor,next_after,as_of}`. As sequências são strings inteiras. Sem `after`, a consulta retoma a última confirmação do consumidor autenticado. Use `after=0` para consultar o histórico disponível.

`POST /events/ack` com `{command_id,sequence}` exige `events:write` e avança a confirmação do próprio consumidor. Confirme somente depois de concluir o tratamento. A entrega admite repetição; use os identificadores de comandos para impedir efeitos duplicados.

Os comandos comerciais e fiscais adquirem um bloqueio PostgreSQL `FOR NO KEY UPDATE` na empresa antes de gravar o comando ou bloquear outros recursos, mantendo-o até commit ou rollback. Isso serializa os produtores de eventos da mesma empresa: uma sequência posterior não pode aparecer antes do commit de uma anterior. Empresas distintas continuam independentes; lacunas na sequência global são normais. Uma leitura não bloqueia os comandos e só retorna eventos confirmados. Todo futuro produtor de eventos precisa seguir a mesma ordem de bloqueio antes de alocar a sequência.

Essa escolha favorece integridade e simplicidade na VPS inicial: comandos de escrita da mesma empresa aguardam entre si, inclusive enquanto uma importação fiscal grava o XML privado. Leituras continuam concorrentes. Para volumes maiores, substituir por uma sequência atribuída a eventos já confirmados exige um protocolo próprio; não basta remover o bloqueio e manter o cursor `BIGSERIAL`.

## Cobertura desta base

Estão implementados os cadastros essenciais, regras comerciais, pedidos, reservas, recebimentos, lançamentos financeiros, reversões e dados analíticos descritos acima.

Conciliação bancária operacional, homologação CNAB por perfil, emissão fiscal, coleta automática de documentos, verificação criptográfica de XML e cálculo tributário geral dependem de módulos e configurações próprios. A leitura de XML ou o lançamento de uma obrigação não deve ser apresentado como validação tributária, autorização fiscal ou pagamento bancário.
