package br.com.thermalprinterkit

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Impressora térmica local já confirmada neste aparelho. Cupom e segredo nunca são persistidos;
 * identidade física pertence à instalação criptografada, nunca ao perfil de capacidades.
 */
interface ThermalPrinter {
    val state: StateFlow<ThermalPrinterState>

    /**
     * Impressoras já confirmadas neste aparelho. Pode haver várias no mesmo transporte; só a
     * instalação ativa recebe os cupons.
     */
    val adoptedPrinters: StateFlow<List<AdoptedPrinter>>
        get() = MutableStateFlow(emptyList())

    /** Compatibilidade: ativa a primeira impressora confirmada deste transporte. */
    suspend fun activatePrinter(transport: PrinterTransport) = Unit

    /** Seleciona uma instalação específica, inclusive quando há várias no mesmo transporte. */
    suspend fun activateInstalledPrinter(profileId: String)

    /**
     * Ativa uma unidade específica.
     *
     * Prefira este a [activateInstalledPrinter]: com duas unidades do mesmo modelo instaladas, o
     * perfil não distingue qual delas recebe o cupom.
     */
    suspend fun activateInstallation(installationId: String) = Unit

    /**
     * Compatibilidade: remove as impressoras confirmadas deste transporte.
     */
    suspend fun removePrinter(transport: PrinterTransport) = Unit

    /** Exclui somente a instalação escolhida, sem atingir outras USB/Bluetooth/Wi-Fi. */
    suspend fun removeInstalledPrinter(profileId: String)

    /** Remove uma unidade específica, sem levar junto as irmãs que compartilham o perfil. */
    suspend fun removeInstallation(installationId: String) = Unit

    /**
     * Readota as impressoras já confirmadas neste aparelho, depois de o app ser reaberto.
     *
     * É suspensa e explícita de propósito: reencontrar uma impressora Bluetooth LE exige uma
     * varredura de vários segundos, e fazer isso no construtor travaria a thread de quem cria a
     * instância. Chame uma vez, de dentro de uma corrotina, na inicialização.
     */
    suspend fun restore() = Unit

    /**
     * Readota **uma** unidade, sem tocar nas outras e sem mudar qual delas está ativa.
     *
     * Existe para quem precisa imprimir num processo que não é a tela do app — no Android, o print
     * service do sistema e a API de terceiros. Nesses processos [restore] é caro demais e caro pelo
     * motivo errado: ele reabre **todas** as adotadas, inclusive uma varredura Bluetooth LE de
     * vários segundos por uma impressora que aquele trabalho não vai usar.
     *
     * Diferente de [activateInstallation], não escreve no store e não troca a ativa: restaurar é
     * reabrir o transporte de quem já foi escolhido, não escolher. Instalação desconhecida não faz
     * nada — quem chama decide o que dizer, porque a frase é do app.
     */
    suspend fun restoreInstallation(installationId: String) = Unit

