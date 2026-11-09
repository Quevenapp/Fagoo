package br.com.thermalprinterkit

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Referência efêmera. O identificador não deriva do MAC, do nome ou do serial do aparelho. */
data class BluetoothPrinterHandle(
    val id: Long,
    val label: String,
    /** Chave efêmera usada somente para mesclar SPP e BLE durante a busca atual. */
    internal val discoveryAddress: String?,
    /** O aparelho se identificou, ou o rótulo é numeração nossa? Ver `BluetoothPrinterCandidate`. */
    val named: Boolean = true,
) {
    constructor(id: Long, label: String) : this(id, label, null)

    // O endereço funciona como token de correlação e nunca pode escapar em relatório ou log.
    override fun toString(): String = "BluetoothPrinterHandle(id=$id)"
}

/**
 * A busca das pareadas, dizendo também **por que** ela voltou vazia.
 *
 * Existe porque `List<BluetoothPrinterHandle>` não tem onde carregar a causa, e a lista vazia era o
 * único canal: cinco situações diferentes chegavam ao balcão como a mesma frase.
 */
sealed interface ResultadoDaBuscaPareada {
    class Encontradas(
        val pareadas: List<BluetoothPrinterHandle>,
    ) : ResultadoDaBuscaPareada {
        init {
            require(pareadas.isNotEmpty()) { "Busca sem pareada é Vazia, e Vazia carrega a causa." }
        }

        override fun toString(): String = "Encontradas(count=${pareadas.size})"
    }

    data class Vazia(
        val causa: CausaDaBuscaPareadaVazia,
    ) : ResultadoDaBuscaPareada
}

/** Porta Bluetooth SPP isolada dos recibos e da interface visual. */
interface BluetoothThermalPort {
    fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle>

    /**
     * A mesma busca de [discover], com a causa quando ela volta vazia.
     *
     * A implementação padrão delega a [discover] e devolve [CausaDaBuscaPareadaVazia.NaoInformada]:
     * uma porta que só sabe listar continua compilando e continua correta — ela apenas não
     * distingue, e diz isso no tipo em vez de fingir uma causa que não mediu.
     */
    fun buscarPareadas(profile: PrinterDriverProfile): ResultadoDaBuscaPareada {
        val encontradas = discover(profile)
        return if (encontradas.isEmpty()) {
            ResultadoDaBuscaPareada.Vazia(CausaDaBuscaPareadaVazia.NaoInformada)
        } else {
            ResultadoDaBuscaPareada.Encontradas(encontradas)
        }
    }

    /** Endereço da pareada escolhida, entregue somente ao store cifrado da instalação. */
    fun persistenceAddress(handle: BluetoothPrinterHandle): String? =
        handle.discoveryAddress?.takeIf { it.matches(Regex("[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}")) }

    suspend fun open(
        handle: BluetoothPrinterHandle,
        profile: PrinterDriverProfile,
    )

    fun close()

    fun write(data: ByteArray)

    /**
     * Espera a impressora consumir o que já foi entregue à pilha Bluetooth, antes de fechar.
     *
     * Existe porque `write` retornar não quer dizer que o papel saiu, e fechar o socket descarta o
     * que estava na fila. Um cupom de teste é pequeno e sobrevive; um recibo com QR não — foi assim
     * que saiu meia matriz de QR e a sequência travou no primeiro recibo.
     */
    fun drain()

    fun coverStatus(): ThermalCoverStatus

    fun paperStatus(): ThermalPaperStatus

    /** Ausência, timeout ou resposta inválida são a resposta normal `null`. */
    fun readIdentity(): PrinterDeclaredIdentity? = null
}

/**
 * Quanto tempo o canal já está em silêncio — a única pergunta que decide a soltura.
 *
 * Vive fora do port para ser exercida sem Bluetooth nenhum. Antes o teste carregava uma cópia da
 * regra, e a cópia marcava atividade a cada escrita enquanto o port marcava só no `drain`: com as
 * duas separadas, o disparo do silêncio anterior fechava o socket no meio do trabalho seguinte e a
 * suíte continuava verde.
 */
