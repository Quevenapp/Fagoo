package br.com.thermalprinterkit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import java.util.UUID

sealed interface PersistedPrinterSelection {
    val profileId: String

    /** O transporte pertence à instalação; várias unidades podem usar o mesmo meio físico. */
    val transport: PrinterTransport

    /**
     * Identidade física da unidade, quando o transporte a conhece.
     *
     * **Interna e nunca observável.** É endereço Bluetooth, endpoint de rede ou VID/PID/serial —
     * exatamente o que o `AGENTS.md` proíbe em log, erro, `toString` e telemetria. Ela existe aqui
     * por um motivo só: distinguir duas unidades que compartilham o mesmo perfil. Quem precisa
     * falar de uma instalação para fora usa [installationId], que é derivado e opaco.
     */
    val physicalIdentity: String?

    /**
     * Identificador estável e opaco desta instalação.
     *
     * Perfil mais um resumo da identidade física. Foi isto que faltou: a instalação era chaveada
     * só pelo perfil, então adotar uma segunda unidade do mesmo modelo **apagava a primeira em
     * silêncio** — sem confirmação, sem aviso, e levando junto uma instalação que uma pessoa tinha
     * confirmado no papel.
     *
     * Sem identidade conhecida, cai no perfil sozinho — que é o comportamento antigo e o correto
     * para esse caso: readotar a mesma impressora sem endereço precisa substituir, não empilhar
     * duplicatas.
     *
     * O resumo é hash truncado, não o endereço: este valor atravessa a superfície e pode aparecer
     * em `AdoptedPrinter`.
     */
    val installationId: String
        get() = physicalIdentity?.let { "$profileId#${identityDigest(it)}" } ?: profileId

    data class Usb(
        override val profileId: String,
        val identity: UsbConnectionIdentity? = null,
    ) : PersistedPrinterSelection {
        init {
            require(isPersistentPrinterProfileId(profileId)) { "Identificador de perfil inválido." }
        }

        override val transport = PrinterTransport.USB

        override val physicalIdentity: String?
            get() = identity?.let { "usb:${it.vendorId}:${it.productId}:${it.serialNumber.orEmpty()}" }

        override fun toString(): String = "Usb(profileId=$profileId, identity=[REDACTED])"
    }

    /** O endereço confirmado permite reencontrar o mesmo aparelho entre os pareados. */
    data class Bluetooth(
        override val profileId: String,
        val address: String? = null,
    ) : PersistedPrinterSelection {
        init {
            require(isPersistentPrinterProfileId(profileId)) { "Identificador de perfil inválido." }
        }

        override val transport = PrinterTransport.BLUETOOTH

        override val physicalIdentity: String?
            get() = address?.let { "bt:$it" }

        init {
            require(address == null || isBluetoothAddress(address)) { "Endereço Bluetooth inválido." }
        }

        override fun toString(): String = "Bluetooth(profileId=$profileId, address=[REDACTED])"
    }

    /** Bluetooth LE reencontra pelo endereço estável anunciado pelo aparelho confirmado. */
    data class BluetoothLe(
        override val profileId: String,
        val address: String? = null,
    ) : PersistedPrinterSelection {
        init {
            require(isPersistentPrinterProfileId(profileId)) { "Identificador de perfil inválido." }
        }

        override val transport = PrinterTransport.BLUETOOTH_LE

        override val physicalIdentity: String?
            get() = address?.let { "ble:$it" }

        init {
            require(address == null || isBluetoothAddress(address)) { "Endereço Bluetooth LE inválido." }
        }

        override fun toString(): String = "BluetoothLe(profileId=$profileId, address=[REDACTED])"
    }

    data class LocalWifi(
        override val profileId: String,
        val endpoint: PersistedNetworkEndpoint? = null,
    ) : PersistedPrinterSelection {
        init {
            require(isPersistentPrinterProfileId(profileId)) { "Identificador de perfil inválido." }
        }

        override val transport = PrinterTransport.LOCAL_WIFI

        override val physicalIdentity: String?
            get() = endpoint?.let { "wifi:${it.ipv4Address}:${it.port}" }

        override fun toString(): String = "LocalWifi(profileId=$profileId, endpoint=[REDACTED])"
    }
}

