package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O comprovante de teste sai **na impressora do card tocado**.
 *
 * Medido no iPhone 7 em 20/08, com duas portáteis instaladas: tocar em Testar no card da MTP-II,
 * que não era a ativa, imprimiu na outra. O caminho do Android é o mesmo — `testPrinter` mira o
 * transporte, e o transporte guarda a conexão de quem está servindo, que é a ativa.
 *
 * A régua que estes testes fixam: o destino é a unidade, a escolha da pessoa não muda por causa de
 * um teste, e unidade que não responde recusa **sem papel em lugar nenhum**. Cair na ativa é o
 * defeito, não o plano B.
 */
class TesteDaUnidadeDoCardTest {
    private val balcaoAddress = "aa:bb:cc:dd:ee:01"
    private val reservaAddress = "aa:bb:cc:dd:ee:02"
    private val portatil = BundledPrinterDrivers.portable58mm.id
    private val t210 = BundledPrinterDrivers.inicoT210.id

    private val ativa = PersistedPrinterSelection.BluetoothLe(portatil, balcaoAddress)
    private val irma = PersistedPrinterSelection.BluetoothLe(portatil, reservaAddress)

    private fun guardadas(
        vararg selecoes: PersistedPrinterSelection,
        ativaEntreElas: PersistedPrinterSelection,
    ) = PersistedPrinterSelections(
        selections = selecoes.toList(),
        active = ativaEntreElas.transport,
        activeProfileId = ativaEntreElas.profileId,
        activeInstallationId = ativaEntreElas.installationId,
    )

    /** O cheque do dono: Testar no card da parada sai NELA, com a ativa ligada do lado. */
    @Test
    fun `testar a inativa envia para a unidade do card`() = runTest {
        val radio = BancadaBlePort(ligadas = listOf(balcaoAddress, reservaAddress))
        val store = MemoriaSelectionStore(guardadas(ativa, irma, ativaEntreElas = ativa))
        val printer = printerCom(radio, store)
        printer.restore()
        radio.limpar()

        val resultado = printer.testInstallation(irma.installationId)

        assertEquals(ThermalPrintResult.Printed, resultado)
        assertEquals(
            "O comprovante saiu numa impressora que ninguém pediu.",
            listOf(reservaAddress),
            radio.imprimiramEm(),
        )
    }

    /** Testar não escolhe: quem recebe os cupons continua sendo quem recebia. */
    @Test
    fun `depois de testar a irma a ativa continua ativa e volta a receber o cupom`() = runTest {
        val radio = BancadaBlePort(ligadas = listOf(balcaoAddress, reservaAddress))
        val store = MemoriaSelectionStore(guardadas(ativa, irma, ativaEntreElas = ativa))
        val printer = printerCom(radio, store)
        printer.restore()

        printer.testInstallation(irma.installationId)

        assertEquals(
            "Um teste trocou a impressora ativa.",
            ativa.installationId,
            printer.adoptedPrinters.value.single { it.active }.installationId,
        )
        assertEquals("Testar gravou no store.", 0, store.saveCalls)

        radio.limpar()
        printer.print(cupomDeUnidade())

        assertEquals(
            "A conexão em memória da ativa não voltou depois do teste.",
            listOf(balcaoAddress),
            radio.imprimiramEm(),
        )
    }

    /**
     * Unidade desligada: recusa nomeando **a do card**, e nenhum byte em nenhuma impressora.
     *
     * Duas impressoras de modelos diferentes de propósito: com o mesmo nome nos dois cards, a
     * frase não provaria qual delas foi recusada.
     */
    @Test
    fun `unidade fora de alcance recusa nomeada e nao imprime em ninguem`() = runTest {
        val parada = PersistedPrinterSelection.BluetoothLe(t210, reservaAddress)
        val radio = BancadaBlePort(ligadas = listOf(balcaoAddress))
        val store = MemoriaSelectionStore(guardadas(ativa, parada, ativaEntreElas = ativa))
        val printer = printerCom(radio, store)
        printer.restore()
        radio.limpar()

        val resultado = printer.testInstallation(parada.installationId)

        val falha = resultado as ThermalPrintResult.Failed
        assertEquals(ThermalPrintDelivery.NOT_SENT, falha.delivery)
        assertTrue(
            "A recusa precisa nomear a impressora do card: ${falha.message}",
            falha.message.contains(BundledPrinterDrivers.inicoT210.displayName),
        )
        assertTrue(
            "A recusa nomeou a impressora errada: ${falha.message}",
            !falha.message.contains(BundledPrinterDrivers.portable58mm.displayName),
        )
        assertEquals(
            "Saiu papel de uma impressora que a pessoa não pediu.",
            emptyList<String?>(),
            radio.imprimiramEm(),
        )
    }

    /** Depois da recusa, a ativa continua alcançável: o teste não pode custar a conexão dela. */
    @Test
    fun `recusa da irma devolve a conexao da ativa`() = runTest {
        val parada = PersistedPrinterSelection.BluetoothLe(t210, reservaAddress)
        val radio = BancadaBlePort(ligadas = listOf(balcaoAddress))
        val store = MemoriaSelectionStore(guardadas(ativa, parada, ativaEntreElas = ativa))
        val printer = printerCom(radio, store)
        printer.restore()

        printer.testInstallation(parada.installationId)
        radio.limpar()
        val cupom = printer.print(cupomDeUnidade())

        assertEquals(ThermalPrintResult.Printed, cupom)
        assertEquals(listOf(balcaoAddress), radio.imprimiramEm())
    }

