package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PrinterProbeSessionTest {
    @Test
    fun `sessao de baixo nivel nao expoe rota de adocao`() {
        assertTrue(
            PrinterProbeSession::class.java.declaredMethods.none { method ->
                method.name.contains("adopt", ignoreCase = true)
            },
        )
    }

    @Test
    fun `adoção grava e relê perfil antes de trocar a seleção`() = runTest {
        val events = mutableListOf<String>()
        val storage = InMemoryPrinterProfileStorage()
        val delegate = BinaryPrinterProfileStore(storage)
        val store =
            object : PrinterProfileStore {
                override fun read(): List<MeasuredProfile> =
                    delegate.read().also { events += "read" }

                override fun save(profile: MeasuredProfile) {
                    events += "save"
                    delegate.save(profile)
                }

                override fun remove(profileId: String) = delegate.remove(profileId)
                override fun clear() = delegate.clear()
            }
        var adopted = false
        val target =
            target(
                store = store,
                adopter = {
                    assertTrue(events.indexOf("save") >= 0)
                    assertTrue(events.lastIndexOf("read") > events.indexOf("save"))
                    adopted = true
                    events += "adopt"
                },
            )
        val flow = readyForFinalConfirmation(target, store)

        flow.confirmFinalReceipt()

        assertTrue(adopted)
        assertEquals("adopt", events.last())
    }

    @Test
    fun `store que não confirma impede adoção`() = runTest {
        var adopted = false
        val broken =
            object : PrinterProfileStore {
                override fun read(): List<MeasuredProfile> = emptyList()
                override fun save(profile: MeasuredProfile) = Unit
                override fun remove(profileId: String) = Unit
                override fun clear() = Unit
            }
        val flow = readyForFinalConfirmation(target(broken) { adopted = true }, broken)

        flow.confirmFinalReceipt()

        assertEquals(PrinterHomologationFailurePoint.ADOPTION, flow.state.value.failure?.point)
        assertFalse(adopted)
    }

    @Test
    fun `falha depois de salvar perfil restaura snapshot anterior`() = runTest {
        val store = InMemoryPrinterProfileStore()
        val flow =
            readyForFinalConfirmation(
                target(store) { error("Falha ao trocar a seleção") },
                store,
            )

        flow.confirmFinalReceipt()

        assertEquals(PrinterHomologationFailurePoint.ADOPTION, flow.state.value.failure?.point)
        assertTrue(store.read().isEmpty())
    }

    @Test
    fun `envio usa sessão efêmera e não adota automaticamente`() = runTest {
        var sent = 0
        var adopted = false
        val store = InMemoryPrinterProfileStore()
        val target =
            PrinterHomologationTarget(
                transport = PrinterTransport.USB,
                displayName = "Impressora de bancada",
                profileId = BundledPrinterDrivers.elginI9Full2.id,
                defaultStore = store,
                sender = {
                    sent += 1
                    ThermalPrintResult.Printed
                },
                adopter = { adopted = true },
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        val session = target.openSession()

        assertSame(ThermalPrintResult.Printed, session.send(byteArrayOf(0x1B, 0x40)))

        assertEquals(1, sent)
        assertFalse(adopted)
        assertEquals(PrinterProbeSessionState.READY, session.state)
        session.close()
        assertEquals(PrinterProbeSessionState.CLOSED, session.state)
    }

    @Test
    fun `configuração manual salva e adota sem enviar bytes`() = runTest {
        val store = InMemoryPrinterProfileStore()
        var sends = 0
        var adopted: MeasuredProfile? = null
        val target =
            PrinterHomologationTarget(
                transport = PrinterTransport.USB,
                displayName = "Impressora de bancada",
                profileId = BundledPrinterDrivers.elginI9Full2.id,
                defaultStore = store,
                sender = {
                    sends += 1
                    ThermalPrintResult.Printed
                },
                adopter = { adopted = it },
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        val profile =
            MeasuredProfile.createLocal(
                id = "00000000-0000-4000-8000-000000000091",
                displayName = "Configurada pelo comprovante",
                transports = setOf(PrinterTransport.USB),
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                codePage = null,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 1,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        target.saveManualConfiguration(profile)

        assertEquals(0, sends)
        assertEquals(profile, store.read().single())
        assertEquals(profile, adopted)
    }

    private fun target(
        store: PrinterProfileStore,
        adopter: suspend (MeasuredProfile) -> Unit,
    ): PrinterHomologationTarget =
        PrinterHomologationTarget(
            transport = PrinterTransport.USB,
            displayName = "Impressora de bancada",
            profileId = BundledPrinterDrivers.elginI9Full2.id,
            defaultStore = store,
            sender = { ThermalPrintResult.Printed },
            adopter = adopter,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    private suspend fun readyForFinalConfirmation(
        target: PrinterHomologationTarget,
        store: PrinterProfileStore,
    ): PrinterHomologationFlow =
        target.openHomologation(store).also { flow ->
            flow.sendCurrentProbe()
            flow.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))
            flow.passRasterThroughputProbe()
            flow.passNativeCodeProbe()
            flow.answerCutterPresence(PrinterCutterPresence.NO)
            flow.sendCurrentProbe()
            // A linha `a` da tira é a frase sem acento: escolhê-la é o perfil ASCII conservador.
            flow.answer(PrinterHomologationAnswer.CodePage(null))
            flow.sendFinalReceipt()
        }
}
