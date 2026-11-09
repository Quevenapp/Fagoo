package br.com.thermalprinterkit

/**
 * Qual série de tiras a homologação envia, escolhida pelo **dialeto do alvo**.
 *
 * **Por que existe.** Até 26/08/2026 havia uma série só, e ela era ESC/POS de ponta a ponta. A
 * homologação não tinha como perguntar "que língua esta impressora fala?" — só como recusar quem
 * não falasse a única que existia. Com duas séries, a escolha precisa de um lugar, e este é o lugar:
 * um `when` exaustivo, sem `else`, do mesmo formato de [EscPosDialectGate]. **Dialeto novo não
 * compila até alguém responder aqui qual série ele recebe** — e não existe padrão razoável, porque
 * o padrão silencioso seria "manda ESC/POS", que é o defeito que travou a IM453H.
 *
 * **O que é comum e o que é próprio.** As duas séries medem as mesmas coisas, na mesma ordem, com
 * as mesmas réguas: quem lê uma tira de uma família reconhece a da outra. O que muda é o envelope
 * dos bytes — e, em duas etapas, se a tira **existe**. Ver [nativeCode] e [codePages].
 */
interface PrinterHomologationProbeSet {
    /** A tira que abre toda medição: as réguas de 58 e 80 mm lado a lado. */
    fun paperWidthRulers(): PrinterProbe

    /** A régua completa de colunas e de dots, para quem não reconheceu o papel na tira anterior. */
    fun fullGeometry(): PrinterProbe

    /** A tira de altura declarada que devolve o fator de compensação vertical. */
    fun rasterThroughput(printableDots: Int): PrinterProbe

    /**
     * A tira que mede se a firmware desenha QR e barras pelo comando nativo, ou `null` quando
     * **este dialeto não tem comando nativo medido**.
     *
     * `null` não é "esta impressora não sabe": é "não há tira honesta a mandar". A máquina pula a
     * etapa e grava os dois campos ausentes — a mesma ausência de
     * [PrinterHomologationMachine.skipNativeCodeMeasurement], que significa que ninguém mediu.
     */
    fun nativeCode(printableDots: Int): PrinterProbe?

    /**
     * Se esta série tem tira de código nativo. Verdadeiro exatamente quando [nativeCode] devolve
     * bytes.
     *
     * É uma pergunta separada porque a máquina precisa decidir **se entra na etapa** antes de haver
     * largura para montar a tira, e montar uma sonda só para descobrir que ela existe seria pagar um
     * raster para responder um booleano. As duas respostas não podem divergir, e é isso que
     * `SerieDeSondasPorDialetoTest` prende.
     */
    val measuresNativeCode: Boolean

    /**
     * Os comandos de corte que esta série coloca no papel, um por tira.
     *
     * A série ESC/POS manda seis porque a firmware é quem escolhe qual atende. Outra série pode
     * mandar um só; o que ela não pode é mandar zero e ainda assim declarar guilhotina.
     */
    val cutCandidates: List<CutProtocol>

    fun isolatedCut(protocol: CutProtocol): PrinterProbe

    fun cutFeedStrips(protocol: CutProtocol): List<CutFeedProbeStrip>

    fun cutFeed(protocol: CutProtocol): PrinterProbe

    /**
     * A tira de páginas de código, ou `null` quando o emissor deste dialeto **não consulta** a
     * página do perfil.
     *
     * Mesma regra do [nativeCode]: tira que produz resposta que ninguém emite é papel gasto para
     * decidir nada. A máquina pula a etapa e o perfil fica como a codificação daquele dialeto já é.
     */
    fun codePages(
        cutProtocol: CutProtocol,
        cutFeedLines: Int,
    ): PrinterProbe?

    /** Se esta série tem tira de página. Verdadeiro exatamente quando [codePages] devolve bytes. */
    val measuresCodePage: Boolean

    fun finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?,
        decoration: ReceiptDecoration?,
    ): PrinterProbe

    /** Tiras que saem em toda medição desta série, o comprovante final incluído. */
    val minimumStrips: Int

    /** O teto: com guilhotina, régua de avanço inteira e a régua completa de geometria. */
    val maximumStrips: Int
}

/**
 * A escolha, e o único lugar dela. Ver [PrinterHomologationProbeSet].
 */
fun printerHomologationProbeSet(dialect: EscPosDialect): PrinterHomologationProbeSet =
    when (dialect) {
        EscPosDialect.EPSON_COMPATIBLE -> EscPosHomologationProbeSet
        EscPosDialect.PROCOMP_ESC_P -> ProcompHomologationProbeSet
    }

/** A série de sempre, byte a byte igual à de antes desta interface existir. */
private object EscPosHomologationProbeSet : PrinterHomologationProbeSet {
    override fun paperWidthRulers(): PrinterProbe = PrinterHomologationProbes.paperWidthRulers()

    override fun fullGeometry(): PrinterProbe = PrinterHomologationProbes.fullGeometry()

    override fun rasterThroughput(printableDots: Int): PrinterProbe =
        PrinterHomologationProbes.rasterThroughput(printableDots)

