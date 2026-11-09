# Homologação da v1.0.0

Base: v0.3.1, repositório `Quevenapp/Fagoo`, branch `codex/fagoo-1.0.0`. A versão em desenvolvimento não deve ser promovida a Latest antes dos critérios de aceite. A produção existente permanece no ciclo assinado atual.

## Evidências automatizadas

| Critério | Evidência |
| --- | --- |
| Schema limpo e atualização do banco da v0.3.1 | `tools/consolidation/check_upgrade_postgres.mjs`: dois clusters PostgreSQL 17 isolados, 356 migrações (baseline de 346 e dez novas), ledger imutável e dados comerciais preservados. O ensaio usa schemas sintéticos de Auth/storage; a instalação completa dos serviços exige homologação separada. |
| Backup e restauração PostgreSQL | O mesmo ensaio executa `pg_dump`/`pg_restore` e compara todas as tabelas. Registro privado em `.local/audit/fagoo-1.0.0-pg-rehearsal.json`. |
| Concorrência das filas | `workers/erp-api/test/queues-postgres.test.mjs`: emissão paralela, repetição idempotente, alternância, unidade independente, revogação durante espera e efeito físico de resultado incerto. |
| Migração revisada | `tools/consolidation/consolidation.test.mjs`: exportação SQLite transacional, arquivo criptografado, mapas explícitos, inscrições legadas, importação inerte e ativação condicionada à reconciliação. |
| Backup e restauração do motor | `tools/qa/synthetic-communication-backup.mjs`: exportação/restauração reais com Wrangler local, D1/FTS, R2/bytes/MIME, integridade e recusas antes de modificar um destino inadequado. |
| Atendimento e isolamento | Testes em `workers/communication/test` e gateway ERP; escopo aplicado a listas, mídia, busca, eventos, equipe, atribuições e notificações; tomada humana invalida resposta anterior da IA. |
| Identidade e CRM | RPCs com permissões por unidade, contato canônico por origem explícita, histórico de relacionamento filtrado, funis e tarefas sem efeitos comerciais automáticos. |
| Conflitos determinísticos | Migração aditiva `202611090011`: quatro RPCs novos usam `PT409` e o gateway devolve HTTP 409. Testes SQL preservam ACL, proprietário e atributos das funções; testes HTTP verificam uma única chamada e resposta sem detalhes privados. O ensaio PostgreSQL real cobre os quatro RPCs, inclusive repetição conflitante da consolidação. |
| Horários de acesso | Fixture SQL executada nas instalações limpa e atualizada: restrições humanas também na autoridade usada por tarefas de atendimento em segundo plano; dispositivos e exceção administrativa preservados. |
| Aplicativo | Builds Android e iOS, testes de regras do painel, recibos, sessão e transporte. Evidências físicas são registradas separadamente; compilação não prova impressão ou push. |
| ERP existente | Suíte completa: 2.655 testes aprovados, quatro pulados, nenhuma falha. Build de produção com configuração pública sintética e verificação dos 258 arquivos distribuídos aprovados. |

## Homologação do servidor

Em 9 de novembro de 2026, o runtime separado `fagoo-homolog` foi inicialmente instalado com 355 migrações e credenciais próprias. A migração 011, que leva o total a 356, foi ensaiada localmente e aguarda aplicação coordenada e nova verificação HTTPS; essa pendência não é considerada concluída pelas evidências locais. A conta Cloudflare é a do Fagoo, com as origens definidas no [guia de instalação isolada](isolated-installation.md). O domínio de produção `demo.fagoo.com.br` permanece na v0.3.1.

- Auth real por HTTPS: 13 verificações aprovadas, incluindo login, renovação, revogação de refresh no logout, TOTP inválido recusado e TOTP válido com sessão AAL2 reconhecida pelo ERP. Foram usadas somente contas sintéticas, sem envio de e-mail. O cliente HTTP identifica-se como Fagoo; nenhuma regra de segurança da zona foi alterada.
- CORS real no gateway: três testes aprovados, cobrindo respostas normais, erros e preflight. Uma origem não autorizada não recebe o cabeçalho de autorização CORS.
- Instalação do conector por arquivo privado: 19 testes aprovados no Linux real, incluindo conta/UUID, exclusividade, permissões e recusa de links simbólicos em origem e destino.
- Identidade/CRM por HTTPS, execução parcial: contexto por unidade, negação de administração e de outra unidade, gravação idempotente, recuperação de recibo e oportunidade ganha sem lançamento financeiro passaram. O teste de versão desatualizada recebeu 503 e interrompeu a fase. Leituras posteriores confirmaram a oportunidade em `won`, versão 2, uma tarefa e três eventos no histórico; não houve repetição da gravação incerta.

O diagnóstico identificou que o PostgREST 14 repete transações sinalizadas com SQLSTATE `40001`, mesmo quando o conflito é determinístico. O comportamento está documentado na [base técnica do Supabase](https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b). A migração 011 altera apenas `fagoo_command`, `fagoo_crm_command`, `fagoo_relationship_link` e `fagoo_consolidation_import`, usando o código próprio `PT409`; os arquivos anteriores do ledger permanecem intactos. As funções legadas do ERP com `40001`, inclusive as redefinições de usuários na migração 002, foram inventariadas separadamente, sem alteração abrangente nesta correção.

