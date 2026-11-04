# Atualizações do FAGOO

Administradores atualizam a instalação em **Preferências → Sistema → Atualizações do sistema**. A mesma distribuição atende instalações vazias ou com dados. O download das releases públicas não exige conta nem token do GitHub.

## Antes de atualizar

Conclua o [manual de instalação](installation.md), incluindo o serviço `fagoo-updater.service` e a publicação da interface/API. A publicação inicial salva a credencial Cloudflare em `private/install/cloudflare/credentials.json`, com acesso exclusivo de root. Ela permite publicar as próximas versões na conta do próprio cliente. O token do túnel é uma credencial diferente.

O servidor precisa de acesso ao GitHub, aos registros de pacotes/imagens e à API Cloudflare, Node.js 24, Docker Compose e espaço para a nova aplicação e backups. A verificação de espaço reserva duas vezes o tamanho do banco e dos arquivos, mais 2 GiB. Mantenha também uma cópia de segurança fora da VPS. O atualizador não instala atualizações do Ubuntu ou de outros aplicativos do servidor.

Avise os usuários e escolha um horário adequado: o ERP entra em manutenção durante a troca. A preparação e a compilação acontecem antes de pausar o acesso. O tempo depende da conexão, da quantidade de dados e da capacidade da VPS.

## Usar o botão

1. Entre no FAGOO como administrador. A política de acesso e MFA da instalação continua sendo aplicada.
2. Abra **Preferências → Sistema → Atualizações do sistema**. A página consulta automaticamente as releases e mostra **Verificando…** durante a busca.
3. Aguarde a conclusão e confira a versão instalada, a disponível, as notas da release e a data/hora em **Verificado em**. Use **Verificar atualizações** para repetir a consulta quando desejar. Em versões anteriores à v0.2.8, clique nesse botão também ao entrar na página.
4. Clique em **Atualizar agora**. O botão só é habilitado para uma versão posterior, com publicação configurada e sem outra atualização ou recuperação pendente.
5. Acompanhe as etapas na página de progresso. O processo continua na VPS se o navegador fechar. Na mesma sessão, a página pode ser recarregada; o acompanhamento usa uma autorização temporária somente de leitura, válida por duas horas.
6. Aguarde **FAGOO atualizado** e clique em **Abrir FAGOO atualizado**. Confira o login e a versão instalada no painel.

Abrir a página apenas verifica a disponibilidade; a instalação depende do clique em **Atualizar agora**. Uma versão salva de uma consulta anterior aparece como **Última versão conhecida** enquanto a nova consulta não estiver confirmada. Em caso de falha, a página mostra **Não foi possível verificar**, mantém a instalação desabilitada e permite tentar novamente. Ela só informa que a instalação está na versão mais recente depois de uma verificação concluída nesta visita.

Se uma consulta já estiver em andamento, a página acompanha sua conclusão. Uma instalação ou recuperação pendente impede iniciar outra verificação. A consulta periódica de situação acompanha o serviço sem solicitar uma nova busca de release a cada ciclo.

O atualizador não solicita token do GitHub nem pede a credencial Cloudflare a cada clique. Se não houver release posterior, **Atualizar agora** permanece desabilitado. Isso é esperado em uma instalação que já está na versão mais recente.

## O que é atualizado e preservado

O serviço coordena o runtime local (PostgreSQL, autenticação, PostgREST, armazenamento e gateway), as alterações versionadas do schema, o Worker da API e o Worker da interface. Antes de concluir, verifica a versão e a revisão publicadas em `/fagoo-version.json` e `/v1/system/version`, além da saúde da autenticação e do CORS público.

Empresa, usuários, permissões, cadastros, documentos, movimentos, saldos, arquivos, metadados e configuração privada permanecem na instalação. O processo não cria outro administrador, não semeia dados de demonstração e não troca as chaves existentes. O runtime fiscal separado, SMTP, bancos, certificados, agentes externos e suas configurações não são implantados por esse fluxo.

Uma [conexão externa opcional](optional-integration.md) habilitada na configuração privada mantém seu modo, endpoints e credenciais na próxima publicação. A instalação padrão continua desconectada.

A configuração permanente fica em `/opt/fagoo/private/install/.env`, fora das pastas de código das releases. As credenciais OAuth cifradas, checkpoints, vínculos, filas e escolhas operacionais ficam no PostgreSQL persistente. O atualizador passa o mesmo arquivo privado à preparação e à publicação da nova versão e o inclui no backup. Os padrões de instalação vazia não são reaplicados durante uma atualização. Uma conexão privada não precisa de um fork do aplicativo para receber releases comuns.

Cada pacote é acompanhado de um manifesto assinado com Ed25519 e verificado pela chave pública fixada na instalação. O download tem tamanho limitado; o arquivo precisa corresponder ao SHA-256 assinado e não pode conter links, caminhos externos ou diretórios privados. O serviço aceita apenas releases públicas do repositório FAGOO. Ele recusa downgrade, reinstalação da mesma versão, mudanças de hash em migrações já aplicadas e troca da versão principal do PostgreSQL. Atualizações futuras que exigirem outro protocolo precisam de um procedimento próprio.

O serviço fica em um socket Unix privado. A API exige administrador validado e não aceita comandos, caminhos ou URLs arbitrários. O progresso permanece acessível durante a manutenção; as demais requisições ao núcleo recebem `503`. `/healthz` continua respondendo `200` para indicar que o gateway está vivo, sem significar que o ERP já saiu da manutenção.

## Backups e diretórios

A instalação original continua em `/opt/fagoo`. Novas releases ficam em `private/updates/releases/`. `private/updates/installed.json` indica a versão e o código ativos; o serviço carrega essa versão depois de reiniciar. Não execute o instalador inicial nem faça `git pull` para trocar uma instalação gerenciada pelo painel.

