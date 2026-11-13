# Verificação do FAGOO

As verificações descritas nesta página usam cenários sintéticos e builds locais. Elas não acessam os dados de uma instalação de cliente.

## Resultados da validação ampla

Última rodada ampla: 02/11/2026. Os resultados abaixo registram os casos únicos aprovados após correções e repetições pontuais.

| Verificação | Resultado |
| --- | --- |
| Interface ERP | 2.625 casos únicos aprovados, zero skips |
| Pacotes de domínio/fiscal/configuração | 1.591 casos únicos aprovados; 55 casos condicionais não executados na suíte geral |
| Workers, conectores, API e integração | 169 testes aprovados |
| Configuração comum de backend | 23 testes aprovados; também incluídos na suíte de pacotes |
| TypeScript e build do ERP | Aprovados; build com origens e chave pública fictícias |
| Inspeção do build público | Sem achados na rodada final |
| Quatro Workers | Empacotamento local aprovado |
| Container fiscal | Build do estágio `test` e testes internos aprovados |
| Auditoria npm da raiz | Zero vulnerabilidades reportadas na rodada registrada |

Os totais por frente se sobrepõem e não devem ser somados. Os 55 casos condicionais da suíte geral permanecem identificados como não executados nessa rodada. O estágio Docker executa seu próprio perfil de testes, incluindo verificações fiscais de processo.

As suítes verificam contratos de dados e permissões, regras comerciais, recuperação de comandos, integridade de arquivos e limites de execução. Cenários fiscais com validade definida usam relógios sintéticos de teste, preservando as verificações de vencimento e os prazos de produção. Essas evidências não substituem o ensaio completo do instalador ou a homologação de uma operação fiscal/bancária.

## Reproduzir

Instale as dependências indicadas no README. Para as suítes fiscais, use Linux, OpenSSL 3 e Python:

```sh
python3 -m venv .venv
.venv/bin/pip install -r packages/fiscal-schema/requirements.txt
export BRUFAP_TEST_OPENSSL_PATH=/usr/bin/openssl
export BRUFAP_TEST_PYTHON="$PWD/.venv/bin/python3"
node --test --test-concurrency=4 packages/*/test/*.test.mjs
npm run test:erp
npm run test:backend
docker build --target test -f packages/fiscal-runtime/Dockerfile -t fagoo-fiscal-validation .
```

Os nomes das variáveis de teste acima são identificadores técnicos usados pelas suítes. Sem `BRUFAP_TEST_PYTHON`, os testes fiscais usam `.venv/bin/python3` quando esse ambiente existe na raiz e, depois, `/usr/bin/python3`. Use um diretório no filesystem nativo do Linux para os testes extensos. Dependências nativas devem ser instaladas no mesmo sistema operacional em que serão executadas.

Os validadores fiscais oficiais rodam no Linux, como no runtime fiscal. No Windows, `npm run test:erp` marca como ignorados os casos da interface que leem XML assinado por esses validadores; execute a suíte no Linux, por exemplo no WSL, para cobri-los.

Na suíte da API (`workers/erp-api/test`), o caso de `backup-import.test.mjs` que derruba a conexão TCP durante a verificação também é ignorado no Windows: ali o workerd só percebe a queda na escrita seguinte, depois de a conclusão já ter sido enviada. A API roda em Linux, e o caso precisa ser executado nele.

O build do frontend exige configuração pública válida da instalação. A compilação usada nesta verificação empregou domínios fictícios e não serve como build de produção configurado para um cliente.

## Aceite de instalação e atualização

Na revisão do núcleo local em 02/11/2026, foram usados containers reais com dados exclusivamente sintéticos:

| Verificação do núcleo local | Resultado |
| --- | --- |
| PostgreSQL, autenticação, PostgREST, armazenamento e gateway | Inicialização aprovada, com imagens fixadas por digest e acesso externo ao banco desabilitado |
| Estrutura do ERP | 311 versões aplicadas ao PostgreSQL real, com guardas de integridade preservadas e histórico de hashes |
| Primeiro administrador | Usuário Auth, permissão ERP e marcador permanente criados; nova inicialização recusada mesmo após remoção da permissão sintética |
| Login e API de dados | Sessão real e RPC `erp_access_me` aprovadas |
| Arquivos | Upload e download em bucket privado, com igualdade dos bytes |
| Atualizador do núcleo | Credenciais, administrador, histórico e arquivo sintéticos preservados; execução concorrente recusada |
| Backup e restauração lógica | Dump restaurado em segundo banco sintético, preservando histórico, marcador, permissão e metadados de arquivo; tar conferido com bytes idênticos |
| Proteções do schema | Divergência de hash recusada; falha SQL desfez os objetos e a entrada de histórico da mesma transação |
| Testes unitários de infraestrutura | 7 aprovados |
| Shell | Sintaxe dos dois scripts aprovada com `bash -n` |
| Interface após revisão | TypeScript e build aprovados; 426 arquivos de build inspecionados sem achados |