    /** Lista impressoras USB conectadas por cabo ou hub com canal de dados. */
    suspend fun searchUsb(profileId: String): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.UsbUnavailable.message,
            state = ThermalPrinterState.UsbUnavailable,
        )

    /**
     * Abre a candidata USB para **diagnóstico**, sem imprimir nada.
     *
     * Existe por uma conta de bobina medida em 23/08/2026. O comando cru — a ferramenta que serve
     * justamente para quem está travado — só tinha alvo depois de [testSearchedUsbPrinter], que
     * imprime um comprovante inteiro. Numa tarde de sondas isso significou um cupom por tentativa,
     * e numa impressora de dialeto desconhecido significou um cupom **ilegível** por tentativa.
     * Quem precisa de diagnóstico é exatamente quem ainda não consegue imprimir direito.
     *
     * **Isto não é adoção, e não substitui o comprovante.** O vínculo é efêmero, vale só para esta
     * sessão, e a confirmação humana em papel continua sendo a única porta para
     * [confirmSearchedPrinter]. O que muda é que **olhar** deixou de custar papel.
     *
     * Devolve `false` quando a candidata não existe na busca atual.
     */
    suspend fun bindSearchedUsbPrinter(candidateId: Long): Boolean = false

    /** Solicita a permissão Android e envia um único comprovante de teste. */
    suspend fun testSearchedUsbPrinter(candidateId: Long): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.UsbUnavailable.message,
            state = ThermalPrinterState.UsbUnavailable,
        )

    /** Lista impressoras Bluetooth já pareadas pela pessoa nos ajustes do aparelho. */
    suspend fun searchBluetooth(profileId: String): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.BluetoothUnavailable.message,
            state = ThermalPrinterState.BluetoothUnavailable,
        )

    /** Abre o canal SPP e envia um único comprovante de teste. */
    suspend fun testSearchedBluetoothPrinter(candidateId: Long): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.BluetoothUnavailable.message,
            state = ThermalPrinterState.BluetoothUnavailable,
        )

    /**
     * Varre o ambiente por impressoras Bluetooth LE. Diferente do SPP, elas não pareiam: são
     * encontradas pelo anúncio a cada busca.
     */
    suspend fun searchBluetoothLe(profileId: String): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.BluetoothUnavailable.message,
            state = ThermalPrinterState.BluetoothUnavailable,
        )

    /** Abre o canal GATT e envia um único comprovante de teste. */
    suspend fun testSearchedBluetoothLePrinter(candidateId: Long): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.BluetoothUnavailable.message,
            state = ThermalPrinterState.BluetoothUnavailable,
        )

    /**
     * Procura possíveis impressoras compatíveis com o modelo já escolhido.
     *
     * Em [PrinterNetworkAttachment.DIRECT_AP] o celular está associado ao ponto de acesso da
     * própria impressora: ela é o gateway, e a busca vai direto nele em vez de varrer a sub-rede.
     */
    suspend fun searchLocalWifi(
        profileId: String,
        attachment: PrinterNetworkAttachment = PrinterNetworkAttachment.ROUTER_LAN,
    ): ThermalPrintResult

    /** Envia um único cupom de teste para uma candidata mostrada pela busca atual. */
    suspend fun testSearchedLocalWifiPrinter(candidateId: Long): ThermalPrintResult

    /**
     * Testa um endereço informado conscientemente pela pessoa. A implementação aceita apenas
     * IPv4 literal dentro da mesma rede Wi-Fi atual e uma porta autorizada pelo perfil escolhido.
     */
    suspend fun testLocalWifiAddress(
        profileId: String,
        address: String,
        port: Int,
    ): ThermalPrintResult

    /** Confirma em memória que o cupom de teste saiu fisicamente na impressora escolhida. */
    suspend fun confirmSearchedPrinter()

    /** Descarta a candidata quando o comprovante de teste não saiu. */
    suspend fun discardSearchedPrinter()

    /**
     * Volta à lista da mesma busca sem esquecer a candidata testada.
     *
     * “Não saiu” pode significar papel, tampa, permissão ou cabo momentâneo. A pessoa precisa poder
     * escolher novamente entre os aparelhos já encontrados; uma nova varredura fica como ação
     * explícita, não como requisito para sair do diálogo.
     */
    suspend fun returnToSearchedPrinters(transport: PrinterTransport) = discardSearchedPrinter()

    /** Testa uma impressora adotada sem trocar qual delas recebe as senhas. */
    suspend fun testPrinter(transport: PrinterTransport): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.PrinterNotSelected.message,
            state = ThermalPrinterState.PrinterNotSelected,
        )

    /**
     * Testa **uma unidade instalada**, e não "uma impressora daquele meio físico".
     *
     * [testPrinter] mira o transporte, e transporte deixou de identificar impressora no dia em que
     * duas passaram a caber no mesmo meio físico: ele alcança a unidade que está conectada — a
     * ativa — e o comprovante sai numa impressora que ninguém pediu. Medido no iPhone 7 em 20/08,
     * com duas portáteis instaladas, e o caminho do Android é o mesmo.
     *
     * Testar não escolhe: a ativa continua sendo quem era, e a conexão em memória dela é
     * restaurada depois. Unidade inalcançável recusa **sem enviar byte nenhum** — cair na ativa
     * seria o próprio defeito com outra roupa. Instalação desconhecida também recusa.
     */
    suspend fun testInstallation(installationId: String): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.PrinterNotSelected.message,
            state = ThermalPrinterState.PrinterNotSelected,
        )

    /** Envia um novo comprovante de teste para a impressora que recebe as senhas. */
    suspend fun testSelectedPrinter(): ThermalPrintResult =
        ThermalPrintResult.Failed(
            message = ThermalPrinterState.PrinterNotSelected.message,
            state = ThermalPrinterState.PrinterNotSelected,
        )

    /**
     * Imprime um cupom já montado.
     *
     * O que se imprime é decidido fora deste pacote: cupons e relatórios conhecem seus dados, mas
     * nenhum deles pertence à camada de impressão.
     * Ver [ThermalReceiptPayload].
     */
    suspend fun print(payload: ThermalReceiptPayload): ThermalPrintResult
}

