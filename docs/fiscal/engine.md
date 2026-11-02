# Engine fiscal de homologação

O repositório inclui uma implementação fiscal real de preparação, geração, assinatura e validação local de NF-e55/NFC-e65, além da composição revisada de envio de homologação. O código foi portado seletivamente de uma revisão existente (`97be7a7eab5c132e540748757120a55897f1e971`), com grafo de dependências conferido, nomes próprios do FAGOO e testes sintéticos. Não foram importados histórico Git, migrações antigas, contas de cliente, certificados privados, segredos, XML de produção ou capturas privadas.

**A presença do engine não habilita emissão.** A instalação nova mantém `dispatch_enabled:false`, `production_authorized:false` e `postgres_operational_ledger_installed:false`. Não há botão/API que simule uma autorização inexistente. Nenhum teste local produz evidência de homologação aceita pela SEFAZ.

## Componentes presentes

| Área | Implementação portada | Limite operacional |
|---|---|---|
| Preparação | `fiscal-core`: identidade/chave, itens, decimais, rateios, preparação tributária e documento comercial | Perfis explícitos; não decide sozinho NCM ou legislação aplicável |
| XML | `fiscal-xml`: serialização4.00, validação estrutural, XML comercial e modelo nativo | XML gerado permanece homologação, sem reserva implícita de numeração |
| Assinatura | XMLDSig, verificação de referência, certificados e PFX, candidata assinada, suplemento NFC-e SP | Certificado precisa de custódia/configuração; assinatura não comprova autorização SEFAZ |
| Schemas | Tipos oficiais PL010f v1.04, schemas de consulta/distribuição e validadores Python/lxml | SHA-256 e tamanhos conferidos; XSD não substitui revisão tributária |
| Autorização | SOAP55/65, revisão de subconjunto SP/CRT1, GTIN, preparação, envio único, diário, recuperação e fechamento | Gate desligado; depende de ledger transacional e política/revisão válida |
| Recibos | Construção/interpretação de consulta, SOAP, XSD, composição e recuperação | Serviço exige grant/ledger próprios; não há polling automático |
| Custódia | Envelope AEAD, leitura PKCS12/OpenSSL3, loaderTLS, confiança de servidor e limpeza de buffers | Nenhuma chave carregada por padrão; contrato não atesta cadeia ICP/revogação completa |
| Orquestração | Geração não assinada e assinada com portas explícitas | Não conectado a um ledger operacional na instalação inicial |

O ponto de entrada de bibliotecas é `packages/fiscal-engine/index.mjs`. A API pode ler apenas `packages/fiscal-engine/capabilities.mjs`, sem carregar criptografia/validadores no startup.

Os cálculos de impostos importados são propostas determinísticas sobre parâmetros fornecidos. Não há uma base legal completa nem autorização para inferir alíquotas/regime/códigos ausentes. Campos tributários não suportados continuam pendências explícitas.

## Portas FAGOO

`createPostgresFiscalExecutor({pool,companyId,actorId,operations})` substitui transporte proprietário por PostgreSQL. O mapa `operations` é configuração privada do backend e aceita somente funções em `fagoo_fiscal`. Cada função recebe um JSONB; a transação recebe contexto local `fagoo.company_id` e `fagoo.actor_id`, prazo limitado e conferência do ator. O adapter não cria funções nem concede permissões. **As funções/ledger de autorização, reserva de numeração, revisão, lease, prepare/use/finish e recuperação ainda precisam ser implementadas no schema novo**, preservando todas as verificações do contrato do engine. O chamador deve mapear identidades de integração para um principal fiscal UUID autorizado. Não fornecer SQL, mapa de funções ou identidades do navegador.

Os adapters de fechamento, revalidação e recibo recebem `{execute}`; não possuem URL, token de serviço ou `fetch` implícito. Erros SQL definitivos ficam separados de timeout/perda de resposta, que não autorizam repetir um envio fiscal.

