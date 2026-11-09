package br.com.thermalprinterkit

/** Meios físicos que um perfil aceita. Cada um exige um transporte próprio dentro do app. */
/** Público porque a interface visual precisa mostrar por onde cada impressora é alcançada. */
enum class PrinterTransport {
    LOCAL_WIFI,
    USB,

    /** Bluetooth clássico, canal serial SPP. Não existe no iOS sem certificação MFi. */
    BLUETOOTH,

    /** Bluetooth LE, via GATT. É o único caminho no iPhone e o de modelos sem SPP. */
    BLUETOOTH_LE,
}

/**
 * Parâmetros de rede. Só existe em perfis que realmente abrem socket TCP; uma impressora
 * Bluetooth ou USB não carrega porta nenhuma.
 */
data class PrinterNetworkProfile(
    val tcpPort: Int,
    val allowedTcpPorts: Set<Int> = setOf(tcpPort),
) {
    init {
        require(tcpPort in ALLOWED_TCP_PORTS) { "Perfil de impressora usa uma porta TCP não reconhecida." }
        require(allowedTcpPorts.isNotEmpty() && allowedTcpPorts.all { it in ALLOWED_TCP_PORTS }) {
            "Perfil de impressora usa uma porta TCP não reconhecida."
        }
        require(tcpPort in allowedTcpPorts) { "A porta padrão precisa ser aceita pelo perfil." }
    }

    fun accepts(port: Int): Boolean = port in allowedTcpPorts

    private companion object {
        val ALLOWED_TCP_PORTS = setOf(9_100)
    }
}

/**
 * Perfil declarativo homologado e embutido no app. Revisões futuras continuam usando
 * este formato, mas nunca código executável ou comandos arbitrários para o aparelho.
 */
