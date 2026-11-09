package br.com.thermalprinterkit

import org.junit.Test

class TomateFinalReceiptTest {
    @Test
    fun `comprovante final da Tomate MDK-082 medida em 58 mm`() {
        val profile = MeasuredProfile.createLocal(
            displayName = "Tomate MDK-082",
            transports = setOf(PrinterTransport.USB),
            paperWidthMm = 58,
            printableColumns = 32,
            printableDots = 384,
            codePage = ThermalCodePage.CP850,
            cutProtocol = CutProtocol.GS_V_0,
            cutFeedLines = 4,
            measuredAtEpochMillis = 1,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )
        PrinterHomologationProbes.finalReceipt(profile, null).bytes()
    }
}
