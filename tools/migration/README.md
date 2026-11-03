# Desenvolvimento e verificação do banco

Esta pasta reúne testes, fixtures sintéticas e utilitários de desenvolvimento dos contratos SQL do ERP. Os arquivos em `helpers` e `fixtures` também são usados pelos testes de bibliotecas e da API. Eles não são executados durante a instalação de um cliente.

Os arquivos de estrutura versionados ficam em `supabase/migrations`. A instalação própria aplica essa estrutura pelo runner público em `infra/migrate.py`, com um registro imutável das versões e hashes aplicados. Atualizações usam o mesmo registro para executar somente versões novas; arquivos já aplicados não devem ser reescritos.

Uma instalação nova não recebe registros comerciais de exemplo. Dados de QA, preparações de homologação e utilitários de aplicação explícita nesta pasta pertencem ao ambiente de desenvolvimento e exigem seus próprios procedimentos; não fazem parte do bootstrap.

Exemplos de verificação local:

```sh
npm run test:database
node --test tools/migration/test_documents_sql.mjs
node --test tools/migration/test_backup_sql.mjs
```

Os testes de banco usam fixtures sintéticas e verificam permissões, concorrência, idempotência e preservação das regras do ERP. Eles não concedem habilitação fiscal ou bancária operacional.
