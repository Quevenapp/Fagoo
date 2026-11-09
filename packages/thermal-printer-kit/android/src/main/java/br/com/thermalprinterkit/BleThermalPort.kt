package br.com.thermalprinterkit

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Impressora térmica por Bluetooth LE. Cobre os modelos que só falam GATT, sem SPP — cada vez
 * mais comuns entre as portáteis 58mm, e o único protocolo que o iPhone alcança.
 *
 * Diferente do SPP, aqui não existe pareamento: a impressora é encontrada pelo anúncio a cada
 * busca. Nenhum MAC é persistido, e o identificador da candidata é posicional.
 */
object BlePrinterProfile {
    /** Serviço padrão de impressora térmica ESC/POS em BLE. */
    val ESC_POS_SERVICE: UUID = UUID.fromString("000018f0-0000-1000-8000-00805f9b34fb")
    val ESC_POS_CHARACTERISTIC: UUID = UUID.fromString("00002af1-0000-1000-8000-00805f9b34fb")

    /** Serviço genérico dos módulos usados por boa parte das portáteis. */
    val VENDOR_SERVICE: UUID = UUID.fromString("e7810a71-73ae-499d-8c15-faa9aef0c3f2")
    val VENDOR_CHARACTERISTIC: UUID = UUID.fromString("bef8d6c9-9c21-4c9e-b632-bd58c1009f9f")

    val SERVICES = listOf(ESC_POS_SERVICE, VENDOR_SERVICE)

    fun characteristicFor(service: UUID): UUID =
        if (service == ESC_POS_SERVICE) ESC_POS_CHARACTERISTIC else VENDOR_CHARACTERISTIC
}

/** Referência efêmera; o identificador não deriva do MAC nem do nome do aparelho. */
data class BlePrinterHandle(
    val id: Long,
    val label: String,
    /** Chave efêmera usada somente para mesclar SPP e BLE durante a busca atual. */
    internal val discoveryAddress: String?,
    /** Verdade somente quando o anúncio trouxe um serviço conhecido de impressão. */
    internal val isLikelyPrinter: Boolean = false,
    /** O aparelho se identificou, ou o rótulo é numeração nossa? */
    val named: Boolean = true,
) {
    constructor(id: Long, label: String) : this(id, label, null, false)

    // O endereço funciona como token de correlação e nunca pode escapar em relatório ou log.
    override fun toString(): String = "BlePrinterHandle(id=$id)"
}

internal data class BleCandidatePresentation(
    val name: String?,
    val isLikelyPrinter: Boolean,
)

/**
 * Nome e indício de serviço só vivem na apresentação da busca. O endereço continua sendo a única
 * chave de correlação e não entra no rótulo, em erro ou em `toString()`.
 */
internal fun bleCandidatePresentation(
    advertisedName: String?,
    deviceName: String?,
    services: List<UUID>,
): BleCandidatePresentation =
    BleCandidatePresentation(
        name =
            sequenceOf(advertisedName, deviceName)
                .mapNotNull { name -> name?.trim()?.takeIf(String::isNotEmpty) }
                .firstOrNull(),
        isLikelyPrinter = services.any(BlePrinterProfile.SERVICES::contains),
    )

/**
 * Como cada bloco chega à impressora, e o que a confirmação de escrita prova em cada caso.
 *
 * A diferença não é de desempenho, é de significado: só o modo confirmado prova que a impressora
 * recebeu o bloco.
 */
internal enum class BleWriteMode {
    /** `WRITE_TYPE_DEFAULT`: o callback vem do ATT da impressora, que assim dita o ritmo. */
    ACKNOWLEDGED,

    /** `WRITE_TYPE_NO_RESPONSE`: o callback vem da pilha do Android, e o rádio segue sozinho. */
    UNACKNOWLEDGED,
}

