package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.CutProtocol
import br.com.thermalprinterkit.EscPosDialect
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.PrinterHomologationProbes
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * O dialeto da candidata sobrevive a adocao.
 *
 * **O buraco que estes testes tapam.** Em 24/08/2026 a descoberta ja passou a carregar o dialeto do
 * card, e o comprovante de teste da Diebold IM453H saiu certo. Mas `createLocal` ainda fixava
 * `EPSON_COMPATIBLE`, entao **salvar** a impressora depois da homologacao a devolvia para ESC/POS —
 * e a proxima impressao voltaria a travar o aparelho, agora sem nenhuma tela dizendo o que mudou.
 *
 * Vale reparar no formato: o mesmo defeito apareceu em tres lugares seguidos — a busca, a
 * reaplicacao de largura e a adocao. Todos com a mesma causa de fundo, que e tratar dialeto como um
 * campo com padrao razoavel. Ele nao tem padrao razoavel; ele tem dono, e o dono e o card.
 */
class DialetoNaAdocaoTest {
    private fun perfilAdotado(
        anterior: MeasuredProfile?,
        dialetoDaCandidata: EscPosDialect,
    ): MeasuredProfile =
        manualConfigurationProfile(
            previous = anterior,
            dialect = dialetoDaCandidata,
            displayName = "Diebold IM453H",
            transport = PrinterTransport.USB,
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            encoding = PrinterHomologationProbes.codePageCandidates.first { it.codePage == null },
            hasCutter = false,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            nowEpochMillis = 1_700_000_000_000,
        )

    @Test
    fun `adotar a candidata Procomp nao a devolve para ESC POS`() {
        val adotado = perfilAdotado(anterior = null, dialetoDaCandidata = EscPosDialect.PROCOMP_ESC_P)

        assertEquals(
            "A impressora homologada voltaria a falar ESC/POS depois de salva.",
            EscPosDialect.PROCOMP_ESC_P,
            adotado.dialect,
        )
    }

    @Test
    fun `a candidata comum continua em ESC POS`() {
        val adotado = perfilAdotado(anterior = null, dialetoDaCandidata = EscPosDialect.EPSON_COMPATIBLE)

        assertEquals(EscPosDialect.EPSON_COMPATIBLE, adotado.dialect)
    }

    @Test
    fun `reconfigurar um perfil ja salvo preserva o dialeto dele`() {
        val anterior =
            MeasuredProfile.createLocal(
                displayName = "Diebold IM453H",
                transports = setOf(PrinterTransport.USB),
                paperWidthMm = 80,
                printableColumns = 48,
                printableDots = 576,
                codePage = null,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 1,
                dialect = EscPosDialect.PROCOMP_ESC_P,
            )

        // A candidata chega em ESC/POS — o caso de um alvo redescoberto sem card. O perfil que ja
        // existe manda, porque ele carrega uma medicao e a candidata nao.
        val adotado = perfilAdotado(anterior = anterior, dialetoDaCandidata = EscPosDialect.EPSON_COMPATIBLE)

        assertEquals(EscPosDialect.PROCOMP_ESC_P, adotado.dialect)
    }
}
