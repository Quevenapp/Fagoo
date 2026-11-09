package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets

/**
 * Tipo próprio do pacote de contribuição, e não `application/json`.
 *
 * Com o tipo genérico, o app que recebe contribuição apareceria na folha de compartilhamento de
 * **todo** JSON que qualquer app do aparelho exportasse: a pessoa o veria oferecido onde ele não
 * tem nada a ver, e ele receberia payload que não sabe tratar. Com o tipo próprio, quem filtra é o
 * sistema, antes da folha, em vez de virar validação depois do fato.
 *
 * ~~O JSON viaja em `Intent.EXTRA_TEXT`.~~ **Errado, e corrigido em 30/08/2026 quando o gesto de
 * origem finalmente existiu.** O pacote viaja como **arquivo**, e quem manda nisso é o consumidor:
 * o leitor de mesa recebe um `java.nio.file.Path`
 * (`jvm/app/.../ImportacaoDeContribuicao.kt`, via `SeletorDeArquivoDeContribuicao`), e o app iOS
 * declara `public.filename-extension` no `Info.plist`. `Intent.EXTRA_TEXT` **não carrega nome de
 * arquivo**, e portanto não carrega extensão — um pacote mandado por ali chegaria como texto solto
 * a um leitor que espera abrir um caminho.
 *
 * A frase antiga estava certa sobre o tamanho e sobre o `FileProvider`: o pacote tem menos de 1 KB, e
 * o kit continua sem provider. Quem exporta usa `ACTION_CREATE_DOCUMENT`, que grava direto no
 * destino escolhido pela pessoa e não pede provider a ninguém.
 */
const val PRINTER_CONTRIBUTION_MIME_TYPE = "application/vnd.printher.printer-contribution+json"

/**
 * Produz o pacote neutro que a pessoa entrega a outro app pelo compartilhamento do Android.
 *
 * A função é pura e recebe versões como dados para que o core não consulte `Context`, pacote,
 * aparelho ou rede. O UUID local e qualquer identificador de transporte não têm campo no JSON.
 */
fun createPrinterContributionJson(
    profile: MeasuredProfile,
    osVersion: String,
    appVersion: String,
): ByteArray {
    require(profile.source == PrinterProfileSource.MEASURED) {
        "Somente uma medição local pode virar contribuição."
    }
    requireValidVersionLabel(osVersion, "Versão do Android inválida.")
    requireValidVersionLabel(appVersion, "Versão do app inválida.")

    val json =
        buildString {
            append("{\n")
            append("  \"kind\": \"printher.printer-contribution\",\n")
            append("  \"version\": 1,\n")
            append("  \"profile\": {\n")
            appendJsonProperty("displayName", profile.displayName, 4)
            append(",\n")
            appendJsonProperty("firmwareVersion", profile.firmwareVersion, 4)
            append(",\n")
            append("    \"transports\": [")
            profile.transports.map(PrinterTransport::name).sorted().forEachIndexed { index, name ->
                if (index > 0) append(", ")
                appendJsonString(name)
            }
            append("],\n")
            append("    \"paperWidthMm\": ${profile.paperWidthMm},\n")
            append("    \"printableColumns\": ${profile.printableColumns},\n")
            append("    \"printableDots\": ${profile.printableDots},\n")
            appendJsonProperty("textEncoding", profile.textEncoding.contributionName, 4)
            append(",\n")
            appendJsonProperty("codePage", profile.codePage?.name, 4)
            append(",\n")
            append("    \"codePageSelector\": ${profile.codePageSelector ?: "null"},\n")
            appendJsonProperty("cutProtocol", profile.cutProtocol.capabilityName, 4)
            append(",\n")
            append("    \"cutModeHonored\": ${profile.cutModeHonored},\n")
            append("    \"cutFeedLines\": ${profile.cutFeedLines},\n")
            appendJsonProperty("dialect", profile.dialect.name, 4)
            append(",\n")
            appendJsonProperty("capabilityKey", profile.capabilityKey.value, 4)
            append(",\n")
            append("    \"measuredAtEpochMillis\": ${requireNotNull(profile.measuredAtEpochMillis)}\n")
            append("  },\n")
            append("  \"platform\": { ")
            append("\"os\": \"android\", ")
            appendJsonProperty("osVersion", osVersion, indent = 0)
            append(", ")
            appendJsonProperty("appVersion", appVersion, indent = 0)
            append(" }\n")
            append("}\n")
        }
    return json.toByteArray(StandardCharsets.UTF_8)
}

