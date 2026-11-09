package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class UsbDescriptorSignatureTest {
    private val printerInterface =
        UsbInterfaceSignature(
            id = 0,
            alternateSetting = 0,
            interfaceClass = 7,
            interfaceSubclass = 1,
            interfaceProtocol = 2,
            endpoints = listOf(UsbEndpointSignature(1, 2, 64, 0)),
        )

    @Test
    fun `mesmo endereco reciclado nao torna descritores diferentes iguais`() {
        val luogao = signature(vendorId = 1137, productId = 85)
        val mp4200 = signature(vendorId = 2843, productId = 3)

        assertNotEquals(luogao, mp4200)
    }

    @Test
    fun `copia do mesmo descritor permanece reconhecivel na enumeracao atual`() {
        val discovered = signature(vendorId = 1137, productId = 85)

        assertEquals(discovered, discovered.copy())
    }

    private fun signature(vendorId: Int, productId: Int) =
        UsbDescriptorSignature(
            vendorId = vendorId,
            productId = productId,
            deviceClass = 0,
            deviceSubclass = 0,
            deviceProtocol = 0,
            interfaces = listOf(printerInterface),
        )
}
