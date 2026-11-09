# Publicar correções e atualizações

Este procedimento permite que um mantenedor ou agente envie uma correção ao repositório e a disponibilize em **Preferências → Sistema → Atualizações do sistema**. O painel instala um pacote de código-fonte assinado. Commit, push e tag, por si só, não habilitam o botão **Atualizar agora**.

O build definitivo acontece na VPS com a configuração da própria instalação. O mantenedor não precisa copiar credenciais de clientes para preparar a release. A publicação no GitHub torna a versão disponível; a instalação pelo painel é uma etapa posterior.

## Repositório e requisitos

| Item | Configuração |
| --- | --- |
| Repositório público | `https://github.com/Quevenapp/Fagoo.git` |
| Remote esperado | `origin`; confirme com `git remote -v` |
| Branch de distribuição | `main` |
| Branches de trabalho | Prefixo `codex/` |
| GitHub Actions | Desligado; publicação manual |
| Ferramentas do mantenedor | Git, GitHub CLI autenticado, Node.js 24, npm, Python 3 e OpenSSL 3 |
| Chave de assinatura | Chave Ed25519 existente, correspondente a `infra/release-root.pem` |
| Artefatos obrigatórios | `fagoo-source.tar.gz`, `fagoo-release.json`, `fagoo-release.sig` |

Os comandos abaixo usam PowerShell 7. Execute cada bloco e confira o resultado antes de avançar. Use `python3` no lugar de `python` em ambientes onde esse seja o nome do interpretador. As validações fiscais completas podem exigir Linux e as dependências descritas no [README](../../README.md).

## Conferir o trabalho e escolher a versão

Na raiz do checkout de trabalho:

```powershell
git status --short
git branch --show-current
git remote -v
git fetch origin main
git log -5 --oneline
gh release list --repo Quevenapp/Fagoo --limit 5
gh api repos/Quevenapp/Fagoo/actions/permissions --jq .enabled
```

O último comando deve retornar `false`. Consulte também as tags e os rascunhos existentes ao reservar a próxima versão. Escolha uma versão maior que a última estável, sem reutilizar versões já distribuídas. Não suponha que a versão mencionada em um chat antigo ainda seja a mais recente.

Crie uma branch `codex/descricao-da-correcao` a partir da base revisada. Confira o diff em relação a `origin/main` para identificar todos os commits que farão parte da release. Se houver alterações de outra sessão, preserve-as e trabalhe em um checkout separado; não faça stash, limpeza ou troca de branch indiscriminada no diretório compartilhado.

Defina a nova versão; substitua o exemplo antes de executar:

```powershell
$fagooRepo = (git rev-parse --show-toplevel).Trim()
$fagooVersion = 'vX.Y.Z'
```

## Versionar e commitar a correção

Implemente e revise a correção. Atualize a versão do pacote, sem criar tag automaticamente:

```powershell
npm version ($fagooVersion.Substring(1)) --no-git-tag-version --ignore-scripts
```

Confira se `package.json.version`, `package-lock.json.version` e `package-lock.json.packages[""].version` correspondem à versão escolhida, sem o prefixo `v`. Se a tarefa já incrementou esses campos, confira-os em vez de incrementar novamente.

Adicione ao stage somente os arquivos da tarefa, incluindo os dois arquivos de versão. Revise o diff completo e as verificações antes de commitar:

```powershell
git diff --cached
git diff --cached --check
git diff --cached --stat
git commit -m "fix: descreva a correção e o comportamento resultante"

$fagooReleaseCommit = (git rev-parse HEAD).Trim()
$fagooBranch = (git branch --show-current).Trim()
```

Não inclua dados comerciais, inventários de clientes, dumps, credenciais, chaves, certificados, capturas de operação ou relatórios privados nos arquivos da release. Preserve o histórico de desenvolvimento.

## Isolar o commit e executar as verificações

Use um worktree isolado para que alterações simultâneas não mudem o código durante o empacotamento. Os caminhos `.local` dos exemplos devem estar ignorados pelo Git. Se não estiverem, use diretórios privados fora do checkout.