data class PrinterDriverProfile(
    val id: String,
    val revision: Int,
    val displayName: String,
    val transports: Set<PrinterTransport>,
    val printableColumns: Int,
    val printableDots: Int,
    /**
     * `hasCutter` diz **se** corta; [cutProtocol] diz **como**. A MP-4200 provou que são perguntas
     * diferentes: ela tem guilhotina e recusa os bytes que a i9 aceita.
     */
    val hasCutter: Boolean,
    val cutProtocol: CutProtocol,
    /**
     * Quantas linhas avançar antes de acionar a guilhotina.
     *
     * É medida **física**, não preferência: entre a cabeça térmica e a lâmina há alguns centímetros
     * de papel, e cortar sem avançar essa distância corta em cima do que acabou de ser impresso. A
     * MP-4200 TH precisa de mais que a Elgin, e isso só o papel responde.
     */
    val cutFeedLines: Int = DEFAULT_CUT_FEED_LINES,
    val dialect: EscPosDialect,
    val statusProtocol: PrinterStatusProtocol,
    /**
     * Este modelo aceita gravar logotipo na NV RAM (`FS q` / `GS ( L`)?
     *
     * Capacidade por modelo, com default `false`, e **nunca** detectada por heurística. Em
     * impressora térmica nada implica nada: aceitar `GS v 0` não implica aceitar `FS q`, e firmware
     * de modelos "iguais" diverge. Gravar NV RAM é escrita em memória não volátil — errar o palpite
     * não devolve papel nem desfaz a gravação.
     *
     * `true` só entra depois de a bancada provar em papel, modelo a modelo. Enquanto for `false` o
     * logotipo é reenviado como raster a cada cupom, que é o caminho que já está homologado.
     */
    val supportsNvLogo: Boolean = false,
    /**
     * Quantos bytes de raster por segundo esta firmware consegue **imprimir**, ou `null` quando
     * ninguém mediu.
     *
     * Capacidade por modelo, com default nulo, e nunca detectada por heurística. Enquanto for
     * `null` o envio continua byte a byte, exatamente como hoje — e desde 20/08 ele é `null` em
     * todo perfil novo, porque **nenhuma sonda define mais este campo**.
     *
     * O caso que o justifica continua sendo o de 18/08 com a GoldenSky MTP-II: escrita sem
     * confirmação em rajada corrompia o cupom, a foto saía pela metade e o resto virava texto. Para
     * aquilo o freio é a resposta certa, está implementado e está testado.
     *
     * O caso que ele **não** explica é o da Inico T210, e isso foi medido em 20/08: mudar o teto de
     * bancada — sem teto, 32 KB/s, 4 KB/s — não mudou nem a velocidade nem o defeito, porque o
     * envio já era mais lento que o menor teto oferecido. O encolhimento da T210 é constante e se
     * compensa por [verticalRasterScale]; nada aqui tem a ver com ele. Quem quiser preencher este
     * campo precisa de uma bancada que meça rajada, não de uma régua.
     */
    val maxRasterBytesPerSecond: Int? = null,
    /**
     * Quanto da altura de raster declarada esta firmware realmente imprime, ou `null` quando
     * ninguém mediu.
     *
     * Medido na bancada em 20/08 com a Inico T210 contra a GoldenSky MTP-II, no mesmo aparelho e
     * pelo mesmo caminho BLE: a **mesma** imagem de 384x800, quase toda branca, com os mesmos
     * 45,7 KB confirmados na telemetria, sai com ~97 mm na MTP-II e com 80 mm na T210. Cobertura de
     * tinta, vazão, altura de banda, MTU, modo de escrita e emenda entre bandas foram eliminados
     * por medição; raster estreito e texto saem certos na T210. O que sobra é a firmware encolhendo
     * raster largo por um fator constante — e constante quer dizer compensável.
     *
     * Com o fator declarado, o emissor manda `1/fator` linhas e o papel sai na altura pretendida.
     * Capacidade por modelo, nula por padrão, nunca detectada por heurística: só a sonda de
     * homologação produz este número, e ele vem de uma régua. Ver [VERTICAL_RASTER_SCALE_RANGE].
     */
    val verticalRasterScale: Double? = null,
    val network: PrinterNetworkProfile? = null,
    /**
     * Página de código do texto, ou `null` quando [textEncoding] não usa tabela de byte único.
     *
     * Não é preferência, é firmware. A Elgin de balcão aceita CP850 e imprime "São João"; a
     * portátil conservadora dobra o acento para ASCII. UTF-8 também mantém este campo nulo, mas
     * preserva os acentos pelo modelo explícito; ausência de página deixou de definir o fio sozinha.
     */
    val codePage: ThermalCodePage? = ThermalCodePage.CP850,
    /** Endereço medido da página em `ESC t`; `null` usa o canônico do enum. Ver `MeasuredProfile`. */
    val codePageSelector: Int? = null,
    /** Como a firmware recebe texto. O padrão derivado mantém os perfis M1 compatíveis. */
    val textEncoding: ThermalTextEncoding =
        if (codePage == null) ThermalTextEncoding.ASCII else ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE,
    /**
     * Esta firmware desenha o QR quando o `GS ( k` pede, ou imprime o comando como texto?
     *
     * Três estados, e o `null` é um deles: **ausente** (ninguém mediu), medido-não e medido-sim.
     * Ausente não é "provavelmente sim" — em impressora térmica nada implica nada, e aceitar
     * `GS v 0` não implica aceitar `GS ( k`. Enquanto for diferente de `true`, o
     * [ReceiptLayout.from] rebaixa a preferência do hospedeiro para raster e o cupom sai como
     * sempre saiu.
     *
     * Capacidade medida, com default nulo, **nunca** detectada por heurística: só a sonda produz
     * este valor, e só depois de uma pessoa dizer o que saiu no papel — firmware que não entende o
     * comando imprime o payload como texto legível, e é isso que a pessoa vê.
     *
     * **Fora da [MeasuredProfile.capabilityKey] de propósito**, como [MeasuredProfile.cutModeHonored]: a chave é
     * identidade de capacidade, e duas impressoras com as mesmas capacidades precisam compartilhar
     * chave. O campo também não muda os bytes emitidos por si — quem muda é a preferência, que não
     * mora no perfil.
     */
    val nativeQrHonored: Boolean? = null,
    /**
     * O mesmo para o `GS k` do código de barras, e por isso é um campo separado.
     *
     * Uma firmware pode atender a um comando e ignorar o outro; medir os dois juntos e gravar um
     * número só seria decidir por medição que não existe. Ver [nativeQrHonored] para os três
     * estados e para a razão de ficar fora da chave de capacidade.
     */
    val nativeBarcodeHonored: Boolean? = null,
) {
    init {
        require(id.matches(PROFILE_ID)) { "Identificador de perfil de impressora inválido." }
        require(revision > 0) { "Revisão de perfil de impressora inválida." }
        require(transports.isNotEmpty()) { "Perfil de impressora sem transporte declarado." }
        require((PrinterTransport.LOCAL_WIFI in transports) == (network != null)) {
            "Perfil Wi-Fi exige parâmetros de rede, e perfil sem Wi-Fi não pode declará-los."
        }
        require(hasCutter == (cutProtocol != CutProtocol.NONE)) {
            "Perfil com guilhotina precisa de um protocolo de corte, e sem guilhotina não pode ter um."
        }
        require(printableColumns in MIN_COLUMNS..MAX_COLUMNS) {
            "Largura de linha do perfil de impressora inválida."
        }
        require(printableDots in MIN_DOTS..MAX_DOTS && printableDots % 8 == 0) {
            "Largura em dots do perfil de impressora inválida."
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
        ) { "Teto de vazão de raster do perfil inválido." }
        require(
            verticalRasterScale == null || verticalRasterScale in VERTICAL_RASTER_SCALE_RANGE,
        ) { "Fator de compensação vertical do perfil inválido." }
    }

    fun supports(transport: PrinterTransport): Boolean = transport in transports

    /** Porta padrão do perfil, ou `null` quando ele não fala TCP. */
    val tcpPort: Int?
        get() = network?.tcpPort

    fun acceptsTcpPort(port: Int): Boolean = network?.accepts(port) == true

    override fun toString(): String = "PrinterDriverProfile(id=$id, revision=$revision)"

    private companion object {
        val PROFILE_ID = Regex("[a-z0-9][a-z0-9._-]{2,79}")
        const val MIN_COLUMNS = 24
        const val MAX_COLUMNS = 96
        const val MIN_DOTS = 192
        const val MAX_DOTS = 1_024
    }
}

