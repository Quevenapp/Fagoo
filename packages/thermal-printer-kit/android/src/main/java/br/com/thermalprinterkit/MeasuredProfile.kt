package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

/** Origem do perfil. Só medições locais pertencem ao armazenamento do aparelho. */
enum class PrinterProfileSource {
    MEASURED,
    BUNDLED,
    TEMPORARY,
}

/**
 * Chave opaca das capacidades que afetam os bytes e o papel.
 *
 * O hash não recebe identificador, nome de exibição, data nem origem. Assim dois aparelhos podem
 * reconhecer medições equivalentes sem transformar marca, modelo ou histórico em identidade.
 */
@JvmInline
value class PrinterCapabilityKey private constructor(val value: String) {
    init {
        require(value.matches(HEX_SHA_256)) { "Chave de capacidade inválida." }
    }

    override fun toString(): String = value

    companion object {
        private val HEX_SHA_256 = Regex("[0-9a-f]{64}")

        internal fun fromCanonical(canonical: String): PrinterCapabilityKey {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(canonical.toByteArray(StandardCharsets.UTF_8))
            return PrinterCapabilityKey(digest.joinToString("") { byte -> "%02x".format(byte) })
        }
    }
}

/**
 * Perfil medido em papel ou homologado e embutido no binário.
 *
 * Marca e modelo existem somente em [displayName]. A versão de firmware declarada pode ser
 * preservada, mas fica fora da chave de capacidades: ela não muda byte no papel. Endpoint,
 * identidade física e transporte pertencem à instalação cifrada, nunca a este tipo.
 */
