package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalPrinterState
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O defeito do iPhone 7 em 21/08, conferido deste lado e virado contrato.
 *
 * Lá foram quatro impressoras instaladas e a de rede ativa e desligada: a tela inteira ficava
 * cinza, incluindo lixeiras e "Adicionar impressora". Aqui o estado do kit é um só para todos os
 * transportes, então `busy` fazia o mesmo por construção.
 */
class PrinterUnitAvailabilityTest {
    @Test
    fun `ocupacao de um transporte nao alcanca as unidades do outro`() {
        val rede = PrinterUnitActivity(isActive = true, transportIsSending = true)
        val portatil = PrinterUnitActivity(transportIsSending = false)

        assertFalse(PrinterUnitAvailability.allowsTest(rede))
        assertFalse(PrinterUnitAvailability.allowsConfiguration(rede))

        assertTrue(PrinterUnitAvailability.allowsTest(portatil))
        assertTrue(PrinterUnitAvailability.allowsConfiguration(portatil))
        // Trocar a ativa é justamente o que a pessoa precisava fazer e não conseguia.
        assertTrue(PrinterUnitAvailability.allowsActivation(portatil))
    }

    @Test
    fun `lixeira e adicionar nao desabilitam em estado nenhum`() {
        listOf(false, true).forEach { ativa ->
            listOf(false, true).forEach { enviando ->
                listOf(false, true).forEach { comprovante ->
                    listOf(false, true).forEach { instalando ->
                        val atividade =
                            PrinterUnitActivity(
                                isActive = ativa,
                                transportIsSending = enviando,
                                receiptIsUnderwayOnTransport = comprovante,
                                setupIsOpen = instalando,
                            )
                        assertTrue("$atividade", PrinterUnitAvailability.allowsRemoval(atividade))
                        assertTrue(
                            "$atividade",
                            PrinterUnitAvailability.allowsAddingPrinter(atividade),
                        )
                    }
                }
            }
        }
    }

    @Test
    fun `envio em curso e confirmacao pendente continuam bloqueando o que precisam`() {
        val enviando = PrinterUnitActivity(transportIsSending = true)
        assertFalse(PrinterUnitAvailability.allowsTest(enviando))
        assertFalse(PrinterUnitAvailability.allowsActivation(enviando))

        // O comprovante do card move a conexão em memória do transporte, que é uma só por rádio:
        // a irmã do mesmo meio físico espera.
        val irma = PrinterUnitActivity(receiptIsUnderwayOnTransport = true)
        assertFalse(PrinterUnitAvailability.allowsTest(irma))
        assertFalse(PrinterUnitAvailability.allowsConfiguration(irma))

        val confirmando = PrinterUnitActivity(setupIsOpen = true)
        assertFalse(PrinterUnitAvailability.allowsTest(confirmando))
        assertFalse(PrinterUnitAvailability.allowsActivation(confirmando))
    }

    @Test
    fun `com nada ocupado o card continua como sempre`() {
        val parada = PrinterUnitActivity()
        assertTrue(PrinterUnitAvailability.allowsActivation(parada))
        assertTrue(PrinterUnitAvailability.allowsTest(parada))
        assertTrue(PrinterUnitAvailability.allowsConfiguration(parada))

        // A ativa continua sendo a única que não aceita ser ativada de novo.
        val ativa = PrinterUnitActivity(isActive = true)
        assertFalse(PrinterUnitAvailability.allowsActivation(ativa))
        assertTrue(PrinterUnitAvailability.allowsTest(ativa))
    }

    /** Procurar não escreve no fio, e por isso não fecha ação nenhuma. */
    @Test
    fun `so envio e conexao contam como bytes a caminho`() {
        assertTrue(ThermalPrinterState.Printing.isSendingBytes())
        assertTrue(ThermalPrinterState.Connecting.isSendingBytes())

        listOf(
            ThermalPrinterState.LocalWifiSearching,
            ThermalPrinterState.BluetoothSearching,
            ThermalPrinterState.UsbSearching,
            ThermalPrinterState.Ready,
            ThermalPrinterState.PrinterNotSelected,
            ThermalPrinterState.LocalWifiPrinterUnavailable,
        ).forEach { estado ->
            assertFalse("$estado", estado.isSendingBytes())
        }
        assertFalse((null as ThermalPrinterState?).isSendingBytes())
    }

    /** SPP e BLE têm portas separadas, mas o rádio é um só: as duas disputam o mesmo hardware. */
    @Test
    fun `spp e ble compartilham radio e nao alcancam rede nem usb`() {
        assertTrue(PrinterTransport.BLUETOOTH.sharesRadioWith(PrinterTransport.BLUETOOTH_LE))
        assertTrue(PrinterTransport.BLUETOOTH_LE.sharesRadioWith(PrinterTransport.BLUETOOTH))
        assertTrue(PrinterTransport.LOCAL_WIFI.sharesRadioWith(PrinterTransport.LOCAL_WIFI))

        assertFalse(PrinterTransport.LOCAL_WIFI.sharesRadioWith(PrinterTransport.BLUETOOTH_LE))
        assertFalse(PrinterTransport.BLUETOOTH.sharesRadioWith(PrinterTransport.USB))
        assertFalse(PrinterTransport.USB.sharesRadioWith(PrinterTransport.LOCAL_WIFI))
    }

    /**
     * A busca de outro transporte não é ocupação da tela de instalação em que a pessoa está: o
     * estado do kit é um só e sobrevive à troca de conexão.
     */
    @Test
    fun `a busca de um transporte nao ocupa a tela do outro`() {
        assertFalse(
            ThermalPrinterState.BluetoothSearching.belongsToSearchOf(
                PrinterConnectionChoice.LOCAL_NETWORK,
            ),
        )
        assertFalse(
            ThermalPrinterState.LocalWifiSearching.belongsToSearchOf(
                PrinterConnectionChoice.BLUETOOTH,
            ),
        )
        assertTrue(
            ThermalPrinterState.LocalWifiSearching.belongsToSearchOf(
                PrinterConnectionChoice.DIRECT_WIFI,
            ),
        )
        // Envio e conexão em curso valem em qualquer caminho.
        assertTrue(ThermalPrinterState.Printing.belongsToSearchOf(PrinterConnectionChoice.BLUETOOTH))
        assertTrue(
            ThermalPrinterState.Connecting.belongsToSearchOf(PrinterConnectionChoice.LOCAL_NETWORK),
        )
    }
}
