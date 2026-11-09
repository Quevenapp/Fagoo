package br.com.thermalprinterkit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream

/** Persistência mínima usada pelo store; útil também para testes sem Android. */
interface PrinterProfileStorage {
    fun read(): ByteArray?

    fun write(value: ByteArray)

    fun clear()
}

class InMemoryPrinterProfileStorage : PrinterProfileStorage {
    private var value: ByteArray? = null

    override fun read(): ByteArray? = value?.copyOf()

    override fun write(value: ByteArray) {
        this.value = value.copyOf()
    }

    override fun clear() {
        value?.fill(0)
        value = null
    }
}

class InMemoryPrinterProfileStore : PrinterProfileStore by
    BinaryPrinterProfileStore(InMemoryPrinterProfileStorage())

/** Guarda somente as capacidades allowlisted de perfis medidos neste aparelho. */
interface PrinterProfileStore {
    fun read(): List<MeasuredProfile>

    fun save(profile: MeasuredProfile)

    fun remove(profileId: String)

    fun clear()
}

/**
 * Grava, no perfil desta impressora, como ela aceita configuração de rede.
 *
 * **Read-modify-write, e com releitura.** O que a tela tem é uma resposta sobre um campo, e o que o
 * store recebe é um [MeasuredProfile] inteiro. Reconstruí-lo na tela apagaria em silêncio tudo o que
 * a tela não conhece — foi assim que a homologação da T210 se perdeu depois de 44 impressões, e é o
 * defeito que a edição manual ainda tem hoje com o fator de compensação.
 *
 * Devolve `false` sem gravar quando não há perfil para escrever: a candidata retida em memória não
 * tem perfil persistido, e a impressora instalada pode nem ter sido resolvida para um. **A resposta
 * da pessoa continua valendo na sessão** — quem chama não pode transformar isto em recomeço —, ela
 * só não sobrevive ao fechamento do app, e fingir que sobreviveu seria pior.
 *
 * Extensão, e não método da interface, porque [PrinterProfileStore] é implementada por hospedeiros
 * fora deste repositório: um membro novo quebraria todos eles para acrescentar uma composição de
 * `read` e `save` que qualquer implementação já oferece.
 *
 * Espelho de `PrinterProfileStore.recordWifiConfigurationFamily(_:forProfileId:)` do iOS.
 */
fun PrinterProfileStore.recordWifiConfigurationFamily(
    family: PrinterWifiConfigurationFamily,
    profileId: String,
): Boolean {
    val current = read().firstOrNull { it.id == profileId } ?: return false
    if (current.wifiConfigurationFamily == family) return true
    val updated = current.withWifiConfigurationFamily(family)
    return runCatching {
        save(updated)
        // Relê antes de dizer que gravou. Perfil que o store aceitou e devolve diferente é a falha
        // que precisa aparecer aqui, e não no papel de quem configurar a rede de novo.
        read().firstOrNull { it.id == profileId } == updated
    }.getOrDefault(false)
}

/**
 * Formato binário fechado: só os campos de [MeasuredProfile] escritos abaixo podem chegar ao
 * disco. Endpoint, MAC, VID, PID, serial e UUID de peripheral não têm campo para serem codificados.
 */
