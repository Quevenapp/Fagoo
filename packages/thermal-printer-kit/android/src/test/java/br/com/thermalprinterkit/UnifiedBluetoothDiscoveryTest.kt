package br.com.thermalprinterkit

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class UnifiedBluetoothDiscoveryTest {
    private val profile = BundledPrinterDrivers.portable58mm

    @Test
    fun `pareadas aparecem enquanto o scan ble ainda esta em andamento`() = runTest {
        val ble = ControlledBlePort(listOf(BlePrinterHandle(31, "BLE", "BB:00")))
        val printer = printer(RecordingSppPort(), ble)

        val search =
            launch {
                printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true)
            }
        ble.started.await()
        while (
            (printer.bluetoothDiscovery.value as? BluetoothDiscoveryState.Searching)
                ?.candidates
                ?.size != 1
        ) {
            yield()
        }

        val during = printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Searching
        assertEquals(1, during.candidates.size)
        assertSame(BluetoothCandidateOrigin.SPP, during.candidates.single().origin)
        assertFalse(search.isCompleted)

        ble.release.complete(Unit)
        search.join()
        val finished = printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Finished
        assertEquals(2, finished.candidates.size)
    }

    @Test
    fun `mescla por endereco prefere spp e mantem ids opacos distintos`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val spp = RecordingSppPort(BluetoothPrinterHandle(21, "SPP", "AA:00"))
        val ble =
            ControlledBlePort(
                listOf(
                    BlePrinterHandle(31, "BLE duplicada", "AA:00"),
                    BlePrinterHandle(32, "BLE exclusiva", "BB:00"),
                ),
                initiallyReleased = true,
            )
        val printer = printer(spp, ble, store)

        assertSame(
            ThermalPrintResult.Printed,
            printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true),
        )
        val candidates =
            (printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Finished).candidates

        assertEquals(2, candidates.size)
        assertEquals(2, candidates.map(BluetoothPrinterCandidate::id).distinct().size)
        assertEquals(
            listOf(BluetoothCandidateOrigin.SPP, BluetoothCandidateOrigin.BLE),
            candidates.map(BluetoothPrinterCandidate::origin),
        )

        printer.testSearchedBluetoothPrinter(candidates.first().id)
        printer.confirmSearchedPrinter()
        assertEquals(PersistedPrinterSelection.Bluetooth(profile.id), store.read().activeSelection)
        assertFalse(store.toString().contains("AA:00"))
        assertFalse(spp.handle.toString().contains("AA:00"))
    }

    @Test
    fun `preserva nomes e ordena provaveis antes dos outros aparelhos sem esconder nenhum`() = runTest {
        val ble =
            ControlledBlePort(
                handles =
                    listOf(
                        BlePrinterHandle(31, "Caixa de som", "BB:00", isLikelyPrinter = false),
                        BlePrinterHandle(32, "T210_D0E9", "CC:00", isLikelyPrinter = true),
                    ),
                initiallyReleased = true,
            )
        val printer =
            printer(
                RecordingSppPort(BluetoothPrinterHandle(21, "SPP-210", "AA:00")),
                ble,
            )

        printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true)

        val finished = printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Finished
        assertEquals(
            setOf("SPP-210", "T210_D0E9"),
            finished.candidates.take(2).map { it.label }.toSet(),
        )
        assertEquals("Caixa de som", finished.candidates.last().label)
        assertEquals(
            finished.candidates.take(2).mapTo(linkedSetOf(), BluetoothPrinterCandidate::id),
            finished.likelyCandidateIds,
        )
    }

    @Test
    fun `aparelho sem nome nao e chamado de impressora`() = runTest {
        // Enquanto a lista era filtrada, "Impressora Bluetooth N" só aparecia depois de o kit já
        // ter decidido que era impressora. Mostrando tudo, o mesmo rótulo passou a batizar beacon
        // e caixa de som: na bancada, 25 de 28 candidatas vieram sem nome.
        val printer =
            printer(
                RecordingSppPort(BluetoothPrinterHandle(21, "   ")),
                ControlledBlePort(emptyList(), initiallyReleased = true),
            )

        printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true)

        val finished = printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Finished
        val candidata = finished.candidates.single()
        assertEquals("Aparelho sem nome 1", candidata.label)
        assertFalse(candidata.named)
    }

    @Test
    fun `spp vazio e ble sem permissao preservam as duas causas`() = runTest {
        val printer =
            printer(
                RecordingSppPort(handle = null),
                ControlledBlePort(
                    handles = emptyList(),
                    initiallyReleased = true,
                    failure = ThermalPortFailure.BluetoothPermissionDenied,
                ),
            )

        val result =
            printer.searchBluetoothPrinters(profile.id, profile.id, scanBle = true)
                as ThermalPrintResult.Failed
        val finished = printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Finished

        assertSame(ThermalPrinterState.BluetoothPermissionDenied, result.state)
        assertSame(ThermalPrinterState.BluetoothUnavailable, finished.pairedFailure)
        assertSame(ThermalPrinterState.BluetoothPermissionDenied, finished.bleFailure)
        assertTrue(finished.candidates.isEmpty())
    }

    /**
     * O cenário do balcão: procurar a segunda impressora não desinstala a primeira.
     *
     * Medido no A07, duas vezes e inclusive num build que já continha o conserto de f3b13db: a
     * MTP-II estava instalada e ativa em BLE, o usuário iniciou a adoção da T210 — também BLE — e a
     * MTP-II sumiu da lista sem aviso. f3b13db tinha consertado a evicção por chave de perfil
     * dentro de `with()`, mas esta perda é **anterior** à gravação: acontecia na porta da busca,
     * com `withoutActiveAt` + `save` antes de qualquer candidata aparecer. 647bdf3 já tinha tirado
     * esse mesmo padrão de USB, SPP, BLE e Wi-Fi; a busca unificada nasceu depois e o repetiu.
     */
    @Test
    fun `busca BLE nao desinstala quem ja estava instalado e a segunda unidade entra ao lado`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val ble = ControlledBlePort(listOf(mtpII), initiallyReleased = true)
        val printer = printer(RecordingSppPort(handle = null), ble, store)
        adotarPrimeiraBle(printer)
        val instalada = store.read()
        assertEquals(1, instalada.selections.size)

        ble.handles = listOf(t210)
        printer.searchBluetoothPrinters(null, profile.id, scanBle = true)

        assertEquals("A busca apagou a instalação antes de qualquer confirmação.", instalada, store.read())
        assertEquals(1, printer.adoptedPrinters.value.size)

        // E a T210 entra ao lado da MTP-II, com a recém-confirmada assumindo como ativa.
        confirmarCandidataBle(printer)

        val duas = store.read()
        assertEquals(2, duas.selections.size)
        assertEquals(
            PersistedPrinterSelection.BluetoothLe(profile.id, enderecoT210).installationId,
            duas.activeSelection?.installationId,
        )
        assertEquals(2, printer.adoptedPrinters.value.size)
        assertEquals(1, printer.adoptedPrinters.value.count(AdoptedPrinter::active))
    }

    /**
     * Cancelar a busca devolve a lista intacta.
     *
     * Era a consequência agravante do desenho antigo: a remoção acontecia na entrada, então desistir
     * não devolvia nada — a instalação já tinha sido perdida antes de a primeira candidata aparecer.
     */
    @Test
    fun `cancelar a busca BLE preserva a instalacao e a lista publicada`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val ble = ControlledBlePort(listOf(mtpII), initiallyReleased = true)
        val printer = printer(RecordingSppPort(handle = null), ble, store)
        adotarPrimeiraBle(printer)
        val instalada = store.read()

        val lenta = ControlledBlePort(listOf(t210))
        val emBusca = printer(RecordingSppPort(handle = null), lenta, store)
        val busca = launch { emBusca.searchBluetoothPrinters(null, profile.id, scanBle = true) }
        lenta.started.await()
        busca.cancel()
        busca.join()

        assertEquals("Cancelar a busca perdeu a instalação.", instalada, store.read())
        assertEquals(
            "A lista publicada não pode mentir depois do cancelamento.",
            1,
            emBusca.adoptedPrinters.value.size,
        )
        assertTrue(emBusca.adoptedPrinters.value.single().active)
    }

    /** Readotar a MESMA unidade substitui em vez de empilhar: a proteção de f3b13db continua. */
    @Test
    fun `readotar a mesma unidade BLE substitui em vez de duplicar`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val ble = ControlledBlePort(listOf(mtpII), initiallyReleased = true)
        val printer = printer(RecordingSppPort(handle = null), ble, store)
        adotarPrimeiraBle(printer)

        printer.searchBluetoothPrinters(null, profile.id, scanBle = true)
        confirmarCandidataBle(printer)

        assertEquals(1, store.read().selections.size)
        assertEquals(1, printer.adoptedPrinters.value.size)
    }

    /**
     * `removePrinter(transporte)` exclui uma impressora, não o transporte inteiro.
     *
     * Usava `without(transport)`, que apagava **todas** as instalações daquele meio físico: com as
     * duas BLE instaladas, excluir uma levava a irmã junto. Era coerente quando cada transporte só
     * cabia uma impressora. A API continua viva porque a superfície ainda cai nela quando
     * `AdoptedPrinter.installationId` vem nulo.
     */
    @Test
    fun `remover por transporte exclui so a instalacao ativa e preserva a irma`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val ble = ControlledBlePort(listOf(mtpII), initiallyReleased = true)
        val printer = printer(RecordingSppPort(handle = null), ble, store)
        adotarPrimeiraBle(printer)
        ble.handles = listOf(t210)
        printer.searchBluetoothPrinters(null, profile.id, scanBle = true)
        confirmarCandidataBle(printer)
        assertEquals(2, store.read().selections.size)

        printer.removePrinter(PrinterTransport.BLUETOOTH_LE)

        val restante = store.read()
        assertEquals("A exclusão levou junto a irmã que ninguém mandou excluir.", 1, restante.selections.size)
        assertEquals(
            PersistedPrinterSelection.BluetoothLe(profile.id, enderecoMtpII).installationId,
            restante.selections.single().installationId,
        )
        assertEquals(1, printer.adoptedPrinters.value.size)
        assertTrue(printer.adoptedPrinters.value.single().active)
    }

    /**
     * A escolha aparece antes da reconexão.
     *
     * `activateInstallation` reconecta com uma varredura BLE que leva segundos; segurar a
     * publicação até o fim dela congela o check na unidade anterior — na bancada de 19/08 isso foi
     * lido como "não dá para selecionar a outra impressora", com a troca já gravada no store.
     */
    @Test
    fun `ativar a outra unidade publica a escolha antes da varredura de reconexao terminar`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val ble = ControlledBlePort(listOf(mtpII), initiallyReleased = true)
        val printer = printer(RecordingSppPort(handle = null), ble, store)
        adotarPrimeiraBle(printer)
        ble.handles = listOf(t210)
        printer.searchBluetoothPrinters(null, profile.id, scanBle = true)
        confirmarCandidataBle(printer)
        val mtpInstalada = printer.adoptedPrinters.value.single { !it.active }

        val lenta = ControlledBlePort(listOf(mtpII))
        val reativando = printer(RecordingSppPort(handle = null), lenta, store)
        val ativacao = launch {
            reativando.activateInstallation(mtpInstalada.installationId!!)
        }
        lenta.started.await()

        assertFalse(ativacao.isCompleted)
        val duranteAVarredura = reativando.adoptedPrinters.value
        assertEquals(
            "O check precisa mover no toque, não no fim da varredura.",
            mtpInstalada.installationId,
            duranteAVarredura.single(AdoptedPrinter::active).installationId,
        )

        lenta.release.complete(Unit)
        ativacao.join()
        assertEquals(
            mtpInstalada.installationId,
            reativando.adoptedPrinters.value.single(AdoptedPrinter::active).installationId,
        )
    }

    /** O caminho é compartilhado, então a pareada precisa do mesmo par de cheques. */
    @Test
    fun `busca SPP nao desinstala a pareada instalada e a segunda entra ao lado`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val spp = RecordingSppPort(BluetoothPrinterHandle(21, "MTP-II", enderecoMtpII))
        val printer = printer(spp, ControlledBlePort(emptyList(), initiallyReleased = true), store)
        printer.searchBluetoothPrinters(profile.id, null, scanBle = false)
        printer.testSearchedBluetoothPrinter(candidataUnica(printer))
        printer.confirmSearchedPrinter()
        val instalada = store.read()
        assertEquals(1, instalada.selections.size)

        spp.handle = BluetoothPrinterHandle(22, "T210", enderecoT210)
        printer.searchBluetoothPrinters(profile.id, null, scanBle = false)

        assertEquals("A busca SPP apagou a instalação antes de confirmar.", instalada, store.read())
        assertEquals(1, printer.adoptedPrinters.value.size)

        printer.testSearchedBluetoothPrinter(candidataUnica(printer))
        printer.confirmSearchedPrinter()

        val duas = store.read()
        assertEquals(2, duas.selections.size)
        assertEquals(
            PersistedPrinterSelection.Bluetooth(profile.id, enderecoT210).installationId,
            duas.activeSelection?.installationId,
        )
    }

    private val enderecoMtpII = "AA:BB:CC:DD:EE:01"
    private val enderecoT210 = "AA:BB:CC:DD:EE:02"
    private val mtpII = BlePrinterHandle(31, "MTP-II", enderecoMtpII, isLikelyPrinter = true)
    private val t210 = BlePrinterHandle(32, "T210_D0E9", enderecoT210, isLikelyPrinter = true)

    private fun candidataUnica(printer: LocalWifiThermalPrinter): Long =
        (printer.bluetoothDiscovery.value as BluetoothDiscoveryState.Finished).candidates.single().id

    private suspend fun adotarPrimeiraBle(printer: LocalWifiThermalPrinter) {
        printer.searchBluetoothPrinters(null, profile.id, scanBle = true)
        confirmarCandidataBle(printer)
    }

    private suspend fun confirmarCandidataBle(printer: LocalWifiThermalPrinter) {
        printer.testSearchedBluetoothLePrinter(candidataUnica(printer))
        printer.confirmSearchedPrinter()
    }

    private fun printer(
        spp: RecordingSppPort,
        ble: ControlledBlePort,
        store: PrinterSelectionStore = InMemoryPrinterSelectionStore(),
    ): LocalWifiThermalPrinter =
        LocalWifiThermalPrinter(
            port = SilentWifiPort(),
            bluetoothPort = spp,
            blePort = ble,
            discovery =
                object : LocalWifiPrinterDiscovery {
                    override suspend fun findCandidates(
                        profile: PrinterDriverProfile,
                        attachment: PrinterNetworkAttachment,
                    ) =
                        LocalWifiPrinterDiscoveryResult.NotFound

                    override fun reject(
                        network: LocalWifiNetwork,
                        endpoint: LocalWifiPrinterEndpoint,
                    ) = Unit
                },
            networkProvider = LocalWifiNetworkProvider { null },
            selectionStore = store,
        )

    private class RecordingSppPort(
        /** `var` para a bancada trocar a pareada entre duas buscas do mesmo aparelho. */
        var handle: BluetoothPrinterHandle? = BluetoothPrinterHandle(21, "SPP", "AA:00"),
    ) : BluetoothThermalPort {
        override fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle> =
            listOfNotNull(handle)

        override suspend fun open(handle: BluetoothPrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun drain() = Unit

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT
    }

    private class ControlledBlePort(
        /** `var` para a bancada trocar de aparelho anunciado entre duas buscas seguidas. */
        var handles: List<BlePrinterHandle>,
        initiallyReleased: Boolean = false,
        private val failure: ThermalPortFailure? = null,
    ) : BleThermalPort {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>().apply { if (initiallyReleased) complete(Unit) }

        override suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle> {
            started.complete(Unit)
            release.await()
            failure?.let { throw ThermalPortException(it) }
            return handles
        }

        override suspend fun open(handle: BlePrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit
    }

    private class SilentWifiPort : LocalWifiThermalPort {
        override fun open(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
            profile: PrinterDriverProfile,
        ) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT
    }
}
