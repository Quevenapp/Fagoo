package br.com.thermalprinterkit

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.RouteInfo
import java.net.Inet4Address
import java.net.Socket

// A fronteira (`LocalWifiNetworkProvider`, `LocalWifiNetwork`, `LocalWifiNetworkSelectionKey`) e a
// política de elegibilidade foram para `LocalWifiNetwork.kt`; aqui fica só o que fala com
// `android.net`.

/**
 * Implementação Android sem SSID, BSSID, logs ou persistência. Ela aceita uma única sub-rede
 * privada diretamente conectada, com prefixo /24 a /30, e vincula cada socket ao Network escolhido.
 */
class AndroidLocalWifiNetworkProvider(
    context: Context,
) : LocalWifiNetworkProvider {
    private val connectivityManager =
        requireNotNull(context.applicationContext.getSystemService(ConnectivityManager::class.java))

    override fun localWifiNetwork(): LocalWifiNetwork? {
        val networks = connectivityManager.allNetworks
        if (networks.any(::isVpnNetwork)) return null
        return networks
            .mapNotNull(::networkIfEligible)
            .singleOrNull()
    }

    private fun networkIfEligible(network: Network): AndroidLocalWifiNetwork? {
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return null
        if (
            !LocalWifiNetworkEligibility.accepts(
                hasWifiTransport = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                hasVpnTransport = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
                hasActiveVpn = false,
                isNotVpn = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN),
                isCaptivePortal = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
            )
        ) {
            return null
        }

        val properties = connectivityManager.getLinkProperties(network) ?: return null
        val subnet = properties.directPrivateWifiSubnet() ?: return null
        return AndroidLocalWifiNetwork(network, subnet)
    }

    private fun isVpnNetwork(network: Network): Boolean =
        connectivityManager
            .getNetworkCapabilities(network)
            ?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true

    private fun isWifiNetworkCurrent(
        network: Network,
        selectionKey: LocalWifiNetworkSelectionKey,
    ): Boolean {
        val networks = connectivityManager.allNetworks
        if (networks.any(::isVpnNetwork)) return false
        return networks.any { current ->
            current == network && networkIfEligible(current)?.selectionKey == selectionKey
        }
    }

    private fun LinkProperties.directPrivateWifiSubnet(): LocalWifiSubnet? {
        val gateways =
            getRoutes()
                .asSequence()
                .mapNotNull { route -> route.ipv4GatewayOrNull()?.address }
                .toList()
        val subnets =
            linkAddresses
                .asSequence()
                .filter { linkAddress -> hasDirectIpv4Route(linkAddress) }
                .mapNotNull { linkAddress ->
                    val ipv4 = linkAddress.address as? Inet4Address ?: return@mapNotNull null
                    runCatching {
                        LocalWifiSubnet(
                            hostAddress = ipv4.address,
                            prefixLength = linkAddress.prefixLength,
                            excludedGatewayAddresses = gateways,
                        )
                    }.getOrNull()
                }.distinct()
                .toList()
        return subnets.singleOrNull()
    }

    private fun LinkProperties.hasDirectIpv4Route(linkAddress: LinkAddress): Boolean {
        val ipv4 = linkAddress.address as? Inet4Address ?: return false
        return getRoutes().any { route ->
            val destination = route.getDestination()
            route.ipv4GatewayOrNull() == null &&
                destination.getAddress() is Inet4Address &&
                destination.getPrefixLength() == linkAddress.prefixLength &&
                destination.contains(ipv4)
        }
    }

    /** `RouteInfo.hasGateway()` é API 29; o gateway IPv4 qualquer representa rota direta. */
    private fun RouteInfo.ipv4GatewayOrNull(): Inet4Address? =
        (getGateway() as? Inet4Address)?.takeUnless { address -> address.isAnyLocalAddress }

    private inner class AndroidLocalWifiNetwork(
        private val network: Network,
        override val subnet: LocalWifiSubnet,
    ) : LocalWifiNetwork {
        override val selectionKey = LocalWifiNetworkSelectionKey(network.networkHandle, subnet)

        override fun openSocket(): Socket = network.socketFactory.createSocket()

        override fun stillAvailable(): Boolean =
            isWifiNetworkCurrent(network, selectionKey)
    }
}
