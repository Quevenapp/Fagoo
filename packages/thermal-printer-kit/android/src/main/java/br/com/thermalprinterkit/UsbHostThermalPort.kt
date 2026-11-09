package br.com.thermalprinterkit

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/** Referência efêmera. O identificador não deriva do serial, VID, PID ou caminho USB. */
data class UsbPrinterHandle(
    val id: Long,
    val label: String,
    /**
     * Verdadeiro quando [label] é o nome que o **aparelho** declarou, e não o genérico do kit.
     *
     * O diálogo de permissão do Android já mostra esse nome, e o app mostrava "Impressora USB 1" na
     * mesma tela — duas identidades para a mesma impressora, e a do sistema era a boa. Quem se
     * identificou tem nome melhor que o nosso genérico.
     */
    val named: Boolean = false,
    /**
     * O que o **descritor** do aparelho sugere sobre a língua dele, ou `null` quando ele nada diz.
     *
     * **Identidade de graça, e a única que esta família permite.** O kit pergunta identidade a todo
     * mundo por `GS I` — e `GS I` é comando `GS`, que é exatamente a família que a IM453H não tem e
     * com a qual ela trava. O descritor USB é lido pela enumeração, antes de abrir o aparelho e sem
     * escrever byte nenhum no caminho de impressão; medido em 23/08/2026, o da IM453H traz
     * `manufacturer_name=Diebold` e `product_name=IM453H`.
     *
     * **Ele confirma e não nega**, e por isso o tipo é anulável em vez de ter um valor "Epson":
     * ver [DialetoNoBalcao.suspeitaPeloDescritor]. O que a interface faz com isto é **avisar** quem
     * respondeu outra coisa — nunca trocar a resposta de quem está com a impressora na mão.
     */
    val dialectSuspicion: EscPosDialect? = null,
)

/** Porta USB Host isolada dos recibos e da interface visual. */
interface UsbThermalPort {
    fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle>

    /** Identidade estável capturada somente depois da escolha humana e destinada ao store cifrado. */
    fun persistenceIdentity(handle: UsbPrinterHandle): UsbConnectionIdentity? = null

    /** Compara uma candidata da enumeração atual com a instalação anteriormente confirmada. */
    fun matchesPersistedIdentity(
        handle: UsbPrinterHandle,
        identity: UsbConnectionIdentity,
    ): Boolean = false

    suspend fun open(
        handle: UsbPrinterHandle,
        profile: PrinterDriverProfile,
    )

    fun close()

    fun write(data: ByteArray)

    fun coverStatus(): ThermalCoverStatus

    fun paperStatus(): ThermalPaperStatus

    /** Ausência, timeout ou resposta inválida são a resposta normal `null`. */
    fun readIdentity(): PrinterDeclaredIdentity? = null
}

/**
 * Transporte ESC/POS direto pelo Android USB Host. A permissão é solicitada apenas após a
 * escolha explícita da candidata. Nenhum identificador técnico sai desta classe.
 */