/** Cada dialeto novo precisa existir no app; o servidor apenas escolhe um dialeto conhecido. */
enum class EscPosDialect {
    EPSON_COMPATIBLE,

    /**
     * ESC/P da Diebold Procomp — a família da IM453H, medida na bancada em 23/08/2026.
     *
     * Não é ESC/POS com diferenças: é outro conjunto. **Nenhum comando `GS` existe** nele, então
     * `GS v 0` (raster), `GS V` (corte) e `GS !` (tamanho) não têm equivalente por tradução. O
     * papel também não é o único custo de errar — ver [EscPosDialectGate].
     *
     * **O emissor existe desde 23/08/2026** — [ProcompEscP] para texto e atributos,
     * [ProcompRasterEmitter] para o `ESC n`, e o [ReceiptLayout] compondo pelo dialeto do perfil —
     * e desde 26/08/2026 a homologação também tem série própria aqui
     * ([ProcompHomologationProbes]). O que o `when` exaustivo do portão continua garantindo é que
     * quem adicionar o próximo dialeto seja obrigado a decidir, em vez de herdar "emite ESC/POS"
     * por silêncio.
     */
    PROCOMP_ESC_P,
}

/**
 * Como esta impressora corta o papel.
 *
 * Separado do dialeto de propósito: a Bematech MP-4200 TH fala ESC/POS compatível para tudo o mais
 * — texto, alinhamento, raster — e **ignora o `GS V`**, que é justamente o comando de corte. Tratar
 * as duas coisas como uma só obrigaria a inventar um dialeto inteiro para uma diferença de dois
 * bytes, e faria o app deixar de mandar o que ela entende no resto.
 *
 * A descoberta é de papel, nunca de documentação: a `CutCommandProbe` imprime um bloco por
 * candidato e a impressora responde qual cortou. Foi assim com a página de código, e é assim aqui.
 */
enum class CutProtocol {
    /** `GS V 0`, corte total sem alimentação embutida. */
    GS_V_0,

    /** `GS V 1`, corte parcial sem alimentação embutida. */
    GS_V_1,

    /** `GS V 65 0x50`, corte total com a alimentação medida no próprio comando. */
    GS_V_65,

    /** `GS V 66 0x50`, corte parcial com a alimentação medida no próprio comando. */
    GS_V_66,

    /** `ESC i`, corte total no dialeto antigo. */
    ESC_I,

    /** `GS V` — o ESC/POS moderno. Elgin i9FULL 2. */
    @Deprecated("Use GS_V_1; este nome é preservado para manter o contrato produtivo M1.")
    GS_V,

    /** `ESC m` — o dialeto antigo que muita Bematech ainda atende. MP-4200 TH. */
    ESC_M,

    /** Sem guilhotina: avança até a serrilha e a pessoa rasga. */
    NONE,
}