data class UsbConnectionIdentity(
    val vendorId: Int,
    val productId: Int,
    val serialNumber: String? = null,
) {
    init {
        require(vendorId in 0..0xffff && productId in 0..0xffff) { "Identidade USB inválida." }
        require(serialNumber == null || serialNumber.isSafePersistedIdentity()) { "Serial USB inválido." }
    }

    override fun toString(): String = "UsbConnectionIdentity([REDACTED])"
}

data class PersistedNetworkEndpoint(
    val ipv4Address: String,
    val port: Int,
) {
    init {
        require(LocalWifiPrinterEndpoint.isPrivateIpv4Literal(ipv4Address)) { "Endpoint Wi-Fi inválido." }
        require(port in LocalWifiPrinterEndpoint.MIN_TCP_PORT..LocalWifiPrinterEndpoint.MAX_TCP_PORT) {
            "Porta Wi-Fi inválida."
        }
    }

    override fun toString(): String = "PersistedNetworkEndpoint([REDACTED])"
}

/**
 * Resumo curto e estável da identidade física, para poder sair do kit sem levar o endereço junto.
 *
 * SHA-256 truncado. Não é segredo criptográfico — é anti-vazamento: `AdoptedPrinter` atravessa a
 * superfície e chega ao app hospedeiro, e o `AGENTS.md` proíbe endereço, MAC e serial fora do
 * store cifrado. Doze hex bastam para separar as impressoras de um balcão sem reconstruir o MAC.
 */
internal fun identityDigest(value: String): String =
    MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .take(6)
        .joinToString("") { byte -> "%02x".format(byte) }

private fun String.isSafePersistedIdentity(): Boolean =
    isNotBlank() && length <= 256 && none(Char::isISOControl)

private fun isBluetoothAddress(value: String): Boolean =
    value.matches(Regex("[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}"))

/** Apenas slug publicado neutro ou UUID local; identidade física fica em campos separados. */
internal fun isPersistentPrinterProfileId(value: String): Boolean {
    val localUuid = runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)
    if (localUuid) return true
    return isPublishedPrinterProfileId(value)
}

/** Slug publicável de perfil embutido, sem o escape de UUID reservado a medição local. */
internal fun isPublishedPrinterProfileId(value: String): Boolean {
    if (!value.matches(Regex("[a-z0-9][a-z0-9._-]{2,79}"))) return false
    if (value.startsWith("temporary.")) return false
    if (TECHNICAL_PROFILE_ID_TOKEN.containsMatchIn(value)) return false
    if (IPV4_IN_PROFILE_ID.containsMatchIn(value)) return false
    if (MAC_IN_PROFILE_ID.containsMatchIn(value)) return false
    if (UUID_IN_PROFILE_ID.containsMatchIn(value)) return false
    if (USB_VID_PID_IN_PROFILE_ID.containsMatchIn(value)) return false
    if (LABELED_VID_PID_IN_PROFILE_ID.containsMatchIn(value)) return false
    if (COMPACT_TECHNICAL_ID_IN_PROFILE_ID.containsMatchIn(value)) return false
    return true
}

private val TECHNICAL_PROFILE_ID_TOKEN =
    Regex("(?:^|[._-])(?:ip|mac|vid|pid|uuid|peripheral|endpoint|serial)(?:[._-]|$)")
private val IPV4_IN_PROFILE_ID = Regex("(?:^|[^0-9])(?:[0-9]{1,3}\\.){3}[0-9]{1,3}(?:$|[^0-9])")
private val MAC_IN_PROFILE_ID = Regex("(?:^|[^0-9a-f])(?:[0-9a-f]{2}[-:]){5}[0-9a-f]{2}(?:$|[^0-9a-f])")
private val UUID_IN_PROFILE_ID =
    Regex("(?:^|[^0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:$|[^0-9a-f])")
private val USB_VID_PID_IN_PROFILE_ID =
    Regex("usb[._-]?[0-9a-f]{4}[._-]?[0-9a-f]{4}")
