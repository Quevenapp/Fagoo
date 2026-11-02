# Configuração bancária e CNAB

O FAGOO armazena perfis bancários por empresa e oferece prévias locais de remessa de cobrança e leitura de retorno. O estado persistido é `pending_homologation`. Não há transmissão bancária, registro operacional de boleto, pagamento de fornecedores ou baixa automática de títulos nesta versão.

Os layouts implementados são Itaú 341, CNAB400 janeiro/2017, carteira 109; e Inter 077, CNAB400 v2.2 de 26/08/2024, carteiras 110 e 112. Cada cliente precisa confirmar com o próprio banco a vigência do layout, o convênio, a carteira e a homologação. A declaração do operador não constitui autenticação pelo banco. Não há suporte genérico a CNAB240 ou a outros bancos.

Todas as rotas exigem autenticação. Configuração exige `system:write`; listagem e leitura de retorno exigem `finance:read`; prévia de remessa exige `finance:write`. A empresa é derivada da identidade autenticada. Configuração e remessa usam `command_id` UUID, com resultado persistido e proteção contra repetição; alterações e prévias exigem `expected_version` do perfil.

| Método | Caminho | Função |
|---|---|---|
| GET | `/api/v1/banking/cnab/profiles` | Lista perfis, layouts e capacidades |
| POST | `/api/v1/banking/cnab/profiles` | Cadastra perfil da empresa |
| PATCH | `/api/v1/banking/cnab/profiles/{id}` | Substitui configuração com versão esperada |
| POST | `/api/v1/banking/cnab/profiles/{id}/remittance-preview` | Gera arquivo para revisão/homologação |
| POST | `/api/v1/banking/cnab/profiles/{id}/return-preview` | Valida integralmente e interpreta retorno |

O cadastro recebe `command_id`, `name`, `configuration` e opcional `active`; PATCH também recebe `expected_version`. A configuração contém `bank`, `layout`, `agency`, `account`, `accountDigit`, `wallet`, `cnpj`, `accountId`, `companyName`, `contractVerified`, `agreementReference` e `simpleCollectionPolicyVerified`. Campos de agência/conta e documentos são strings. O CNPJ deve coincidir com o cadastrado em `/api/v1/company/fiscal`. Esses layouts aceitam somente CNPJ numérico. `companyName` deve estar em ASCII maiúsculo, até 30 caracteres. Os booleanos representam declarações do operador e nunca promovem o perfil para homologado.

Itaú usa agência de 4 dígitos, conta de 5 e dígito de 1; Inter usa agência `0001`, conta de 9 e dígito de 1. Para Inter110, incluir `reservedRange: { verified: true, start: "0000000001", end: "0000000099" }` com a faixa efetivamente reservada pelo banco antes da geração. Inter112 recebe o número atribuído pelo banco; não enviar `ourNumber` na remessa.

A prévia de remessa recebe `command_id`, `expected_version`, `generated_on` (data ISO), `remittance_sequence` (string inteira positiva) e `titles` (1 a 30). Cada título contém `id`, `control` (até25 ASCII maiúsculos), `documentNumber` (até10), `amountCents` (centavos inteiros em string), `issuedOn`, `dueOn` e `payer`. O pagador contém `type` (`01` CPF ou `02` CNPJ), `document`, `name`, `address`, `state` e `postalCode`; Itaú requer também `neighborhood` e `city`. Itaú requer `ourNumber` de8 dígitos; Inter110, de10; Inter requer `paymentLimitDays` de1 a60. Identificadores repetidos no mesmo arquivo são rejeitados. O valor mínimo Inter é250 centavos. Os encargos Itaú opcionais são validados pelo módulo `packages/cnab/itau-terms.mjs`; instruções não implementadas são rejeitadas.

A resposta contém `artifact.bytes_base64`, `fileHash` SHA-256, `filename`, `manifest`, `totalCents` e avisos. `productionReady`, `bankTransmissionPerformed` e `financialMutationPerformed` permanecem falsos. **Os bytes CNAB não codificam ambiente de testes**: o arquivo precisa ser encaminhado apenas ao canal de homologação acordado com o banco. A API não reserva números operacionais, não marca recebíveis como registrados e não muda saldos.

A prévia de retorno recebe `expected_version`, `bytes_base64` (arquivo até4.020.000bytes) e opcional `century` (1900,2000 ou2100; padrão2000). O parser confere tamanho dos registros, sequência, campos, agência/conta/beneficiário/carteira, dígitos, totais e datas antes de devolver eventos. O evento07 possui significados diferentes por banco e é interpretado pelo layout correspondente. `validated:true` prova somente estrutura; `originAuthenticated:false` e `financialMutationPerformed:false` explicitam os limites. Hashes permitem futura conciliação idempotente, mas nenhum arquivo enviado pelo usuário é automaticamente considerado prova de pagamento.
