# Preparação da migração para PostgreSQL na VPS

O FAGOO preserva o modelo de dados, as funções de negócio, os contratos da API e as telas da base original. A preparação entregue aqui inventaria e compara bancos; **não restaura dados, não troca o Auth e não declara uma migração concluída**.

O banco é parte do ERP: estoque, financeiro, recebimentos, reservas, auditorias, comandos idempotentes e regras fiscais dependem de funções, constraints e triggers existentes. Não substituir esse domínio por um conjunto menor de tabelas nem importar o histórico pelos endpoints de criação.

## Dois modos de instalação

| Modo | Conteúdo | Critério de aceite |
| --- | --- | --- |
| Instalação virgem | Schema completo, referências públicas e configurações de sistema. Empresa, usuários, certificado e dados comerciais são criados pelo cliente. | Fluxos completos funcionam em um ambiente vazio, sem dados ou credenciais da origem. |
| Migração de instalação existente | Schema e dados, usuários/UUIDs, permissões, anexos, financeiro, estoque, auditorias e continuidade fiscal. | Restauração ensaiada e reconciliações documentadas, além dos testes da instalação virgem. |

Cada cliente deve começar com uma instalação e banco próprios. A base possui singletons e permissões de uma empresa; acrescentar `company_id` isoladamente não a converte em uma instalação com várias empresas independentes.

## Serviços necessários

O caminho inicial de menor alteração é PostgreSQL com um núcleo compatível de PostgREST, Auth/GoTrue e Storage, atrás de HTTPS. O Worker e os demais componentes podem conservar as rotas RPC existentes. As versões desses serviços e os schemas internos de Auth/Storage precisam ser compatíveis entre si e registrados no ensaio.

As tabelas de teste que simulam `auth.users` ou `storage.objects` não substituem esses serviços. O banco usa UUIDs do Auth, sessões e MFA reais; a API valida a identidade antes de chamar a RPC; a RPC revalida as permissões. Storage participa da confirmação de uploads por objeto, tamanho, MIME type e acesso privado.

O inventário do repositório permite avaliar uma implantação sem Studio, analytics, Realtime ou Edge Functions. Confirmar também o que está implantado, pois a ausência de uso no código não prova ausência de dependências no ambiente. Em uma VPS de 1 vCPU/4 GB, medir o núcleo junto com Hermes e os serviços fiscais. Limitar conexões e concorrência, usar imagens prontas e verificar espaço para banco, objetos, WAL e manutenção. O instalador não deve presumir que 50 GB atendem qualquer empresa.

## Inventário somente leitura

Requisitos locais: Node.js 22 ou superior e `psql` compatível com o PostgreSQL de destino, disponíveis no `PATH`. Os utilitários não instalam dependências e não acessam nenhum banco ao executar seus testes.

Configure a conexão por **PGSERVICE/arquivo de serviços libpq**, preferencialmente com credenciais no arquivo de senhas protegido. Também são aceitos `PGHOST`, `PGDATABASE` e `PGUSER`, com os demais parâmetros libpq no ambiente. Use TLS com verificação de certificado quando a conexão atravessar a rede. Não passe senha na linha de comando, não inclua credenciais em arquivos do repositório e não envie o ambiente aos logs.

Exemplo em Ubuntu, com os serviços `fagoo-source-audit` e `fagoo-target-audit` já configurados pelo operador:

```bash
umask 077
mkdir -p /var/lib/fagoo-private/migration-audit
PGSERVICE=fagoo-source-audit node tools/portability/inventory.mjs \
  --output /var/lib/fagoo-private/migration-audit/source.json
PGSERVICE=fagoo-target-audit node tools/portability/inventory.mjs \
  --output /var/lib/fagoo-private/migration-audit/target.json
```

O utilitário usa uma transação `REPEATABLE READ READ ONLY`, desabilita o arquivo de inicialização do psql, não pede senha interativamente e termina com `ROLLBACK`. Impõe tempo de conexão de 15 segundos, timeout de 60 segundos por comando, espera de lock de 5 segundos, duração total de 15 minutos e saída máxima de 64 MiB. Se a conta não conseguir contar uma tabela integralmente, o inventário falha; não produz uma contagem filtrada por RLS como se fosse o total.

