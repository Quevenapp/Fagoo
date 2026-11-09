package br.com.thermalprinterkit

import java.net.InetSocketAddress

/**
 * Endpoint descoberto somente na Wi-Fi local já conectada. O endereço fica em memória e não é
 * incluído em representações textuais, erros ou estado persistido.
 */
class LocalWifiPrinterEndpoint(
    address: ByteArray,
    val port: Int,
) {
    private val address = address.copyOf()

    init {
        require(isPrivateLocalWifiIpv4(this.address)) {
            "Endpoint da impressora precisa usar IPv4 privado."
        }
        require(port in MIN_TCP_PORT..MAX_TCP_PORT) { "Porta TCP de impressora inválida." }
    }

    fun socketAddress(): InetSocketAddress = InetSocketAddress(hostAddress(), port)

    /** Mostrado somente na lista efêmera de candidatas que a própria pessoa solicitou. */
    fun displayAddress(): String = hostAddress()

    fun belongsTo(subnet: LocalWifiSubnet): Boolean = subnet.contains(address)

    /** Cópia interna usada apenas para validar os limites da sub-rede antes de abrir um socket. */
    fun addressForSubnetCheck(): ByteArray = address.copyOf()

    fun isSameAddress(other: LocalWifiPrinterEndpoint): Boolean =
        address.contentEquals(other.address) && port == other.port

    override fun equals(other: Any?): Boolean = other is LocalWifiPrinterEndpoint && isSameAddress(other)

    override fun hashCode(): Int = 31 * address.contentHashCode() + port

    override fun toString(): String = "LocalWifiPrinterEndpoint([REDACTED])"

    private fun hostAddress(): String =
        address.joinToString(separator = ".") { byte -> (byte.toInt() and 0xff).toString() }

    companion object {
        const val MIN_TCP_PORT = 1
        const val MAX_TCP_PORT = 65_535

        /** Não resolve nomes: a configuração avançada aceita somente IPv4 literal. */
        fun parseIpv4Literal(
            value: String,
            port: Int,
        ): LocalWifiPrinterEndpoint? {
            val parts = value.trim().split('.')
            if (parts.size != IPV4_SIZE) return null
            val address =
                ByteArray(IPV4_SIZE) { index ->
                    val part = parts[index]
                    if (part.isEmpty() || part.length > 3 || !part.all(Char::isDigit)) return null
                    val number = part.toIntOrNull() ?: return null
                    if (number !in 0..255) return null
                    number.toByte()
                }
            return runCatching { LocalWifiPrinterEndpoint(address, port) }.getOrNull()
        }

        fun isPrivateIpv4Literal(value: String): Boolean =
            value == value.trim() && parseIpv4Literal(value, MIN_TCP_PORT) != null

        private const val IPV4_SIZE = 4
    }
}

/**
 * Uma sub-rede IPv4 privada diretamente conectada à Wi-Fi. Prefixos maiores que /24 nunca são
 * aceitos para que uma busca explícita continue pequena e não se torne uma varredura da rede do
 * estabelecimento.
 */
