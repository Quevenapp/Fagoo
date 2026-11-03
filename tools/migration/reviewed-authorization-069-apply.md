# Aplicador auditável da 069

Preparado e testado localmente, depois aplicado no Supabase em 16/10/2026 às 22:10–22:11 de São Paulo. A execução completa retornou o recibo de auditoria e a consulta independente confirmou a persistência. Ver [resultado e provas privadas](../../docs/integrations/fiscal-reviewed-authorization-ledger.md).
Fonte SQL congelada: `26b9810328ab24a7e3590ac7ea03c91723331dae55ecb63a9cd4460b18caa7d3`.

O gerador `prepare_reviewed_authorization_apply.mjs` inclui a fonte literal em uma única transação, valida seu hash e os contratos anteriores, recusa reaplicação e recusa qualquer política antiga habilitada antes de executar a fonte. Versões antigas desativadas não precisam ser sequenciais. Os locks são adquiridos na ordem estável do inventário: `ACCESS EXCLUSIVE NOWAIT` na policy e `SHARE ROW EXCLUSIVE NOWAIT` nas demais tabelas, antes de capturar os dados. A recusa por concorrência exige rollback/conferência; não há repetição automática.

A prova compara contagem e hash de todas as tabelas existentes dos schemas `erp_*` e `origin_*`, além de `auth.users`, `storage.buckets` e `storage.objects`. Para a policy, compara exatamente as chaves antigas e todas as colunas antigas; verifica separadamente o discriminador `legacy_v1`, a coluna nova e os dois seeds desativados. Os hashes integrais antes/depois da policy são registrados e são diferentes por desenho. Não se declara identidade integral dessa tabela.

Também compara ACL, owner, RLS, políticas, colunas, constraints e triggers das relações; ACL dos schemas; privilégios padrão; definições/ACL/owner das funções não alteradas e a segurança das três redefinidas. A mudança permitida tem catálogo fechado: duas tabelas privadas vazias, sete helpers privados, sete RPCs service-only, três redefinições e quatro triggers. A representação adicional de NOT NULL do PostgreSQL18/PGlite é validada antes de ser normalizada; o mesmo contrato passou no PostgreSQL17.

`prepareReviewedAuthorizationReadback()` produz uma transação `READ ONLY`, com snapshot `REPEATABLE READ`, sem libxml. O bloco DO executa apenas SELECTs dinâmicos; `set_config(..., true)` transporta o agregado para o SELECT final dentro da transação, sem objeto temporário ou função persistida. O valor LOCAL é limpo no COMMIT, comprovado na mesma sessão PostgreSQL17. Compare `legacy_rows` com `after` e `other_functions_sha256` com o recibo de aplicação. Mudanças concorrentes posteriores ao COMMIT podem causar diferenças legítimas; investigue-as sem reaplicar a migração.

## Artefatos locais congelados

- Aplicação: `/Volumes/Dev/tmp/brufap-reviewed-authorization-069-apply-20261016.sql`, SHA256 `d4795ce9c7c72a5ee8ffe118af9f63b8dfe76f5938a2b630677e73467a95d934`.
- Readback: `/Volumes/Dev/tmp/brufap-reviewed-authorization-069-readback-20261016.sql`, SHA256 `06f14725044cf0f75f15ae296d48d791a77ad2cc4e487a5ed82eaec0800f29bd`.
- Manifesto: `/Volumes/Dev/tmp/brufap-reviewed-authorization-069-manifest-20261016.json`.

Os arquivos foram gravados com criação exclusiva, modo 0600 e fsync. A saída de auditoria contém nomes técnicos, contagens e hashes; não contém linhas de negócio. A execução do script completo requer confirmação do COMMIT, além da linha de auditoria que o precede. Uma resposta perdida não autoriza repetir; o readback é a conferência independente.

## Provas locais

```sh
node --test tools/migration/test_reviewed_authorization_apply.mjs
BRUFAP_TEST_PG17_BIN=/Volumes/Dev/tmp/brufap-pg17-20261016/install/bin node tools/migration/check_reviewed_authorization_apply_postgres.mjs
```

39/39 testes PGlite passaram sobre baseline sintética 001–068. Incluem alterações adversariais de dados, policy, ACL/RLS, constraints, triggers, schemas, funções e seeds; rollback; policy ativa; sucesso; reaplicação; readback.

6/6 cenários do próprio aplicador passaram no PostgreSQL17.11 isolado: policy ativa recusada, leitor da policy recusado NOWAIT, gravador anterior recusado NOWAIT, sucesso com leitor no pai de FK, readback idêntico e reaplicação recusada. Os dois conflitos responderam em 12 ms, sem deadlock. A fixture protegeu 146 tabelas e conservou financeiro/estoque/tentativas em zero; políticas passaram de três antigas para cinco, todas desativadas. O cluster utilizou somente socket Unix privado, sem TCP, e foi removido ao terminar.

Logs: `/Volumes/Dev/tmp/brufap-reviewed-069-applicator-tests.log` e `/Volumes/Dev/tmp/brufap-reviewed-069-applicator-postgres.json`. Esses seis cenários validam o aplicador; não substituem as 22 corridas do ledger registradas separadamente por seu autor.

Não há ativação operacional, validação tributária completa, transmissão, certificado ou acesso à empresa nesses ensaios. A fonte 069 e os módulos fiscais não foram alterados pelo aplicador.