```powershell
$fagooSource = Join-Path $fagooRepo ".local/updates/source-$fagooVersion"
$fagooOutput = Join-Path $fagooRepo ".local/updates/release-$fagooVersion"
$fagooNotes = Join-Path $fagooRepo ".local/audit/release-$fagooVersion.md"

git worktree add --detach $fagooSource $fagooReleaseCommit
Set-Location $fagooSource
npm run install:deployment
if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar as dependências da release.' }
```

Se um desses diretórios já existir, confira sua finalidade e use um novo caminho quando necessário. Não apague ambientes ou sobrescreva artefatos de uma publicação anterior para contornar a verificação.

`install:deployment` instala as dependências fixadas na raiz, em `workers/erp-api`, `workers/communication`, `packages/fiscal-xml` e `packages/fiscal-danfe`. Apenas `npm ci` na raiz não prepara todos os pacotes necessários. Execute os testes relevantes aos módulos modificados, incluindo regressões que reproduzam a falha corrigida. Para mudanças visuais, confira também as telas e os tamanhos de viewport afetados.

Valide o build de produção em um processo temporário, com configuração pública sintética:

```powershell
pwsh -NoProfile -Command {
    $env:VITE_SUPABASE_DEPLOYMENT = 'self-hosted'
    $env:VITE_SUPABASE_URL = 'https://services.example.test'
    $env:VITE_SUPABASE_ANON_KEY = 'sb_publishable_0123456789abcdefghijklmnop'
    $env:VITE_SUPABASE_PUBLISHABLE_KEY = ''
    $env:VITE_ERP_API_URL = 'https://api.example.test'
    $env:VITE_A1_API_URL = ''
    npm run build:erp:release
    exit $LASTEXITCODE
}
if ($LASTEXITCODE -ne 0) { throw 'Build de produção reprovado.' }
```

O processo temporário evita deixar essas variáveis no ambiente do operador. Os endereços `.test` e a chave de exemplo não dão acesso a uma instalação e não devem ser usados para publicar uma aplicação. O pacote de atualização leva o código-fonte versionado, não esse `dist` local.

`ERP_PUBLIC_ACCESS_CONFIG_REQUIRED` indica que a configuração pública do frontend não foi fornecida. Use o bloco acima para validar sem dados de clientes. Um bundle em modo development não substitui a validação de produção. Consulte também [Build da interface](release-build.md).

## Preparar e assinar os três artefatos

Escreva as notas da versão em `$fagooNotes`, fora do código público. Descreva o problema corrigido, o comportamento resultante, as verificações realmente executadas e eventuais limitações pertinentes. O texto dessas notas será público na release e no painel do cliente.

Defina `$fagooSigningKey` com o caminho da chave privada existente. No ambiente do operador, o inventário local pode estar em `.local/maintenance/release-operator.md`. Não crie outra chave para contornar uma assinatura inválida: as instalações confiam na chave pública já distribuída em `infra/release-root.pem`.

No worktree isolado, execute:

```powershell
git status --short
python scripts/release.py `
    --version $fagooVersion `
    --key $fagooSigningKey `
    --out $fagooOutput `
    --notes-file $fagooNotes
if ($LASTEXITCODE -ne 0) { throw 'A release não foi preparada.' }
```

O script exige um commit limpo e a versão correspondente ao pacote. Antes de empacotar, executa obrigatoriamente `scripts/check-update-continuity.py`: configuração privada, backup, publicação, atualização, padrões do banco, rotas de integração e proteções de entrega. Ele confere novamente o commit e a limpeza do checkout após os testes.

O empacotamento usa `git archive` do commit revisado, calcula o SHA-256, cria o manifesto e o assina com Ed25519. A assinatura é validada com a chave pública do repositório e a extração do pacote também é conferida. O resultado deve informar `signature_verified: true` e o mesmo `revision` de `$fagooReleaseCommit`.