private val LABELED_VID_PID_IN_PROFILE_ID =
    Regex(
        "(?:vid[._-]?[0-9a-f]{4}.*pid[._-]?[0-9a-f]{4}|" +
            "pid[._-]?[0-9a-f]{4}.*vid[._-]?[0-9a-f]{4})",
    )
private val COMPACT_TECHNICAL_ID_IN_PROFILE_ID =
    Regex("(?:mac|device|peripheral|serial|endpoint)[._-]?[0-9a-f]{12,}")

/**
 * Impressoras confirmadas neste aparelho e qual instalação recebe os cupons.
 * Nenhum cupom, código, QR ou token é preservado.
 */
data class PersistedPrinterSelections(
    val selections: List<PersistedPrinterSelection> = emptyList(),
    val active: PrinterTransport? = null,
    val activeProfileId: String? = null,
    /**
     * Qual **unidade** recebe os cupons.
     *
     * `activeProfileId` sozinho deixou de bastar quando duas instalações podem compartilhar perfil:
     * ele apontaria para as duas. Continua gravado para não quebrar quem lê o formato antigo.
     */
    val activeInstallationId: String? = null,
) {
    init {
        // Antes esta invariante era por perfil, e era ela que traduzia "duas unidades do mesmo
        // modelo" em "uma some". Duas MTP-II num balcão são duas instalações legítimas; o que não
        // pode repetir é a mesma unidade.
        require(selections.map(PersistedPrinterSelection::installationId).distinct().size == selections.size) {
            "Cada instalação precisa apontar para uma unidade diferente."
        }
        require(active == null || selections.any { it.transport == active }) {
            "O transporte ativo precisa ter uma impressora confirmada."
        }
        require(activeProfileId == null || selections.any { it.profileId == activeProfileId }) {
            "O perfil ativo precisa pertencer a uma impressora confirmada."
        }
        require(
            activeInstallationId == null || selections.any { it.installationId == activeInstallationId },
        ) {
            "A instalação ativa precisa pertencer a uma impressora confirmada."
        }
    }

    fun of(transport: PrinterTransport): PersistedPrinterSelection? =
        activeSelection?.takeIf { it.transport == transport }
            ?: selections.firstOrNull { it.transport == transport }

    fun ofProfile(profileId: String): PersistedPrinterSelection? =
        selections.firstOrNull { it.profileId == profileId }

    /** Preciso: resolve a unidade, e não a primeira que compartilha o perfil. */
    fun ofInstallation(installationId: String): PersistedPrinterSelection? =
        selections.firstOrNull { it.installationId == installationId }

    /**
     * A impressora recém-confirmada assume como ativa: foi a última escolha consciente.
     *
     * Substitui apenas a **mesma unidade** — readotar a impressora de sempre não empilha duplicata.
     * Uma segunda unidade do mesmo modelo entra ao lado da primeira, em vez de apagá-la.
     */
    fun with(selection: PersistedPrinterSelection): PersistedPrinterSelections =
        PersistedPrinterSelections(
            selections = selections.filterNot { it.installationId == selection.installationId } + selection,
            active = selection.transport,
            activeProfileId = selection.profileId,
            activeInstallationId = selection.installationId,
        )

    fun without(transport: PrinterTransport): PersistedPrinterSelections {
        val remaining = selections.filterNot { it.transport == transport }
        return PersistedPrinterSelections(
            selections = remaining,
            active = active.takeIf { it != transport && remaining.isNotEmpty() }
                ?: remaining.firstOrNull()?.transport,
            activeProfileId = activeProfileId.takeIf { id -> remaining.any { it.profileId == id } }
                ?: remaining.firstOrNull()?.profileId,
            activeInstallationId =
                activeInstallationId.takeIf { id -> remaining.any { it.installationId == id } }
                    ?: remaining.firstOrNull()?.installationId,
        )
    }

    fun withoutProfile(profileId: String): PersistedPrinterSelections {
        val remaining = selections.filterNot { it.profileId == profileId }
        val next =
            if (activeProfileId == profileId) remaining.firstOrNull() else activeSelection
        return PersistedPrinterSelections(
            selections = remaining,
            active = next?.transport,
            activeProfileId = next?.profileId,
            activeInstallationId = next?.installationId,
        )
    }

    /**
     * Remove uma unidade só.
     *
     * Diferente de [withoutProfile], que leva junto toda instalação que compartilhe o perfil —
     * apagar a segunda MTP-II não pode desinstalar a primeira.
     */
    fun withoutInstallation(installationId: String): PersistedPrinterSelections {
        val remaining = selections.filterNot { it.installationId == installationId }
        val next =
            if (activeInstallationId == installationId) remaining.firstOrNull() else activeSelection
        return PersistedPrinterSelections(
            selections = remaining,
            active = next?.transport,
            activeProfileId = next?.profileId,
            activeInstallationId = next?.installationId,
        )
    }

    fun withoutActiveAt(transport: PrinterTransport): PersistedPrinterSelections =
        activeSelection
            ?.takeIf { it.transport == transport }
            ?.let { withoutInstallation(it.installationId) }
            ?: this

    fun activatedAt(transport: PrinterTransport): PersistedPrinterSelections =
        selections.firstOrNull { it.transport == transport }?.let(::activatedProfile) ?: this

    fun activatedProfile(selection: PersistedPrinterSelection): PersistedPrinterSelections =
        if (selections.any { it.installationId == selection.installationId }) {
            copy(
                active = selection.transport,
                activeProfileId = selection.profileId,
                activeInstallationId = selection.installationId,
            )
        } else {
            this
        }

    val activeSelection: PersistedPrinterSelection?
        get() = activeInstallationId?.let(::ofInstallation)
            ?: activeProfileId?.let(::ofProfile)
            ?: active?.let { transport -> selections.firstOrNull { it.transport == transport } }

    override fun toString(): String =
        "PersistedPrinterSelections(transportes=${selections.map(PersistedPrinterSelection::transport)}, ativo=$active)"
}

