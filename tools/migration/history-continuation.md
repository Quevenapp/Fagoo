# Continuação durável dos históricos083 — migração093

A093 acrescenta dois ledgers imutáveis e quatro RPCs exclusivas de `service_role`. Usa a função original `erp_origin_sales_history_capture` sem substituir qualquer rotina001–092. Cada captura continua sendo uma observação comercial privada, sem pedido nativo, estoque, título, pagamento, emissão fiscal ou escrita no Origin.

O Worker chama as RPCs com a credencial remota já existente e um UUID de administrador configurado privadamente. Não há chave de serviço em um runner local nem entrada HTTP para escolher o ator. Todas as chamadas revalidam a associação administrativa ativa. Novas gravações exigem o proprietário e o token atuais do lease global `__scheduler__`, conferidos antes e depois.

A execução no coletor exige `SALES_HISTORY_CONTINUATION_ENABLED=true` e o ator privado. Por padrão permanece desabilitada. A fase compartilha o prazo do ciclo e tem até20 segundos para atéquatro lotes, com reserva para a coleta seguinte e o fechamento do scheduler. A conexão interna admite somente os quatro nomes completos de RPC abaixo; outras rotinas `erp_` não foram liberadas. O checkpoint fica em `sales_history_continuation` e resultados públicos da fase contêm somente agregados.

| RPC pública | Argumentos adicionais a `p_user_id` | Retorno |
| --- | --- | --- |
| `erp_origin_sales_history_continuation_get` | `p_batch_id uuid default null` | `{profile, batch}`; `batch` é envelope ou `null`. Sem ID, encontra o preparo pendente mais antigo. |
| `erp_origin_sales_history_continuation_prepare` | `p_owner uuid, p_scheduler_token uuid, p_batch_id uuid, p_after text default null, p_limit integer default 25` | Envelope persistido do lote. |
| `erp_origin_sales_history_continuation_apply` | `p_owner uuid, p_scheduler_token uuid, p_batch_id uuid, p_prepare_hash text` | Envelope persistido, com terminal quando concluído. |
| `erp_origin_sales_history_continuation_inventory` | `p_after text default null, p_limit integer default 100` | Contagens globais e página nominal de fontes sem histórico. |

O envelope tem perfil `origin-sales-history-continuation-state-v1`, `batch_id`, `actor`, `request_hash`, `prepare_hash`, datas, `proof` e `terminal`. O hash de preparo é SHA256 da representação `jsonb::text` da prova no PostgreSQL; o cliente conserva o hash retornado, sem recodificá-lo com `JSON.stringify`. O terminal contém `status`, `result`, `result_hash` e `finished_at`; o hash do resultado usa a mesma representação PostgreSQL.

A prova preserva até25 itens com `source_id`, `source_hash`, `source_version`, `price_capture_hash`, `snapshot_hash` e `command_id`083 distinto. Esses UUIDs são gerados uma vez, dentro da transação do preparo. Também preserva o cursor de entrada, limite, cursor seguinte, quantidade examinada, resíduos nominais e datas. O preparo expira após10 minutos.

Estados de um envelope:

- `prepared`: existe preparo durável, sem terminal.
- `pending_existing`: outra chamada de preparo encontrou um lote pendente. O envelope identifica esse lote antigo; o UUID solicitado pela nova chamada não foi usado. Não substituir o lote pendente.
- `applied`: a única transação de aplicação gravou todos os históricos083 e o terminal com seus recibos exatos.
- `rejected`: a aplicação provou ausência de terminal anterior e encontrou fonte alterada/ausente, histórico concorrente, conflito de comando ou expiração. Gravou um terminal sem capturas083 do lote.
- `empty`: o preparo não encontrou itens elegíveis naquela varredura limitada; preservou cursor e resíduos e gravou o terminal vazio.

O ciclo começa consultando o pendente. Se houver um, conserva seu ID, hash e UUIDs. Se não houver, cria um novo UUID de lote e chama preparo. Em seguida aplica o lote preparado e confirma o estado com GET. Qualquer ACK incerto interrompe o ciclo; a recuperação posterior consulta esse mesmo lote ou o pendente mais antigo. Repetir preparo com o mesmo UUID exige os mesmos ator, cursor e limite; repetir aplicação exige ator e hash originais. Resultados já confirmados são recuperáveis mesmo depois de expirar o lease, sem nova captura. Um erro SQL inesperado ou lock ocupado não grava terminal e mantém o preparo para recuperação. Nunca gerar UUIDs083 substitutos para resolver incerteza.

A seleção examina no máximo100 fontes ainda não capturadas por preparo, ordenadas lexicamente pelo ID exato, e para ao reunir o limite de até25 elegíveis. Somente observações aceitas pela083 e com captura de preços `bound` são elegíveis. Resíduos ficam ligados ao hash/versão da fonte e ao hash da captura de preços; a mesma identidade inválida é ignorada nas próximas varreduras. Uma alteração material dessa identidade permite reavaliação. A ausência de captura não é preenchida com preços inferidos.

`next_after` e `reached_end_of_pass` descrevem uma passagem. Um lote vazio pode ter avançado sobre100 resíduos e ainda haver fontes adiante. Fontes coletadas depois com IDs menores exigem novas passagens explícitas com `p_after=null`. Não filtrar por `first_seen_at`: uma fonte histórica legítima pode ter sido coletada apenas hoje. O chamador deve limitar lotes pelo prazo de execução e continuar enquanto a coleta está ativa.

O inventário separa `missing` global exato, `cached_invalid` e `unclassified_pending`; estes últimos ainda precisam ser classificados e não são uma contagem de elegíveis. `eligible_in_page` vale somente para a página devolvida, de até100 linhas. A finalização depende da coleta concluída e de nova leitura integral com `missing=0`, além da prova global de preservação dos históricos anteriores e da união exata dos novos recibos. Resíduos não resolvidos continuam sendo lacunas explícitas. `coverage_certified` permanece falso em todos os retornos.

Os contadores do checkpoint são operacionais. Se uma captura e seu terminal forem confirmados no banco, mas o checkpoint global inteiro se perder, a seleção seguinte já exclui as fontes capturadas e não as duplica; o contador pode ficar abaixo do total real. A auditoria final deve usar os ledgers093 e o inventário083, sem inferir conclusão a partir desses contadores.

Os locks novos usam `NOWAIT` ou `pg_try_advisory_xact_lock`. A aplicação adquire os mesmos locks de comandos e fontes da083 antes de chamar a rotina antiga, conserva leitura das fontes e da associação administrativa e protege o usuário referenciado. Lock ocupado retorna SQLSTATE `55P03`, sem substituir dados ou UUIDs. O lease perdido retorna `55000` e desfaz integralmente a transação. Mudança de fonte e expiração produzem rejeição durável quando a transação pode adquirir os locks e verificar o lease.

Verificação local:

```sh
source .cache/linux-tools/activate.sh
node --test --test-isolation=none --test-reporter=tap tools/migration/history-continuation-093.test.mjs
node tools/migration/history-continuation-postgres.mjs
```

O segundo comando cria e remove um cluster PostgreSQL17 próprio em diretório temporário privado, usando exclusivamente socket Unix e dados sintéticos. A instalação remota precisa de auditoria independente da baseline001–092, dos dois novos ledgers e das nove funções093, com ACK pósCOMMIT e readback; os testes locais não substituem essa auditoria.
