# Preparação explícita dos identificadores fiscais dos itens

Biblioteca pura local em `src/item-preparation.mjs`, perfil `item-identification-v1`. Não está exportada pelo entrypoint do pacote. A persistência SQL, a fachada HTTP e a interface da migração 035 estão descritas no [contrato de persistência](../../docs/integrations/fiscal-item-preparation.md), que registra o estado da integração e validação. A biblioteca continua sem IO, geração ou transmissão fiscal.

O primeiro recorte permite preparar NCM, origem, CEST, GTIN comercial e GTIN tributário, com escolha explícita por campo e item. CFOP, CST/CSOSN, enquadramento, alíquotas e grupos tributários permanecem pendentes. Preços, quantidades, descontos, valores totais e número comercial não são editáveis nesta operação.

## Contrato puro

```js
const prepared = prepareFiscalItems({
  basis, // base da conferência 029, obtida no servidor
  expected: {
    draft_id: 'a0000000-0000-4000-8000-000000000001',
    draft_version: 1,
    snapshot_hash: 'a'.repeat(64),
  },
  decisions: [{
    item_id: 'e0000000-0000-4000-8000-000000000001',
    fields: {
      ncm: {source: 'manual', value: '12345678'}, // exemplo sintético, sem classificação atestada
      origin: {
        source: 'catalog',
        expected_product_id: 'd0000000-0000-4000-8000-000000000001',
        expected_version: 2,
      },
      gtin: {source: 'manual', value: 'SEM GTIN'},
      cest: {source: 'manual', value: null},
    },
  }],
});
```

`basis` passa pela validação matemática e estrutural da 029. O vínculo exige igualdade entre os IDs, versão e hash declarados e aqueles da base. Isso **não recalcula nem autentica o hash do snapshot**: a persistência 035 carrega a revisão original sob autorização e confere sua versão/hash. O navegador não pode fornecer uma base autoritativa, produto atual ou proveniência já resolvida.

Até 250 itens na base e até 250 decisões, sem IDs repetidos ou alheios à revisão. Os UUIDs usam a forma canônica em minúsculas. Cada decisão contém ao menos um dos cinco campos permitidos. Campos desconhecidos, valores numéricos em vez de strings, arrays esparsos e dados extras na escolha são recusados.

Cada campo tem uma escolha independente:

| Escolha | Resultado |
|---|---|
| Ausente de `decisions` | `value: null`, proveniência `unreviewed`, pendência mantida. Nada é copiado do histórico nem do catálogo. |
| `manual` | Usa exatamente a string ou `null` explicitamente fornecido. Não apara espaços, completa zeros ou normaliza códigos. |
| `catalog` | Confere produto ligado ao item e versão exata do cadastro atual. Só então captura o campo, ID, versão e estado ativo do catálogo. Não aceita um valor do navegador junto com a escolha. |

Produto indisponível, ID diferente ou versão desatualizada faz a preparação falhar por inteiro; não existe fallback para nome, SKU ou outro cadastro. A versão mais recente pode diferir da versão no pedido: a captura explícita fica separada do snapshot histórico. Um catálogo inativo continua identificado pela proveniência e pelo diagnóstico 029, sem afirmar elegibilidade de emissão. Item livre admite somente decisões manuais e continua marcado para revisão própria.

`null` mantém a pendência, inclusive para CEST. Não significa “inaplicável”. `SEM GTIN` precisa ser escolhido literalmente ou confirmado como valor de uma versão do catálogo; campo vazio nunca recebe esse valor automaticamente.

## Resultado e limites

O resultado contém:

- `binding`: ID/versão/hash do rascunho, modelo 55/65, ambiente 2 e vínculo ao pedido de origem.
- `commercial`: número, data e valores do snapshot comercial, preservados como strings decimais. Não há arredondamento nem conversão para ponto flutuante.
- `items`: na ordem comercial original, com valor, proveniência, informação de verificação de dígito e pendências por campo/item.
- `snapshot_findings`: diagnósticos 029 originais, que continuam descrevendo o snapshot. A preparação não apaga, por exemplo, o fato de que a origem não estava capturada naquele histórico.
- `pending`: dependências de operação, pagamento, tributos e XML; mudanças de pedido/empresa, cancelamento, revisão histórica e arquivamento continuam identificados.

