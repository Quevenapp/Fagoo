package br.com.thermalprinterkit

/**
 * Por que a busca terminou sem impressora nenhuma.
 *
 * "Não achei nada" e "não pude procurar" chegavam ao balcão como a mesma frase — e a ação de quem
 * está lá é diferente em cada caso: ligar o rádio, autorizar o app, abrir os Ajustes e parear,
 * aproximar a impressora, ou levá-la para a mesma rede. A busca vazia era o único resultado, então
 * a frase era única, e as cinco causas do SPP viravam "Ligue o Bluetooth e a impressora, e confira
 * se ela já está pareada" mesmo quando o Bluetooth já estava ligado.
 *
 * A distinção é **de tipo**, não de string: quem decide o texto é a tela do app hospedeiro, e ela
 * precisa poder decidir com o compilador do lado dela. O kit só se compromete a dizer qual foi.
 *
 * **O que nenhum teste desta suíte alcança**: qual causa o aparelho real produz. A JVM de teste não
 * tem `android.bluetooth` — instanciar [AndroidBluetoothThermalPort] devolveria "Stub!" — então o
 * que se prova aqui é a decisão a partir dos fatos, e nas portas se prova que os fatos são lidos e
 * repassados. Que `adapter.isEnabled` seja mesmo falso com o rádio desligado é contrato do Android,
 * não medição nossa.
 */
sealed interface CausaDaBuscaVazia

/**
 * Por que a lista de **pareadas** (SPP) saiu vazia.
 *
 * Cinco silêncios diferentes saíam por um `emptyList()` só em `AndroidBluetoothThermalPort.discover`:
 * perfil sem o transporte, aparelho sem rádio, rádio desligado, nenhuma pareada, e pareadas que não
 * anunciam serviço de impressão. Só a permissão era distinguida, e por exceção.
 */
sealed interface CausaDaBuscaPareadaVazia : CausaDaBuscaVazia {
    /**
     * Quem produziu o resultado não sabe distinguir.
     *
     * É o que devolve a implementação padrão de [BluetoothThermalPort.buscarPareadas], que só tem
     * a lista de [BluetoothThermalPort.discover] para olhar. Não é "causa desconhecida do rádio":
     * é "esta porta não responde a esta pergunta".
     */
    data object NaoInformada : CausaDaBuscaPareadaVazia

    /** O app hospedeiro não montou porta Bluetooth nenhuma neste kit. Erro de montagem, não de balcão. */
    data object KitSemPortaBluetooth : CausaDaBuscaPareadaVazia

    /** O perfil escolhido não declara o transporte: procurar por aqui não encontraria nada. */
    data object ModeloNaoFalaBluetooth : CausaDaBuscaPareadaVazia

    /** Não existe rádio Bluetooth neste aparelho — nada que a pessoa faça no balcão resolve. */
    data object SemRadioNoAparelho : CausaDaBuscaPareadaVazia

    /** O rádio existe e está desligado. A ação é ligar o Bluetooth, e só ela. */
    data object RadioDesligado : CausaDaBuscaPareadaVazia

    /** Falta `BLUETOOTH_CONNECT`. A ação é autorizar, e mandar parear de novo não adianta. */
    data object PermissaoDeConexaoNegada : CausaDaBuscaPareadaVazia

    /** O rádio respondeu e não há nenhum aparelho pareado. A ação é parear nos Ajustes. */
    data object NenhumaPareada : CausaDaBuscaPareadaVazia

    /**
     * Há pareadas, e nenhuma anuncia impressão.
     *
     * É o caso do fone e da caixa de som pareados: o Bluetooth está ligado, a permissão está dada,
     * a lista dos Ajustes não está vazia — e ainda assim não há impressora. Mandar "parear de novo"
     * aqui é mandar repetir o que já foi feito.
     */
    data class PareadasSemServicoDeImpressao(
        val pareadas: Int,
    ) : CausaDaBuscaPareadaVazia {
        init {
            require(pareadas > 0) { "Sem nenhuma pareada a causa é NenhumaPareada." }
        }
    }
}

/** Por que a **varredura BLE** terminou sem anunciante. */
sealed interface CausaDaVarreduraLeVazia : CausaDaBuscaVazia {
    /** Ver [CausaDaBuscaPareadaVazia.NaoInformada]: a porta não responde a esta pergunta. */
    data object NaoInformada : CausaDaVarreduraLeVazia

    data object KitSemPortaBluetooth : CausaDaVarreduraLeVazia

    data object ModeloNaoFalaBluetoothLe : CausaDaVarreduraLeVazia

    /** O app hospedeiro proíbe a varredura nesta versão do sistema. Ver [BluetoothLeScanPolicy]. */
    data object BloqueadaPeloHospedeiro : CausaDaVarreduraLeVazia

    data object SemRadioNoAparelho : CausaDaVarreduraLeVazia

    data object RadioDesligado : CausaDaVarreduraLeVazia

    /** Falta `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` a partir do Android 12. */
    data object PermissaoDeVarreduraNegada : CausaDaVarreduraLeVazia