class AndroidUsbHostThermalPort(
    context: Context,
    private val manager: UsbManager =
        requireNotNull(context.getSystemService(Context.USB_SERVICE) as? UsbManager) {
            "USB Host não disponível."
        },
    private val writeTimeoutMillis: Int = DEFAULT_WRITE_TIMEOUT_MILLIS,
    private val statusTimeoutMillis: Int = DEFAULT_STATUS_TIMEOUT_MILLIS,
) : UsbThermalPort {
    /**
     * Fotografia efêmera do descritor que o kernel entregou na descoberta.
     *
     * O endereço `/dev/bus/usb/...` e o `deviceId` são endereços de uma enumeração, não identidade:
     * depois de desligar um hub, o Android pode entregar o mesmo par a outra impressora. A
     * fotografia nunca sai desta instância, não é persistida e não aparece em log.
     */
    private data class DiscoveredDevice(
        val device: UsbDevice,
        val descriptor: UsbDescriptorSignature,
    )

    private val appContext = context.applicationContext
    private val nextId = AtomicLong(1)
    private val discovered = linkedMapOf<Long, DiscoveredDevice>()
    private var connection: UsbDeviceConnection? = null
    private var claimedInterface: UsbInterface? = null
    private var outputEndpoint: UsbEndpoint? = null
    private var inputEndpoint: UsbEndpoint? = null
    private var identityOverflowed = false

    /** Aparelhos já recuperados nesta sessão; reenumerar troca o nome e rearma a recuperação. */
    private val resetDevices = mutableSetOf<String>()
    private var currentDeviceName: String? = null

    init {
        require(writeTimeoutMillis > 0) { "Timeout de escrita USB inválido." }
        require(statusTimeoutMillis > 0) { "Timeout de status USB inválido." }
    }

    override fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle> {
        close()
        discovered.clear()
        // Enumerar de novo é o momento em que "o hub foi religado" aparece; a recuperação de canal
        // volta a ficar armada para cada aparelho encontrado agora.
        resetDevices.clear()
        return manager.deviceList.values
            .asSequence()
            .filter { device -> compatibleInterface(device, profile) != null }
            .sortedBy(UsbDevice::getDeviceId)
            .mapIndexed { index, device ->
                val id = nextHandleId()
                discovered[id] = DiscoveredDevice(device, UsbDescriptorSignature.from(device))
                // `productName` é descritor de fabricante, não serial: `getSerialNumber` exige
                // permissão e nunca é lido aqui. A validação de nome recusa o que tiver cara de
                // identificador técnico, e o genérico do kit continua sendo a rede de segurança.
                val declared = runCatching { device.productName }.getOrNull()?.trim()
                val aceito = declared?.takeIf(::isAcceptableProfileName)
                // `manufacturerName` era lido em lugar nenhum da produção — só na sonda de bancada
                // —, e é justamente ele que diz "Diebold". Ele NÃO entra no rótulo: o nome que a
                // pessoa vê continua sendo o de produto, e este campo serve só para a suspeita.
                val fabricante = runCatching { device.manufacturerName }.getOrNull()?.trim()
                UsbPrinterHandle(
                    id = id,
                    label = aceito ?: "Impressora USB ${index + 1}",
                    named = aceito != null,
                    dialectSuspicion = DialetoNoBalcao.suspeitaPeloDescritor(fabricante, declared),
                )
            }
            .toList()
    }

    override suspend fun open(
        handle: UsbPrinterHandle,
        profile: PrinterDriverProfile,
    ) {
        close()
        val discoveredDevice = discovered[handle.id]
            ?: throw ThermalPortException(ThermalPortFailure.UsbDisconnected)
        val device = discoveredDevice.device
        val current = manager.deviceList.values.firstOrNull { candidate ->
            candidate.deviceId == device.deviceId &&
                candidate.deviceName == device.deviceName &&
                UsbDescriptorSignature.from(candidate) == discoveredDevice.descriptor
        } ?: throw ThermalPortException(ThermalPortFailure.UsbDisconnected)
        val usbInterface = compatibleInterface(current, profile)
            ?: throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        if (!manager.hasPermission(current) && !requestPermission(current)) {
            throw ThermalPortException(ThermalPortFailure.UsbPermissionDenied)
        }
        val opened = manager.openDevice(current)
            ?: throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        if (!opened.claimInterface(usbInterface, true)) {
            opened.close()
            throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        }
        val output = bulkEndpoint(usbInterface, UsbConstants.USB_DIR_OUT)
        if (output == null) {
            opened.releaseInterface(usbInterface)
            opened.close()
            throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        }
        // Porta serial precisa ser aberta antes de aceitar byte.
        //
        // A MP-4200 é CDC, não impressora USB: o endpoint de dados existe e o `bulkTransfer` devolve
        // -1 enquanto o host não levantar DTR. Da tela, isso saía como "USB não disponível" logo
        // depois de a permissão ser concedida — enumerou, abriu, e não escreveu.
        //
        // Falha em silêncio de propósito: aparelho de classe impressora não tem interface de
        // controle nenhuma, e recusar por causa de um handshake que não se aplica quebraria a Elgin,
        // que já imprime.
        if (usbInterface.interfaceClass == UsbConstants.USB_CLASS_CDC_DATA) {
            abreLinhaSerial(opened, current)
        } else if (
            usbInterface.interfaceClass == UsbConstants.USB_CLASS_PRINTER &&
            resetDevices.add(current.deviceName)
        ) {
            resetPrinterChannel(opened, usbInterface)
        }

        currentDeviceName = current.deviceName
        connection = opened
        claimedInterface = usbInterface
        outputEndpoint = output
        inputEndpoint = bulkEndpoint(usbInterface, UsbConstants.USB_DIR_IN)
    }

    override fun persistenceIdentity(handle: UsbPrinterHandle): UsbConnectionIdentity? {
        val device = discovered[handle.id]?.device ?: return null
        val serial =
            if (manager.hasPermission(device)) {
                runCatching { device.serialNumber }
                    .getOrNull()
                    ?.trim()
                    ?.takeIf { value -> value.isNotEmpty() && value.length <= 256 && value.none(Char::isISOControl) }
            } else {
                null
            }
        return UsbConnectionIdentity(device.vendorId, device.productId, serial)
    }

    override fun matchesPersistedIdentity(
        handle: UsbPrinterHandle,
        identity: UsbConnectionIdentity,
    ): Boolean {
        val device = discovered[handle.id]?.device ?: return false
        if (device.vendorId != identity.vendorId || device.productId != identity.productId) return false
        val expectedSerial = identity.serialNumber ?: return true
        if (!manager.hasPermission(device)) return true
        val currentSerial = runCatching { device.serialNumber }.getOrNull() ?: return false
        return currentSerial == expectedSerial
    }

    /**
     * Configura a linha e levanta DTR/RTS na interface de controle do CDC.
     *
     * `SET_LINE_CODING` vem antes porque algumas firmwares recusam o `SET_CONTROL_LINE_STATE` sem
     * uma configuração válida; 115200 8N1 é o que a MP-4200 anuncia como padrão, e é inofensivo em
     * quem ignora.
     */
    private fun abreLinhaSerial(opened: UsbDeviceConnection, device: UsbDevice) {
        val controle = (0 until device.interfaceCount)
            .map(device::getInterface)
            .firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_COMM }
            ?: return
        val indice = controle.id

        // 115200, 1 stop bit, sem paridade, 8 bits de dados.
        val lineCoding = byteArrayOf(0x00, 0xC2.toByte(), 0x01, 0x00, 0x00, 0x00, 0x08)
        opened.controlTransfer(
            CDC_REQUEST_TYPE, SET_LINE_CODING, 0, indice, lineCoding, lineCoding.size, CONTROL_TIMEOUT,
        )
        opened.controlTransfer(
            CDC_REQUEST_TYPE, SET_CONTROL_LINE_STATE, DTR_AND_RTS, indice, null, 0, CONTROL_TIMEOUT,
        )
    }

    /**
     * Reinicia o canal da classe Printer **uma vez por aparelho enumerado**, não a cada `open`.
     *
     * A conexão USB pode continuar enumerada e autorizada enquanto o endpoint permanece em NAK
     * depois de a impressora ou o hub ser religado. Nesse estado até o primeiro comando ESC/POS
     * espera o timeout e a tela parece travada. O SOFT_RESET é a recuperação definida pela própria
     * classe USB Printer; ele não depende de fabricante, VID/PID nem perfil homologado.
     *
     * Firmwares que anunciam a classe mas não implementam a requisição devolvem erro. Isso não
     * impede a escrita normal, portanto a resposta é deliberadamente opcional. **Quem implementa,
     * porém, descarta buffer**, e é por isso que ele não pode sair a cada `open`.
     *
     * Medido em papel na TM-T20X-II em 17/08, na etapa de corte, que é o único fluxo que abre a
     * porta seis vezes seguidas: com o reset em todo `open`, **uma** tira; sem reset nenhum,
     * **seis**. Nas duas vezes o fio devolveu os seis envios como aceitos — a Epson engole os seis
     * payloads em 81 ms e leva cerca de um segundo de mecânica por tira, então cada abertura
     * seguinte descartava a tira que ainda estava saindo. A primeira sobrevivia porque nada vinha
     * antes dela, e a tela oferecia seis cortes para quem tinha uma tira na mão.
     *
     * Uma vez por aparelho enumerado preserva a cura sem o dano: o nome do aparelho muda quando ele
     * reenumera, que é exatamente o caso de religar a impressora ou o hub, então o religamento
     * continua recuperado; e uma escrita que falha rearma a recuperação para o próximo `open`.
     */
    private fun resetPrinterChannel(
        opened: UsbDeviceConnection,
        usbInterface: UsbInterface,
    ) {
        opened.controlTransfer(
            USB_PRINTER_REQUEST_TYPE,
            USB_PRINTER_SOFT_RESET,
            0,
            usbInterface.id,
            null,
            0,
            CONTROL_TIMEOUT,
        )
    }

    override fun close() {
        val activeConnection = connection
        val activeInterface = claimedInterface
        connection = null
        claimedInterface = null
        outputEndpoint = null
        inputEndpoint = null
        if (activeConnection != null && activeInterface != null) {
            runCatching { activeConnection.releaseInterface(activeInterface) }
        }
        runCatching { activeConnection?.close() }
    }

    override fun write(data: ByteArray) {
        val activeConnection = connection
            ?: throw ThermalPortException(ThermalPortFailure.UsbDisconnected)
        val endpoint = outputEndpoint
            ?: throw ThermalPortException(ThermalPortFailure.UsbDisconnected)
        var offset = 0
        while (offset < data.size) {
            val length = minOf(MAX_USB_CHUNK_BYTES, data.size - offset)
            val chunk = data.copyOfRange(offset, offset + length)
            val written =
                try {
                    activeConnection.bulkTransfer(endpoint, chunk, chunk.size, writeTimeoutMillis)
                } finally {
                    chunk.fill(0)
                }
            if (written != length) {
                // Escrita que não completou é o sintoma que o SOFT_RESET existe para curar. O
                // aparelho volta à fila de recuperação, e o próximo `open` o reinicia.
                currentDeviceName?.let(resetDevices::remove)
                throw ThermalPortException(
                    if (offset == 0 && written <= 0) {
                        ThermalPortFailure.UsbDisconnected
                    } else {
                        ThermalPortFailure.WriteInterrupted
                    },
                )
            }
            offset += written
        }

        // Sinaliza o fim da transferência quando o último pacote encheu exatamente.
        //
        // Em USB bulk o dispositivo só sabe que a mensagem acabou quando chega um pacote **menor**
        // que o máximo. Se o total for múltiplo exato do tamanho de pacote, o resto fica na fila
        // dele esperando mais — e o que fica preso é justamente o **fim do cupom**: o avanço e o
        // corte, que são os últimos bytes.
        //
        // Foi esse o sintoma na MP-4200 por USB: o texto saiu, o papel não avançou nem cortou, e o
        // mesmo cupom pela rede cortava normalmente. Um pacote de tamanho zero fecha a mensagem.
        val maxPacket = endpoint.maxPacketSize
        if (maxPacket > 0 && data.isNotEmpty() && data.size % maxPacket == 0) {
            activeConnection.bulkTransfer(endpoint, ByteArray(0), 0, writeTimeoutMillis)
        }
    }

    override fun coverStatus(): ThermalCoverStatus =
        EscPosStatus.cover(readStatus(EscPosStatus.COVER_QUERY))

    override fun paperStatus(): ThermalPaperStatus =
        EscPosStatus.paper(readStatus(EscPosStatus.PAPER_QUERY))

    override fun readIdentity(): PrinterDeclaredIdentity? {
        identityOverflowed = false
        val firmware = readTerminatedText(EscPosPrinterIdentity.FIRMWARE_VERSION_QUERY)
        if (identityOverflowed) return null
        val manufacturer = readTerminatedText(EscPosPrinterIdentity.MANUFACTURER_QUERY)
        if (identityOverflowed) return null
        val model = readTerminatedText(EscPosPrinterIdentity.MODEL_QUERY)
        if (identityOverflowed) return null
        return PrinterDeclaredIdentity.fromResponses(firmware, manufacturer, model)
    }

    /**
     * A consulta não liga o status automático: o `GS a` faz o firmware devolver um bloco ASB
     * antes da resposta do `DLE EOT`, e o primeiro byte desse bloco seria lido como tampa aberta.
     * Bytes pendentes de blocos anteriores são descartados antes da pergunta, e a leitura só
     * aceita um byte com o layout fixo do `DLE EOT`.
     */
    private fun readStatus(query: ByteArray): Int? {
        val activeConnection = connection ?: return null
        val output = outputEndpoint ?: return null
        val input = inputEndpoint ?: return null
        val response = ByteArray(readBufferSize(input, EscPosStatus.MAX_RESPONSE_SCAN_BYTES))
        return try {
            discardPending(activeConnection, input, response)
            if (activeConnection.bulkTransfer(output, query, query.size, statusTimeoutMillis) < 0) {
                null
            } else {
                firstStatusByte(activeConnection, input, response)
            }
        } finally {
            response.fill(0)
        }
    }

    /**
     * Buffer de leitura nunca menor que o pacote do endpoint.
     *
     * USB bulk entrega **pacotes inteiros**: se o dispositivo manda 64 bytes e o buffer tem 8, o
     * pacote não cabe e a pilha do Android reprova a transferência — `ArrayIndexOutOfBoundsException`
     * dentro de `bulkTransfer`, não erro de I/O. É por isso que o defeito é intermitente e só
     * apareceu na quarta impressora: ele exige que a impressora **tenha o que responder**. Quem não
     * responde ao `GS I` nunca enche pacote nenhum, e o buffer curto passa despercebido.
     *
     * Medido na Tomate MDK-082 por USB: `discardPending` estourou ao selecionar a candidata e, de
     * novo, no comprovante final.
     */
    private fun readBufferSize(
        input: UsbEndpoint,
        minimum: Int,
    ): Int = maxOf(minimum, input.maxPacketSize.takeIf { it > 0 } ?: 0)

    private fun discardPending(
        activeConnection: UsbDeviceConnection,
        input: UsbEndpoint,
        buffer: ByteArray,
    ) {
        repeat(MAX_STATUS_READS) {
            if (activeConnection.bulkTransfer(input, buffer, buffer.size, DRAIN_TIMEOUT_MILLIS) <= 0) return
        }
    }

    private fun firstStatusByte(
        activeConnection: UsbDeviceConnection,
        input: UsbEndpoint,
        buffer: ByteArray,
    ): Int? {
        repeat(MAX_STATUS_READS) {
            val read = activeConnection.bulkTransfer(input, buffer, buffer.size, statusTimeoutMillis)
            if (read <= 0) return null
            for (index in 0 until minOf(read, buffer.size)) {
                val byte = buffer[index].toInt() and 0xff
                if (EscPosStatus.isStatusResponse(byte)) return byte
            }
        }
        return null
    }

    private fun readTerminatedText(query: ByteArray): ByteArray? {
        val activeConnection = connection ?: return null
        val output = outputEndpoint ?: return null
        val input = inputEndpoint ?: return null
        val chunk = ByteArray(readBufferSize(input, PrinterDeclaredIdentity.MAX_FIELD_BYTES + 1))
        val response = ByteArray(PrinterDeclaredIdentity.MAX_FIELD_BYTES)
        return try {
            discardPending(activeConnection, input, chunk)
            if (activeConnection.bulkTransfer(output, query, query.size, statusTimeoutMillis) < 0) {
                null
            } else {
                var length = 0
                var overflow = false
                repeat(MAX_STATUS_READS) {
                    val read = activeConnection.bulkTransfer(input, chunk, chunk.size, statusTimeoutMillis)
                    if (read <= 0) return null
                    for (index in 0 until minOf(read, chunk.size)) {
                        val value = chunk[index].toInt() and 0xff
                        if (value == 0) return if (overflow) null else response.copyOf(length)
                        if (length >= response.size) {
                            overflow = true
                            identityOverflowed = true
                        } else {
                            response[length++] = value.toByte()
                        }
                    }
                }
                null
            }
        } finally {
            chunk.fill(0)
            response.fill(0)
        }
    }

    private suspend fun requestPermission(device: UsbDevice): Boolean =
        suspendCancellableCoroutine { continuation ->
            val action = "${appContext.packageName}.USB_PERMISSION.${nextHandleId()}"
            var registered = true
            lateinit var receiver: BroadcastReceiver
            fun unregister() {
                if (registered) {
                    registered = false
                    runCatching { appContext.unregisterReceiver(receiver) }
                }
            }
            receiver =
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context?, intent: Intent?) {
                        if (intent?.action != action) return
                        val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                        unregister()
                        if (continuation.isActive) continuation.resume(granted)
                    }
                }
            ContextCompat.registerReceiver(
                appContext,
                receiver,
                IntentFilter(action),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            continuation.invokeOnCancellation { unregister() }
            val permissionIntent =
                PendingIntent.getBroadcast(
                    appContext,
                    device.deviceId,
                    Intent(action).setPackage(appContext.packageName),
                    // **Mutável, e não imutável.** É o sistema que escreve
                    // `EXTRA_PERMISSION_GRANTED` neste intent ao responder o diálogo; com
                    // `FLAG_IMMUTABLE` ele não consegue, e o receiver lê o valor padrão — `false`.
                    // O efeito é a permissão parecer negada mesmo quando a pessoa toca em permitir,
                    // ou o diálogo nem aparecer, dependendo da versão do Android.
                    //
                    // `FLAG_MUTABLE` só existe a partir do 31; abaixo disso o padrão já é mutável.
                    PendingIntent.FLAG_UPDATE_CURRENT or
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            PendingIntent.FLAG_MUTABLE
                        } else {
                            0
                        },
                )
            manager.requestPermission(device, permissionIntent)
        }

    /**
     * A interface por onde os bytes saem — e ela **não é sempre da classe impressora**.
     *
     * A Bematech MP-4200 TH se apresenta como porta serial virtual: classe do dispositivo `COMM`,
     * uma interface de controle e uma **`CDC_DATA` (10)** com os endpoints bulk. Exigir
     * `USB_CLASS_PRINTER` a deixava invisível, e "não reconheceu" ficava indistinguível de "não
     * está conectada". Medido pela `UsbInventoryProbe`, que lista sem filtrar nada.
     *
     * O que de fato importa é o **endpoint bulk de saída**: é por ele que ESC/POS trafega, na classe
     * 7 ou na 10. A classe impressora vem primeiro por ser a mais específica — um aparelho que
     * ofereça as duas deve usar a dela.
     */
    private fun compatibleInterface(
        device: UsbDevice,
        profile: PrinterDriverProfile,
    ): UsbInterface? {
        if (!EscPosDialectGate.composesReceipt(profile.dialect)) return null
        val interfaces = (0 until device.interfaceCount).map(device::getInterface)
        fun comSaidaBulk(classe: Int) =
            interfaces.firstOrNull { usbInterface ->
                usbInterface.interfaceClass == classe &&
                    bulkEndpoint(usbInterface, UsbConstants.USB_DIR_OUT) != null
            }
        return comSaidaBulk(UsbConstants.USB_CLASS_PRINTER)
            ?: comSaidaBulk(UsbConstants.USB_CLASS_CDC_DATA)
    }

    private fun bulkEndpoint(
        usbInterface: UsbInterface,
        direction: Int,
    ): UsbEndpoint? =
        (0 until usbInterface.endpointCount)
            .asSequence()
            .map(usbInterface::getEndpoint)
            .firstOrNull { endpoint ->
                endpoint.type == UsbConstants.USB_ENDPOINT_XFER_BULK && endpoint.direction == direction
            }

    private fun nextHandleId(): Long {
        val id = nextId.getAndUpdate { current -> if (current == Long.MAX_VALUE) 1 else current + 1 }
        return id.coerceAtLeast(1)
    }

    private companion object {
        /**
         * O `bulkTransfer` bloqueia enquanto a impressora **imprime**, não só enquanto o cabo
         * transmite: o buffer dela enche, e a escrita só volta conforme o papel anda.
         *
         * Medido na bancada com a Tomate MDK-082 de 80 mm: todas as sondas passaram por USB e só o
         * comprovante final falhou com "não foi possível imprimir por USB" — é a única peça com QR
         * raster, e a maior. Na segunda tentativa saiu. Cinco segundos é tempo de transmissão, não
         * de impressão.
         */
        const val DEFAULT_WRITE_TIMEOUT_MILLIS = 15_000
        const val DEFAULT_STATUS_TIMEOUT_MILLIS = 300
        const val DRAIN_TIMEOUT_MILLIS = 20
        const val MAX_STATUS_READS = 3
        /** Host para dispositivo, classe, destinatário interface. */
        const val CDC_REQUEST_TYPE = 0x21
        const val SET_LINE_CODING = 0x20
        const val SET_CONTROL_LINE_STATE = 0x22
        const val DTR_AND_RTS = 0x03
        const val CONTROL_TIMEOUT = 2_000
        /** Host para dispositivo, classe, destinatário interface. */
        const val USB_PRINTER_REQUEST_TYPE = 0x21
        const val USB_PRINTER_SOFT_RESET = 0x02

        /**
         * Bloco menor devolve o controle mais cedo, então nenhuma transferência isolada carrega o
         * papel inteiro. Com 16 KB, um único bloco podia representar segundos de impressão física
         * e estourar sozinho o timeout.
         */
        const val MAX_USB_CHUNK_BYTES = 4 * 1024
    }
}
