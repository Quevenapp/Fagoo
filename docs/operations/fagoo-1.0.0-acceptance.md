# Homologação da v1.0.0

Base: v0.3.1, repositório `Quevenapp/Fagoo`, branch `codex/fagoo-1.0.0`. A versão em desenvolvimento não deve ser promovida a Latest antes dos critérios de aceite. A produção existente permanece no ciclo assinado atual.

## Evidências automatizadas

| Critério | Evidência |
| --- | --- |
| Schema limpo e atualização do banco da v0.3.1 | `tools/consolidation/check_upgrade_postgres.mjs`: dois clusters PostgreSQL 17 isolados, 355 migrações (baseline de 346 e nove novas), ledger imutável e dados comerciais preservados. O ensaio usa schemas sintéticos de Auth/storage; a instalação completa dos serviços exige homologação separada. |
| Backup e restauração PostgreSQL | O mesmo ensaio executa `pg_dump`/`pg_restore` e compara todas as tabelas. Registro privado em `.local/audit/fagoo-1.0.0-pg-rehearsal.json`. |
| Concorrência das filas | `workers/erp-api/test/queues-postgres.test.mjs`: emissão paralela, repetição idempotente, alternância, unidade independente, revogação durante espera e efeito físico de resultado incerto. |
| Migração revisada | `tools/consolidation/consolidation.test.mjs`: exportação SQLite transacional, arquivo criptografado, mapas explícitos, inscrições legadas, importação inerte e ativação condicionada à reconciliação. |
| Backup e restauração do motor | `tools/qa/synthetic-communication-backup.mjs`: exportação/restauração reais com Wrangler local, D1/FTS, R2/bytes/MIME, integridade e recusas antes de modificar um destino inadequado. |
| Atendimento e isolamento | Testes em `workers/communication/test` e gateway ERP; escopo aplicado a listas, mídia, busca, eventos, equipe, atribuições e notificações; tomada humana invalida resposta anterior da IA. |
| Identidade e CRM | RPCs com permissões por unidade, contato canônico por origem explícita, histórico de relacionamento filtrado, funis e tarefas sem efeitos comerciais automáticos. |
| Horários de acesso | Fixture SQL executada nas instalações limpa e atualizada: restrições humanas também na autoridade usada por tarefas de atendimento em segundo plano; dispositivos e exceção administrativa preservados. |
| Aplicativo | Builds Android e iOS, testes de regras do painel, recibos, sessão e transporte. Evidências físicas são registradas separadamente; compilação não prova impressão ou push. |
| ERP existente | Suíte completa: 2.655 testes aprovados, quatro pulados, nenhuma falha. Build de produção com configuração pública sintética e verificação dos 258 arquivos distribuídos aprovados. |

## Homologação do servidor

Em 9 de novembro de 2026, o runtime separado `fagoo-homolog` foi instalado com as 355 migrações e credenciais próprias. A conta Cloudflare é a do Fagoo, com as origens definidas no [guia de instalação isolada](isolated-installation.md). O domínio de produção `demo.fagoo.com.br` permanece na v0.3.1.

- Auth real por HTTPS: 13 verificações aprovadas, incluindo login, renovação, revogação de refresh no logout, TOTP inválido recusado e TOTP válido com sessão AAL2 reconhecida pelo ERP. Foram usadas somente contas sintéticas, sem envio de e-mail. O cliente HTTP identifica-se como Fagoo; nenhuma regra de segurança da zona foi alterada.
- CORS real no gateway: três testes aprovados, cobrindo respostas normais, erros e preflight. Uma origem não autorizada não recebe o cabeçalho de autorização CORS.
- Instalação do conector por arquivo privado: 19 testes aprovados no Linux real, incluindo conta/UUID, exclusividade, permissões e recusa de links simbólicos em origem e destino.

Os roteiros de [Auth/CRM](../../tools/qa/homologation-auth-crm.md) e [filas](../../tools/qa/homologation-queues.md) registram relatórios privados e persistem comandos antes do envio. Auth HTTPS não comprova, por si só, CRM, concorrência da API, transições visuais do aplicativo ou efeitos físicos; cada fase precisa de seu próprio resultado.

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
