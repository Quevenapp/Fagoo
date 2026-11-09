package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.TransportMeasurement
import br.com.thermalprinterkit.TransportWriteMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * As frases do painel de transporte, que é onde o caso da T210 vira número legível.
 *
 * O que a bancada precisa ler numa olhada: o MTU, o modo de escrita e a vazão. O teste fixa a grafia
 * porque é ela que vai viajar em relato de quem usa — e fixa também o que **não** pode aparecer.
 */
class PainelDeTransporteTest {
    @Test
    fun `a medida da T210 aparece com MTU, modo e vazao em uma casa decimal`() {
        val linhas =
            transportMeasurementLines(
                TransportMeasurement(
                    transport = PrinterTransport.BLUETOOTH_LE,
                    blockBytes = 20,
                    negotiatedMtuBytes = 23,
                    writeMode = TransportWriteMode.ACKNOWLEDGED,
                    bytes = 26_624,
                    elapsedMillis = 45_000,
                ),
            )

        assertEquals(
            listOf(
                "Transporte: Bluetooth LE",
                "MTU negociado: 23 bytes — blocos de 20 bytes",
                "Escrita: confirmada",
                "Vazão efetiva: 0,6 KB/s — 26,0 KB em 45,0 s",
            ),
            linhas,
        )
    }

    @Test
    fun `negociacao sem resposta se distingue do enlace que respondeu no minimo`() {
        val recusada =
            transportMeasurementLines(
                TransportMeasurement(
                    transport = PrinterTransport.BLUETOOTH_LE,
                    blockBytes = 20,
                    negotiatedMtuBytes = null,
                    writeMode = TransportWriteMode.UNACKNOWLEDGED,
                    bytes = 2_048,
                    elapsedMillis = 2_000,
                ),
            )

        // "Não negociado" é medição: quer dizer que ninguém do outro lado respondeu ao `requestMtu`,
        // e não que o MTU seja 23 por escolha.
        assertTrue(recusada.contains("MTU negociado: não negociado — blocos de 20 bytes"))
        assertTrue(recusada.contains("Escrita: sem confirmação"))
    }

    @Test
    fun `SPP nao finge escolher modo de escrita`() {
        val linhas =
            transportMeasurementLines(
                TransportMeasurement(
                    transport = PrinterTransport.BLUETOOTH,
                    blockBytes = 256,
                    negotiatedMtuBytes = null,
                    writeMode = TransportWriteMode.NOT_APPLICABLE,
                    bytes = 26_624,
                    elapsedMillis = 4_000,
                ),
            )

        assertTrue(linhas.contains("Transporte: Bluetooth SPP"))
        assertTrue(linhas.contains("Escrita: este transporte não escolhe"))
        assertTrue(linhas.contains("Vazão efetiva: 6,5 KB/s — 26,0 KB em 4,0 s"))
    }

    @Test
    fun `relogio parado diz que nao deu para medir, em vez de inventar numero`() {
        val linhas =
            transportMeasurementLines(
                TransportMeasurement(
                    transport = PrinterTransport.USB,
                    blockBytes = 512,
                    negotiatedMtuBytes = null,
                    writeMode = TransportWriteMode.NOT_APPLICABLE,
                    bytes = 64,
                    elapsedMillis = 0,
                ),
            )

        assertTrue(linhas.contains("Vazão efetiva: não deu para medir — 0,1 KB em 0,0 s"))
    }

    @Test
    fun `sessao sem impressao mostra uma frase so, e nenhuma linha de numero`() {
        assertEquals(listOf(TRANSPORT_PANEL_EMPTY), transportMeasurementLines(null))
    }

    @Test
    fun `nenhuma frase do painel promete identidade de impressora`() {
        val frases =
            transportMeasurementLines(
                TransportMeasurement(
                    transport = PrinterTransport.BLUETOOTH_LE,
                    blockBytes = 20,
                    negotiatedMtuBytes = 23,
                    writeMode = TransportWriteMode.ACKNOWLEDGED,
                    bytes = 1_024,
                    elapsedMillis = 1_000,
                ),
            ) + listOf(TRANSPORT_PANEL_TITLE, TRANSPORT_PANEL_NOTICE)

        // O painel é feito para ser fotografado e mandado por quem usa. Endereço, nome e modelo não
        // ajudam a decidir nada aqui, e vazam a impressora de uma pessoa para dentro de um relato.
        listOf("endereço:", "MAC", "serial", "modelo:", "nome:").forEach { proibido ->
            assertTrue(proibido, frases.none { it.contains(proibido) })
        }
    }
}
