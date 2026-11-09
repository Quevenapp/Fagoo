// SPDX-License-Identifier: AGPL-3.0-only
// Adaptado do Vinki v4, código próprio autorizado para distribuição com FAGOO.
package br.com.queven.fagoo.panel

import br.com.thermalprinterkit.ReceiptLayout
import br.com.thermalprinterkit.ThermalReceiptPayload
import br.com.thermalprinterkit.ThermalTextAlignment
import br.com.thermalprinterkit.ThermalTextSize
import br.com.thermalprinterkit.ThermalTextStyle
import br.com.thermalprinterkit.receiptBytes

/**
 * Os cupons do Vinki v4, impressos pelo ThermalPrinterKit como no V2. O kit
 * recebe o cupom pronto; largura, página de código, corte e compensação
 * vertical chegam pelo [ReceiptLayout] e não são decididos aqui.
 */

/**
 * O cupom da senha: nome da loja, `SENHA`, número em corpo dobrado e, quando a
 * loja tem página pública, o QR do acompanhamento (`/s/{token_publico}`). O QR
 * leva só o token público; o de pareamento nunca entra no cupom.
 */
class FagooTicketReceipt private constructor(
    private val header: String,
    private var publicNumber: CharArray?,
    private var address: CharArray?,
) : ThermalReceiptPayload {
    override fun receiptBytes(layout: ReceiptLayout): ByteArray {
        val number = publicNumber?.concatToString() ?: error("Senha indisponível.")
        val link = address?.concatToString()
        val parts =
            buildList {
                add(layout.text(layout.wrap(header) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, ThermalTextSize.NORMAL))
                add(layout.text("SENHA\n", ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL))
                add(
                    layout.text(
                        // Corpo dobrado ocupa duas colunas por caractere; a quebra precisa saber disso.
                        layout.wrap(number, DOUBLE_SIZE) + "\n",
                        ThermalTextAlignment.CENTER,
                        ThermalTextStyle.BOLD,
                        DOUBLE_SIZE,
                    ),
                )
                if (link != null) {
                    add(requireNotNull(layout.qrRaster(link)) { "QR da senha inválido." })
                    add(
                        layout.text(
                            layout.wrap(
                                if (link.startsWith("https://wa.me/")) {
                                    "Aponte a câmera e envie a mensagem: os avisos da senha chegam no seu WhatsApp"
                                } else {
                                    "Aponte a câmera para acompanhar a senha"
                                },
                            ) + "\n",
                            ThermalTextAlignment.CENTER,
                            ThermalTextStyle.NORMAL,
                            ThermalTextSize.NORMAL,
                        ),
                    )
                }
                add(layout.finish())
            }
        return receiptBytes(parts)
    }

    override fun clear() {
        publicNumber?.fill('\u0000')
        address?.fill('\u0000')
        publicNumber = null
        address = null
    }

    /** Número e endereço não vão para log. */
    override fun toString(): String = "FagooTicketReceipt(publicNumber=[REDACTED], address=[REDACTED])"

    companion object {
        /** `GS ! 0x11`: dobro da largura e da altura. */
        private val DOUBLE_SIZE = ThermalTextSize(widthMultiplier = 2, heightMultiplier = 2)

        fun create(publicNumber: String, address: String?, header: String = "FAGOO"): FagooTicketReceipt {
            require(publicNumber.isNotBlank()) { "Senha vazia." }
            require(address == null || address.startsWith("https://")) { "Endereço inválido." }
            fun clean(value: String) = value.filter { it >= ' ' && it != '\u007f' }.take(120)
            return FagooTicketReceipt(clean(header).ifBlank { "FAGOO" }, clean(publicNumber).toCharArray(), address?.toCharArray())
        }
    }
}