/**
 * O que se pede ao transporte BLE sobre o modo de escrita — e o padrão nunca muda.
 *
 * [PREFER_ACKNOWLEDGED] é o comportamento publicado, e ele consertou a corrupção medida em 18/08 na
 * GoldenSky MTP-II, em que a foto saía pela metade e o resto virava texto. [FORCE_UNACKNOWLEDGED]
 * existe para **medir**, não para decidir: é a outra metade do teste de inanição, porque escrita sem
 * confirmação não espera o ATT da impressora a cada bloco. Quem oferece a escolha é o app hospedeiro,
 * no build de depuração dele.
 */
enum class BleWritePreference {
    /** O publicado: confirmado sempre que a característica declara esse modo. */
    PREFER_ACKNOWLEDGED,

    /** Só bancada: sem confirmação, quando a característica aceita. */
    FORCE_UNACKNOWLEDGED,
}

/**
 * A característica declara o que aceita, e nada mais implica isso — nem o serviço, nem o modelo.
 * Preferimos escrita confirmada quando ela existe e caímos para a não confirmada só quando é o
 * único modo declarado.
 *
 * [preference] só consegue **pedir**: forçar um modo que a característica não declara seria escrever
 * no vazio, e a bancada mediria o silêncio em vez do transporte. Uma característica que ofereça
 * apenas escrita confirmada continua confirmando mesmo com o botão ligado.
 */
internal fun bleWriteMode(
    properties: Int,
    preference: BleWritePreference = BleWritePreference.PREFER_ACKNOWLEDGED,
): BleWriteMode {
    val semResposta = properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
    if (preference == BleWritePreference.FORCE_UNACKNOWLEDGED && semResposta) {
        return BleWriteMode.UNACKNOWLEDGED
    }
    return if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) {
        BleWriteMode.ACKNOWLEDGED
    } else {
        BleWriteMode.UNACKNOWLEDGED
    }
}

/**
 * O que a bancada pode pedir de MTU, e o que o ATT admite.
 *
 * 23 é o piso do protocolo — 20 bytes de carga —, e 517 é o teto. Pedir fora disso não é medição, é
 * chamada malformada. O padrão do kit continua sendo 247, e ele não muda por este intervalo existir.
 */
val BLE_MTU_RANGE: IntRange = 23..517

/**
 * O MTU que o kit pede em toda conexão, e continua pedindo.
 *
 * Público para que o app hospedeiro possa **nomear** o padrão no rótulo de um controle de bancada
 * sem repetir o número: duas cópias deste valor seriam duas respostas sobre a mesma conexão.
 */
const val BLE_PREFERRED_MTU = 247

/**
 * A varredura BLE, dizendo também **por que** ela voltou vazia.
 *
 * Ver [ResultadoDaBuscaPareada]: é o mesmo defeito no transporte irmão. Aqui ele era pior, porque
 * "varri seis segundos e ninguém anunciou" saía igual a "o rádio nem me deu um varredor".
 */
sealed interface ResultadoDaVarreduraLe {
    class Encontradas(
        val anunciantes: List<BlePrinterHandle>,
    ) : ResultadoDaVarreduraLe {
        init {
            require(anunciantes.isNotEmpty()) { "Varredura sem anunciante é Vazia, e Vazia tem causa." }
        }

        override fun toString(): String = "Encontradas(count=${anunciantes.size})"
    }

    data class Vazia(
        val causa: CausaDaVarreduraLeVazia,
    ) : ResultadoDaVarreduraLe
}

interface BleThermalPort {
    suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle>

    /**
     * A mesma varredura de [discover], com a causa quando ela volta vazia.
     *
     * Implementação padrão delega e devolve [CausaDaVarreduraLeVazia.NaoInformada], pelo mesmo
     * motivo de [BluetoothThermalPort.buscarPareadas]: porta que só sabe listar continua correta e
     * diz no tipo que não distingue.
     */
    suspend fun varrer(
        profile: PrinterDriverProfile,
        onDiscovered: (BlePrinterHandle) -> Unit = {},
    ): ResultadoDaVarreduraLe {
        val anunciantes = discover(profile, onDiscovered)
        return if (anunciantes.isEmpty()) {
            ResultadoDaVarreduraLe.Vazia(CausaDaVarreduraLeVazia.NaoInformada)
        } else {
            ResultadoDaVarreduraLe.Encontradas(anunciantes)
        }
    }