class BinaryPrinterProfileStore(
    private val storage: PrinterProfileStorage,
) : PrinterProfileStore {
    @Synchronized
    override fun read(): List<MeasuredProfile> {
        val encoded = storage.read() ?: return emptyList()
        return try {
            require(encoded.size in 1..MAX_ENCODED_BYTES) { "Store de perfis fora do limite." }
            val storedVersion = encodedVersion(encoded)
            val decoded = decode(encoded)
            val canonical = canonicalize(decoded.profiles)
            if (storedVersion < VERSION || decoded.discardedPublishedProfile || canonical != decoded.profiles) {
                writeAll(canonical)
            }
            canonical
        } catch (_: Throwable) {
            // Um registro parcial não pode virar capacidade suposta. O perfil embutido ou o
            // temporário conservador continuam disponíveis pelo resolvedor.
            storage.clear()
            emptyList()
        } finally {
            encoded.fill(0)
        }
    }

    @Synchronized
    override fun save(profile: MeasuredProfile) {
        require(profile.source == PrinterProfileSource.MEASURED) {
            "Somente perfil medido localmente pode ser persistido."
        }
        val current = read()
        require((current.map(MeasuredProfile::id) + profile.id).distinct().size <= MAX_PROFILE_COUNT) {
            "Limite local de perfis medidos atingido."
        }
        // **O que chega vem primeiro na lista, e é só isso que esta ordem faz.**
        //
        // `canonicalize` desempata por data com `maxBy`, que devolve o **primeiro** máximo. Com o
        // recém-chegado no fim, um empate de data devolvia o registro que já estava no disco:
        // gravar de novo o mesmo perfil sem mexer na data era um no-op silencioso, e quem
        // escrevesse um campo sem remedir nada perdia a escrita sem erro em lugar nenhum. Só não
        // doía antes porque o único caminho de regravação, a edição manual, empurra a data com
        // `nextMeasurementDate` — e o comentário de lá registra o sintoma: "empate faz a releitura
        // devolver o registro antigo". A tela de rede grava sem mexer na data, porque nada foi
        // remedido no papel.
        //
        // **A regra de medição mais antiga continua intacta**, e é por isso que a ordem muda em vez
        // de o registro anterior ser removido: `maxBy` continua preferindo a data estritamente
        // maior, venha ela de onde vier. Empate é escrita; mais antigo continua perdendo.
        writeAll(canonicalize(listOf(profile) + current))
    }

    @Synchronized
    override fun remove(profileId: String) {
        val remaining = read().filterNot { it.id == profileId }
        if (remaining.isEmpty()) storage.clear() else writeAll(remaining)
    }

    @Synchronized
    override fun clear() = storage.clear()

    private fun writeAll(profiles: List<MeasuredProfile>) {
        require(profiles.size <= MAX_PROFILE_COUNT) { "Perfis medidos demais para persistir." }
        val encoded = encode(profiles)
        try {
            require(encoded.size <= MAX_ENCODED_BYTES) { "Store de perfis fora do limite." }
            storage.write(encoded)
        } finally {
            encoded.fill(0)
        }
    }

    private fun encode(profiles: List<MeasuredProfile>): ByteArray =
        ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(MAGIC)
                output.writeInt(VERSION)
                output.writeInt(profiles.size)
                profiles.forEach { profile ->
                    require(profile.source == PrinterProfileSource.MEASURED)
                    output.writeUTF(profile.id)
                    output.writeUTF(profile.displayName)
                    output.writeInt(profile.paperWidthMm)
                    output.writeInt(profile.printableColumns)
                    output.writeInt(profile.printableDots)
                    output.writeInt(codePageCode(profile.codePage))
                    output.writeInt(cutProtocolCode(profile.cutProtocol))
                    output.writeInt(profile.cutFeedLines)
                    output.writeInt(dialectCode(profile.dialect))
                    output.writeInt(statusProtocolCode(profile.statusProtocol))
                    output.writeLong(requireNotNull(profile.measuredAtEpochMillis))
                    // v2: endereço da página e modo de corte, ambos medidos no papel. Sem gravá-los
                    // o perfil volta do disco com o `n` canônico e com a promessa de trocar de
                    // modo — perdendo em silêncio o que custou 44 impressões para descobrir.
                    output.writeInt(profile.codePageSelector ?: NO_CODE_PAGE_SELECTOR)
                    output.writeBoolean(profile.cutModeHonored)
                    // v3: somente firmware. Marca/modelo continuam em displayName e serial nunca
                    // é consultado; a ausência é codificada sem sentinela textual ambígua.
                    output.writeBoolean(profile.firmwareVersion != null)
                    profile.firmwareVersion?.let(output::writeUTF)
                    // v4: modelo do fio. `codePage = null` deixou de significar uma coisa só:
                    // tanto UTF-8 quanto a dobra ASCII não usam página, mas emitem bytes distintos.
                    output.writeInt(textEncodingCode(profile.textEncoding))
                    // v6: capacidade de gravar logotipo em NV RAM. Perfil antigo relê como
                    // `false`, que é o conservador: reenviar raster funciona em toda impressora
                    // que já imprime imagem, e gravar memória não volátil por engano não se
                    // desfaz.
                    output.writeBoolean(profile.supportsNvLogo)
                    // v7: teto de vazão de raster. Perfil antigo relê como "sem teto", que é o
                    // envio byte a byte já homologado; presumir um número seria frear impressora
                    // que nunca precisou de freio.
                    output.writeInt(profile.maxRasterBytesPerSecond ?: NO_RASTER_CEILING)
                    // v8: fator de compensação vertical de raster. Perfil antigo relê como "sem
                    // compensação", que é o raster byte a byte já homologado; presumir um fator
                    // esticaria a foto de impressora que nunca encolheu nada.
                    output.writeDouble(profile.verticalRasterScale ?: NO_VERTICAL_RASTER_SCALE)
                    // v9: as duas respostas da sonda de código nativo. São **dois** inteiros e não
                    // dois booleanos porque o campo tem três estados, e o terceiro é o que importa:
                    // `null` é "ninguém perguntou", e um booleano não sabe dizer isso.
                    output.writeInt(profile.nativeQrHonored.stored())
                    output.writeInt(profile.nativeBarcodeHonored.stored())
                    // v10: como esta impressora aceita configuração de rede, e de onde isso veio.
                    // Perfil antigo relê como "nunca determinado" — nem "aceita", nem "não aceita",
                    // porque nenhuma tira saiu naquele aparelho. Presumir uma família mandaria o
                    // quadro de uma para uma impressora que pode ser da outra, e a impressora
                    // errada não avisa.
                    output.writeInt(wifiConfigurationFamilyCode(profile.wifiConfigurationFamily))
                }
            }
            bytes.toByteArray()
        }

    private fun decode(encoded: ByteArray): DecodedProfiles =
        DataInputStream(ByteArrayInputStream(encoded)).use { input ->
            require(input.readInt() == MAGIC) { "Store de perfis desconhecido." }
            // v1 não tem os dois campos medidos. Ler o formato antigo é migração, não erro: falhar
            // aqui apagaria a medição de quem já usava, e "perfil medido nunca é sobrescrito" vale
            // também para o dia da atualização.
            val version = input.readInt()
            require(version in SUPPORTED_VERSIONS) { "Versão do store de perfis desconhecida." }
            val count = input.readInt()
            require(count in 0..MAX_PROFILE_COUNT) { "Quantidade de perfis inválida." }
            var discardedPublishedProfile = false
            val profiles = buildList(count) {
                repeat(count) {
                    val id = input.readUTF()
                    val displayName = input.readUTF()
                    val persistedTransports =
                        if (version >= VERSION_WITH_TRANSPORT_NEUTRAL_PROFILE) {
                            PrinterTransport.entries.toSet()
                        } else {
                            // v1–v4 gravavam o transporte usado na bancada. Consumimos o campo
                            // para preservar o restante da medição, mas descartamos essa associação.
                            input.readInt()
                            PrinterTransport.entries.toSet()
                        }
                    val paperWidthMm = input.readInt()
                    val printableColumns = input.readInt()
                    val printableDots = input.readInt()
                    val persistedCodePage = codePage(input.readInt())
                    val persistedCutProtocol = cutProtocol(input.readInt())
                    val cutFeedLines = input.readInt()
                    val persistedDialect = dialect(input.readInt())
                    val persistedStatusProtocol = statusProtocol(input.readInt())
                    val measuredAtEpochMillis = input.readLong()
                    val codePageSelector =
                        if (version >= VERSION_WITH_MEASURED_PAGE_ADDRESS) {
                            input.readInt().takeIf { it != NO_CODE_PAGE_SELECTOR }
                        } else {
                            null
                        }
                    val cutModeHonored =
                        if (version >= VERSION_WITH_MEASURED_PAGE_ADDRESS) input.readBoolean() else true
                    val firmwareVersion =
                        if (version >= VERSION_WITH_FIRMWARE_IDENTITY && input.readBoolean()) {
                            input.readUTF()
                        } else {
                            null
                        }
                    val textEncoding =
                        if (version >= VERSION_WITH_TEXT_ENCODING) {
                            textEncoding(input.readInt())
                        } else if (persistedCodePage == null) {
                            ThermalTextEncoding.ASCII
                        } else {
                            ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE
                        }
                    // Perfil gravado antes do v6 volta com `false`: a capacidade nunca foi medida
                    // naquele aparelho, e presumir `true` mandaria `FS q` para firmware que pode
                    // não conhecê-lo.
                    val supportsNvLogo =
                        if (version >= VERSION_WITH_NV_LOGO) input.readBoolean() else false
                    // Perfil gravado antes do v7 volta sem teto: aquele aparelho nunca mediu vazão,
                    // e o envio byte a byte é o que já saía no papel dele.
                    val maxRasterBytesPerSecond =
                        if (version >= VERSION_WITH_RASTER_CEILING) {
                            input.readInt().takeIf { it != NO_RASTER_CEILING }
                        } else {
                            null
                        }
                    // Perfil gravado antes do v8 volta sem compensação: aquela impressora nunca foi
                    // medida encolhendo, e o raster de sempre é o que já saía no papel dela.
                    val verticalRasterScale =
                        if (version >= VERSION_WITH_VERTICAL_RASTER_SCALE) {
                            input.readDouble().takeIf { it != NO_VERTICAL_RASTER_SCALE }
                        } else {
                            null
                        }
                    // Perfil gravado antes do v9 volta sem resposta: aquela impressora nunca viu a
                    // sonda de código nativo, e presumir que ela entende `GS ( k` mandaria comando
                    // para firmware que imprimiria o payload como texto no meio do cupom. `null`
                    // não é "não" — é "ninguém perguntou", e é o que Ajustes precisa distinguir
                    // para mandar remedir em vez de dizer que a impressora não sabe.
                    val nativeQrHonored =
                        if (version >= VERSION_WITH_NATIVE_CODE) {
                            input.readInt().asNativeAnswer()
                        } else {
                            null
                        }
                    val nativeBarcodeHonored =
                        if (version >= VERSION_WITH_NATIVE_CODE) {
                            input.readInt().asNativeAnswer()
                        } else {
                            null
                        }
                    // Perfil gravado antes do v10 volta com a pergunta em aberto: aquela impressora
                    // nunca respondeu a tira de família, e "nunca determinado" é a única coisa
                    // verdadeira a dizer sobre ela. É também o que faz a tela continuar
                    // perguntando, em vez de mandar o quadro de uma família por suposição.
                    val wifiConfigurationFamily =
                        if (version >= VERSION_WITH_WIFI_CONFIGURATION_FAMILY) {
                            wifiConfigurationFamily(input.readInt())
                        } else {
                            null
                        }
                    if (isPublishedPrinterProfileId(id)) {
                        // O v4 não tinha tag de origem. Builds de bancada chegaram a gravar perfis
                        // editoriais usando o slug publicado; consumimos o registro inteiro e o
                        // descartamos individualmente. Um erro global aqui apagaria também UUIDs
                        // medidos no mesmo blob, contrariando a garantia de preservar a medição.
                        discardedPublishedProfile = true
                    } else {
                        add(
                            MeasuredProfile(
                                id = id,
                                displayName = displayName,
                                transports = persistedTransports,
                                paperWidthMm = paperWidthMm,
                                printableColumns = printableColumns,
                                printableDots = printableDots,
                                codePage = persistedCodePage,
                                textEncoding = textEncoding,
                                cutProtocol = persistedCutProtocol,
                                cutFeedLines = cutFeedLines,
                                dialect = persistedDialect,
                                statusProtocol = persistedStatusProtocol,
                                measuredAtEpochMillis = measuredAtEpochMillis,
                                codePageSelector = codePageSelector,
                                cutModeHonored = cutModeHonored,
                                firmwareVersion = firmwareVersion,
                                supportsNvLogo = supportsNvLogo,
                                maxRasterBytesPerSecond = maxRasterBytesPerSecond,
                                verticalRasterScale = verticalRasterScale,
                                nativeQrHonored = nativeQrHonored,
                                nativeBarcodeHonored = nativeBarcodeHonored,
                                wifiConfigurationFamily = wifiConfigurationFamily,
                                source = PrinterProfileSource.MEASURED,
                            ),
                        )
                    }
                }
            }
            require(input.available() == 0) { "Dados excedentes no store de perfis." }
            DecodedProfiles(profiles, discardedPublishedProfile)
        }

    private fun encodedVersion(encoded: ByteArray): Int =
        DataInputStream(ByteArrayInputStream(encoded)).use { input ->
            require(input.readInt() == MAGIC) { "Store de perfis desconhecido." }
            input.readInt().also { require(it in SUPPORTED_VERSIONS) }
        }

    /** Mesmo ID representa a mesma medição local; a data mais nova vence e vem primeiro. */
    private fun canonicalize(profiles: List<MeasuredProfile>): List<MeasuredProfile> =
        profiles
            .groupBy(MeasuredProfile::id)
            .values
            .map { duplicates ->
                duplicates.maxBy { requireNotNull(it.measuredAtEpochMillis) }
                    .copy(transports = PrinterTransport.entries.toSet())
            }
            .sortedWith(
                compareByDescending<MeasuredProfile> { it.measuredAtEpochMillis }
                    .thenBy(MeasuredProfile::id),
            )

    private fun transportMask(transports: Set<PrinterTransport>): Int =
        transports.fold(0) { mask, transport -> mask or (1 shl transportCode(transport)) }

    private fun transports(mask: Int): Set<PrinterTransport> {
        val knownMask = PrinterTransport.entries.fold(0) { result, item -> result or (1 shl transportCode(item)) }
        require(mask != 0 && mask and knownMask == mask) { "Transportes persistidos inválidos." }
        return PrinterTransport.entries.filterTo(linkedSetOf()) { transport ->
            mask and (1 shl transportCode(transport)) != 0
        }
    }

    private fun transportCode(value: PrinterTransport): Int =
        when (value) {
            PrinterTransport.LOCAL_WIFI -> 0
            PrinterTransport.USB -> 1
            PrinterTransport.BLUETOOTH -> 2
            PrinterTransport.BLUETOOTH_LE -> 3
        }

    private fun codePageCode(value: ThermalCodePage?): Int =
        when (value) {
            null -> 0
            ThermalCodePage.CP850 -> 1
            ThermalCodePage.CP860 -> 2
            ThermalCodePage.CP437 -> 3
            ThermalCodePage.CP1252 -> 4
            ThermalCodePage.CP866 -> 5
            ThermalCodePage.CP858 -> 6
        }

    private fun codePage(value: Int): ThermalCodePage? =
        when (value) {
            0 -> null
            1 -> ThermalCodePage.CP850
            2 -> ThermalCodePage.CP860
            3 -> ThermalCodePage.CP437
            4 -> ThermalCodePage.CP1252
            5 -> ThermalCodePage.CP866
            6 -> ThermalCodePage.CP858
            else -> throw IllegalArgumentException("Página de código persistida inválida.")
        }

    private fun textEncodingCode(value: ThermalTextEncoding): Int =
        when (value) {
            ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE -> 1
            ThermalTextEncoding.UTF_8 -> 2
            ThermalTextEncoding.ASCII -> 3
            // Código novo, não reaproveitado: perfil gravado antes disto nunca vale 4.
            ThermalTextEncoding.FIRMWARE_DEFAULT_PAGE -> 4
        }

    private fun textEncoding(value: Int): ThermalTextEncoding =
        when (value) {
            1 -> ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE
            2 -> ThermalTextEncoding.UTF_8
            3 -> ThermalTextEncoding.ASCII
            4 -> ThermalTextEncoding.FIRMWARE_DEFAULT_PAGE
            else -> throw IllegalArgumentException("Modelo de codificação persistido inválido.")
        }

    /**
     * Tabela fechada, no molde de [codePageCode], e **não** `ordinal()`.
     *
     * O disco não pode depender da ordem de declaração de um enum: reordenar os casos
     * reinterpretaria todo perfil já gravado, em silêncio. E o `0` é a ausência pelo mesmo desenho
     * da página de código — aqui ele diz "nunca determinado", que é um estado real do campo e não
     * um valor de fuga.
     *
     * **Um `Int` de tabela, e não dois booleanos.** "Tem família" mais "foi medida" admitiria em
     * disco a combinação impossível — sem família e medida —, e o leitor teria de inventar uma
     * regra para ela. Este store existe justamente para não haver invenção na volta.
     */
    private fun wifiConfigurationFamilyCode(value: PrinterWifiConfigurationFamily?): Int =
        when (value) {
            null -> 0
            PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED -> 1
            PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT -> 2
            PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US -> 3
        }

    private fun wifiConfigurationFamily(value: Int): PrinterWifiConfigurationFamily? =
        when (value) {
            0 -> null
            1 -> PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED
            2 -> PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT
            3 -> PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US
            else -> throw IllegalArgumentException("Família de configuração persistida inválida.")
        }

    private fun cutProtocolCode(value: CutProtocol): Int =
        when (value) {
            CutProtocol.NONE -> 0
            CutProtocol.GS_V_0 -> 1
            CutProtocol.GS_V,
            CutProtocol.GS_V_1,
            -> 2
            CutProtocol.GS_V_65 -> 3
            CutProtocol.GS_V_66 -> 4
            CutProtocol.ESC_I -> 5
            CutProtocol.ESC_M -> 6
        }

    private fun cutProtocol(value: Int): CutProtocol =
        when (value) {
            0 -> CutProtocol.NONE
            1 -> CutProtocol.GS_V_0
            2 -> CutProtocol.GS_V_1
            3 -> CutProtocol.GS_V_65
            4 -> CutProtocol.GS_V_66
            5 -> CutProtocol.ESC_I
            6 -> CutProtocol.ESC_M
            else -> throw IllegalArgumentException("Protocolo de corte persistido inválido.")
        }

    private fun dialectCode(value: EscPosDialect): Int =
        when (value) {
            EscPosDialect.EPSON_COMPATIBLE -> 1
            EscPosDialect.PROCOMP_ESC_P -> 2
        }

    // O dialeto persiste mesmo quando o app recusa imprimir com ele: o perfil descreve a
    // impressora, e não o que esta versão sabe fazer. A recusa é do caminho de impressão, não do
    // disco — apagar o dialeto aqui faria um perfil medido voltar como se fosse Epson.
    private fun dialect(value: Int): EscPosDialect =
        when (value) {
            1 -> EscPosDialect.EPSON_COMPATIBLE
            2 -> EscPosDialect.PROCOMP_ESC_P
            else -> throw IllegalArgumentException("Dialeto persistido inválido.")
        }

    private fun statusProtocolCode(value: PrinterStatusProtocol): Int =
        when (value) {
            PrinterStatusProtocol.NONE -> 0
            PrinterStatusProtocol.DLE_EOT -> 1
        }

    private fun statusProtocol(value: Int): PrinterStatusProtocol =
        when (value) {
            0 -> PrinterStatusProtocol.NONE
            1 -> PrinterStatusProtocol.DLE_EOT
            else -> throw IllegalArgumentException("Protocolo de status persistido inválido.")
        }

    private companion object {
        const val MAGIC = 0x54504b50 // TPKP
        // v5 remove o transporte da bancada; o vínculo físico vive no store cifrado da instalação.
        const val VERSION = 10
        const val VERSION_WITH_MEASURED_PAGE_ADDRESS = 2
        const val VERSION_WITH_FIRMWARE_IDENTITY = 3
        const val VERSION_WITH_TEXT_ENCODING = 4
        const val VERSION_WITH_TRANSPORT_NEUTRAL_PROFILE = 5
        const val VERSION_WITH_NV_LOGO = 6
        const val VERSION_WITH_RASTER_CEILING = 7
        const val VERSION_WITH_VERTICAL_RASTER_SCALE = 8
        const val VERSION_WITH_NATIVE_CODE = 9
        // Duas frentes chegaram ao v9 em paralelo, cada uma na sua linha; o código nativo entrou
        // primeiro no tronco e ficou com o número. A família de rede vem depois dele no blob, e por
        // isso é v10 — trocar a ordem tornaria ilegível todo perfil já gravado com o v9 do tronco.
        const val VERSION_WITH_WIFI_CONFIGURATION_FAMILY = 10

        // Cresce junto com [VERSION], e não depois. `require(version in SUPPORTED_VERSIONS)` roda
        // em dois lugares — `decode` e `encodedVersion` —, e uma faixa que não alcança a versão
        // corrente faz a primeira leitura do blob recém-gravado cair no `catch` que limpa o store:
        // o app apagaria o que acabou de salvar, sem erro em lugar nenhum.
        val SUPPORTED_VERSIONS = 1..10
        private const val NO_CODE_PAGE_SELECTOR = -1
        private const val NO_RASTER_CEILING = -1

        /** Fora da faixa aceita pelo campo, então nenhum fator válido colide com a ausência. */
        private const val NO_VERTICAL_RASTER_SCALE = 0.0

        /**
         * A ausência de resposta da sonda de código nativo, gravada como número.
         *
         * `-1` não colide com nenhuma das duas respostas — `0` é "saiu texto" e `1` é "saiu
         * código" —, e é o mesmo desenho de sentinela do [NO_CODE_PAGE_SELECTOR].
         */
        private const val NO_NATIVE_ANSWER = -1
        private const val NATIVE_ANSWER_NO = 0
        private const val NATIVE_ANSWER_YES = 1

        /** `null → -1`, `false → 0`, `true → 1`. Três estados, três valores. */
        private fun Boolean?.stored(): Int =
            when (this) {
                null -> NO_NATIVE_ANSWER
                false -> NATIVE_ANSWER_NO
                true -> NATIVE_ANSWER_YES
            }

        private fun Int.asNativeAnswer(): Boolean? =
            when (this) {
                NO_NATIVE_ANSWER -> null
                NATIVE_ANSWER_NO -> false
                NATIVE_ANSWER_YES -> true
                // Registro parcial não pode virar capacidade suposta: o `read()` trata a exceção
                // limpando o blob, como faz com qualquer outro campo persistido inválido.
                else -> throw IllegalArgumentException("Resposta de código nativo persistida inválida.")
            }
        const val MAX_PROFILE_COUNT = 64
        const val MAX_ENCODED_BYTES = 128 * 1_024
    }

    private data class DecodedProfiles(
        val profiles: List<MeasuredProfile>,
        val discardedPublishedProfile: Boolean,
    )
}