    /**
     * O rádio está ligado, autorizado, e mesmo assim não entrega um varredor LE.
     *
     * `adapter.bluetoothLeScanner` devolvia `null` e a busca saía como lista vazia — o mesmo
     * silêncio de "varri seis segundos e ninguém anunciou". Não é a mesma coisa: aqui não saiu um
     * pacote sequer do rádio.
     */
    data object SemVarredorNoAparelho : CausaDaVarreduraLeVazia

    /**
     * A varredura aconteceu inteira e ninguém anunciou.
     *
     * Esta é a única causa em que o rádio realmente trabalhou. A ação é aproximar a impressora e
     * conferir se ela está ligada — que é justamente a frase errada para todas as outras.
     */
    data class NinguemAnunciou(
        val millisDeVarredura: Long,
    ) : CausaDaVarreduraLeVazia {
        init {
            require(millisDeVarredura >= 0) { "Duração de varredura inválida." }
        }
    }
}

/** Por que a busca na Wi-Fi local terminou sem candidata. */
sealed interface CausaDaBuscaWifiVazia : CausaDaBuscaVazia {
    /** Ver [CausaDaBuscaPareadaVazia.NaoInformada]. */
    data object NaoInformada : CausaDaBuscaWifiVazia

    /**
     * O perfil não fala Wi-Fi, então não há porta TCP para sondar.
     *
     * Antes isto não era resultado, era exceção: `LocalWifiSubnet.discoveryCandidates` faz
     * `requireNotNull(profile.tcpPort)`, e o `IllegalArgumentException` subia por `withContext` e
     * saía da função suspensa. Perfil medido só-Bluetooth tem `tcpPort` nulo por invariante do
     * próprio [PrinterDriverProfile], então o caso é alcançável por quem homologa.
     */
    data object ModeloNaoFalaWifi : CausaDaBuscaWifiVazia

    /**
     * Wi-Fi direto e nenhum gateway conhecido: não há para onde mandar a única sondagem.
     *
     * Em Wi-Fi direto a impressora **é** o ponto de acesso, e a busca vai só ao gateway. Num AP
     * isolado que não publica rota, `gatewayEndpoints` devolve lista vazia e zero pacote sai da
     * máquina — o que é o oposto de "sondei e ela não respondeu".
     */
    data object SemGatewayNoDireto : CausaDaBuscaWifiVazia

    /**
     * A sub-rede não sobrou host nenhum para sondar.
     *
     * O construtor aceita de /24 a /30. Numa /30 sobram dois hosts, e os dois podem cair no
     * telefone e no gateway — daí a varredura nasce vazia sem ter varrido coisa alguma.
     */
    data object SubRedeSemHostLivre : CausaDaBuscaWifiVazia

    /** Todos os alvos já tinham sido recusados nesta mesma Wi-Fi; nenhum pacote novo saiu. */
    data class TodosJaRecusados(
        val recusados: Int,
    ) : CausaDaBuscaWifiVazia {
        init {
            require(recusados > 0) { "Sem alvo recusado esta não é a causa." }
        }
    }

    /**
     * A varredura aconteceu inteira e ninguém atendeu na porta.
     *
     * A única causa Wi-Fi em que houve pacote na rede. [sondados] diz quantos — 1 em Wi-Fi direto,
     * até 253 na rede do local.
     */
    data class NinguemRespondeu(
        val sondados: Int,
    ) : CausaDaBuscaWifiVazia {
        init {
            require(sondados > 0) { "Sem alvo sondado a causa é a que explica a lista vazia de alvos." }
        }
    }
}

/**
 * Decide, **só a partir dos fatos**, por que a lista de pareadas saiu vazia; `null` quando há
 * impressora para mostrar.
 *
 * Vive fora da porta pelo mesmo motivo de [SppOciosidade] e de [LocalWifiNetworkEligibility]: é
 * política, e política precisa ser exercida sem rádio nenhum. A porta Android lê os fatos do
 * adaptador e chama isto; a JVM de teste chama isto direto.
 *
 * A ordem das perguntas é a ordem em que uma resposta torna as seguintes impossíveis de responder.
 * Com o rádio desligado não se lê `bondedDevices`, então "nenhuma pareada" seria mentira; sem
 * permissão a lista vem vazia por recusa, não por ausência. Por isso o impedimento sempre vence o
 * silêncio que ele mesmo causou.
 */
internal fun causaDaBuscaPareadaVazia(
    modeloFalaBluetooth: Boolean,
    radioPresente: Boolean,
    radioLigado: Boolean,
    temPermissaoDeConexao: Boolean,
    pareadas: Int,
    comServicoDeImpressao: Int,
): CausaDaBuscaPareadaVazia? {
    require(pareadas >= 0 && comServicoDeImpressao in 0..pareadas) {
        "Contagem de pareadas incoerente."
    }
    return when {
        !modeloFalaBluetooth -> CausaDaBuscaPareadaVazia.ModeloNaoFalaBluetooth
        !radioPresente -> CausaDaBuscaPareadaVazia.SemRadioNoAparelho
        !radioLigado -> CausaDaBuscaPareadaVazia.RadioDesligado
        !temPermissaoDeConexao -> CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada
        pareadas == 0 -> CausaDaBuscaPareadaVazia.NenhumaPareada
        comServicoDeImpressao == 0 ->
            CausaDaBuscaPareadaVazia.PareadasSemServicoDeImpressao(pareadas)
        else -> null
    }
}

