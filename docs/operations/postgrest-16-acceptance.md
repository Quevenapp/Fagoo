# PostgREST 16: conflitos do ERP e homologação isolada

O REST da v1.0.0 usa `postgrest/postgrest:v16.5@sha256:1347d7552b88f17832912c06afbf7c43209af6eeeb60834b04aae12c9bd9d5cc`.
O digest é o índice oficial com imagens Linux amd64 e arm64, conferido no [Docker Hub](https://hub.docker.com/v2/repositories/postgrest/postgrest/tags/v16.5) em 9/11/2026. A referência anterior continua registrada em `infra/runtime-manifest.json` para revisão e recuperação.

## Motivo e alcance

PostgREST 14 repete transações quando uma função lança `40001`. O ERP herdado usa esse código também em conflitos determinísticos de versão, estado ou comando. A [orientação oficial da Supabase](https://github.com/orgs/supabase/discussions/50151) descreve o laço e recomenda códigos de negócio como `PT409`; a [versão 16](https://github.com/PostgREST/postgrest/releases/tag/v16.0) remove a repetição problemática. A migração 011 corrige os RPCs novos e redefinidos da v1.0.0; o runtime 16 também protege o ERP anterior sem reescrever suas centenas de funções nesta entrega.

Na base v0.3.1 (`origin/main` em `1c5ac861c7ba02d13fc61d5dd14dcac64af36977`), há 1.562 comandos `RAISE ... ERRCODE='40001'` em 207 arquivos históricos. As últimas definições literais por nome incluem 478 nomes com esse código, como catálogo, documentos, financeiro, estoque e PDV. Esses números incluem redefinições históricas e não são contagem exata de funções ativas: há sobrecargas, renomes e 150 trechos com `pg_get_functiondef`. Os arquivos legados permanecem inalterados em relação à base.

O pin muda somente a imagem de `rest`. Banco, Auth, Storage, gateway, volumes, secrets, ledger e identidades não mudam por causa deste patch. O ensaio inicial é exclusivo de `fagoo-homolog`, em `/opt/fagoo-homolog`; não instala o pin no projeto de produção.

## Compatibilidade revisada

- A versão 16 exige PostgreSQL 14 ou superior; esta instalação usa a imagem PostgreSQL 17 já fixada no Compose.
- `db-schemas` não pode incluir `pg_catalog` ou `information_schema`; usamos `public,storage`.
- O papel JWT padrão continua igual. Não configuramos `jwt-role-claim-key`; a [v16.2](https://github.com/PostgREST/postgrest/releases/tag/v16.2) também restaurou compatibilidade com a sintaxe antiga explícita.
- `Prefer: timezone` inválido passa a falhar mesmo com `handling=lenient`. Não foi encontrado uso desse cabeçalho no cliente. A [v16.5](https://github.com/PostgREST/postgrest/releases/tag/v16.5) limita ainda esse valor a 24 caracteres nas versões de PostgreSQL anteriores às correções indicadas na release; não alterar esse cabeçalho durante o ensaio.
- Manter o padrão de compatibilidade `url-use-legacy-target-names`; não habilitar mudanças de filtros/aliases nesta atualização.
- O REST devolve HTTP 500 para SQLSTATE `40*`; o Worker já lê o código e o converte em `409 ERP_CONFLICT`. O teste de catálogo cobre essa resposta real, sem expor detalhes SQL. O erro customizado `PT409` também é compatível com ambas as versões. [Contrato de erros](https://docs.postgrest.org/en/v16/references/errors.html).

## Aplicação revisada pelo operador

1. Interromper os ensaios concorrentes. Validar o diretório real, `FAGOO_INSTANCE_ID=fagoo-homolog` e as três origens do [guia isolado](isolated-installation.md). Manter o `UpdateLock` da instalação durante toda a troca; não usar um segundo protocolo de lock.
2. Registrar as imagens que estão efetivamente em execução com `infra/record-runtime.py --env-file private/install/.env --project-name fagoo-homolog --output private/qa/<run>/postgrest-before-images.json`. O arquivo é privado e exclusivo: não sobrescrever um recibo anterior. Registrar também o checkpoint do backup/ledger e as identidades dos containers de banco e produção.
3. Revisar que o diff do Compose troca exclusivamente `rest.image`. Usar sempre `docker compose --project-name fagoo-homolog --env-file private/install/.env -f infra/compose.yaml`; primeiro `config --quiet`, depois `pull rest`, depois `up -d --no-deps --wait rest`. Não executar `down`, não remover volumes, não recriar o banco e não usar o atualizador completo para este ensaio isolado.
4. Confirmar imagem/digest, `postgrest --version`, healthcheck `postgrest --ready` e gateway. Registrar novo recibo e comprovar que banco, produção e os outros serviços mantiveram seus IDs. Se já existia uma repetição em andamento, parar somente o REST da homologação limpa suas conexões; não encerrar backends de outras instalações.
5. Executar sequencialmente os roteiros abaixo. Verificar logs sem repetição contínua e conexões do REST sem consultas presas. Não tratar apenas o healthcheck como aceite funcional.

```bash
python3 tools/qa/homologation_auth_crm.py --auth-transport https --phase api --run-id 9e786a54cb21 --execute
python3 tools/qa/homologation_postgrest.py --run-id 9e786a54cb21 --execute
python3 tools/qa/homologation_queues.py --run-id 9e786a54cb21 --execute
```

O primeiro roteiro exige a migração 011 aplicada pelo migrador normal, além da fase Auth/MFA concluída. Não reaplicar migrações manualmente nem alterar hashes de migrações anteriores. O roteiro de filas verifica concorrência, idempotência, isolamento e impressão incerta com um dispositivo apenas HTTP; não envia bytes a impressoras nem notificações.

`homologation_postgrest.py` recusa qualquer imagem, versão, projeto ou origem diferentes antes de provocar o erro. Reutiliza o contato sintético projetado pela fase CRM. Envia seu mesmo estado `active`, com uma versão propositalmente divergente: a função falha antes de gravar contato, auditoria ou recibo. Confirma SQLSTATE `40001`/HTTP 500 diretamente no REST, resposta pública `409` em menos de 12 segundos, papel anônimo/autenticado impedido de chamar RPC exclusivo de serviço, operador sem acesso ao catálogo ERP, isolamento CRM e comparação dos dados antes/depois. UUID inexistente só provaria `404`, portanto não seria teste desta regressão.

O modo sem `--execute` verifica apenas o pin e a saúde do runtime. Relatórios e IDs de comandos ficam em `private/qa/<run>/postgrest-*.json`. A autenticação cria/renova sessões sintéticas; o teste não é isento dessas gravações de Auth. Não executar junto com os demais roteiros que compartilham credenciais.

## Reversão preservando dados

Se o REST 16 falhar no aceite, usar o recibo `postgrest-before-images.json` para criar uma sobreposição privada contendo somente `services.rest.image` com a referência anterior revisada. Validar a configuração e executar a mesma operação `up -d --no-deps --wait rest`, sob o lock e com o projeto explícito. Não restaurar banco nem remover migrações por causa de uma troca de imagem sem alteração de dados. A migração 011 permanece válida no REST 14.

A reversão para v14.18 reintroduz o risco nas funções legadas que ainda lançam `40001`. Não repetir a prova de erro nessa versão; manter a promoção bloqueada até resolver a incompatibilidade. Não reverter usando `latest` ou uma referência sem digest.

## Estado de aceite

Patch preparado e testes locais registrados no PR. Execução real em homologação, resultados dos roteiros e recibos de imagens são evidências separadas; preencher somente após observação. Nenhuma conclusão de produção decorre desta preparação.