Use uma conta de auditoria com acesso autorizado aos catálogos e às contagens completas necessárias, ou execute contra uma réplica/cópia preparada para auditoria. Não alterar permissões de produção apenas para satisfazer a ferramenta. Contagens exatas podem consumir CPU/I/O; planejar a janela e nunca comparar dois bancos que continuam recebendo gravações independentes como se fossem o mesmo snapshot.

O manifesto contém:

- Versão/encoding/collation do PostgreSQL, tamanho total, extensões e suas versões.
- Schemas, roles e associação entre roles, proprietários e ACLs, sem hashes de senha ou credenciais.
- Tabelas, colunas, tipos, nulabilidade, RLS, constraints, índices, triggers, políticas e relações de partição/herança.
- Assinaturas de funções e suas propriedades de segurança; fingerprints das definições, sem corpos SQL em texto.
- Enums/domínios e metadados de sequências, sem chamar `nextval`.
- Contagens exatas em strings decimais, inclusive acima do limite inteiro do JavaScript. Cada relação é contada com `ONLY`: partições são contadas individualmente e pais particionados têm zero linhas físicas; não somar novamente os pais.
- Contagens das tabelas Auth, sem selecionar UUIDs, e-mails, perfis, senhas, tokens ou conteúdo de sessões.
- Configuração de buckets e total de objetos por bucket, sem nomes/caminhos dos objetos ou conteúdo dos arquivos.
- Versões registradas em `supabase_migrations.schema_migrations`, quando esse histórico existe; não exporta suas instruções SQL.

Os fingerprints MD5 são detectores de alteração de catálogo, **não provas criptográficas de integridade ou igualdade dos dados**. Constraints/defaults/políticas podem conter literais privados; por isso suas definições são apenas resumidas por fingerprint. Os identificadores de infraestrutura e metadados também devem ser tratados como privados. Guardar manifesto, mapa e relatório fora do Git e da distribuição. A criação usa modo `0600` em sistemas POSIX; no Windows, aplicar ACLs privadas à pasta. Arquivos existentes não são sobrescritos.

Foreign tables têm seus metadados inventariados, mas seus dados não são consultados e sua presença bloqueia o aceite automático da comparação. Estados de sequência nulos podem significar sequência ainda não usada ou privilégio insuficiente; ambos exigem revisão. O inventário não substitui `pg_dump`: não captura toda a definição de um cluster, settings por role/database, assinaturas de publicações/subscrições ou efeitos externos. Esses itens precisam de avaliação no ensaio.

## Comparação e plano offline

A comparação lê apenas arquivos locais. Um mapa privado pode relacionar nomes antigos aos nomes neutros do destino. O exemplo abaixo é fictício e não deve conter dados, senhas ou nomes de infraestrutura reais no repositório:

```json
{
  "version": 1,
  "schemas": { "old_inventory": "erp_stock" },
  "objects": { "public.old_stock_get": "public.erp_stock_get" },
  "roles": { "old_owner": "erp_owner" },
  "buckets": { "old-attachments": "erp-attachments" }
}
```

As chaves de `objects` identificam um objeto qualificado como `schema.nome`; a assinatura ainda distingue sobrecargas de funções. O mapa deve ser um para um. Não há opção para ignorar tabelas, aceitar perda ou dispensar Auth/Storage. A ferramenta detecta colisões, inclusive quando um objeto renomeado colidir com outro que manteve o nome.

```bash
node tools/portability/compare.mjs \
  --source /var/lib/fagoo-private/migration-audit/source.json \
  --target /var/lib/fagoo-private/migration-audit/target.json \
  --map /var/lib/fagoo-private/migration-audit/namespaces.json \
  --output /var/lib/fagoo-private/migration-audit/comparison.json
```

O mapa é opcional quando os identificadores coincidem. Ele só altera identificadores durante a comparação. **Não é um script para transformar dumps, XMLs, envelopes A1, históricos ou hashes.** Os fingerprints e ACLs de definições renomeadas podem divergir; nesse caso a comparação continua bloqueada. É necessário revisar e provar a equivalência das definições no procedimento de restauração, não apagar os impedimentos nem marcar hashes divergentes como iguais.

Resultados e códigos de saída:

| Resultado | Código | Significado |
| --- | --- | --- |
| `blocked` | 2 | Há objetos/dados sem destino, contagens distintas, alteração de catálogo, permissões, versão, Storage ou outra evidência pendente. |
| `inventory-compatible` | 0 | Os itens comparados coincidem; ainda faltam as evidências funcionais e de dados listadas no relatório. |
| Erro de entrada/processamento | 1 | Arquivo inválido, inventário incompleto, mapa ambíguo, falha de conexão/coleta ou saída já existente. |

