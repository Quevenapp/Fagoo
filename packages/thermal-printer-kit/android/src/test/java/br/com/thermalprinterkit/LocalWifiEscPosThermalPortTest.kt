package br.com.thermalprinterkit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalWifiEscPosThermalPortTest {
    @Test
    fun `GS I lê três respostas terminadas em NUL sem consultar serial`() {
        val socket =
            IdentitySocket(
                replies = listOf("SV3.2.2", "GoldenSky", "58E_BT"),
            )
        val network = RecordingLocalWifiNetwork(socket)
        val port = LocalWifiEscPosThermalPort(LocalWifiNetworkProvider { network })
        port.open(network, endpoint(), BundledPrinterDrivers.elginI9Full2)

        val identity = requireNotNull(port.readIdentity())

        assertEquals("SV3.2.2", identity.firmwareVersion)
        assertEquals("GoldenSky", identity.manufacturer)
        assertEquals("58E_BT", identity.model)
        val sent = socket.written.toByteArray().toList().windowed(3)
        assertTrue(sent.contains(EscPosPrinterIdentity.FIRMWARE_VERSION_QUERY.toList()))
        assertTrue(sent.contains(EscPosPrinterIdentity.MANUFACTURER_QUERY.toList()))
        assertTrue(sent.contains(EscPosPrinterIdentity.MODEL_QUERY.toList()))
        assertFalse(sent.contains(byteArrayOf(0x1d, 0x49, 68).toList()))
    }

    @Test
    fun `GS I sem NUL e com controle termina no timeout como ausência`() {
        val socket = IdentitySocket(replies = listOf("SEM-TERMINADOR", "FAB\nRICA", ""), terminate = false)
        val network = RecordingLocalWifiNetwork(socket)
        val port = LocalWifiEscPosThermalPort(LocalWifiNetworkProvider { network })
        port.open(network, endpoint(), BundledPrinterDrivers.elginI9Full2)

        assertEquals(null, port.readIdentity())
    }

    @Test
    fun `local Wi-Fi port opens only a socket supplied by the confirmed Wi-Fi network`() {
        val network = RecordingLocalWifiNetwork(RecordingSocket())
        val port = LocalWifiEscPosThermalPort(LocalWifiNetworkProvider { network })

        port.open(network, endpoint(), BundledPrinterDrivers.elginI9Full2)
        port.write(byteArrayOf(0x1b, 0x40))

        assertEquals("192.168.31.88", network.socket.connectedEndpoint?.hostString)
        assertEquals(9_100, network.socket.connectedEndpoint?.port)
        assertTrue(network.socket.written.toByteArray().isNotEmpty())
        port.close()
        assertTrue(network.socket.closed)
    }

    @Test
    fun `a changed Wi-Fi is rejected before a socket can be created or written`() {
        val network = RecordingLocalWifiNetwork(RecordingSocket())
        val provider = LocalWifiNetworkProvider { if (network.available) network else null }
        val port = LocalWifiEscPosThermalPort(provider)

        network.available = false
        val openError =
            runCatching { port.open(network, endpoint(), BundledPrinterDrivers.elginI9Full2) }
                .exceptionOrNull() as ThermalPortException

        assertEquals(ThermalPortFailure.LocalWifiDisconnected, openError.failure)
        assertEquals(0, network.openSocketCalls)

        network.available = true
        port.open(network, endpoint(), BundledPrinterDrivers.elginI9Full2)
        network.available = false
        val writeError = runCatching { port.write(byteArrayOf(0x1b)) }.exceptionOrNull() as ThermalPortException

        assertEquals(ThermalPortFailure.LocalWifiDisconnected, writeError.failure)
        assertFalse(network.socket.written.toByteArray().contains(0x1b))
        port.close()
    }

    /**
     * O gateway deixou de ser recusado aqui: em Wi-Fi direto a impressora **é** o gateway, e a
     * GoldenSky no AP `10.10.100.0/24` atende na 9100 do `.254`. Ele continua fora da varredura,
     * que é onde a economia de sondagem importa. Porta fora do perfil continua recusada.
     */
    @Test
    fun `gateway typed by hand opens a socket and a non profile port never does`() {
        val network = RecordingLocalWifiNetwork(RecordingSocket())
        val port = LocalWifiEscPosThermalPort(LocalWifiNetworkProvider { network })

        val gatewayOpened =
            port.open(
                network,
                LocalWifiPrinterEndpoint(byteArrayOf(192.toByte(), 168.toByte(), 31, 1), 9_100),
                BundledPrinterDrivers.elginI9Full2,
            )
        val otherPortFailure =
            runCatching {
                port.open(
                    network,
                    LocalWifiPrinterEndpoint(byteArrayOf(192.toByte(), 168.toByte(), 31, 88.toByte()), 9_101),
                    BundledPrinterDrivers.elginI9Full2,
                )
            }.exceptionOrNull() as ThermalPortException

        assertNotNull(gatewayOpened)
        assertEquals(ThermalPortFailure.PrinterUnavailable, otherPortFailure.failure)
        assertEquals(1, network.openSocketCalls)
    }

    @Test
    fun `the ASB block sent before the DLE EOT answer is discarded instead of read as an open cover`() {
        val socket = StatusSocket(replies = listOf(ASB_BLOCK + byteArrayOf(0x12)))
        val network = RecordingLocalWifiNetwork(socket)
        val port = LocalWifiEscPosThermalPort(LocalWifiNetworkProvider { network })
        port.open(network, endpoint(), BundledPrinterDrivers.elginI9Full2)

        val cover = port.coverStatus()

        assertEquals(ThermalCoverStatus.CLOSED, cover)
        assertFalse(containsAutomaticStatusCommand(socket.written.toByteArray()))
        port.close()
    }

    @Test
    fun `an answer that only brings ASB bytes is unknown and never blocks printing`() {
        val socket = StatusSocket(replies = listOf(ASB_BLOCK, ASB_BLOCK))
        val network = RecordingLocalWifiNetwork(socket)
        val port = LocalWifiEscPosThermalPort(LocalWifiNetworkProvider { network })
        port.open(network, endpoint(), BundledPrinterDrivers.elginI9Full2)

        assertEquals(ThermalCoverStatus.UNKNOWN, port.coverStatus())
        assertEquals(ThermalPaperStatus.UNKNOWN, port.paperStatus())
        port.close()
    }

    @Test
    fun `ASB bytes left over from an earlier block are drained before the query is answered`() {
        val socket = StatusSocket(replies = listOf(byteArrayOf(0x72)), leftovers = ASB_BLOCK + ASB_BLOCK)
        val network = RecordingLocalWifiNetwork(socket)
        val port = LocalWifiEscPosThermalPort(LocalWifiNetworkProvider { network })
        port.open(network, endpoint(), BundledPrinterDrivers.elginI9Full2)

        assertEquals(ThermalPaperStatus.OUT, port.paperStatus())
        port.close()
    }

    private fun endpoint(): LocalWifiPrinterEndpoint =
        LocalWifiPrinterEndpoint(byteArrayOf(192.toByte(), 168.toByte(), 31, 88.toByte()), 9_100)

    private class RecordingLocalWifiNetwork<T : Socket>(val socket: T) : LocalWifiNetwork {
        override val subnet =
            LocalWifiSubnet(
                hostAddress = byteArrayOf(192.toByte(), 168.toByte(), 31, 42),
                prefixLength = 24,
                excludedGatewayAddresses = listOf(byteArrayOf(192.toByte(), 168.toByte(), 31, 1)),
            )
        override val selectionKey = LocalWifiNetworkSelectionKey(networkHandle = 87, subnet = subnet)
        var available = true
        var openSocketCalls = 0

        override fun openSocket(): Socket {
            openSocketCalls += 1
            return socket
        }

        override fun stillAvailable(): Boolean = available
    }

    private class RecordingSocket : Socket() {
        val written = ByteArrayOutputStream()
        var connectedEndpoint: InetSocketAddress? = null
        var closed = false

        override fun connect(
            endpoint: SocketAddress?,
            timeout: Int,
        ) {
            connectedEndpoint = endpoint as InetSocketAddress
        }

        override fun getOutputStream() = written

        override fun getInputStream() = ByteArrayInputStream(ByteArray(0))

        override fun setSoTimeout(timeout: Int) = Unit

        override fun setTcpNoDelay(on: Boolean) = Unit

        override fun close() {
            closed = true
        }
    }

    /**
     * Impressora de bancada: cada `DLE EOT` recebido devolve a próxima resposta programada, e a
     * leitura só enxerga bytes depois da pergunta, como no socket real.
     */
    private class StatusSocket(
        private val replies: List<ByteArray>,
        leftovers: ByteArray = ByteArray(0),
    ) : Socket() {
        val written = ByteArrayOutputStream()
        private val pending = ArrayDeque<Int>()
        private var repliesSent = 0
        private var tail = 0

        init {
            leftovers.forEach { pending.addLast(it.toInt() and 0xff) }
        }

        override fun connect(
            endpoint: SocketAddress?,
            timeout: Int,
        ) = Unit

        override fun getOutputStream(): java.io.OutputStream =
            object : java.io.OutputStream() {
                override fun write(value: Int) = record(value)

                override fun write(
                    buffer: ByteArray,
                    offset: Int,
                    length: Int,
                ) {
                    for (index in offset until offset + length) record(buffer[index].toInt())
                }
            }

        override fun getInputStream(): java.io.InputStream =
            object : java.io.InputStream() {
                override fun read(): Int = pending.removeFirstOrNull() ?: throw SocketTimeoutException()

                override fun available(): Int = pending.size
            }

        override fun setSoTimeout(timeout: Int) = Unit

        override fun setTcpNoDelay(on: Boolean) = Unit

        override fun close() = Unit

        private fun record(value: Int) {
            written.write(value)
            tail = ((tail shl 8) or (value and 0xff)) and 0xffffff
            if (tail == COVER_QUERY_TAIL || tail == PAPER_QUERY_TAIL) {
                replies.getOrNull(repliesSent)?.forEach { pending.addLast(it.toInt() and 0xff) }
                repliesSent += 1
            }
        }

        private companion object {
            const val COVER_QUERY_TAIL = 0x100402
            const val PAPER_QUERY_TAIL = 0x100404
        }
    }

    private class IdentitySocket(
        private val replies: List<String>,
        private val terminate: Boolean = true,
    ) : Socket() {
        val written = ByteArrayOutputStream()
        private val pending = ArrayDeque<Int>()
        private var tail = 0
        private var responseIndex = 0

        override fun connect(endpoint: SocketAddress?, timeout: Int) = Unit

        override fun getOutputStream(): java.io.OutputStream =
            object : java.io.OutputStream() {
                override fun write(value: Int) = record(value)
                override fun write(buffer: ByteArray, offset: Int, length: Int) {
                    for (index in offset until offset + length) record(buffer[index].toInt())
                }
            }

        override fun getInputStream(): java.io.InputStream =
            object : java.io.InputStream() {
                override fun read(): Int = pending.removeFirstOrNull() ?: throw SocketTimeoutException()
                override fun available(): Int = pending.size
            }

        override fun setSoTimeout(timeout: Int) = Unit
        override fun setTcpNoDelay(on: Boolean) = Unit
        override fun close() = Unit

        private fun record(value: Int) {
            written.write(value)
            tail = ((tail shl 8) or (value and 0xff)) and 0xffffff
            if (tail in setOf(0x1d4941, 0x1d4942, 0x1d4943)) {
                replies.getOrNull(responseIndex)?.toByteArray()?.forEach {
                    pending.addLast(it.toInt() and 0xff)
                }
                if (terminate) pending.addLast(0)
                responseIndex += 1
            }
        }
    }

    private companion object {
        /** Bloco ASB medido na bancada: o primeiro byte já foi lido como tampa aberta. */
        val ASB_BLOCK = byteArrayOf(0x14, 0x00, 0x00, 0x0f)

        fun containsAutomaticStatusCommand(bytes: ByteArray): Boolean =
            (0..bytes.size - 3).any { index ->
                bytes[index] == 0x1d.toByte() && bytes[index + 1] == 0x61.toByte()
            }
    }
}