class LocalWifiSubnet(
    hostAddress: ByteArray,
    val prefixLength: Int,
    excludedGatewayAddresses: Iterable<ByteArray> = emptyList(),
) {
    private val hostValue = ipv4Value(hostAddress)
    private val mask = maskFor(prefixLength)
    private val networkValue = hostValue and mask
    private val broadcastValue = networkValue or (IPV4_MASK xor mask)
    private val excludedHostValues =
        buildSet {
            add(hostValue)
            excludedGatewayAddresses.forEach { gateway ->
                val gatewayValue = ipv4Value(gateway)
                if (this@LocalWifiSubnet.contains(gatewayValue)) add(gatewayValue)
            }
        }

    init {
        require(prefixLength in MIN_PREFIX_LENGTH..MAX_PREFIX_LENGTH) {
            "A busca Wi-Fi aceita somente sub-redes IPv4 de /24 a /30."
        }
        require(isPrivateLocalWifiIpv4(hostAddress)) { "A busca Wi-Fi requer IPv4 privado." }
        require(hostValue != networkValue && hostValue != broadcastValue) {
            "O endereço local Wi-Fi não pode ser rede ou broadcast."
        }
    }

    /** Gera no máximo 253 destinos e remove telefone, rede, broadcast e gateways conhecidos. */
    fun discoveryCandidates(profile: PrinterDriverProfile): List<LocalWifiPrinterEndpoint> =
        discoveryCandidates(
            requireNotNull(profile.tcpPort) { "Perfil sem porta TCP não participa da busca Wi-Fi." },
        )

    fun discoveryCandidates(port: Int): List<LocalWifiPrinterEndpoint> {
        require(port in MIN_TCP_PORT..MAX_TCP_PORT) { "Porta TCP de impressora inválida." }
        return buildList {
            for (candidate in networkValue + 1 until broadcastValue) {
                if (candidate !in excludedHostValues) {
                    add(LocalWifiPrinterEndpoint(ipv4Bytes(candidate), port))
                }
            }
        }.also { candidates ->
            check(candidates.size <= MAX_DISCOVERY_CANDIDATES) {
                "A busca Wi-Fi excedeu o limite de destinos."
            }
        }
    }

    /**
     * Os gateways desta sub-rede, como destinos de impressora.
     *
     * Em Wi-Fi direto a impressora **é** o ponto de acesso, e portanto o gateway: a GoldenSky no
     * SSID "Printer" atende na 9100 do `10.10.100.254`. Varrer 253 endereços para chegar nela é
     * gasto sem retorno — e o `.254` seria o último.
     */
    fun gatewayEndpoints(port: Int): List<LocalWifiPrinterEndpoint> {
        require(port in MIN_TCP_PORT..MAX_TCP_PORT) { "Porta TCP de impressora inválida." }
        return excludedHostValues
            .filter { it != hostValue && it > networkValue && it < broadcastValue }
            .sorted()
            .map { LocalWifiPrinterEndpoint(ipv4Bytes(it), port) }
    }

    fun contains(address: ByteArray): Boolean =
        address.size == IPV4_SIZE && contains(ipv4Value(address))

    fun contains(endpoint: LocalWifiPrinterEndpoint): Boolean = endpoint.belongsTo(this)

    /**
     * Aceita um host utilizável dentro da mesma sub-rede Wi-Fi atual, inclusive o gateway.
     *
     * O gateway fica fora da **varredura**, para ela não bater no roteador do estabelecimento —
     * mas isso é economia de sondagem, não regra de segurança, e vetar um endereço que a pessoa
     * digitou é outra coisa. Medido na bancada: com o celular associado ao AP da própria
     * impressora, a GoldenSky é o gateway `.254`, e a tela recusava o endereço certo como
     * inválido. Continuam fora só o que não é host: rede, broadcast e o próprio telefone.
     */
    fun isSelectableEndpoint(endpoint: LocalWifiPrinterEndpoint): Boolean =
        isSelectableAddress(endpoint.addressForSubnetCheck(), excludeGateways = false)

    /** Aceita somente um host que esta sub-rede geraria na busca limitada. */
    fun isDiscoveryCandidate(endpoint: LocalWifiPrinterEndpoint): Boolean =
        isSelectableAddress(endpoint.addressForSubnetCheck(), excludeGateways = true)

    fun isDiscoveryCandidate(
        endpoint: LocalWifiPrinterEndpoint,
        profile: PrinterDriverProfile,
    ): Boolean = endpoint.port == profile.tcpPort && isDiscoveryCandidate(endpoint)

    override fun equals(other: Any?): Boolean =
        other is LocalWifiSubnet &&
            networkValue == other.networkValue &&
            prefixLength == other.prefixLength

    override fun hashCode(): Int = 31 * networkValue.hashCode() + prefixLength

    override fun toString(): String = "LocalWifiSubnet([REDACTED])"

    private fun contains(candidate: Long): Boolean =
        candidate in networkValue..broadcastValue

    private fun isSelectableAddress(
        address: ByteArray,
        excludeGateways: Boolean,
    ): Boolean {
        val candidate = ipv4Value(address)
        val excluded = if (excludeGateways) excludedHostValues else setOf(hostValue)
        return candidate in (networkValue + 1) until broadcastValue && candidate !in excluded
    }

    private companion object {
        const val IPV4_SIZE = 4
        const val IPV4_MASK = 0xffff_ffffL
        const val MIN_PREFIX_LENGTH = 24
        const val MAX_PREFIX_LENGTH = 30
        const val MIN_TCP_PORT = 1
        const val MAX_TCP_PORT = 65_535
        const val MAX_DISCOVERY_CANDIDATES = 253

        fun ipv4Value(address: ByteArray): Long {
            require(address.size == IPV4_SIZE) { "Endereço da rede precisa ser IPv4." }
            return address.fold(0L) { accumulated, byte ->
                (accumulated shl 8) or (byte.toLong() and 0xff)
            }
        }

        fun ipv4Bytes(value: Long): ByteArray =
            byteArrayOf(
                (value shr 24).toByte(),
                (value shr 16).toByte(),
                (value shr 8).toByte(),
                value.toByte(),
            )

        fun maskFor(prefixLength: Int): Long {
            require(prefixLength in MIN_PREFIX_LENGTH..MAX_PREFIX_LENGTH) {
                "A busca Wi-Fi aceita somente sub-redes IPv4 de /24 a /30."
            }
            return (IPV4_MASK shl (32 - prefixLength)) and IPV4_MASK
        }
    }
}

private fun isPrivateLocalWifiIpv4(address: ByteArray): Boolean {
    if (address.size != 4) return false
    val first = address[0].toInt() and 0xff
    val second = address[1].toInt() and 0xff
    return first == 10 ||
        (first == 172 && second in 16..31) ||
        (first == 192 && second == 168)
}
