# Concorrência real do atendimento na homologação

Operador preparado para revisão; a criação de usuários/unidades e o seed D1 exigem autorização explícita do coordenador antes de executar. O modo padrão apenas imprime o plano e não acessa rede, credenciais ou banco.

## Escopo fixo e independente

- Instalação `/opt/fagoo-homolog`, três origens `homolog.fagoo.com.br`, `api-homolog.fagoo.com.br` e `services-homolog.fagoo.com.br`.
- Conta Cloudflare Fagoo `d534038b992cdfbb065cb97a81442afc`, zona `7b7a1b39964797b972f25e4777fce738`. O banco é resolvido exclusivamente de `private/install/communication.json`, validando a origem, a conta e todos os nomes derivados desta instalação. Recusa recursos adotados/legados.
- Run novo e exclusivo. `9e786a54cb21`, usado no navegador e nos ensaios anteriores, é recusado. Contas: um administrador QA próprio com TOTP e dois operadores; e-mails exclusivamente `@synthetic.invalid`. Não há signup público, convites, e-mail ou alteração da política MFA global.
- Duas unidades QA próprias: uma para os dois concorrentes e outra sem permissão para eles. Os operadores recebem somente leitura, assumir, responder e transferir nesta unidade; não recebem configuração, ERP ou acesso a outras unidades. Estas unidades não representam uma instalação legada a migrar.

## Escritas planejadas

O bootstrap usa Auth administrativo para criar as três contas sintéticas, associações ERP restritas a esses IDs e comandos normais `unit.save`/`member.save` pela API Fagoo. O acesso delegado cria o perfil interno gerenciado. Tudo fica identificado pelo run e pelo campo `settings.qa` da unidade.

O seed mínimo no D1 cria uma conversa `waiting`, sem dono, com `connection_id=NULL`, `phone=NULL`, namespace `qa:<run>`, época zero e uma mensagem sintética. Não cria conexão Meta/Telegram/Hermes, bot, aplicação, webhook, inscrição ou inbox. A publicação não muda: nenhum endpoint de teste é acrescentado ao produto.

Depois da disputa, envia somente os bytes de um pequeno arquivo de texto sintético pela rota normal de mídia; o seed associa esse anexo à conversa para verificar acesso positivo e negativo. Um segundo seed insere uma resposta sintética de IA na outbox com época antiga, **somente depois de confirmar a tomada humana**. Uma ação de etiquetas acorda o DO; a outbox precisa terminar `cancelled`, sem ID de envio. A existência de conexão, webhook, bot em execução, inbox, rota de avisos ou aparelho habilitado a receber push nesta unidade (inclusive registro global sem filtro de perfil) aborta o ensaio.

Rotas usadas:

| Finalidade | API HTTPS |
| --- | --- |
| Fila mínima | `GET /v1/communication/units/{unit}/queue` |
| Disputa e transferência | `POST /v1/communication/units/{unit}/conversations/{id}/actions` |
| Detalhes autorizados | `GET /v1/communication/units/{unit}/conversations/{id}` |
| Eventos filtrados | `GET /v1/communication/units/{unit}/events?after=0` |
| Anexo sintético | `POST /v1/communication/units/{unit}/media` e `GET .../media/{id}/content` |

O cliente recusa ações de envio, retomada de bot, configurações, conexões e ingestão. Cada mutação HTTP mantém o mesmo `Idempotency-Key`, persistido antes do envio; uma falha de transporte não cria uma nova intenção. O seed D1 usa parâmetros e IDs exclusivos. Não imprime tokens, senhas, TOTP, corpos privados ou configuração.

## Critérios observados pelo operador

1. Dois POSTs partem de threads sincronizadas contra a mesma conversa e o mesmo perfil/DO. Exatamente um recebe sucesso; o outro recebe recusa `403`, `404` ou `409`, conforme a autorização atual. Ambos terem sucesso é falha, mesmo que a última gravação deixe apenas um dono.
2. D1 confirma o dono vencedor, estado humano e época 1. Repetir os mesmos comandos recupera os resultados sem outra mudança de época.
3. Apenas o vencedor lê conversa, mensagem, anexo e evento; o outro é recusado. O conteúdo do anexo precisa coincidir byte a byte com o texto sintético.
4. A outbox de época zero é cancelada pelo motor real antes de qualquer transporte. Isto comprova o bloqueio de resposta obsoleta enfileirada; não comprova uma chamada externa ao Hermes nem a conclusão de um modelo real.
5. Transferir ao outro operador revoga imediatamente detalhes, bytes e eventos para o dono anterior, inclusive para quem enviou o arquivo. O novo dono lê normalmente. A outra unidade continua recusada.

## Execução após revisão

Escolher um run ainda não usado; o exemplo abaixo é exclusivo deste ensaio. O arquivo de credenciais Cloudflare deve estar dentro de `private/`, ser privado e conter somente a conta/zona autorizadas. O operador respeita a seleção IPv4 privada existente sem alterar DNS global.

```bash
python3 tools/qa/homologation_communication.py --run-id c74ca003ce10
python3 tools/qa/homologation_communication.py --run-id c74ca003ce10 --credentials-file private/install/cloudflare/credentials.json --execute
```

Confirmar o caminho real do arquivo de credenciais antes do segundo comando; o exemplo não cria nem procura credenciais em outras contas. Não executar enquanto houver outra sessão usando essas novas contas. A conta do navegador e a execução anterior não são reutilizadas.

Credenciais, intenções e relatório ficam em `private/qa/<run>/`, com arquivos `0600` e diretório `0700`. Um run concluído não repete login ou seed ao chamar `--execute` novamente. Em resultado ambíguo, conservar o estado e os mesmos IDs; não apagar o lock ou inventar um run substituto para encobrir a incerteza.

## Retirada reversível da fixture

Após revisão dos resultados, `--retire` confirma o nome e `settings.qa` das duas unidades, desativa somente essas unidades pela API e desativa as três associações ERP sintéticas por UUID/e-mail/marca de origem. Preserva usuários Auth, recibos, histórico e o arquivo R2 para auditoria; não remove evidências nem dados de outras unidades. A reativação é manual e revisada, não automática. Se surgirem canais ou registros externos, a retirada automática também recusa e exige inspeção.

```bash
python3 tools/qa/homologation_communication.py --run-id c74ca003ce10 --credentials-file private/install/cloudflare/credentials.json --retire
```

Não há limpeza global de D1/R2, remoção de Workers/DO, mudança de webhook ou ativação de consumidor. A retirada de uma fixture não equivale a migrar ou aposentar um sistema legado. Testes locais do operador: `python3 -m unittest discover -s tools/qa -p test_homologation_communication.py`.
