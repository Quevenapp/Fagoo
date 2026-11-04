# Orientações para agentes no FAGOO

Para corrigir o sistema, enviar alterações ao GitHub ou disponibilizar uma versão no botão **Atualizar agora**, leia [Publicar correções e atualizações](docs/operations/publishing-updates.md). O procedimento inclui versionamento, testes, assinatura, commit, push, tag, release e verificação no painel.

- O repositório de distribuição é `Quevenapp/Fagoo`, com releases estáveis a partir de `main`. Use branches `codex/` para o trabalho e mantenha GitHub Actions desligado.
- Commit e push não criam uma atualização disponível. O painel consome os três artefatos assinados de uma release pública estável marcada como **Latest**.
- Consulte o estado atual do GitHub antes de escolher a versão. Prepare a release em um checkout limpo do commit revisado; use worktree isolado quando houver trabalho simultâneo. Preserve alterações de outras sessões e não use force push para publicar.
- Execute os testes adequados à mudança. `scripts/release.py` exige também as verificações de continuidade das integrações antes de assinar. Não suprima essas verificações.
- O build definitivo usa a configuração da instalação na VPS. A validação local de produção pode usar a configuração pública sintética descrita no guia, sem credenciais de clientes.
- Preserve configuração privada, dados, vínculos e filas nas atualizações. Material de clientes, chaves privadas, tokens e relatórios de operação ficam fora da distribuição pública.
- Quando existir, `.local/maintenance/release-operator.md` contém somente os caminhos locais do operador para assinatura e artefatos. Esse arquivo é privado e deve permanecer ignorado pelo Git; nunca imprima o conteúdo da chave de assinatura.
- Disponibilizar uma release e instalar essa release em uma VPS são ações distintas. Atualize a instalação quando isso fizer parte do pedido ou já estiver autorizado. Não reinstale o ambiente para aplicar uma correção comum.

Para instalação, acompanhamento e recuperação, consulte [Atualizações do FAGOO](docs/operations/updates.md).
