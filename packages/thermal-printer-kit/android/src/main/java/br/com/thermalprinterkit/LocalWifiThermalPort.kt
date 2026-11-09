package br.com.thermalprinterkit

import java.io.IOException
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.locks.LockSupport

/** Porta ESC/POS vinculada explicitamente à Wi-Fi local que foi confirmada na busca. */
interface LocalWifiThermalPort {
    fun open(
        network: LocalWifiNetwork,
        endpoint: LocalWifiPrinterEndpoint,
        profile: PrinterDriverProfile,
    )

    fun close()

    fun write(data: ByteArray)

    /** Aguarda o firmware consumir o último lote antes de encerrar o socket TCP. */
    fun finish() = Unit

    fun coverStatus(): ThermalCoverStatus

    fun paperStatus(): ThermalPaperStatus

    /** Ausência, timeout ou resposta inválida são a resposta normal `null`. */
    fun readIdentity(): PrinterDeclaredIdentity? = null
}

/**
 * TCP/ESC-POS para a impressora encontrada na Wi-Fi local. Cada socket é criado pelo
 * [LocalWifiNetwork], não pelo processo: assim a busca e a impressão nunca vazam para dados
 * móveis, Ethernet, VPN ou outra Wi-Fi. A escolha é invalidada se a rede/CIDR mudar.
 */
