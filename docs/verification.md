# Verificação da recomposição

Referência: `brunovnq/brufap`, commit `97be7a7eab5c132e540748757120a55897f1e971`. Verificações realizadas em 02/11/2026. Os testes usam cenários sintéticos, sem conexão a dados de produção.

## Preservação da referência

O inventário em `tools/reference/baseline.json` acompanha 3.340 arquivos da fonte, excluindo a documentação operacional histórica com informações específicas de cliente. O verificador exige a presença de todos esses arquivos e confere as alterações registradas em `changes.json`. Os hashes de comparação normalizam apenas finais de linha de texto; os arquivos de schema/certificados públicos verificados por manifests mantêm seus bytes originais.

A interface preserva os 1.270 arquivos originais de `apps/erp`, incluindo 334 arquivos TSX e 114 arquivos CSS. O template e sua estrutura de layout foram mantidos; as diferenças abrangem identidade exibida, configuração de origem, correções de colisões de nomes e estabilização de testes.

As 311 migrações foram aplicadas integralmente em dois bancos PGlite independentes: referência e FAGOO. Os catálogos finais, com 1.327 relações e 2.310 funções, correspondem após a normalização de namespaces. Relações incluem objetos de catálogo além de tabelas; esses números não representam o inventário de um banco de cliente. Os 39 hashes esperados de guardas afetadas foram recalculados em 21 migrações após comprovação do corpo de função correspondente. As guardas continuam ativas.

## Resultados

| Verificação | Resultado |
| --- | --- |
| Interface ERP | 2.625 casos únicos aprovados, zero skips |
| Pacotes de domínio/fiscal/configuração | 1.591 casos únicos aprovados; 55 casos condicionais não executados na suíte geral |
| Workers, conectores, API e integração | 169 testes aprovados na frente de infraestrutura |
| Configuração comum de backend | 23 testes aprovados; também incluídos na suíte de pacotes |
| Portabilidade e adoção | 37 testes aprovados |
| Recovery de Storage | 34 testes aprovados |
| Baseline e janela fiscal sintética | 22 testes aprovados |
| Inventário/comparação em PostgreSQL 17.11 real, Docker | 26 verificações sintéticas aprovadas |
| TypeScript e build do ERP | Aprovados; build com origens e chave pública fictícias |
| Inspeção do build público | Sem achados; 325 arquivos examinados na rodada final, incluindo assets locais retidos de builds anteriores |
| Quatro Workers | Empacotamento `--dry-run` aprovado, sem publicação |
| Container fiscal | Build do estágio `test` e testes internos aprovados |
| Auditoria npm da raiz após atualização compatível do Wrangler | Zero vulnerabilidades reportadas |

Os totais por frente se sobrepõem e não devem ser somados. A contagem consolidada considera os casos únicos que passaram após correções e repetições pontuais. Na interface, nove arquivos foram inicialmente impedidos por uma cópia incompleta das dependências do ambiente temporário: seus 52 casos passaram depois de restaurar os módulos. Nos pacotes, 22 falhas foram corrigidas exclusivamente em fixtures/testes e verificadas novamente: datas de cenários históricos e um teste cujo prazo real de 20 ms terminava antes da etapa que pretendia exercitar.

Os 55 casos condicionais da suíte geral permanecem identificados como não executados nessa rodada. O estágio Docker executa seu próprio perfil de testes, incluindo verificações fiscais de processo. Nenhuma dessas evidências representa homologação de emissão real, validação de um banco de cliente ou garantia de capacidade da VPS.

## Reproduzir

Instale as dependências indicadas no README. Para as suítes fiscais, use Linux, OpenSSL 3 e Python:

```sh
python3 -m venv .venv
.venv/bin/pip install -r packages/fiscal-schema/requirements.txt
export BRUFAP_TEST_OPENSSL_PATH=/usr/bin/openssl
export BRUFAP_TEST_PYTHON="$PWD/.venv/bin/python3"
node --test --test-concurrency=4 packages/*/test/*.test.mjs
npm run test:erp
npm run test:portability
npm run check:reference
docker build --target test -f packages/fiscal-runtime/Dockerfile -t fagoo-fiscal-validation .
```

Os nomes históricos das variáveis de teste permanecem compatíveis. Use um diretório no filesystem nativo do Linux para as suítes extensas; misturar dependências nativas Windows/Linux ou executar milhares de leituras através de um volume compartilhado pode invalidar ou tornar lento o ambiente de teste.

O build do frontend exige configuração pública válida da instalação. A compilação usada nesta verificação empregou domínios fictícios e não serve como build de produção configurado para um cliente.

## Aceite operacional pendente

A próxima instalação ainda precisa validar o stack completo de Auth, Storage, PostgREST e PostgreSQL, bootstrap do cliente, dados e objetos restaurados, saldos e permissões, certificados e recuperação, atualização assinada e capacidade com Hermes. O [estado da reconstrução](status.md) e o [roteiro de migração](operations/supabase-migration.md) descrevem esse trabalho.