    /**
     * Testar a própria ativa é o caminho de sempre, byte a byte.
     *
     * O comprovante é a peça que prova o perfil no papel; qualquer diferença aqui seria uma
     * mudança de bytes homologados entrando de carona numa correção de destino.
     */
    @Test
    fun `testar a ativa continua enviando exatamente os mesmos bytes`() = runTest {
        val porUnidade = BancadaBlePort(ligadas = listOf(balcaoAddress, reservaAddress))
        val porTransporte = BancadaBlePort(ligadas = listOf(balcaoAddress, reservaAddress))
        val comUnidade = printerCom(porUnidade, MemoriaSelectionStore(guardadas(ativa, irma, ativaEntreElas = ativa)))
        val comTransporte =
            printerCom(porTransporte, MemoriaSelectionStore(guardadas(ativa, irma, ativaEntreElas = ativa)))
        comUnidade.restore()
        comTransporte.restore()
        porUnidade.limpar()
        porTransporte.limpar()

        val novo = comUnidade.testInstallation(ativa.installationId)
        val antigo = comTransporte.testPrinter(PrinterTransport.BLUETOOTH_LE)

        assertEquals(antigo, novo)
        assertEquals(listOf(balcaoAddress), porUnidade.imprimiramEm())
        assertEquals(
            "O comprovante da ativa mudou de bytes.",
            porTransporte.bytesDe(balcaoAddress),
            porUnidade.bytesDe(balcaoAddress),
        )
    }

    /** Instalação que não existe não pode virar comprovante em impressora nenhuma. */
    @Test
    fun `instalacao desconhecida nao imprime em ninguem`() = runTest {
        val radio = BancadaBlePort(ligadas = listOf(balcaoAddress, reservaAddress))
        val store = MemoriaSelectionStore(guardadas(ativa, irma, ativaEntreElas = ativa))
        val printer = printerCom(radio, store)
        printer.restore()
        radio.limpar()

        val resultado = printer.testInstallation("instalacao.que.nao.existe")

        assertTrue(resultado is ThermalPrintResult.Failed)
        assertEquals(emptyList<String?>(), radio.imprimiramEm())
        assertEquals(0, store.saveCalls)
    }

    private fun cupomDeUnidade() =
        object : ThermalReceiptPayload {
            override fun receiptBytes(layout: ReceiptLayout): ByteArray = byteArrayOf(0x41)

            override fun clear() = Unit
        }

    private fun printerCom(
        radio: BancadaBlePort,
        store: MemoriaSelectionStore,
    ) = LocalWifiThermalPrinter(
        port = PortaWifiMuda(),
        blePort = radio,
        discovery = LocalWifiPrinterDiscovery { _, _ -> LocalWifiPrinterDiscoveryResult.NotFound },
        networkProvider = LocalWifiNetworkProvider { null },
        selectionStore = store,
        profileStore = InMemoryPrinterProfileStore(),
    )

    /** Rádio de bancada: só as ligadas anunciam, e cada byte fica creditado a quem o recebeu. */
    private class BancadaBlePort(
        private val ligadas: List<String>,
    ) : BleThermalPort {
        private val escritas = linkedMapOf<String?, MutableList<ByteArray>>()
        private var aberta: BlePrinterHandle? = null

        override suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle> =
            ligadas.mapIndexed { indice, address ->
                BlePrinterHandle(
                    id = indice + 1L,
                    label = "Portátil ${indice + 1}",
                    discoveryAddress = address,
                    isLikelyPrinter = true,
                )
            }

        override suspend fun open(
            handle: BlePrinterHandle,
            profile: PrinterDriverProfile,
        ) {
            aberta = handle
        }

        override fun close() {
            aberta = null
        }

        override fun write(data: ByteArray) {
            escritas.getOrPut(aberta?.discoveryAddress) { mutableListOf() } += data.copyOf()
        }

        fun limpar() = escritas.clear()

        /** Em quais unidades saiu papel, na ordem em que saiu. */
        fun imprimiramEm(): List<String?> = escritas.keys.toList()

        fun bytesDe(address: String): List<List<Byte>> =
            escritas[address].orEmpty().map { it.toList() }
    }

    private class MemoriaSelectionStore(
        private var current: PersistedPrinterSelections,
    ) : PrinterSelectionStore {
        var saveCalls = 0

        override fun read(): PersistedPrinterSelections = current

        override fun save(selections: PersistedPrinterSelections) {
            saveCalls += 1
            current = selections
        }

        override fun clear() {
            current = PersistedPrinterSelections()
        }
    }

    private class PortaWifiMuda : LocalWifiThermalPort {
        override fun open(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
            profile: PrinterDriverProfile,
        ) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun coverStatus() = ThermalCoverStatus.CLOSED

        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }
}
