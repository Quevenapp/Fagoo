# Publicação da interface e da API

O comando `infra/deploy-application.py` compila e publica a interface web do FAGOO e a API completa do ERP em dois Workers da conta Cloudflare desta instalação. Ele usa o núcleo local e as três origens já geradas por `infra/configure.py`; não cria outro banco, usuário ou conjunto de dados.

## Preparação

Conclua o núcleo descrito no [manual de instalação](installation.md). Publique o gateway local por uma origem HTTPS, por exemplo usando um Cloudflare Tunnel até `http://localhost:8081` na VPS. A origem de serviços deve responder por HTTPS com certificado válido antes de testar login. As portas PostgreSQL e dos serviços internos continuam privadas.

As três origens têm funções diferentes:

| Origem | Destino |
| --- | --- |
| `FAGOO_WEB_ORIGIN` | Worker dos arquivos da interface |
| `FAGOO_API_ORIGIN` | Worker das rotas de negócio `/v1` |
| `FAGOO_BACKEND_ORIGIN` | Gateway da VPS para autenticação, dados e arquivos |

Use Node.js 24 e as dependências fixadas no repositório. Na raiz do código:

```sh
npm run install:deployment
python3 -m unittest discover -s infra -p 'test_deploy_application.py'
```

O instalador executa `npm ci` nas quatro árvores necessárias: raiz, `workers/erp-api`, `packages/fiscal-xml` e `packages/fiscal-danfe`, usando o lockfile de cada uma. Instale com o usuário dono da cópia do código. O deploy verifica as dependências diretas dessas quatro árvores antes de compilar; executar somente `npm ci` na raiz deixa dependências da API ausentes.

Obtenha o Account ID e o Zone ID no painel Cloudflare. O token precisa acessar somente a conta e a zona escolhidas, com `Workers Scripts — Edit`, `Workers Routes — Edit`, `Zone — Read` e `DNS — Read` (ou `DNS — Edit` quando o mesmo token também configurar DNS). Ele será solicitado sem eco e, após uma publicação concluída, salvo em `private/install/cloudflare/credentials.json` com permissão `0600`, para atualizações pelo painel. Não coloque token em argumentos, no Git ou no frontend.

