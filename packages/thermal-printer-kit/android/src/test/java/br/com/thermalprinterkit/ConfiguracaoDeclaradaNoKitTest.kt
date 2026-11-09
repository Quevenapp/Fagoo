package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A rota declarada do **kit** não pode apagar o que a sonda mediu.
 *
 * A preservação dos quatro campos medidos tardios já existia na tela do `:printher` e dentro do kit
 * do iOS; no Android ela estava só na tela, e [PrinterHomologationTarget.saveManualConfiguration] —
 * que é o ponto de entrada do kit para esta rota — sobrescrevia o perfil inteiro. Quem chamasse a
 * API sem passar pela tela apagava `verticalRasterScale` em silêncio: a foto, o logotipo e o QR da
 * T210 voltavam a sair ~20% mais curtos, o cupom continuava saindo e a `capabilityKey` de um perfil
 * já medido se movia — que é o que o `AGENTS.md` proíbe nominalmente.
 *
 * Nenhum app hospedeiro chamava esta API fora do `:printher` quando isto foi medido, em 21/08/2026:
 * era superfície que **permitia** a perda, não defeito ativo em app publicado. A garantia tem de
 * ser da superfície do kit, como já é no iOS, e não de quem chama.
 */
class ConfiguracaoDeclaradaNoKitTest {
    @Test
    fun `regravar pela superfície do kit preserva os quatro campos medidos tardios`() =
        runTest {
            val store = InMemoryPrinterProfileStore()
            val medido = perfilComReguaDaSonda()
            store.save(medido)

            alvo(store).saveManualConfiguration(trocaSomenteAPagina())

            val gravado = store.read().single()
            assertEquals(ThermalCodePage.CP850, gravado.codePage)
            assertEquals(medido.maxRasterBytesPerSecond, gravado.maxRasterBytesPerSecond)
            assertEquals(medido.verticalRasterScale, gravado.verticalRasterScale)
            assertEquals(medido.nativeQrHonored, gravado.nativeQrHonored)
            assertEquals(medido.nativeBarcodeHonored, gravado.nativeBarcodeHonored)
        }

    /**
     * O fator entra na `capabilityKey`, então apagá-lo movia a chave de um perfil já medido — e
     * chave que se move deixa de casar com a medição que já foi contribuída.
     *
     * O literal é o mesmo das outras duas suítes (`ManualConfigurationLateFieldsTest` do
     * `:printher` e `PrinterManualConfigurationTests` do iOS): as três precisam sair iguais para o
     * mesmo perfil.
     */
    @Test
    fun `a chave de capacidade do perfil já medido não se move`() =
        runTest {
            val store = InMemoryPrinterProfileStore()
            val medido = perfilComReguaDaSonda()
            store.save(medido)

            alvo(store).saveManualConfiguration(trocaSomenteONome())

            val gravado = store.read().single()
            assertEquals(medido.capabilityKey, gravado.capabilityKey)
            assertEquals(
                "9d0b8093b21e428ce931f875929ca60d906a75d02a2f22bb207fc52db9155d29",
                gravado.capabilityKey.value,
            )
        }

    /**
     * Quem adota precisa receber o perfil que foi ao disco.
     *
     * O hospedeiro reconstrói o layout pelo perfil adotado; se ele recebesse a declaração crua, o
     * cupom seguinte sairia sem compensação mesmo com o disco correto — e não haveria erro em lugar
     * nenhum.
     */
    @Test
    fun `o perfil adotado é o mesmo que foi ao disco`() =
        runTest {
            val store = InMemoryPrinterProfileStore()
            store.save(perfilComReguaDaSonda())
            var adotado: MeasuredProfile? = null

            alvo(store) { adotado = it }.saveManualConfiguration(trocaSomenteAPagina())

            assertEquals(store.read().single(), adotado)
            assertEquals(0.8, adotado?.verticalRasterScale!!, 0.0)
        }

    /** O declarado ganha do anterior: quem transcreve a régua nova está corrigindo a antiga. */
    @Test
    fun `o valor declarado vence o do perfil anterior`() =
        runTest {
            val store = InMemoryPrinterProfileStore()
            store.save(perfilComReguaDaSonda())

            alvo(store).saveManualConfiguration(
                declaracao(verticalRasterScale = 0.9, nativeQrHonored = true),
            )

            val gravado = store.read().single()
            assertEquals(0.9, gravado.verticalRasterScale!!, 0.0)
            assertEquals(true, gravado.nativeQrHonored)
            // O que ninguém declarou continua vindo do perfil anterior.
            assertEquals(4_096, gravado.maxRasterBytesPerSecond)
            assertEquals(true, gravado.nativeBarcodeHonored)
            assertNotEquals(perfilComReguaDaSonda().capabilityKey, gravado.capabilityKey)
        }

