# Fagoo Android

Aplicativo online de comunicação autorizada e painéis. O APK não incorpora a central Rust, SQLite operacional ou Quall. O nome/ícone usam a marca do Fagoo web; os modelos de painel preservam as apresentações do Vinki.

Requisitos: JDK 17, SDK Android 36 e Gradle Wrapper incluído. Para desenvolvimento:

```powershell
./gradlew.bat :app:assembleDebug :app:testDebugUnitTest
```

A variante debug instala o pacote separado `br.com.queven.fagoo.debug`; release usa `br.com.queven.fagoo`. Não desinstale aplicativos existentes para instalar uma atualização de teste.

## Firebase por variante

Guarde os arquivos fornecidos pelo seu projeto Firebase em `app/src/release/google-services.json` e `app/src/debug/google-services.json`. Ambos são ignorados pelo Git. O arquivo legado `app/google-services.json` continua aceito somente quando contém o pacote exato solicitado. Nenhum identificador é alterado ou fabricado.

Debug sem cliente correspondente compila sem o plugin Google Services e **não recebe push**. Recursos Firebase gerados por builds antigos não são registrados nessa compilação. O log informa essa limitação. Release exige o cliente correto; uma solicitação conjunta de debug e release falha quando falta o cliente debug. Compile as variantes separadamente até completar a configuração.

Não confunda esse arquivo público do app com credenciais de servidor FCM/APNs. Push de avisos ao consumidor legado e push pessoal do Fagoo têm contratos próprios. Compilar um APK com Firebase não comprova entrega nem isolamento real entre usuários: execute a bancada.

## Impressão e validação

O Gradle inclui os fontes de `packages/thermal-printer-kit`. Configure a impressora na área autenticada antes de ativar o aparelho como painel. A credencial pública de painel não abre a configuração local. O runtime registra o recibo técnico antes de transmitir e mantém um resultado físico incerto sem repetição automática.

Consulte `docs/operations/fagoo-queues-acceptance.md` para evidências e verificações físicas pendentes. `PANEL-NOTICE`, `WABOTIA-LICENSE` e os avisos do kit preservam as origens; os arquivos privados do Firebase/assinatura e os artefatos de build não entram no repositório.