interface PrinterSelectionStore {
    fun read(): PersistedPrinterSelections

    fun save(selections: PersistedPrinterSelections)

    fun clear()
}

/**
 * O formato binário da instalação — **o que** a caixa-forte sela, separado de **qual** caixa-forte.
 *
 * Mesmo motivo que já está escrito em `AndroidPrinterProfileStore.kt` para o outro store: o formato
 * é núcleo e a caixa-forte é plataforma. Enquanto os dois moravam juntos, levar o formato para a JVM
 * de mesa arrastava o AndroidKeyStore junto — e reimplementá-lo do outro lado criaria **duas
 * verdades sobre o disco**, que é exatamente o defeito que aquele arquivo evitou. Aqui a fonte é uma
 * só, e Windows e Android não podem divergir no que gravam.
 *
 * **Isto é contrato com aparelho de outra pessoa, não código interno.** Cada byte abaixo já está
 * gravado no chaveiro de quem tem impressora adotada agora. Mudar ordem de campo, largura de inteiro
 * ou [PAYLOAD_VERSION] não deixa a suíte vermelha por acidente — deixa o app publicado sem achar a
 * impressora de alguém. Há teste que congela os bytes por literal, medidos do código publicado antes
 * desta extração; ele é o portão, e não decoração.
 *
 * O que **não** mora aqui, de propósito: chave, IV, tag, AAD, alias e namespace. Cifragem é da
 * caixa-forte, e cada plataforma tem a sua — separação que só vale enquanto o dado associado de cada
 * uma for diferente do da outra.
 *
 * **O que mudou na mudança de casa, por inteiro.** O corpo veio linha a linha de
 * `AndroidKeystorePrinterSelectionStore`, e as diferenças são três, todas necessárias e nenhuma
 * observável no disco:
 *
 * 1. `encode` e `decode` deixaram de ser `private`. A JVM de mesa é outro módulo, então `internal`
 *    não alcançaria; é a mesma visibilidade que `BinaryPrinterProfileStore` já tem, pelo mesmo
 *    motivo. Os privados de apoio continuam privados.
 * 2. `require(version in 2..PAYLOAD_VERSION)` virou `MIN_SUPPORTED_VERSION..PAYLOAD_VERSION` — o
 *    mesmo 2, com nome, para o piso da migração deixar de ser um literal solto.
 * 3. As constantes de transporte e de versão vieram junto; as de cifragem ficaram lá.
 */
