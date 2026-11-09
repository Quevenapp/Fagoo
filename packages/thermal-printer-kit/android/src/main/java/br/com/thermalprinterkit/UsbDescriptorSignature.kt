package br.com.thermalprinterkit

import android.hardware.usb.UsbDevice

/**
 * Descritor USB mantido somente em memória para não confundir um endereço reciclado com o aparelho
 * que ocupava aquele endereço antes. Não contém serial nem caminho USB e nunca deve ser persistido
 * ou logado.
 */
internal data class UsbDescriptorSignature(
    val vendorId: Int,
    val productId: Int,
    val deviceClass: Int,
    val deviceSubclass: Int,
    val deviceProtocol: Int,
    val interfaces: List<UsbInterfaceSignature>,
) {
    internal companion object {
        fun from(device: UsbDevice): UsbDescriptorSignature =
            UsbDescriptorSignature(
                vendorId = device.vendorId,
                productId = device.productId,
                deviceClass = device.deviceClass,
                deviceSubclass = device.deviceSubclass,
                deviceProtocol = device.deviceProtocol,
                interfaces =
                    (0 until device.interfaceCount).map { interfaceIndex ->
                        val usbInterface = device.getInterface(interfaceIndex)
                        UsbInterfaceSignature(
                            id = usbInterface.id,
                            alternateSetting = usbInterface.alternateSetting,
                            interfaceClass = usbInterface.interfaceClass,
                            interfaceSubclass = usbInterface.interfaceSubclass,
                            interfaceProtocol = usbInterface.interfaceProtocol,
                            endpoints =
                                (0 until usbInterface.endpointCount).map { endpointIndex ->
                                    val endpoint = usbInterface.getEndpoint(endpointIndex)
                                    UsbEndpointSignature(
                                        address = endpoint.address,
                                        attributes = endpoint.attributes,
                                        maxPacketSize = endpoint.maxPacketSize,
                                        interval = endpoint.interval,
                                    )
                                },
                        )
                    },
            )
    }
}

internal data class UsbInterfaceSignature(
    val id: Int,
    val alternateSetting: Int,
    val interfaceClass: Int,
    val interfaceSubclass: Int,
    val interfaceProtocol: Int,
    val endpoints: List<UsbEndpointSignature>,
)

internal data class UsbEndpointSignature(
    val address: Int,
    val attributes: Int,
    val maxPacketSize: Int,
    val interval: Int,
)