data class MeasuredProfile(
    val id: String,
    val displayName: String,
    val transports: Set<PrinterTransport>,
    val paperWidthMm: Int,
    val printableColumns: Int,
    val printableDots: Int,
    val codePage: ThermalCodePage?,
    /** Modelo do fio: página de byte único, UTF-8 ou dobra ASCII sem acento. */
    val textEncoding: ThermalTextEncoding =
        if (codePage == null) ThermalTextEncoding.ASCII else ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE,
    /**
     * Endereço medido da página em `ESC t`, quando a firmware não usa o canônico.
     *
     * Medido na bancada em 2026-08-10: a T210 (`58E_BT`) atende a CP860 em `ESC t 8`, não no 3, e
     * responde com tabela tailandesa no `n` reservado à CP1252. O assistente reprovava a
     * impressora e concluía `Nenhuma` porque perguntava pelo nome, não pelo endereço.
     *
     * **Fora da `capabilityKey` de propósito.** Duas impressoras com a mesma página efetiva
     * produzem o mesmo papel, ainda que a alcancem por `n` diferente; incluir o endereço mudaria
     * a chave de todo perfil já medido para distinguir coisas idênticas no papel.
     */
    val codePageSelector: Int? = null,
    val cutProtocol: CutProtocol,
    /**
     * A firmware entrega o modo que o comando pede?
     *
     * Medido na bancada em 2026-08-10: a GoldenSky 80 mm obedeceu aos sete comandos e cortou
     * **sempre parcial**, inclusive nos que pedem total (`GS V 0`, `ESC i`). O comando é atendido;
     * o modo não. Com isto em `false`, [withCutMode] recusa a troca em vez de prometer papel solto
     * que nunca vem — perfil com dado suposto é pior que perfil nenhum.
     *
     * **Fora da `capabilityKey`**: os bytes emitidos continuam sendo os de [cutProtocol], que já
     * está na chave. Isto descreve se existe escolha, não o que sai no papel.
     */
    val cutModeHonored: Boolean = true,
    val cutFeedLines: Int,
    val dialect: EscPosDialect,
    val statusProtocol: PrinterStatusProtocol,
    /**
     * Gravação de logotipo em NV RAM, medida — nunca presumida. Ver `PrinterDriverProfile`.
     *
     * Perfil medido pelo usuário nasce `false`: o assistente ainda não tem sonda para NV RAM, e
     * perfil com dado suposto é pior que perfil nenhum.
     */
    val supportsNvLogo: Boolean = false,
    /**
     * Teto de vazão de raster, em bytes por segundo, medido — nunca presumido. Ver
     * [PrinterDriverProfile.maxRasterBytesPerSecond].
     *
     * Perfil medido pelo usuário nasce `null`, e **continua nascendo**: desde 20/08 nenhuma sonda
     * define este campo. A régua da homologação passou a concluir [verticalRasterScale], porque a
     * hipótese de vazão foi medida e refutada na T210. `null` é o conservador aqui porque é o
     * comportamento que já está homologado nas outras impressoras.
     *
     * **Fora da `capabilityKey` de propósito**: os bytes emitidos são exatamente os mesmos, muda só
     * o ritmo com que saem do rádio. Incluí-lo mudaria a chave de todo perfil já medido para
     * distinguir cupons idênticos byte a byte.
     */
    val maxRasterBytesPerSecond: Int? = null,
    /**
     * Fator de compensação vertical de raster, medido — nunca presumido. Ver
     * [PrinterDriverProfile.verticalRasterScale].
     *
     * Perfil medido pelo usuário nasce `null`: sem a régua da sonda não há fator, e compensar por
     * palpite deformaria a foto de quem nunca teve defeito. `null` é o conservador aqui porque é o
     * comportamento homologado em todas as outras impressoras.
     *
     * **Dentro da `capabilityKey`, e este é o único campo medido tardio que entra nela.** Os bytes
     * emitidos mudam por causa dele: a mesma foto vira 1,25x mais linhas num perfil com fator 0,80.
     * Deixá-lo de fora faria a T210 casar com o perfil de uma impressora que imprime certo, e a
     * foto voltaria a sair 20% curta pelo caminho do catálogo. A chave de perfil sem fator **não
     * muda**: o campo só entra na string canônica quando existe.
     */
    val verticalRasterScale: Double? = null,
    /**
     * Como esta impressora aceita configuração de rede, ou `null` enquanto ninguém determinou.
     *
     * O valor carrega **a procedência junto com a família** — ver [PrinterWifiConfigurationFamily],
     * onde a lista de casos e o motivo de o indeterminado não ser representável estão escritos.
     * Aqui basta o que ele significa para o perfil: `null` é "nunca determinado", e não um padrão
     * que pareça medição. Perfil gravado antes deste campo volta `null` e continua perguntando,
     * como sempre perguntou.
     *
     * **Quem escreve é a tela de configuração de rede, e ninguém mais**, depois de a pessoa
     * responder. Nenhuma sonda de homologação o preenche: ele não sai da série de tiras que a
     * homologação imprime, e completá-lo ali seria inventar medição.
     *
     * **Fora da [capabilityKey] de propósito**, como [cutModeHonored]: ele não muda um byte de
     * cupom. Decide qual quadro a tela de configuração monta, e quadro de configuração não é cupom —
     * duas impressoras que imprimem idêntico têm de continuar com a mesma chave.
     *
     * **Fora de [PrinterDriverProfile], também de propósito.** Aquele perfil é o que o emissor lê
     * para montar bytes de cupom, e o emissor não monta quadro de configuração. Ele fica só aqui, no
     * perfil medido, que é onde as capacidades que a bancada descobre moram.
     *
     * **Fora do pacote de contribuição.** O precedente é dividido — o seletor de página e o modo de
     * corte saem no pacote; o teto, o fator e o logotipo em NV RAM não —, e o que decide aqui é a
     * procedência misturada: um dos três casos é escolha de uma pessoa, e um pacote de homologação
     * que a carregasse publicaria palpite como medição de bancada. Omiti-lo inteiro é honesto;
     * omitir só o caso declarado deixaria a ausência querendo dizer duas coisas.
     */
    val wifiConfigurationFamily: PrinterWifiConfigurationFamily? = null,
    val measuredAtEpochMillis: Long?,
    val source: PrinterProfileSource,
    /** `GS I 65`, saneado; identidade editorial, deliberadamente fora da [capabilityKey]. */
    val firmwareVersion: String? = null,
    /**
     * Esta firmware desenha o QR quando o `GS ( k` pede? Ver [PrinterDriverProfile.nativeQrHonored].
     *
     * Três estados, e o `null` é um deles: ausente, medido-não, medido-sim. **Fora da
     * [capabilityKey] de propósito**, como [cutModeHonored] — a chave é identidade de capacidade, e
     * duas impressoras com as mesmas capacidades têm de compartilhar chave. Perfil já medido não
     * pode ver a chave dele se mover por causa de um campo que ninguém mediu ainda.
     */
    val nativeQrHonored: Boolean? = null,
    /**
     * O mesmo para o `GS k` do código de barras. Ver [PrinterDriverProfile.nativeBarcodeHonored].
     *
     * Também fora da [capabilityKey], pela mesma razão.
     */
    val nativeBarcodeHonored: Boolean? = null,
) {
    init {
        require(displayName.isNotBlank() && displayName.length <= MAX_DISPLAY_NAME_LENGTH) {
            "Nome de exibição do perfil inválido."
        }
        require(displayName.none(Char::isISOControl)) { "Nome de exibição do perfil inválido." }
        require(TECHNICAL_IDENTIFIER_PATTERNS.none { it.containsMatchIn(displayName) }) {
            "Nome de exibição não pode carregar endpoint ou identificador técnico."
        }
        require(
            firmwareVersion == null ||
                PrinterDeclaredIdentity.sanitizeField(
                    firmwareVersion.toByteArray(StandardCharsets.US_ASCII),
                ) == firmwareVersion,
        ) { "Versão de firmware declarada inválida." }
        require(transports.isNotEmpty()) { "Perfil sem transporte declarado." }
        require(paperWidthMm in SUPPORTED_PAPER_WIDTHS_MM) { "Largura de papel inválida." }
        require(printableColumns in MIN_PRINTABLE_COLUMNS..MAX_PRINTABLE_COLUMNS) {
            "Largura textual medida inválida."
        }
        require(printableDots in printableDotCandidates(paperWidthMm)) {
            "Largura raster medida inválida."
        }
        require(qrWidthDots(printableColumns, printableDots) >= MIN_SAFE_RASTER_QR_DOTS) {
            "Área imprimível abaixo do mínimo seguro para QR raster."
        }
        require(textEncoding.usesCodePage == (codePage != null)) {
            "Modelo de codificação e página de código incompatíveis."
        }
        require(textEncoding == ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE || codePageSelector == null) {
            "Seletor de página só existe quando o kit seleciona a página."
        }
        require(
            maxRasterBytesPerSecond == null ||
                maxRasterBytesPerSecond in RASTER_BYTES_PER_SECOND_RANGE,
        ) { "Teto de vazão de raster medido inválido." }
        require(
            verticalRasterScale == null || verticalRasterScale in VERTICAL_RASTER_SCALE_RANGE,
        ) { "Fator de compensação vertical medido inválido." }
        require(cutFeedLines in CUT_FEED_CHOICES) { "Avanço de corte medido inválido." }
        require(
            cutProtocol !in CUTS_WITH_EMBEDDED_FEED && cutProtocol != CutProtocol.NONE ||
                cutFeedLines == 0,
        ) {
            "Corte sem avanço separado precisa concluir com avanço zero."
        }
        when (source) {
            PrinterProfileSource.MEASURED -> {
                require(isLocalUuid(id)) { "Perfil medido precisa de UUID local." }
                require(measuredAtEpochMillis != null && measuredAtEpochMillis > 0) {
                    "Perfil medido precisa registrar quando a medição terminou."
                }
                // Status não pode ser inferido da impressão: exige uma sonda própria futura.
                require(statusProtocol == PrinterStatusProtocol.NONE) {
                    "Perfil novo não pode declarar status sem sonda própria."
                }
            }
            PrinterProfileSource.BUNDLED -> {
                require(id.matches(PUBLISHED_PROFILE_ID)) { "Identificador bundled inválido." }
                require(measuredAtEpochMillis == null) { "Perfil bundled não leva data local." }
            }
            PrinterProfileSource.TEMPORARY -> {
                require(id.matches(TEMPORARY_PROFILE_ID)) { "Identificador temporário inválido." }
                require(measuredAtEpochMillis == null) { "Perfil temporário não leva data local." }
                require(codePage == null) { "Perfil temporário não escolhe página de código." }
                require(textEncoding == ThermalTextEncoding.ASCII) {
                    "Perfil temporário precisa dobrar acentos para ASCII."
                }
                require(cutProtocol == CutProtocol.NONE && cutFeedLines == 0) {
                    "Perfil temporário não aciona guilhotina."
                }
                require(statusProtocol == PrinterStatusProtocol.NONE) {
                    "Perfil temporário não consulta status."
                }
            }
        }
    }

    val capabilityKey: PrinterCapabilityKey
        get() = PrinterCapabilityKey.fromCanonical(capabilityCanonicalString())

    val qrWidthDots: Int
        get() = qrWidthDots(printableColumns, printableDots)

    val hasCutter: Boolean
        get() = cutProtocol != CutProtocol.NONE

    /** Grudado ou solto. `null` só quando não há guilhotina. */
    val cutMode: CutMode?
        get() = cutProtocol.cutMode

    /**
     * Troca só o modo, preservando o dialeto que a bancada mediu. É o que permite a ficha sair
     * grudada sem repetir a homologação: o comando que a firmware provou atender continua o mesmo,
     * muda o irmão. Sem guilhotina não há o que trocar.
     */
    fun withCutMode(mode: CutMode): MeasuredProfile =
        if (cutProtocol == CutProtocol.NONE || !cutModeHonored) {
            // Sem guilhotina não há o que trocar; com modo não honrado, trocar seria prometer um
            // corte que a firmware não entrega.
            this
        } else {
            copy(cutProtocol = cutProtocol.withCutMode(mode))
        }

    /**
     * Grava como esta impressora aceita configuração de rede, sem tocar em nada que foi medido.
     *
     * Molde de [withCutMode], e pela mesma razão: quem escreve este campo é a tela de rede, que não
     * mediu geometria, página nem corte — reconstruir o perfil ali à mão é o caminho pelo qual
     * [verticalRasterScale] e [maxRasterBytesPerSecond] já se perdem hoje na edição manual.
     *
     * [measuredAtEpochMillis] **não** muda: nada foi remedido no papel que a homologação certifica,
     * e mexer nele reordenaria a lista de perfis por causa de uma resposta de tela. Existe como
     * método, e não como `copy` solto no chamador, para o gêmeo iOS — onde não há `copy` — ter o
     * mesmo nome e o mesmo contrato.
     */
    fun withWifiConfigurationFamily(family: PrinterWifiConfigurationFamily?): MeasuredProfile =
        copy(wifiConfigurationFamily = family)

    fun supports(transport: PrinterTransport): Boolean = transport in transports

    /** Adapta a medição ao contrato produtivo M1 sem ensinar endpoint algum ao perfil. */
    fun toDriverProfile(): PrinterDriverProfile =
        PrinterDriverProfile(
            id = id,
            revision = 1,
            displayName = displayName,
            transports = transports,
            printableColumns = printableColumns,
            printableDots = printableDots,
            hasCutter = hasCutter,
            cutProtocol = cutProtocol,
            cutFeedLines = cutFeedLines,
            dialect = dialect,
            statusProtocol = statusProtocol,
            supportsNvLogo = supportsNvLogo,
            // Sem isto o teto morre na conversão e o transporte volta a soltar o raster byte a
            // byte — que é exatamente o defeito que ele existe para conter.
            maxRasterBytesPerSecond = maxRasterBytesPerSecond,
            // Sem isto o fator morre na conversão e a foto volta a sair encolhida na impressora
            // que a sonda acabou de medir encolhendo.
            verticalRasterScale = verticalRasterScale,
            // Sem isto a capacidade medida morre na conversão, a trava do layout vê `null` e o modo
            // nativo nunca sai — a medição existiria e não alcançaria o papel.
            nativeQrHonored = nativeQrHonored,
            nativeBarcodeHonored = nativeBarcodeHonored,
            network = PrinterNetworkProfile(tcpPort = DEFAULT_PRINTER_TCP_PORT)
                .takeIf { PrinterTransport.LOCAL_WIFI in transports },
            codePage = codePage,
            textEncoding = textEncoding,
            // Sem isto, o endereço medido morre na conversão e o papel volta ao `n` canônico.
            codePageSelector = codePageSelector,
        )

    override fun toString(): String = "MeasuredProfile(id=$id, source=$source)"

    private fun capabilityCanonicalString(): String =
        listOf(
            CAPABILITY_KEY_VERSION,
            transports.map(PrinterTransport::name).sorted().joinToString(","),
            paperWidthMm,
            printableColumns,
            printableDots,
            // v2 inclui o modelo porque UTF-8 e ASCII mantêm `codePage = null`, mas emitem bytes
            // diferentes para a mesma frase. O seletor `ESC t n` continua fora: ele só encontra a
            // mesma página efetiva por outro endereço e não muda o papel.
            textEncoding.name,
            codePage?.name ?: NONE_VALUE,
            cutProtocol.capabilityName,
            cutFeedLines,
            dialect.name,
            statusProtocol.name,
            if (PrinterTransport.LOCAL_WIFI in transports) DEFAULT_PRINTER_TCP_PORT else NONE_VALUE,
        ).joinToString("|") + verticalRasterScaleCanonicalSuffix()

    /**
     * O fator entra na chave **só quando existe**, e por isso nenhuma chave já emitida se move.
     *
     * Ele muda os bytes: a mesma foto vira 1,25x mais linhas num perfil com fator 0,80, então dois
     * perfis que diferem só nele não são medições equivalentes e não podem compartilhar chave. Um
     * campo novo em posição fixa faria a conta certa e cobraria caro pelo caminho errado: mudaria
     * a chave de todo perfil já medido e já contribuído, para distinguir cupons que continuam
     * idênticos byte a byte. Um sufixo opcional mantém a igualdade de quem nunca viu a sonda e
     * separa quem viu.
     *
     * Em milésimos, e por inteiro: `0,8` de duas plataformas precisa dar a mesma string, e
     * formatação de ponto flutuante não promete isso.
     */
    private fun verticalRasterScaleCanonicalSuffix(): String =
        verticalRasterScale
            ?.let { "|VRS${Math.round(it * VERTICAL_RASTER_SCALE_CANONICAL_SCALE)}" }
            ?: ""

    companion object {
        const val TEMPORARY_PROFILE_WARNING =
            "Perfil temporário: acentos, corte e sensores ficam desativados até a homologação em papel."
        const val MIN_SAFE_RASTER_QR_DOTS = 160
        const val DEFAULT_PRINTER_TCP_PORT = 9_100

        val CUT_FEED_CHOICES: Set<Int> = linkedSetOf(0, 2, 4, 5, 6, 8, 10, 12)
        val CUTS_WITH_EMBEDDED_FEED: Set<CutProtocol> =
            setOf(CutProtocol.GS_V_65, CutProtocol.GS_V_66)

        fun createLocal(
            displayName: String,
            transports: Set<PrinterTransport>,
            paperWidthMm: Int,
            printableColumns: Int,
            printableDots: Int,
            codePage: ThermalCodePage?,
            textEncoding: ThermalTextEncoding =
                if (codePage == null) ThermalTextEncoding.ASCII else ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE,
            cutProtocol: CutProtocol,
            cutFeedLines: Int,
            measuredAtEpochMillis: Long,
            id: String = UUID.randomUUID().toString(),
            codePageSelector: Int? = null,
            cutModeHonored: Boolean = true,
            /**
             * O idioma da impressora. Ver [temporary]: e o unico campo aqui que a homologacao
             * **nao** mede, porque nao ha como medi-lo sem falar errado com o aparelho primeiro.
             * Ele vem da candidata, que por sua vez o recebeu do card do catalogo ou da pergunta
             * feita antes da primeira tira, e atravessa a adocao intacto. Sem isso a impressora
             * homologada voltava a ESC/POS depois de salva.
             *
             * **Sem padrao desde 09/09/2026.** Esta funcao grava perfil no disco, e um perfil
             * gravado decide os bytes de toda impressao seguinte: o `= EPSON_COMPATIBLE` que
             * estava aqui transformava "quem chamou esqueceu" em "a impressora fala ESC/POS", sem
             * tela nenhuma dizendo o que mudou.
             */
            dialect: EscPosDialect,
            firmwareVersion: String? = null,
            /**
             * Teto de vazão de raster, quando algum dia alguém o medir na bancada.
             *
             * Nenhuma sonda o define desde 20/08: a hipótese de vazão foi medida e refutada na
             * T210, e o que a régua da homologação conclui agora é [verticalRasterScale].
             */
            maxRasterBytesPerSecond: Int? = null,
            /** Só a régua da sonda produz este fator; sem ela o perfil nasce sem compensação. */
            verticalRasterScale: Double? = null,
            /**
             * O que a tira de código nativo mediu, ou `null` quando ela não saiu.
             *
             * Nulo por padrão, e nulo é um estado: perfil anterior à sonda nasce sem resposta e
             * continua imprimindo exatamente como imprime hoje, porque o padrão é rasterizado e a
             * trava do layout exige `true`.
             */
            nativeQrHonored: Boolean? = null,
            nativeBarcodeHonored: Boolean? = null,
            /**
             * Só a tela de configuração de rede produz este valor, e só depois de a pessoa
             * responder; sem ela o perfil nasce com a pergunta em aberto. Ele viaja neste
             * construtor para a edição manual não apagá-lo ao reconstruir o perfil do zero.
             */
            wifiConfigurationFamily: PrinterWifiConfigurationFamily? = null,
        ): MeasuredProfile =
            MeasuredProfile(
                id = id,
                displayName = displayName,
                // O argumento descreve a sessão que mediu o papel; não vira capacidade do perfil.
                transports = PrinterTransport.entries.toSet().also { require(transports.isNotEmpty()) },
                paperWidthMm = paperWidthMm,
                printableColumns = printableColumns,
                printableDots = printableDots,
                codePage = codePage,
                textEncoding = textEncoding,
                codePageSelector = codePageSelector,
                cutProtocol = cutProtocol,
                cutModeHonored = cutModeHonored,
                cutFeedLines = cutFeedLines,
                dialect = dialect,
                statusProtocol = PrinterStatusProtocol.NONE,
                measuredAtEpochMillis = measuredAtEpochMillis,
                source = PrinterProfileSource.MEASURED,
                firmwareVersion = firmwareVersion,
                maxRasterBytesPerSecond = maxRasterBytesPerSecond,
                verticalRasterScale = verticalRasterScale,
                nativeQrHonored = nativeQrHonored,
                nativeBarcodeHonored = nativeBarcodeHonored,
                wifiConfigurationFamily = wifiConfigurationFamily,
            )

        /**
         * @param dialect o idioma da impressora escolhida no catalogo, quando ha uma.
         *
         * **Dialeto nao e capacidade.** Todo o resto deste perfil e deliberadamente conservador:
         * sem pagina de codigo, sem guilhotina, largura no palpite seguro — porque supor
         * capacidade nao medida estraga um cupom, e medir e justamente o que vem depois. O
         * dialeto nao segue essa regra: errar o idioma nao da cupom feio, da aparelho travado
         * com a tecla de avanco morta. Medido na Diebold IM453H em 24/08/2026, o padrao ESC/POS
         * chegava nela como `ESC @` e `GS v0`, e a firmware, que nao tem nenhum comando `GS`,
         * cuspia trinta centimetros de caractere e parava de responder.
         *
         * Por isso ele **vem do card** e nao do padrao — e desde 09/09/2026 **nao tem padrao
         * nenhum**. Enquanto teve, a frase que estava aqui dizia que sem card `EPSON_COMPATIBLE`
         * continua sendo a aposta certa; ela era verdadeira e estava no lugar errado. Uma aposta
         * pode ser a melhor disponivel e ainda assim precisar ser **declarada** por quem a faz:
         * quem chama sem card tem de escrever o argumento, e ao escreve-lo tem a chance de
         * perceber que nao sabe a resposta. Era esse `= EPSON_COMPATIBLE` que fazia uma Diebold
         * chegada por "Nova impressora" receber ESC/POS sem ninguem ter decidido nada.
         */
        fun temporary(
            transport: PrinterTransport,
            paperWidthMm: Int,
            displayName: String? = null,
            dialect: EscPosDialect,
        ): MeasuredProfile {
            val defaults = geometryDefaults(paperWidthMm)
            return MeasuredProfile(
                id = "temporary.${paperWidthMm}.${transport.name.lowercase()}",
                displayName = displayName ?: "Impressora temporária $paperWidthMm mm",
                transports = setOf(transport),
                paperWidthMm = paperWidthMm,
                printableColumns = defaults.printableColumns,
                printableDots = defaults.printableDots,
                codePage = null,
                textEncoding = ThermalTextEncoding.ASCII,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                dialect = dialect,
                statusProtocol = PrinterStatusProtocol.NONE,
                measuredAtEpochMillis = null,
                source = PrinterProfileSource.TEMPORARY,
            )
        }

        fun bundled(profile: PrinterDriverProfile): MeasuredProfile =
            MeasuredProfile(
                id = profile.id,
                displayName = profile.displayName,
                transports = profile.transports,
                paperWidthMm = if (profile.printableColumns <= 32) 58 else 80,
                printableColumns = profile.printableColumns,
                printableDots = profile.printableDots,
                codePage = profile.codePage,
                textEncoding = profile.textEncoding,
                cutProtocol = profile.cutProtocol,
                cutFeedLines =
                    if (
                        profile.cutProtocol == CutProtocol.NONE ||
                            profile.cutProtocol in CUTS_WITH_EMBEDDED_FEED
                    ) {
                        0
                    } else {
                        profile.cutFeedLines
                    },
                dialect = profile.dialect,
                statusProtocol = profile.statusProtocol,
                maxRasterBytesPerSecond = profile.maxRasterBytesPerSecond,
                verticalRasterScale = profile.verticalRasterScale,
                // Ida e volta da conversão precisam preservar o que a entrada declarou; campo que
                // morre no meio do caminho é medição perdida sem erro em lugar nenhum.
                nativeQrHonored = profile.nativeQrHonored,
                nativeBarcodeHonored = profile.nativeBarcodeHonored,
                measuredAtEpochMillis = null,
                source = PrinterProfileSource.BUNDLED,
            )

        fun geometryDefaults(paperWidthMm: Int): PrinterGeometry =
            when (paperWidthMm) {
                58 -> PrinterGeometry(58, printableColumns = 32, printableDots = 384)
                80 -> PrinterGeometry(80, printableColumns = 48, printableDots = 576)
                else -> throw IllegalArgumentException("Largura de papel inválida.")
            }

        fun printableDotCandidates(paperWidthMm: Int): List<Int> =
            when (paperWidthMm) {
                58 -> listOf(256, 288, 320, 384)
                80 -> listOf(384, 512, 576, 640)
                else -> emptyList()
            }

        fun qrWidthDots(
            printableColumns: Int,
            printableDots: Int,
        ): Int = minOf(320, printableDots, printableColumns * 12) / 8 * 8

        private fun isLocalUuid(id: String): Boolean =
            runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false)

        private const val CAPABILITY_KEY_VERSION = "v2"

        /** Milésimos: o fator entra na chave como inteiro, igual nas duas plataformas. */
        internal const val VERTICAL_RASTER_SCALE_CANONICAL_SCALE = 1_000
        private const val NONE_VALUE = "NONE"
        internal const val MAX_DISPLAY_NAME_LENGTH = 80
        private const val MIN_PRINTABLE_COLUMNS = 24
        private const val MAX_PRINTABLE_COLUMNS = 96
        private val SUPPORTED_PAPER_WIDTHS_MM = setOf(58, 80)
        private val PUBLISHED_PROFILE_ID = Regex("[a-z0-9][a-z0-9._-]{2,79}")
        private val TEMPORARY_PROFILE_ID = Regex("temporary\\.(58|80)\\.[a-z_]+")
        internal val TECHNICAL_IDENTIFIER_PATTERNS =
            listOf(
                Regex("(?:^|\\D)(?:\\d{1,3}\\.){3}\\d{1,3}(?:$|\\D)"),
                Regex("(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}"),
                Regex("(?i)\\b(?:VID|PID|MAC|UUID|PERIPHERAL)\\b"),
                Regex("(?i)\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b"),
            )
    }
}

/**
 * O nome serve como `displayName` de perfil?
 *
 * O nome que o aparelho declara no Bluetooth costuma terminar com bytes do endereço — `T210_D0E9` —
 * e a validação do perfil recusa identificador técnico. Perguntar antes evita construir um perfil
 * que só falha na hora de salvar.
 */
fun isAcceptableProfileName(name: String): Boolean =
    runCatching {
        val limpo = name.trim()
        limpo.isNotEmpty() &&
            limpo.length <= MeasuredProfile.MAX_DISPLAY_NAME_LENGTH &&
            limpo.none(Char::isISOControl) &&
            MeasuredProfile.TECHNICAL_IDENTIFIER_PATTERNS.none { it.containsMatchIn(limpo) }
    }.getOrDefault(false)

data class PrinterGeometry(
    val paperWidthMm: Int,
    val printableColumns: Int,
    val printableDots: Int,
)

/** O nome antigo emitia exatamente `GS V 1`; normalizá-lo evita chaves diferentes. */
internal val CutProtocol.capabilityName: String
    get() = if (this == CutProtocol.GS_V) CutProtocol.GS_V_1.name else name