O comando recusa sobrescrever os três arquivos em um diretório de saída já utilizado. Em uma nova tentativa ainda não publicada, use outro diretório de saída e execute todas as verificações normalmente. Não ignore erros nem edite o manifesto depois de assinado.

## Enviar o commit e a tag

Confirme que nenhum trabalho concorrente avançou `main` além da base do commit preparado:

```powershell
git fetch origin main
git merge-base --is-ancestor origin/main $fagooReleaseCommit
if ($LASTEXITCODE -ne 0) {
    throw 'main avançou: integre e revise as mudanças antes de preparar outra release.'
}
```

Se for necessário integrar mudanças, volte à branch de trabalho, revise o resultado, fixe o novo commit e repita a validação e a assinatura em um checkout limpo. Nunca use force push para publicar uma release. Depois que uma versão tiver sido distribuída, qualquer correção exige uma nova versão.

Quando o commit preparado incluir a versão atual de `main`, crie a tag e envie as referências de forma atômica:

```powershell
git tag $fagooVersion $fagooReleaseCommit
if ($LASTEXITCODE -ne 0) { throw 'Confira a tag existente antes de continuar.' }

git push --atomic origin `
    "${fagooReleaseCommit}:refs/heads/main" `
    "${fagooReleaseCommit}:refs/heads/$fagooBranch" `
    "refs/tags/$fagooVersion"
if ($LASTEXITCODE -ne 0) { throw 'O envio ao repositório não foi concluído.' }
```

Isso preserva a correspondência entre commit, branch, tag e manifesto. Se a tag já existir, verifique para qual commit ela aponta; não a mova nem a apague automaticamente. Se houver proteção de branch exigindo PR, siga essa política e prepare os artefatos do commit final resultante antes da publicação.

## Publicar a release estável

Crie primeiro um rascunho contendo os três artefatos:

```powershell
gh release create $fagooVersion `
    (Join-Path $fagooOutput 'fagoo-source.tar.gz') `
    (Join-Path $fagooOutput 'fagoo-release.json') `
    (Join-Path $fagooOutput 'fagoo-release.sig') `
    --repo Quevenapp/Fagoo `
    --verify-tag `
    --title "FAGOO $fagooVersion" `
    --notes-file $fagooNotes `
    --draft
if ($LASTEXITCODE -ne 0) { throw 'Confira o rascunho e os uploads antes de continuar.' }

gh release view $fagooVersion --repo Quevenapp/Fagoo `
    --json tagName,isDraft,isPrerelease,targetCommitish,assets,url
```

Confira tag, notas e os três arquivos com estado `uploaded`, nomes exatos e tamanhos iguais aos arquivos locais. Uma falha parcial de upload deve ser resolvida no rascunho existente; não publique um rascunho incompleto. O arquivo automático de código-fonte do GitHub não substitui `fagoo-source.tar.gz` nem os arquivos de assinatura.

Depois da conferência, publique como estável e **Latest**:

```powershell
gh release edit $fagooVersion --repo Quevenapp/Fagoo --draft=false --latest
if ($LASTEXITCODE -ne 0) { throw 'A publicação da release não foi confirmada.' }

gh release view $fagooVersion --repo Quevenapp/Fagoo `
    --json tagName,isDraft,isPrerelease,publishedAt,url
