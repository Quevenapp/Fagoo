package br.com.thermalprinterkit

import java.net.Socket
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A busca vazia chega ao balcão dizendo **qual** vazio foi.
 *
 * Todas estas provas passam pela fachada que o app hospedeiro usa, e não pelas funções de decisão:
 * o que estava quebrado não era a política, era o caminho — as causas existiam como fatos no
 * aparelho e morriam num `emptyList()` antes de chegar a qualquer lugar que a tela leia.
 *
 * Nenhum **estado novo** foi criado nesta rodada, e isso é decisão registrada: o estado publicado
 * segue `BluetoothUnavailable`/`LocalWifiPrinterUnavailable` porque a tela de `:printher` faz um
 * `when` exaustivo sobre `ThermalPrinterState`, como expressão e sem `else`, e um estado novo
 * quebraria a compilação de um módulo que não é deste diretório. A distinção fina viaja no campo
 * tipado, verificável pelo compilador de quem for escrever a frase.
 *
 * O que **mudou** de texto é a permissão negada, e mudou duas vezes: ao passar as portas Android
 * para resultado tipado, o `catch (ThermalPortException)` dos três pontos de entrada virou código
 * morto para a porta real, e "Autorize o acesso" virou "Ligue o Bluetooth" — o defeito original de
 * cabeça para baixo. `estadoDaBuscaVazia` desfaz isso, e são as provas com `…PermissaoNegadaSem…`
 * no nome que a medem: elas dirigem portas que **devolvem** `Vazia(Permissao…)`, que é como a porta
 * Android se comporta hoje, e não portas que lançam.
 */
class BuscaVaziaNoBalcaoTest {
    private val profile = BundledPrinterDrivers.portable58mm

    /**
     * As duas causas mais comuns do balcão, e as mais opostas em ação: uma pede ligar o rádio, a
     * outra pede parear a impressora certa entre fones e caixas de som já pareados. Antes deste
     * campo os dois resultados eram objetos **iguais** — mesma mensagem, mesmo estado, mesma
     * entrega — e nenhuma tela poderia tê-los separado por mais cuidado que tivesse.
     */
    @Test
    fun `duas buscas SPP vazias por motivos diferentes nao chegam iguais`() = runTest {
        val radioDesligado =
            printer(bluetooth = PortaPareadaFixa(CausaDaBuscaPareadaVazia.RadioDesligado))
                .searchBluetooth(profile.id)
        val soFonesPareados =
            printer(
                bluetooth =
                    PortaPareadaFixa(CausaDaBuscaPareadaVazia.PareadasSemServicoDeImpressao(3)),
            ).searchBluetooth(profile.id)

        assertNotEquals(radioDesligado, soFonesPareados)
        assertEquals(
            CausaDaBuscaPareadaVazia.RadioDesligado,
            (radioDesligado as ThermalPrintResult.Failed).causa,
        )
        assertEquals(
            CausaDaBuscaPareadaVazia.PareadasSemServicoDeImpressao(3),
            (soFonesPareados as ThermalPrintResult.Failed).causa,
        )
        // O estado publicado é o mesmo de propósito; ver o cabeçalho desta classe.
        assertSame(ThermalPrinterState.BluetoothUnavailable, radioDesligado.state)
        assertSame(ThermalPrinterState.BluetoothUnavailable, soFonesPareados.state)
    }

