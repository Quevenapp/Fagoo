# Núcleo matemático de boleto

Pacote puro, sem rede, relógio implícito, banco de dados ou geração de PDF. Produz um candidato numérico e uma prévia SVG do código de barras para validação local. Nenhum módulo do ERP o chama nesta entrega.

**Itaú 109 está implementado. Inter 110 permanece bloqueado por uma lacuna na especificação oficial consultada.** Não há adaptação silenciosa para 112, campo livre arbitrário nem conversão do número de operação do retorno.

## Fontes primárias verificadas em 16/10/2026

- [Itaú CNAB 400](https://download.itau.com.br/bankline/layout_cobranca_400bytes_cnab_itau.pdf): §7.3.2 define posições do campo livre; anexos 2/3 tratam DVs; nota 23 e anexo 4 tratam nosso número; anexo 6 inclui a virada de 2025. O exemplo completo dos anexos usa carteira 110 e serve apenas de vetor da matemática comum, sem habilitar esse perfil na geração.
- [Inter CNAB 400 v2.2, 26/08/2024](https://s3.sa-east-1.amazonaws.com/static.bancointer.com.br/openbanking/cnab/manual/manual.pdf): §§6 e 7.3 descrevem 110 e seu DV, mas a tabela do campo livre §7.1.3 fixa 112 e operação de 7 posições. Ela remete ao retorno 381–394, descrito como 14 posições alfanuméricas. Não há regra comprovada de transformação entre esses campos. A existência de exemplos secundários não resolve essa diferença.
- [Caixa, especificações do boleto](https://www.caixa.gov.br/Downloads/cobranca-caixa/ESP_COD_BARRAS_SIGCB_COBRANCA_CAIXA.pdf): tabela do fator confirma 22/02/2025=1000, 21/12/2026=1667 e 13/10/2049=9999; usada como vetor independente de datas, não como layout Itaú/Inter.

Os formatos bancários, cálculos e tabelas são fatos técnicos dessas fontes. Nenhum PDF bancário foi copiado para o pacote. O contrato da conta e a homologação precisam ser conferidos separadamente; a versão pública do manual Itaú tem indicação de janeiro/2017.

## Interface

```ts
calculateDueFactor({dueOn, referenceOn}): string
calculateBarcodeDigit(base43: string): string
barcodeToDigitableLine(barcode44: string): {digits: string, formatted: string}
createBoletoDigits({purpose: 'offline-validation', profile, title, allocation})
createItau109BarcodePreview({purpose: 'offline-validation', profile, title, allocation})
```

`profile` usa os nomes do `cnab-core`: banco/layout/conta interna/agência/conta/DV/carteira/CNPJ/nome, contrato/referência e política simples. `title` tem somente `amountCents`, `dueOn` e `referenceOn`. `allocation` tem `ourNumber`, `confirmed:true` e referência explícita da conferência da alocação. Seu número é a base sem DV, com zeros à esquerda; nunca é escolhido, incrementado ou reservado pelo pacote. Essas declarações são entradas do chamador, não provas de cadastro, autorização ou alocação persistida.

O perfil é copiado por propriedades próprias de dados e validado com o código CNAB existente. Campos desconhecidos, accessors, valores implícitos e objetos não planos são recusados. A entrada `createBoletoDigits` não aceita juros, desconto, multa, moeda variável, PIX, vencimento vazio, valor aberto, pagamento parcial ou campo livre informado pelo chamador.

Uma entrada separada, `createItau109BoletoTermsCandidate({...boletoInput, collectionTerms})`, acrescenta a revisão explícita de juros/multa Itaú 109 sem alterar dígitos ou valor nominal. Ela aceita resolução ausente como pendência, nunca como taxa zero ou autorização. O [contrato offline dos encargos](../../packages/cnab-core/src/itau-terms.mjs) documenta a base mensal, arredondamento e datas que precisam de conferência. Não gera PDF, mensagens de protesto nem instruções bancárias. Todas as flags de emissão/registro/transmissão permanecem falsas.

Para Itaú 109, o pacote confere também o DAC agência/conta contra o cálculo referenciado na posição 41 do manual. Divergência devolve `BOLETO_ACCOUNT_DIGIT_MISMATCH`; não altera o dígito recebido. Uma eventual conta excepcional exigiria especificação e perfil próprios. O `cnab-core` e os cadastros existentes não foram modificados.

Inter 110 exige sintaticamente o perfil, a faixa reservada confirmada e a base dentro dela, mas a montagem termina em `BOLETO_INTER110_FIELD_LAYOUT_UNCONFIRMED`. Nem `operationNumber` nem um campo livre genérico são aceitos para contornar o bloqueio. O DV de nosso número 110 já está implementado e testado no `cnab-core`; isso não comprova o restante do boleto.

## Datas, valores e representação

O fator usa dias inteiros UTC. Parte de 1000 em 03/07/2000 e reinicia após 9999; 22/02/2025 volta a 1000. `referenceOn` é obrigatório, com janela de 3000 dias anteriores a 5500 posteriores. Não há inferência de uma data a partir de quatro dígitos, pois o fator se repete entre ciclos. O recorte aceita calendários de 2000–2099, a partir de 03/07/2000, com verificação real do dia/mês/ano.

Dinheiro é string canônica de centavos positivos, até 10 posições. O teto é `9999999999`; valores maiores são recusados, sem invadir o fator de vencimento. Itaú aceita a partir de 1 centavo neste núcleo; Inter conserva o mínimo de 250 centavos do perfil CNAB. Não usa ponto flutuante para valores. Datas e somas limitadas de dígitos usam inteiros exatos.

O candidato Itaú contém código de 44 dígitos, linha de 47 dígitos, versão formatada, campo livre, fator, valor e datas explícitos, nosso número com DV e pendências. Os objetos de saída são congelados.

`calculateBarcodeDigit` é aritmética sobre 43 posições, sem o DV geral. `barcodeToDigitableLine` confere comprimento, banco 341/077, moeda 9 e DV geral, depois reorganiza os campos. **Essa função não confere o contrato nem o conteúdo bancário do campo livre**; formatar um código recebido não o torna um boleto autorizado. Ela não é uma alternativa ao builder bloqueado do Inter.

## Limite de uso e próxima integração

`createItau109BarcodePreview` reutiliza todas as validações do candidato Itaú 109 e representa os mesmos 44 dígitos em Intercalado 2 de 5, sem acrescentar um dígito. Segue o §7.3 do manual: barras de 103 × 13 mm, com 5 mm de área branca em cada lado. O SVG mede 113 × 24 mm e mantém a advertência **PRÉVIA TÉCNICA — NÃO PAGAR** fora das barras. O aviso faz parte da prévia; não existe opção para removê-lo.

O desenho contém somente retângulos calculados a partir dos dígitos e texto fixo. Não incorpora nomes, referências, URLs ou marcação fornecidos pelo chamador. Os 405 módulos e as 114 barras foram comparados com um vetor de encoder independente e a prévia sintética foi renderizada para inspeção visual. Isso verifica a representação técnica, sem substituir a impressão completa e a homologação bancária. `fullBoletoRendered` e `printedLayoutValidatedByBank` continuam falsas; não há ficha de compensação, recibo do pagador, PDF ou título operacional associado.

As flags `bankRegistered`, `bankAcceptanceVerified`, `homologationVerified`, `numberAllocationVerified`, `financialMutationPerformed`, `bankTransmissionPerformed`, `canIssue` e `canTransmit` permanecem falsas. O pacote não consegue atestar registro, aceite, titularidade, exclusividade de numeração ou vínculo com um título real. Um código matematicamente correto pode corresponder a uma conta inexistente. Os dígitos bancários não contêm uma marca universal de ambiente de teste.

Para formalizar a futura emissão será necessário:

1. Priorizar Itaú 109: obter configuração bancária confirmada e conferir encargos/instruções com a evidência apropriada. Inter foi adiado e continua bloqueado; resolver seu campo livre exigirá uma etapa separada com fonte oficial, sem reduzir 14 posições para 7 por corte, conversão numérica ou remoção de zeros.
2. Vincular o candidato à reserva persistida de nosso número e à cópia imutável de conta/título/valor/vencimento do CNAB. `confirmed:true` local não substitui essa consulta autorizada. Manter números usados/reservados indisponíveis e coordenar a virada do emissor anterior.
3. Implementar PDF/representação gráfica, dados completos de beneficiário/pagador e vínculo com retorno de registro. Conferir o resultado com o banco no canal apropriado. Não deduzir aceite de um DV correto nem reenviar boletos legados.

A habilitação de qualquer carteira depende da especificação e do contrato bancário confirmados para a instalação; arquivos de sistemas anteriores não substituem essa confirmação.

## Testes

```sh
npm test --prefix packages/boleto-core
node --test packages/boleto-core/test/*.test.mjs packages/cnab-core/test/*.test.mjs
```

19 casos próprios passaram, incluindo quatro testes de desenho ITF. A regressão CNAB anterior teve 30 casos aprovados. A cobertura inclui vetores oficiais de DV/linha/nosso número, fator 2025/2049, calendário e janela, limite monetário, corrupção de DV, perfil incompleto, imutabilidade, Inter bloqueado e compatibilidade com a remessa CNAB sintética. O vetor público completo Itaú usa 110; o teste não o apresenta como comprovação de uma remessa 109 homologada. Nenhum dado bancário real, arquivo de produção, credencial ou endpoint é usado.
