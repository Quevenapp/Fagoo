# Preparação para Android e iOS

O aplicativo nativo ainda não é distribuído. O servidor já possui os contratos de descoberta e autenticação para que ele se conecte a instalações independentes.

1. O usuário informa o endereço HTTPS do servidor.
2. O aplicativo consulta `/.well-known/fagoo.json`, verifica produto, versão e a identidade permanente da instalação.
3. O aplicativo usa os endpoints anunciados e inicia Authorization Code com PKCE S256 em navegador do sistema.
4. O usuário entra com sua conta e consente o acesso; o código retorna ao callback registrado.
5. O aplicativo troca o código usando o verifier e utiliza o access token na API.

Um administrador prepara o cliente público com `POST /api/v1/mobile/client`. A identidade criada é anunciada em `oauth.client_id`. O callback previsto é `app.fagoo://oauth/callback`; o cliente não contém segredo. O grant exige PKCE.

O escopo `fagoo` permite operações de negócio de acordo com as permissões atuais do usuário. Tokens nativos não recebem as ações administrativas de credenciais, atualizador e gestão do servidor. Revogação, expiração e escopo são verificados pelo provedor de autenticação.

O app deverá guardar credenciais no Keychain/Keystore, separadas por `server_id` e origem. Mudança de servidor exige nova autenticação. Endereço incompatível, TLS inválido ou identidade de instalação inesperada precisam ser apresentados ao usuário antes de enviar credenciais.

O modo HTTP em localhost serve exclusivamente a desenvolvimento e instalação piloto local. Não é um modo de acesso público para os aplicativos.