private val ThermalTextEncoding.contributionName: String
    get() =
        when (this) {
            ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE -> "SINGLE_BYTE_CODE_PAGE"
            ThermalTextEncoding.FIRMWARE_DEFAULT_PAGE -> "FIRMWARE_DEFAULT_PAGE"
            ThermalTextEncoding.UTF_8 -> "UTF8"
            ThermalTextEncoding.ASCII -> "ASCII"
        }

private fun requireValidVersionLabel(
    value: String,
    message: String,
) {
    require(value.isNotBlank() && value.length <= 128 && value.none(Char::isISOControl)) { message }
}

private fun StringBuilder.appendJsonProperty(
    name: String,
    value: String?,
    indent: Int,
) {
    repeat(indent) { append(' ') }
    appendJsonString(name)
    append(": ")
    if (value == null) append("null") else appendJsonString(value)
}

private fun StringBuilder.appendJsonString(value: String) {
    append('"')
    value.forEach { character ->
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000C' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else ->
                if (character.code < 0x20) {
                    append("\\u%04x".format(character.code))
                } else {
                    append(character)
                }
        }
    }
    append('"')
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// A VOLTA: LER O PACOTE (lote C28)
//
// O escritor acima existe desde antes da Frente C e nunca teve par. Medido em 26/08/2026: nada
// neste repositório nem no app Android lê `printher.printer-contribution` — o pacote era só de ida,
// e o único consumidor era o teste do próprio escritor.
//
// **Por que a volta virou necessidade.** O app de mesa do Windows LISTA perfil homologado e não tem
// caminho nenhum para CRIAR um: não há homologação guiada em `jvm/`, e sem perfil não há largura,
// página de código, dialeto de corte nem `verticalRasterScale`. A homologação que existe e já saiu
// em papel é a do telefone. Este leitor é a ponte: homologa-se no aparelho, compartilha-se o pacote
// de menos de 1 KB, e a máquina de mesa adota o que a bancada mediu — **sem gastar um centímetro de
// bobina para repetir a medição**.
//
// ## O que o formato v1 não carrega, e o que fazer com cada coisa
//
// O JSON tem quinze propriedades e o perfil tem mais campos que isso. A diferença se divide em três
// grupos, e **cada um exige uma decisão diferente**:
//
// 1. **`id` — ausente de propósito.** O cabeçalho do escritor é literal: *"o UUID local e qualquer
//    identificador de transporte não têm campo no JSON"*. Identidade é da instalação, não da
//    medição. Quem lê **cunha um identificador local novo**, e por isso ele entra por parâmetro:
//    inventá-lo aqui dentro faria a mesma leitura produzir perfis diferentes a cada chamada, e a
//    suíte não teria como fixar nada.
//
// 2. **Campos que são legitimamente "não medido".** `nativeQrHonored`, `nativeBarcodeHonored`,
//    `maxRasterBytesPerSecond`, `supportsNvLogo` e `wifiConfigurationFamily` **não estão na chave de
//    capacidade de propósito** — não mudam um byte no papel — e o tipo já modela a ausência deles.
//    Chegam ausentes, e o leitor **diz quais foram**, em [PrinterContributionImport.Accepted.unmeasured].
//    Preencher qualquer um com um palpite seria afirmar medição que ninguém fez.
//
// 3. **`statusProtocol` e `verticalRasterScale` — o problema de verdade.** Os dois **estão dentro da
//    chave de capacidade** e **não têm propriedade no JSON**. `statusProtocol` não é anulável e não
//    tem padrão; `verticalRasterScale` é anulável, mas ausente ele significa "sem compensação", e um
//    perfil de Inico T210 importado sem os 0,80 sai com o cupom **20% mais curto, sem erro nenhum** —
//    que é o defeito silencioso que este kit inteiro existe para não ter.
//
// ## Como o grupo 3 é resolvido sem inventar nada
//
// `capabilityKey` é **SHA-256 do string canônico**, não o string: ele verifica, não revela. Mas o
// domínio dos dois campos que faltam é enumerável e minúsculo — [PrinterStatusProtocol] tem **dois**
// valores, e o fator entra na chave como **milésimos inteiros**. Então o leitor **inverte a chave**:
// constrói candidatos, pede a `capabilityKey` de cada um e para no que reproduz o hash declarado.
//
// Isto **não é adivinhação**, e a diferença é o que torna a rota aceitável:
//
// - o resultado é **verificado**, não inferido: só é aceito o candidato cuja chave bate byte a byte;
// - a chave é calculada por `MeasuredProfile.capabilityKey`, a **mesma** propriedade que o escritor
//   usou — o formato canônico não é reescrito aqui, e não há segunda verdade sobre ele para
//   envelhecer;
// - bater a chave valida **todo o resto junto**: se qualquer propriedade explícita do JSON tiver
//   sido editada à mão, o hash deixa de fechar e o pacote é recusado inteiro. A conferência
//   campo a campo sai de graça, e sai mais forte do que se eu a escrevesse;
// - e **ambiguidade é recusa**: se duas combinações reproduzissem a mesma chave, o leitor devolve
//   [PrinterContributionRefusal.AMBIGUOUS_KEY] em vez de escolher uma. Não é um caso alcançável com
//   SHA-256 sobre alguns milhares de candidatos, e é justamente por isso que ele é barato de honrar.
//
// **A busca começa pelo caso comum.** Sem fator, são dois candidatos — o custo normal da leitura são
// dois hashes. A varredura de milésimos só acontece quando nenhum dos dois fecha, que é exatamente o
// perfil que TEM compensação medida.
//
// ## Não medido, e nomeado para não virar suposição
//
// - **Nenhum pacote de aparelho de verdade foi lido.** Todas as provas partem de pacotes que o
//   escritor deste mesmo arquivo produziu. Um JSON vindo de uma versão futura do app ainda não
//   existe para ser testado; por isso `version` diferente de 1 é recusa nomeada, e não tolerância.
// - **Nada disto saiu em papel.** O que está provado é que o perfil que entra é igual ao que saiu,
//   campo a campo, e que a chave fecha. Que o cupom saia certo na máquina de destino é bancada.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** O desfecho de ler um pacote de contribuição. Recusa é desfecho, nunca exceção. */
sealed class PrinterContributionImport {
    /**
     * O pacote foi lido e a chave de capacidade fechou.
     *
     * @property unmeasured o que o formato v1 não tem como carregar. **Não é erro**: é o que a
     *   pessoa precisa saber que continua sem medida nesta máquina.
     */
    data class Accepted(
        val profile: MeasuredProfile,
        val unmeasured: Set<PrinterContributionUnmeasured>,
    ) : PrinterContributionImport()

