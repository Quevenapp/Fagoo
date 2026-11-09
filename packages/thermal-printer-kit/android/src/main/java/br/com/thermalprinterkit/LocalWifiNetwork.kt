package br.com.thermalprinterkit

import java.net.Socket

// O contrato de rede local — provedor, rede e chave de seleção — não é Android: é a fronteira que
// o transporte Wi-Fi usa dos dois lados. Ele saiu de `AndroidLocalWifiNetworkProvider.kt` para
// que a JVM de mesa pudesse implementá-lo com o socket dela sem carregar `android.net`. A
// implementação Android continua onde estava; aqui só mora a fronteira e a política de
// elegibilidade, que é aritmética de booleano e sempre foi verificável sem SSID/BSSID.

/** Seleciona somente uma Wi-Fi privada, local e não cativa; VPN nunca é uma rota candidata. */
fun interface LocalWifiNetworkProvider {
    fun localWifiNetwork(): LocalWifiNetwork?
}

/**
 * Socket e identidade opaca de uma Wi-Fi atualmente conectada. A descoberta e a impressão devem
 * usar [openSocket], nunca o socket padrão do processo.
 */
interface LocalWifiNetwork {
    val subnet: LocalWifiSubnet
    val selectionKey: LocalWifiNetworkSelectionKey

    fun openSocket(): Socket

    /** Verdadeiro somente enquanto esta mesma Wi-Fi e este mesmo CIDR continuam utilizáveis. */
    fun stillAvailable(): Boolean

    fun matchesSelectionKey(key: LocalWifiNetworkSelectionKey): Boolean =
        selectionKey == key && stillAvailable()
}

/** Identifica a Wi-Fi/CIDR em memória sem revelar handle de rede ou endereço. */
class LocalWifiNetworkSelectionKey constructor(
    private val networkHandle: Long,
    private val subnet: LocalWifiSubnet,
) {
    override fun equals(other: Any?): Boolean =
        other is LocalWifiNetworkSelectionKey &&
            networkHandle == other.networkHandle &&
            subnet == other.subnet

    override fun hashCode(): Int = 31 * networkHandle.hashCode() + subnet.hashCode()

    override fun toString(): String = "LocalWifiNetworkSelectionKey([REDACTED])"
}

/** Fatos de elegibilidade isolados para manter a política Wi-Fi verificável sem SSID/BSSID. */
object LocalWifiNetworkEligibility {
    fun accepts(
        hasWifiTransport: Boolean,
        hasVpnTransport: Boolean,
        hasActiveVpn: Boolean,
        isNotVpn: Boolean,
        isCaptivePortal: Boolean,
    ): Boolean = hasWifiTransport && !hasVpnTransport && !hasActiveVpn && isNotVpn && !isCaptivePortal
}
