package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.EscPosDialect
import br.com.thermalprinterkit.BundledPrinterDrivers
import br.com.thermalprinterkit.CutProtocol
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PrinterHomologationProbes
import br.com.thermalprinterkit.PrinterProfileSource
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalCodePage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ConfigurationPrinterProfilesTest {
    @Test
    fun `picker inclui medidos primeiro e remove ids duplicados`() {
        val measured = measuredProfile()
        val duplicate = measured.toDriverProfile().copy(displayName = "Duplicata simulada")

        val result =
            configurationPrinterProfiles(
                measuredProfiles = listOf(measured),
                bundledProfiles = listOf(duplicate, duplicate),
            )

        assertEquals(1, result.size)
        assertEquals(measured.displayName, result.single().displayName)
    }

    @Test
    fun `perfil temporario nunca entra no picker persistido`() {
        val temporary = MeasuredProfile.temporary(PrinterTransport.USB, 80, dialect = EscPosDialect.EPSON_COMPATIBLE)

        val result = configurationPrinterProfiles(listOf(temporary), emptyList())

        assertFalse(result.any { it.id == temporary.id })
    }

    @Test
    fun `default preserva measured e bundled com selos sem inventar procedencia`() {
        val choices =
            configurationPrinterProfileChoices(
                measuredProfiles = listOf(measuredProfile()),
                bundledProfiles = listOf(BundledPrinterDrivers.portable58mm),
            )

        assertEquals(listOf("Só neste celular", "Homologar novamente"), choices.map { it.badge })
        assertEquals(measuredProfile(), choices.first().measuredProfile)
        assertEquals(null, choices.last().measuredProfile)
        assertEquals(
            listOf(PrinterProfileSource.MEASURED, PrinterProfileSource.BUNDLED),
            choices.map { it.source },
        )
    }

    @Test
    fun `o aviso anuncia o teto real de tiras, incluindo o comprovante final`() {
        assertEquals(26, PrinterHomologationProbes.codePageCandidates.size)
        assertEquals(7, PrinterHomologationProbes.cutProtocolCandidates.size)
        assertEquals(8, MeasuredProfile.CUT_FEED_CHOICES.size)
        // Geometria não imprime; texto e página agregam as 26 candidatas numa tira só — em 58 mm
        // cada uma ocupa duas linhas, e é a tela que anuncia o número de linhas desta impressora.
        // Corte imprime os seis dialetos antes da escolha, e o avanço imprime a régua inteira: as
        // duas decisões de 12/08 que trocaram papel por medição de verdade.
        // A tira de vazão entra em toda impressora, porque o descarte de linha não avisa por
        // marca: é a primeira parcela abaixo, e é ela que fez o piso do intervalo virar quatro.
        // A tira de código nativo entra pelo mesmo argumento e pelo mesmo caminho — firmware não se
        // adivinha —, e é ela que fez o piso virar cinco.
        // As réguas de largura abrem toda medição e saem numa tira só; a régua completa de
        // geometria é a conta de quem responde "Nenhum". As duas faltavam no teto anunciado até
        // 20/08, embora a de largura já contasse no piso.
        // Largura, geometria, vazão, código nativo, página, os seis dialetos e a régua de oito
        // avanços.
        assertEquals(1 + 1 + 1 + 1 + 1 + 6 + 8, homologationProbePaperTestCount())
        assertEquals(20, homologationPaperTestCount())
        assertEquals(5, MINIMUM_PAPER_TEST_COUNT)
        assertEquals("São de 5 a 20 tiras curtas de teste.", paperCostHeadline())
        assertEquals(
            "A primeira sai agora, para conferir a conexão.",
            PRELIMINARY_RECEIPT_NOTICE,
        )
        assertEquals("O comprovante preliminar já saiu.", PRELIMINARY_RECEIPT_ALREADY_PRINTED)
        assertEquals("Deixe papel suficiente na impressora.", PAPER_COST_LEFTOVER_NOTICE)
    }

    private fun measuredProfile(): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = "00000000-0000-4000-8000-000000000099",
            displayName = "Impressora medida",
            transports = setOf(PrinterTransport.USB),
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            codePage = ThermalCodePage.CP850,
            cutProtocol = CutProtocol.GS_V_1,
            cutFeedLines = 5,
            measuredAtEpochMillis = 1,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )
}
