package br.com.thermalprinterkit

import java.io.File
import org.junit.Test

/**
 * Gera os recursos das sondas de bissecao da IM453H: o preambulo de texto e o cupom completo.
 *
 * O cupom completo e uma reconstrucao fiel de `testReceiptBytes`, incluindo as tres linhas de
 * capacidade que o preambulo omitia e o `finish()`. O QR entra pelos bytes ja gerados, porque
 * `rasterProven()` esta `false` e `layout.qrRaster` devolve `null` — sao os mesmos bytes que
 * `layout.qrRaster` devolvia quando a linha estava destravada, e `SondaQrRealDoCupomTest` garante
 * isso.
 */
class GeraPreambuloSonda {
    @Test
    fun gera() {
        val perfil = BundledPrinterDrivers.dieboldIm453h
        val layout = ReceiptLayout.from(perfil)
        val qr = File("../android-lab/src/main/res/raw/qr_cupom_diebold.bin").readBytes()

        val titulo =
            layout.text(
                "COMPROVANTE DE TESTE\n",
                ThermalTextAlignment.CENTER,
                ThermalTextStyle.BOLD,
                ThermalTextSize.NORMAL,
            )
        val nome =
            layout.text(
                layout.wrap(perfil.displayName) + "\n\n",
                ThermalTextAlignment.CENTER,
                ThermalTextStyle.NORMAL,
                ThermalTextSize.NORMAL,
            )
        fun dados(completo: Boolean) =
            layout.text(
                "Saiu por: cabo USB\n" +
                    "Em: 24/08/2026 14:50\n" +
                    "${perfil.printableColumns} colunas | ${perfil.printableDots} dots\n" +
                    "Página: " + (perfil.codePage?.name ?: "Nenhuma") + "\n" +
                    "Codificação: ${perfil.textEncoding.receiptLabel}\n" +
                    "Corte: ${perfil.cutProtocol.capabilityName} | avanço ${perfil.cutFeedLines}\n" +
                    (
                        if (completo) {
                            PrinterHomologationProbes.verticalRasterScaleLine(layout.verticalRasterScale) +
                                PrinterHomologationProbes.nativeQrLine(perfil.nativeQrHonored) +
                                PrinterHomologationProbes.nativeBarcodeLine(perfil.nativeBarcodeHonored)
                        } else {
                            ""
                        }
                    ) +
                    "Acentos: ação, opção, São João\n",
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                ThermalTextSize.NORMAL,
            )

        val preambulo = titulo + nome + dados(completo = false)
        File("../android-lab/src/main/res/raw/preambulo_cupom_diebold.bin").writeBytes(preambulo)
        println("### preambulo = ${preambulo.size} bytes")

        val completo =
            titulo + nome + dados(completo = true) + qr + byteArrayOf('\n'.code.toByte()) + layout.finish()
        File("../android-lab/src/main/res/raw/cupom_completo_diebold.bin").writeBytes(completo)
        println("### completo = ${completo.size} bytes")
        println("### cauda apos o QR: " + completo.drop(completo.size - 24).joinToString(" ") { "%02X".format(it) })
    }
}