/** Candidata efêmera da busca atual; o IP serve apenas para a escolha visual da pessoa. */
data class LocalWifiPrinterCandidate(
    val id: Long,
    val label: String,
    val ipAddress: String,
) {
    init {
        require(id > 0) { "Identificador de candidata inválido." }
        require(label.isNotBlank()) { "Rótulo de candidata inválido." }
        require(LocalWifiPrinterEndpoint.isPrivateIpv4Literal(ipAddress)) {
            "IP de candidata inválido."
        }
    }

    override fun toString(): String = "LocalWifiPrinterCandidate(id=$id)"
}

/** Impressora confirmada e o meio pelo qual ela é alcançada. Nenhum endereço é exposto. */
data class AdoptedPrinter(
    val transport: PrinterTransport,
    val displayName: String,
    val active: Boolean,
    /** Aviso visível quando o resolvedor precisou recompor um perfil conservador e efêmero. */
    val warning: String? = null,
    /** Identifica somente o perfil escolhido; nunca contém endereço ou identidade do aparelho. */
    val profileId: String? = null,
    /**
     * Identifica esta **unidade**, e não o modelo dela.
     *
     * Duas impressoras iguais no mesmo balcão são duas instalações e têm ids diferentes aqui. O
     * valor é perfil mais um resumo truncado da identidade física — nunca o endereço, que não sai
     * do store cifrado.
     */
    val installationId: String? = null,
) {
    val transportLabel: String
        get() =
            when (transport) {
                PrinterTransport.LOCAL_WIFI -> "Wi-Fi"
                PrinterTransport.USB -> "USB"
                PrinterTransport.BLUETOOTH -> "Bluetooth"
                PrinterTransport.BLUETOOTH_LE -> "Bluetooth LE"
            }
}

/** Candidata Bluetooth efêmera; nenhum MAC, nome de fábrica ou serial é exposto. */
enum class BluetoothCandidateOrigin {
    SPP,
    BLE,
}

data class BluetoothPrinterCandidate(
    val id: Long,
    val label: String,
    val origin: BluetoothCandidateOrigin = BluetoothCandidateOrigin.SPP,
    /**
     * O aparelho se identificou, ou o rótulo é numeração nossa?
     *
     * Medido na bancada: das 28 candidatas encontradas num ambiente comum, só três tinham nome — e
     * eram exatamente as impressoras. Quem não se identifica vai para o fim da lista.
     */
    val named: Boolean = true,
) {
    init {
        require(id > 0) { "Identificador de candidata Bluetooth inválido." }
        require(label.isNotBlank()) { "Rótulo de candidata Bluetooth inválido." }
    }
}

/** Candidata USB efêmera; nenhum serial, VID, PID ou caminho técnico é exposto. */
data class UsbPrinterCandidate(
    val id: Long,
    val label: String,
    /**
     * O que o descritor USB do aparelho sugere sobre a língua dele, ou `null`.
     *
     * Chega até aqui para que a tela possa **contradizer** uma resposta, e só isso: ver
     * [DialetoNoBalcao.avisoDeDescritorContrariado]. O descritor confirma e não nega — ele nunca
     * vale `EPSON_COMPATIBLE`, porque "não se anunciou Diebold" não é medição de coisa nenhuma.
     */
    val dialectSuspicion: EscPosDialect? = null,
) {
    init {
        require(id > 0) { "Identificador de candidata USB inválido." }
        require(label.isNotBlank()) { "Rótulo de candidata USB inválido." }
    }
}

