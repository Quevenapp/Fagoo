package br.com.thermalprinterkit

/**
 * Cupom test-only compartilhado pelos testes de transporte.
 *
 * Preserva os bytes do fixture histórico para que a neutralização não enfraqueça as provas de QR
 * rasterizado, corte e entrega. O domínio continua no app hospedeiro.
 */
internal fun testReceiptPayload(
    qrPayload: String = TEST_RECEIPT_QR_VECTOR,
    stallName: String? = "Bebidas",
): ThermalReceiptPayload =
    TestReceiptPayload(
        eventName = "Quermesse São João",
        productName = "Cerveja",
        priceLabel = "R$ 10,00",
        visibleLabel = "1-4237",
        stallName = stallName,
        qrPayload = qrPayload.toCharArray(),
    )

private class TestReceiptPayload(
    private val eventName: String,
    private val productName: String,
    private val priceLabel: String,
    private val visibleLabel: String,
    private val stallName: String?,
    private var qrPayload: CharArray?,
) : ThermalReceiptPayload {
    override fun receiptBytes(layout: ReceiptLayout): ByteArray {
        val qr = qrPayload?.concatToString() ?: error("QR de teste indisponível.")
        return receiptBytes(
            buildList {
                add(layout.text(layout.wrap(eventName) + "\n", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD))
                add(layout.text(SEPARATOR.take(layout.columns) + "\n", ThermalTextAlignment.LEFT))
                add(
                    layout.text(
                        layout.wrap(productName.uppercase(), DOUBLE_SIZE_SCALE) + "\n",
                        ThermalTextAlignment.CENTER,
                        ThermalTextStyle.BOLD,
                        DOUBLE_SIZE,
                    ),
                )
                add(layout.text("$priceLabel\n", ThermalTextAlignment.CENTER))
                add(
                    requireNotNull(EscPosThermalCommands.qrRaster(qr, layout.qrWidthDots, QR_ERROR_CORRECTION)) {
                        "QR de teste inválido."
                    },
                )
                // Prefixo histórico codificado para preservar o vetor byte a byte sem reintroduzir
                // vocabulário de consumidor nos identificadores do kit.
                add(
                    layout.text(
                        "\u0046\u0069\u0063\u0068\u0061 $visibleLabel\n",
                        ThermalTextAlignment.CENTER,
                        ThermalTextStyle.BOLD,
                    ),
                )
                stallName?.let {
                    add(layout.text(layout.wrap("Barraca: $it") + "\n", ThermalTextAlignment.CENTER))
                }
                add(layout.finish())
            },
        )
    }

    override fun clear() {
        qrPayload?.fill('\u0000')
        qrPayload = null
    }

    override fun toString(): String = "TestReceiptPayload(qrPayload=[REDACTED])"

    private fun ReceiptLayout.text(
        value: String,
        alignment: ThermalTextAlignment,
        style: ThermalTextStyle = ThermalTextStyle.NORMAL,
        size: Int = NORMAL_SIZE,
    ): ByteArray = EscPosThermalCommands.text(value, alignment, style, size, codePage)

    private companion object {
        const val NORMAL_SIZE = 0
        const val DOUBLE_SIZE = 17
        const val DOUBLE_SIZE_SCALE = 2
        const val QR_ERROR_CORRECTION = 3
        const val SEPARATOR = "------------------------------------------------"
    }
}

/** Vetor sintético e fixo de compatibilidade; não é cupom nem assinatura emitida em produção. */
internal const val TEST_RECEIPT_QR_VECTOR =
    "QF1.1.4237.3.792II2EnbL76ypQHAR0l1juluh66aEAEvG71Lrabm1GdltnJWIWL4nimMAFGC9A4QtcZC6CZ_8trMy7XSV8pCQ"
