# Fundação de cobrança CNAB 400

Biblioteca de domínio local, ESM, sem dependências de rede. Lê retornos e codifica remessas. A entrada original `generateRemittance` permanece **somente para homologação**, reutilizada pelo [módulo014](../../workers/erp-api/src/cnab.mjs). A entrada separada `generateOperationalRemittance` atende à [orquestração042 com autorização persistente](../../workers/erp-api/src/cnab-operational.mjs); o encoder puro não concede autorização. A biblioteca permanece independente de rede e persistência. Não envia arquivos, registra boletos, cancela cobranças ou liquida títulos. Todos os testes usam dados sintéticos.

## Compatibilidade verificada em 16/10/2026

O **Inter oferece CNAB 400 para cobrança**; seu CNAB 240 atende outros serviços. Isso está separado na [página oficial de integrações](https://inter.co/empresas/integracoes-para-empresas/). O [artigo de ajuda](https://ajuda.inter.co/conta-digital-pessoa-juridica/como-emitir-boletos-de-cobranca-pelo-arquivo-cnab400) descreve o envio manual de `.REM` e a obtenção do retorno pelo Internet Banking PJ. Não é necessária integração por API para esse fluxo.

| Banco | Perfil implementado | Fonte oficial e pontos usados |
|---|---|---|
| Itaú 341 | Carteira 109; cobrança direta simples; tipo 1 e multa tipo 2 opt-in | [Manual CNAB 400, janeiro/2017](https://download.itau.com.br/bankline/layout_cobranca_400bytes_cnab_itau.pdf), pp. 7–9, 12–14, 17: posições; notas 3/5/11/12/17/21/35: nosso número, carteira, instruções, ocorrências, totais e multa; anexo 4, pp. 56–57: DAC. O arquivo público é antigo: a vigência do contrato e do layout da conta precisa ser confirmada com o banco. |
| Inter 077 | Carteiras 112 e 110; tipo 1 | [Manual CNAB 400 v2.2, 26/08/2024](https://s3.sa-east-1.amazonaws.com/static.bancointer.com.br/openbanking/cnab/manual/manual.pdf), §§4–5, pp. 7–17: remessa/retorno; §7.3, p. 26: DAC de nosso número da carteira 110. A 112 recebe o número do banco; a 110 exige faixa reservada. A [FAQ oficial](https://developers.inter.co/duvidas-frequentes) confirma essa diferença e que a cobrança não depende de código de cedente. |

No Itaú, `06` identifica liquidação normal e `07` liquidação parcial B2B. No Inter, `06` é pago e `07` cancelado. O código nunca é interpretado fora do banco correspondente. Os totais de carteira do trailer Itaú representam carteira bancária, não apenas os títulos presentes no arquivo.

O manual Inter contém divergências editoriais: comprimentos incompatíveis com os intervalos de posições; a linha de agregados de pagos do trailer menciona `04`, enquanto o detalhe define `06`. O parser segue as posições e a descrição de liquidação, registra avisos, preserva os campos originais e confere contagens `02/03/06`. Se nominal e recebido divergirem, não escolhe uma fórmula presumida para o agregado; exige revisão. Essa interpretação precisa ser confirmada com retorno homologado do banco antes de operação.

## Contratos e limites desta implementação

- `generateRemittance({profile,titles,generatedOn,remittanceSequence,purpose:'homologation'})`: retorna `Uint8Array`, SHA-256, nome e manifesto. Aceita de 1 a 30 títulos, ocorrência de entrada `01`, duplicata mercantil; o contrato legado permanece sem juros, multa, desconto, rateio, mensagens ou avalista. O campo opt-in `collectionTerms`, somente Itaú 109, exige resolução explícita e permite juros diários + multa tipo 2 conforme o [contrato de encargos offline](../../packages/cnab-core/src/itau-terms.mjs). Outros campos desconhecidos são recusados. A escolha de 30 é o teto conservador dos testes Itaú aplicado a ambos.
- `generateOperationalRemittance({...sameInput,purpose:'operational'})`: mesma validação e posições, com nome Itaú `ITAU_COBRANCA_...REM`; Inter preserva nome canônico. Só a aplicação042 confere aprovação, CAS/hash da prévia e reserva persistente. `productionReady:false`, `originAuthenticated:false` e ausência de transmissão/mutação financeira não certificam homologação. O limite conservador de30 continua nesta etapa.
- Itaú: instruções explícitas `10` e `47` inibem protesto e dispensam juros/comissão; valores zerados isolados poderiam herdar configuração da conta. Inter: flags sem multa/juros/desconto; dias para pagamento após vencimento obrigatórios, de 1 a 60. Sua data de emissão fica em branco no arquivo, conforme manual; `issuedOn` é apenas validado no domínio.
- Itaú opt-in: `prepareItau109Terms` conserva a taxa mensal/tolerância observadas e devolve pendências até receber base, arredondamento, centavos e datas conferidos. O perfil limitado é 1% mensal, multa de 2%, tolerância de 1 dia e desconto zero; usa `10+44`, sem habilitar protesto, e adiciona um tipo 2 por título. A política é diferente de instruções ausentes na origem e não alega homologação. O encoder e o candidato de boleto preservam o nominal. Não há ligação com a API ou persistência atual.
- `parseReturn(bytes,{profile,century:2000})`: valida todo o arquivo antes de devolver eventos. Somente header, detalhe tipo 1 e trailer dos perfis listados. Rateios, cheques Itaú (`69/76`) e estruturas adicionais são recusados. Ocorrências Itaú não mapeadas permanecem pendências de revisão; ocorrências Inter não documentadas são recusadas.
- `planReturnReconciliation({parsed,titles,evidence,seenFileHashes,seenEventHashes})`: devolve propostas de revisão. **`canSettle` e `financialMutationPerformed` são sempre `false`**, inclusive em correspondência exata.
- `verifyOperationalReturnEvent({bytes,profile,century,fileHash,eventHash,lineHash,line,payload,fileWarnings,generatedOn})`: reprocessa bytes privados e confere a correspondência exata com a evidência persistida. Retorna `bytesVerified:true`, mantendo `originAuthenticated:false` e `financialMutationPerformed:false`. Não aceita um objeto previamente marcado como validado em lugar do arquivo. A [orquestração043](../../workers/erp-api/src/cnab-returns.mjs) acrescenta autorização, vínculos e transação financeira; essa função pura não concede permissão nem baixa títulos.

O perfil contém `bank`, identificador `layout` de `LAYOUTS`, `accountId` interno, agência, conta, dígito, CNPJ e carteira. A geração exige ainda `companyName`, `contractVerified:true`, `agreementReference` e `simpleCollectionPolicyVerified:true`; Inter 110 exige `reservedRange:{verified:true,start,end}`. Essas afirmações devem vir de configuração privada revisada, nunca de parâmetros livres do navegador. Não existe campo de convênio universal inventado: a referência ao contrato é metadado interno, e a identificação gravada segue cada layout. Agência/conta/DV são conferidos contra o perfil bancário; não foi presumida uma fórmula de DAC de conta corrente.

Os DVs documentados de nosso número são calculados: Itaú 109 usa agência+conta+carteira+8 posições; Inter 110 usa `0001`+`110`+10 posições, módulo 10. O teste Itaú reproduz o exemplo oficial da carteira 110 apenas para validar o algoritmo; a geração Itaú continua restrita à 109. Para Inter 112, o número de 11 posições é atribuído pelo banco, sem algoritmo local presumido. No manifesto e nos eventos, `ourNumber` inclui o DV: 9 posições Itaú, 11 Inter. Na entrada do gerador, informar a base sem DV (8/10), ou omitir na carteira 112.

Textos são ASCII imprimível em caixa alta, sem transliteração ou corte silencioso. CPF/CNPJ numéricos têm DV validado na remessa. CNPJ alfanumérico não é aceito nestas versões de CNAB. Arquivos com BOM, acentos multibyte, tabulações, controles, linhas curtas/longas ou quebras misturadas são recusados. Cada registro possui exatamente 400 bytes; a geração usa CRLF, e o leitor aceita CRLF ou LF consistentes. Limite: 10.000 registros/4.020.000 bytes. Sequência de registros obrigatória de `000001` até o trailer.

Valores são strings de **centavos inteiros**, por exemplo `'12345'` para R$ 123,45, calculados com `BigInt`; números JavaScript, vírgulas, pontos e arredondamento implícito são recusados. Datas são validadas pelo calendário. O ano de dois dígitos usa século explícito (padrão 2000); arquivos históricos precisam da configuração correspondente. Geração e snapshots para conciliação estão limitados a 2000–2099.

## Evidência, idempotência e conciliação

SHA-256 comprova integridade, não a origem bancária. O retorno declara `originAuthenticated:false`. A aplicação receptora deve guardar o arquivo privado original e registrar a procedência da obtenção autenticada. `evidence` exige `source:'authenticated-bank-download'`, `fileHash`, `accountId`, `reviewedBy` e `referenceId`; essa estrutura é uma declaração do chamador confiável, não uma verificação criptográfica do banco.

Cada evento carrega hash canônico, hash da linha e número da linha. O resultado do parser é congelado recursivamente e atestado internamente com `WeakSet`; a conciliação recusa clones e objetos construídos apenas com `validated:true`. Ao recarregar dados, é obrigatório reprocessar o arquivo bruto. O hash canônico exclui sequência/geração do arquivo e inclui banco/conta/carteira, referências, ocorrência, datas, valores e evidências específicas. Reentrega em arquivo diferente não gera outra proposta. Não descarte o arquivo bruto ao detectar repetição: eventos bancários indistinguíveis podem exigir conferência, especialmente pagamentos parciais Itaú sem identificador único de transação.

É exigida correspondência única por escopo da conta, controle interno, número do documento, nosso número, valor e vencimento. Nome, CPF ou valor isolados nunca associam título. Pagamento sem nosso número previamente vinculado fica pendente; retorno `02` da carteira Inter 112 pode apenas propor o vínculo. Valores divergentes, tarifas, datas de crédito ausentes, saldos parciais, baixas e cancelamentos exigem revisão.

A aplicação futura deverá persistir unicidade por `(accountScope,fileHash)` e `(accountScope,eventHash)`, bloquear concorrência e salvar revisão/lançamentos numa única transação. Este pacote não oferece armazenamento, lock, autorização ou uma função de baixa. O hash não substitui essas garantias.

## Homologação e pendências

Os arquivos não possuem uma marca universal de ambiente de teste: `purpose` é uma proteção local. **Nunca enviar os testes sintéticos a uma área bancária de produção.** Confirmar cadastro da cobrança, carteira, conta/DV, contrato, instruções permanentes, faixa/alocação única de nosso número e sequência de remessas. A biblioteca só detecta duplicidade dentro da remessa; reserva persistente e prevenção de reutilização entre arquivos pertencem à aplicação.

Validar arquivos no canal de homologação de cada banco e obter retornos correspondentes, inclusive registro, rejeição, liquidação, diferença de valor e cancelamento. Resolver as divergências do trailer Inter e confirmar o manual contratado Itaú. Não foram realizados homologação, emissão de boleto/PDF, cálculo de código de barras/linha digitável, transmissão ou movimentação financeira.

```sh
npm test --prefix packages/cnab-core
```

Os testes usam apenas nomes e identificadores construídos para teste, com DVs sintéticos. Não leem contas privadas nem backups de instalações. `primitives.mjs` reutiliza exclusivamente a função local de validação de CNPJ de `../fiscal-core`.