/**
 * O que impede a varredura BLE de sequer começar; `null` quando o rádio pode varrer.
 *
 * Separada do resultado da varredura de propósito: antes e depois de varrer são fatos diferentes, e
 * misturá-los foi exatamente o defeito. `canScan()` devolvia um `false` só para "rádio desligado" e
 * "permissão faltando", e os dois chamadores traduziam esse `false` para `BluetoothPermissionDenied`
 * — quem estava com o Bluetooth desligado era mandado autorizar uma permissão que já tinha.
 */
internal fun impedimentoDaVarreduraLe(
    modeloFalaBluetoothLe: Boolean,
    hospedeiroPermiteVarrer: Boolean,
    radioPresente: Boolean,
    radioLigado: Boolean,
    temPermissaoDeVarredura: Boolean,
    varredorPresente: Boolean,
): CausaDaVarreduraLeVazia? =
    when {
        !modeloFalaBluetoothLe -> CausaDaVarreduraLeVazia.ModeloNaoFalaBluetoothLe
        !hospedeiroPermiteVarrer -> CausaDaVarreduraLeVazia.BloqueadaPeloHospedeiro
        !radioPresente -> CausaDaVarreduraLeVazia.SemRadioNoAparelho
        !radioLigado -> CausaDaVarreduraLeVazia.RadioDesligado
        !temPermissaoDeVarredura -> CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada
        !varredorPresente -> CausaDaVarreduraLeVazia.SemVarredorNoAparelho
        else -> null
    }

/**
 * Qual falha técnica de porta corresponde a um impedimento de varredura; `null` quando o impedimento
 * não é motivo para lançar.
 *
 * Existe para que o conserto seja verificável: rádio desligado sai como [ThermalPortFailure.BluetoothUnavailable]
 * ("Ligue o Bluetooth e a impressora") e **não** como [ThermalPortFailure.BluetoothPermissionDenied]
 * ("Autorize o acesso"), que era o que a pessoa lia.
 */
internal fun falhaDaVarreduraLe(causa: CausaDaVarreduraLeVazia): ThermalPortFailure? =
    when (causa) {
        CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada ->
            ThermalPortFailure.BluetoothPermissionDenied
        CausaDaVarreduraLeVazia.RadioDesligado,
        CausaDaVarreduraLeVazia.SemRadioNoAparelho,
        -> ThermalPortFailure.BluetoothUnavailable
        // Modelo sem o transporte, varredor ausente, política do hospedeiro e "ninguém anunciou"
        // não são falha de canal: a busca simplesmente não tem o que devolver.
        else -> null
    }

/**
 * Qual [ThermalPrinterState] a busca vazia publica; a tradução que **faltava** no caminho novo.
 *
 * Antes desta rodada só havia um caminho para permissão negada: a porta lançava e os três
 * chamadores traduziam a exceção dentro de `catch (ThermalPortException)`. Ao passar as portas
 * Android para [ResultadoDaBuscaPareada]/[ResultadoDaVarreduraLe], esse `catch` virou código morto
 * para a porta real — [AndroidBluetoothThermalPort.buscarPareadas] e [AndroidBleThermalPort.varrer]
 * devolvem `Vazia(PermissaoDe…Negada)` e não lançam mais — e as saídas `Vazia` caíam todas em
 * [ThermalPrinterState.BluetoothUnavailable]. Medido em 04/09/2026 com um dublê que reproduz o
 * retorno novo da porta Android: os três pontos de entrada publicavam "Ligue o Bluetooth" para quem
 * precisava autorizar, que é o defeito original invertido.
 *
 * Fica aqui, e não nos chamadores, porque é a mesma decisão nos três — e porque assim a tabela
 * inteira é exercível sem rádio nenhum.
 */
internal fun estadoDaBuscaVazia(causa: CausaDaBuscaVazia?): ThermalPrinterState =
    when (causa) {
        CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada,
        CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada,
        -> ThermalPrinterState.BluetoothPermissionDenied
        CausaDaVarreduraLeVazia.BloqueadaPeloHospedeiro ->
            ThermalPrinterState.BluetoothLeUnavailableByHostPolicy
        // Todas as outras pedem "ligue o Bluetooth e a impressora": rádio ausente, rádio
        // desligado, nada pareado, pareadas sem impressão, ninguém anunciou. A frase é a mesma; a
        // distinção entre elas viaja no campo `causa`, que é o que a tela lê.
        else -> ThermalPrinterState.BluetoothUnavailable
    }
