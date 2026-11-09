package br.com.thermalprinterkit

import java.io.IOException

/** Falhas técnicas neutras compartilhadas pela porta de impressão local. */
sealed interface ThermalPortFailure {
    data object LocalWifiDisconnected : ThermalPortFailure

    data object UsbPermissionDenied : ThermalPortFailure

    data object UsbDisconnected : ThermalPortFailure

    data object BluetoothPermissionDenied : ThermalPortFailure

    data object BluetoothDisconnected : ThermalPortFailure

    /**
     * O aparelho não está pareado.
     *
     * É diferente de "caiu a conexão": o pareamento é ação do sistema, feita nos Ajustes, e sem ele
     * o `connect` falha sem imprimir nada. Medido na genérica LUOGAO, que reprovou três vezes com a
     * mensagem genérica antes de alguém perceber que faltava parear — e vai acontecer com quem usa.
     */
    data object BluetoothNotPaired : ThermalPortFailure

    data object BluetoothUnavailable : ThermalPortFailure

    data object PrinterUnavailable : ThermalPortFailure

    data object WriteInterrupted : ThermalPortFailure
}

class ThermalPortException(
    val failure: ThermalPortFailure,
    cause: Throwable? = null,
) : IOException(failure::class.simpleName, cause) {
    override fun toString(): String = "ThermalPortException(failure=${failure::class.simpleName})"
}

enum class ThermalCoverStatus {
    CLOSED,
    OPEN,
    UNKNOWN,
}

enum class ThermalPaperStatus {
    PRESENT,
    LOW,
    OUT,
    UNKNOWN,
}

/**
 * Status ESC/POS aceito somente quando a impressora devolve um byte com o layout fixo do
 * `DLE EOT`. A impressora pode intercalar blocos ASB (resposta assíncrona de `GS a`) no mesmo
 * canal; esses bytes têm o bit 1 em zero e são descartados aqui, nunca lidos como bloqueio.
 */
object EscPosStatus {
    val COVER_QUERY = byteArrayOf(0x10, 0x04, 0x02)
    val PAPER_QUERY = byteArrayOf(0x10, 0x04, 0x04)

    /** Quantos bytes vale a pena varrer antes de desistir: o bloco ASB tem 4 bytes. */
    const val MAX_RESPONSE_SCAN_BYTES = 8

    /** Bits fixos do layout Epson: bit0=0, bit1=1, bit4=1, bit7=0. */
    fun isStatusResponse(byte: Int): Boolean = byte in 0..255 && byte and LAYOUT_MASK == LAYOUT_VALUE

    fun cover(response: Int?): ThermalCoverStatus =
        when {
            response == null || !isStatusResponse(response) -> ThermalCoverStatus.UNKNOWN
            response and COVER_OPEN_MASK != 0 -> ThermalCoverStatus.OPEN
            else -> ThermalCoverStatus.CLOSED
        }

    fun paper(response: Int?): ThermalPaperStatus =
        when {
            response == null || !isStatusResponse(response) -> ThermalPaperStatus.UNKNOWN
            response and PAPER_OUT_MASK != 0 -> ThermalPaperStatus.OUT
            response and PAPER_LOW_MASK != 0 -> ThermalPaperStatus.LOW
            else -> ThermalPaperStatus.PRESENT
        }

    private const val LAYOUT_MASK = 0x93
    private const val LAYOUT_VALUE = 0x12
    private const val COVER_OPEN_MASK = 0x04
    private const val PAPER_LOW_MASK = 0x0c
    private const val PAPER_OUT_MASK = 0x60
}