**`ready` permanece `false` em ambos os resultados.** Mesma contagem não prova mesmos UUIDs, lançamentos, saldos ou bytes. O relatório lista dados sem tabela de destino e as provas restantes para Auth, objetos, saldos, integridade fiscal, corte e recuperação. Objetos adicionais no destino são apontados; sua legitimidade precisa ser revisada.

## Roteiro de restauração fiel a executar depois

1. Fixar a versão de origem e o conjunto de migrations do FAGOO. Registrar versões reais de PostgreSQL, Auth, Storage, PostgREST, extensões e serviços fiscais. Inventariar tabelas não previstas, funções instaladas fora do repositório, jobs e integrações.
2. Preparar um ambiente isolado com as mesmas dependências reais. Validar a instalação virgem antes de restaurar dados existentes. Não usar stubs de QA nem eliminar migrations que participam do domínio.
3. Obter backup consistente de schema e dados, configurações necessárias de roles/grants e sequência de restauração. Tratar backup de Auth e credenciais por canal privado. O exportador da interface exclui usuários, permissões e material de custódia; seu ZIP não é um backup completo. Não publicar dumps nem logs de restauração.
4. Resolver o mapa de namespaces em procedimento privado, revisado e versionado. Uma alteração de nomes no código para uma instalação virgem não transforma dados antigos. Preservar IDs, relações e conteúdo histórico; adaptar apenas os identificadores estruturais necessários no ensaio.
5. Restaurar preservando UUIDs dos atores, vínculos de usuário, permissões, comandos e referências. Migrar autenticação com o formato e a versão corretos; validar confirmação de e-mail, convites, redefinição de senha e MFA. Planejar invalidação de sessões. Trocar de biblioteca de Auth exige estratégia própria de credenciais/reinscrição, não copiar hashes incompatíveis.
6. Copiar os bytes de todos os buckets por fluxo autenticado e criar um manifesto privado de objeto, tamanho, MIME type e SHA-256. Reconciliar bytes e metadados. Preservar originais imutáveis, acesso privado e leases/estados de upload. Guardar keyring A1 fora do banco e validar contexto/identidade do cofre antes de qualquer reempacotamento. Não substituir strings dentro de envelopes.
7. Restaurar numerações e estados de sequências sem consumir novos números. Preservar parcelas, liquidações, estornos, movimentos, contas, documentos, reservas, lotes, conversões e vínculos. Nunca reproduzir comandos/eventos históricos para recriar saldos.
8. Comparar inventários. Complementar com checks de órfãos/FKs, hashes canônicos de linhas em páginas privadas e reconciliações por produto/depósito/lote e por conta/título/contato/direção/data. Estoque: quantidade, reservado, disponível e soma do ledger. Financeiro: original, liquidado, restante, status e saldo inicial mais movimentos. Preservar centavos inteiros e precisão decimal.
9. Reconciliar chaves fiscais, hashes de XML, protocolos, eventos, cancelamentos, numerações, NSU e backoff. Transmissões com resultado incerto exigem consulta/reconciliação; não devem ser reenviadas como novas emissões. Executar testes de permissões, idempotência, recebimento parcial, liquidação e estorno contra dados sintéticos.
10. Ensaiar corte e recuperação: bloquear novas gravações na origem, drenar/pausar jobs e filas, obter snapshot consistente ou delta controlado, restaurar e comparar, trocar as origens configuradas e testar. Manter a origem somente leitura. Se houver gravações após o corte, reconciliar esse delta antes de voltar; não ligar dois escritores.
11. Medir recursos na VPS, validar retenção de WAL/logs e limites de concorrência. Configurar backup fora do servidor e provar a restauração. O backup não está validado apenas porque o upload terminou.

Essas etapas ainda exigem implementação/ensaio específico para a instalação. As ferramentas deste diretório não modificam o banco, não publicam Cloudflare, não executam importador e não alteram o ambiente de produção.

O planejador anterior de adoção de produtos, `tools/migration/plan_proposal_product_adoption.mjs`, também exige configuração explícita: `SUPABASE_URL` como origem HTTPS, `FAGOO_ADOPTION_ACTOR_ID` como UUID do ator autorizado, `SUPABASE_SERVICE_ROLE_KEY` no ambiente protegido e `FAGOO_READONLY_PLAN_CONFIRMED=yes`. Ele não possui destino nem ator de cliente embutidos. Essa ferramenta continua sendo específica do fluxo de adoção; não restaura um banco ou substitui o roteiro acima. Os demais utilitários históricos em `tools/migration` devem ser revisados individualmente antes de uso e não são executados pelo inventário.

