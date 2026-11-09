package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Nenhum byte de uma sonda alcanca uma impressora que fala outra lingua.
 *
 * **Medido em 24/08/2026, na marra.** `PrinterHomologationProbes` monta bytes crus, sem
 * [ReceiptLayout], entao nao ha por onde o dialeto entrar: sao 24 `GS` e 20 `ESC` fixos no codigo.
 * Com a Diebold IM453H adotada — que nao tem um unico comando `GS` — a regua raster do passo de
 * altura saiu como **dois metros de codigo**, e o aparelho parou de responder ate desligar e ligar.
 *
 * O que torna isso pior que um cupom torto: eu tinha acabado de recomendar a homologacao por
 * escrito, no handover, sem conferir se as sondas falavam o dialeto. O documento estava certo sobre
 * o cupom e errado sobre o assistente, e nenhum teste dizia a diferenca.
 *
 * **A pergunta do portao mudou em 26/08/2026, e a protecao continua.** Ate entao ele olhava o alvo
 * — "esta impressora fala ESC/POS?" — e recusava a homologacao inteira, mandando quem caisse ali
 * para a configuracao manual. Agora existe [ProcompHomologationProbes], e o portao pergunta o que
 * sempre foi a pergunta certa: **estes bytes falam a lingua desta impressora?** A serie ESC/POS
 * continua sem alcancar a IM453H, que e o que esta suite existe para prender; a serie Procomp
 * alcanca, e a configuracao manual deixou de ser a unica saida.
 */
class HomologacaoRecusaDialetoTest {
    private fun sessaoPara(
        dialect: EscPosDialect,
        enviados: MutableList<ByteArray>,
    ): PrinterProbeSession =
        PrinterHomologationTarget(
            transport = PrinterTransport.USB,
            displayName = "Diebold IM453H",
            profileId = "diebold.im453h.procomp",
            paperWidthMm = 80,
            dialect = dialect,
            defaultStore = InMemoryPrinterProfileStore(),
            sender = { bytes ->
                enviados += bytes.copyOf()
                ThermalPrintResult.Printed
            },
            adopter = { },
        ).openSession()

    @Test
    fun `sonda ESC POS nao chega a uma firmware Procomp`() = runTest {
        val enviados = mutableListOf<ByteArray>()

        val resultado =
            sessaoPara(EscPosDialect.PROCOMP_ESC_P, enviados)
                .send(PrinterHomologationProbes.paperWidthRulers())

        assertTrue("A sonda foi enviada assim mesmo.", enviados.isEmpty())
        val falha = resultado as ThermalPrintResult.Failed
        assertSame(ThermalPrinterState.DialectNotSupported, falha.state)
        assertEquals(ThermalPrintDelivery.NOT_SENT, falha.delivery)
        assertTrue(
            "A mensagem nao diz que nada saiu.",
            falha.message.contains("Nada foi enviado"),
        )
    }

    @Test
    fun `sonda Procomp nao chega a uma firmware ESC POS`() = runTest {
        // O outro lado da mesma trava. Ela nao existia antes de haver duas series: o portao olhava
        // so o alvo, entao trocar o portao de lugar bastaria para a serie errada passar.
        val enviados = mutableListOf<ByteArray>()

        val resultado =
            sessaoPara(EscPosDialect.EPSON_COMPATIBLE, enviados)
                .send(ProcompHomologationProbes.paperWidthRulers())

        assertTrue("A sonda foi enviada assim mesmo.", enviados.isEmpty())
        assertSame(
            ThermalPrinterState.DialectNotSupported,
            (resultado as ThermalPrintResult.Failed).state,
        )
    }

    @Test
    fun `a mesma sonda continua saindo em ESC POS`() = runTest {
        val enviados = mutableListOf<ByteArray>()

        val resultado =
            sessaoPara(EscPosDialect.EPSON_COMPATIBLE, enviados)
                .send(PrinterHomologationProbes.paperWidthRulers())

        assertSame(ThermalPrintResult.Printed, resultado)
        assertEquals(1, enviados.size)
    }

    @Test
    fun `a serie Procomp alcanca a impressora Procomp`() = runTest {
        val enviados = mutableListOf<ByteArray>()

        val resultado =
            sessaoPara(EscPosDialect.PROCOMP_ESC_P, enviados)
                .send(ProcompHomologationProbes.paperWidthRulers())

        assertSame(ThermalPrintResult.Printed, resultado)
        assertEquals(1, enviados.size)
    }

    @Test
    fun `bytes crus continuam passando, porque a bancada os monta no dialeto certo`() = runTest {
        val enviados = mutableListOf<ByteArray>()
        // Os `ESC n` das sondas de bancada da IM453H sao exatamente este caso: bytes montados por
        // quem sabe o dialeto. Fecha-los aqui mataria o unico jeito de medir a impressora.
        val crus = ProcompEscP.reset() + byteArrayOf(0x1B, 0x6E)

        val resultado = sessaoPara(EscPosDialect.PROCOMP_ESC_P, enviados).send(crus)

        assertSame(ThermalPrintResult.Printed, resultado)
        assertEquals(1, enviados.size)
    }
}
