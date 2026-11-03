# Rateio exato: matemática, sem decisão tributária

`src/allocation.mjs` é uma biblioteca pura, sem dependências, rede, SQL, UI, geração de XML ou numeração. Ela distribui um valor explícito de desconto, frete ou outras despesas entre itens identificados, conservando todos os centavos. A escolha da base e a definição do valor são decisões do chamador.

O algoritmo **não é apresentado como uma regra fiscal oficial de rateio**. Não escolhe CFOP, CST/CSOSN, regime, alíquota, incidência, base de cálculo, inclusão no total da nota ou tratamento tributário. Não calcula imposto, valor líquido da NF-e nem aptidão para emissão. Os limites numéricos escolhidos estão ancorados em campos do XSD local, mas nenhum XML é validado ou criado.

## Contrato

Importação direta durante a revisão, sem mudança nos exports públicos existentes:

```js
import { allocateFiscalAmount } from './src/allocation.mjs';

const result = allocateFiscalAmount({
  kind: 'freight',
  total_cents: '100',
  basis: { type: 'amount' },
  items: [
    { id: 'a0000000-0000-4000-8000-000000000003', weight: '1000' },
    { id: 'a0000000-0000-4000-8000-000000000001', weight: '1000' },
    { id: 'a0000000-0000-4000-8000-000000000002', weight: '1000' },
  ],
});
// allocated_cents, na mesma ordem: ['33', '34', '33'].
// O centavo de desempate pertence ao UUID ...001, não à primeira linha exibida.
```

Todos os valores monetários entram como **strings de centavos inteiros**, sem sinal, ponto, vírgula, expoente, espaços ou zeros iniciais. Zero é `'0'`; `null`, ausência e `Number` são rejeitados. O código usa `BigInt` em todas as operações de valor e peso. Tipos estão em `allocation.d.mts`.

| Campo | Valores e obrigação |
| --- | --- |
| `kind` | `'discount'`, `'freight'` ou `'other'`; obrigatório |
| `total_cents` | String de 0 a `999999999999999`; obrigatório |
| `basis` | Objeto com `type` obrigatório; `unit` somente na base `quantity` |
| `items` | De 1 a 250 linhas; ordem de saída igual à ordem de entrada |
| `items[].id` | UUID único de **linha**, não de produto/SKU; letras normalizadas para minúsculas |
| `items[].weight` | Obrigatório conforme a base; proibido em `equal` |
| `items[].unit` | Obrigatório somente em `quantity`; correspondência exata com `basis.unit` |
| `items[].discount_capacity_cents` | Obrigatório somente em `discount`; mesmo limite monetário de `total_cents` |

Campos desconhecidos são rejeitados. Repetir um produto em duas linhas exige dois UUIDs de linha distintos. A biblioteca não agrupa produtos ou altera vínculos.

### Bases explícitas

- `amount`: `weight` é um valor em centavos inteiros, até o limite monetário acima. O chamador decide se esse valor representa bruto, líquido comercial ou outra grandeza apropriada. A biblioteca não busca campos de um pedido.
- `quantity`: `weight` é uma quantidade decimal exata, até 12 inteiros e 6 casas. `basis.unit` e a unidade de cada item são obrigatórios e iguais. Não converte caixa em unidade, peso em volume nem mistura unidades.
- `manual`: `weight` é uma ponderação explicitamente fornecida, até 12 inteiros e 6 casas. A biblioteca não atribui significado fiscal ou físico a ela.
- `equal`: cada linha recebe peso 1 porque a base igualitária foi explicitamente escolhida. Não aceita peso informado e nunca é usada como fallback.

Unidades têm de 1 a 16 unidades de código UTF-16, sem controles, substitutos isolados ou espaços nas bordas. Texto Unicode é aceito e conservado. `PÇ`, `PC` e `PÇ` são comparados exatamente; não há conversão de caixa, transliteração ou normalização Unicode. Esses rótulos pertencem à base matemática e não são serializados como `uCom`/`uTrib`.

Pesos `1.23` e `1.230000` representam o mesmo valor. `0.000001` é aceito; uma sétima casa decimal é rejeitada, mesmo que seja zero. Não há arredondamento dos pesos. Pesos monetários usam escala 0; quantidade e ponderação manual usam escala 6. O resultado informa essa escala e os inteiros usados.

## Algoritmo e desempate

Algoritmo versionado: `largest-remainder-uuid-v1`.

1. Transforma pesos válidos em inteiros de escala comum, sem ponto flutuante.
2. Para cada item calcula `floor = (total_cents × weight_units) / weight_total_units`, usando divisão inteira, e guarda o resto da mesma divisão.
3. Soma os pisos. Distribui os centavos restantes, um por item, em ordem decrescente do resto.
4. Em restos iguais, o UUID canônico em ordem ASCII crescente decide. A posição do item na lista não influencia o desempate.
5. Confere a soma final e retorna as linhas na **ordem original**.

