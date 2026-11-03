# Publicação da interface e da API

O comando `infra/deploy-application.py` compila e publica a interface original e a API completa do ERP em dois Workers da conta Cloudflare desta instalação. Ele usa o núcleo local e as três origens já geradas por `infra/configure.py`; não cria outro banco, usuário ou conjunto de dados.

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
npm ci
python3 -m unittest discover -s infra -p 'test_deploy_application.py'
```

Obtenha o Account ID e o Zone ID no painel Cloudflare. O token para esta publicação precisa acessar somente a conta e a zona escolhidas, com `Workers Scripts — Edit`, `Workers Routes — Edit`, `Zone — Read` e `DNS — Read` (ou `DNS — Edit` quando o mesmo token também configurar DNS). Ele será solicitado sem eco pelo comando e não será salvo. Não coloque token em argumentos, no Git, no frontend ou em gravações de tela.

## Ensaio sem publicação

Substitua os identificadores abaixo pelos valores do painel:

```sh
python3 infra/deploy-application.py \
  --account-id ACCOUNT_ID \
  --zone-id ZONE_ID \
  --dry-run
```

O comando deriva somente as variáveis públicas do build, executa TypeScript/build, verifica os artefatos e empacota os dois Workers com o Wrangler instalado pelo `npm ci`. O modo de ensaio não solicita token nem publica serviços. Os identificadores de conta e zona devem ter 32 caracteres hexadecimais, inclusive no ensaio.

As configurações Wrangler geradas e logs ficam em `private/install/cloudflare/`. Os nomes dos Workers são estáveis por instalação, derivados da origem web: `fagoo-api-<sufixo>` e `fagoo-web-<sufixo>`. Logs têm acesso restrito e os valores privados conhecidos são ocultados. A configuração original `private/install/.env` não é sobrescrita.

## Publicação

Os hostnames web e API serão domínios personalizados dos Workers. Se houver registros A/CNAME provisórios nesses **dois nomes**, remova somente esses registros pelo painel antes do primeiro deploy. Preserve o DNS do domínio principal, e-mails, outros serviços e o hostname do túnel. A publicação criará os registros gerenciados dos domínios personalizados.

O helper verifica a conta/zona e recusa DNS conflitante ou um domínio pertencente a outro Worker. Essa verificação é necessária porque o Wrangler sem terminal interativo pode substituir conflitos de DNS automaticamente. Não use uma opção de força para contornar um conflito.

```sh
python3 infra/deploy-application.py \
  --account-id ACCOUNT_ID \
  --zone-id ZONE_ID \
  --deploy
```

Depois dos testes locais, digite o token no prompt oculto. A chave de serviço do banco é transmitida ao Worker da API como segredo da versão, usando um arquivo JSON temporário protegido que é removido ao terminar. Essa chave nunca entra no Worker da interface nem nas variáveis `VITE_`. O token Cloudflare não é armazenado pelo helper.

O primeiro Worker publicado é o da API. O frontend só é publicado após o comando da API concluir. Se ocorrer falha parcial, uma publicação anterior bem-sucedida não é desfeita automaticamente; confira a fase informada e o log privado antes de repetir. Um lock local impede dois processos deste helper no mesmo diretório. Se uma interrupção abrupta deixar `private/install/cloudflare/deploy.lock`, confira os processos antes de remover somente esse diretório vazio.

## Verificação e limites

Confirme no painel os dois domínios personalizados. Pelo navegador, teste carregamento da interface, login com o administrador da instalação, consulta de permissões e cadastros vazios. Uma chamada não autenticada a `/v1/me` deve ser recusada, não retornar registros. O teste de login precisa usar os serviços reais da VPS.

Este comando publica o ERP web e a API. A configuração de SMTP, MFA, certificados, runtime fiscal, integrações e credenciais bancárias segue os próprios fluxos do sistema. O runtime fiscal tem gateway, executor e Container próprios e não é publicado por este helper. Sem essa configuração, não declare a emissão fiscal habilitada.

Agendamentos, conectores externos e importação administrativa de backup permanecem desabilitados por padrão. O helper não muda os dados do banco, não substitui o [atualizador do núcleo](updates.md) e não implementa o botão de atualização do painel. Atualizações do aplicativo devem usar a mesma revisão pública compatível com o núcleo.
