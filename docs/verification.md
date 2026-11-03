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

Os nomes das variáveis de teste acima são identificadores técnicos usados pelas suítes. Use um diretório no filesystem nativo do Linux para os testes extensos. Dependências nativas devem ser instaladas no mesmo sistema operacional em que serão executadas.

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

O script de instalação do sistema operacional não foi executado integralmente em uma VPS Ubuntu nova nessa rodada. A restauração lógica local não constitui recuperação completa da implantação. Também permanecem sem ensaio integrado a publicação HTTPS, SMTP, MFA pela interface publicada, Workers, runtime fiscal, atualização entre duas releases distintas e atualização pelo painel. Não foi medida capacidade de produção na VPS de referência.

Uma release instalável precisa demonstrar o bootstrap de uma base comercial vazia, cadastro inicial, login/MFA, permissões, arquivos, backup e restauração. A atualização deve ser ensaiada separadamente com uma instalação preenchida, preservando os dados e as configurações locais e aplicando as mudanças versionadas de schema.

A recuperação após falha também precisa ser comprovada. O [manual de instalação](operations/installation.md), o [contrato de atualização](operations/updates.md) e o [estado do projeto](status.md) descrevem esses critérios e o que ainda precisa ser implementado.
