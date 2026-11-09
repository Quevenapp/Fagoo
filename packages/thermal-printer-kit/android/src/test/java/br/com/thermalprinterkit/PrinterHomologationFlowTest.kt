package br.com.thermalprinterkit

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterHomologationFlowTest {
    /** A linha que grava uma página de código, para distinguir o rascunho novo do antigo. */
    private val letraDoCP860 =
        PrinterHomologationProbes.codePageCandidates
            .first { it.codePage == ThermalCodePage.CP860 }
            .letter

    @Test
    fun `identidade é lida uma vez antes do comprovante e firmware atravessa o store`() = runTest {
        val store = InMemoryPrinterProfileStore()
        var reads = 0
        var finalReceipt = ""
        var sends = 0
        val identity = PrinterDeclaredIdentity("SV3.2.2", "GoldenSky", "58E_BT")
        val flow =
            flow(
                store = store,
                identityReader = {
                    reads += 1
                    identity
                },
                sender = { probe ->
                    sends += 1
                    if (sends > 2) finalReceipt = String(probe.bytes(), Charsets.US_ASCII)
                    ThermalPrintResult.Printed
                },
            )
        completeMeasurementWithoutCutter(flow)

        assertEquals(false, flow.state.value.identityReadCompleted)
        flow.sendFinalReceipt()

        assertEquals(1, reads)
        assertEquals(identity, flow.state.value.declaredIdentity)
        assertEquals("GoldenSky 58E_BT", flow.previewFinalProfile().displayName)
        assertEquals("SV3.2.2", flow.previewFinalProfile().firmwareVersion)
        assertTrue(finalReceipt.contains("Fabricante: GoldenSky"))
        assertTrue(finalReceipt.contains("Modelo: 58E_BT"))
        assertTrue(finalReceipt.contains("Firmware: SV3.2.2"))

        flow.prepareFinalReceiptRetryAfterNotPrinted()
        flow.sendFinalReceipt()
        assertEquals(1, reads)
        flow.confirmFinalReceipt()
        assertEquals("SV3.2.2", store.read().single().firmwareVersion)
    }

    @Test
    fun `DONE e callback final nao adotam sem confirmacao humana`() = runTest {
        val store = InMemoryPrinterProfileStore()
        var adopted = 0
        val flow = flow(store = store, adopter = { adopted += 1 })

        completeMeasurementWithoutCutter(flow)

        assertEquals(PrinterHomologationFlowPhase.FINAL_RECEIPT_READY, flow.state.value.phase)
        assertEquals(0, adopted)
        assertTrue(store.read().isEmpty())

        assertSame(ThermalPrintResult.Printed, flow.sendFinalReceipt())
        assertEquals(
            PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION,
            flow.state.value.phase,
        )
        assertEquals(0, adopted)
        assertTrue(store.read().isEmpty())

        flow.confirmFinalReceipt()

        assertEquals(PrinterHomologationFlowPhase.FINISHED, flow.state.value.phase)
        assertEquals(1, adopted)
        assertEquals(1, store.read().size)
    }

    @Test
    fun `renomear antes de adotar troca so o nome e preserva a medicao`() = runTest {
        // O perfil do Caminho B herdava "Impressora temporária" mesmo depois de sair correto no
        // papel. É no fim que a pessoa consegue dar um nome local à impressora que acabou de ver.
        val store = InMemoryPrinterProfileStore()
        var adoptedProfile: MeasuredProfile? = null
        val flow =
            flow(
                store = store,
                displayName = "Impressora temporária 58 mm",
                adopter = { adoptedProfile = it },
            )
        completeMeasurementWithoutCutter(flow)
        flow.sendFinalReceipt()
        val before = flow.previewFinalProfile()

        assertThrows(IllegalArgumentException::class.java) {
            flow.renameFinalProfile("550e8400-e29b-41d4-a716-446655440000")
        }
        assertEquals(before, flow.previewFinalProfile())

        flow.renameFinalProfile("  T210 do balcão  ")
        val after = flow.previewFinalProfile()

        assertEquals(before.copy(displayName = "T210 do balcão"), after)
        assertEquals(before.id, after.id)
        assertEquals(before.capabilityKey, after.capabilityKey)

        // Em branco mantém o nome escolhido em vez de apagar ou restaurar o nome temporário.
        flow.renameFinalProfile("   ")
        assertEquals("T210 do balcão", flow.previewFinalProfile().displayName)

        flow.confirmFinalReceipt()

        assertEquals("T210 do balcão", store.read().single().displayName)
        assertEquals("T210 do balcão", adoptedProfile?.displayName)
    }

    @Test
    fun `resposta e confirmacao final fora de estado sao recusadas`() = runTest {
        val flow = flow()

        assertThrows(IllegalStateException::class.java) {
            flow.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))
        }
        assertThrows(IllegalStateException::class.java) {
            kotlinx.coroutines.runBlocking { flow.confirmFinalReceipt() }
        }
        assertThrows(IllegalStateException::class.java) {
            kotlinx.coroutines.runBlocking { flow.sendFinalReceipt() }
        }

        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))

        assertEquals(
            PrinterHomologationStep.RASTER_THROUGHPUT,
            flow.state.value.machineState.step,
        )
    }

    @Test
    fun `tres resultados finais ficam tipados e nunca repetem envio`() = runTest {
        val results =
            ArrayDeque<ThermalPrintResult>().apply {
                // Quatro sondas até DONE — geometria, vazão, código nativo e texto. Recusar
                // guilhotina não envia nada —, seguidas pelas três variantes do callback final.
                repeat(4) { add(ThermalPrintResult.Printed) }
                add(ThermalPrintResult.Printed)
                add(
                    ThermalPrintResult.Failed(
                        "Falha antes do envio",
                        ThermalPrinterState.Failed("Falha antes do envio"),
                        ThermalPrintDelivery.NOT_SENT,
                    ),
                )
                add(
                    ThermalPrintResult.Failed(
                        "Falha depois do primeiro byte",
                        ThermalPrinterState.Failed("Falha depois do primeiro byte"),
                        ThermalPrintDelivery.INDETERMINATE,
                    ),
                )
            }
        var sends = 0
        val flow = flow(sender = {
            sends += 1
            results.removeFirst()
        })
        completeMeasurementWithoutCutter(flow)

        assertSame(ThermalPrintResult.Printed, flow.sendFinalReceipt())
        assertEquals(5, sends)
        flow.prepareFinalReceiptRetryAfterNotPrinted()

        val notSent = flow.sendFinalReceipt() as ThermalPrintResult.Failed
        assertEquals(ThermalPrintDelivery.NOT_SENT, notSent.delivery)
        assertEquals(PrinterHomologationFlowPhase.FAILED, flow.state.value.phase)
        assertEquals(6, sends)
        flow.retryFinalReceipt()

        val indeterminate = flow.sendFinalReceipt() as ThermalPrintResult.Failed
        assertEquals(ThermalPrintDelivery.INDETERMINATE, indeterminate.delivery)
        assertEquals(
            PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION,
            flow.state.value.phase,
        )
        assertTrue(flow.state.value.finalReceiptWarning?.contains("Confira a impressora") == true)
        assertEquals(7, sends)
    }

    @Test
    fun `falha tardia exige inspecao e saiu certo adota sem novo envio`() = runTest {
        val store = InMemoryPrinterProfileStore()
        var sends = 0
        var adopted = 0
        val flow =
            flow(
                store = store,
                sender = {
                    sends += 1
                    // Geometria, vazão, código nativo e texto saem; o comprovante final falha.
                    if (sends <= 4) {
                        ThermalPrintResult.Printed
                    } else {
                        ThermalPrintResult.Failed(
                            "Falha depois do primeiro byte",
                            ThermalPrinterState.Failed("Falha depois do primeiro byte"),
                            ThermalPrintDelivery.INDETERMINATE,
                        )
                    }
                },
                adopter = { adopted += 1 },
            )
        completeMeasurementWithoutCutter(flow)

        val result = flow.sendFinalReceipt() as ThermalPrintResult.Failed

        assertEquals(ThermalPrintDelivery.INDETERMINATE, result.delivery)
        assertEquals(5, sends)
        assertEquals(0, adopted)
        assertTrue(store.read().isEmpty())
        assertEquals(
            PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION,
            flow.state.value.phase,
        )
        assertTrue(flow.state.value.finalReceiptWarning != null)

        flow.confirmFinalReceipt()

        assertEquals(5, sends)
        assertEquals(1, adopted)
        assertEquals(1, store.read().size)
        assertEquals(PrinterHomologationFlowPhase.FINISHED, flow.state.value.phase)
    }

    @Test
    fun `falha tardia permite problema ou nao saiu sem repetir automaticamente`() = runTest {
        suspend fun indeterminateFlow(): PrinterHomologationFlow {
            var probeNumber = 0
            return flow(
                sender = {
                    probeNumber += 1
                    if (probeNumber <= 5) {
                        ThermalPrintResult.Printed
                    } else {
                        ThermalPrintResult.Failed(
                            "Entrega incerta",
                            ThermalPrinterState.Failed("Entrega incerta"),
                            ThermalPrintDelivery.INDETERMINATE,
                        )
                    }
                },
            ).also { candidate ->
                completeMeasurementWithoutCutter(candidate)
                candidate.sendFinalReceipt()
            }
        }

        val withProblem = indeterminateFlow()
        withProblem.restartAfterFinalProblem()
        assertEquals(PrinterHomologationFlowPhase.MEASURING, withProblem.state.value.phase)
        assertTrue(withProblem.state.value.measuredProfile == null)

        val notPrinted = indeterminateFlow()
        notPrinted.prepareFinalReceiptRetryAfterNotPrinted()
        assertEquals(
            PrinterHomologationFlowPhase.FINAL_RECEIPT_READY,
            notPrinted.state.value.phase,
        )
    }

    @Test
    fun `falha do adopter remove perfil salvo e preserva selecao anterior`() = runTest {
        val store = InMemoryPrinterProfileStore()
        val flow = flow(store = store, adopter = { error("Falha ao salvar seleção") })
        completeMeasurementWithoutCutter(flow)
        flow.sendFinalReceipt()

        flow.confirmFinalReceipt()

        assertEquals(PrinterHomologationFlowPhase.FAILED, flow.state.value.phase)
        assertEquals(PrinterHomologationFailurePoint.ADOPTION, flow.state.value.failure?.point)
        assertTrue(store.read().isEmpty())
    }

    @Test
    fun `confirmacao entra em adopting antes de suspender e duplo toque nao adota duas vezes`() =
        runTest {
            val adopterStarted = CompletableDeferred<Unit>()
            val releaseAdopter = CompletableDeferred<Unit>()
            var adoptions = 0
            val flow =
                flow(
                    adopter = {
                        adoptions += 1
                        adopterStarted.complete(Unit)
                        releaseAdopter.await()
                    },
                )
            completeMeasurementWithoutCutter(flow)
            flow.sendFinalReceipt()

            val first = async { flow.confirmFinalReceipt() }
            adopterStarted.await()

            assertEquals(PrinterHomologationFlowPhase.ADOPTING, flow.state.value.phase)
            val second = async { runCatching { flow.confirmFinalReceipt() }.exceptionOrNull() }
            assertTrue(!second.isCompleted)

            releaseAdopter.complete(Unit)
            first.await()

            assertTrue(second.await() is IllegalStateException)
            assertEquals(1, adoptions)
            assertEquals(PrinterHomologationFlowPhase.FINISHED, flow.state.value.phase)
        }

    /**
     * Trocar 58 por 80 não mudava mais nada no estado publicado, o `StateFlow` descartava a emissão
     * por igualdade e a tela seguia marcando 58 mm — indistinguível de "não seleciona". A largura
     * mudava na máquina; só a tela não contava. Visto ao tentar medir a GoldenSky de 80 mm.
     */
    @Test
    fun `trocar a largura do papel muda o estado publicado`() = runTest {
        val flow = flow()
        val inicial = flow.state.value

        flow.startAdvancedPath()
        flow.choosePaperWidth(80)

        assertEquals(58, inicial.geometry.paperWidthMm)
        assertEquals(80, flow.state.value.geometry.paperWidthMm)
        assertNotEquals(inicial, flow.state.value)
        assertEquals(flow.currentGeometry, flow.state.value.geometry)
    }

    @Test
    fun `fluxo curto não envia largura nem corte quando pessoa informa ausência de guilhotina`() = runTest {
        var sends = 0
        val flow = flow(sender = {
            sends += 1
            ThermalPrintResult.Printed
        })

        flow.acceptDefaultGeometry()
        flow.passRasterThroughputProbe()
        flow.passNativeCodeProbe()
        flow.answerCutterPresence(PrinterCutterPresence.NO)
        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.CodePage(null))

        // Sem guilhotina e sem geometria avançada, a medição inteira são três tiras: a de vazão,
        // a de código nativo e a de texto. O comprovante final vem depois, por confirmação humana,
        // e não entra nesta conta.
        assertEquals(3, sends)
        assertEquals(PrinterHomologationFlowPhase.FINAL_RECEIPT_READY, flow.state.value.phase)
        assertEquals(CutProtocol.NONE, flow.previewFinalProfile().cutProtocol)
        assertEquals(0, flow.previewFinalProfile().cutFeedLines)
    }

    @Test
    fun `resposta gratuita de guilhotina muda o estado publicado sem enviar`() = runTest {
        val flow = flow()
        flow.acceptDefaultGeometry()
        flow.passRasterThroughputProbe()
        flow.passNativeCodeProbe()
        val before = flow.state.value

        flow.answerCutterPresence(PrinterCutterPresence.YES)

        assertNotEquals(before, flow.state.value)
        assertEquals(PrinterCutProbeStage.PROBING, flow.state.value.cutStage)
        // A varredura começa no primeiro dialeto da lista e percorre todos antes de perguntar.
        assertEquals(CutProtocol.GS_V_0, flow.state.value.cutProbeProtocol)
    }

    /**
     * O retrocesso atravessa o fluxo sem inventar estado: quem reverte é a máquina, e o estado
     * publicado é a consequência. Nenhum byte sai por causa de um "Voltar".
     */
    @Test
    fun `voltar reverte a medição no estado publicado e não envia nada`() = runTest {
        var sends = 0
        val flow =
            flow(
                sender = {
                    sends += 1
                    ThermalPrintResult.Printed
                },
            )
        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))
        val naEscolhaDeCorte = flow.state.value

        assertEquals(1, sends)
        assertTrue(naEscolhaDeCorte.canGoBack)
        assertEquals(PrinterHomologationStep.GEOMETRY, naEscolhaDeCorte.previousStep)
        assertTrue(naEscolhaDeCorte.backReprintsProbes)

        flow.goBack()

        assertEquals(1, sends)
        assertNotEquals(naEscolhaDeCorte, flow.state.value)
        assertEquals(PrinterHomologationStep.GEOMETRY, flow.state.value.machineState.step)
        assertEquals(PrinterHomologationPhase.READY, flow.state.value.machineState.phase)
        assertEquals(PrinterHomologationStep.WIDTH, flow.state.value.previousStep)

        flow.goBack()

        assertEquals(1, sends)
        assertEquals(PrinterHomologationStep.WIDTH, flow.state.value.machineState.step)
        assertFalse(flow.state.value.canGoBack)
        assertThrows(IllegalStateException::class.java) { flow.goBack() }
    }

    /**
     * O comprovante final volta enquanto a confirmação humana não foi dada.
     *
     * A letra de acento só se prova aqui, e quem lê no comprovante que escolheu errado precisa
     * corrigir antes de dizer "saiu certo". O rascunho vai junto: nada foi persistido, e a próxima
     * passagem por DONE tem de montar o perfil da resposta nova, não reaproveitar o da antiga.
     */
    @Test
    fun `voltar do comprovante final reabre os acentos e descarta o rascunho`() = runTest {
        val store = InMemoryPrinterProfileStore()
        var sends = 0
        val flow = flow(store = store, sender = { sends += 1; ThermalPrintResult.Printed })
        completeMeasurementWithoutCutter(flow)

        assertEquals(PrinterHomologationFlowPhase.FINAL_RECEIPT_READY, flow.state.value.phase)
        assertTrue(flow.state.value.canGoBack)
        assertEquals(PrinterHomologationStep.CODE_PAGE, flow.state.value.previousStep)
        val enviosAntes = sends
        val rascunhoAntigo = requireNotNull(flow.state.value.measuredProfile)

        flow.goBack()

        // Voltar não imprime, não grava e não deixa o rascunho antigo para trás.
        assertEquals(enviosAntes, sends)
        assertTrue(store.read().isEmpty())
        assertEquals(PrinterHomologationFlowPhase.MEASURING, flow.state.value.phase)
        assertEquals(PrinterHomologationStep.CODE_PAGE, flow.state.value.machineState.step)
        assertEquals(PrinterHomologationPhase.READY, flow.state.value.machineState.phase)
        assertEquals(null, flow.state.value.measuredProfile)

        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.CodePage(letraDoCP860))

        val rascunhoNovo = requireNotNull(flow.state.value.measuredProfile)
        assertNotEquals(rascunhoAntigo.codePage, rascunhoNovo.codePage)
        assertEquals(ThermalCodePage.CP860, rascunhoNovo.codePage)
    }

    /**
     * Depois do comprovante enviado ainda volta; depois da confirmação, não.
     *
     * Instalação concluída é concluída: o perfil está no disco e a impressora foi selecionada.
     * Enquanto o envio está no ar também não volta — há bytes a caminho do papel.
     */
    @Test
    fun `a confirmação final fecha o retrocesso de vez`() = runTest {
        val store = InMemoryPrinterProfileStore()
        val flow = flow(store = store)
        completeMeasurementWithoutCutter(flow)
        flow.sendFinalReceipt()

        assertEquals(
            PrinterHomologationFlowPhase.AWAITING_FINAL_CONFIRMATION,
            flow.state.value.phase,
        )
        assertTrue(flow.state.value.canGoBack)

        flow.confirmFinalReceipt()

        assertEquals(PrinterHomologationFlowPhase.FINISHED, flow.state.value.phase)
        assertFalse(flow.state.value.canGoBack)
        assertThrows(IllegalStateException::class.java) { flow.goBack() }
    }

    /** Falha pendente não oferece retrocesso: primeiro se decide sobre a tira que talvez saiu. */
    @Test
    fun `falha de sonda esconde o voltar até a decisão humana`() = runTest {
        var sends = 0
        val flow =
            flow(
                sender = {
                    sends += 1
                    // Geometria, vazão e código nativo saem; quem falha é a primeira tira de
                    // corte.
                    if (sends <= 3) {
                        ThermalPrintResult.Printed
                    } else {
                        ThermalPrintResult.Failed(
                            "Falha de bancada",
                            ThermalPrinterState.Failed("Falha de bancada"),
                            ThermalPrintDelivery.INDETERMINATE,
                        )
                    }
                },
            )
        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))
        flow.passRasterThroughputProbe()
        flow.passNativeCodeProbe()
        flow.answerCutterPresence(PrinterCutterPresence.YES)
        flow.sendAllCutProbes()

        assertEquals(PrinterHomologationFlowPhase.FAILED, flow.state.value.phase)
        assertFalse(flow.state.value.canGoBack)
        assertThrows(IllegalStateException::class.java) { flow.goBack() }

        flow.retryProbe()

        assertTrue(flow.state.value.canGoBack)
    }

    private suspend fun completeMeasurementWithoutCutter(flow: PrinterHomologationFlow) {
        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))
        flow.passRasterThroughputProbe()
        flow.passNativeCodeProbe()
        flow.answerCutterPresence(PrinterCutterPresence.NO)
        flow.sendCurrentProbe()
        // A linha `a` da tira é a frase sem acento: escolhê-la é o perfil ASCII conservador.
        flow.answer(PrinterHomologationAnswer.CodePage(null))
        assertEquals(listOf(0), flow.currentCutFeedChoices)
    }

    private fun flow(
        store: PrinterProfileStore = InMemoryPrinterProfileStore(),
        sender: suspend (PrinterProbe) -> ThermalPrintResult = { ThermalPrintResult.Printed },
        adopter: suspend (MeasuredProfile) -> Unit = {},
        displayName: String = "Impressora de bancada",
        identityReader: suspend () -> PrinterDeclaredIdentity? = { null },
    ): PrinterHomologationFlow {
        val target =
            PrinterHomologationTarget(
                transport = PrinterTransport.USB,
                displayName = displayName,
                profileId = BundledPrinterDrivers.elginI9Full2.id,
                defaultStore = store,
                sender = { bytes -> sender(PrinterProbe(bytes, EscPosDialect.EPSON_COMPATIBLE)) },
                adopter = adopter,
                identityReader = identityReader,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        return PrinterHomologationFlow(
            target = target,
            probeSession = target.openSession(),
            store = store,
            adopter = adopter,
            nowEpochMillis = { 1 },
        )
    }
}