    override fun nativeCode(printableDots: Int): PrinterProbe =
        PrinterHomologationProbes.nativeCode(printableDots)

    override val measuresNativeCode: Boolean
        get() = true

    /**
     * Todos os dialetos saem antes de qualquer pergunta.
     *
     * Parar no primeiro que corta economiza papel e esconde o que a impressora faz nos outros — foi
     * assim que a MP-4200 quase passou como "corta parcial e pronto", medido em 12/08.
     */
    override val cutCandidates: List<CutProtocol>
        get() =
            PrinterHomologationProbes.cutProtocolCandidates.mapNotNull { candidate ->
                candidate.protocol.takeIf { it != CutProtocol.NONE }
            }

    override fun isolatedCut(protocol: CutProtocol): PrinterProbe =
        PrinterHomologationProbes.isolatedCut(protocol)

    override fun cutFeedStrips(protocol: CutProtocol): List<CutFeedProbeStrip> =
        PrinterHomologationProbes.cutFeedStrips(protocol)

    override fun cutFeed(protocol: CutProtocol): PrinterProbe =
        PrinterHomologationProbes.cutFeed(protocol)

    override fun codePages(
        cutProtocol: CutProtocol,
        cutFeedLines: Int,
    ): PrinterProbe = PrinterHomologationProbes.codePages(cutProtocol, cutFeedLines)

    override val measuresCodePage: Boolean
        get() = true

    override fun finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?,
        decoration: ReceiptDecoration?,
    ): PrinterProbe =
        PrinterHomologationProbes.finalReceipt(profile, identity, transport, decoration)

    override val minimumStrips: Int
        get() = PrinterHomologationPaperCost.minimumStrips

    override val maximumStrips: Int
        get() = PrinterHomologationPaperCost.maximumStrips
}

/**
 * A série da Diebold Procomp. Ver [ProcompHomologationProbes] para o que cada tira mede.
 *
 * Duas etapas devolvem `null` aqui, e é medição: nesta firmware o comando nativo nunca saiu em
 * papel, e o emissor de texto não consulta a página do perfil.
 */
private object ProcompHomologationProbeSet : PrinterHomologationProbeSet {
    override fun paperWidthRulers(): PrinterProbe = ProcompHomologationProbes.paperWidthRulers()

    override fun fullGeometry(): PrinterProbe = ProcompHomologationProbes.fullGeometry()

    override fun rasterThroughput(printableDots: Int): PrinterProbe =
        ProcompHomologationProbes.rasterThroughput(printableDots)

    /** `ESC ( k` e `ESC | 0` existem no manual e nunca saíram em papel. Não há tira honesta. */
    override fun nativeCode(printableDots: Int): PrinterProbe? = null

    override val measuresNativeCode: Boolean
        get() = false

    /**
     * Um candidato só, e ele é o **lugar do corte no formato comum**, não uma medição desta unidade.
     *
     * [MeasuredProfile.hasCutter] é `cutProtocol != NONE`, e [CutProtocol] inteiro é ESC/POS: não há
     * valor que signifique `ESC w`. `GS_V_1` é o que mais perto chega do que a bancada viu — corte
     * parcial, sem avanço embutido, o que mantém a régua de avanço obrigatória —, e **nenhum byte
     * `GS` sai desta série**: quem emite é [procompFinish], sempre com `ESC w`. A folha final diz
     * isso em letra, para ninguém transcrever `GS_V_1` como se fosse medida — ver
     * [ProcompHomologationProbes.profileLines].
     */
    override val cutCandidates: List<CutProtocol>
        get() = listOf(CutProtocol.GS_V_1)

    override fun isolatedCut(protocol: CutProtocol): PrinterProbe =
        ProcompHomologationProbes.isolatedCut()

    override fun cutFeedStrips(protocol: CutProtocol): List<CutFeedProbeStrip> =
        ProcompHomologationProbes.cutFeedStrips()

    override fun cutFeed(protocol: CutProtocol): PrinterProbe = ProcompHomologationProbes.cutFeed()

    /** [procompText] codifica em ABICOMP e não lê a página do perfil. A resposta não teria uso. */
    override fun codePages(
        cutProtocol: CutProtocol,
        cutFeedLines: Int,
    ): PrinterProbe? = null

    override val measuresCodePage: Boolean
        get() = false

    override fun finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?,
        decoration: ReceiptDecoration?,
    ): PrinterProbe =
        ProcompHomologationProbes.finalReceipt(profile, identity, transport, decoration)

    /** Largura, vazão e comprovante final. Sem tira de código nativo e sem tira de página. */
    override val minimumStrips: Int
        get() =
            PrinterHomologationPaperCost.WIDTH_RULERS +
                PrinterHomologationPaperCost.RASTER_THROUGHPUT +
                PrinterHomologationPaperCost.FINAL_RECEIPT

    override val maximumStrips: Int
        get() =
            minimumStrips +
                PrinterHomologationPaperCost.FULL_GEOMETRY +
                cutCandidates.size +
                PrinterHomologationPaperCost.cutFeedStrips
}