    /** Endereço anunciado pela escolhida, entregue somente ao store cifrado da instalação. */
    fun persistenceAddress(handle: BlePrinterHandle): String? =
        handle.discoveryAddress?.takeIf { it.matches(Regex("[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}")) }

    /**
     * Publica cada candidata enquanto o rádio ainda está varrendo. Portas de teste e integrações
     * antigas continuam corretas pelo fallback que publica a lista somente ao concluir.
     */
    suspend fun discover(
        profile: PrinterDriverProfile,
        onDiscovered: (BlePrinterHandle) -> Unit,
    ): List<BlePrinterHandle> = discover(profile).also { candidates -> candidates.forEach(onDiscovered) }

    suspend fun open(
        handle: BlePrinterHandle,
        profile: PrinterDriverProfile,
    )

    fun close()

    fun write(data: ByteArray)

    /** GATT dessas impressoras não devolve status; papel e tampa ficam indetectáveis. */
    fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.UNKNOWN

    fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.UNKNOWN
}

class AndroidBleThermalPort(
    context: Context,
    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter,
    private val scanMillis: Long = DEFAULT_SCAN_MILLIS,
    private val connectTimeoutMillis: Long = DEFAULT_CONNECT_TIMEOUT_MILLIS,
    private val writeTimeoutMillis: Long = DEFAULT_WRITE_TIMEOUT_MILLIS,
    /** Vale somente no modo sem confirmação, onde ninguém do outro lado segura a fila. */
    private val unacknowledgedPauseMillis: Long = DEFAULT_UNACKNOWLEDGED_PAUSE_MILLIS,
    private val unacknowledgedFlushMillis: Long = DEFAULT_UNACKNOWLEDGED_FLUSH_MILLIS,
    /**
     * Sobrescreve o teto de vazão do perfil enquanto o app está rodando; `null` mantém o do perfil.
     *
     * É um ponto de injeção neutro, e existe para que uma bancada **descubra** o número: imprimir a
     * mesma foto a 32, 16 e 8 KB/s e achar onde ela para de encolher. O kit não lê preferência
     * nenhuma — quem oferece o controle é o app hospedeiro, e no build de depuração dele.
     */
    private val rasterThroughputOverride: () -> Int? = { null },
    /**
     * Onde os números deste enlace são publicados; `null` mantém o transporte sem medição.
     *
     * Escrever aqui é uma atribuição de campo entre blocos que já saíam: nenhum byte muda, e o ritmo
     * também não. Ver [TransportMeasurement] para o que se mede e por quê.
     */
    private val telemetry: TransportTelemetry? = null,
    /**
     * Qual modo de escrita pedir à característica; o padrão é o publicado.
     *
     * Ponto de injeção neutro, do mesmo feitio de [rasterThroughputOverride]. Sem o botão do app
     * hospedeiro, a preferência é `PREFER_ACKNOWLEDGED` a cada conexão e o transporte se comporta
     * byte a byte como antes deste parâmetro existir. **Não** troque o padrão: o modo confirmado é
     * o que consertou a corrupção de 18/08 na MTP-II.
     */
    private val bleWritePreference: () -> BleWritePreference = { BleWritePreference.PREFER_ACKNOWLEDGED },
    /**
     * Qual MTU pedir na conexão; `null` mantém o de sempre, [BLE_PREFERRED_MTU].
     *
     * Existe porque a bancada precisa separar duas causas que dão o mesmo papel: negociação recusada
     * pela impressora e negociação que nunca sobe. Medido em 20/08 na Inico T210, ~0,6 KB/s é
     * exatamente 20 bytes por intervalo de conexão — pedir 185 e 23 e comparar a vazão diz se o
     * enlace está preso no mínimo do ATT.
     */
    private val bleMtuPreference: () -> Int? = { null },
) : BleThermalPort {
    init {
        require(unacknowledgedPauseMillis >= 0) { "Pausa de escrita BLE inválida." }
        require(unacknowledgedFlushMillis >= 0) { "Janela de dreno BLE inválida." }
    }

    private val appContext = context.applicationContext
    private val nextId = AtomicLong(1)
    private val discovered = linkedMapOf<Long, BluetoothDevice>()

    private var gatt: BluetoothGatt? = null
    private var target: BluetoothGattCharacteristic? = null
    private var mtuPayload = DEFAULT_MTU_PAYLOAD
    private var writeMode = BleWriteMode.UNACKNOWLEDGED
    private var unacknowledgedWriteInFlight = false

    /**
     * O MTU que a impressora aceitou, e `null` enquanto nenhuma negociação concluiu.
     *
     * `null` não é o mesmo que 23: quer dizer que `requestMtu` foi recusado ou que a resposta não
     * veio, e o enlace ficou no mínimo do ATT sem ninguém confirmar. A diferença importa na tela.
     */
    private var negotiatedMtu: Int? = null

    /** Bytes entregues e tempo gasto dentro da escrita, desde o `open` deste canal. */
    private var bytesSinceOpen = 0L
    private var writeNanosSinceOpen = 0L

    /** Armado no `open` com o teto do perfil desta impressora; sem teto declarado, fica nulo. */
    private var pacer: RasterThroughputPacer? = null

    private var connectLatch: CountDownLatch? = null
    private var writeLatch: CountDownLatch? = null
    private var connectFailure: ThermalPortFailure? = null

    override suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle> =
        discover(profile) {}

    /**
     * Mantém o contrato antigo: lista, e lança quando o rádio não pode varrer.
     *
     * O que mudou é **qual** falha sai. Antes rádio desligado e permissão faltando eram o mesmo
     * `false` de `canScan()`, e os dois viravam `BluetoothPermissionDenied`: com o Bluetooth
     * desligado a pessoa lia "Autorize o acesso a dispositivos Bluetooth" e ia procurar um botão de
     * permissão que já estava concedido. Agora quem traduz é [falhaDaVarreduraLe].
     */
    override suspend fun discover(
        profile: PrinterDriverProfile,
        onDiscovered: (BlePrinterHandle) -> Unit,
    ): List<BlePrinterHandle> =
        when (val resultado = varrer(profile, onDiscovered)) {
            is ResultadoDaVarreduraLe.Encontradas -> resultado.anunciantes
            is ResultadoDaVarreduraLe.Vazia -> {
                falhaDaVarreduraLe(resultado.causa)?.let { falha -> throw ThermalPortException(falha) }
                emptyList()
            }
        }

    /**
     * Lê os fatos do adaptador e deixa a decisão com [impedimentoDaVarreduraLe].
     *
     * A política do app hospedeiro ([BluetoothLeScanPolicy]) é decidida antes de chegar aqui: esta
     * porta não conhece versão de Android nem loja, e por isso passa `true` naquele fato.
     *
     * **Sem prova automatizada**: a leitura do adaptador em si. `BluetoothAdapter` responde "Stub!"
     * na JVM de teste, então o que os testes exercem é a decisão a partir dos fatos.
     */
    override suspend fun varrer(
        profile: PrinterDriverProfile,
        onDiscovered: (BlePrinterHandle) -> Unit,
    ): ResultadoDaVarreduraLe =
        withContext(Dispatchers.IO) {
            close()
            discovered.clear()
            impedimentoDaVarreduraLe(
                modeloFalaBluetoothLe = profile.supports(PrinterTransport.BLUETOOTH_LE),
                hospedeiroPermiteVarrer = true,
                radioPresente = adapter != null,
                radioLigado = adapter?.isEnabled == true,
                temPermissaoDeVarredura = temPermissaoDeVarredura(),
                varredorPresente = adapter?.bluetoothLeScanner != null,
            )?.let { causa -> return@withContext ResultadoDaVarreduraLe.Vazia(causa) }
            // Segunda leitura de `bluetoothLeScanner`, e ela não é estável: o getter devolve `null`
            // com o rádio desligado. Entre o `impedimentoDaVarreduraLe` acima e esta linha cabe a
            // pessoa desligar o Bluetooth pela cortina do sistema — e um `requireNotNull` aqui
            // lançaria `IllegalArgumentException`, que não é `ThermalPortException` e por isso
            // atravessaria `withContext` e `mutex.withLock` inteiros para sair da função suspensa
            // do kit, em vez de virar `Failed`. É exatamente o estouro que o resultado tipado veio
            // acabar. Sem varredor, a saída é a causa que já existe para isso.
            val scanner =
                adapter?.bluetoothLeScanner
                    ?: return@withContext ResultadoDaVarreduraLe.Vazia(
                        CausaDaVarreduraLeVazia.SemVarredorNoAparelho,
                    )
            val found = linkedMapOf<String, BlePrinterHandle>()
            var acceptingResults = true
            val callback =
                object : ScanCallback() {
                    override fun onScanResult(callbackType: Int, result: ScanResult) {
                        // O filtro do sistema perde anúncio que traz o serviço só no scan
                        // response, então a triagem acontece aqui.
                        val services = result.scanRecord?.serviceUuids?.map { it.uuid }.orEmpty()
                        val presentation =
                            bleCandidatePresentation(
                                advertisedName = result.scanRecord?.deviceName,
                                deviceName = runCatching { result.device.name }.getOrNull(),
                                services = services,
                            )
                        synchronized(found) {
                            if (!acceptingResults) return@synchronized
                            val address = result.device.address
                            val previous = found[address]
                            val handle =
                                BlePrinterHandle(
                                    id = previous?.id ?: nextHandleId(),
                                    label =
                                        presentation.name
                                            ?: previous?.label
                                            ?: "Aparelho sem nome ${found.size + 1}",
                                    discoveryAddress = address,
                                    isLikelyPrinter =
                                        previous?.isLikelyPrinter == true ||
                                            presentation.isLikelyPrinter,
                                    named = presentation.name != null || previous?.named == true,
                                )
                            if (handle != previous) {
                                discovered[handle.id] = result.device
                                found[address] = handle
                                onDiscovered(handle)
                            }
                        }
                    }
                }
            try {
                scanner.startScan(
                    emptyList(),
                    ScanSettings.Builder()
                        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                        .build(),
                    callback,
                )
                Thread.sleep(scanMillis)
            } catch (failure: SecurityException) {
                throw ThermalPortException(ThermalPortFailure.BluetoothPermissionDenied, failure)
            } finally {
                synchronized(found) { acceptingResults = false }
                runCatching { scanner.stopScan(callback) }
            }
            val anunciantes = synchronized(found) { found.values.toList() }
            if (anunciantes.isEmpty()) {
                // A única saída vazia em que o rádio de fato trabalhou. A ação de quem está no
                // balcão é aproximar a impressora e conferir se ela está ligada — e era essa a
                // frase que faltava, porque as outras cinco saídas vazias diziam o mesmo.
                ResultadoDaVarreduraLe.Vazia(CausaDaVarreduraLeVazia.NinguemAnunciou(scanMillis))
            } else {
                ResultadoDaVarreduraLe.Encontradas(anunciantes)
            }
        }

    override suspend fun open(
        handle: BlePrinterHandle,
        profile: PrinterDriverProfile,
    ) = withContext(Dispatchers.IO) {
        close()
        // O teto é desta impressora, então ele é armado junto com o canal dela. Um perfil sem teto
        // devolve `null` e a escrita continua byte a byte, exatamente como antes.
        pacer = RasterThroughputPacer(rasterThroughputOverride() ?: profile.maxRasterBytesPerSecond)
        impedimentoDeAbertura()?.let { falha -> throw ThermalPortException(falha) }
        val device = discovered[handle.id]
            ?: throw ThermalPortException(ThermalPortFailure.BluetoothDisconnected)
        val latch = CountDownLatch(1)
        connectLatch = latch
        connectFailure = null
        gatt =
            try {
                device.connectGatt(appContext, false, callback)
            } catch (failure: SecurityException) {
                throw ThermalPortException(ThermalPortFailure.BluetoothPermissionDenied, failure)
            }
        if (!latch.await(connectTimeoutMillis, TimeUnit.MILLISECONDS)) {
            close()
            throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        }
        connectFailure?.let { failure ->
            close()
            throw ThermalPortException(failure)
        }
        if (target == null) {
            close()
            throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        }
    }

    /**
     * Solta o periférico ao terminar: impressora BLE para de anunciar enquanto conectada, e
     * segurar o enlace a esconde dos outros aparelhos do balcão.
     */
    override fun close() {
        val active = gatt
        // Escrita sem confirmação só prova que a pilha local soltou o bloco. Soltar o periférico
        // aqui descarta o que ainda está na fila do rádio, e o fim do cupom some no meio de uma
        // faixa raster — o iOS espera 1,5 s pelo mesmo motivo. No modo confirmado o último
        // callback já veio da impressora, e não existe fila para drenar.
        if (unacknowledgedWriteInFlight && unacknowledgedFlushMillis > 0) {
            runCatching { Thread.sleep(unacknowledgedFlushMillis) }
        }
        unacknowledgedWriteInFlight = false
        // O ritmo pertence ao canal que está sendo solto: o próximo `open` arma o do perfil dele.
        pacer = null
        gatt = null
        target = null
        mtuPayload = DEFAULT_MTU_PAYLOAD
        // A medição publicada continua valendo depois do fecho — é justamente o trabalho que acabou
        // de sair que a tela precisa mostrar. O que zera aqui são os contadores do canal seguinte.
        negotiatedMtu = null
        bytesSinceOpen = 0L
        writeNanosSinceOpen = 0L
        writeMode = BleWriteMode.UNACKNOWLEDGED
        connectLatch = null
        writeLatch = null
        runCatching { active?.disconnect() }
        runCatching { active?.close() }
    }

    /**
     * BLE não tem controle de fluxo próprio, e "esperar a confirmação" quer dizer coisas
     * diferentes em cada modo.
     *
     * Com `WRITE_TYPE_NO_RESPONSE` o callback chega assim que a pilha do Android solta o bloco: o
     * rádio continua enviando na velocidade do enlace mesmo com o buffer da impressora cheio, e a
     * portátil 58mm descarta o excedente sem avisar. Em cupom curto isso passa; numa foto o
     * descarte cai dentro de uma faixa `GS v 0` e o resto do raster volta a ser lido como texto —
     * é o lixo ASCII com barras pretas que sai no papel. Com `WRITE_TYPE_DEFAULT` cada bloco
     * espera o ATT da própria impressora, que assim dita o ritmo. Daí a preferência pelo modo
     * confirmado, e a pausa entre blocos existir só quando ele não é oferecido — a mesma pausa
     * que o SPP usa, pelo mesmo motivo.
     */
    override fun write(data: ByteArray) {
        val active = gatt ?: throw ThermalPortException(ThermalPortFailure.BluetoothDisconnected)
        val characteristic = target
            ?: throw ThermalPortException(ThermalPortFailure.BluetoothDisconnected)
        var offset = 0
        // O cronômetro cobre a escrita inteira, freio incluído: o que a bancada precisa saber é a
        // velocidade com que os bytes chegam à impressora, não a de um bloco isolado. Ele para no
        // `finally` para que falha no meio ainda publique o que saiu até ali — trabalho que morreu
        // devagar é medição, não ausência dela.
        val comecou = System.nanoTime()
        try {
            writeBlocks(active, characteristic, data) { escritos -> offset = escritos }
        } finally {
            bytesSinceOpen += offset
            writeNanosSinceOpen += System.nanoTime() - comecou
            telemetry?.record(
                TransportMeasurement(
                    transport = PrinterTransport.BLUETOOTH_LE,
                    blockBytes = mtuPayload,
                    negotiatedMtuBytes = negotiatedMtu,
                    writeMode =
                        when (writeMode) {
                            BleWriteMode.ACKNOWLEDGED -> TransportWriteMode.ACKNOWLEDGED
                            BleWriteMode.UNACKNOWLEDGED -> TransportWriteMode.UNACKNOWLEDGED
                        },
                    bytes = bytesSinceOpen,
                    elapsedMillis = writeNanosSinceOpen / NANOS_PER_MILLI,
                ),
            )
        }
    }

    /**
     * O laço de blocos de sempre, agora com um relato de progresso.
     *
     * Ele existe separado só para o cronômetro do [write] poder fechar num `finally` sem embrulhar o
     * corpo inteiro num bloco a mais de indentação. [progress] é chamado depois de cada bloco aceito
     * — é o que permite medir também o trabalho que falhou no meio.
     */
    private fun writeBlocks(
        active: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        data: ByteArray,
        progress: (Int) -> Unit,
    ) {
        var offset = 0
        while (offset < data.size) {
            val length = minOf(mtuPayload, data.size - offset)
            // O freio entra onde os blocos já saem, antes de soltar este. Vale nos dois modos: o
            // callback confirmado prova recepção no ATT da impressora, não impressão — e é
            // justamente entre receber e imprimir que a T210 descarta linha.
            try {
                pacer?.pace(length)
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
                throw ThermalPortException(ThermalPortFailure.WriteInterrupted, interrupted)
            }
            val chunk = data.copyOfRange(offset, offset + length)
            val latch = CountDownLatch(1)
            writeLatch = latch
            val mode = writeMode
            val queued =
                try {
                    enqueue(active, characteristic, chunk, mode)
                } catch (failure: SecurityException) {
                    throw ThermalPortException(ThermalPortFailure.BluetoothPermissionDenied, failure)
                } finally {
                    chunk.fill(0)
                }
            if (!queued) {
                throw ThermalPortException(
                    if (offset == 0) {
                        ThermalPortFailure.BluetoothDisconnected
                    } else {
                        ThermalPortFailure.WriteInterrupted
                    },
                )
            }
            if (!latch.await(writeTimeoutMillis, TimeUnit.MILLISECONDS)) {
                throw ThermalPortException(ThermalPortFailure.WriteInterrupted)
            }
            offset += length
            progress(offset)
            if (mode == BleWriteMode.UNACKNOWLEDGED) {
                unacknowledgedWriteInFlight = true
                if (unacknowledgedPauseMillis > 0) {
                    try {
                        Thread.sleep(unacknowledgedPauseMillis)
                    } catch (interrupted: InterruptedException) {
                        Thread.currentThread().interrupt()
                        throw ThermalPortException(
                            ThermalPortFailure.WriteInterrupted,
                            interrupted,
                        )
                    }
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun enqueue(
        active: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        chunk: ByteArray,
        mode: BleWriteMode,
    ): Boolean {
        val writeType =
            when (mode) {
                BleWriteMode.ACKNOWLEDGED -> BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                BleWriteMode.UNACKNOWLEDGED -> BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            active.writeCharacteristic(characteristic, chunk, writeType) ==
                BluetoothGatt.GATT_SUCCESS
        } else {
            characteristic.writeType = writeType
            characteristic.value = chunk
            active.writeCharacteristic(characteristic)
        }
    }

    private val callback =
        object : BluetoothGattCallback() {
            override fun onConnectionStateChange(
                active: BluetoothGatt,
                status: Int,
                newState: Int,
            ) {
                when {
                    newState == BluetoothGatt.STATE_CONNECTED -> {
                        // `requestMtu` recusado devolve `false` sem lançar e sem chamar
                        // `onMtuChanged`: sem seguir para a descoberta aqui, a conexão morre no
                        // timeout em vez de imprimir com o MTU mínimo.
                        val requested =
                            runCatching { active.requestMtu(requestedMtu()) }.getOrDefault(false)
                        if (!requested) runCatching { active.discoverServices() }
                    }
                    newState == BluetoothGatt.STATE_DISCONNECTED -> {
                        connectFailure = ThermalPortFailure.BluetoothDisconnected
                        connectLatch?.countDown()
                        writeLatch?.countDown()
                    }
                }
            }

            override fun onMtuChanged(active: BluetoothGatt, mtu: Int, status: Int) {
                // Três bytes do MTU são cabeçalho ATT.
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    mtuPayload = (mtu - ATT_HEADER_BYTES).coerceAtLeast(DEFAULT_MTU_PAYLOAD)
                    negotiatedMtu = mtu
                }
                runCatching { active.discoverServices() }
            }

            override fun onServicesDiscovered(active: BluetoothGatt, status: Int) {
                target =
                    BlePrinterProfile.SERVICES
                        .asSequence()
                        .mapNotNull { service -> active.getService(service) }
                        .mapNotNull { service ->
                            service.getCharacteristic(
                                BlePrinterProfile.characteristicFor(service.uuid),
                            )
                        }
                        .firstOrNull()
                val preference = bleWritePreference()
                writeMode =
                    target
                        ?.let { characteristic ->
                            bleWriteMode(characteristic.properties, preference)
                        }
                        ?: BleWriteMode.UNACKNOWLEDGED
                if (target == null) connectFailure = ThermalPortFailure.PrinterUnavailable
                connectLatch?.countDown()
            }

            override fun onCharacteristicWrite(
                active: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int,
            ) {
                writeLatch?.countDown()
            }
        }

    /**
     * O MTU que este `open` vai pedir, dentro do que o ATT admite.
     *
     * Um valor fora da faixa cai no padrão em vez de virar chamada malformada: o botão é de bancada,
     * e bancada com transporte quebrado não mede nada.
     */
    private fun requestedMtu(): Int =
        bleMtuPreference()?.takeIf { it in BLE_MTU_RANGE } ?: PREFERRED_MTU

    /**
     * O que impede este canal de sequer abrir; `null` quando dá para tentar.
     *
     * Reusa a mesma decisão da varredura porque os fatos que barram são os mesmos — e reusá-la é o
     * que garante que `open` e `discover` não voltem a discordar sobre o que é permissão e o que é
     * rádio desligado. O modelo e o varredor não entram: abrir um canal não varre nada.
     */
    private fun impedimentoDeAbertura(): ThermalPortFailure? =
        impedimentoDaVarreduraLe(
            modeloFalaBluetoothLe = true,
            hospedeiroPermiteVarrer = true,
            radioPresente = adapter != null,
            radioLigado = adapter?.isEnabled == true,
            temPermissaoDeVarredura = temPermissaoDeVarredura(),
            varredorPresente = true,
        )?.let(::falhaDaVarreduraLe)

    /**
     * Só a permissão — o estado do rádio é outro fato, e misturá-los era o defeito.
     *
     * `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` só existem como permissão em tempo de execução a partir
     * do Android 12.
     */
    private fun temPermissaoDeVarredura(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
            .all { permission ->
                ContextCompat.checkSelfPermission(appContext, permission) ==
                    PackageManager.PERMISSION_GRANTED
            }
    }

    private fun nextHandleId(): Long {
        val id = nextId.getAndUpdate { current -> if (current == Long.MAX_VALUE) 1 else current + 1 }
        return id.coerceAtLeast(1)
    }

    private companion object {
        const val DEFAULT_SCAN_MILLIS = 6_000L
        const val DEFAULT_CONNECT_TIMEOUT_MILLIS = 12_000L
        const val DEFAULT_WRITE_TIMEOUT_MILLIS = 5_000L
        const val DEFAULT_UNACKNOWLEDGED_PAUSE_MILLIS = 20L
        const val DEFAULT_UNACKNOWLEDGED_FLUSH_MILLIS = 1_500L
        const val PREFERRED_MTU = BLE_PREFERRED_MTU
        const val ATT_HEADER_BYTES = 3
        const val DEFAULT_MTU_PAYLOAD = 20
        const val NANOS_PER_MILLI = 1_000_000L
    }
}
