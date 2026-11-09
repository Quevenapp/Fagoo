# Parear Fagoo com Wabotia

Em **Preferências → Sistema → Wabotia**, um administrador informa a URL HTTPS do Wabotia e o nome da instalação. Clique em **Gerar código**, abra o Wabotia e aprove esse código em **Integrações → Parear Vinki ou Fagoo**, escolhendo o perfil, as permissões, os bots e as linhas permitidas. Volte ao Fagoo e clique em **Verificar aprovação**. O código dura dez minutos. Nenhum token é digitado ou mostrado.

**Desconectar** revoga o acesso no Wabotia e apaga a credencial local. Se a rede falhar, tente novamente; a credencial permanece até a revogação ser confirmada. Também é possível revogar pelo painel Wabotia. A conexão perde validade quando a chave vence, é revogada ou muda a chave de serviço da instalação; nesses casos, faça novo pareamento.

## Instalação da alteração

O pareamento integra a versão 0.3.1. Siga [o procedimento de publicação assinada](publishing-updates.md) e instale a versão pelo atualizador da instalação. A atualização aplica `supabase/migrations/202611090001_wabotia_pairing.sql`, publica o ERP API (`workers/erp-api`) e gera o frontend com a configuração existente. O Wabotia correspondente precisa da migração `0010_pairing.sql` e das rotas de pareamento antes de iniciar uma conexão. Não há credenciais novas para configurar: a sessão e MFA existentes protegem o administrador, e a chave de serviço já instalada cifra o estado AES-GCM. Preserve essa configuração privada ao atualizar.

O vínculo é da instalação Fagoo, cujo Postgres contém uma única empresa. A tabela e a RPC só admitem `service_role`; usuários autenticados e anônimos não podem ler nem modificar os segredos. A API pública devolve apenas estado, código curto, URL, perfil e identificador da aplicação. Rotação da chave de serviço exige revogar o vínculo anterior no Wabotia e refazer o pareamento.

Após rotação da chave, a tela mostra uma recuperação: revogue primeiro o vínculo anterior no Wabotia, marque **Já revoguei o vínculo anterior** e clique em **Esquecer conexão local**. Somente então gere outro código. Essa ação apaga o estado cifrado e não faz revogação remota; exige sessão administrativa, MFA e confirmação explícita. A rota correspondente é `POST /v1/system/wabotia/forget` com `{"confirmed":true}`.

## Contrato

Sessão administrativa existente: `GET /v1/system/wabotia`, `POST /v1/system/wabotia/start` (`url`, `name`), `POST /v1/system/wabotia/poll` e `POST /v1/system/wabotia/disconnect` (corpo `{}`). O Worker chama `POST /api/pairing/start` (`client=fagoo`), guarda o `device_code` cifrado, consulta `POST /api/pairing/token` e guarda a credencial automaticamente. Ao desconectar, chama `POST /api/v1/pairings/disconnect` com essa credencial. Redirecionamentos são recusados, respostas são limitadas, consultas respeitam cinco segundos e um bloqueio Postgres serializa operações concorrentes.

O pareamento autoriza o Fagoo perante o Wabotia. Ele não provisiona bots financeiros Hermes nem credenciais bancárias: esses bots continuam configurados internamente no Hermes, como os demais serviços. Se a resposta final da troca for perdida, inicie outro pareamento e revogue a aplicação anterior no Wabotia.

Validação local: `node --test workers/erp-api/test/wabotia*.test.mjs` (Postgres PGlite real, rede externa simulada), `npm run typecheck:erp`. O teste HTTP cobre o middleware de autenticação, MFA e papéis da API real.
