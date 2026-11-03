# Prévia imprimível Itaú 109

Pacote local que monta um espécime completo com recibo do pagador e ficha de compensação. Todas as partes exibem **NÃO PAGAR**. Não cria cobrança, reserva número, consulta banco, altera cadastro ou transmite remessa. Nenhum dado real foi usado nos testes.

`createItau109PrintPreview(input)` é assíncrona apenas para calcular SHA-256 do HTML. Antes do primeiro `await`, captura os objetos, valida os dados e monta conteúdo e vínculo. Rejeita campos extras, accessors, protótipos personalizados, controles, caracteres bidirecionais e textos fora dos limites. Não normaliza nem trunca valores.

## Entrada e vínculo

```js
import { createItau109PrintPreview } from './src/index.mjs';
import { fixture } from './test/fixtures.mjs';
const preview = await createItau109PrintPreview(fixture());
```

- `purpose`: `offline-print-preview`.
- `boleto`: entrada exata do boleto-core, restrita a Itaú 341, carteira 109. As declarações de contrato e numeração exigidas pelo core continuam sendo declarações do chamador, sem verificação bancária. Beneficiário, CNPJ, agência, conta, valor nominal, vencimento, nosso número, linha digitável e barras derivam desta única entrada.
- `document`: `number` com até 10 caracteres alfanuméricos, ponto, barra ou hífen; `issuedOn` e `processedOn` explícitos. Emissão não pode superar processamento ou vencimento. Processamento deve ser igual à data de referência explícita do fator de vencimento. Não existe relógio implícito.
- `beneficiaryAddress`: `address` até 60 caracteres, `neighborhood` até 20, `city` até 40, `state` como UF e `postalCode` com oito dígitos não nulos.
- `payer`: mesmo endereço, mais `name` até 60 caracteres e `type`/`document` (`01`/CPF ou `02`/CNPJ, com dígitos conferidos). Não prova titularidade ou vínculo cadastral.

Textos aceitam letras latinas, espaços e pontuação simples, preservados literalmente com escape HTML. Campos não comportados são recusados. Não há entrada para HTML, CSS, SVG, link, instrução, taxa, desconto, protesto, beneficiário final ou avalista. O primeiro perfil limita-se à cobrança simples nominal do próprio beneficiário; não representa cessão ou operação por terceiro.

O retorno contém `html`, `htmlHash`, `sizeBytes`, `binding`, `dimensions`, perfil `itau109-print-preview-v1` e pendências. `fullBoletoRendered:true` indica somente presença das duas partes do espécime. `printedLayoutValidatedByBank`, `bankRegistered`, `bankAcceptanceVerified`, `homologationVerified`, `numberAllocationVerified`, `financialMutationPerformed`, `bankTransmissionPerformed`, `canIssue`, `canTransmit` e `canPay` permanecem `false`.

`binding` descreve os dígitos, valor nominal, datas, nosso número e número documental efetivamente impressos. Não é prova de origem bancária. O SHA refere-se aos bytes UTF-8 do HTML, não a um eventual PDF. O HTML tem limite de 128 KiB, CSP fechada, nenhuma fonte/recurso remoto, script, formulário, navegação ou ação automática de impressão.

## Layout e fonte primária

Base: [manual público Itaú CNAB400](https://download.itau.com.br/bankline/layout_cobranca_400bytes_cnab_itau.pdf), versão impressa de janeiro de 2017, consultado em 16/10/2026. A consulta confirma o documento disponível, sem afirmar homologação atual do espécime.

- §7.2, página 48: dimensões da ficha, posição inferior na A4 e submissão do modelo ao banco.
- §§7.3.2–7.3.4, páginas 49–50: campos do código e dimensões físicas.
- Página 51: apresentação da linha digitável.
- Anexo 1, páginas 52–54: disposição e descrição dos campos.

A4 com margens de 10 mm; cada parte mede 190 × 104 mm. A ficha de compensação fica na base da área imprimível. O SVG vem diretamente do boleto-core: barras ITF de 103 × 13 mm, zona branca lateral de 5 mm, sem redimensionamento adaptativo. O centro das barras fica a 13,5 mm da base da ficha. A linha usa fonte de 3,5 mm. Textos declarados usam fonte monoespaçada e limites que cabem nas células; não existe ocultação de overflow como solução para conteúdo excedente.

Nome textual do banco, sem reproduzir logotipo oficial. Isso e toda a aparência permanecem sujeitos à homologação visual. A instrução de pagamento é substituída por aviso de teste. A página 53 restringe encargos nas instruções, enquanto a 54 apresenta exemplos condicionais: este pacote não resolve essa ambiguidade nem infere juros, multa, tolerância ou protesto. Campos de desconto, encargos e valor pago ficam em branco; nunca são convertidos silenciosamente em zero. Somente o valor nominal aparece no código e no campo principal.

Para a prova local, imprimir A4 a 100%, sem cabeçalho/rodapé do navegador. Validação de medidas em PDF é apenas evidência do renderizador local, não aceite bancário nem garantia da escala física de outra impressora.

## Verificação

```sh
node --test packages/boleto-preview/test/preview.test.mjs
```

Fixtures são inteiramente sintéticas. Testes conferem vínculo de ambos os recibos, precisão dos centavos, fator, SVG original, SHA/tamanho, injeção, limites, calendário, formas de entrada, gates e mutação dos dados durante o hash. A prova visual deve incluir fixture usual e fixture nos limites de texto, uma página cada, sem cortes ou sobreposições.

Exportação reproduzível das duas fixtures, sem abrir navegador e sem sobrescrever arquivos existentes:

```sh
node packages/boleto-preview/tools/render-fixtures.mjs /caminho/local/novo-diretorio
```

Para gerar PDF no Chrome local, utilizar perfil temporário exclusivo, `--headless`, `--no-pdf-header-footer` e `--print-to-pdf`, apontando apenas para o HTML local. Não reutilizar perfil de navegação autenticado. Após renderizar e inspecionar as duas páginas, a medição vetorial opcional usa `pdfplumber` já disponível no ambiente:

```sh
python packages/boleto-preview/test/measure-pdf.py /caminho/standard.pdf /caminho/dense.pdf
```

Verificação local de 16/10/2026: 10/10 testes do pacote; revisão independente da raiz com 29/29 testes combinados core + prévia. Chrome local 155 produziu duas páginas A4 individuais, sem JavaScript ou formulários PDF. As duas imagens foram inspecionadas: sem corte ou sobreposição, incluindo os limites de texto. Medição das 114 barras: aproximadamente 102,994 × 12,999 mm; zonas brancas de aproximadamente 5 mm; centro a aproximadamente 13,5 mm da base da ficha. Arredondamentos submilimétricos são do renderizador. Artefatos e log de revisão estão no diretório temporário local `brufap-boleto-preview-20261016` e no log `brufap-boleto-preview-root-review.log`; não fazem parte do pacote versionado.

Nenhuma API, tela ERP, perfil persistido, contador, PDF bancário real, banco de dados ou integração Inter foi alterado.