`operational_effects`, `emission_enabled`, `can_emit`, `tax_rules_validated`, `xsd_validated` e `catalog_registry_verified` são sempre `false`. Identificadores preenchidos não produzem estado “pronto para emitir”. Uma chamada pura pode reconstruir uma proposta para revisão histórica, mas isso não autoriza gravá-la; a API 035 permite novas decisões somente na revisão atual de um rascunho em preparação.

| Campo | Verificação implementada | O que permanece sem verificação |
|---|---|---|
| NCM | Exatamente 2 ou 8 dígitos conforme XSD local. Dois dígitos geram pendência própria de exceção. | Classificação, existência/vigência, aplicabilidade da exceção e operação. |
| Origem | Enum estrutural `Torig`: strings 0–8 do perfil versionado. | Origem efetiva da mercadoria e seu enquadramento. |
| CEST | Exatamente 7 dígitos quando informado. | Classificação, vigência, sujeição e aplicabilidade. |
| GTIN / GTIN tributário | 8, 12, 13 ou 14 dígitos e verificação matemática do último dígito; ou escolha explícita `SEM GTIN`. Zeros à esquerda são preservados. | Atribuição pela GS1, cadastro externo, identidade do produto e relação com a unidade tributária. |

O dígito GTIN usa apenas aritmética inteira: a partir do último dígito do corpo, pesos 3 e 1 alternados; o complemento da soma para múltiplo de 10 é comparado ao dígito final. A verificação segue a [explicação oficial da GS1](https://www.gs1.org/services/how-calculate-check-digit-manually). Mesmo uma sequência que satisfaça essa conta não comprova atribuição do código; o registro externo permanece não verificado.

Os formatos e a enumeração foram conferidos no [leiaute oficial local PL010f v1.04](../fiscal-schema/schemas/pl010f-v1.04/leiauteNFe_v4.00.xsd), com origem e hashes no [manifesto](../fiscal-schema/schemas/pl010f-v1.04/manifest.json). O XSD também permite GTIN vazio; este contrato usa `null` para ausência e conserva a pendência. Validar esses campos isoladamente não equivale a validar um XML completo.

## Encaixe na 035

A extensão persistente tem uma preparação com versão própria, vinculada à tripla `(draft_id, draft_version, snapshot_hash)`, e revisões imutáveis contendo os valores normalizados e sua proveniência. Ela não altera o corpo/snapshot da 022. Uma interface futura poderá exibir ambas as fontes lado a lado.

O comando exige administrador/fiscal ativo, `command_id`, versão CAS da preparação e a tripla de origem. A ordem é comando próprio → pedido comercial `FOR SHARE` → rascunho 022 `FOR UPDATE` → preparação → cadastros dos produtos, ordenados por UUID. Essa ordem respeita o pai antes do rascunho, como na 022.

Uma RPC não mantém seus locks depois de retornar ao Worker. Por isso, a gravação resolve as escolhas e repete os validadores estruturais **no SQL, dentro da mesma transação**, relendo os cadastros sob locks antes de gravar revisão/auditoria. Os testes comparam os validadores SQL e esta biblioteca. Uma prévia feita em JavaScript pode orientar a conferência, mas não substitui essa revalidação; o save não aceita `catalog`, valores resolvidos ou proveniência enviados pelo cliente.

Atualizar a cópia na 022 cria uma nova revisão de rascunho e deixa a preparação anterior como histórica. Nenhuma decisão é carregada automaticamente para a nova revisão. Repetir um comando retorna o recibo histórico, após revalidar acesso; a UI ainda precisa consultar o estado atual. A leitura histórica usa os valores/proveniências persistidos, não refaz a captura contra o catálogo atual. Não haverá edição retroativa nem regeneração silenciosa do histórico.

O rateio matemático em `allocation.mjs` é independente e não é aplicado aqui. Preparar identificadores não escolhe base de rateio, incidência, tributos, unidade tributária, código de pagamento nem regras de NFC-e.

## Validação local

```sh
node --test packages/fiscal-core/test/item-preparation.test.mjs
node --test packages/fiscal-core/test/*.test.mjs
```

Os testes usam dados sintéticos: vínculo exato de revisão/hash, item duplicado/alheio, versão de produto alterada, item livre, ordens permutadas, 250 itens, ausência de mutação do input, preservação decimal/Unicode, GTIN de diversos comprimentos e zeros à esquerda, limites/enum do XSD local, CEST nulo, revisão histórica e flags sempre desabilitados. Nenhuma conexão à SEFAZ, catálogo GS1, banco ou conta real é feita pelos testes.
