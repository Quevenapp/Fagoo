package br.com.thermalprinterkit

import java.io.IOException
import java.net.Socket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext

/** Resultado da busca deliberada na Wi-Fi atual; não expõe endereço em sua representação textual. */
sealed interface LocalWifiPrinterDiscoveryResult {
    class Candidates(
        val endpoints: List<LocalWifiPrinterEndpoint>,
        val network: LocalWifiNetwork,
    ) : LocalWifiPrinterDiscoveryResult {
        init {
            // `isSelectableEndpoint`, e não `isDiscoveryCandidate`: em Wi-Fi direto o gateway é a
            // impressora, e ele é candidato legítimo — só não entra na varredura da rede alheia.
            require(endpoints.isNotEmpty() && endpoints.all(network.subnet::isSelectableEndpoint)) {
                "Resultado Wi-Fi fora dos limites de descoberta da rede conectada."
            }
        }

        override fun toString(): String = "Candidates(count=${endpoints.size}, network=[REDACTED])"
    }

    data object WifiUnavailable : LocalWifiPrinterDiscoveryResult

    /**
     * Não há candidata — e [causa] diz se algum pacote chegou a sair da máquina.
     *
     * Era um `data object NotFound` só. "A sub-rede não gerou alvo nenhum" e "sondei 253 e ninguém
     * respondeu" saíam iguais, e a pessoa lia "Confira se a impressora está ligada e conectada ao
     * mesmo roteador Wi-Fi" mesmo quando o telefone não tinha mandado um pacote sequer.
     */
    data class NaoEncontrada(
        val causa: CausaDaBuscaWifiVazia,
    ) : LocalWifiPrinterDiscoveryResult

    companion object {
        /**
         * "Não encontrei", sem dizer por quê.
         *
         * É propriedade, e não classe, para que `LocalWifiPrinterDiscoveryResult.NotFound` continue
         * resolvendo em quem já o construía — inclusive nos testes instrumentados de `:printher`,
         * que `./gradlew test` não compila. Tirar o nome do ar quebraria código alheio sem deixar
         * nenhuma suíte desta máquina vermelha, que é o pior jeito de quebrar.
         */
        @JvmField
        val NotFound: LocalWifiPrinterDiscoveryResult =
            NaoEncontrada(CausaDaBuscaWifiVazia.NaoInformada)
    }
}

/**
 * Como a impressora está pendurada na rede. Muda a descoberta, não os bytes.
 *
 * Em [DIRECT_AP] o celular está associado ao ponto de acesso da própria impressora, então ela é o
 * gateway e não há sub-rede para varrer. Em [ROUTER_LAN] ela está no roteador do local, e aí o
 * gateway é justamente quem não se deve sondar.
 */
enum class PrinterNetworkAttachment {
    DIRECT_AP,
    ROUTER_LAN,
}

fun interface LocalWifiPrinterDiscovery {
    suspend fun findCandidates(
        profile: PrinterDriverProfile,
        attachment: PrinterNetworkAttachment,
    ): LocalWifiPrinterDiscoveryResult

    /**
     * Mantém em memória, e somente para esta Wi-Fi/CIDR, um host cujo teste não saiu no papel.
     * Assim uma porta TCP/9100 aberta que não seja impressora não prende a próxima busca nela.
     */
    fun reject(
        network: LocalWifiNetwork,
        endpoint: LocalWifiPrinterEndpoint,
    ) = Unit
}

/**
 * Busca somente no CIDR privado diretamente ligado à Wi-Fi já selecionada pelo Android. Não usa
 * DNS, multicast, socket padrão, Ethernet, dados móveis ou VPN. Uma porta TCP aberta não seleciona
 * o destino: o chamador ainda envia um teste inofensivo e pede confirmação física.
 */
