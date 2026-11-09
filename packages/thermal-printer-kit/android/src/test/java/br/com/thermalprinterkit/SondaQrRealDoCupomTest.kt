package br.com.thermalprinterkit

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O recurso da sonda de bancada e os bytes que o cupom emitiria sao os mesmos.
 *
 * **Por que este teste existe.** Em 24/08/2026 a sonda `lab.raster.qrreal` mandou esses 12.885
 * bytes sozinhos para a IM453H e saiu **QR legivel** — os mesmos bytes que, dentro do cupom, saem
 * como rio de caractere. Essa e a medicao que tirou o bitmap, o volume, as bandas e o transporte da
 * lista de suspeitos e apontou para o estado deixado pelo texto anterior.
 *
 * O valor da sonda esta inteiro em ela ser **byte a byte igual** ao que o cupom emite. Se alguem
 * mexer no emissor Procomp, no QR ou na geometria do card e o recurso ficar para tras, a sonda
 * passa a medir outra coisa e continua parecendo a mesma — e o papel nao avisa. Este teste avisa.
 *
 * Mora no modulo do kit, e nao no `android-lab`, porque [ProcompRasterEmission] e interna.
 * Regenerar: rode este teste com `-Dsonda.regravar=true`.
 */
class SondaQrRealDoCupomTest {
    @Test
    fun `o recurso da sonda e o QR que o cupom emitiria`() {
        val perfil = BundledPrinterDrivers.dieboldIm453h
        val layout = ReceiptLayout.from(perfil)
        val esperado =
            requireNotNull(
                EscPosThermalCommands.qrRaster(
                    value = PrinterHomologationProbes.FINAL_RECEIPT_QR,
                    widthDots = layout.qrWidthDots,
                    errorCorrection = 2,
                    verticalRasterScale = layout.verticalRasterScale,
                    emission = ProcompRasterEmission(perfil.printableDots),
                ),
            )
        val recurso = File("../android-lab/src/main/res/raw/qr_cupom_diebold.bin")
        if (System.getProperty("sonda.regravar") == "true") {
            recurso.writeBytes(esperado)
        }
        assertTrue("Recurso da sonda ausente: ${recurso.absolutePath}", recurso.isFile)
        assertArrayEquals(
            "O recurso da sonda divergiu do QR do cupom. Regrave com -Dsonda.regravar=true.",
            esperado,
            recurso.readBytes(),
        )
    }
}