O Cloudflare mostra o valor completo uma única vez. Pause a gravação antes de gerar ou revelar o segredo e salve-o no seu gerenciador de senhas, junto da identificação da conta, domínio e validade, antes de clicar em **Veja todos os tokens de API** (ou **Done**, em outras versões do painel). A cópia privada na VPS permite as próximas atualizações pelo painel. Se perder um token ainda válido, use **Profile → API Tokens → Actions → View summary** para conferir o escopo e a validade; volte com **Back**, escolha **Actions → Roll** e pause a gravação antes de confirmar. **Roll invalida o valor antigo e mantém as permissões, os recursos e a expiração**. Se expirou, crie um novo token com as permissões e os escopos acima. Veja o [passo a passo para perda ou expiração](installation.md#se-perder-o-token-ou-ele-expirar). Esse token é diferente da credencial do Cloudflare Tunnel.

## Ensaio sem publicação

Substitua os identificadores abaixo pelos valores do painel:

```sh
sudo python3 infra/deploy-application.py \
  --account-id ACCOUNT_ID \
  --zone-id ZONE_ID \
  --dry-run
```

O comando deriva somente as variáveis públicas do build, executa TypeScript/build, verifica os artefatos e empacota os dois Workers com o Wrangler instalado pela preparação acima. O modo de ensaio não solicita token nem publica serviços. Os identificadores de conta e zona devem ter 32 caracteres hexadecimais, inclusive no ensaio. O `sudo` permite ler `private/install/.env`, criado pelo instalador com acesso exclusivo de root; não altere essa permissão para tornar o arquivo público.

As configurações Wrangler geradas e logs ficam em `private/install/cloudflare/`. Os nomes dos Workers são estáveis por instalação, derivados da origem web: `fagoo-api-<sufixo>` e `fagoo-web-<sufixo>`. Logs têm acesso restrito e os valores privados conhecidos são ocultados. A configuração original `private/install/.env` não é sobrescrita.

## Publicação

Os hostnames web e API serão domínios personalizados dos Workers. Se houver registros A/CNAME provisórios nesses **dois nomes**, remova somente esses registros pelo painel antes do primeiro deploy. Preserve o DNS do domínio principal, e-mails, outros serviços e o hostname do túnel. A publicação criará os registros gerenciados dos domínios personalizados.

O helper verifica a conta/zona e recusa DNS conflitante ou um domínio pertencente a outro Worker. Essa verificação é necessária porque o Wrangler sem terminal interativo pode substituir conflitos de DNS automaticamente. Não use uma opção de força para contornar um conflito.

```sh
sudo python3 infra/deploy-application.py \
  --account-id ACCOUNT_ID \
  --zone-id ZONE_ID \
  --deploy
```

Depois dos testes locais, digite o token no prompt oculto. A chave de serviço do banco e a credencial interna do atualizador são transmitidas ao Worker da API como segredos da versão, usando um arquivo JSON temporário protegido que é removido ao terminar. Elas nunca entram no Worker da interface nem nas variáveis `VITE_`. O token Cloudflare fica no arquivo privado da VPS e não é enviado ao frontend ou ao repositório.

O primeiro Worker publicado é o da API. O frontend só é publicado após o comando da API concluir. Se ocorrer falha parcial, uma publicação anterior bem-sucedida não é desfeita automaticamente; confira a fase informada e o log privado antes de repetir. Um lock local impede dois processos deste helper no mesmo diretório. Se uma interrupção abrupta deixar `private/install/cloudflare/deploy.lock`, confira os processos antes de remover somente esse diretório vazio.

## Verificação e limites

Confirme os dois domínios personalizados em **Computação → Workers e Pages → nome do Worker → Domínios**. O Worker `fagoo-web-<sufixo>` deve mostrar a origem web; `fagoo-api-<sufixo>`, a origem da API. A publicação já cria essas associações e os registros DNS gerenciados. Em **Domínios → sua zona → DNS → Registros**, a interface pode mostrá-los como tipo **Worker**; o hostname de serviços aparece como **Túnel**. Veja o [passo a passo de conferência](installation.md#conferir-os-subdomínios-web-e-api-no-painel).

Pelo navegador, teste carregamento da interface, login com o administrador da instalação, consulta de permissões e cadastros vazios. Uma chamada não autenticada a `/v1/me` deve ser recusada com `401`, não retornar registros. O teste de login precisa usar os serviços reais da VPS e o domínio já ativo no Cloudflare.

### Diagnóstico de login e CORS

Se o gateway responde, mas o navegador bloqueia o login por CORS, confira a resposta normal de autenticação. Substitua os endereços de exemplo pelas origens web e de serviços da instalação. Estes comandos mostram somente headers, sem senha ou token:

```sh
curl -sS -D - -o /dev/null \
  -H 'Origin: https://erp.example.com' \
  http://127.0.0.1:8081/auth/v1/health

curl -sS -D - -o /dev/null \
  -H 'Origin: https://erp.example.com' \
  https://services.example.com/auth/v1/health
```

As duas respostas devem ter status `200` e exatamente um `Access-Control-Allow-Origin`, com a origem web informada. Dois valores, como a origem web junto com `*`, impedem o login. Testar somente `OPTIONS` ou `/healthz` não detecta esse problema. O `infra/Caddyfile` atual remove o header de origem enviado pelos serviços internos e mantém o valor definido pelo gateway. Depois de atualizar esse arquivo, reinicie somente o gateway e repita as verificações:

```sh
sudo docker compose --project-name fagoo --env-file private/install/.env \
  -f infra/compose.yaml restart gateway
```

O teste de regressão `infra/test_gateway_cors.py` usa um runtime local descartável, com `FAGOO_TEST_GATEWAY_URL=http://127.0.0.1:PORTA` e `FAGOO_TEST_WEB_ORIGIN` igual à origem web desse ambiente. Ele verifica Auth, REST, Storage e preflight, sem credenciais nem alterações de dados.

### Serviços configurados separadamente

Este comando publica o ERP web e a API. A configuração de SMTP, MFA, certificados, runtime fiscal, integrações e credenciais bancárias segue os próprios fluxos do sistema. O runtime fiscal tem gateway, executor e Container próprios e não é publicado por este helper. Sem essa configuração, não declare a emissão fiscal habilitada.

Agendamentos, conectores externos e importação administrativa de backup permanecem desabilitados por padrão. O helper isolado não muda os dados do banco. Após a instalação inicial, use o [atualizador pelo painel](updates.md), que coordena a publicação com os serviços e as migrações do banco. O modo `--prepared` publica exatamente o build verificado no ensaio anterior, sem recompilar; `--credentials-file` lê a credencial privada salva e dispensa entrada interativa.

### Consulta de histórico existente

Uma instalação nova mantém `ORIGIN_HISTORY_ENABLED=false`. Para exibir consultas do conector quando a instalação já possui esse histórico, o administrador pode definir `ORIGIN_HISTORY_ENABLED=true` em `private/install/.env` e republicar com o mesmo helper. O valor é preservado nas publicações seguintes; aceita somente `true` ou `false` e não entra no build público. Mantenha essa escolha no arquivo privado: uma alteração feita somente no painel Cloudflare será substituída pela configuração gerada na próxima publicação.

A API informa essa disponibilidade em `/v1/me`, no campo `capabilities.originHistory`. Ela é independente de `capabilities.originIntegration`, que exige ambos os flags `ORIGIN_ENABLED` e `ORIGIN_TWO_WAY_ENABLED`. O helper mantém esses dois flags de sincronização desligados, mesmo quando a consulta do histórico é habilitada. Esta opção não importa registros, não ativa envio/recebimento e não altera filas, dados ou permissões no banco.