    /** O pacote não virou perfil, e o motivo é dizível a uma pessoa. */
    data class Refused(
        val reason: PrinterContributionRefusal,
        val detail: String,
    ) : PrinterContributionImport()
}

/**
 * O que o pacote v1 não carrega, e que por isso chega **ausente** no perfil importado.
 *
 * Todos estão fora da chave de capacidade de propósito — nenhum muda um byte emitido —, e todos têm
 * ausência representável no tipo. Ficam listados para a tela poder dizer à pessoa, em vez de o
 * silêncio virar a impressão de que foi medido.
 */
enum class PrinterContributionUnmeasured {
    /** `GS ( k` honrado? Sem isso o QR sai rasterizado, que é o caminho seguro. */
    NATIVE_QR,

    /** O mesmo para o `GS k` do código de barras. */
    NATIVE_BARCODE,

    /** O teto de vazão de raster. Continua nulo em todo perfil do programa, medido em 22/08. */
    RASTER_THROUGHPUT,

    /** Logotipo em NV. */
    NV_LOGO,

    /** Como esta impressora aceita configuração de rede. */
    WIFI_CONFIGURATION,
}

/** Por que o pacote foi recusado. Motivo, nunca o conteúdo do arquivo. */
enum class PrinterContributionRefusal {
    /** Não é UTF-8 válido, ou não é um objeto JSON que este leitor saiba percorrer. */
    NOT_READABLE,

    /** Não é um pacote de contribuição: `kind` ausente ou diferente do contrato. */
    NOT_A_CONTRIBUTION,

