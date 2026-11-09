package br.com.thermalprinterkit.printher

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.TransportMeasurement
import br.com.thermalprinterkit.TransportTelemetryHost
import br.com.thermalprinterkit.TransportWriteMode
import java.util.Locale

/**
 * Os números do transporte do último trabalho: MTU, modo de escrita e vazão medida.
 *
 * **Por que esta tela ganhou um painel de números**, medido na bancada em 2026-08-20 (Samsung A07,
 * Inico T210 por BLE): uma foto de ~26 KB levou 45 s, e mudar o teto de vazão de bancada — sem teto,
 * 32 KB/s, 4 KB/s — não mudou nem a velocidade nem o defeito. Um freio que nunca freia é a prova de
 * que o envio já era mais lento que o menor teto, e nada na tela dizia isso. ~0,6 KB/s é a assinatura
 * de escrita confirmada com MTU 23: 20 bytes de carga por intervalo de conexão. Sem estes três
 * números, "a foto sai encolhida" e "a foto sai devagar" chegam como o mesmo relato.
 *
 * O que **não** aparece aqui, e não pode aparecer: endereço, nome, modelo ou qualquer identificador
 * da impressora. Este painel existe para viajar em relato de quem usa, e transporte não identifica
 * ninguém.
 *
 * Some inteiro quando o hospedeiro não entregou quadro de medição às portas: sem medição, um painel
 * permanentemente vazio só ensinaria que o kit está quebrado.
 */
@Composable
fun PrinterTransportPanel(
    printer: ThermalPrinter,
    modifier: Modifier = Modifier,
) {
    val telemetry = (printer as? TransportTelemetryHost)?.transportTelemetry ?: return
    val measurement by telemetry.last.collectAsStateWithLifecycle()

    PrinterDiagnosticsPanel(TRANSPORT_PANEL_TITLE, modifier) {
        Text(TRANSPORT_PANEL_NOTICE)
        transportMeasurementLines(measurement).forEach { line ->
            Text(line, modifier = Modifier.testTag("printer.diagnostics.transport.line"))
        }
    }
}

internal const val TRANSPORT_PANEL_TITLE = "Transporte do último trabalho"

internal const val TRANSPORT_PANEL_NOTICE =
    "Somente números do transporte. Endereço, nome e modelo da impressora não aparecem aqui."

internal const val TRANSPORT_PANEL_EMPTY = "Nenhum trabalho de impressão medido nesta sessão."

/**
 * As linhas do painel, fora do Compose para o teste conferir a frase e a conta.
 *
 * A vazão vem com uma casa decimal porque é isso que a bancada consegue interpretar: a diferença
 * entre 0,6 e 12,0 KB/s decide a investigação, e a terceira casa não decide nada. Quando o relógio
 * não avançou, a linha diz que não deu para medir em vez de mostrar um número inventado.
 */
internal fun transportMeasurementLines(measurement: TransportMeasurement?): List<String> {
    if (measurement == null) return listOf(TRANSPORT_PANEL_EMPTY)
    val mtu =
        measurement.negotiatedMtuBytes?.let { "$it bytes" }
            ?: "não negociado"
    val throughput =
        measurement.kilobytesPerSecond
            ?.let { "${decimal(it)} KB/s" }
            ?: "não deu para medir"
    return listOf(
        "Transporte: ${transportLabel(measurement.transport)}",
        "MTU negociado: $mtu — blocos de ${measurement.blockBytes} bytes",
        "Escrita: ${writeModeLabel(measurement.writeMode)}",
        "Vazão efetiva: $throughput — ${decimal(measurement.bytes / BYTES_PER_KILOBYTE)} KB em " +
            "${decimal(measurement.elapsedMillis / MILLIS_PER_SECOND)} s",
    )
}

private fun transportLabel(transport: PrinterTransport): String =
    when (transport) {
        PrinterTransport.LOCAL_WIFI -> "Wi-Fi local"
        PrinterTransport.USB -> "USB"
        PrinterTransport.BLUETOOTH -> "Bluetooth SPP"
        PrinterTransport.BLUETOOTH_LE -> "Bluetooth LE"
    }

/**
 * O que a confirmação prova em cada modo, dito em três palavras.
 *
 * "Confirmada" é o ATT da impressora ditando o ritmo — recepção no rádio, jamais papel. "Sem
 * confirmação" é a pilha local soltando o bloco e seguindo em frente.
 */
private fun writeModeLabel(mode: TransportWriteMode): String =
    when (mode) {
        TransportWriteMode.ACKNOWLEDGED -> "confirmada"
        TransportWriteMode.UNACKNOWLEDGED -> "sem confirmação"
        TransportWriteMode.NOT_APPLICABLE -> "este transporte não escolhe"
    }

/** Vírgula decimal, porque o painel é lido em pt-BR e o aparelho pode estar em qualquer idioma. */
private fun decimal(value: Double): String = String.format(Locale.forLanguageTag("pt-BR"), "%.1f", value)

private const val BYTES_PER_KILOBYTE = 1_024.0
private const val MILLIS_PER_SECOND = 1_000.0