gh api repos/Quevenapp/Fagoo/releases/latest --jq .tag_name
gh api repos/Quevenapp/Fagoo/actions/permissions --jq .enabled
```

Confirme `isDraft: false`, `isPrerelease: false`, a nova tag como `latest` e Actions ainda desligado. Não habilite Actions nem substitua artefatos de versões já distribuídas.

## Conferir a disponibilidade e a instalação

Entre como administrador na instalação e abra **Preferências → Sistema → Atualizações do sistema**, rota `/preferencias/sistema/atualizacoes`. A partir da v0.2.8, a página verifica automaticamente a disponibilidade ao abrir. Aguarde a conclusão, confira **Verificado em**, a versão e as notas. Clique em **Verificar atualizações** para repetir a consulta ou ao usar uma versão anterior do painel. A informação **Última versão conhecida** não confirma uma consulta atual. A release fica disponível sem token GitHub para o cliente. O mantenedor usa sua própria autenticação GitHub para fazer push e publicar os artefatos.

**Atualizar agora** depende de uma versão superior à instalada, credencial Cloudflare configurada e ausência de atualização ou recuperação pendente. Se o pedido for somente disponibilizar a correção, reporte o link da release e a versão oferecida. Aplique a atualização na VPS quando essa etapa fizer parte do pedido ou já estiver autorizada.

O serviço consulta `https://github.com/Quevenapp/Fagoo/releases/latest/download/fagoo-release.json` e busca a assinatura no endereço da versão indicada no manifesto. Assim, uma publicação simultânea não mistura assinaturas de versões diferentes. O pacote baixado precisa corresponder ao tamanho e ao hash assinados.

Na VPS, `infra/update_pipeline.py` executa `npm run install:deployment` e prepara a aplicação com `infra/deploy-application.py`. O build recebe os endereços e a chave pública de `/opt/fagoo/private/install/.env`. A publicação usa `/opt/fagoo/private/install/cloudflare/credentials.json`, já configurado na instalação. As credenciais privadas não entram no bundle do navegador.

O processo prepara a aplicação, salva backup, atualiza os serviços e as migrações, publica API/interface e verifica versão, revisão, autenticação e CORS antes de concluir. Ele preserva o PostgreSQL persistente, arquivos e configuração privada, incluindo as conexões opcionais configuradas. Não execute o instalador inicial nem `git pull` na VPS para substituir esse fluxo.

Após uma instalação autorizada, confira **FAGOO atualizado**, a versão instalada, a tela corrigida e as funções afetadas. Em instalações com conexão externa, confira também o modo e as filas. Registre a release, o commit, as verificações realizadas e, se houve instalação, o resultado observado. Evidências específicas da instalação ficam na documentação privada.

## Resolver falhas de preparação e publicação

| Sinal | Ação |
| --- | --- |
| `CLEAN_COMMITTED_SOURCE_REQUIRED` | Use um checkout limpo do commit revisado. Não remova o trabalho de outra sessão. |
| `SOURCE_CHANGED_DURING_RELEASE_CHECKS` | Fixe o commit e repita em worktree isolado. |
| `RELEASE_VERSION_MUST_MATCH_PACKAGE` | Confira a tag solicitada e os três campos de versão. |
| `UPDATE_CONTINUITY_CHECKS_FAILED` | Leia o teste que falhou e corrija a causa. Para dependências ausentes, execute `npm run install:deployment`. |
| `UPDATE_CONTINUITY_CHECKS_INCOMPLETE` | Corrija a ferramenta ausente ou a execução interrompida e repita o procedimento. |
| `ERP_PUBLIC_ACCESS_CONFIG_REQUIRED` | Forneça configuração pública ao build; para validação local, use o bloco sintético acima. |
| `RELEASE_OUTPUT_ALREADY_EXISTS` | Confira os arquivos e escolha outro diretório para uma tentativa ainda não publicada. |
| Assinatura inválida | Confira a chave existente e a integridade dos arquivos; não troque a raiz de confiança para contornar o erro. |
| Push recusado | Confira o avanço de `main` ou as regras da branch e revise a integração, sem force push. |
| Botão não oferece a release | Confira publicação estável/Latest, três artefatos, versão superior e resultado de **Verificar atualizações**. |
| Painel informa recuperação necessária | Siga [Atualizações e recuperação](updates.md#recuperação); não remova o marcador de manutenção para forçar acesso. |

As referências de implementação são [release.py](../../scripts/release.py), [check-update-continuity.py](../../scripts/check-update-continuity.py), [update_agent.py](../../infra/update_agent.py), [update_pipeline.py](../../infra/update_pipeline.py) e [deploy-application.py](../../infra/deploy-application.py).
