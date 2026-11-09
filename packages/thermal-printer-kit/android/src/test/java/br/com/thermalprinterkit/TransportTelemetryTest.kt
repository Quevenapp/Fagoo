package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A aritmética da medição de transporte, que é o que transforma o caso da T210 em número.
 *
 * O caso de referência é o da bancada de 20/08: ~26 KB em 45 s pela Inico T210 por BLE. A conta
 * precisa devolver **0,6 KB/s** — o número que denuncia MTU 23 com escrita confirmada, 20 bytes por
 * intervalo de conexão — e não um arredondamento simpático.
 */
class TransportTelemetryTest {
    @Test
    fun `a foto de 26 KB em 45 segundos mede a vazao que denuncia o pacote minimo`() {
        val medida =
            TransportMeasurement(
                transport = PrinterTransport.BLUETOOTH_LE,
                blockBytes = 20,
                negotiatedMtuBytes = 23,
                writeMode = TransportWriteMode.ACKNOWLEDGED,
                bytes = 26_624,
                elapsedMillis = 45_000,
            )

        assertEquals(0.58, medida.kilobytesPerSecond!!, 0.01)
        // O bloco é `mtu - 3`, e é dele que sai a suspeita: 20 bytes por intervalo de conexão.
        assertEquals(20, medida.blockBytes)
    }

    @Test
    fun `trabalho curto demais para o relogio nao vira vazao infinita`() {
        val instantanea =
            TransportMeasurement(
                transport = PrinterTransport.BLUETOOTH_LE,
                blockBytes = 20,
                negotiatedMtuBytes = null,
                writeMode = TransportWriteMode.UNACKNOWLEDGED,
                bytes = 512,
                elapsedMillis = 0,
            )
        val vazia = instantanea.copy(bytes = 0, elapsedMillis = 120)

        // "Não deu para medir" é resposta; "infinito" seria mentira com cara de número.
        assertNull(instantanea.kilobytesPerSecond)
        assertNull(vazia.kilobytesPerSecond)
    }

    @Test
    fun `MTU nulo distingue negociacao recusada de enlace no minimo do ATT`() {
        val recusada =
            TransportMeasurement(
                transport = PrinterTransport.BLUETOOTH_LE,
                blockBytes = 20,
                negotiatedMtuBytes = null,
                writeMode = TransportWriteMode.ACKNOWLEDGED,
                bytes = 1_024,
                elapsedMillis = 1_000,
            )
        val negociadaNoMinimo = recusada.copy(negotiatedMtuBytes = 23)

        // Os dois enlaces mandam 20 bytes por pacote; só um deles teve resposta da impressora, e a
        // diferença é o que separa "a impressora recusou" de "ninguém pediu".
        assertEquals(recusada.blockBytes, negociadaNoMinimo.blockBytes)
        assertNull(recusada.negotiatedMtuBytes)
        assertEquals(23, negociadaNoMinimo.negotiatedMtuBytes)
    }

    @Test
    fun `SPP mede vazao sem inventar MTU nem modo de escrita`() {
        val spp =
            TransportMeasurement(
                transport = PrinterTransport.BLUETOOTH,
                blockBytes = 256,
                negotiatedMtuBytes = null,
                writeMode = TransportWriteMode.NOT_APPLICABLE,
                bytes = 26_624,
                elapsedMillis = 4_000,
            )

        assertNull(spp.negotiatedMtuBytes)
        assertEquals(TransportWriteMode.NOT_APPLICABLE, spp.writeMode)
        assertEquals(6.5, spp.kilobytesPerSecond!!, 0.01)
    }

    @Test
    fun `o quadro nasce vazio, guarda a ultima medida e sabe esquecer`() {
        val telemetria = TransportTelemetry()
        assertNull(telemetria.last.value)

        val primeira =
            TransportMeasurement(
                transport = PrinterTransport.BLUETOOTH_LE,
                blockBytes = 20,
                negotiatedMtuBytes = 23,
                writeMode = TransportWriteMode.ACKNOWLEDGED,
                bytes = 100,
                elapsedMillis = 10,
            )
        telemetria.record(primeira)
        telemetria.record(primeira.copy(bytes = 200, elapsedMillis = 20))

        assertEquals(200L, telemetria.last.value?.bytes)
        telemetria.clear()
        assertNull(telemetria.last.value)
    }

    @Test
    fun `sem quadro entregue pelo hospedeiro a impressora nao publica medicao nenhuma`() {
        val semQuadro = printer(telemetry = null)
        val quadro = TransportTelemetry()
        val comQuadro = printer(telemetry = quadro)

        assertTrue(semQuadro is TransportTelemetryHost)
        assertNull((semQuadro as TransportTelemetryHost).transportTelemetry)
        // A tela precisa alcançar exatamente a instância que as portas escrevem; uma cópia mostraria
        // um quadro sempre vazio e ninguém saberia por quê.
        assertSame(quadro, (comQuadro as TransportTelemetryHost).transportTelemetry)
    }

    private fun printer(telemetry: TransportTelemetry?): ThermalPrinter =
        createLocalWifiThermalPrinter(
            localWifiNetworkProvider = LocalWifiNetworkProvider { null },
            transportTelemetry = telemetry,
        )
}