Antes de mudar o runtime, o serviço pausa as escritas externas e grava `private/backups/update-<identificador>/` com:

- `database.dump`: backup lógico completo do banco, incluindo os metadados de autenticação e armazenamento.
- `storage.tar`: bytes dos arquivos armazenados.
- `runtime.env`: configuração privada existente.
- `previous-runtime-images.json`: identidades das imagens que estavam em execução.
- `recovery.json`: versão anterior, versões publicadas dos Workers, hashes dos backups e estado da operação.

Os logs ficam em `private/updates/<identificador>.log`. Os backups contêm dados e segredos; não os publique nem os anexe integralmente a um chamado. A chave do túnel em `/etc/fagoo/cloudflared/token` e a credencial Cloudflare precisam de cópias privadas próprias. Backups e releases anteriores não são apagados automaticamente: acompanhe o espaço e retenha os materiais necessários à recuperação.

## Recuperação

Se houver falha durante a preparação, os serviços existentes continuam disponíveis. Confira o erro, a conexão, o espaço e as credenciais; depois verifique as atualizações novamente.

Uma falha após o início da manutenção mantém o ERP pausado e informa **Recuperação necessária**, com o identificador do backup. Não remova o marcador de manutenção para forçar a abertura. A restauração não é automática porque pode desfazer alterações do banco e dos arquivos.

No console da VPS, confirme a instalação e o identificador mostrado no painel. Substitua `IDENTIFICADOR` pelo UUID completo:

```sh
cd /opt/fagoo
sudo python3 infra/recover-update.py --root /opt/fagoo --backup-id update-IDENTIFICADOR --confirm-restore
```

`--confirm-restore` confirma que esta instalação voltará ao seu backup anterior à atualização interrompida. O comando valida os hashes, recupera configuração, banco e arquivos quando necessário, inicia as imagens anteriores e republica as versões anteriores dos dois Workers. Ele verifica versão pública e saúde antes de liberar o acesso. O backup é preservado. O diagnóstico fica em `recovery.log`, dentro do diretório do backup.

Se a falha ocorreu antes de substituir o runtime, o comando apenas retoma os serviços anteriores e verifica a implantação. Se a VPS perdeu o disco ou o backup está inválido, esse procedimento não substitui a recuperação a partir da cópia externa. Se o token Cloudflare expirou, renove-o antes de recuperar.

## Renovar a credencial Cloudflare

Crie ou renove o token com as permissões e os escopos descritos no [manual](installation.md#se-perder-o-token-ou-ele-expirar). Na VPS:

```sh
cd /opt/fagoo
sudo python3 infra/configure-updates.py --root /opt/fagoo
```

Cole o novo token no prompt oculto. O comando reaproveita os IDs salvos, confere conta, zona e domínios, e guarda o valor com permissão `0600`. Não recompila nem publica a aplicação. Na primeira configuração manual, acrescente `--account-id ACCOUNT_ID --zone-id ZONE_ID`. Depois volte ao painel e clique em **Verificar atualizações**.

## Diagnóstico no servidor

```sh
sudo systemctl is-active fagoo-updater.service
sudo journalctl -u fagoo-updater.service -n 30 --no-pager
```

O primeiro comando deve retornar `active`. Não exponha o socket nem altere as permissões dos arquivos privados. O lock impede duas operações simultâneas. Um bloqueio de processo do painel comprovadamente encerrado pode ser recuperado pelo serviço; um bloqueio desconhecido exige inspeção. Não apague diretórios privados ou volumes para contornar um erro.

`scripts/update-runtime.sh` permanece como ferramenta técnica do núcleo. Seu uso não publica web/API nem atualiza o registro da release ativa; utilize o painel para a atualização coordenada.

## Publicação pelo mantenedor

O procedimento completo, com commit, push, versão, assinatura, tag, release e conferência do botão, está em [Publicar correções e atualizações](publishing-updates.md). Ele também explica a validação local do build sem credenciais de clientes e o uso de worktree isolado para trabalho simultâneo.

O mantenedor confirma um commit limpo, atualiza a versão do `package.json` e do lockfile, executa as verificações e prepara os artefatos:

```sh
python3 scripts/release.py --version vVERSAO --key /CAMINHO-PRIVADO/assinatura.pem --out /CAMINHO-PRIVADO/release --notes-file /CAMINHO/notas.txt
```

Antes de empacotar ou assinar, esse comando executa obrigatoriamente `scripts/check-update-continuity.py`. A verificação cobre configuração privada e backup durante a troca de release, manutenção do modo de sincronização e do agendamento, preservação de credenciais cifradas/checkpoints/vínculos/filas ao repetir os padrões de instalação, rotas da API e proteções de entrega. Falha ou execução incompleta impede gerar o pacote. O código precisa continuar limpo e no mesmo commit após os testes. Esses testes usam dados sintéticos e não acessam instalações de clientes.

Para executar a mesma verificação antecipadamente, com as dependências de desenvolvimento instaladas, use `python3 scripts/check-update-continuity.py`. O mantenedor também deve validar o ciclo de atualização em ambiente de teste; os testes de regressão não substituem a conferência operacional de uma instalação após atualizar.

Publique `fagoo-source.tar.gz`, `fagoo-release.json` e `fagoo-release.sig` juntos na release da mesma tag do repositório `Quevenapp/Fagoo`. O painel consulta a release estável marcada como latest. Não substitua artefatos de uma versão já distribuída; publique uma nova versão. A chave privada de assinatura nunca integra o código ou a VPS do cliente. A publicação é manual e não requer habilitar GitHub Actions.
