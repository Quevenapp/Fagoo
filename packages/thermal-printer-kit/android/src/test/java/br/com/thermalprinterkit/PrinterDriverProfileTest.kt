package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterDriverProfileTest {
    @Test
    fun `todo card de catálogo oferece os quatro transportes para descoberta`() {
        BundledPrinterDrivers.all.forEach { profile ->
            assertEquals(PrinterTransport.entries.toSet(), profile.transports)
        }
    }

    @Test
    fun `catálogo usa somente descoberta conservadora sem configuração homologada`() {
        val profile = BundledPrinterDrivers.elginI9Full2

        assertEquals(EscPosDialect.EPSON_COMPATIBLE, profile.dialect)
        assertEquals(PrinterStatusProtocol.NONE, profile.statusProtocol)
        assertEquals(null, profile.codePage)
        assertFalse(profile.hasCutter)
        assertEquals(9_100, profile.tcpPort)
        assertTrue(profile.supports(PrinterTransport.LOCAL_WIFI))
        assertTrue(profile.supports(PrinterTransport.USB))
        assertTrue(profile.supports(PrinterTransport.BLUETOOTH))
        assertTrue(profile.supports(PrinterTransport.BLUETOOTH_LE))
    }

    @Test
    fun `um perfil embutido não pode virar uma sonda de rede arbitrária`() {
        assertThrows(IllegalArgumentException::class.java) {
            PrinterDriverProfile(
                id = "other.brand.model",
                revision = 1,
                displayName = "Outro modelo",
                transports = setOf(PrinterTransport.LOCAL_WIFI),
                printableColumns = 48,
                printableDots = 576,
                hasCutter = true,
                cutProtocol = CutProtocol.GS_V,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
                statusProtocol = PrinterStatusProtocol.DLE_EOT,
                network = PrinterNetworkProfile(tcpPort = 22),
            )
        }
    }

    /** A largura serve ao primeiro teste; o restante será medido novamente em papel. */
    @Test
    fun `perfil portátil mantém geometria e aceita todas as conexões`() {
        val profile = BundledPrinterDrivers.portable58mm

        assertTrue(profile.supports(PrinterTransport.BLUETOOTH))
        assertTrue(profile.supports(PrinterTransport.LOCAL_WIFI))
        assertTrue(profile.supports(PrinterTransport.USB))
        assertEquals(9_100, profile.tcpPort)
        assertTrue(profile.acceptsTcpPort(9_100))
        assertEquals(32, profile.printableColumns)
        assertEquals(384, profile.printableDots)
        assertFalse(profile.hasCutter)
    }

    @Test
    fun `a wifi profile cannot omit its network parameters`() {
        assertThrows(IllegalArgumentException::class.java) {
            PrinterDriverProfile(
                id = "broken.wifi.model",
                revision = 1,
                displayName = "Sem rede",
                transports = setOf(PrinterTransport.LOCAL_WIFI),
                printableColumns = 48,
                printableDots = 576,
                hasCutter = true,
                cutProtocol = CutProtocol.GS_V,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
                statusProtocol = PrinterStatusProtocol.DLE_EOT,
            )
        }
    }

    @Test
    fun `a profile without wifi cannot declare network parameters`() {
        assertThrows(IllegalArgumentException::class.java) {
            PrinterDriverProfile(
                id = "broken.bluetooth.model",
                revision = 1,
                displayName = "Bluetooth com porta",
                transports = setOf(PrinterTransport.BLUETOOTH),
                printableColumns = 32,
                printableDots = 384,
                hasCutter = false,
                cutProtocol = CutProtocol.NONE,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
                statusProtocol = PrinterStatusProtocol.DLE_EOT,
                network = PrinterNetworkProfile(tcpPort = 9_100),
            )
        }
    }

    @Test
    fun `nenhum card preserva corte página ou status da homologação antiga`() {
        BundledPrinterDrivers.all.forEach { perfil ->
            assertFalse(perfil.hasCutter)
            assertEquals(CutProtocol.NONE, perfil.cutProtocol)
            assertEquals(0, perfil.cutFeedLines)
            assertNull(perfil.codePage)
            assertEquals(PrinterStatusProtocol.NONE, perfil.statusProtocol)
        }
    }

    /** Guilhotina e protocolo de corte andam juntos: um sem o outro é estado que não existe. */
    @Test
    fun `todo perfil com guilhotina sabe cortar`() {
        BundledPrinterDrivers.all.forEach { perfil ->
            assertEquals(
                "perfil ${perfil.id} discorda de si mesmo sobre o corte",
                perfil.hasCutter,
                perfil.cutProtocol != CutProtocol.NONE,
            )
        }
    }
}