/**
 * Como a tira se separa do rolo. É preferência de quem usa, não medição: a ficha costuma ser
 * melhor grudada e o cupom de venda solto, na mesma impressora e no mesmo dialeto.
 */
enum class CutMode {
    /** A tira sai solta do rolo. */
    TOTAL,

    /** A tira fica presa por um ponto; é o que mantém a ficha grudada. */
    PARTIAL,
}

/**
 * O modo embutido no comando medido. `NONE` não corta, então não tem modo.
 *
 * O enum mistura duas coisas que a bancada aprendeu separadas: o dialeto que a firmware atende
 * (`GS V`, `GS V 65/66`, `ESC i/m`) e o modo do corte. Só o dialeto é medível — o modo é escolha.
 */
val CutProtocol.cutMode: CutMode?
    get() =
        when (this) {
            CutProtocol.GS_V_0, CutProtocol.GS_V_65, CutProtocol.ESC_I -> CutMode.TOTAL
            @Suppress("DEPRECATION")
            CutProtocol.GS_V_1, CutProtocol.GS_V_66, CutProtocol.ESC_M, CutProtocol.GS_V ->
                CutMode.PARTIAL
            CutProtocol.NONE -> null
        }

/**
 * O irmão do mesmo dialeto no outro modo. É a peça que faltava: a homologação media dialeto e modo
 * juntos e gravava o que a sonda encontrasse primeiro — sempre um total, porque a ordem dos
 * candidatos começa neles. Com o irmão explícito, quem usa escolhe grudado ou solto sem
 * re-homologar e sem sair do dialeto que a impressora provou atender.
 */
fun CutProtocol.withCutMode(mode: CutMode): CutProtocol =
    when (this) {
        CutProtocol.NONE -> CutProtocol.NONE
        CutProtocol.GS_V_0, CutProtocol.GS_V_1 ->
            if (mode == CutMode.TOTAL) CutProtocol.GS_V_0 else CutProtocol.GS_V_1
        @Suppress("DEPRECATION")
        CutProtocol.GS_V -> if (mode == CutMode.TOTAL) CutProtocol.GS_V_0 else CutProtocol.GS_V_1
        CutProtocol.GS_V_65, CutProtocol.GS_V_66 ->
            if (mode == CutMode.TOTAL) CutProtocol.GS_V_65 else CutProtocol.GS_V_66
        CutProtocol.ESC_I, CutProtocol.ESC_M ->
            if (mode == CutMode.TOTAL) CutProtocol.ESC_I else CutProtocol.ESC_M
    }

enum class PrinterStatusProtocol {
    DLE_EOT,

    /** Firmware que não devolve status utilizável; papel e tampa ficam indetectáveis. */
    NONE,
}

/** Entradas do catálogo visual. A configuração de impressão é criada pela homologação local. */
/** O avanço que a Elgin i9 pede, e o ponto de partida de qualquer perfil novo. */
const val DEFAULT_CUT_FEED_LINES = 5

/**
 * Faixa aceita para o teto de vazão de raster, em bytes por segundo.
 *
 * O piso existe para que um teto digitado errado não transforme uma foto em espera de minutos; o
 * limite de cima é folga larga, acima de qualquer enlace que estas portáteis alcançam. Pública
 * porque quem oferece um campo para o valor precisa recusá-lo **antes** de montar um perfil que só
 * falharia na hora de salvar.
 */
val RASTER_BYTES_PER_SECOND_RANGE: IntRange = 256..1_000_000

object BundledPrinterDrivers {
    private val allTransports = PrinterTransport.entries.toSet()
    // O dialeto é escrito em cada card, e não herdado de um padrão. Os oito abaixo são ESC/POS
    // porque **saíram em papel** falando ESC/POS nesta bancada, e não porque o argumento foi
    // omitido: o `escpos` no id de cada um passou a ser afirmação verificável em vez de sufixo.
    val epsonTmT20xII =
        catalogEntry("epson.tmt20xii.escpos", "Epson TM-T20X-II", 80, EscPosDialect.EPSON_COMPATIBLE)
    val elginI9Full2 =
        catalogEntry("elgin.i9full2.escpos", "Elgin i9FULL 2", 80, EscPosDialect.EPSON_COMPATIBLE)
    val bematechMp4200Th =
        catalogEntry("bematech.mp4200th.escpos", "Bematech MP-4200 TH", 80, EscPosDialect.EPSON_COMPATIBLE)
    val portable58mm =
        catalogEntry("generic.portable58.escpos", "Portátil 58mm Bluetooth", 58, EscPosDialect.EPSON_COMPATIBLE)
    val goldenSkyGsT80cWf =
        catalogEntry("goldensky.gst80cwf.escpos", "GoldenSky GS-T80C-WF", 80, EscPosDialect.EPSON_COMPATIBLE)
    val tomateMdk082 =
        catalogEntry("tomate.mdk082.escpos", "Tomate MDK-082", 80, EscPosDialect.EPSON_COMPATIBLE)
    val inicoT210 =
        catalogEntry("inico.t210.escpos", "Inico T210", 58, EscPosDialect.EPSON_COMPATIBLE)
    val luogaoJk8002e =
        catalogEntry("luogao.jk8002e.escpos", "Luogao JK8002E", 80, EscPosDialect.EPSON_COMPATIBLE)