sealed interface ThermalPrinterState {
    val title: String
    val message: String

    data object PrinterNotSelected : ThermalPrinterState {
        override val title = "Escolha a impressora"
        override val message = "Escolha o modelo e procure uma impressora na rede Wi-Fi local."
    }

    data object Connecting : ThermalPrinterState {
        override val title = "Conectando à impressora"
        override val message = "Verificando a conexão da impressora selecionada."
    }

    data object LocalWifiSearching : ThermalPrinterState {
        override val title = "Procurando na rede Wi-Fi"
        override val message = "Procurando possíveis impressoras na rede Wi-Fi local conectada a este aparelho."
    }

    data object UsbSearching : ThermalPrinterState {
        override val title = "Procurando impressora USB"
        override val message = "Conecte a impressora por cabo ou hub USB com dados."
    }

    data class UsbCandidatesFound(
        val candidates: List<UsbPrinterCandidate>,
    ) : ThermalPrinterState {
        init {
            require(candidates.isNotEmpty()) { "A lista USB não pode estar vazia." }
        }

        override val title = "Escolha a impressora USB"
        override val message = foundMessage(candidates.size, "USB compatível", "USB compatíveis")

        override fun toString(): String = "UsbCandidatesFound(count=${candidates.size})"
    }

    data object BluetoothSearching : ThermalPrinterState {
        override val title = "Procurando impressora Bluetooth"
        override val message = "Ligue a impressora e confira se ela já está pareada neste aparelho."
    }

    data class BluetoothCandidatesFound(
        val candidates: List<BluetoothPrinterCandidate>,
    ) : ThermalPrinterState {
        init {
            require(candidates.isNotEmpty()) { "A lista Bluetooth não pode estar vazia." }
        }

        override val title = "Escolha a impressora Bluetooth"
        override val message = foundMessage(candidates.size, "Bluetooth pareada", "Bluetooth pareadas")

        override fun toString(): String = "BluetoothCandidatesFound(count=${candidates.size})"
    }

    data class LocalWifiCandidatesFound(
        val candidates: List<LocalWifiPrinterCandidate>,
    ) : ThermalPrinterState {
        init {
            require(candidates.isNotEmpty()) { "A lista de candidatas não pode estar vazia." }
        }

        override val title = "Escolha a impressora"
        override val message = foundMessage(candidates.size, "possível", "possíveis")

        override fun toString(): String = "LocalWifiCandidatesFound(count=${candidates.size})"
    }

    data object Ready : ThermalPrinterState {
        override val title = "Impressora pronta"
        override val message = "A impressora selecionada está pronta para receber envios."
    }

    data object SearchConfirmationRequired : ThermalPrinterState {
        override val title = "Confirme o comprovante"
        override val message = "Confirme se o cupom de teste saiu antes de selecionar esta impressora."
    }

    data object Printing : ThermalPrinterState {
        override val title = "Imprimindo"
        override val message = "Aguarde o término da impressão."
    }

    data object LocalWifiUnavailable : ThermalPrinterState {
        override val title = "Wi-Fi local não disponível"
        override val message = "Conecte este aparelho a uma rede Wi-Fi privada, sem VPN, e tente novamente."
    }

    data object LocalWifiPrinterUnavailable : ThermalPrinterState {
        override val title = "Impressora não encontrada no Wi-Fi"
        override val message = "Confira se a impressora está ligada e conectada ao mesmo roteador Wi-Fi."
    }

    data object LocalWifiAddressInvalid : ThermalPrinterState {
        override val title = "Endereço não disponível"
        override val message = "Informe o IP e a porta compatível da impressora nesta rede Wi-Fi local."
    }

    data object UsbPermissionDenied : ThermalPrinterState {
        override val title = "Acesso USB não permitido"
        override val message = "Autorize o acesso à impressora USB para enviar o comprovante de teste."
    }