    /**
     * Permissão negada, vinda como **resultado** e não como exceção, ainda manda autorizar.
     *
     * Esta é a forma que a porta Android tem hoje: [AndroidBluetoothThermalPort.buscarPareadas] lê
     * `hasConnectPermission()` antes de tocar em `bondedDevices` e devolve
     * `Vazia(PermissaoDeConexaoNegada)`. Nenhuma prova desta suíte dirigia uma porta assim — todas
     * as que mediam permissão usavam dublês que **lançam**, que é a forma antiga —, e por isso o
     * build ficou verde enquanto o balcão lia "Ligue o Bluetooth e a impressora" com o rádio ligado
     * e a autorização pendente.
     *
     * A tela de `:printher` decide o aviso de acesso parcial comparando o estado com
     * `BluetoothPermissionDenied`; é o `assertSame` daqui que fixa isso.
     */
    @Test
    fun `permissao negada sem excecao no SPP ainda pede autorizacao`() = runTest {
        val resultado =
            printer(
                bluetooth =
                    PortaPareadaFixa(CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada),
            ).searchBluetooth(profile.id) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.BluetoothPermissionDenied, resultado.state)
        assertNotEquals(ThermalPrinterState.BluetoothUnavailable, resultado.state)
        assertEquals(CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada, resultado.causa)
    }

    /** O irmão BLE do de cima: `AndroidBleThermalPort.varrer` também devolve em vez de lançar. */
    @Test
    fun `permissao negada sem excecao no BLE ainda pede autorizacao`() = runTest {
        val resultado =
            printer(ble = PortaLeFixa(CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada))
                .searchBluetoothLe(profile.id) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.BluetoothPermissionDenied, resultado.state)
        assertEquals(CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada, resultado.causa)
    }

    /**
     * Na busca unificada, os dois campos que a tela lê para o aviso de acesso parcial.
     *
     * `ThermalPrinterScreen` decide o aviso por `finished.pairedFailure == BluetoothPermissionDenied`
     * e `finished.bleFailure == …`. Com as portas devolvendo `Vazia(Permissao…)` os dois campos
     * saíam `BluetoothUnavailable` e a comparação nunca mais era verdadeira — sem nada ficar
     * vermelho, porque os dublês da suíte lançavam.
     */
    @Test
    fun `permissao negada sem excecao aparece nos dois campos da busca unificada`() = runTest {
        val printer =
            printer(
                bluetooth =
                    PortaPareadaFixa(CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada),
                ble = PortaLeFixa(CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada),
            )

        val resultado =
            printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true)
                as ThermalPrintResult.Failed
        val finished = printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Finished

        assertSame(ThermalPrinterState.BluetoothPermissionDenied, finished.pairedFailure)
        assertSame(ThermalPrinterState.BluetoothPermissionDenied, finished.bleFailure)
        assertSame(ThermalPrinterState.BluetoothPermissionDenied, resultado.state)
    }

    /**
     * A causa do SPP não é jogada fora quando o BLE cai no mesmo objeto de estado.
     *
     * O resultado único escolhia o estado primeiro e só depois perguntava de qual lado ele veio,
     * com `failure === bleFailure`. `BluetoothUnavailable` é `data object`: com o SPP dizendo
     * `NenhumaPareada` e o BLE caindo no mesmo objeto por outro motivo, a identidade respondia "veio
     * do BLE" e a causa publicada era `null` — que pelo contrato do campo significa "esta porta não
     * distingue". O resultado afirmava não saber o que sabia.
     */
    @Test
    fun `com as duas metades vazias a causa do SPP sobrevive ao lado do BLE`() = runTest {
        val printer =
            printer(
                bluetooth = PortaPareadaFixa(CausaDaBuscaPareadaVazia.NenhumaPareada),
                ble = PortaLeQueLanca(ThermalPortFailure.BluetoothDisconnected),
            )

        val resultado =
            printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true)
                as ThermalPrintResult.Failed

        assertEquals(CausaDaBuscaPareadaVazia.NenhumaPareada, resultado.causa)
        assertNotEquals(null, resultado.causa)
    }

    /** O mesmo, com a metade BLE ausente por erro de montagem: a causa acionável é a do SPP. */
    @Test
    fun `kit sem porta BLE nao apaga a causa do SPP`() = runTest {
        val printer =
            printer(
                bluetooth =
                    PortaPareadaFixa(
                        CausaDaBuscaPareadaVazia.PareadasSemServicoDeImpressao(3),
                    ),
            )

        val resultado =
            printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true)
                as ThermalPrintResult.Failed

        assertEquals(
            CausaDaBuscaPareadaVazia.PareadasSemServicoDeImpressao(3),
            resultado.causa,
        )
    }

    /**
     * A exceção da porta BLE virava exceção de quem chamou.
     *
     * `searchBluetooth` sempre teve o `try/catch` que traduz a falha da porta em estado — e até o
     * comentário explicando por quê. Na irmã `searchBluetoothLe` a chamada estava **nua**: a
     * exceção atravessava `withContext`, atravessava `mutex.withLock` e saía da função suspensa.
     *
     * **O que esta prova cobre hoje**: as portas de integração que ainda lançam, e só elas. A porta
     * Android não passa mais por este caminho — ver as duas provas de `…PermissaoNegadaSem…` acima,
     * que medem a forma que ela realmente produz. Enquanto esta era a única prova de permissão no
     * BLE, ela dava sensação de cobertura sobre um ramo que a produção tinha deixado de percorrer.
     */
    @Test
    fun `porta BLE que lanca vira resultado e nao excecao`() = runTest {
        val resultado =
            printer(ble = PortaLeQueLanca(ThermalPortFailure.BluetoothPermissionDenied))
                .searchBluetoothLe(profile.id)

        val falhou = resultado as ThermalPrintResult.Failed
        assertSame(ThermalPrinterState.BluetoothPermissionDenied, falhou.state)
        assertEquals(CausaDaVarreduraLeVazia.PermissaoDeVarreduraNegada, falhou.causa)
    }

    /**
     * Rádio desligado e permissão negada pedem ações opostas, e chegavam iguais.
     *
     * **O que esta prova não alcança**: que o aparelho real produza `RadioDesligado`. A leitura do
     * adaptador mora em [AndroidBleThermalPort] e `BluetoothAdapter` responde "Stub!" na JVM de
     * teste. O que se prova aqui é que a causa, uma vez produzida, chega ao resultado sem virar
     * "autorize o acesso" pelo caminho — que era exatamente onde ela virava.
     */
    @Test
    fun `radio desligado no BLE nao pede permissao ao balcao`() = runTest {
        val resultado =
            printer(ble = PortaLeFixa(CausaDaVarreduraLeVazia.RadioDesligado))
                .searchBluetoothLe(profile.id)

        val falhou = resultado as ThermalPrintResult.Failed
        assertNotEquals(ThermalPrinterState.BluetoothPermissionDenied, falhou.state)
        assertSame(ThermalPrinterState.BluetoothUnavailable, falhou.state)
        assertEquals(CausaDaVarreduraLeVazia.RadioDesligado, falhou.causa)
    }

    /**
     * "Varri seis segundos e ninguém anunciou" é a única saída vazia do BLE em que o rádio
     * trabalhou, e a única em que "aproxime a impressora e confira se ela está ligada" é a frase
     * certa. Ela saía igual a "o adaptador não me deu um varredor".
     */
    @Test
    fun `varredura completa sem anuncio e distinta de varredor ausente`() = runTest {
        val ninguem =
            printer(ble = PortaLeFixa(CausaDaVarreduraLeVazia.NinguemAnunciou(6_000)))
                .searchBluetoothLe(profile.id) as ThermalPrintResult.Failed
        val semVarredor =
            printer(ble = PortaLeFixa(CausaDaVarreduraLeVazia.SemVarredorNoAparelho))
                .searchBluetoothLe(profile.id) as ThermalPrintResult.Failed

        assertNotEquals(ninguem, semVarredor)
        assertEquals(CausaDaVarreduraLeVazia.NinguemAnunciou(6_000), ninguem.causa)
    }

    /**
     * Perfil medido só-Bluetooth não estoura mais a busca Wi-Fi.
     *
     * `PrinterDriverProfile` garante `(LOCAL_WIFI in transports) == (network != null)`, logo um
     * perfil desses tem `tcpPort` nulo — e `LocalWifiSubnet.discoveryCandidates` faz
     * `requireNotNull(profile.tcpPort)`. O `IllegalArgumentException` subia por
     * `withContext(Dispatchers.IO)` e saía da função suspensa: não era frase errada, era estouro.
     * Nenhum perfil de [BundledPrinterDrivers] cai nisso — todos declaram os quatro transportes —
     * mas perfil medido e perfil importado caem.
     */
    @Test
    fun `perfil so-bluetooth recusa a busca Wi-Fi em vez de estourar`() = runTest {
        val rede = RedeDeTeste()
        val printer =
            LocalWifiThermalPrinter(
                port = PortaWifiSilenciosa(),
                discovery = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { rede }),
                networkProvider = LocalWifiNetworkProvider { rede },
                driverProfiles = listOf(soBluetooth),
            )

        val resultado = printer.searchLocalWifi(soBluetooth.id) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.LocalWifiPrinterUnavailable, resultado.state)
        assertEquals(CausaDaBuscaWifiVazia.ModeloNaoFalaWifi, resultado.causa)
        assertTrue("nenhum pacote pode ter saído: ${rede.sondados}", rede.sondados.isEmpty())
    }

    /** A busca unificada publica as duas causas separadas, uma por lado. */
    @Test
    fun `a busca unificada publica a causa de cada lado`() = runTest {
        val printer =
            printer(
                bluetooth = PortaPareadaFixa(CausaDaBuscaPareadaVazia.NenhumaPareada),
                ble = PortaLeFixa(CausaDaVarreduraLeVazia.NinguemAnunciou(6_000)),
            )

        printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true)

        val finished = printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Finished
        assertEquals(CausaDaBuscaPareadaVazia.NenhumaPareada, finished.pairedCausa)
        assertEquals(CausaDaVarreduraLeVazia.NinguemAnunciou(6_000), finished.bleCausa)
    }

    /**
     * Porta que não sabe distinguir continua correta, e diz isso.
     *
     * As dez portas-dublê desta suíte e as integrações que só sabem listar caem na implementação
     * padrão de [BluetoothThermalPort.buscarPareadas]. Elas não podem passar a mentir uma causa que
     * não mediram — `NaoInformada` é a resposta honesta, e é distinta de todas as outras.
     */
    @Test
    fun `porta que so sabe listar responde NaoInformada`() = runTest {
        val resultado =
            printer(bluetooth = PortaPareadaMuda()).searchBluetooth(profile.id)
                as ThermalPrintResult.Failed

        assertEquals(CausaDaBuscaPareadaVazia.NaoInformada, resultado.causa)
        assertNotEquals(
            CausaDaBuscaPareadaVazia.NenhumaPareada as CausaDaBuscaVazia,
            resultado.causa,
        )
    }

    private fun printer(
        bluetooth: BluetoothThermalPort? = null,
        ble: BleThermalPort? = null,
    ): LocalWifiThermalPrinter =
        LocalWifiThermalPrinter(
            port = PortaWifiSilenciosa(),
            bluetoothPort = bluetooth,
            blePort = ble,
            discovery = LocalWifiPrinterDiscovery { _, _ -> LocalWifiPrinterDiscoveryResult.NotFound },
            networkProvider = LocalWifiNetworkProvider { RedeDeTeste() },
        )

    private val soBluetooth =
        PrinterDriverProfile(
            id = "medido.portatil.sobluetooth",
            revision = 1,
            displayName = "Portátil medida só-Bluetooth",
            transports = setOf(PrinterTransport.BLUETOOTH),
            printableColumns = 32,
            printableDots = 384,
            hasCutter = false,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
            statusProtocol = PrinterStatusProtocol.NONE,
            network = null,
            codePage = null,
            textEncoding = ThermalTextEncoding.ASCII,
        )

    /** Devolve sempre a mesma causa; nenhum rádio é consultado. */
    private class PortaPareadaFixa(
        private val causa: CausaDaBuscaPareadaVazia,
    ) : BluetoothThermalPort {
        override fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle> =
            emptyList()

        override fun buscarPareadas(profile: PrinterDriverProfile): ResultadoDaBuscaPareada =
            ResultadoDaBuscaPareada.Vazia(causa)

        override suspend fun open(handle: BluetoothPrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun drain() = Unit

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.UNKNOWN

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.UNKNOWN
    }

    /** Só lista, como as portas antigas: a causa tem de sair da implementação padrão. */
    private class PortaPareadaMuda : BluetoothThermalPort {
        override fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle> =
            emptyList()

        override suspend fun open(handle: BluetoothPrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun drain() = Unit

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.UNKNOWN

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.UNKNOWN
    }

    private class PortaLeFixa(
        private val causa: CausaDaVarreduraLeVazia,
    ) : BleThermalPort {
        override suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle> =
            emptyList()

        override suspend fun varrer(
            profile: PrinterDriverProfile,
            onDiscovered: (BlePrinterHandle) -> Unit,
        ): ResultadoDaVarreduraLe = ResultadoDaVarreduraLe.Vazia(causa)

        override suspend fun open(handle: BlePrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit
    }

    /**
     * Porta antiga que lança: não sobrescreve `varrer`, então a exceção sobe pela implementação
     * padrão exatamente como subia da porta real.
     */
    private class PortaLeQueLanca(
        private val falha: ThermalPortFailure,
    ) : BleThermalPort {
        override suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle> =
            throw ThermalPortException(falha)

        override suspend fun open(handle: BlePrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit
    }

    private class PortaWifiSilenciosa : LocalWifiThermalPort {
        override fun open(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
            profile: PrinterDriverProfile,
        ) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.UNKNOWN

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.UNKNOWN
    }

    /** Registra qualquer socket aberto, para que "nenhum pacote saiu" seja afirmação e não fé. */
    private class RedeDeTeste : LocalWifiNetwork {
        override val subnet =
            LocalWifiSubnet(
                hostAddress = byteArrayOf(192.toByte(), 168.toByte(), 31, 42),
                prefixLength = 24,
                excludedGatewayAddresses = listOf(byteArrayOf(192.toByte(), 168.toByte(), 31, 1)),
            )
        override val selectionKey = LocalWifiNetworkSelectionKey(networkHandle = 77, subnet = subnet)
        val sondados = mutableListOf<String>()

        override fun openSocket(): Socket {
            sondados += "socket"
            error("Nenhuma sondagem deveria acontecer neste teste.")
        }

        override fun stillAvailable(): Boolean = true
    }
}