`createFiscalArtifactPort({storage,companyId})` adapta um armazenamento privado imutável com `put/get`. Valida caminhos/hash/tamanho, prefixa `companies/{companyId}/fiscal-engine/`, exige `If-None-Match:*` no contrato do driver e verifica leitura posterior. A aplicação de produção precisa habilitar esses caminhos no driver privado após conectar ACL/ledger. O armazenamento inicial da importação de notas recebidas possui outro conjunto de caminhos e permanece independente. O port de artefatos não abre o cofre A1.

`createAuthorizationCustodyPort` exige separadamente leitor de envelopes privados, loaderTLS, keyring e reautorização de preparação. Nenhuma credencial é aceita pelo frontend como autorização. Chaves do cofre e segredos devem ficar no servidor/serviço de custódia, nunca no aplicativo ou no repositório.

## Gates e continuidade da homologação

Os perfis revisados preservam a data-limite original de **26/10/2026**, que já está vencida. Ela não foi prorrogada durante o port. Retomar testes fiscais reais requer nova revisão versionada do escopo, schemas, SOAP, trust e política, seguida da configuração do ledger e do certificado do cliente. Alterar uma constante para `true` não resolve essas dependências.

O perfil de envio revisado é limitado a SP, ambiente2, modelos55/65 e subconjunto comercial/tributário explícito. Produção, outros estados/regimes/operações e cobertura tributária geral precisam de implementação e homologação próprias. Entradas de dados, emissão de documentos e captura automática de documentos são fluxos distintos.

O adapter Cloudflare do cliente ainda precisa compor essas portas com autenticação/HMAC, autorização do ator, custódia, armazenamento e ledger do FAGOO. Não houve publicação no Cloudflare durante o port. O runtime Linux inclui as dependências locais; isso não ativa rede fiscal, certificado ou política.

## Verificação local

Node24, dependências fixadas no lockfile, Python3 com `lxml==6.1.1` e OpenSSL3 são as dependências. O runtime instala Python em `/opt/fiscal-validator/bin/python3`. `FAGOO_FISCAL_PYTHON` configura a instalação; `FAGOO_TEST_PYTHON` ou `PYTHON` pode selecionar um caminho absoluto local para testes. O resolver procura o ambiente instalado e depois um interpretador local, sem download automático.

```sh
FAGOO_TEST_PYTHON=/opt/fiscal-validator/bin/python3 \
node --test --test-concurrency=2 \
  packages/fiscal-core/test/*.test.mjs \
  packages/fiscal-xml/test/*.test.mjs \
  packages/fiscal-authorization/test/*.test.mjs \
  packages/fiscal-engine/test/*.test.mjs
```

As fixtures geram chaves/certificados autoassinados em memória. O conjunto verifica emissão local55/65, preços/quantidades, wrapping/tampering, PFX, schemas reais, SOAP, regras/GTIN e recibos. Quatro verificações opcionais de snapshots WSDL privados permanecem desativadas; esses arquivos não pertencem à distribuição. Nenhum teste deste conjunto chama a SEFAZ. Os testes do adapter PostgreSQL exercitam funções sintéticas em banco isolado, sem fingir que o ledger operacional foi migrado.

Renomear o produto altera perfis e o campo `verProc`; hashes de perfis/validators/entrypoints e fixtures correspondentes foram recalculados. As saídas XML de referência foram comparadas com a implementação de origem, confirmando apenas a alteração nominal antes de atualizar os hashes. Tipos XSD oficiais e raiz pública de confiança permanecem com bytes pinados. Arquivos cujo hash depende dos bytes possuem `.gitattributes` para evitar conversão automática de fim de linha.

## Limites atuais do ERP

A importação de XML recebido funciona independentemente do engine. Ainda não há vínculo persistido de conciliação entre nota recebida e pedido de compra. O total comercial atual do pedido soma itens e não possui rateio de frete/despesas. As parcelas financeiras guardam valor e vencimento; dados completos de boleto/DDA e sua autenticação precisam de módulo próprio. Esses limites impedem anunciar o fluxo fiscal/financeiro inteiro como automático nesta versão.
