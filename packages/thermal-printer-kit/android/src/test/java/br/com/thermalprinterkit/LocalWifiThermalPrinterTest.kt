package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets
import java.time.Instant
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalWifiThermalPrinterTest {
    @Test
    fun `temporary discovery profile is conservative ephemeral and reaches search`() = runTest {
        val network = FakeLocalWifiNetwork()
        val discovery = RecordingDiscovery(network, listOf(endpoint(88)))
        val printer = printer(network, RecordingLocalWifiPort(), discovery)

        val temporary =
            printer.prepareTemporaryDiscoveryProfile(
                transport = PrinterTransport.LOCAL_WIFI,
                paperWidthMm = 58,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        assertEquals(null, temporary.codePage)
        assertEquals(CutProtocol.NONE, temporary.cutProtocol)
        assertEquals(0, temporary.cutFeedLines)
        assertTrue(printer.profileStore.read().isEmpty())
        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(temporary.id))
        assertEquals(listOf(temporary), discovery.searchedProfiles)
        assertTrue(printer.profileStore.read().isEmpty())
    }

    /**
     * A largura escolhida depois da busca precisa alcançar a candidata.
     *
     * O perfil temporário é criado no momento da busca, com a largura daquele instante, e a
     * candidata guarda **esse** perfil. Tocar em "58 mm" depois só trocava o que a tela mostrava:
     * medido em papel na LUOGAO em 12/08, a tela marcava 58 e o comprovante saiu "Impressora
     * temporária 80 mm", 48 colunas e 576 dots — e a homologação inteira seguiu em 80, porque a
     * largura dela vem do perfil da candidata.
     */
    @Test
    fun `a largura escolhida depois da busca alcança a candidata pendente`() = runTest {
        val network = FakeLocalWifiNetwork()
        val printer =
            printer(
                network = network,
                port = RecordingLocalWifiPort(),
                discovery = RecordingDiscovery(network, listOf(endpoint(88))),
            )
        val largo =
            printer.prepareTemporaryDiscoveryProfile(
                transport = PrinterTransport.LOCAL_WIFI,
                paperWidthMm = 80,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(largo.id))
        val candidate =
            (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))
        assertEquals(80, printer.openHomologationTarget()?.paperWidthMm)

        printer.applyTemporaryDiscoveryPaperWidth(58)

        val alvo = printer.openHomologationTarget()
        assertEquals(58, alvo?.paperWidthMm)
        assertEquals("temporary.58.local_wifi", alvo?.profileId)
        // Nada foi adotado nem gravado: trocar a largura antes de medir não é uma medição.
        assertTrue(printer.profileStore.read().isEmpty())
    }

    /**
     * Apagar medição é a saída para medição errada, e ela existe porque medição errada existe.
     *
     * A regra "perfil medido nunca é sobrescrito" protege contra acidente, não contra vontade: a
     * T210 foi gravada com 80 mm e 48 colunas em 12/08 porque a largura da busca atravessou de
     * outra impressora, e sem isso o único caminho seria limpar os dados do app inteiro.
     */
    @Test
    fun `apagar a medição solta a impressora que apontava para ela`() = runTest {
        val network = FakeLocalWifiNetwork()
        val store = InMemoryPrinterSelectionStore()
        val printer =
            printer(
                network = network,
                port = RecordingLocalWifiPort(),
                discovery = RecordingDiscovery(network, listOf(endpoint(88))),
                store = store,
            )
        val medido =
            MeasuredProfile.createLocal(
                id = java.util.UUID.randomUUID().toString(),
                displayName = "T210 de bancada",
                transports = setOf(PrinterTransport.LOCAL_WIFI),
                paperWidthMm = 80,
                printableColumns = 48,
                printableDots = 576,
                codePage = ThermalCodePage.CP860,
                textEncoding = ThermalTextEncoding.FIRMWARE_DEFAULT_PAGE,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 1,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        printer.profileStore.save(medido)
        store.save(store.read().with(PersistedPrinterSelection.LocalWifi(medido.id)))
        assertEquals(listOf(medido), printer.profileStore.read())

        printer.forgetMeasuredProfile(medido.id)

        assertTrue(printer.profileStore.read().isEmpty())
        assertEquals(null, store.read().of(PrinterTransport.LOCAL_WIFI))
        assertTrue(printer.adoptedPrinters.value.none { it.displayName == medido.displayName })
    }

    @Test
    fun `temporary discovery cannot be confirmed before measurement and mutates nothing`() = runTest {
        val network = FakeLocalWifiNetwork()
        val store = InMemoryPrinterSelectionStore()
        val printer =
            printer(
                network = network,
                port = RecordingLocalWifiPort(),
                discovery = RecordingDiscovery(network, listOf(endpoint(88))),
                store = store,
            )
        val temporary =
            printer.prepareTemporaryDiscoveryProfile(
                transport = PrinterTransport.LOCAL_WIFI,
                paperWidthMm = 58,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(temporary.id))
        val candidate =
            (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))

        val selectionBefore = store.read()
        val stateBefore = printer.state.value
        val adoptedBefore = printer.adoptedPrinters.value
        assertTrue(printer.hasPendingTemporaryDiscoveryProfile())
        val targetBefore = printer.openHomologationTarget()
        val failure = runCatching { printer.confirmSearchedPrinter() }.exceptionOrNull()

        assertTrue(failure is IllegalStateException)
        assertEquals(temporary.id, targetBefore?.profileId)
        assertEquals(selectionBefore, store.read())
        assertSame(stateBefore, printer.state.value)
        assertEquals(adoptedBefore, printer.adoptedPrinters.value)
        assertTrue(printer.hasPendingTemporaryDiscoveryProfile())
        assertEquals(temporary.id, printer.openHomologationTarget()?.profileId)
        assertTrue(printer.profileStore.read().isEmpty())
    }

    @Test
    fun `sem transporte ativo o teste falha em vez de chutar a Wi-Fi`() = runTest {
        // Visto na bancada com a T210: o USB não estava adotável, e o comprovante saiu pelo
        // Bluetooth ativo sem a tela dizer nada. O fallback silencioso para LOCAL_WIFI fazia
        // "não escolhi impressora" virar "a Wi-Fi falhou", e podia imprimir onde ninguém pediu.
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer = printer(network, port, RecordingDiscovery(network, listOf(endpoint(88))))

        val resultado = printer.testSelectedPrinter() as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.PrinterNotSelected, resultado.state)
        assertEquals(emptyList<LocalWifiPrinterEndpoint>(), port.openedEndpoints)
    }

    @Test
    fun `medição salva depois da construção fica disponível sem reiniciar`() = runTest {
        val network = FakeLocalWifiNetwork()
        val discovery = RecordingDiscovery(network, listOf(endpoint(88)))
        val profileStore = InMemoryPrinterProfileStore()
        val measured = localWifiMeasuredProfile()
        val printer =
            printer(
                network,
                RecordingLocalWifiPort(),
                discovery,
                profileStore = profileStore,
            )

        val beforeUpdate = printer.searchLocalWifi(measured.id) as ThermalPrintResult.Failed
        assertSame(ThermalPrinterState.PrinterNotSelected, beforeUpdate.state)
        profileStore.save(measured)

        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(measured.id))
        assertEquals(listOf(measured.toDriverProfile()), discovery.searchedProfiles)
        profileStore.remove(measured.id)
        val afterRemoval = printer.searchLocalWifi(measured.id) as ThermalPrintResult.Failed
        assertSame(ThermalPrinterState.PrinterNotSelected, afterRemoval.state)
    }

    @Test
    fun `restore relê medição salva depois da construção`() = runTest {
        val network = FakeLocalWifiNetwork()
        val discovery = RecordingDiscovery(network, listOf(endpoint(88)))
        val profileStore = InMemoryPrinterProfileStore()
        val measured = localWifiMeasuredProfile()
        val selectionStore =
            InMemoryPrinterSelectionStore().apply {
                save(
                    PersistedPrinterSelections(
                        selections = listOf(PersistedPrinterSelection.LocalWifi(measured.id)),
                        active = PrinterTransport.LOCAL_WIFI,
                    ),
                )
            }
        val printer =
            printer(
                network,
                RecordingLocalWifiPort(),
                discovery,
                store = selectionStore,
                profileStore = profileStore,
            )
        profileStore.save(measured)

        printer.restore()

        assertSame(ThermalPrinterState.Ready, printer.state.value)
        assertEquals(listOf(measured.toDriverProfile()), discovery.searchedProfiles)
    }

    @Test
    fun `search lists all candidates and only the tested confirmed printer receives a ticket`() = runTest {
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val discovery = RecordingDiscovery(network, listOf(endpoint(88), endpoint(91)))
        val store = InMemoryPrinterSelectionStore()
        val printer = printer(network, port, discovery, store)

        assertSame(
            ThermalPrintResult.Printed,
            printer.searchLocalWifi(BundledPrinterDrivers.elginI9Full2.id),
        )
        val candidates = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates
        assertEquals(listOf("Impressora encontrada 1", "Impressora encontrada 2"), candidates.map { it.label })
        assertEquals(listOf("192.168.31.88", "192.168.31.91"), candidates.map { it.ipAddress })
        assertFalse(printer.state.value.toString().contains("192.168."))

        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidates[1].id))
        assertSame(ThermalPrinterState.SearchConfirmationRequired, printer.state.value)
        assertEquals(1, port.openedEndpoints.size)

        val beforeConfirmation = printer.print(testReceiptPayload()) as ThermalPrintResult.Failed
        assertSame(ThermalPrinterState.SearchConfirmationRequired, beforeConfirmation.state)
        assertEquals(1, port.openedEndpoints.size)

        printer.confirmSearchedPrinter()
        assertSame(ThermalPrinterState.Ready, printer.state.value)
        assertEquals(
            PersistedPrinterSelection.LocalWifi(
                BundledPrinterDrivers.elginI9Full2.id,
                PersistedNetworkEndpoint("192.168.31.91", 9_100),
            ),
            store.read().of(PrinterTransport.LOCAL_WIFI),
        )
        assertFalse(store.read().toString().contains("192.168.31.91"))
        assertSame(ThermalPrintResult.Printed, printer.print(testReceiptPayload()))
        assertEquals(2, port.openedEndpoints.size)
        assertTrue(port.containsRasterImage())
        assertFalse(port.allText().contains("#t="))
        assertFalse(printer.toString().contains("#t="))
    }

    @Test
    fun `rejecting a candidate keeps the other discovered printers available`() = runTest {
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val first = endpoint(88)
        val second = endpoint(91)
        val discovery = RecordingDiscovery(network, listOf(first, second))
        val printer = printer(network, port, discovery)

        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(BundledPrinterDrivers.elginI9Full2.id))
        val firstCandidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.first()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(firstCandidate.id))

        printer.discardSearchedPrinter()

        val remaining = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates
        assertEquals(1, remaining.size)
        assertEquals("Impressora encontrada 2", remaining.single().label)
        assertEquals(listOf(first), discovery.rejected)
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(remaining.single().id))
        assertEquals(2, port.openedEndpoints.size)
        assertFalse(port.allText().contains("#access="))
    }

    /**
     * Em Wi-Fi direto a impressora **é** o gateway: digitá-lo é o caminho legítimo, e ele só fica
     * fora da varredura para não sondar o roteador do estabelecimento. Medido na bancada com a
     * GoldenSky no AP `10.10.100.0/24`, atendendo na 9100 do `.254` — endereço que a tela recusava
     * como inválido, tanto na busca quanto digitado à mão.
     */
    @Test
    fun `gateway digitado à mão imprime, porque em Wi-Fi direto ele é a impressora`() = runTest {
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer = printer(network, port, RecordingDiscovery(network, listOf(endpoint(88))))
        val profile = BundledPrinterDrivers.elginI9Full2
        val profilePort = requireNotNull(profile.tcpPort)

        val resultado = printer.testLocalWifiAddress(profile.id, "192.168.31.1", profilePort)

        assertSame(ThermalPrintResult.Printed, resultado)
        assertSame(ThermalPrinterState.SearchConfirmationRequired, printer.state.value)
        printer.confirmSearchedPrinter()
        assertSame(ThermalPrintResult.Printed, printer.print(testReceiptPayload()))
    }

    @Test
    fun `advanced address accepts only current Wi-Fi host and selected driver port`() = runTest {
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer = printer(network, port, RecordingDiscovery(network, listOf(endpoint(88))))
        val profile = BundledPrinterDrivers.elginI9Full2
        val profilePort = requireNotNull(profile.tcpPort)

        val wrongPort =
            printer.testLocalWifiAddress(profile.id, "192.168.31.88", 9_101) as ThermalPrintResult.Failed
        val wrongSubnet =
            printer.testLocalWifiAddress(profile.id, "192.168.32.88", profilePort) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.LocalWifiAddressInvalid, wrongPort.state)
        assertSame(ThermalPrinterState.LocalWifiAddressInvalid, wrongSubnet.state)
        assertTrue(port.openedEndpoints.isEmpty())

        assertSame(
            ThermalPrintResult.Printed,
            printer.testLocalWifiAddress(profile.id, "192.168.31.88", profilePort),
        )
        assertSame(ThermalPrinterState.SearchConfirmationRequired, printer.state.value)
        printer.confirmSearchedPrinter()
        assertSame(ThermalPrintResult.Printed, printer.print(testReceiptPayload()))
        assertEquals(2, port.openedEndpoints.size)
    }

    @Test
    fun `confirmed Wi-Fi printer prints receipts without ever leaking the signature as text`() = runTest {
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer = printer(network, port, RecordingDiscovery(network, listOf(endpoint(88))))
        val profile = BundledPrinterDrivers.elginI9Full2

        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(profile.id))
        val candidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))
        printer.confirmSearchedPrinter()

        assertSame(ThermalPrintResult.Printed, printer.print(testReceiptPayload()))
        assertSame(
            ThermalPrintResult.Printed,
            printer.print(testReceiptPayload(qrPayload = "QF1.1.4238.3.${"B".repeat(86)}")),
        )

        // O QR vira imagem, nunca comando nativo: firmware que não entende `GS ( k` imprimiria o
        // payload como texto legível, e a assinatura no papel tornaria o cupom falsificável.
        assertTrue(port.containsRasterImage())
        assertFalse(
            "a assinatura do cupom não pode sair como texto",
            port.allText().contains("792II2EnbL76"),
        )
        assertFalse(port.allText().contains("QF1."))
        assertEquals(3, port.openedEndpoints.size)
    }

    @Test
    fun `explicit test uses the already confirmed Wi-Fi printer`() = runTest {
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer = printer(network, port, RecordingDiscovery(network, listOf(endpoint(88))))

        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(BundledPrinterDrivers.elginI9Full2.id))
        val candidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))
        printer.confirmSearchedPrinter()

        assertSame(ThermalPrintResult.Printed, printer.testSelectedPrinter())
        assertSame(ThermalPrinterState.Ready, printer.state.value)
        assertEquals(2, port.openedEndpoints.size)
        // O teste passou a imprimir o comprovante do perfil adotado: duas linhas genéricas só
        // provavam que o socket abre, e impressora que recebe bytes ainda erra acento, corta em
        // cima do texto ou não faz QR.
        assertTrue(port.allText().contains("COMPROVANTE DE TESTE"))
        // Nome do perfil e aparelho que recebeu são coisas diferentes. Na bancada, um comprovante
        // do perfil da T210 saiu na MTP-II e a tira não dizia por onde tinha saído.
        assertTrue(port.allText().contains("Saiu por: rede Wi-Fi"))
        assertTrue(port.allText().contains("Corte: NONE"))
        // O comprovante de teste também lista capacidades, e a compensação vertical é a que muda
        // os bytes do QR logo abaixo dele. Perfil embutido não tem fator, e a linha diz isso.
        assertTrue(port.allText().contains("Vazao: sem compensacao"))
        // E as duas da sonda de código nativo, pelo mesmo argumento: é este o papel que a pessoa
        // tem na mão quando decide se o ajuste de emissão vale. Perfil embutido nasce sem as duas
        // respostas, e as linhas dizem exatamente isso — a ausência é a informação.
        assertTrue(port.allText().contains("QR nativo: nao medido"))
        assertTrue(port.allText().contains("Barras nativas: nao medido"))
    }

    /**
     * O comprovante de teste repete o fator do perfil adotado.
     *
     * Sem esta linha, o papel que a pessoa manda imprimir um mês depois da homologação mostra
     * colunas, dots, página e corte e esconde a única capacidade que alterou o comportamento da
     * impressora — enquanto o QR ali embaixo já sai compensado por ela.
     */
    @Test
    fun `o comprovante de teste registra a compensação do perfil adotado`() = runTest {
        val profileStore = InMemoryPrinterProfileStore()
        val medido =
            MeasuredProfile.createLocal(
                id = "0d1a4c52-6e1f-4b83-9a77-2f0c8b5d1e64",
                displayName = "Inico T210",
                transports = setOf(PrinterTransport.LOCAL_WIFI),
                paperWidthMm = 58,
                printableColumns = 32,
                printableDots = 384,
                // Sem página medida o encoder dobra os acentos, e a linha continua legível: é a
                // regra de nunca usar caractere que a página não tenha.
                codePage = null,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                verticalRasterScale = 38.0 / PrinterHomologationProbes.RASTER_THROUGHPUT_STRIP_MM,
                measuredAtEpochMillis = 1,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        profileStore.save(medido)
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer =
            printer(
                network,
                port,
                RecordingDiscovery(network, listOf(endpoint(88))),
                profileStore = profileStore,
            )

        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(medido.id))
        val candidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))

        assertTrue(port.allText(), port.allText().contains("Vazao: 38/48 mm | fator 0,79"))
    }

    /**
     * O comprovante de teste tem de sair na página medida, e não na padrão do kit: é ele que prova
     * que o perfil relido do disco é o que a bancada mediu. A frase acentuada sai igual na leitura
     * em CP850 e em UTF-8, e diferente no fio.
     */
    @Test
    fun `o comprovante de teste sai na codificação do perfil adotado`() = runTest {
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer = printer(network, port, RecordingDiscovery(network, listOf(endpoint(88))))
        val profile = BundledPrinterDrivers.elginI9Full2

        printer.searchLocalWifi(profile.id)
        val candidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        printer.testSearchedLocalWifiPrinter(candidate.id)
        printer.confirmSearchedPrinter()
        val antes = port.allBytes().size

        assertSame(ThermalPrintResult.Printed, printer.testSelectedPrinter())

        val frase = "Acentos: ação, opção, São João\n"
        val esperado =
            EscPosThermalCommands.text(
                frase,
                ThermalTextAlignment.LEFT,
                ThermalTextStyle.NORMAL,
                0,
                codePage = profile.codePage,
                codePageSelector = profile.codePageSelector,
                textEncoding = profile.textEncoding,
            ).toList().takeLast(frase.length)
        val impresso = port.allBytes().drop(antes)
        assertTrue(
            "A frase acentuada precisa sair na página do perfil",
            impresso.windowed(esperado.size).any { it == esperado },
        )
    }

    @Test
    fun `confirmed Wi-Fi profile restores only an unambiguous rediscovered printer`() = runTest {
        val network = FakeLocalWifiNetwork()
        val store = InMemoryPrinterSelectionStore()
        val firstPort = RecordingLocalWifiPort()
        val first = printer(network, firstPort, RecordingDiscovery(network, listOf(endpoint(88))), store)

        first.searchLocalWifi(BundledPrinterDrivers.elginI9Full2.id)
        val candidate = (first.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        first.testSearchedLocalWifiPrinter(candidate.id)
        first.confirmSearchedPrinter()

        val restoredPort = RecordingLocalWifiPort()
        val restored =
            printer(network, restoredPort, RecordingDiscovery(network, listOf(endpoint(88))), store)
        // IP nunca vai para disco. A readoção repete a descoberta pelo perfil e só assume o
        // endpoint porque há exatamente uma candidata; duas exigiriam escolha humana de novo.
        restored.restore()

        assertSame(ThermalPrinterState.Ready, restored.state.value)
        assertSame(ThermalPrintResult.Printed, restored.testSelectedPrinter())
        assertEquals(listOf(endpoint(88)), restoredPort.openedEndpoints)
    }

    @Test
    fun `network loss invalidates the confirmed selection without another socket`() = runTest {
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer = printer(network, port, RecordingDiscovery(network, listOf(endpoint(88))))
        val profile = BundledPrinterDrivers.elginI9Full2

        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(profile.id))
        val candidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))
        printer.confirmSearchedPrinter()
        network.available = false

        val result = printer.print(testReceiptPayload()) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.LocalWifiUnavailable, result.state)
        assertEquals(1, port.openedEndpoints.size)
    }

    private fun printer(
        network: FakeLocalWifiNetwork,
        port: RecordingLocalWifiPort,
        discovery: RecordingDiscovery,
        store: PrinterSelectionStore = InMemoryPrinterSelectionStore(),
        profileStore: PrinterProfileStore = InMemoryPrinterProfileStore(),
        driverProfiles: List<PrinterDriverProfile> = BundledPrinterDrivers.all,
        codeEmissionOverride: (String) -> ThermalCodeEmissionPreferences? = { null },
    ): LocalWifiThermalPrinter =
        LocalWifiThermalPrinter(
            port = port,
            discovery = discovery,
            networkProvider = LocalWifiNetworkProvider { network.takeIf { it.available } },
            driverProfiles = driverProfiles,
            selectionStore = store,
            profileStore = profileStore,
            codeEmissionOverride = codeEmissionOverride,
        )

    private fun endpoint(host: Int): LocalWifiPrinterEndpoint =
        LocalWifiPrinterEndpoint(byteArrayOf(192.toByte(), 168.toByte(), 31, host.toByte()), 9_100)
    private class RecordingDiscovery(
        private val network: FakeLocalWifiNetwork,
        private val endpoints: List<LocalWifiPrinterEndpoint>,
    ) : LocalWifiPrinterDiscovery {
        val rejected = mutableListOf<LocalWifiPrinterEndpoint>()
        val searchedProfiles = mutableListOf<PrinterDriverProfile>()

        override suspend fun findCandidates(
            profile: PrinterDriverProfile,
            attachment: PrinterNetworkAttachment,
        ): LocalWifiPrinterDiscoveryResult {
            searchedProfiles += profile
            return if (network.available) {
                LocalWifiPrinterDiscoveryResult.Candidates(endpoints, network)
            } else {
                LocalWifiPrinterDiscoveryResult.WifiUnavailable
            }
        }

        override fun reject(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
        ) {
            rejected += endpoint
        }
    }

    private class RecordingLocalWifiPort : LocalWifiThermalPort {
        val openedEndpoints = mutableListOf<LocalWifiPrinterEndpoint>()
        private val writes = mutableListOf<ByteArray>()

        override fun open(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
            profile: PrinterDriverProfile,
        ) {
            check(network.stillAvailable()) { "A porta local não pode usar Wi-Fi expirada." }
            openedEndpoints += endpoint
        }

        override fun close() = Unit

        override fun write(data: ByteArray) {
            writes += data.copyOf()
        }

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT

        fun allText(): String = writes.joinToString(separator = "") { String(it, StandardCharsets.US_ASCII) }

        fun allBytes(): List<Byte> = writes.flatMap(ByteArray::toList)

        fun containsRasterImage(): Boolean = writes.any(::containsWifiRasterCommand)
    }

    private class FakeLocalWifiNetwork : LocalWifiNetwork {
        override val subnet =
            LocalWifiSubnet(
                hostAddress = byteArrayOf(192.toByte(), 168.toByte(), 31, 42),
                prefixLength = 24,
                excludedGatewayAddresses = listOf(byteArrayOf(192.toByte(), 168.toByte(), 31, 1)),
            )
        override val selectionKey = LocalWifiNetworkSelectionKey(networkHandle = 52, subnet = subnet)
        var available = true

        override fun openSocket() = error("A descoberta fake não usa socket.")

        override fun stillAvailable(): Boolean = available
    }

    /**
     * A preferência de emissão chega ao cupom, e é relida **a cada impressão**.
     *
     * Lê-la uma vez na composição faria a pessoa trocar o ajuste, mandar imprimir e não ver
     * diferença nenhuma até reabrir o app — que é o laço inteiro de quem está escolhendo como o
     * código sai. É o mesmo motivo da altura de banda.
     *
     * A capacidade medida entra por um perfil injetado, e não pelo store: **o store ainda não
     * serializa os dois campos**, e é a frente da sonda que abre o schema para eles. O que este
     * teste prova é o caminho do modo até o emissor, que é o que existe hoje.
     */
    @Test
    fun `a preferência de emissão é relida a cada cupom`() = runTest {
        val perfil = BundledPrinterDrivers.elginI9Full2.copy(nativeQrHonored = true)
        var preferencia = ThermalCodeEmissionPreferences.DEFAULT
        val consultados = mutableListOf<String>()
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer =
            printer(
                network,
                port,
                RecordingDiscovery(network, listOf(endpoint(88))),
                driverProfiles = listOf(perfil),
                codeEmissionOverride = { id ->
                    consultados += id
                    preferencia
                },
            )
        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(perfil.id))
        val candidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))
        printer.confirmSearchedPrinter()

        val antesDoPadrao = port.allBytes().size
        assertSame(ThermalPrintResult.Printed, printer.print(QrOnlyPayload(QR_DE_EMISSAO)))
        val padrao = port.allBytes().drop(antesDoPadrao)
        assertTrue("o padrão continua rasterizando", contémRaster(padrao))
        assertFalse("o padrão não pede QR à firmware", contémQrNativo(padrao))

        // A pessoa troca o ajuste com o app aberto; o cupom seguinte já sai pelo outro caminho.
        preferencia = ThermalCodeEmissionPreferences(qrEmission = ThermalCodeEmission.NATIVE)
        val antesDoNativo = port.allBytes().size
        assertSame(ThermalPrintResult.Printed, printer.print(QrOnlyPayload(QR_DE_EMISSAO)))
        val nativo = port.allBytes().drop(antesDoNativo)
        assertTrue("o modo nativo pede o QR à firmware", contémQrNativo(nativo))
        assertFalse("o modo nativo não rasteriza", contémRaster(nativo))

        // Sempre pelo id do perfil adotado: a escolha é por impressora, nunca global.
        assertTrue(consultados.isNotEmpty())
        assertTrue(consultados.all { it == perfil.id })
    }

    /** A capacidade medida não basta: sem preferência do hospedeiro, o cupom sai como sempre saiu. */
    @Test
    fun `sem ponto de injeção o cupom continua rasterizando`() = runTest {
        val perfil = BundledPrinterDrivers.elginI9Full2.copy(nativeQrHonored = true)
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer =
            printer(
                network,
                port,
                RecordingDiscovery(network, listOf(endpoint(88))),
                driverProfiles = listOf(perfil),
            )
        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(perfil.id))
        val candidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))
        printer.confirmSearchedPrinter()

        val antes = port.allBytes().size
        assertSame(ThermalPrintResult.Printed, printer.print(QrOnlyPayload(QR_DE_EMISSAO)))
        val cupom = port.allBytes().drop(antes)

        assertTrue(contémRaster(cupom))
        assertFalse(contémQrNativo(cupom))
    }

    /**
     * A trava vale no caminho de produção, e não só no construtor do layout: preferência nativa
     * numa impressora sem a capacidade medida sai rasterizada.
     */
    @Test
    fun `preferência nativa sem capacidade medida sai rasterizada no papel`() = runTest {
        val perfil = BundledPrinterDrivers.elginI9Full2
        assertEquals(null, perfil.nativeQrHonored)
        val network = FakeLocalWifiNetwork()
        val port = RecordingLocalWifiPort()
        val printer =
            printer(
                network,
                port,
                RecordingDiscovery(network, listOf(endpoint(88))),
                driverProfiles = listOf(perfil),
                codeEmissionOverride = {
                    ThermalCodeEmissionPreferences(qrEmission = ThermalCodeEmission.NATIVE)
                },
            )
        assertSame(ThermalPrintResult.Printed, printer.searchLocalWifi(perfil.id))
        val candidate = (printer.state.value as ThermalPrinterState.LocalWifiCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedLocalWifiPrinter(candidate.id))
        printer.confirmSearchedPrinter()

        val antes = port.allBytes().size
        assertSame(ThermalPrintResult.Printed, printer.print(QrOnlyPayload(QR_DE_EMISSAO)))
        val cupom = port.allBytes().drop(antes)

        assertTrue(contémRaster(cupom))
        assertFalse(contémQrNativo(cupom))
    }

    /** Cupom mínimo que exercita o caminho `layout.qr`, o que escolhe o modo. */
    private class QrOnlyPayload(private val value: String) : ThermalReceiptPayload {
        override fun receiptBytes(layout: ReceiptLayout): ByteArray =
            receiptBytes(listOf(requireNotNull(layout.qr(value)) { "QR inválido." }, layout.finish()))

        override fun clear() = Unit
    }

    private fun contémRaster(bytes: List<Byte>): Boolean =
        bytes.windowed(4).any {
            it == listOf(0x1d.toByte(), 0x76.toByte(), 0x30.toByte(), 0x00.toByte())
        }

    /** `GS ( k` — o grupo de comandos de símbolo bidimensional. */
    private fun contémQrNativo(bytes: List<Byte>): Boolean =
        bytes.windowed(3).any { it == listOf(0x1d.toByte(), 0x28.toByte(), 0x6b.toByte()) }

    private fun localWifiMeasuredProfile(): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = "00000000-0000-4000-8000-000000000088",
            displayName = "Impressora Wi-Fi medida",
            transports = setOf(PrinterTransport.LOCAL_WIFI),
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            codePage = ThermalCodePage.CP850,
            cutProtocol = CutProtocol.GS_V_1,
            cutFeedLines = 5,
            measuredAtEpochMillis = 10,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )
}

/** Endereço sem assinatura: o que este cupom prova é o comando, não o conteúdo. */
private const val QR_DE_EMISSAO = "https://queven.app/printher"

private fun containsWifiRasterCommand(bytes: ByteArray): Boolean =
    (0..bytes.size - 4).any { index ->
        bytes[index] == 0x1d.toByte() &&
            bytes[index + 1] == 0x76.toByte() &&
            bytes[index + 2] == 0x30.toByte() &&
            bytes[index + 3] == 0x00.toByte()
    }
