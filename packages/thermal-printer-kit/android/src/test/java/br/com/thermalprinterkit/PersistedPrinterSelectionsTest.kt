package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class PersistedPrinterSelectionsTest {
    private val wifi = PersistedPrinterSelection.LocalWifi("elgin.i9full2.escpos")
    private val bluetooth = PersistedPrinterSelection.Bluetooth("generic.portable58.escpos")

    @Test
    fun `profileId recusa endpoint e identificadores técnicos antes do store`() {
        listOf(
            "192.168.1.40",
            "AA:BB:CC:DD:EE:FF",
            "VID:1234-PID:5678",
            "A8098C1A-F86E-4E58-B1D4-C41B99F9A201",
            "ip.192.168.1.40",
            "mac.aa-bb-cc-dd-ee-ff",
            "vid.1234.pid.5678",
            "peripheral.000018f0-0000-1000-8000-00805f9b34fb",
            "temporary.58.bluetooth",
            "printer.192.168.1.40",
            "device-aa-bb-cc-dd-ee-ff",
            "usb-1234-5678",
            "printer-000018f0-0000-1000-8000-00805f9b34fb",
            "printervid1234pid5678",
            "printerusb12345678",
            "deviceaabbccddeeff",
        ).forEach { technical ->
            assertThrows(IllegalArgumentException::class.java) {
                PersistedPrinterSelection.LocalWifi(technical)
            }
        }
    }

    @Test
    fun `profileId preserva slug publicado inclusive numérico e UUID local`() {
        assertEquals(
            "future.brand-model_v2",
            PersistedPrinterSelection.Usb("future.brand-model_v2").profileId,
        )
        assertEquals(
            "3nstar.pos58.escpos",
            PersistedPrinterSelection.LocalWifi("3nstar.pos58.escpos").profileId,
        )
        assertEquals(
            "00000000-0000-4000-8000-000000000051",
            PersistedPrinterSelection.Bluetooth(
                "00000000-0000-4000-8000-000000000051",
            ).profileId,
        )
    }

    /** O balcão pode ter a impressora de rede e a portátil ao mesmo tempo. */
    @Test
    fun `printers from different transports coexist`() {
        val selections = PersistedPrinterSelections().with(wifi).with(bluetooth)

        assertEquals(2, selections.selections.size)
        assertEquals(wifi, selections.of(PrinterTransport.LOCAL_WIFI))
        assertEquals(bluetooth, selections.of(PrinterTransport.BLUETOOTH))
    }

    /** Duas unidades USB/rede continuam instaladas separadamente. */
    @Test
    fun `printers on the same transport coexist`() {
        val other = PersistedPrinterSelection.LocalWifi("bematech.mp4200th.escpos")

        val selections = PersistedPrinterSelections().with(wifi).with(bluetooth).with(other)

        assertEquals(3, selections.selections.size)
        assertEquals(other, selections.of(PrinterTransport.LOCAL_WIFI))
        assertEquals(wifi, selections.ofProfile(wifi.profileId))
        assertEquals(bluetooth, selections.of(PrinterTransport.BLUETOOTH))
    }

    /** A recém-confirmada assume as senhas: foi a última escolha consciente da pessoa. */
    @Test
    fun `the newest printer becomes the active one`() {
        val selections = PersistedPrinterSelections().with(wifi).with(bluetooth)

        assertEquals(PrinterTransport.BLUETOOTH, selections.active)
        assertEquals(bluetooth, selections.activeSelection)
    }

    @Test
    fun `activating switches which printer receives the tickets`() {
        val selections =
            PersistedPrinterSelections().with(wifi).with(bluetooth)
                .activatedAt(PrinterTransport.LOCAL_WIFI)

        assertEquals(wifi, selections.activeSelection)
    }

    @Test
    fun `activating a profile distinguishes two printers on the same transport`() {
        val other = PersistedPrinterSelection.LocalWifi("bematech.mp4200th.escpos")
        val selections = PersistedPrinterSelections().with(wifi).with(other).activatedProfile(wifi)

        assertEquals(wifi, selections.activeSelection)
        assertEquals(wifi, selections.of(PrinterTransport.LOCAL_WIFI))
    }

    /** Não dá para ativar um transporte sem impressora confirmada. */
    @Test
    fun `activating an empty transport does nothing`() {
        val selections = PersistedPrinterSelections().with(wifi).activatedAt(PrinterTransport.USB)

        assertEquals(wifi, selections.activeSelection)
    }

    /** Removida a ativa, outra assume — o aparelho não fica com impressora confirmada e nenhuma ativa. */
    @Test
    fun `removing the active printer promotes another`() {
        val selections =
            PersistedPrinterSelections().with(wifi).with(bluetooth)
                .without(PrinterTransport.BLUETOOTH)

        assertEquals(wifi, selections.activeSelection)
    }

    @Test
    fun `removing the last printer leaves nothing active`() {
        val selections = PersistedPrinterSelections().with(wifi).without(PrinterTransport.LOCAL_WIFI)

        assertNull(selections.active)
        assertNull(selections.activeSelection)
    }

    @Test
    fun `the same installed profile cannot be duplicated`() {
        assertThrows(IllegalArgumentException::class.java) {
            PersistedPrinterSelections(listOf(wifi, wifi), PrinterTransport.LOCAL_WIFI)
        }
    }

    @Test
    fun `an active transport without a confirmed printer is rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            PersistedPrinterSelections(listOf(wifi), PrinterTransport.BLUETOOTH)
        }
    }

    /**
     * O endpoint confirmado vive só na instância de `LocalWifiThermalPrinter`.
     *
     * Este construtor aceitar endereço outra vez reabriria a gravação de IP em disco, mesmo que o
     * `toString` continuasse redigido; por isso a seleção persistente conhece somente o perfil.
     */
    @Test
    fun `the persisted Wi-Fi selection carries only its profile`() {
        val selection = PersistedPrinterSelection.LocalWifi("elgin.i9full2.escpos")

        assertEquals("elgin.i9full2.escpos", selection.profileId)
        assertEquals(PrinterTransport.LOCAL_WIFI, selection.transport)
    }
}