object BinaryPrinterSelectionCodec {
    /**
     * A versão que se grava hoje. A leitura aceita de [MIN_SUPPORTED_VERSION] até aqui: v2 carregava
     * o transporte ativo num byte, v3 trouxe o perfil ativo e v4 trouxe a unidade ativa.
     */
    const val PAYLOAD_VERSION: Int = 4

    /** Abaixo disto não há migração escrita, e adivinhar formato antigo é inventar instalação. */
    const val MIN_SUPPORTED_VERSION: Int = 2

    /** Teto de sanidade: um registro adulterado não vira alocação de lista arbitrária. */
    const val MAX_SELECTIONS: Int = 32

    private const val NO_ACTIVE_TRANSPORT = 0
    private const val TRANSPORT_USB = 1
    private const val TRANSPORT_LOCAL_WIFI = 2
    private const val TRANSPORT_BLUETOOTH = 3
    private const val TRANSPORT_BLUETOOTH_LE = 4

    fun encode(selections: PersistedPrinterSelections): ByteArray =
        ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(PAYLOAD_VERSION)
                writeNullableUtf(output, selections.activeProfileId)
                // v4: qual unidade está ativa. `activeProfileId` sozinho ficou ambíguo quando duas
                // instalações podem compartilhar perfil.
                writeNullableUtf(output, selections.activeInstallationId)
                output.writeByte(selections.selections.size)
                selections.selections.forEach { selection -> encodeOne(output, selection) }
            }
            bytes.toByteArray()
        }

    private fun encodeOne(
        output: DataOutputStream,
        selection: PersistedPrinterSelection,
    ) {
        run {
            run {
                when (selection) {
                    is PersistedPrinterSelection.Usb -> {
                        output.writeByte(TRANSPORT_USB)
                        output.writeUTF(selection.profileId)
                        output.writeBoolean(selection.identity != null)
                        selection.identity?.let { identity ->
                            output.writeInt(identity.vendorId)
                            output.writeInt(identity.productId)
                            writeNullableUtf(output, identity.serialNumber)
                        }
                    }
                    is PersistedPrinterSelection.Bluetooth -> {
                        output.writeByte(TRANSPORT_BLUETOOTH)
                        output.writeUTF(selection.profileId)
                        writeNullableUtf(output, selection.address)
                    }
                    is PersistedPrinterSelection.BluetoothLe -> {
                        output.writeByte(TRANSPORT_BLUETOOTH_LE)
                        output.writeUTF(selection.profileId)
                        writeNullableUtf(output, selection.address)
                    }
                    is PersistedPrinterSelection.LocalWifi -> {
                        output.writeByte(TRANSPORT_LOCAL_WIFI)
                        output.writeUTF(selection.profileId)
                        output.writeBoolean(selection.endpoint != null)
                        selection.endpoint?.let { endpoint ->
                            output.writeUTF(endpoint.ipv4Address)
                            output.writeInt(endpoint.port)
                        }
                    }
                }
            }
        }
    }

    fun decode(value: ByteArray): PersistedPrinterSelections =
        DataInputStream(ByteArrayInputStream(value)).use { input ->
            val version = input.readInt()
            require(version in MIN_SUPPORTED_VERSION..PAYLOAD_VERSION)
            val activeProfileId = if (version >= 3) readNullableUtf(input) else null
            val activeInstallationId = if (version >= 4) readNullableUtf(input) else null
            val activeCode = if (version == 2) input.readUnsignedByte() else NO_ACTIVE_TRANSPORT
            val count = input.readUnsignedByte()
            require(count <= MAX_SELECTIONS)
            val selections =
                (0 until count).map {
                    decodeOne(input, version)
                }
            require(input.available() == 0)
            val active = selections.map(PersistedPrinterSelection::transport)
                .firstOrNull { transportCode(it) == activeCode }
                ?: selections.firstOrNull { it.profileId == activeProfileId }?.transport
            val resolvedProfileId =
                activeProfileId
                    ?: selections.firstOrNull { transportCode(it.transport) == activeCode }?.profileId
            return@use PersistedPrinterSelections(
                selections = selections,
                active = active,
                activeProfileId = resolvedProfileId,
                // Store gravado antes do v4 não sabia de unidade. A ativa é reconstruída a partir
                // do perfil ativo, que era a única chave que existia — e como naquele formato o
                // perfil já era único, a reconstrução é exata.
                activeInstallationId = activeInstallationId
                    ?: resolvedProfileId?.let { id ->
                        selections.firstOrNull { it.profileId == id }?.installationId
                    },
            )
        }

    private fun decodeOne(input: DataInputStream, version: Int): PersistedPrinterSelection =
        when (input.readUnsignedByte()) {
            TRANSPORT_USB -> {
                val profileId = input.readUTF()
                val identity =
                    if (version >= 2 && input.readBoolean()) {
                        UsbConnectionIdentity(input.readInt(), input.readInt(), readNullableUtf(input))
                    } else {
                        null
                    }
                PersistedPrinterSelection.Usb(profileId, identity)
            }
            TRANSPORT_BLUETOOTH ->
                PersistedPrinterSelection.Bluetooth(
                    input.readUTF(),
                    if (version >= 2) readNullableUtf(input) else null,
                )
            TRANSPORT_BLUETOOTH_LE ->
                PersistedPrinterSelection.BluetoothLe(
                    input.readUTF(),
                    if (version >= 2) readNullableUtf(input) else null,
                )
            TRANSPORT_LOCAL_WIFI -> {
                val profileId = input.readUTF()
                val endpoint =
                    if (version >= 2 && input.readBoolean()) {
                        PersistedNetworkEndpoint(input.readUTF(), input.readInt())
                    } else {
                        null
                    }
                PersistedPrinterSelection.LocalWifi(profileId, endpoint)
            }
            else -> error("Transporte de impressora inválido.")
        }

    private fun writeNullableUtf(output: DataOutputStream, value: String?) {
        output.writeBoolean(value != null)
        value?.let(output::writeUTF)
    }

    private fun readNullableUtf(input: DataInputStream): String? =
        if (input.readBoolean()) input.readUTF() else null

    private fun transportCode(transport: PrinterTransport): Int =
        when (transport) {
            PrinterTransport.USB -> TRANSPORT_USB
            PrinterTransport.LOCAL_WIFI -> TRANSPORT_LOCAL_WIFI
            PrinterTransport.BLUETOOTH -> TRANSPORT_BLUETOOTH
            PrinterTransport.BLUETOOTH_LE -> TRANSPORT_BLUETOOTH_LE
        }
}