    /** É um pacote, de uma versão que este leitor não conhece. */
    UNSUPPORTED_VERSION,

    /** Falta uma propriedade obrigatória, ou ela veio com o tipo errado. */
    MALFORMED_FIELD,

    /** Um enum trouxe um nome que esta versão do kit não tem. */
    UNKNOWN_VALUE,

    /**
     * Nenhuma combinação de `statusProtocol` e fator reproduz a chave declarada.
     *
     * É o que acontece com um JSON editado à mão: qualquer propriedade alterada muda o canônico e o
     * hash deixa de fechar. **Recusar inteiro é a decisão**, porque um pacote em que a chave não
     * bate não tem nenhuma parte confiável.
     */
    KEY_DOES_NOT_MATCH,

    /** Duas combinações reproduzem a mesma chave. Inalcançável na prática; recusado mesmo assim. */
    AMBIGUOUS_KEY,

    /** As validações de [MeasuredProfile] recusaram o que o pacote descreve. */
    INVALID_PROFILE,
}

/**
 * Lê o pacote produzido por [createPrinterContributionJson] e devolve o perfil que ele descreve.
 *
 * @param id o identificador local a cunhar. Ver o grupo 1 do cabeçalho: ele entra por parâmetro
 *   porque identidade é de quem instala, e porque uma leitura precisa ser reproduzível na suíte.
 */