class LocalWifiEscPosThermalPort(
    private val networkProvider: LocalWifiNetworkProvider,
    private val connectTimeoutMillis: Int = DEFAULT_CONNECT_TIMEOUT_MILLIS,
    private val statusTimeoutMillis: Int = DEFAULT_STATUS_TIMEOUT_MILLIS,
) : LocalWifiThermalPort {
    private var socket: Socket? = null
    private var output: java.io.OutputStream? = null
    private var input: java.io.InputStream? = null
    private var activeNetwork: LocalWifiNetwork? = null

    init {
        require(connectTimeoutMillis > 0) { "Timeout de conexão Wi-Fi inválido." }
        require(statusTimeoutMillis > 0) { "Timeout de status Wi-Fi inválido." }
    }

    override fun open(
        network: LocalWifiNetwork,
        endpoint: LocalWifiPrinterEndpoint,
        profile: PrinterDriverProfile,
    ) {
        close()
        if (!isCurrent(network)) throw ThermalPortException(ThermalPortFailure.LocalWifiDisconnected)
        if (!network.subnet.isSelectableEndpoint(endpoint) || !profile.acceptsTcpPort(endpoint.port)) {
            throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        }
        var openedSocket: Socket? = null
        try {
            openedSocket = network.openSocket()
            openedSocket.connect(endpoint.socketAddress(), connectTimeoutMillis)
            openedSocket.soTimeout = statusTimeoutMillis
            openedSocket.tcpNoDelay = true
        } catch (error: Exception) {
            runCatching { openedSocket?.close() }
            throw ThermalPortException(failureAfterSocketError(network), error)
        }
        val connectedSocket = requireNotNull(openedSocket)
        try {
            socket = connectedSocket
            output = connectedSocket.getOutputStream()
            input = connectedSocket.getInputStream()
            activeNetwork = network
        } catch (error: Exception) {
            socket = null
            output = null
            input = null
            activeNetwork = null
            runCatching { connectedSocket.close() }
            throw ThermalPortException(failureAfterSocketError(network), error)
        }
    }

    override fun close() {
        val activeSocket = socket
        socket = null
        output = null
        input = null
        activeNetwork = null
        runCatching { activeSocket?.close() }
    }

    override fun write(data: ByteArray) {
        val activeOutput = output
            ?: throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        val network = activeNetwork
            ?: throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        if (!isCurrent(network)) throw ThermalPortException(ThermalPortFailure.LocalWifiDisconnected)
        try {
            var offset = 0
            while (offset < data.size) {
                val length = minOf(MAX_WIFI_CHUNK_BYTES, data.size - offset)
                activeOutput.write(data, offset, length)
                activeOutput.flush()
                offset += length
                if (offset < data.size) LockSupport.parkNanos(CHUNK_PAUSE_NANOS)
            }
        } catch (error: IOException) {
            throw ThermalPortException(
                if (isCurrent(network)) {
                    ThermalPortFailure.WriteInterrupted
                } else {
                    ThermalPortFailure.LocalWifiDisconnected
                },
                error,
            )
        }
    }

    override fun finish() {
        val activeOutput = output
            ?: throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        try {
            activeOutput.flush()
            LockSupport.parkNanos(FINAL_DRAIN_NANOS)
        } catch (error: IOException) {
            throw ThermalPortException(ThermalPortFailure.WriteInterrupted, error)
        }
    }

    override fun coverStatus(): ThermalCoverStatus =
        EscPosStatus.cover(readStatus(EscPosStatus.COVER_QUERY))

    override fun paperStatus(): ThermalPaperStatus =
        EscPosStatus.paper(readStatus(EscPosStatus.PAPER_QUERY))

    override fun readIdentity(): PrinterDeclaredIdentity? =
        PrinterDeclaredIdentity.fromResponses(
            firmwareVersion = readTerminatedText(EscPosPrinterIdentity.FIRMWARE_VERSION_QUERY),
            manufacturer = readTerminatedText(EscPosPrinterIdentity.MANUFACTURER_QUERY),
            model = readTerminatedText(EscPosPrinterIdentity.MODEL_QUERY),
        )

    /**
     * A consulta não liga o status automático: o `GS a` faz o firmware devolver um bloco ASB
     * antes da resposta do `DLE EOT`, e o primeiro byte desse bloco seria lido como tampa aberta.
     * Bytes pendentes de blocos anteriores são descartados antes da pergunta, e a leitura só
     * aceita um byte com o layout fixo do `DLE EOT`.
     */
    private fun readStatus(query: ByteArray): Int? {
        val activeOutput = output ?: return null
        val activeInput = input ?: return null
        return try {
            discardPending(activeInput)
            activeOutput.write(query)
            activeOutput.flush()
            firstStatusByte(activeInput)
        } catch (_: SocketTimeoutException) {
            null
        } catch (_: IOException) {
            null
        }
    }

    private fun discardPending(activeInput: java.io.InputStream) {
        var discarded = 0
        while (discarded < EscPosStatus.MAX_RESPONSE_SCAN_BYTES && activeInput.available() > 0) {
            if (activeInput.read() < 0) return
            discarded += 1
        }
    }

    private fun firstStatusByte(activeInput: java.io.InputStream): Int? {
        repeat(EscPosStatus.MAX_RESPONSE_SCAN_BYTES) {
            val byte = activeInput.read()
            if (byte < 0) return null
            if (EscPosStatus.isStatusResponse(byte)) return byte
        }
        return null
    }

    /** NUL é obrigatório: timeout, EOF, controle ou excesso resultam apenas em ausência. */
    private fun readTerminatedText(query: ByteArray): ByteArray? {
        val activeOutput = output ?: return null
        val activeInput = input ?: return null
        return try {
            discardPending(activeInput)
            activeOutput.write(query)
            activeOutput.flush()
            val response = ByteArray(PrinterDeclaredIdentity.MAX_FIELD_BYTES)
            var length = 0
            var completed: ByteArray? = null
            var overflow = false
            while (completed == null) {
                val value = activeInput.read()
                if (value < 0) return null
                if (value == 0) {
                    completed = if (overflow) ByteArray(0) else response.copyOf(length)
                    continue
                }
                if (length >= response.size) {
                    overflow = true
                } else {
                    response[length++] = value.toByte()
                }
            }
            completed.takeUnless { overflow }
        } catch (_: SocketTimeoutException) {
            null
        } catch (_: IOException) {
            null
        }
    }

    private fun isCurrent(network: LocalWifiNetwork): Boolean =
        networkProvider.localWifiNetwork()?.matchesSelectionKey(network.selectionKey) == true

    private fun failureAfterSocketError(network: LocalWifiNetwork): ThermalPortFailure =
        if (isCurrent(network)) {
            ThermalPortFailure.PrinterUnavailable
        } else {
            ThermalPortFailure.LocalWifiDisconnected
        }

    private companion object {
        const val DEFAULT_CONNECT_TIMEOUT_MILLIS = 1_000
        const val DEFAULT_STATUS_TIMEOUT_MILLIS = 300
        const val MAX_WIFI_CHUNK_BYTES = 1_024
        const val CHUNK_PAUSE_NANOS = 20_000_000L
        const val FINAL_DRAIN_NANOS = 600_000_000L
    }
}
