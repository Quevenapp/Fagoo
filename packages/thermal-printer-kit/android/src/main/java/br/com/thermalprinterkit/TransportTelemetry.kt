package br.com.thermalprinterkit

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Como cada bloco chegou à impressora no último trabalho — o que a confirmação prova, e nada além.
 *
 * Neutro de propósito: BLE distingue confirmado de não confirmado, e SPP, USB e Wi-Fi não têm essa
 * escolha. [NOT_APPLICABLE] é medição, não lacuna.
 */
enum class TransportWriteMode {
    /** Cada bloco esperou o ATT da impressora. Prova recepção no rádio, nunca papel. */
    ACKNOWLEDGED,

    /** O callback veio da pilha local; o rádio seguiu sozinho. */
    UNACKNOWLEDGED,

    /** O transporte não oferece a distinção. */
    NOT_APPLICABLE,
}

/**
 * Os números do transporte do último trabalho, e **só** os números.
 *
 * Não há endereço, nome, modelo nem identificador de impressora aqui, e não pode haver: esta medida
 * é para aparecer em tela de diagnóstico e viajar em relato de quem usa. O que ela responde é uma
 * pergunta que hoje ninguém consegue responder olhando o papel — a que velocidade os bytes saíram, e
 * em blocos de que tamanho.
 *
 * **Por que existe**, medido na bancada em 2026-08-20 (Samsung A07, Inico T210 por BLE): uma foto de
 * ~26 KB levou 45 s, o que dá ~0,6 KB/s. Esse número é a assinatura de escrita ATT confirmada com
 * MTU 23 — 20 bytes de carga por intervalo de conexão — e ele não aparece em lugar nenhum da tela.
 * Sem ele, "a foto sai encolhida" e "a foto sai devagar" são o mesmo relato; com ele, dá para
 * separar buffer estourando de banda que não termina antes do timeout da firmware.
 *
 * @param blockBytes carga útil de um bloco: `mtu - 3` no BLE, o tamanho fixo nos demais.
 * @param negotiatedMtuBytes MTU do enlace ATT, quando o transporte negocia um. `null` fora do BLE.
 * @param bytes total entregue ao transporte desde que o canal foi aberto.
 * @param elapsedMillis tempo gasto **dentro** da escrita, sem a espera humana entre cupons.
 */
data class TransportMeasurement(
    val transport: PrinterTransport,
    val blockBytes: Int,
    val negotiatedMtuBytes: Int?,
    val writeMode: TransportWriteMode,
    val bytes: Long,
    val elapsedMillis: Long,
) {
    /**
     * Vazão efetiva: bytes ÷ tempo, sem arredondar para um número bonito.
     *
     * `null` quando o relógio não avançou — trabalho curto demais para medir é diferente de trabalho
     * instantâneo, e fingir "infinito" seria pior que não responder.
     */
    val kilobytesPerSecond: Double?
        get() =
            if (elapsedMillis <= 0 || bytes <= 0) {
                null
            } else {
                bytes * MILLIS_PER_SECOND / (elapsedMillis * BYTES_PER_KILOBYTE)
            }

    private companion object {
        const val MILLIS_PER_SECOND = 1_000.0
        const val BYTES_PER_KILOBYTE = 1_024.0
    }
}

/**
 * O quadro de medição do transporte, escrito pela porta e lido pela tela.
 *
 * É o hospedeiro quem constrói e distribui: a mesma instância vai para as portas e para o
 * `ThermalPrinter`, e é assim que a tela de diagnóstico alcança números que nasceram dentro do
 * rádio. Quem não passa nenhuma continua sem medição, e o transporte não muda por isso — a
 * gravação é uma atribuição de campo entre blocos que já saíam.
 */
class TransportTelemetry {
    private val medicao = MutableStateFlow<TransportMeasurement?>(null)

    /** O último trabalho medido, ou `null` enquanto nenhum saiu neste processo. */
    val last: StateFlow<TransportMeasurement?> = medicao.asStateFlow()

    internal fun record(measurement: TransportMeasurement) {
        medicao.value = measurement
    }

    /** Esquece o que foi medido. Existe para a bancada separar uma sequência da seguinte. */
    fun clear() {
        medicao.value = null
    }
}

/**
 * Quem publica a medição do transporte, para a tela achá-la sem ganhar parâmetro novo.
 *
 * Mesma forma de `PrinterHomologationHost`: a tela pergunta `printer as? TransportTelemetryHost` e
 * segue sem painel quando o hospedeiro não oferece nenhum.
 */
interface TransportTelemetryHost {
    val transportTelemetry: TransportTelemetry?
}
