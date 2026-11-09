package br.com.thermalprinterkit

/**
 * O canal por onde as tiras de homologação saem, numa plataforma que não tem fachada de transporte
 * dentro do núcleo.
 *
 * **Por que ele existe.** [PrinterHomologationTarget] tem construtor `internal`, e o motivo é bom:
 * o alvo carrega o `sender` e o `adopter` da impressora que está sendo medida, e quem os monta
 * precisa ser quem já é dono do canal aberto. No Android quem monta é `LocalWifiThermalPrinter`,
 * que vive no núcleo; no Mac quem monta é o `ThermalPrinterConfiguration` do kit Swift. **O Printher
 * para Windows não tem nem um nem outro** — os transportes dele são `DesktopPrinterPort`, em
 * `jvm/transports/`, que o núcleo não enxerga e não pode enxergar sem arrastar a JVM de mesa para
 * dentro do AAR do Android.
 *
 * A saída é esta: o núcleo continua sendo o único lugar que **monta** o alvo, e a plataforma entrega
 * só o que ela sabe fazer — escrever bytes e, quando o meio permite, perguntar a identidade. A
 * invariante que o `internal` protege não é "ninguém de fora pode homologar"; é "quem monta o alvo
 * já é dono do canal". Quem implementa esta interface é dono do canal por construção.
 *
 * **O que ela deliberadamente não tem:** busca. Achar a impressora é da plataforma, e no Windows já
 * existe o gesto que pergunta o endereço. Uma varredura aqui seria a segunda verdade sobre onde a
 * impressora está.
 */
interface HomologationProbeChannel {
    /**
     * Escreve uma tira inteira e só volta quando a pilha local soltou tudo.
     *
     * **Falha é [ThermalPrintResult.Failed], e o [ThermalPrintDelivery] dela é o que separa repetir
     * de não repetir.** Quem implementa não pode devolver `NOT_SENT` depois do primeiro byte: a
     * homologação reimprime a tira em cima de `NOT_SENT`, e uma tira reimpressa por engano gasta
     * bobina e, pior, mede outra coisa.
     */
    suspend fun write(bytes: ByteArray): ThermalPrintResult

    /**
     * A identidade declarada pela firmware, quando este meio sabe perguntar.
     *
     * `null` é resposta legítima e quer dizer "este meio não lê de volta", não "a impressora não
     * respondeu". A homologação segue sem ela; o que se perde é só o nome sugerido.
     */
    suspend fun readIdentity(): PrinterDeclaredIdentity? = null
}

/**
 * Hospedeiro de homologação para uma impressora que a plataforma já sabe alcançar.
 *
 * É o que falta ao Printher para Windows para medir impressora em vez de só adotar a medição que
 * veio do telefone. A máquina, as sondas e o fluxo já atravessam para a JVM de mesa pela regra de
 * exclusão do `:core-jvm`; o que não atravessava era **o alvo**.
 *
 * ## O perfil que entra aqui é temporário, e isso é de propósito
 *
 * A homologação começa sem saber largura, página de código nem guilhotina — é o que ela existe para
 * descobrir. [MeasuredProfile.temporary] é o perfil conservador que sustenta as primeiras tiras, e
 * ele **nunca entra no store**: quem grava é o [adopt], no fim, com o perfil que a máquina montou.
 *
 * @property adopt o que fazer com a medição pronta. No Windows é gravar no cadastro **e** semear o
 *   cofre de instalações — sem a segunda metade a impressora aparece na lista sem transporte, que é
 *   exatamente o buraco que o C39 fechou pelo outro lado.
 */
class RemoteHomologationHost(
    override val profileStore: PrinterProfileStore,
    private val transport: PrinterTransport,
    private val displayName: String,
    private val paperWidthMm: Int,
    private val dialect: EscPosDialect,
    private val channel: HomologationProbeChannel,
    private val adopt: suspend (MeasuredProfile) -> Unit,
) : PrinterHomologationHost {

    /**
     * O perfil conservador desta sessão, montado uma vez — e **público porque quem abre o canal
     * precisa exatamente dele**.
     *
     * A porta de mesa é montada pela plataforma, e montar exige um perfil: largura, dialeto e teto
     * de vazão. Se a plataforma montasse o seu, existiriam duas verdades sobre a mesma sessão, e
     * elas divergiriam no dia em que uma das duas ganhasse um campo. Aqui há uma só.
     *
     * Uma segunda chamada a [openHomologationTarget] tem de devolver um alvo com o **mesmo**
     * `profileId`: a tela do kit recompõe, e um id novo a cada recomposição faria a máquina achar
     * que está medindo outra impressora no meio da medição.
     */
    val temporaryProfile: MeasuredProfile =
        temporaryProfileFor(transport, paperWidthMm, displayName, dialect)

    override suspend fun openHomologationTarget(
        transport: PrinterTransport?,
    ): PrinterHomologationTarget? {
        // Um transporte pedido que não é o desta impressora não é "nenhum alvo por enquanto": é
        // pergunta errada, e responder `null` a esconderia atrás de uma tela de "não encontrei".
        if (transport != null && transport != this.transport) return null
        return PrinterHomologationTarget(
            transport = this.transport,
            displayName = displayName,
            profileId = temporaryProfile.id,
            paperWidthMm = paperWidthMm,
            dialect = dialect,
            defaultStore = profileStore,
            sender = { bytes -> channel.write(bytes) },
            adopter = { profile -> adopt(profile) },
            identityReader = { channel.readIdentity() },
            // Tira é instrumento de medida e sai crua; o comprovante final é recibo. Nenhuma das
            // duas coisas leva decoração de mesa hoje — o Windows carimba na composição do cupom,
            // e um carimbo aqui deslocaria a régua que a tira existe para medir.
            receiptDecoration = null,
        )
    }

    companion object {
        /**
         * O mesmo perfil provisório, calculável **antes** de existir hospedeiro.
         *
         * Quem abre a porta de mesa precisa do perfil para montá-la, e o hospedeiro precisa do
         * canal para existir — um depende do outro. Sem esta função a plataforma montaria o seu
         * próprio perfil provisório, e passariam a existir duas verdades sobre a mesma sessão, que
         * divergiriam no dia em que uma das duas ganhasse um campo.
         */
        fun temporaryProfileFor(
            transport: PrinterTransport,
            paperWidthMm: Int,
            displayName: String,
            dialect: EscPosDialect,
        ): MeasuredProfile =
            MeasuredProfile.temporary(
                transport = transport,
                paperWidthMm = paperWidthMm,
                displayName = displayName,
                dialect = dialect,
            )
    }
}