Linhas com peso zero recebem zero e nunca participam da distribuição do centavo restante. Se todos os pesos são zero, somente um total zero é aceito. Um total positivo gera `ALLOCATION_ZERO_BASIS`, sem dividir igualmente de forma implícita.

Cada componente é independente. Ratear um desconto não altera automaticamente os pesos de frete ou outras despesas. Para usar valores após desconto como uma nova base, o chamador precisa construir e escolher explicitamente essa base em outra chamada.

## Capacidade de desconto

O chamador fornece para cada linha a capacidade ainda disponível, já considerando quaisquer descontos anteriores relevantes. A biblioteca não identifica nem desconta lançamentos anteriores por conta própria.

Há duas rejeições distintas:

- `ALLOCATION_DISCOUNT_TOTAL_EXCEEDS_CAPACITY`: o desconto total excede a soma das capacidades dos itens com peso positivo. A capacidade de um item de peso zero não permite transferir desconto a ele.
- `ALLOCATION_DISCOUNT_ITEM_EXCEEDS_CAPACITY`: a parcela proporcional calculada, **incluindo seu eventual centavo de arredondamento**, excede a capacidade daquela linha. O erro identifica somente o UUID canônico do item.

O segundo erro pode ocorrer mesmo quando há capacidade total suficiente. Exemplo: desconto de 3 centavos, pesos iguais e capacidades de 1 e 2 centavos. Se o item de menor UUID tem capacidade 1, ele receberia 2 pelo desempate e a operação é rejeitada. A biblioteca **não limita essa linha e redistribui o restante**, pois isso mudaria a regra proporcional escolhida. O chamador deve revisar explicitamente o valor, a base ou a política em um fluxo futuro. Não existe resultado parcial ou líquido negativo oculto.

## Resultado e fronteiras de confiança

O resultado inclui:

- Identificação de algoritmo, tipo de encargo, base, escala e soma dos pesos inteiros.
- `total_cents`, `allocated_total_cents` idênticos e `undistributed_cents: '0'`.
- Por item: UUID, `weight_units`, `floor_cents`, `remainder_numerator`, `rounding_cent` (`'0'` ou `'1'`), `allocated_cents` e a capacidade explícita de desconto quando aplicável.

O denominador de `remainder_numerator` é `basis.weight_total_units`. Os campos de cálculo são strings e permitem conferir a conta sem depender de `Number`. Não são campos XML e não devem ser enviados diretamente à SEFAZ.

As flags permanecem `operational_effects:false`, `emission_enabled:false`, `can_emit:false`, `tax_rules_validated:false` e `xsd_validated:false`. Dados de entrada não são modificados e não há relógio, sorteio ou IO. A execução é determinística. Erros usam códigos constantes e, quando pertinente, somente um UUID validado; não ecoam valores ou textos inválidos.

O consumidor futuro ainda deverá vincular o resultado à revisão exata do documento e às decisões explícitas de base, com autorização, controle de versão e auditoria. A biblioteca não é um mecanismo de persistência, conciliação bancária ou comprovação fiscal.

## Limites observados no XSD

O perfil local é o [PL 010f v1.04 do Portal Nacional da NF-e](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=8ITFuBLltXs=), preservado em `../fiscal-schema/schemas/pl010f-v1.04/` com manifesto e hashes.

O tipo `TDec_1302` comporta até 13 inteiros e 2 decimais. Os totais `vDesc`, `vFrete` e `vOutro` usam esse tipo; os campos correspondentes de item usam `TDec_1302Opc`. Por isso o componente matemático limita cada valor monetário informado a `9.999.999.999.999,99`, representado por `'999999999999999'` centavos.

O limite de 250 linhas e as escalas de peso são políticas desta biblioteca, alinhadas ao documento comercial do ERP. Não são declarações sobre o limite legal de itens ou todas as regras de uma NF-e/NFC-e. A soma dos pesos é uma grandeza de cálculo e não é apresentada como `vProd` ou total fiscal válido. Cabe a uma futura montagem XML decidir campos opcionais, totais, incidência, consistência do documento e perfil vigente.

## Testes

```sh
node --test packages/fiscal-core/test/allocation.test.mjs
```

Fixtures exclusivamente fictícias. Cobertura: resultado conhecido, desempate, 120 permutações dos mesmos cinco itens, 100 conjuntos gerados deterministicamente, soma exata, piso/teto de cada parcela, invariância por escala comum dos pesos, zero, capacidade de desconto, 250/251 linhas, dinheiro máximo, multiplicações acima da precisão de `Number`, Unicode e unidades divergentes, tipos inválidos, arrays esparsos, não alteração de entrada e vínculo dos limites aos XSDs preservados.

Nenhum export existente, schema, módulo de UI ou processo de emissão foi conectado a esta biblioteca nesta etapa.