O ensaio local final terminou em `2026-11-09T18:33:56.134Z`: instalação limpa, atualização 346 + 10, conflitos dos quatro RPCs, igualdade dos hashes entre instalações e `pg_dump`/`pg_restore` integral passaram. O hash do conjunto de migrações é `c7dc7ac1e278e61b261a5730dea978d3b727073b5fa1dc6b4e95899c57fc4540`. Onze testes Node focados e oito testes Python do operador QA também passaram. Isso ainda não encerra o teste de conflito pela API HTTPS nem o aceite do runtime PostgREST atualizado.

Os roteiros de [Auth/CRM](../../tools/qa/homologation-auth-crm.md) e [filas](../../tools/qa/homologation-queues.md) registram relatórios privados e persistem comandos antes do envio. Auth HTTPS não comprova, por si só, CRM, concorrência da API, transições visuais do aplicativo ou efeitos físicos; cada fase precisa de seu próprio resultado.

### Sequência revisada para aplicar a 011 na homologação

Esta sequência é um procedimento pendente, não um registro de execução. O operador controla a aplicação e a publicação no commit revisado, exclusivamente em `/opt/fagoo-homolog`, projeto Docker `fagoo-homolog` e nas três origens de homologação Fagoo.

1. Confira a configuração privada sem imprimir segredos e execute `infra/migrate.py --env-file private/install/.env --project-name fagoo-homolog --check-only`. O ledger existente deve corresponder ao checkout; não edite versões anteriores nem use inicialização de instalação nova.
2. Adquira atomicamente o diretório `private/update-fagoo.lock`, compartilhado com o atualizador. Um lock existente exige inspeção; não o remova para prosseguir. Mantenha a manutenção em `private/update-service/run/maintenance` durante backup, aplicação e publicação. Pare somente o serviço `rest` da homologação para encerrar requisições antigas em repetição; isso não requer parar ou alterar a instalação de produção.
3. Em uma pasta nova, privada e identificada por data dentro de `private/backups`, preserve a configuração e o inventário das imagens em execução. Execute `pg_dump --format=custom` pelo container `db` do projeto explícito, salvando `database.dump`. Confirme tamanho não nulo, índice legível com `pg_restore --list` e SHA-256. Essa inspeção do arquivo não substitui o ensaio completo de restauração já registrado.
4. Aplique com `python3 infra/migrate.py --env-file private/install/.env --project-name fagoo-homolog`. O migrador usa lock PostgreSQL, transação por versão e hash imutável; somente a 011 deve estar pendente. Confirme 356 entradas e execute novamente `--check-only`. Se falhar, mantenha a manutenção e preserve backup e diagnóstico privado; não declare conclusão nem restaure sobre dados posteriores sem revisão.
5. A eventual troca de imagem do PostgREST é uma etapa separada, com versão/digest revisados e inventário anterior preservado. Suba o serviço homologado escolhido e publique a API do mesmo commit, incluindo o mapeamento `PT409` → HTTP 409. Confira versões públicas antes de remover a manutenção. Libere apenas o lock adquirido por esta operação e valide saúde do gateway/Auth.
6. Retome `tools/qa/homologation_auth_crm.py --run-id 9e786a54cb21 --phase api --auth-transport https --execute`, usando as mesmas contas, unidades e UUIDs de comandos privados. O roteiro exige a presença da 011. Não crie outro run para contornar uma resposta incerta. Só após `https_identity_crm_phase_complete` avance para os ensaios de filas e para o conflito legado do PostgREST.

O ensaio de [PostgREST 16](postgrest-16-acceptance.md) cobre o conflito legado `40001`, a resposta pública `409`, as permissões e a reversão somente do REST com dados preservados. O novo pin exige esse aceite na homologação antes de promoção.

## Operação e recuperação

A atualização mantém a recepção durável dos webhooks e pausa os processadores e mutações humanas. A recuperação restaura versões e configuração e conserva a caixa de entrada ao vivo. Um backup D1/R2 é restaurado em recursos novos; nunca por sobrescrita do banco que recebeu webhooks depois do checkpoint. A adoção de uma instalação antiga mantém o nome do Worker, namespace de Durable Objects, D1, R2, rotas e chave de criptografia originais.

Consulte o [migrador](../../tools/consolidation/README.md), o [contrato](../architecture/fagoo-1.0.0-contract.md) e os [ensaios de filas](fagoo-queues-acceptance.md). As credenciais e os relatórios de instalação ficam fora da distribuição pública.

## Critérios que exigem bancada e ambiente de homologação

- Configuração do Firebase/APNs e notificações reais Android/iOS, inclusive após logout, troca de usuário e entrada no painel.
- Login, MFA, cadastro de aparelho e transição de modos com a instalação homologada na nuvem.
- Impressão física e áudio nos aparelhos autorizados, com interrupção de rede durante envio e confirmação.
- Acesso por hotspot e entre redes diferentes, sem replay de efeitos anteriores.
- Migração e restauração com o backup da instalação autorizada, revisão dos mapas e confirmação de um único consumidor por canal.
- Conferência operacional da paridade dos canais, automações, protocolos, consentimentos e recursos web herdados.

Registre aparelho, build, destino, data e resultado de cada ensaio. Enquanto algum item obrigatório não tiver evidência, mantenha a v1.0.0 em homologação e preserve a versão estável existente.
