package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalWifiPrinterEndpointTest {
    @Test
    fun `private direct subnet excludes phone gateway network and broadcast`() {
        val subnet =
            LocalWifiSubnet(
                hostAddress = ipv4(192, 168, 31, 42),
                prefixLength = 24,
                excludedGatewayAddresses = listOf(ipv4(192, 168, 31, 1)),
            )

        val hosts = subnet.discoveryCandidates(port = 9_100).map(::host)

        assertEquals(252, hosts.size)
        assertFalse("192.168.31.0" in hosts)
        assertFalse("192.168.31.255" in hosts)
        assertFalse("192.168.31.1" in hosts)
        assertFalse("192.168.31.42" in hosts)
        assertTrue(hosts.all { it.startsWith("192.168.31.") })
    }

    @Test
    fun `only a generated host on the recognized printer port is accepted as a Wi-Fi target`() {
        val subnet =
            LocalWifiSubnet(
                hostAddress = ipv4(192, 168, 31, 42),
                prefixLength = 24,
                excludedGatewayAddresses = listOf(ipv4(192, 168, 31, 1)),
            )

        assertFalse(subnet.isDiscoveryCandidate(LocalWifiPrinterEndpoint(ipv4(192, 168, 31, 0), 9_100)))
        assertFalse(subnet.isDiscoveryCandidate(LocalWifiPrinterEndpoint(ipv4(192, 168, 31, 255), 9_100)))
        assertFalse(subnet.isDiscoveryCandidate(LocalWifiPrinterEndpoint(ipv4(192, 168, 31, 1), 9_100)))
        assertFalse(subnet.isDiscoveryCandidate(LocalWifiPrinterEndpoint(ipv4(192, 168, 31, 42), 9_100)))
        assertFalse(
            subnet.isDiscoveryCandidate(
                LocalWifiPrinterEndpoint(ipv4(192, 168, 31, 88), 9_101),
                BundledPrinterDrivers.elginI9Full2,
            ),
        )
        assertTrue(
            subnet.isDiscoveryCandidate(
                LocalWifiPrinterEndpoint(ipv4(192, 168, 31, 88), 9_100),
                BundledPrinterDrivers.elginI9Full2,
            ),
        )
    }

    /**
     * Medido na bancada: com o celular associado ao AP da própria impressora — SSID "Printer",
     * `10.10.100.0/24` —, a GoldenSky **é** o gateway `.254`, com a 9100 aberta. A varredura não
     * bate no gateway de propósito, para não sondar o roteador do estabelecimento; mas isso é
     * economia de sondagem, e vetar o endereço que a pessoa digitou é outra coisa. A tela recusava
     * o endereço certo como inválido.
     */
    @Test
    fun `o gateway fica fora da varredura e continua aceito quando alguém digita`() {
        val subnet =
            LocalWifiSubnet(
                hostAddress = ipv4(10, 10, 100, 150),
                prefixLength = 24,
                excludedGatewayAddresses = listOf(ipv4(10, 10, 100, 254)),
            )
        val impressoraNoGateway = LocalWifiPrinterEndpoint(ipv4(10, 10, 100, 254), 9_100)

        assertFalse(subnet.isDiscoveryCandidate(impressoraNoGateway))
        assertTrue(subnet.isSelectableEndpoint(impressoraNoGateway))

        // O que não é host continua fora dos dois caminhos, inclusive o próprio telefone.
        listOf(
            LocalWifiPrinterEndpoint(ipv4(10, 10, 100, 0), 9_100),
            LocalWifiPrinterEndpoint(ipv4(10, 10, 100, 255), 9_100),
            LocalWifiPrinterEndpoint(ipv4(10, 10, 100, 150), 9_100),
        ).forEach { endpoint ->
            assertFalse(subnet.isSelectableEndpoint(endpoint))
            assertFalse(subnet.isDiscoveryCandidate(endpoint))
        }
    }

    @Test
    fun `even the largest accepted Wi-Fi subnet has at most 253 candidates`() {
        val subnet = LocalWifiSubnet(ipv4(10, 24, 8, 99), prefixLength = 24)

        val candidates = subnet.discoveryCandidates(BundledPrinterDrivers.elginI9Full2)

        assertEquals(253, candidates.size)
        assertTrue(candidates.all(subnet::contains))
    }

    @Test
    fun `small direct subnet preserves its only non-phone host`() {
        val subnet = LocalWifiSubnet(ipv4(172, 16, 8, 2), prefixLength = 30)

        assertEquals(listOf("172.16.8.1"), subnet.discoveryCandidates(9_100).map(::host))
    }

    @Test
    fun `unsupported route sizes and non-private addresses cannot start a local scan`() {
        assertThrows(IllegalArgumentException::class.java) {
            LocalWifiSubnet(ipv4(10, 0, 0, 10), prefixLength = 23)
        }
        assertThrows(IllegalArgumentException::class.java) {
            LocalWifiSubnet(ipv4(10, 0, 0, 10), prefixLength = 31)
        }
        assertThrows(IllegalArgumentException::class.java) {
            LocalWifiSubnet(ipv4(8, 8, 8, 8), prefixLength = 24)
        }
        assertThrows(IllegalArgumentException::class.java) {
            LocalWifiSubnet(ipv4(192, 168, 1, 0), prefixLength = 24)
        }
        assertThrows(IllegalArgumentException::class.java) {
            LocalWifiPrinterEndpoint(ipv4(100, 64, 0, 10), port = 9_100)
        }
    }

    @Test
    fun `endpoints subnet and selection key redact network identifiers`() {
        val address = ipv4(192, 168, 31, 88)
        val endpoint = LocalWifiPrinterEndpoint(address, port = 9_100)
        val subnet = LocalWifiSubnet(address, prefixLength = 24)
        val selectionKey = LocalWifiNetworkSelectionKey(networkHandle = 4_218, subnet = subnet)

        address[3] = 1

        assertFalse(endpoint.toString().contains("192.168.31.88"))
        assertFalse(subnet.toString().contains("192.168.31"))
        assertFalse(selectionKey.toString().contains("4218"))
        assertFalse(selectionKey.toString().contains("192.168.31"))
        assertEquals("192.168.31.88", host(endpoint))
        assertTrue(endpoint.belongsTo(subnet))
    }

    @Test
    fun `visible candidates accept only valid private IPs and redact their address`() {
        val candidate =
            LocalWifiPrinterCandidate(
                id = 1,
                label = "Impressora encontrada 1",
                ipAddress = "192.168.31.88",
            )

        assertFalse(candidate.toString().contains("192.168.31.88"))
        assertThrows(IllegalArgumentException::class.java) {
            LocalWifiPrinterCandidate(2, "Impressora encontrada 2", "999.168.31.88")
        }
        assertThrows(IllegalArgumentException::class.java) {
            LocalWifiPrinterCandidate(3, "Impressora encontrada 3", "8.8.8.8")
        }
    }

    @Test
    fun `advanced address accepts only a private IPv4 literal inside the current subnet`() {
        val subnet =
            LocalWifiSubnet(
                hostAddress = ipv4(192, 168, 31, 42),
                prefixLength = 24,
                excludedGatewayAddresses = listOf(ipv4(192, 168, 31, 1)),
            )

        val valid = LocalWifiPrinterEndpoint.parseIpv4Literal("192.168.31.88", 9_100)

        assertNotNull(valid)
        assertTrue(subnet.isSelectableEndpoint(requireNotNull(valid)))
        assertFalse(
            subnet.isSelectableEndpoint(
                requireNotNull(LocalWifiPrinterEndpoint.parseIpv4Literal("192.168.32.88", 9_100)),
            ),
        )
        // O gateway digitado é aceito de propósito: em Wi-Fi direto ele é a própria impressora.
        // Ver `o gateway fica fora da varredura e continua aceito quando alguém digita`.
        assertTrue(
            subnet.isSelectableEndpoint(
                requireNotNull(LocalWifiPrinterEndpoint.parseIpv4Literal("192.168.31.1", 9_100)),
            ),
        )
        assertNull(LocalWifiPrinterEndpoint.parseIpv4Literal("printer.local", 9_100))
        assertNull(LocalWifiPrinterEndpoint.parseIpv4Literal("8.8.8.8", 9_100))
        assertNull(LocalWifiPrinterEndpoint.parseIpv4Literal("192.168.31.88", 0))
    }

    @Test
    fun `only a non captive non VPN Wi-Fi can be considered for local printing`() {
        assertTrue(
            LocalWifiNetworkEligibility.accepts(
                hasWifiTransport = true,
                hasVpnTransport = false,
                hasActiveVpn = false,
                isNotVpn = true,
                isCaptivePortal = false,
            ),
        )
        assertFalse(
            LocalWifiNetworkEligibility.accepts(
                hasWifiTransport = false,
                hasVpnTransport = false,
                hasActiveVpn = false,
                isNotVpn = true,
                isCaptivePortal = false,
            ),
        )
        assertFalse(
            LocalWifiNetworkEligibility.accepts(
                hasWifiTransport = true,
                hasVpnTransport = true,
                hasActiveVpn = true,
                isNotVpn = false,
                isCaptivePortal = false,
            ),
        )
        assertFalse(
            LocalWifiNetworkEligibility.accepts(
                hasWifiTransport = true,
                hasVpnTransport = false,
                hasActiveVpn = false,
                isNotVpn = true,
                isCaptivePortal = true,
            ),
        )
        assertFalse(
            LocalWifiNetworkEligibility.accepts(
                hasWifiTransport = true,
                hasVpnTransport = false,
                hasActiveVpn = true,
                isNotVpn = true,
                isCaptivePortal = false,
            ),
        )
    }

    private fun ipv4(first: Int, second: Int, third: Int, fourth: Int): ByteArray =
        byteArrayOf(first.toByte(), second.toByte(), third.toByte(), fourth.toByte())

    private fun host(endpoint: LocalWifiPrinterEndpoint): String = endpoint.socketAddress().hostString
}