internal class SppOciosidade(
    private val prazoMillis: Long,
    private val clock: () -> Long,
) {
    private var ultimaAtividade = 0L

    fun tocou() {
        ultimaAtividade = clock()
    }

    fun esgotada(): Boolean = clock() - ultimaAtividade >= prazoMillis
}

/**
 * Transporte ESC/POS por RFCOMM no perfil SPP. Lista apenas aparelhos já pareados pela pessoa,
 * o que dispensa `BLUETOOTH_SCAN` e qualquer permissão de localização. Nenhum identificador
 * técnico sai desta classe.
 */
class AndroidBluetoothThermalPort(
    context: Context,
    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter,
    private val writeChunkBytes: Int = DEFAULT_WRITE_CHUNK_BYTES,
    private val writePauseMillis: Long = DEFAULT_WRITE_PAUSE_MILLIS,
    private val statusTimeoutMillis: Long = DEFAULT_STATUS_TIMEOUT_MILLIS,
    private val idleReleaseMillis: Long = DEFAULT_IDLE_RELEASE_MILLIS,
    private val clock: () -> Long = System::currentTimeMillis,
    /**
     * Sobrescreve o teto de vazão do perfil enquanto o app está rodando; `null` mantém o do perfil.
     *
     * Mesmo ponto de injeção do BLE, e pelo mesmo motivo: SPP também não tem controle de fluxo, e a
     * pausa fixa de 20 ms por bloco é um teto implícito que ninguém mediu. Ver `AndroidBleThermalPort`.
     */
    private val rasterThroughputOverride: () -> Int? = { null },
    /**
     * Onde os números deste canal são publicados; `null` mantém o transporte sem medição.
     *
     * SPP não negocia MTU e não escolhe entre confirmado e não confirmado, então a medida sai com
     * `NOT_APPLICABLE` e sem MTU — o que ele tem para dar é o bloco fixo e a vazão real.
     */
    private val telemetry: TransportTelemetry? = null,
) : BluetoothThermalPort {
    private val appContext = context.applicationContext
    private val nextId = AtomicLong(1)
    private val discovered = linkedMapOf<Long, BluetoothDevice>()
    private var socket: BluetoothSocket? = null

    /** Bytes entregues à pilha Bluetooth desde o `open`, ainda não necessariamente impressos. */
    private var writtenSinceOpen = 0L

    /**
     * Bytes e tempo do trabalho atual, contados só para a medição publicada.
     *
     * Separados de [writtenSinceOpen] porque aquele é zerado pelo `drain` — ele serve para calcular
     * a espera da cabeça térmica, e some justamente quando o trabalho termina, que é quando a tela
     * de diagnóstico precisa do número.
     */
    private var measuredBytes = 0L
    private var measuredNanos = 0L

    /** Qual aparelho está do outro lado do socket aberto, para poder reaproveitá-lo. */
    private var openHandleId: Long? = null

    /** Armado no `open` com o teto do perfil desta impressora; sem teto declarado, fica nulo. */
    private var pacer: RasterThroughputPacer? = null

    private val ociosidade = SppOciosidade(idleReleaseMillis, clock)
    private var idleRelease: ScheduledFuture<*>? = null

    /**
     * Solta o canal quando ninguém escreve há um tempo.
     *
     * **O módulo Bluetooth aceita uma conexão só.** Manter o socket aberto entre as fichas de uma
     * venda tirou o intervalo de reconexão de cada uma delas — mas segurar indefinidamente não é
     * otimizar, é monopolizar: enquanto este aparelho tem o canal, nenhum outro acha a impressora,
     * e de fora isso é indistinguível de impressora desligada.
     *
     * Dois casos reais mordiam por isso: uma impressora para dois Caixas, em que o primeiro a
     * imprimir trancava a noite inteira; e a troca de celular, em que o aparelho que saiu da vaga
     * continua segurando o canal enquanto o app dele estiver aberto.
     *
     * Dez segundos cobrem as fichas de uma mesma venda e o cliente seguinte da fila, e devolvem a
     * impressora numa pausa de verdade — que é exatamente quando outro aparelho a quer. O iOS já se
     * comporta assim, soltando o peripheral 1,5 s depois de escrever.
     */
    private val releaser: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "spp-idle-release").apply { isDaemon = true }
        }

    init {
        require(writeChunkBytes in MIN_WRITE_CHUNK_BYTES..MAX_WRITE_CHUNK_BYTES) {
            "Tamanho de bloco Bluetooth inválido."
        }
        require(writePauseMillis >= 0) { "Pausa de escrita Bluetooth inválida." }
        require(statusTimeoutMillis > 0) { "Timeout de status Bluetooth inválido." }
    }

    /**
     * Mantém o contrato antigo: lista, e **lança** quando falta permissão.
     *
     * A exceção era a única causa em que a lista vazia já era distinguível, e `searchBluetooth`
     * contava com ela. **Não conta mais**: desde que esta porta ganhou [buscarPareadas],
     * `searchBluetooth` chama a irmã, que devolve `Vazia(PermissaoDeConexaoNegada)` sem lançar, e
     * quem traduz isso em `BluetoothPermissionDenied` é `estadoDaBuscaVazia`. Este `discover`
     * continua de pé pelas integrações de fora que ainda o chamam; o `catch` do kit que o
     * atendia continua lá pelo mesmo motivo, e não porque esta porta o alcance.
     */
    override fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle> =
        when (val resultado = buscarPareadas(profile)) {
            is ResultadoDaBuscaPareada.Encontradas -> resultado.pareadas
            is ResultadoDaBuscaPareada.Vazia -> {
                if (resultado.causa == CausaDaBuscaPareadaVazia.PermissaoDeConexaoNegada) {
                    throw ThermalPortException(ThermalPortFailure.BluetoothPermissionDenied)
                }
                emptyList()
            }
        }

    /**
     * Lê os fatos do adaptador e deixa a decisão com [causaDaBuscaPareadaVazia].
     *
     * A separação é o ponto: esta metade não é exercível sem `android.bluetooth` — na JVM de teste
     * `BluetoothAdapter` responde "Stub!" — e a outra metade é exercível caso a caso. O que fica
     * sem prova automatizada aqui é a leitura em si: que `isEnabled` seja falso com o rádio
     * desligado e que `bondedDevices` liste o que os Ajustes mostram é contrato do Android.
     */
    override fun buscarPareadas(profile: PrinterDriverProfile): ResultadoDaBuscaPareada {
        close()
        discovered.clear()
        val modeloFalaBluetooth = profile.supports(PrinterTransport.BLUETOOTH)
        val radioPresente = adapter != null
        val radioLigado = adapter?.isEnabled == true
        // A permissão é lida antes de `bondedDevices` e não depois do estouro: sem
        // BLUETOOTH_CONNECT a chamada lança SecurityException, e o `runCatching` de lá devolveria
        // uma lista vazia indistinguível de "nada pareado" — que foi o defeito de campo original.
        val temPermissao = hasConnectPermission()
        val podeConsultar = modeloFalaBluetooth && radioLigado && temPermissao
        val pareadas = if (podeConsultar) bondedDevices() else emptyList()
        val impressoras = pareadas.filter(::looksLikePrinter)
        causaDaBuscaPareadaVazia(
            modeloFalaBluetooth = modeloFalaBluetooth,
            radioPresente = radioPresente,
            radioLigado = radioLigado,
            temPermissaoDeConexao = temPermissao,
            pareadas = pareadas.size,
            comServicoDeImpressao = impressoras.size,
        )?.let { causa -> return ResultadoDaBuscaPareada.Vazia(causa) }
        return ResultadoDaBuscaPareada.Encontradas(
            impressoras.mapIndexed { index, device ->
                val id = nextHandleId()
                discovered[id] = device
                // O nome pareado é o que a pessoa acabou de ver nos Ajustes do sistema —
                // `MTP-II_BD7E`, `T210_D0E9`. Descartá-lo e numerar fazia a volta dos Ajustes dizer
                // "um aparelho encontrado" sem dizer qual, logo depois de a pessoa ter parado
                // justamente para parear aquela impressora pelo nome. Visto no A10s.
                //
                // Passa pelo mesmo filtro que guarda nome de perfil: MAC, IP e UUID não chegam à
                // tela. Sem nome utilizável, a numeração continua sendo o que sobra.
                val declared = runCatching { device.name }.getOrNull()?.takeIf(::isAcceptableProfileName)
                BluetoothPrinterHandle(
                    id = id,
                    label = declared ?: "Aparelho sem nome ${index + 1}",
                    named = declared != null,
                    discoveryAddress = device.address,
                )
            },
        )
    }

    /**
     * Abre o canal, **reaproveitando o que já estiver aberto para a mesma impressora**.
     *
     * Reconectar RFCOMM custa perto de um segundo, e numa sequência de cinco cupons são cinco
     * aberturas. Abrir e fechar a cada um punha um intervalo visível entre eles.
     */
    override suspend fun open(
        handle: BluetoothPrinterHandle,
        profile: PrinterDriverProfile,
    ) {
        // O disparo de soltura armado pelo trabalho anterior não sabe que este começou: sem adiar
        // aqui, ele fecha o socket no meio da sonda. Medido no A07 com a KPrinter, na homologação,
        // em que a pausa humana entre uma sonda e a resposta encosta nos dez segundos.
        tocar()
        // A medição é do trabalho que começa agora, e o canal reaproveitado não a herda: sem zerar
        // aqui, o quinto cupom da mesma venda mostraria a vazão dos cinco somados.
        measuredBytes = 0
        measuredNanos = 0
        // O teto é do perfil deste trabalho, e vale também no canal reaproveitado: ele foi aberto
        // para esta impressora, mas quem dita o ritmo é o perfil que está imprimindo agora.
        val teto = rasterThroughputOverride() ?: profile.maxRasterBytesPerSecond
        if (openHandleId == handle.id && socket?.isConnected == true) {
            pacer = RasterThroughputPacer(teto)
            return
        }
        close()
        if (!isUsable()) throw ThermalPortException(ThermalPortFailure.BluetoothUnavailable)
        val device = discovered[handle.id]
            ?: throw ThermalPortException(ThermalPortFailure.BluetoothDisconnected)
        // O pareamento pode ter sido desfeito nos ajustes entre a busca e a escolha.
        if (bondedDevices().none { it.address == device.address }) {
            throw ThermalPortException(ThermalPortFailure.BluetoothNotPaired)
        }
        // Seguro primeiro, inseguro depois.
        //
        // `createRfcommSocketToServiceRecord` exige canal autenticado. Boa parte das portáteis
        // chinesas com PIN `0000` só aceita o inseguro: o pareamento existe, a busca lista, e o
        // `connect` falha sem imprimir um milímetro. Medido na genérica LUOGAO (`KPrinter`), que
        // reprovava três vezes seguidas sem sair papel, enquanto a T210 abria no primeiro caminho.
        //
        // A ordem importa: o seguro é o que deve ser tentado antes, porque é o canal autenticado.
        // O inseguro é queda de padrão, e só entra quando o outro já falhou.
        val opened = connectSocket(device)
        socket = opened
        openHandleId = handle.id
        // Depois do `close()` acima, que solta o ritmo junto com o canal anterior.
        pacer = RasterThroughputPacer(teto)
    }

    /**
     * Abre o canal, caindo para o inseguro quando o autenticado recusa. Erro de permissão não é
     * tentado de novo: falta de `BLUETOOTH_CONNECT` reprovaria os dois do mesmo jeito, e insistir
     * só esconderia a causa.
     */
    private fun connectSocket(device: BluetoothDevice): BluetoothSocket {
        var ultimaFalha: IOException? = null
        listOf(true, false).forEach { autenticado ->
            val candidate =
                try {
                    if (autenticado) {
                        device.createRfcommSocketToServiceRecord(SPP_UUID)
                    } else {
                        device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
                    }
                } catch (failure: SecurityException) {
                    throw ThermalPortException(ThermalPortFailure.BluetoothPermissionDenied, failure)
                } catch (failure: IOException) {
                    ultimaFalha = failure
                    return@forEach
                }
            try {
                candidate.connect()
                return candidate
            } catch (failure: SecurityException) {
                runCatching { candidate.close() }
                throw ThermalPortException(ThermalPortFailure.BluetoothPermissionDenied, failure)
            } catch (failure: IOException) {
                runCatching { candidate.close() }
                ultimaFalha = failure
            }
        }
        throw ThermalPortException(ThermalPortFailure.PrinterUnavailable, ultimaFalha)
    }

    @Synchronized
    override fun close() {
        idleRelease?.cancel(false)
        idleRelease = null
        val active = socket
        socket = null
        openHandleId = null
        writtenSinceOpen = 0
        // O ritmo pertence ao canal que está sendo solto: o próximo `open` arma o do perfil dele.
        pacer = null
        runCatching { active?.close() }
    }

    /** Marca atividade e adia a soltura. Chamado por quem toca no transporte. */
    @Synchronized
    private fun marcarAtividade() {
        ociosidade.tocou()
    }

    /**
     * Toda operação adia a soltura, porque o prazo conta silêncio e não trabalho.
     *
     * Só o `drain` marcava atividade, então o relógio da soltura era o da impressão **anterior**:
     * um trabalho que começasse nove segundos depois dela levava o disparo no meio.
     */
    @Synchronized
    private fun tocar() {
        marcarAtividade()
        agendarSoltura()
    }

    @Synchronized
    private fun agendarSoltura() {
        if (idleReleaseMillis <= 0) return
        idleRelease?.cancel(false)
        idleRelease = releaser.schedule(::soltarSeOcioso, idleReleaseMillis, TimeUnit.MILLISECONDS)
    }

    @Synchronized
    private fun soltarSeOcioso() {
        if (socket == null) return
        // Reagendar em vez de fechar quando houve escrita no meio do caminho: a venda seguinte pode
        // ter começado enquanto este disparo esperava o lock.
        if (ociosidade.esgotada()) close() else agendarSoltura()
    }

    /**
     * SPP não tem controle de fluxo: o socket aceita tudo e a impressora descarta o que passar
     * do buffer dela. Blocos pequenos com pausa é o que evita cupom truncado.
     *
     * Atenção ao que `write` **não** significa: quando ele retorna, os bytes estão na pilha
     * Bluetooth do Android, não no papel. Quem fecha o socket em seguida joga fora o que ainda
     * estava na fila. Ver [drain].
     */
    override fun write(data: ByteArray) {
        val stream = socket?.outputStream
            ?: throw ThermalPortException(ThermalPortFailure.BluetoothDisconnected)
        // O cronômetro fecha no `finally` para que trabalho interrompido no meio ainda publique o
        // que saiu até ali: envio que morreu devagar é medição, não ausência de medição.
        val comecou = System.nanoTime()
        try {
            writeBlocks(stream, data)
        } finally {
            measuredNanos += System.nanoTime() - comecou
            telemetry?.record(
                TransportMeasurement(
                    transport = PrinterTransport.BLUETOOTH,
                    blockBytes = writeChunkBytes,
                    negotiatedMtuBytes = null,
                    writeMode = TransportWriteMode.NOT_APPLICABLE,
                    bytes = measuredBytes,
                    elapsedMillis = measuredNanos / NANOS_PER_MILLI,
                ),
            )
        }
    }

    /** O laço de blocos de sempre, separado só para o cronômetro do [write] fechar num `finally`. */
    private fun writeBlocks(
        stream: OutputStream,
        data: ByteArray,
    ) {
        var offset = 0
        while (offset < data.size) {
            val length = minOf(writeChunkBytes, data.size - offset)
            // O freio entra onde os blocos já saem. A pausa fixa abaixo continua existindo: ela é
            // por bloco, o teto é por segundo, e quem for mais restritivo manda.
            try {
                pacer?.pace(length)
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
                throw ThermalPortException(ThermalPortFailure.WriteInterrupted, interrupted)
            }
            try {
                stream.write(data, offset, length)
                stream.flush()
            } catch (failure: IOException) {
                throw ThermalPortException(
                    if (offset == 0) {
                        ThermalPortFailure.BluetoothDisconnected
                    } else {
                        ThermalPortFailure.WriteInterrupted
                    },
                    failure,
                )
            }
            offset += length
            writtenSinceOpen += length
            measuredBytes += length
            // Bloco a bloco: um raster grande leva mais tempo do que o prazo de soltura.
            marcarAtividade()
            if (writePauseMillis > 0) {
                try {
                    Thread.sleep(writePauseMillis)
                } catch (failure: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw ThermalPortException(ThermalPortFailure.WriteInterrupted, failure)
                }
            }
        }
    }

    /**
     * Espera pelo tempo que a impressora leva para imprimir o que recebeu, mais uma folga.
     *
     * É espera por tempo porque não há sinal melhor disponível: SPP não tem controle de fluxo, e o
     * `DLE EOT` é comando de tempo real — a firmware responde na hora, **mesmo com a fila cheia**,
     * então usá-lo aqui daria um "pronto" que não quer dizer nada.
     *
     * A conta parte do throughput mecânico e não do throughput do rádio: o gargalo é a cabeça
     * térmica, e ela desacelera justamente onde o cupom é mais preto, que é o QR. Por isso o
     * divisor é conservador — errar para mais custa uma fração de segundo por cupom; errar para
     * menos custa metade de um QR ilegível, que é dinheiro na mão do cliente e produto não entregue.
     */
    override fun drain() {
        val pending = writtenSinceOpen
        // Agenda mesmo sem nada pendente: `drain` marca o fim de uma impressão, e é daqui que a
        // contagem de ociosidade passa a valer.
        marcarAtividade()
        agendarSoltura()
        if (pending <= 0) return
        writtenSinceOpen = 0
        val millis = MIN_DRAIN_MILLIS + pending * 1_000L / DRAIN_BYTES_PER_SECOND
        try {
            Thread.sleep(minOf(millis, MAX_DRAIN_MILLIS))
        } catch (failure: InterruptedException) {
            Thread.currentThread().interrupt()
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
     * Consulta sem `GS a`: a firmware responde ao pedido de status automático com um bloco de
     * quatro bytes que chega antes da resposta do `DLE EOT` e seria lido no lugar dela.
     */
    private fun readStatus(query: ByteArray): Int? {
        val active = socket ?: return null
        tocar()
        val status = runCatching {
            drain(active)
            active.outputStream.write(query)
            active.outputStream.flush()
            awaitByte(active)
        }.getOrNull()
        tocar()
        return status
    }

    private fun drain(active: BluetoothSocket) {
        while (active.inputStream.available() > 0) {
            active.inputStream.read()
        }
    }

    private fun awaitByte(active: BluetoothSocket): Int? {
        val deadline = System.currentTimeMillis() + statusTimeoutMillis
        while (System.currentTimeMillis() < deadline) {
            if (active.inputStream.available() > 0) {
                val value = active.inputStream.read()
                return value.takeIf { it >= 0 }?.and(0xff)
            }
            Thread.sleep(STATUS_POLL_MILLIS)
        }
        return null
    }

    /** Lê até NUL e abandona no prazo; bytes sem terminador nunca viram texto parcial. */
    private fun readTerminatedText(query: ByteArray): ByteArray? {
        val active = socket ?: return null
        tocar()
        val text = runCatching {
            drain(active)
            active.outputStream.write(query)
            active.outputStream.flush()
            val response = ArrayList<Byte>(PrinterDeclaredIdentity.MAX_FIELD_BYTES)
            var overflow = false
            val deadline = System.currentTimeMillis() + statusTimeoutMillis
            while (System.currentTimeMillis() < deadline) {
                if (active.inputStream.available() <= 0) {
                    Thread.sleep(STATUS_POLL_MILLIS)
                    continue
                }
                val value = active.inputStream.read()
                if (value < 0) return@runCatching null
                if (value == 0) {
                    return@runCatching if (overflow) null else response.toByteArray()
                }
                if (response.size >= PrinterDeclaredIdentity.MAX_FIELD_BYTES) {
                    overflow = true
                } else {
                    response += value.toByte()
                }
            }
            null
        }.getOrNull()
        tocar()
        return text
    }

    private fun bondedDevices(): List<BluetoothDevice> =
        runCatching { adapter?.bondedDevices.orEmpty().sortedBy(BluetoothDevice::getAddress) }
            .getOrDefault(emptyList())

    /**
     * Classe de dispositivo **não** determina serviço.
     *
     * Medido no A10s com as duas pareadas: a T210 se declara da classe de impressora e aparecia; a
     * MTP-II não, e sumia da lista — mesmo pareada e mesmo expondo o SPP (`00001101`), que é o
     * serviço pelo qual o kit imprime nela. Quem decide é o serviço anunciado, não como o aparelho
     * se rotula. É o mesmo erro que o filtro de varredura BLE cometia com o GATT.
     *
     * A classe continua valendo como aceite: impressora que se declara e não lista UUID nenhum
     * (`getUuids` devolve nulo em aparelho que nunca foi consultado) permanece na lista.
     */
    private fun looksLikePrinter(device: BluetoothDevice): Boolean {
        val servesSpp =
            runCatching { device.uuids.orEmpty().any { it.uuid == SPP_UUID } }.getOrDefault(false)
        if (servesSpp) return true
        val deviceClass = runCatching { device.bluetoothClass }.getOrNull() ?: return false
        return deviceClass.majorDeviceClass == BluetoothClass.Device.Major.IMAGING ||
            deviceClass.deviceClass == PRINTER_DEVICE_CLASS
    }

    private fun isUsable(): Boolean = adapter?.isEnabled == true && hasConnectPermission()

    /** `BLUETOOTH_CONNECT` só existe como permissão em tempo de execução a partir do Android 12. */
    private fun hasConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.BLUETOOTH_CONNECT,
            ) == PackageManager.PERMISSION_GRANTED

    private fun nextHandleId(): Long {
        val id = nextId.getAndUpdate { current -> if (current == Long.MAX_VALUE) 1 else current + 1 }
        return id.coerceAtLeast(1)
    }

    // `internal` e não `private`: o prazo de soltura é política, não detalhe, e o teste que a
    // afirma vive no mesmo módulo. Continua fora da API pública do kit.
    internal companion object {
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        const val PRINTER_DEVICE_CLASS = 0x0680
        const val DEFAULT_WRITE_CHUNK_BYTES = 256
        const val NANOS_PER_MILLI = 1_000_000L
        const val DEFAULT_WRITE_PAUSE_MILLIS = 20L

        /**
         * Vazão mecânica assumida da cabeça térmica, em bytes por segundo.
         *
         * Acima do que o rádio entrega (256 B a cada 20 ms, ou 12,8 kB/s), e é isso que explica por
         * que o cupom nunca estourou o buffer: a impressora consome mais rápido do que recebe. O
         * que se perdia era só o resto da fila no instante do fechamento — por isso o dreno é curto
         * e a primeira estimativa, seis vezes mais lenta, punha segundos de espera entre cupons
         * sem necessidade nenhuma.
         */
        const val DRAIN_BYTES_PER_SECOND = 18_000L

        /** Folga fixa: mesmo um cupom curto precisa da cabeça terminar a última linha. */
        const val MIN_DRAIN_MILLIS = 500L

        /** Teto para não prender a venda se a conta errar feio. */
        const val MAX_DRAIN_MILLIS = 8_000L
        /**
         * Dez segundos sem escrever e o canal cai sozinho. Ver o comentário de `releaser`: cobre a
         * venda inteira e o cliente seguinte, e devolve a impressora numa pausa de verdade.
         */
        const val DEFAULT_IDLE_RELEASE_MILLIS = 10_000L

        const val DEFAULT_STATUS_TIMEOUT_MILLIS = 800L
        const val MIN_WRITE_CHUNK_BYTES = 32
        const val MAX_WRITE_CHUNK_BYTES = 1_024
        const val STATUS_POLL_MILLIS = 20L
    }
}
