package br.com.thermalprinterkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MeasuredProfileTest {
    @Test
    fun `larguras de papel começam com a geometria pedida`() {
        assertEquals(PrinterGeometry(58, 32, 384), MeasuredProfile.geometryDefaults(58))
        assertEquals(PrinterGeometry(80, 48, 576), MeasuredProfile.geometryDefaults(80))
        assertEquals(listOf(256, 288, 320, 384), MeasuredProfile.printableDotCandidates(58))
        assertEquals(listOf(384, 512, 576, 640), MeasuredProfile.printableDotCandidates(80))
    }

    @Test
    fun `perfil novo usa UUID local e mantém status NONE`() {
        val profile = measured()

        assertTrue(profile.id.matches(Regex("[0-9a-f-]{36}")))
        assertEquals(PrinterStatusProtocol.NONE, profile.statusProtocol)
        assertEquals(PrinterProfileSource.MEASURED, profile.source)
    }

    @Test
    fun `capability key exclui id nome data e origem`() {
        val first = measured(id = UUID_1, name = "Modelo A", measuredAt = 10)
        val second = measured(id = UUID_2, name = "Modelo B", measuredAt = 20)
        val bundled =
            MeasuredProfile(
                id = "generic.equivalent.profile",
                displayName = "Modelo homologado",
                transports = first.transports,
                paperWidthMm = first.paperWidthMm,
                printableColumns = first.printableColumns,
                printableDots = first.printableDots,
                codePage = first.codePage,
                cutProtocol = first.cutProtocol,
                cutFeedLines = first.cutFeedLines,
                dialect = first.dialect,
                statusProtocol = first.statusProtocol,
                measuredAtEpochMillis = null,
                source = PrinterProfileSource.BUNDLED,
            )

        assertEquals(first.capabilityKey, second.capabilityKey)
        assertEquals(first.capabilityKey, bundled.capabilityKey)
        assertNotEquals(first.id, second.id)
        assertNotEquals(first.displayName, second.displayName)
    }

    @Test
    fun `cards de mesma largura têm somente a capability conservadora do catálogo`() {
        val epson = MeasuredProfile.bundled(BundledPrinterDrivers.epsonTmT20xII)
        val elgin = MeasuredProfile.bundled(BundledPrinterDrivers.elginI9Full2)

        assertEquals(epson.capabilityKey, elgin.capabilityKey)
        assertEquals(CutProtocol.NONE, elgin.cutProtocol)
        assertEquals(null, elgin.codePage)
    }

    @Test
    fun `QR respeita dots colunas e múltiplo de oito`() {
        assertEquals(320, MeasuredProfile.qrWidthDots(printableColumns = 48, printableDots = 576))
        assertEquals(288, MeasuredProfile.qrWidthDots(printableColumns = 24, printableDots = 384))
        assertEquals(120, MeasuredProfile.qrWidthDots(printableColumns = 10, printableDots = 384))
        assertTrue(measured().qrWidthDots >= MeasuredProfile.MIN_SAFE_RASTER_QR_DOTS)
        assertEquals(0, measured().qrWidthDots % 8)
    }

    @Test
    fun `perfil temporário é conservador e mostra aviso`() {
        val profile =
            MeasuredProfile.temporary(
                PrinterTransport.BLUETOOTH_LE,
                58,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        assertEquals(PrinterProfileSource.TEMPORARY, profile.source)
        assertEquals(null, profile.codePage)
        assertEquals(ThermalTextEncoding.ASCII, profile.textEncoding)
        assertEquals(CutProtocol.NONE, profile.cutProtocol)
        assertEquals(0, profile.cutFeedLines)
        assertEquals(PrinterStatusProtocol.NONE, profile.statusProtocol)
        assertTrue(MeasuredProfile.TEMPORARY_PROFILE_WARNING.contains("temporário"))
    }

    @Test
    fun `modelo de codificação entra na chave porque muda os bytes`() {
        val ascii = measured().copy(codePage = null, codePageSelector = null, textEncoding = ThermalTextEncoding.ASCII)
        val utf8 = ascii.copy(textEncoding = ThermalTextEncoding.UTF_8)

        assertNotEquals(ascii.capabilityKey, utf8.capabilityKey)
    }

    @Test
    fun `marca e modelo ficam no nome mas endpoint e identificador técnico são recusados`() {
        listOf(
            "Impressora 192.168.1.40",
            "Impressora AA:BB:CC:DD:EE:FF",
            "Impressora VID 1234",
            "Peripheral 123",
            "550e8400-e29b-41d4-a716-446655440000",
        ).forEach { unsafeName ->
            assertThrows(IllegalArgumentException::class.java) { measured(name = unsafeName) }
        }
        assertFalse(measured(name = "Elgin i9FULL 2").displayName.contains("192.168"))
    }

    @Test
    fun `o endereco medido da pagina fica fora da chave de capacidade`() {
        // A T210 atende a CP860 em `ESC t 8`, não no 3 canônico. Duas impressoras que produzem o
        // mesmo papel continuam equivalentes ainda que cheguem à página por `n` diferente; incluir
        // o endereço na chave mudaria a de todo perfil já medido para distinguir coisas iguais.
        val canonico = medidoComPagina(seletor = null)
        val medidoNaT210 = medidoComPagina(seletor = 8)

        assertEquals(canonico.capabilityKey, medidoNaT210.capabilityKey)
        assertEquals(8, medidoNaT210.toDriverProfile().codePageSelector)
        assertEquals(null, canonico.toDriverProfile().codePageSelector)
    }

    @Test
    fun `o endereco medido chega ao papel no lugar do canonico`() {
        val layout = ReceiptLayout.from(medidoComPagina(seletor = 8).toDriverProfile())
        val canonico = ReceiptLayout.from(medidoComPagina(seletor = null).toDriverProfile())

        val medido = layout.text("a", ThermalTextAlignment.LEFT, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)
        val padrao = canonico.text("a", ThermalTextAlignment.LEFT, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)

        // `ESC t n` abre os dois blocos; muda só o endereço.
        assertEquals(0x08, medido[2].toInt())
        assertEquals(ThermalCodePage.CP860.escPosValue, padrao[2].toInt())
    }

    /**
     * O teto medido precisa atravessar a conversão para o contrato produtivo.
     *
     * É onde ele morreria em silêncio: `toDriverProfile` é o que o transporte recebe, e um campo
     * esquecido ali devolve a foto encolhida sem erro em lugar nenhum.
     */
    @Test
    fun `o teto de vazao atravessa a conversao para o perfil produtivo`() {
        val comTeto = measured().copy(maxRasterBytesPerSecond = 8_192)

        assertEquals(8_192, comTeto.toDriverProfile().maxRasterBytesPerSecond)
        assertEquals(null, measured().toDriverProfile().maxRasterBytesPerSecond)
    }

    /** Perfil com dado suposto é pior que perfil nenhum: teto impossível é recusado, não corrigido. */
    @Test
    fun `teto de vazao fora da faixa e recusado`() {
        assertThrows(IllegalArgumentException::class.java) {
            measured().copy(maxRasterBytesPerSecond = 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            measured().copy(maxRasterBytesPerSecond = RASTER_BYTES_PER_SECOND_RANGE.last + 1)
        }
    }

    /**
     * O fator de compensação atravessa a conversão para o perfil produtivo.
     *
     * É onde ele morreria em silêncio: `toDriverProfile` é o que o layout e o transporte recebem, e
     * um campo esquecido ali devolve a foto encolhida sem erro em lugar nenhum.
     */
    @Test
    fun `o fator de compensacao atravessa a conversao para o perfil produtivo`() {
        val comFator = measured().copy(verticalRasterScale = 0.8)

        assertEquals(0.8, comFator.toDriverProfile().verticalRasterScale!!, 1e-9)
        assertEquals(null, measured().toDriverProfile().verticalRasterScale)
    }

    /** Perfil com dado suposto é pior que perfil nenhum: fator impossível é recusado, não corrigido. */
    @Test
    fun `fator de compensacao fora da faixa e recusado`() {
        listOf(0.0, 0.49, 1.01, -0.8).forEach { invalido ->
            assertThrows(IllegalArgumentException::class.java) {
                measured().copy(verticalRasterScale = invalido)
            }
        }
    }

    /**
     * Gravar a família de configuração de rede preserva todo o resto da medição.
     *
     * A tela de rede não mediu geometria, página nem corte; ela responde uma pergunta só. Um
     * caminho de escrita que reconstruísse o perfil apagaria em silêncio o que ela não conhece —
     * que é o defeito que a edição manual ainda tem hoje com o fator de compensação.
     */
    @Test
    fun `gravar a familia de configuracao preserva o resto da medicao`() {
        val medido =
            medidoComPagina(seletor = 8).copy(
                cutModeHonored = false,
                verticalRasterScale = 0.8,
                firmwareVersion = "SV3.2.2",
            )

        val comFamilia =
            medido.withWifiConfigurationFamily(
                PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED,
            )

        assertEquals(
            PrinterWifiConfigurationFamily.MEASURED_US_W_HONORED,
            comFamilia.wifiConfigurationFamily,
        )
        assertEquals(8, comFamilia.codePageSelector)
        assertEquals(false, comFamilia.cutModeHonored)
        assertEquals(0.8, comFamilia.verticalRasterScale!!, 1e-9)
        assertEquals("SV3.2.2", comFamilia.firmwareVersion)
        // A data não anda: nada foi remedido no papel, e mexer nela reordenaria a lista de perfis.
        assertEquals(medido.measuredAtEpochMillis, comFamilia.measuredAtEpochMillis)
        assertEquals(medido.id, comFamilia.id)
    }

    /**
     * A família de configuração não chega ao perfil produtivo, e isso é decisão.
     *
     * [PrinterDriverProfile] é o que o emissor lê para montar bytes de cupom, e o emissor não monta
     * quadro de configuração. Ao contrário do teto e do fator — que morreriam na conversão e
     * mudariam o papel —, este campo não tem nada a fazer do outro lado da ponte.
     */
    @Test
    fun `a familia de configuracao nao atravessa para o perfil produtivo`() {
        val comFamilia =
            measured().withWifiConfigurationFamily(
                PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US,
            )

        assertEquals(
            comFamilia.toDriverProfile(),
            measured().toDriverProfile(),
        )
    }

    /**
     * A edição manual carrega a família adiante ao reconstruir o perfil.
     *
     * A tela de edição chama `createLocal` do zero, e o que ela não passa some sem erro em lugar
     * nenhum. É o mesmo motivo pelo qual `cutModeHonored` é carregado ali.
     */
    @Test
    fun `a edicao manual carrega a familia de configuracao adiante`() {
        val editado =
            MeasuredProfile.createLocal(
                id = UUID_1,
                displayName = "T210 de bancada",
                transports = setOf(PrinterTransport.BLUETOOTH),
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                codePage = ThermalCodePage.CP860,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 2,
                codePageSelector = 8,
                cutModeHonored = false,
                wifiConfigurationFamily = PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        assertEquals(
            PrinterWifiConfigurationFamily.MEASURED_US_W_ABSENT,
            editado.wifiConfigurationFamily,
        )
    }

    private fun medidoComPagina(seletor: Int?): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = UUID_1,
            displayName = "T210 de bancada",
            transports = setOf(PrinterTransport.BLUETOOTH),
            paperWidthMm = 58,
            printableColumns = 32,
            printableDots = 384,
            codePage = ThermalCodePage.CP860,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            measuredAtEpochMillis = 1,
            codePageSelector = seletor,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    private fun measured(
        id: String = UUID_1,
        name: String = "Portátil de bancada",
        measuredAt: Long = 1,
    ): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = id,
            displayName = name,
            transports = setOf(PrinterTransport.BLUETOOTH, PrinterTransport.BLUETOOTH_LE),
            paperWidthMm = 58,
            printableColumns = 32,
            printableDots = 384,
            codePage = null,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            measuredAtEpochMillis = measuredAt,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    private companion object {
        const val UUID_1 = "00000000-0000-4000-8000-000000000001"
        const val UUID_2 = "00000000-0000-4000-8000-000000000002"
    }
}