Reproduza as verificações unitárias com `python3 -m unittest discover -s infra -p 'test_*.py'`. O [manual de instalação](operations/installation.md) apresenta os comandos do núcleo. Não execute procedimentos destrutivos de ensaio sobre volumes de uma instalação em uso.

Na rodada de 02/11, o script de instalação do sistema operacional ainda não havia sido executado integralmente em uma VPS Ubuntu nova, e a restauração lógica local não constituía recuperação completa da implantação. Os resultados posteriores da instalação e do atualizador estão descritos abaixo. SMTP, MFA pela interface publicada, runtime fiscal e capacidade sob carga têm validações operacionais próprias.

Uma release instalável precisa demonstrar o bootstrap de uma base comercial vazia, cadastro inicial, login/MFA, permissões, arquivos, backup e restauração. A atualização deve ser ensaiada separadamente com uma instalação preenchida, preservando os dados e as configurações locais e aplicando as mudanças versionadas de schema.

O [manual de instalação](operations/installation.md), o [contrato de atualização](operations/updates.md) e o [estado do projeto](status.md) descrevem o procedimento disponível e seus limites.

## Atualizador pelo painel: validação de 03/11/2026

A release `v0.2.1`, revisão `5a92aa90a30f57348d330d2bbb8193201eed19fe`, foi obtida e instalada pelo botão do FAGOO em uma VPS de demonstração com Ubuntu 24.04, 1 vCPU e 4 GB de RAM. A instalação de partida usava a versão de preparação `v0.2.0-dev.0`. O teste não exigiu token GitHub; a publicação utilizou a credencial Cloudflare salva privadamente na VPS.

| Verificação | Evidência e resultado |
| --- | --- |
| Serviço de atualização | Unit instalada e iniciada no Ubuntu; socket Unix alcançável somente pelo contrato autenticado do gateway |
| Autorização | Testes do handler real da API verificaram administrador, vínculo de acesso, MFA, CORS e recusa de operações não permitidas |
| Release pública | Download do manifesto, assinatura Ed25519, hash e extração segura aprovados; artefato de aproximadamente 8,9 MB |
| Fluxo pelo navegador | Verificar atualizações, selecionar release, iniciar e acompanhar; recarregamento da página retomou o progresso |
| Atualização coordenada real | Preparação, backup, serviços, migrações, publicação da API e da interface e verificação pública concluídos |
| Versão publicada | Web e API responderam `v0.2.1` e a mesma revisão; autenticação respondeu `200`; API sem sessão respondeu `401` |
| Retorno à aplicação | A sessão administrativa continuou acessando o ERP após a atualização |
| Recuperação real na demonstração | Um ensaio anterior parou na verificação pública; o procedimento restaurou banco, arquivos, imagens anteriores e versões dos dois Workers, verificou as origens e reabriu o acesso |
| Proteção durante a falha | ERP permaneceu em manutenção, com backup preservado e acompanhamento disponível |
| Preservação com dados sintéticos | Em Ubuntu/WSL com os cinco serviços reais: registro de banco, administrador, histórico do schema, configuração privada e arquivo binário preservados na atualização e na restauração completa |

O ensaio local de preservação usou uma release sintética assinada com chave de teste. Nesse ensaio específico, build e Cloudflare foram substituídos por adaptadores de teste; os serviços, backup, banco, armazenamento e recuperação foram reais. A publicação Cloudflare e o fluxo do botão foram exercitados separadamente na VPS de demonstração, como registrado acima.

Na demonstração, a Cloudflare recusou o identificador padrão das consultas Python de saúde. A `v0.2.1` identifica essas chamadas como `FAGOO-updater/1`, sem alterar as proteções da zona. A avaliação `v0.2.0` foi mantida como pré-release; o canal estável e o manual selecionam `v0.2.1`.

Verificações de código executadas para esta entrega:

- Infraestrutura: 39 testes na descoberta Python, sendo 36 aprovados e 3 de CORS executados separadamente contra o gateway real, também aprovados.
- Atualizador: 12 testes Python incluídos no total anterior, 7 testes do handler da API e 6 testes do controlador/componentes da interface.
- Regressão de acesso, preferências, menus e recuperação: 49 testes JavaScript aprovados, incluindo os 7 testes da API de atualização.
- TypeScript, build da interface e empacotamento/publicação dos Workers aprovados. O helper inspecionou 336 arquivos públicos sem encontrar os segredos da instalação.
- Assinatura do pacote e extração verificadas novamente na preparação de cada release. GitHub Actions permaneceu desabilitado.

Esses resultados validam o atualizador e sua recuperação no cenário descrito. Não constituem teste de carga, homologação fiscal/bancária ou ensaio de todas as combinações de integrações. A VPS de demonstração já havia sido instalada; esta rodada acrescentou e validou o atualizador sem formatá-la. O instalador inicial e o guia continuam exigindo Ubuntu 24.04 e uma pasta/volumes novos.