fun readPrinterContributionJson(
    bytes: ByteArray,
    id: String,
): PrinterContributionImport {
    val texto =
        try {
            decodeStrictUtf8(bytes)
        } catch (_: Exception) {
            return refuse(PrinterContributionRefusal.NOT_READABLE, "o arquivo não é UTF-8.")
        }

    val raiz =
        try {
            JsonValue.parse(texto)
        } catch (erro: JsonMalformed) {
            return refuse(PrinterContributionRefusal.NOT_READABLE, erro.message ?: "JSON malformado.")
        }

    val objeto = raiz as? JsonValue.Obj
        ?: return refuse(PrinterContributionRefusal.NOT_READABLE, "a raiz do JSON não é um objeto.")

    val kind = objeto.optionalString("kind")
    if (kind != CONTRIBUTION_KIND) {
        return refuse(
            PrinterContributionRefusal.NOT_A_CONTRIBUTION,
            "este arquivo não é um pacote de impressora do Printher.",
        )
    }
    val version = objeto.optionalInt("version")
        ?: return refuse(PrinterContributionRefusal.NOT_A_CONTRIBUTION, "o pacote não declara versão.")
    if (version != CONTRIBUTION_VERSION) {
        return refuse(
            PrinterContributionRefusal.UNSUPPORTED_VERSION,
            "o pacote é da versão $version e esta máquina lê a versão $CONTRIBUTION_VERSION.",
        )
    }

    val perfil = objeto.optionalObject("profile")
        ?: return refuse(PrinterContributionRefusal.MALFORMED_FIELD, "o pacote não traz o perfil.")

    val lido =
        try {
            ContributionFields(
                displayName = perfil.requiredString("displayName"),
                firmwareVersion = perfil.optionalString("firmwareVersion"),
                transports = perfil.requiredStringArray("transports"),
                paperWidthMm = perfil.requiredInt("paperWidthMm"),
                printableColumns = perfil.requiredInt("printableColumns"),
                printableDots = perfil.requiredInt("printableDots"),
                textEncoding = perfil.requiredString("textEncoding"),
                codePage = perfil.optionalString("codePage"),
                codePageSelector = perfil.optionalInt("codePageSelector"),
                cutProtocol = perfil.requiredString("cutProtocol"),
                cutModeHonored = perfil.requiredBoolean("cutModeHonored"),
                cutFeedLines = perfil.requiredInt("cutFeedLines"),
                dialect = perfil.requiredString("dialect"),
                capabilityKey = perfil.requiredString("capabilityKey"),
                measuredAtEpochMillis = perfil.requiredLong("measuredAtEpochMillis"),
            )
        } catch (erro: JsonMissing) {
            return refuse(PrinterContributionRefusal.MALFORMED_FIELD, erro.message ?: "propriedade ausente.")
        }

    val transportes =
        lido.transports.map { nome ->
            enumOrNull<PrinterTransport>(nome)
                ?: return refuse(PrinterContributionRefusal.UNKNOWN_VALUE, "transporte desconhecido: $nome.")
        }.toSet()
    if (transportes.isEmpty()) {
        return refuse(PrinterContributionRefusal.MALFORMED_FIELD, "o pacote não lista transporte nenhum.")
    }
    val codificacao = textEncodingFromContributionName(lido.textEncoding)
        ?: return refuse(PrinterContributionRefusal.UNKNOWN_VALUE, "codificação desconhecida: ${lido.textEncoding}.")
    val pagina =
        lido.codePage?.let { nome ->
            enumOrNull<ThermalCodePage>(nome)
                ?: return refuse(PrinterContributionRefusal.UNKNOWN_VALUE, "página de código desconhecida: $nome.")
        }
    val corte = enumOrNull<CutProtocol>(lido.cutProtocol)
        ?: return refuse(PrinterContributionRefusal.UNKNOWN_VALUE, "protocolo de corte desconhecido: ${lido.cutProtocol}.")
    val dialeto = enumOrNull<EscPosDialect>(lido.dialect)
        ?: return refuse(PrinterContributionRefusal.UNKNOWN_VALUE, "dialeto desconhecido: ${lido.dialect}.")

    val monta: (Double?) -> MeasuredProfile? = { fator ->
        try {
            MeasuredProfile(
                id = id,
                displayName = lido.displayName,
                transports = transportes,
                paperWidthMm = lido.paperWidthMm,
                printableColumns = lido.printableColumns,
                printableDots = lido.printableDots,
                codePage = pagina,
                textEncoding = codificacao,
                codePageSelector = lido.codePageSelector,
                cutProtocol = corte,
                cutModeHonored = lido.cutModeHonored,
                cutFeedLines = lido.cutFeedLines,
                dialect = dialeto,
                statusProtocol = MEASURED_STATUS_PROTOCOL,
                verticalRasterScale = fator,
                measuredAtEpochMillis = lido.measuredAtEpochMillis,
                source = PrinterProfileSource.MEASURED,
                firmwareVersion = lido.firmwareVersion,
            )
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    // **Antes da busca, uma construção de sondagem.** Sem ela, um perfil que as validações de
    // `MeasuredProfile` recusam — um `id` que não é UUID, uma geometria impossível — produziria zero
    // candidatos e sairia daqui como `KEY_DOES_NOT_MATCH`, mandando a pessoa procurar corrupção num
    // arquivo que está inteiro. O motivo precisa apontar para a causa.
    try {
        MeasuredProfile(
            id = id,
            displayName = lido.displayName,
            transports = transportes,
            paperWidthMm = lido.paperWidthMm,
            printableColumns = lido.printableColumns,
            printableDots = lido.printableDots,
            codePage = pagina,
            textEncoding = codificacao,
            codePageSelector = lido.codePageSelector,
            cutProtocol = corte,
            cutModeHonored = lido.cutModeHonored,
            cutFeedLines = lido.cutFeedLines,
            dialect = dialeto,
            statusProtocol = MEASURED_STATUS_PROTOCOL,
            measuredAtEpochMillis = lido.measuredAtEpochMillis,
            source = PrinterProfileSource.MEASURED,
            firmwareVersion = lido.firmwareVersion,
        )
    } catch (erro: IllegalArgumentException) {
        return refuse(PrinterContributionRefusal.INVALID_PROFILE, erro.message ?: "o perfil descrito é inválido.")
    }

    // O caso comum primeiro: sem fator, é um candidato e um hash.
    val candidatos = mutableListOf<MeasuredProfile>()
    monta(null)?.takeIf { it.capabilityKey.value == lido.capabilityKey }?.let { candidatos += it }
    if (candidatos.isEmpty()) {
        // Só agora a varredura de milésimos, que é o perfil que TEM compensação medida.
        for (milesimos in 1..VERTICAL_RASTER_SCALE_SEARCH_CEILING) {
            val fator = milesimos.toDouble() / MeasuredProfile.VERTICAL_RASTER_SCALE_CANONICAL_SCALE
            monta(fator)?.takeIf { it.capabilityKey.value == lido.capabilityKey }?.let { candidatos += it }
        }
    }

    if (candidatos.isEmpty()) {
        return refuse(
            PrinterContributionRefusal.KEY_DOES_NOT_MATCH,
            "a chave de capacidade não fecha com o que o pacote descreve.",
        )
    }
    if (candidatos.size > 1) {
        return refuse(
            PrinterContributionRefusal.AMBIGUOUS_KEY,
            "mais de uma medição reproduz a chave declarada.",
        )
    }

    // Não há conferência de transporte aqui, e a ausência é deliberada: `supports` pergunta se um
    // transporte está no conjunto do próprio perfil, e o conjunto veio deste mesmo JSON. A pergunta
    // que importa — se ESTA máquina fala algum deles — é de quem instala, com o hardware na frente,
    // e não de quem lê um arquivo.
    return PrinterContributionImport.Accepted(
        profile = candidatos.single(),
        // `entries`, e não a lista literal dos cinco valores que estava aqui até 30/08/2026.
        //
        // O enum É a lista do que o pacote v1 não carrega: ele não existe para outra coisa. Escrita
        // à mão, a lista tinha uma falha de omissão silenciosa — um sexto valor entraria no enum,
        // ninguém lembraria deste `setOf`, e a capacidade nova passaria por aqui **sem ser
        // declarada ausente**. Quem instala leria "só isto ficou sem medida" e estaria errado, que é
        // o pior desfecho possível para uma lista cuja função é dizer o que NÃO se sabe.
        //
        // Achado pelo lote C38 ao escrever o gesto de origem, onde o `when` equivalente é exaustivo
        // e quebra o build. Aqui não quebrava nada. A prova que mata a volta atrás está em
        // `ContribuicaoLidaNaJvmTest`, e foi mordida.
        unmeasured = PrinterContributionUnmeasured.entries.toSet(),
    )
}

/**
 * O único status que um perfil medido pode ter, e não é escolha deste leitor.
 *
 * `MeasuredProfile` recusa qualquer outro valor quando `source` é `MEASURED`, com o motivo escrito
 * lá: *"status não pode ser inferido da impressão: exige uma sonda própria futura"*. Então o campo
 * não estar no JSON **não é perda**: ele não tem grau de liberdade nenhum, e ler o pacote não
 * precisa descobri-lo. Se um dia a sonda de status existir e o campo passar a variar, ele terá de
 * entrar no pacote — e esta constante é onde a mudança falha alto.
 */
private val MEASURED_STATUS_PROTOCOL = PrinterStatusProtocol.NONE

private const val CONTRIBUTION_KIND = "printher.printer-contribution"
private const val CONTRIBUTION_VERSION = 1

/**
 * Até onde a varredura de milésimos vai.
 *
 * 4,0 é folgado de propósito: o único fator medido neste programa é 0,80 (Inico T210), e um teto
 * apertado no valor conhecido transformaria a próxima impressora numa recusa inexplicável. Quatro
 * mil hashes de uma string de oitenta bytes é trabalho que não aparece no relógio, então não há o
 * que economizar aqui.
 */
private const val VERTICAL_RASTER_SCALE_SEARCH_CEILING = 4_000

private class ContributionFields(
    val displayName: String,
    val firmwareVersion: String?,
    val transports: List<String>,
    val paperWidthMm: Int,
    val printableColumns: Int,
    val printableDots: Int,
    val textEncoding: String,
    val codePage: String?,
    val codePageSelector: Int?,
    val cutProtocol: String,
    val cutModeHonored: Boolean,
    val cutFeedLines: Int,
    val dialect: String,
    val capabilityKey: String,
    val measuredAtEpochMillis: Long,
)

private fun refuse(
    reason: PrinterContributionRefusal,
    detail: String,
): PrinterContributionImport.Refused = PrinterContributionImport.Refused(reason, detail)

private inline fun <reified T : Enum<T>> enumOrNull(name: String): T? =
    enumValues<T>().firstOrNull { it.name == name }

/** A volta de [contributionName]. Escrita como `when` exaustivo para não sobreviver a um enum novo. */
private fun textEncodingFromContributionName(name: String): ThermalTextEncoding? =
    ThermalTextEncoding.entries.firstOrNull { it.contributionName == name }
