# Fagoo Android e iOS

O aplicativo inicial tem dois modos exclusivos: Painel e Comunicação. Ele usa o mesmo Auth, unidades e permissões do Fagoo web, descobertos em `https://<empresa>/fagoo-mobile.json`. A API verifica MFA, horário de acesso e escopo; o aplicativo não recebe conversas não autorizadas para ocultá-las depois.

## Usar

1. Informe o endereço web da instalação e entre com seu usuário Fagoo. Se houver MFA, informe o código do autenticador.
2. Comunicação oferece WhatsApp direcionado/assumido, fila disponível autorizada e chat individual com pessoas e bots permitidos. Texto, anexos e áudio WhatsApp são preservados.
3. Para um painel, cadastre o aparelho no assistente web. Entre no app com uma conta administrativa, escolha o aparelho e vincule. O app recebe sua autorização automaticamente; nenhuma credencial de integração é digitada.
4. Configure a impressora pela área autenticada antes de vincular o painel. O painel público contém somente suas funções de chamadas, pedidos e emissão, conforme a configuração web. A saída requer autenticação e autorização online.

Todo comando depende de confirmação na nuvem. O app guarda apenas identificadores de operações incertas e recibos técnicos dos efeitos. Um recibo desconhecido é consultado, sem repetir impressão ou anúncio. O comprovante digital pode ser acompanhado pelo QR com internet. O último comprovante sai da tela após 30 segundos.

Trocar usuário, unidade ou modo cancela requisições e players privados, limpa mídias temporárias e notificações e revoga a inscrição anterior. Credenciais humanas ficam no armazenamento protegido do sistema. O cliente de painel recebe somente uma credencial de aparelho; não recebe bearer humano nem diretório ou chats.

## Compilar Android

Use JDK 17, Android SDK 36 e o wrapper Gradle versionado em `android`. A dependência `packages/thermal-printer-kit` é incluída como projeto local.

```sh
cd apps/mobile/android
./gradlew assembleDebug testDebugUnitTest
```

O identificador principal é `br.com.queven.fagoo`; o APK de desenvolvimento usa `br.com.queven.fagoo.debug`. Coloque os arquivos públicos Firebase em `android/app/src/release/google-services.json` e `android/app/src/debug/google-services.json`, cada um com o identificador correspondente. Eles são locais e ignorados pelo Git. Debug pode compilar sem Firebase, com notificações desativadas; release exige configuração válida. Não adapte o identificador de um arquivo para simular outro aplicativo. A assinatura de distribuição é configurada pelo mantenedor; a chave nunca acompanha o código.

## Compilar iOS

Use Xcode, XcodeGen e um destino iOS 15 ou superior. O projeto referencia `packages/thermal-printer-kit/ios` e Firebase Messaging. Copie a configuração pública do app iOS para `ios/Fagoo/Resources/GoogleService-Info.plist`.

```sh
cd apps/mobile/ios
xcodegen generate
xcodebuild -scheme Fagoo -destination 'platform=iOS Simulator,name=<simulador>' test
```

O bundle é `br.com.queven.fagoo`. O projeto Xcode, DerivedData, perfis, chaves e configurações locais não são versionados. Configure a equipe de assinatura para seu ambiente sem substituir as chaves de release do Fagoo web.

## Notificações e privacidade

O servidor gerenciado envia notificações FCM somente com dados. Antes de mostrar uma notificação local genérica, o app verifica sessão, usuário, unidade, origem e autorização online do recurso. Um push atrasado não pode exibir conteúdo pessoal no modo painel. O recebimento em segundo plano depende das políticas de Android/iOS; no iOS, o sistema pode adiar uma atualização silenciosa. O app consulta o estado atual quando volta ao primeiro plano.

Configurar Firebase, APNs e comprovar a entrega em aparelhos físicos faz parte da homologação. Compilar sem configuração Firebase não comprova notificações. Não são incluídos ERP/CRM completos, administração, operação de guichê, chat interno em grupo ou com anexos nem WebRTC nesta entrega móvel.

## Origem e licenças

As telas de comunicação e recursos de mídia foram incorporados do Wabotia sob MIT, preservada em `WABOTIA-LICENSE`. Os templates e regras do painel foram incorporados do Vinki com a abertura autorizada pelo titular; as fontes preservam suas licenças OFL. A biblioteca de impressão preserva suas atribuições, licenças e histórico em `packages/thermal-printer-kit/NOTICE`. O restante da aplicação segue a licença do Fagoo.