O módulo `tools/recovery/private-storage-snapshot.mjs` pode preparar e copiar uma seleção privada de objetos já inventariados, mediante opt-in explícito. Ele exige `FAGOO_STORAGE_PROJECT` (identificador da instalação, com letras minúsculas, números, `_` ou `-`) e `SUPABASE_URL` (origem HTTPS), e conserva a leitura da credencial por arquivo privado no modo de download. Não há destino de cliente embutido. O identificador deve coincidir com o manifesto fixado por SHA-256; entradas de outra instalação são recusadas antes de qualquer requisição. Comparações e planos incrementais também recusam instalações distintas.

O exportador **privado** `tools/recovery/private-storage-inventory.sql` requer o parâmetro PostgreSQL `fagoo.storage_project`, sem valor padrão. O operador pode configurá-lo via serviço libpq/`PGOPTIONS` ao executar o SQL com `psql -X -w -v ON_ERROR_STOP=1`. Diferentemente do inventário resumido de portabilidade, esse exportador inclui caminhos de objetos necessários à cópia e seu resultado deve ficar estritamente fora do repositório. Ele não fornece senha, URL ou configuração de rede. A cópia continua verificando hashes, privacidade, limites, imutabilidade, leitura local e retomada; não abre certificados nem comprova restauração do banco.

A fixture `tools/migration/helpers/fiscal55-window-fixture.mjs` é baseada em um cenário de homologação, com identidades fictícias e sem conteúdo de certificado ou XML. Seus 31 campos de digest opaco (29 valores distintos) foram regenerados a partir de uma seed sintética estável e caminhos explícitos, preservando referências internas. Os hashes públicos de contratos e manifestos foram mantidos. Essa fixture não é evidência do estado de um cliente. O leitor de baseline do planejador fiscal exige o SHA-256 privado informado explicitamente pelo operador; não possui hash de instalação como valor padrão.

## Verificação das ferramentas

```bash
node --test tools/portability/portability.test.mjs
```

Os testes desse arquivo usam manifestos sintéticos e um processo psql simulado. Cobrem snapshot incompleto, conexão privada, contagens grandes, dados sem destino, mapa conflitante, mudanças de permissões/funções/Storage e bloqueio de prontidão. Não constituem ensaio de restauração nem teste de conectividade com produção.

### Evidências da recomposição

Em 02/11/2026, a cadeia foi comparada com a fonte fixada no commit `97be7a7eab5c132e540748757120a55897f1e971`, usando dois bancos PGlite locais e sintéticos, com finais de linha LF:

- As **311 migrations** foram executadas integralmente, em ordem, tanto na fonte quanto no FAGOO.
- Foram ajustados **39 hashes esperados em 21 migrations** para a normalização dos identificadores. Antes de cada ajuste, foi comprovado que o corpo da função no FAGOO era exatamente a transformação permitida do corpo na fonte. Nenhuma guarda foi removida ou flexibilizada.
- O catálogo final apresentou **1.327 relações**, incluindo tabelas, índices, views e sequências, e **2.310 funções**, equivalentes após essa transformação. Não foram detectadas colisões de nomes nesses catálogos.
- Todos os corpos finais de função comparados corresponderam exatamente à transformação da fonte. Esses números descrevem o banco sintético de validação, incluindo seus schemas auxiliares de teste; não medem um banco de cliente.

O coletor e o comparador também passaram por integração em um PostgreSQL **17.11**, em container descartável com dados exclusivamente sintéticos: **26 verificações** abrangeram Auth/Storage de teste, RLS, partições, enums/domínios, função com `SECURITY DEFINER`, identificador com espaço, contagens `ONLY`, preservação de sequências, falha por privilégio insuficiente, ausência de valores privados na saída e bloqueio por divergências. Oito testes do Worker de sincronização passaram depois da correção das guardas.

Essa validação comprova o comportamento testado das ferramentas e da recomposição de schema. A restauração de uma instalação real continua exigindo os serviços Auth/Storage completos, os dados/objetos privados e as reconciliações do roteiro acima; as estruturas sintéticas dos testes nunca integram o bootstrap de produção.
