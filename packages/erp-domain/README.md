# Núcleo de documentos ERP

Biblioteca ESM sem dependências para validar documentos próprios e calcular valores com `BigInt`. O contrato SQL correspondente está em `supabase/migrations/202610160008_erp_documents.sql`; o teste PGlite compara os dois resultados integralmente em cenários de arredondamento.

Exports: `KINDS`, `STATES` (códigos/rótulos), `INITIAL_STATE`, `TRANSITIONS`, `canEdit`, `checkTransition`, `calculateDocument`, `normalizeDocument`, `decimal`, `format`, `DocumentError`. Entradas financeiras são strings decimais; não converter valores em `Number`. O pacote não acessa rede, banco, certificado, contas ou estoque.

```js
import { normalizeDocument } from './src/index.mjs';

const planned = normalizeDocument('sales_proposals', {
  date: '2026-10-16',
  contact_id: '11111111-1111-4111-8111-111111111111', // exemplo sintético
  items: [{ description: 'Item de exemplo', unit: 'UN', quantity: '3', unit_price: '1.005', discount_percent: '10' }],
  discount_mode: 'percent', discount_value: '5', freight: '1.20', other_expenses: '0.30',
});
// planned.totals.total === '4.08'
```

Arredondamento half-up: primeiro quantidade × preço em duas casas por item; desconto percentual do item sobre esse bruto em centavos; soma dos líquidos; desconto global sobre a soma líquida; depois frete e outras despesas. Desconto global não incide sobre frete nesta versão. Não há rateio fiscal de descontos ou cálculo tributário.

O resultado normalizado tem campos calculados e não deve ser enviado integralmente como novo `p_body`: o contrato de escrita aceita somente campos de entrada. Preserve IDs de itens ao editar; envie valores e campos calculados apenas em componentes de visualização.

Limites e RPCs: [contrato dos documentos](../../docs/integrations/erp-documents-rpc.md). Testes:

```sh
node --test packages/erp-domain/test/*.test.mjs tools/migration/test_documents_sql.mjs
```