class InMemoryPrinterSelectionStore : PrinterSelectionStore {
    private var current = PersistedPrinterSelections()

    override fun read(): PersistedPrinterSelections = current

    override fun save(selections: PersistedPrinterSelections) {
        current = selections
    }

    override fun clear() {
        current = PersistedPrinterSelections()
    }
}

/** Leitura fornecida pelo host; o kit não conhece namespace, alias, AAD nem formato legado. */
fun interface LegacyPrinterSelectionReader {
    fun readLegacyPrinterSelections(): PersistedPrinterSelections?
}

class LegacyPrinterSelectionDeletionAuthorization internal constructor()

sealed interface PrinterSelectionImportResult {
    data class Imported(
        val authorization: LegacyPrinterSelectionDeletionAuthorization,
    ) : PrinterSelectionImportResult

    data object NothingToImport : PrinterSelectionImportResult

    data class Failed(
        val reason: String,
    ) : PrinterSelectionImportResult
}

/** Grava e relê o formato neutro antes de liberar a exclusão no armazenamento do host. */
fun importLegacyPrinterSelections(
    reader: LegacyPrinterSelectionReader,
    neutralStore: PrinterSelectionStore,
): PrinterSelectionImportResult =
    runCatching {
        val legacy = reader.readLegacyPrinterSelections()
            ?: return PrinterSelectionImportResult.NothingToImport
        neutralStore.save(legacy)
        check(neutralStore.read() == legacy) {
            "O store neutro não confirmou a seleção importada."
        }
        PrinterSelectionImportResult.Imported(LegacyPrinterSelectionDeletionAuthorization())
    }.getOrElse {
        PrinterSelectionImportResult.Failed("Não foi possível confirmar a importação da seleção.")
    }
