package br.com.thermalprinterkit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.Collections
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultLocalWifiPrinterDiscoveryTest {
    @Test
    fun `local Wi-Fi search never uses another network when Wi-Fi is unavailable`() = runTest {
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { null })

        assertEquals(
            LocalWifiPrinterDiscoveryResult.WifiUnavailable,
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.ROUTER_LAN),
        )
    }

    /**
     * Em Wi-Fi direto a impressora **é** o ponto de acesso, e portanto o gateway. Medido na
     * bancada: a GoldenSky no SSID "Printer" atende na 9100 do `10.10.100.254`, e a varredura —
     * que pula o gateway de propósito, para não sondar o roteador do estabelecimento — nunca
     * chegava nela. Uma sondagem, no gateway, em vez de 253 endereços.
     */
    @Test
    fun `em Wi-Fi direto a busca vai ao gateway e não varre a sub-rede`() = runTest {
        val network = RecordingLocalWifiNetwork(reachableHosts = setOf(1))
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })

        val result =
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.DIRECT_AP)

        assertTrue(result is LocalWifiPrinterDiscoveryResult.Candidates)
        assertEquals(listOf("192.168.31.1"), network.hosts.toList())
    }

    @Test
    fun `a varredura da rede do local continua pulando o gateway`() = runTest {
        val network = RecordingLocalWifiNetwork(reachableHosts = setOf(44))
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })

        finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.ROUTER_LAN)

        assertFalse(network.hosts.contains("192.168.31.1"))
    }

    @Test
    fun `local Wi-Fi search stays within the directly connected private subnet`() = runTest {
        val network = RecordingLocalWifiNetwork(reachableHosts = setOf(44))
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })

        val result = finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.ROUTER_LAN)

        assertTrue(result is LocalWifiPrinterDiscoveryResult.Candidates)
        assertTrue(network.hosts.contains("192.168.31.44"))
        assertTrue(network.hosts.all { it.startsWith("192.168.31.") })
        assertFalse(network.hosts.contains("192.168.31.1"))
        assertFalse(network.hosts.contains("192.168.31.42"))
        assertFalse(network.hosts.any { it.startsWith("10.") || it.startsWith("172.") })
    }

    @Test
    fun `network loss during a local Wi-Fi search is not reinterpreted as a printer miss`() = runTest {
        val network = RecordingLocalWifiNetwork(reachableHosts = setOf(44), available = false)
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })

        assertEquals(
            LocalWifiPrinterDiscoveryResult.WifiUnavailable,
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.ROUTER_LAN),
        )
        assertTrue(network.hosts.isEmpty())
    }

    @Test
    fun `a rejected open TCP port is skipped on the next Wi-Fi search`() = runTest {
        val network = RecordingLocalWifiNetwork(reachableHosts = setOf(3, 44))
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })

        val first =
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.ROUTER_LAN) as
                LocalWifiPrinterDiscoveryResult.Candidates
        val rejected = first.endpoints.first { it.socketAddress().hostString == "192.168.31.3" }
        finder.reject(network, rejected)
        network.hosts.clear()
        val second =
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.ROUTER_LAN) as
                LocalWifiPrinterDiscoveryResult.Candidates

        assertEquals(
            listOf("192.168.31.3", "192.168.31.44"),
            first.endpoints.map { endpoint -> endpoint.socketAddress().hostString },
        )
        assertEquals(
            listOf("192.168.31.44"),
            second.endpoints.map { endpoint -> endpoint.socketAddress().hostString },
        )
        assertFalse(network.hosts.contains("192.168.31.3"))
    }

    /**
     * Zero pacote e varredura inteira saíam pelo mesmo `NotFound`.
     *
     * Em Wi-Fi direto a busca vai só ao gateway, porque a impressora **é** o ponto de acesso. Num
     * AP isolado que não publica rota, `gatewayEndpoints` devolve lista vazia: nada sai da máquina
     * e a pessoa lia "Confira se a impressora está ligada e conectada ao mesmo roteador Wi-Fi" —
     * conselho que não tem como funcionar, porque ninguém tentou falar com ela.
     */
    @Test
    fun `sem gateway conhecido o Wi-Fi direto diz que nao teve alvo`() = runTest {
        val network = RecordingLocalWifiNetwork(reachableHosts = emptySet(), gateways = emptyList())
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })

        val result =
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.DIRECT_AP)

        assertTrue("nenhum pacote pode sair: ${network.hosts}", network.hosts.isEmpty())
        assertEquals(
            LocalWifiPrinterDiscoveryResult.NaoEncontrada(CausaDaBuscaWifiVazia.SemGatewayNoDireto),
            result,
        )
    }

    /**
     * A varredura que aconteceu inteira é a única saída vazia em que houve pacote na rede — e a
     * única em que "confira se ela está ligada e no mesmo roteador" é a frase certa. Ela não pode
     * ser igual à busca que nem chegou a sondar.
     */
    @Test
    fun `varredura completa sem resposta e distinta de busca sem alvo`() = runTest {
        val varreu = RecordingLocalWifiNetwork(reachableHosts = emptySet())
        val naoVarreu = RecordingLocalWifiNetwork(reachableHosts = emptySet(), gateways = emptyList())
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { varreu })
        val finderSemAlvo = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { naoVarreu })

        val completa =
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.ROUTER_LAN)
        val semAlvo =
            finderSemAlvo.findCandidates(
                BundledPrinterDrivers.elginI9Full2,
                PrinterNetworkAttachment.DIRECT_AP,
            )

        // 254 endereços na /24, menos o telefone e menos o gateway.
        assertEquals(
            LocalWifiPrinterDiscoveryResult.NaoEncontrada(CausaDaBuscaWifiVazia.NinguemRespondeu(252)),
            completa,
        )
        assertEquals(252, varreu.hosts.size)
        // O outro lado da distinção, e ele é o que importa: zero pacote saiu no direto sem
        // gateway, então a causa não pode ser "sondei e ninguém respondeu".
        assertEquals(
            LocalWifiPrinterDiscoveryResult.NaoEncontrada(CausaDaBuscaWifiVazia.SemGatewayNoDireto),
            semAlvo,
        )
        assertEquals(emptyList<String>(), naoVarreu.hosts)
    }

    /**
     * Numa /30 sobram dois hosts, e os dois podem cair no telefone e no gateway. O construtor
     * aceita o prefixo, a varredura nasce vazia, e nenhum pacote sai — outra vez o mesmo silêncio
     * que dizia "confira o roteador".
     */
    @Test
    fun `sub-rede sem host livre nao vira impressora desligada`() = runTest {
        // Rede .4/30: hosts utilizáveis .5 e .6. O telefone fica no .6 e o gateway no .5, e não
        // sobra endereço nenhum para sondar.
        val network =
            RecordingLocalWifiNetwork(
                reachableHosts = emptySet(),
                hostAddress = byteArrayOf(192.toByte(), 168.toByte(), 31, 6),
                prefixLength = 30,
                gateways = listOf(byteArrayOf(192.toByte(), 168.toByte(), 31, 5)),
            )
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })

        val result =
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.ROUTER_LAN)

        assertTrue("nenhum pacote pode sair: ${network.hosts}", network.hosts.isEmpty())
        assertEquals(
            LocalWifiPrinterDiscoveryResult.NaoEncontrada(CausaDaBuscaWifiVazia.SubRedeSemHostLivre),
            result,
        )
    }

    /**
     * Perfil que não fala Wi-Fi era estouro, não resultado.
     *
     * `discoveryCandidates` faz `requireNotNull(profile.tcpPort)`, e o `IllegalArgumentException`
     * subia por `withContext(Dispatchers.IO)` e saía da função suspensa de quem chamou. Perfil
     * medido só-Bluetooth tem `tcpPort` nulo por invariante do próprio `PrinterDriverProfile`.
     */
    @Test
    fun `perfil sem porta TCP e recusado antes de qualquer socket`() = runTest {
        val network = RecordingLocalWifiNetwork(reachableHosts = emptySet())
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })

        val result = finder.findCandidates(soBluetooth, PrinterNetworkAttachment.ROUTER_LAN)

        assertTrue(network.hosts.isEmpty())
        assertEquals(
            LocalWifiPrinterDiscoveryResult.NaoEncontrada(CausaDaBuscaWifiVazia.ModeloNaoFalaWifi),
            result,
        )
    }

    /** Alvo já recusado nesta Wi-Fi não vira "ninguém respondeu": ninguém foi perguntado. */
    @Test
    fun `todos os alvos ja recusados nao viram varredura sem resposta`() = runTest {
        val network = RecordingLocalWifiNetwork(reachableHosts = setOf(1), gateways = listOf(gateway))
        val finder = DefaultLocalWifiPrinterDiscovery(LocalWifiNetworkProvider { network })
        val primeira =
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.DIRECT_AP)
                as LocalWifiPrinterDiscoveryResult.Candidates
        finder.reject(network, primeira.endpoints.single())
        network.hosts.clear()

        val segunda =
            finder.findCandidates(BundledPrinterDrivers.elginI9Full2, PrinterNetworkAttachment.DIRECT_AP)

        assertTrue("nenhum pacote pode sair: ${network.hosts}", network.hosts.isEmpty())
        assertEquals(
            LocalWifiPrinterDiscoveryResult.NaoEncontrada(CausaDaBuscaWifiVazia.TodosJaRecusados(1)),
            segunda,
        )
    }

    private val gateway = byteArrayOf(192.toByte(), 168.toByte(), 31, 1)

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

    private class RecordingLocalWifiNetwork(
        private val reachableHosts: Set<Int> = setOf(44),
        var available: Boolean = true,
        hostAddress: ByteArray = byteArrayOf(192.toByte(), 168.toByte(), 31, 42),
        prefixLength: Int = 24,
        gateways: List<ByteArray> = listOf(byteArrayOf(192.toByte(), 168.toByte(), 31, 1)),
    ) : LocalWifiNetwork {
        override val subnet =
            LocalWifiSubnet(
                hostAddress = hostAddress,
                prefixLength = prefixLength,
                excludedGatewayAddresses = gateways,
            )
        override val selectionKey = LocalWifiNetworkSelectionKey(networkHandle = 91, subnet = subnet)
        val hosts = Collections.synchronizedList(mutableListOf<String>())

        override fun openSocket(): Socket =
            object : Socket() {
                override fun connect(endpoint: SocketAddress?, timeout: Int) {
                    check(available) { "Não deve criar socket após a Wi-Fi sair." }
                    val address = (endpoint as InetSocketAddress).hostString
                    hosts += address
                    if (address.removePrefix("192.168.31.").toIntOrNull() !in reachableHosts) {
                        throw ConnectException("not found")
                    }
                }

                override fun getInputStream() = ByteArrayInputStream(ByteArray(0))

                override fun getOutputStream() = ByteArrayOutputStream()

                override fun setSoTimeout(timeout: Int) = Unit

                override fun setTcpNoDelay(on: Boolean) = Unit

                override fun close() = Unit
            }

        override fun stillAvailable(): Boolean = available
    }
}