    data object UsbUnavailable : ThermalPrinterState {
        override val title = "Impressora USB não disponível"
        override val message = "Confira o cabo, o hub de dados e se a impressora está ligada."
    }

    data object BluetoothPermissionDenied : ThermalPrinterState {
        override val title = "Acesso Bluetooth não permitido"
        override val message = "Autorize o acesso a dispositivos Bluetooth para usar a impressora pareada."
    }

    data object BluetoothUnavailable : ThermalPrinterState {
        override val title = "Impressora Bluetooth não disponível"
        override val message =
            "Ligue o Bluetooth e a impressora, e confira se ela já está pareada neste aparelho."
    }

    data object BluetoothLeUnavailableByHostPolicy : ThermalPrinterState {
        override val title = "Busca Bluetooth LE indisponível"
        override val message =
            "Este app não oferece busca Bluetooth LE nesta versão do sistema. Use Wi-Fi, USB ou uma impressora já pareada."
    }

    data object PaperOut : ThermalPrinterState {
        override val title = "Sem papel"
        override val message = "Coloque papel na i9FULL 2 e feche a tampa."
    }

    data object CoverOpen : ThermalPrinterState {
        override val title = "Tampa aberta"
        override val message = "Feche a tampa da i9FULL 2 e tente novamente."
    }

    /**
     * A impressora escolhida fala um dialeto que este app ainda não emite.
     *
     * Recusar é o comportamento correto, e não uma limitação a contornar: mandar ESC/POS a uma
     * firmware que não o entende já travou uma impressora na bancada a ponto de a tecla física de
     * avanço parar de responder. Ver [EscPosDialectGate].
     */
    data object DialectNotSupported : ThermalPrinterState {
        override val title = "Impressora incompatível"
        override val message =
            "Esta impressora usa um conjunto de comandos que este app ainda não sabe emitir. " +
                "Nada foi enviado a ela."
    }

    data class Failed(
        override val message: String,
    ) : ThermalPrinterState {
        override val title = "Não foi possível imprimir"

        override fun toString(): String = "Failed(message=$message)"
    }
}

sealed interface ThermalPrintResult {
    data object Printed : ThermalPrintResult

    data class Failed(
        val message: String,
        val state: ThermalPrinterState,
        val delivery: ThermalPrintDelivery = ThermalPrintDelivery.NOT_SENT,
        /**
         * Por que a busca voltou vazia, quando foi uma busca e quem a fez sabe distinguir.
         *
         * É **campo**, e não um membro novo de [ThermalPrinterState], por uma restrição de
         * compilação que vale a pena registrar: `ThermalPrinterState` é interface selada e a tela
         * do app hospedeiro faz um `when` exaustivo sobre ela, como expressão e sem `else`. Um
         * estado novo aqui quebraria a compilação de um módulo que não é deste arquivo. O campo com
         * padrão `null` mantém todo chamador compilando e deixa a distinção verificável pelo
         * compilador de quem quiser lê-la.
         *
         * `null` não quer dizer "sem causa": quer dizer que este resultado não é de busca, ou que a
         * porta usada não distingue. Ver [CausaDaBuscaVazia].
         */
        val causa: CausaDaBuscaVazia? = null,
    ) : ThermalPrintResult {
        override fun toString(): String =
            "Failed(message=$message, state=${state::class.simpleName}, delivery=$delivery, " +
                "causa=${causa?.javaClass?.simpleName})"
    }
}

/**
 * TCP confirma a escrita no socket, não a saída física do cupom. Uma falha depois do início
 * da escrita exige confirmação antes de repetir, para não entregar dois comprovantes iguais.
 */
enum class ThermalPrintDelivery {
    NOT_SENT,
    INDETERMINATE,
}

/**
 * "1 impressora encontrada" e não "1 impressoras encontradas". O caso de uma impressora só é o
 * mais comum numa festa, então a concordância errada apareceria quase sempre.
 */
private fun foundMessage(
    count: Int,
    singular: String,
    plural: String,
): String =
    if (count == 1) {
        "1 impressora $singular encontrada. Toque nela para testar."
    } else {
        "Foram encontradas $count impressoras $plural. Escolha uma para testar."
    }