class DefaultLocalWifiPrinterDiscovery(
    private val networkProvider: LocalWifiNetworkProvider,
    private val connectTimeoutMillis: Int = DEFAULT_CONNECT_TIMEOUT_MILLIS,
    private val parallelProbes: Int = DEFAULT_PARALLEL_PROBES,
) : LocalWifiPrinterDiscovery {
    private val rejectedEndpointsByNetwork =
        mutableMapOf<LocalWifiNetworkSelectionKey, MutableSet<LocalWifiPrinterEndpoint>>()

    init {
        require(connectTimeoutMillis > 0) { "Timeout de descoberta Wi-Fi inválido." }
        require(parallelProbes in 1..MAX_PARALLEL_PROBES) { "Paralelismo de descoberta Wi-Fi inválido." }
    }

    override suspend fun findCandidates(
        profile: PrinterDriverProfile,
        attachment: PrinterNetworkAttachment,
    ): LocalWifiPrinterDiscoveryResult =
        withContext(Dispatchers.IO) {
            // Recusar antes de olhar a rede. Perfil medido só-Bluetooth tem `tcpPort` nulo por
            // invariante do próprio `PrinterDriverProfile`, e o `requireNotNull` que ficava logo
            // abaixo transformava isso num IllegalArgumentException que subia por `withContext` e
            // saía da função suspensa de quem chamou — falha de programa, não resultado de busca.
            val porta = profile.tcpPort
                ?: return@withContext LocalWifiPrinterDiscoveryResult.NaoEncontrada(
                    CausaDaBuscaWifiVazia.ModeloNaoFalaWifi,
                )
            val network = networkProvider.localWifiNetwork()
                ?.takeIf(LocalWifiNetwork::stillAvailable)
                ?: return@withContext LocalWifiPrinterDiscoveryResult.WifiUnavailable
            val rejected = rejectedEndpointsFor(network)
            val foundEndpoints = mutableListOf<LocalWifiPrinterEndpoint>()
            val alvosDaRede =
                when (attachment) {
                    // Uma tentativa, no gateway. Varrer aqui é gasto sem retorno: a impressora é o
                    // próprio ponto de acesso.
                    PrinterNetworkAttachment.DIRECT_AP -> network.subnet.gatewayEndpoints(porta)
                    PrinterNetworkAttachment.ROUTER_LAN -> network.subnet.discoveryCandidates(porta)
                }
            if (alvosDaRede.isEmpty()) {
                return@withContext LocalWifiPrinterDiscoveryResult.NaoEncontrada(
                    when (attachment) {
                        // AP isolado que não publica rota: `gatewayEndpoints` volta vazio e não há
                        // para onde mandar a única sondagem do Wi-Fi direto.
                        PrinterNetworkAttachment.DIRECT_AP -> CausaDaBuscaWifiVazia.SemGatewayNoDireto
                        // Numa /30 sobram dois hosts, e os dois podem ser o telefone e o gateway.
                        PrinterNetworkAttachment.ROUTER_LAN -> CausaDaBuscaWifiVazia.SubRedeSemHostLivre
                    },
                )
            }
            val alvos = alvosDaRede.filterNot(rejected::contains)
            if (alvos.isEmpty()) {
                return@withContext LocalWifiPrinterDiscoveryResult.NaoEncontrada(
                    CausaDaBuscaWifiVazia.TodosJaRecusados(alvosDaRede.size),
                )
            }
            alvos
                .chunked(parallelProbes)
                .forEach { candidates ->
                    if (!network.stillAvailable()) {
                        return@withContext LocalWifiPrinterDiscoveryResult.WifiUnavailable
                    }
                    val found =
                        coroutineScope {
                            candidates
                                .map { endpoint -> async { endpoint.takeIf { probe(network, it) } } }
                                .awaitAll()
                                .filterNotNull()
                        }
                    if (!network.stillAvailable()) {
                        return@withContext LocalWifiPrinterDiscoveryResult.WifiUnavailable
                    }
                    foundEndpoints += found
                }
            if (foundEndpoints.isEmpty()) {
                // Aqui, e só aqui, houve pacote na rede: 1 alvo em Wi-Fi direto, até 253 na rede
                // do local. É a única saída vazia em que "confira se a impressora está ligada e
                // conectada ao mesmo roteador" é a frase certa.
                LocalWifiPrinterDiscoveryResult.NaoEncontrada(
                    CausaDaBuscaWifiVazia.NinguemRespondeu(alvos.size),
                )
            } else {
                LocalWifiPrinterDiscoveryResult.Candidates(foundEndpoints, network)
            }
        }

    override fun reject(
        network: LocalWifiNetwork,
        endpoint: LocalWifiPrinterEndpoint,
    ) {
        if (
            !network.matchesSelectionKey(network.selectionKey) ||
                !network.subnet.isSelectableEndpoint(endpoint)
        ) {
            return
        }
        synchronized(rejectedEndpointsByNetwork) {
            // A seleção não deve sobreviver à troca de Wi-Fi, mesmo somente em memória.
            rejectedEndpointsByNetwork.keys.retainAll(setOf(network.selectionKey))
            rejectedEndpointsByNetwork.getOrPut(network.selectionKey, ::mutableSetOf) += endpoint
        }
    }

    private fun rejectedEndpointsFor(network: LocalWifiNetwork): Set<LocalWifiPrinterEndpoint> =
        synchronized(rejectedEndpointsByNetwork) {
            rejectedEndpointsByNetwork.keys.retainAll(setOf(network.selectionKey))
            rejectedEndpointsByNetwork[network.selectionKey]?.toSet().orEmpty()
        }

    private fun probe(
        network: LocalWifiNetwork,
        endpoint: LocalWifiPrinterEndpoint,
    ): Boolean {
        var socket: Socket? = null
        return try {
            if (!network.stillAvailable()) return false
            socket = network.openSocket()
            socket.connect(endpoint.socketAddress(), connectTimeoutMillis)
            true
        } catch (_: IOException) {
            false
        } finally {
            runCatching { socket?.close() }
        }
    }

    private companion object {
        const val DEFAULT_CONNECT_TIMEOUT_MILLIS = 250
        const val DEFAULT_PARALLEL_PROBES = 16
        const val MAX_PARALLEL_PROBES = 32
    }
}