    /**
     * Diebold IM453H — híbrida de recibo e autenticação, e a **primeira entrada não-Epson** do
     * catálogo.
     *
     * Difere das outras em uma coisa só: o **dialeto `PROCOMP_ESC_P`**. Ela não fala ESC/POS, e
     * enquanto a composição do recibo não falar o dialeto dela, [EscPosDialectGate] recusa
     * imprimir. A entrada existe para que ela seja **encontrável e reconhecível**, não para que já
     * imprima.
     *
     * **Os quatro transportes continuam declarados, e isso é decisão.** A unidade da bancada expõe
     * só paralela e USB — o autoteste dela diz isso. Mas o card é rede de descoberta, não descrição
     * de hardware: outra unidade do mesmo modelo pode estar noutro barramento, e recortar aqui a
     * tornaria invisível. Qual interface **esta** impressora tem é fato do perfil medido, e é lá
     * que ele deve morar.
     *
     * As 48 colunas vêm do autoteste dela, e batem com a régua de 48 dígitos que saiu em uma linha
     * só. Os 576 dots são a convenção do catálogo para 80 mm e **não foram medidos nesta
     * impressora** — a área imprimível dela ainda não passou por régua. Como entrada de catálogo
     * não confia byte nenhum a este número, isso é aceitável aqui e está anotado em
     * `docs/diebold-im453h.md` como pendência para o perfil medido.
     */
    val dieboldIm453h =
        catalogEntry(
            id = "diebold.im453h.procomp",
            displayName = "Diebold IM453H",
            paperWidthMm = 80,
            dialect = EscPosDialect.PROCOMP_ESC_P,
        )

    val all: List<PrinterDriverProfile> =
        listOf(
            epsonTmT20xII,
            luogaoJk8002e,
            elginI9Full2,
            goldenSkyGsT80cWf,
            portable58mm,
            bematechMp4200Th,
            tomateMdk082,
            inicoT210,
            dieboldIm453h,
        )

    fun byId(id: String): PrinterDriverProfile? = all.firstOrNull { it.id == id }

    /**
     * Só sustenta descoberta e a grade de fotos. Nenhum byte específico de modelo é confiado a
     * esta entrada; a confirmação em papel cria um [MeasuredProfile] separado.
     *
     * @param dialect **sem padrão, de propósito.** Um card é a única coisa que responde a pergunta
     *   de dialeto no lugar da pessoa: quem escolhe "Diebold IM453H" na grade escolhe junto o
     *   `PROCOMP_ESC_P`, e nunca vê a pergunta. Um card novo que esquecesse o argumento nasceria
     *   ESC/POS em silêncio, e a primeira tira da medição dele levaria `ESC @` e `GS v 0` — a
     *   sequência que travou a IM453H em 23/08/2026. Com o padrão fora, esquecer não compila.
     */
    private fun catalogEntry(
        id: String,
        displayName: String,
        paperWidthMm: Int,
        dialect: EscPosDialect,
    ) =
        PrinterDriverProfile(
            id = id,
            revision = 1,
            displayName = displayName,
            transports = allTransports,
            printableColumns = if (paperWidthMm == 58) 32 else 48,
            printableDots = if (paperWidthMm == 58) 384 else 576,
            hasCutter = false,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            dialect = dialect,
            statusProtocol = PrinterStatusProtocol.NONE,
            network = PrinterNetworkProfile(tcpPort = 9_100),
            codePage = null,
            textEncoding = ThermalTextEncoding.ASCII,
        )
}
