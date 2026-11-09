package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.EscPosDialect
import br.com.thermalprinterkit.CutProtocol
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PrinterHomologationProbes
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalCodePage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A rota declarada não mede sonda nenhuma, e por isso não pode apagar o que a sonda já mediu.
 *
 * Quatro campos nascem tardios e não têm campo em tela: o teto de vazão, o fator de compensação
 * vertical e as duas respostas do código nativo. Quem homologou a T210 e depois só trocou a página
 * de código perdia a compensação em silêncio — foto, logotipo e QR voltavam a sair ~20% mais
 * curtos, o cupom continuava saindo e nenhuma suíte acusava.
 */
class ManualConfigurationLateFieldsTest {
    @Test
    fun `regravar pela tela declarada preserva os quatro campos medidos tardios`() {
        val medido = perfilComReguaDaSonda()

        val regravado =
            manualConfigurationProfile(
                previous = medido,
                displayName = medido.displayName,
                transport = PrinterTransport.BLUETOOTH,
                paperWidthMm = medido.paperWidthMm,
                printableColumns = medido.printableColumns,
                printableDots = medido.printableDots,
                encoding = cp850,
                hasCutter = false,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                nowEpochMillis = 2_000,
            )

        assertEquals(ThermalCodePage.CP850, regravado.codePage)
        assertEquals(medido.maxRasterBytesPerSecond, regravado.maxRasterBytesPerSecond)
        assertEquals(medido.verticalRasterScale, regravado.verticalRasterScale)
        assertEquals(medido.nativeQrHonored, regravado.nativeQrHonored)
        assertEquals(medido.nativeBarcodeHonored, regravado.nativeBarcodeHonored)
    }

    /**
     * O fator entra na `capabilityKey`, então apagá-lo movia a chave de um perfil já medido — e
     * chave que se move deixa de casar com a medição que já foi contribuída.
     */
    @Test
    fun `regravar sem mudança nenhuma mantém a chave de capacidade`() {
        val medido = perfilComReguaDaSonda()

        val regravado =
            manualConfigurationProfile(
                previous = medido,
                displayName = medido.displayName,
                transport = PrinterTransport.BLUETOOTH,
                paperWidthMm = medido.paperWidthMm,
                printableColumns = medido.printableColumns,
                printableDots = medido.printableDots,
                encoding = semPagina,
                hasCutter = false,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                nowEpochMillis = 2_000,
            )

        assertEquals(medido.capabilityKey, regravado.capabilityKey)
        assertEquals(medido.id, regravado.id)
    }

    /**
     * A superfície consegue carregar os quatro quando quem chama já os tem — é o que o app de mesa
     * usa para transcrever a régua do comprovante (`Vazão: 38/48 mm | fator 0,79`). Nenhuma tela de
     * celular ganha campo para digitar isto.
     */
    @Test
    fun `quem já tem os quatro campos consegue declará-los`() {
        val declarado =
            manualConfigurationProfile(
                previous = null,
                displayName = "T210 do balcão",
                transport = PrinterTransport.BLUETOOTH,
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                encoding = semPagina,
                hasCutter = false,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                nowEpochMillis = 2_000,
                newId = "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
                maxRasterBytesPerSecond = 4_096,
                verticalRasterScale = 0.79,
                nativeQrHonored = false,
                nativeBarcodeHonored = true,
            )

        assertEquals(4_096, declarado.maxRasterBytesPerSecond)
        assertEquals(0.79, declarado.verticalRasterScale!!, 0.0)
        assertEquals(false, declarado.nativeQrHonored)
        assertEquals(true, declarado.nativeBarcodeHonored)
    }

    /** O declarado ganha do anterior: quem transcreve a régua nova está corrigindo a antiga. */
    @Test
    fun `o valor declarado prevalece sobre o do perfil anterior`() {
        val regravado =
            manualConfigurationProfile(
                previous = perfilComReguaDaSonda(),
                displayName = "T210 do balcão",
                transport = PrinterTransport.BLUETOOTH,
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                encoding = semPagina,
                hasCutter = false,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                nowEpochMillis = 2_000,
                verticalRasterScale = 0.9,
            )

        assertEquals(0.9, regravado.verticalRasterScale!!, 0.0)
        // O que não foi declarado continua vindo do perfil anterior.
        assertEquals(4_096, regravado.maxRasterBytesPerSecond)
    }

    /**
     * Paridade com o iOS, fixada por literal nas duas suítes.
     *
     * O mesmo perfil declarado do mesmo jeito precisa sair igual nas duas plataformas, e a chave é
     * o que prova isso sem impressora: ela leva o fator em milésimos inteiros, justamente porque
     * formatação de ponto flutuante não promete a mesma string dos dois lados. O literal gêmeo está
     * em `PrinterManualConfigurationTests` do iOS.
     */
    @Test
    fun `a chave do perfil com fator é a mesma das duas plataformas`() {
        assertEquals(
            "9d0b8093b21e428ce931f875929ca60d906a75d02a2f22bb207fc52db9155d29",
            perfilComReguaDaSonda().capabilityKey.value,
        )
    }

    /** Quem nunca viu sonda nenhuma continua nascendo sem os quatro: nada os completa sozinho. */
    @Test
    fun `sem perfil anterior e sem declaração os quatro nascem ausentes`() {
        val novo =
            manualConfigurationProfile(
                previous = null,
                displayName = "Impressora nova",
                transport = PrinterTransport.BLUETOOTH,
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                encoding = semPagina,
                hasCutter = false,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                nowEpochMillis = 2_000,
            )

        assertNull(novo.maxRasterBytesPerSecond)
        assertNull(novo.verticalRasterScale)
        assertNull(novo.nativeQrHonored)
        assertNull(novo.nativeBarcodeHonored)
    }

    /** As faixas continuam sendo do perfil: declarar fora delas não vira perfil nenhum. */
    @Test(expected = IllegalArgumentException::class)
    fun `fator fora da faixa medida não vira perfil`() {
        manualConfigurationProfile(
            previous = null,
            displayName = "Impressora",
            transport = PrinterTransport.BLUETOOTH,
            paperWidthMm = 58,
            printableColumns = 32,
            printableDots = 384,
            encoding = semPagina,
            hasCutter = false,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            nowEpochMillis = 2_000,
            verticalRasterScale = 0.4,
        )
    }

    private val semPagina = PrinterHomologationProbes.codePageCandidates.first { it.codePage == null }

    private val cp850 =
        PrinterHomologationProbes.codePageCandidates.first {
            it.codePage == ThermalCodePage.CP850 && !it.isAddress
        }

    private fun perfilComReguaDaSonda(): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
            displayName = "T210 do balcão",
            transports = setOf(PrinterTransport.BLUETOOTH),
            paperWidthMm = 58,
            printableColumns = 32,
            printableDots = 384,
            codePage = null,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            measuredAtEpochMillis = 1_000,
            maxRasterBytesPerSecond = 4_096,
            verticalRasterScale = 0.8,
            nativeQrHonored = false,
            nativeBarcodeHonored = true,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )
}