    /**
     * Idempotência: a tela do `:printher` já funde antes de chamar, e fundir de novo no kit não
     * pode mudar o resultado de quem já fundiu.
     */
    @Test
    fun `fundir de novo não muda o que já veio fundido`() =
        runTest {
            val store = InMemoryPrinterProfileStore()
            store.save(perfilComReguaDaSonda())
            val jaFundido =
                declaracao(
                    codePage = ThermalCodePage.CP850,
                    maxRasterBytesPerSecond = 4_096,
                    verticalRasterScale = 0.8,
                    nativeQrHonored = false,
                    nativeBarcodeHonored = true,
                )
            val alvo = alvo(store)

            alvo.saveManualConfiguration(jaFundido)
            val primeira = store.read().single()
            alvo.saveManualConfiguration(primeira)
            val segunda = store.read().single()

            assertEquals(jaFundido, primeira)
            assertEquals(primeira, segunda)
            assertEquals(primeira.capabilityKey, segunda.capabilityKey)
        }

    /** Sem perfil anterior nada completa a lacuna: quem nunca viu sonda continua sem os quatro. */
    @Test
    fun `sem perfil anterior os quatro continuam nascendo ausentes`() =
        runTest {
            val store = InMemoryPrinterProfileStore()
            val novo = trocaSomenteAPagina()

            alvo(store).saveManualConfiguration(novo)

            val gravado = store.read().single()
            assertEquals(novo, gravado)
            assertNull(gravado.maxRasterBytesPerSecond)
            assertNull(gravado.verticalRasterScale)
            assertNull(gravado.nativeQrHonored)
            assertNull(gravado.nativeBarcodeHonored)
        }

    /**
     * A rota da sonda grava por outro caminho, e continua podendo gravar **ausência**.
     *
     * A preservação vale só para a declaração, que não mede nada. A homologação mede: uma régua que
     * conclui `>= 0,97` grava `null` de propósito, e um perfil que sai da sonda sem os quatro é a
     * verdade sobre ele. Quem persiste ali é [PrinterHomologationFlow], depois do comprovante em
     * papel e da confirmação humana — nada disso passa por
     * [PrinterHomologationTarget.saveManualConfiguration].
     */
    @Test
    fun `a homologação continua gravando o que mediu, inclusive ausência`() =
        runTest {
            val store = InMemoryPrinterProfileStore()
            val medidoAntes = perfilComReguaDaSonda()
            store.save(medidoAntes)
            val flow = alvo(store).openHomologation(store)

            flow.sendCurrentProbe()
            flow.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))
            flow.passRasterThroughputProbe()
            flow.passNativeCodeProbe()
            flow.answerCutterPresence(PrinterCutterPresence.NO)
            flow.sendCurrentProbe()
            flow.answer(PrinterHomologationAnswer.CodePage(null))
            flow.sendFinalReceipt()
            flow.confirmFinalReceipt()

            val homologado = store.read().single { it.id != medidoAntes.id }
            assertNull(homologado.maxRasterBytesPerSecond)
            assertNull(homologado.verticalRasterScale)
            assertNull(homologado.nativeQrHonored)
            assertNull(homologado.nativeBarcodeHonored)
            // E a medição antiga continua exatamente como estava.
            assertEquals(medidoAntes, store.read().single { it.id == medidoAntes.id })
        }

    private fun alvo(
        store: PrinterProfileStore,
        adopter: suspend (MeasuredProfile) -> Unit = {},
    ): PrinterHomologationTarget =
        PrinterHomologationTarget(
            transport = PrinterTransport.BLUETOOTH,
            displayName = "T210 do balcão",
            profileId = PERFIL,
            defaultStore = store,
            sender = { ThermalPrintResult.Printed },
            adopter = adopter,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    /** O perfil que a bancada mediu na T210: régua da sonda e tira de código nativo respondidas. */
    private fun perfilComReguaDaSonda(): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = PERFIL,
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

    /** O caso do defeito: a pessoa só quis acento, e a declaração chega sem os quatro. */
    private fun trocaSomenteAPagina(): MeasuredProfile = declaracao(codePage = ThermalCodePage.CP850)

    /** O caso mais cru ainda: nada de capacidade muda, só o nome do card. */
    private fun trocaSomenteONome(): MeasuredProfile = declaracao(displayName = "T210 da cozinha")

    private fun declaracao(
        displayName: String = "T210 do balcão",
        codePage: ThermalCodePage? = null,
        maxRasterBytesPerSecond: Int? = null,
        verticalRasterScale: Double? = null,
        nativeQrHonored: Boolean? = null,
        nativeBarcodeHonored: Boolean? = null,
    ): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = PERFIL,
            displayName = displayName,
            transports = setOf(PrinterTransport.BLUETOOTH),
            paperWidthMm = 58,
            printableColumns = 32,
            printableDots = 384,
            codePage = codePage,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            measuredAtEpochMillis = 2_000,
            maxRasterBytesPerSecond = maxRasterBytesPerSecond,
            verticalRasterScale = verticalRasterScale,
            nativeQrHonored = nativeQrHonored,
            nativeBarcodeHonored = nativeBarcodeHonored,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    private companion object {
        const val PERFIL = "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e"
    }
}
