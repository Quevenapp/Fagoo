import XCTest
@testable import ThermalPrinterKit

@MainActor
final class BluetoothThermalPrinterTests: XCTestCase {
    func testSearchPublishesCandidatesFound() {
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport)

        printer.search()
        XCTAssertEqual(printer.state, .searching)

        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])

        XCTAssertEqual(printer.state, .candidatesFound)
        XCTAssertEqual(printer.candidates.count, 1)
    }

    /// O rótulo mostrado à pessoa não pode conter identificador técnico do periférico.
    func testCandidateLabelStaysPositional() {
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport)
        printer.search()

        transport.publish([BluetoothPrinterCandidate(id: 7, label: "Impressora Bluetooth 1")])

        XCTAssertEqual(printer.candidates.first?.label, "Impressora Bluetooth 1")
        XCTAssertFalse(printer.candidates.first?.description.contains("label") ?? true)
    }

    func testTestReceiptAwaitsHumanConfirmation() async {
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport)
        printer.search()
        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])
        await waitUntil { !printer.candidates.isEmpty }

        let result = await printer.test(printer.candidates[0])

        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(printer.state, .awaitingConfirmation)
        let refused = await printer.print(testReceipt())
        XCTAssertEqual(delivery(of: refused), .notSent)
    }

    func testConfirmingMakesThePrinterReady() async {
        let printer = await readyPrinter(FakeTransport())

        XCTAssertEqual(printer.state, .ready)
        XCTAssertTrue(printer.candidates.isEmpty)
    }

    func testDiscardingDropsTheCandidate() async {
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport)
        printer.search()
        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])
        await waitUntil { !printer.candidates.isEmpty }
        let testResult = await printer.test(printer.candidates[0])
        XCTAssertEqual(testResult, .delivered)

        printer.discardTestReceipt()

        XCTAssertEqual(printer.state, .printerUnavailable)
        XCTAssertTrue(printer.candidates.isEmpty)
    }

    func testReceiptCarriesTheRasterQR() async {
        let transport = FakeTransport()
        let printer = await readyPrinter(transport)

        let result = await printer.print(testReceipt())
        XCTAssertEqual(result, .delivered)

        let receipt = transport.sent.last ?? Data()
        XCTAssertTrue(contains(receipt, [0x1d, 0x76, 0x30, 0x00]), "faltou o raster GS v 0")
        XCTAssertTrue(contains(receipt, Array("Ficha 1-4237".utf8)))
    }

    /**
     A propriedade mais importante do cupom: a assinatura protegida **nunca** sai como texto.

     Se o QR fosse emitido pelo comando nativo `GS ( k`, uma firmware que não o entende imprimiria
     o payload literal no papel — e quem lesse teria um token copiável na mão.
     */
    func testReceiptNeverPrintsTheSignatureAsText() async {
        let transport = FakeTransport()
        let printer = await readyPrinter(transport)

        let result = await printer.print(testReceipt())
        XCTAssertEqual(result, .delivered)

        let receipt = transport.sent.last ?? Data()
        XCTAssertFalse(contains(receipt, Array(protectedQRVector.utf8)), "a assinatura saiu como texto")
        XCTAssertFalse(contains(receipt, Array("QF1.".utf8)))
        XCTAssertFalse(contains(receipt, [0x1d, 0x28, 0x6b]), "o comando QR nativo é proibido")
    }

    /// A portátil não tem guilhotina: o cupom termina em avanço, nunca em comando de corte.
    func testReceiptNeverAsksForACut() async {
        let transport = FakeTransport()
        let printer = await readyPrinter(transport)

        let result = await printer.print(testReceipt())
        XCTAssertEqual(result, .delivered)

        let receipt = transport.sent.last ?? Data()
        XCTAssertFalse(contains(receipt, [0x1d, 0x56]), "cupom não deveria pedir corte")
        // Avanço em quebras de linha: a MP-4200 ignora `ESC d`.
        XCTAssertEqual(Array(receipt.suffix(4)), Array(repeating: 0x0a, count: 4))
    }

    /// O comprovante de teste não pode nomear a impressora de balcão nem pedir corte.
    func testTestReceiptSuitsThePortablePrinter() async {
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport)
        printer.search()
        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])
        await waitUntil { !printer.candidates.isEmpty }

        let result = await printer.test(printer.candidates[0])
        XCTAssertEqual(result, .delivered)

        let receipt = transport.sent.first ?? Data()
        XCTAssertFalse(contains(receipt, Array("QRFesta".utf8)))
        XCTAssertFalse(contains(receipt, Array("I9FULL".utf8)))
        XCTAssertFalse(contains(receipt, Array("BALCÃO".utf8)))
        // O comprovante passou a repetir o perfil adotado em vez de anunciar o transporte.
        XCTAssertTrue(contains(receipt, Array("COMPROVANTE DE TESTE".utf8)))
        // "SENSIVEIS", dobrado para ASCII — e não "SENSÍVEIS" com o Í em CP850.
        //
        // Esta linha já foi o contrário, e o papel desmentiu: esta impressora ignora `ESC t`. Foi
        // sondada com CP850, CP860, CP437, CP1252, CP866 e CP858 e não imprimiu nenhuma delas
        // legível — engoliu os bytes altos e comeu quebras de linha junto. O acento dobrado é o
        // único resultado que se lê no papel dela.
        XCTAssertTrue(contains(receipt, Array("Acentos: acao, opcao, Sao Joao".utf8)))
        XCTAssertFalse(contains(receipt, [0x1b, 0x74]), "`ESC t` não pode sair para quem o ignora")
        // A regra é sobre **texto**: byte alto volta como lixo ali. O raster é outro caminho e
        // funciona — o papel da MTP-II saiu com QR. Vale até onde o `GS v 0` começa.
        let texto = receipt.range(of: Data([0x1d, 0x76, 0x30])).map { receipt[..<$0.lowerBound] } ?? receipt[...]
        XCTAssertNil(texto.first(where: { $0 > 0x7e }), "byte alto volta como lixo no texto dela")
        XCTAssertFalse(contains(receipt, [0x1d, 0x56]), "comprovante não deveria pedir corte")
    }

    /// O QR precisa caber nos 384 pontos imprimíveis do papel de 58mm.
    func testQRFitsThePortablePaper() {
        XCTAssertLessThanOrEqual(
            ReceiptLayout.portable58mm.qrWidthDots,
            BluetoothPrinterProfile.printableDots
        )
        XCTAssertFalse(BluetoothPrinterProfile.hasCutter)
        XCTAssertEqual(BluetoothPrinterProfile.columns, 32)
        XCTAssertEqual(ReceiptLayout.portable58mm.qrWidthDots % 8, 0)
    }

    /// Falha depois de a impressora ter sido adotada precisa exigir um novo teste.
    func testAFailedReceiptDropsTheConfirmedSelection() async {
        let transport = FakeTransport()
        let printer = await readyPrinter(transport)
        transport.results = [
            .failed(message: "Falha sintética depois do primeiro byte.", delivery: .indeterminate),
        ]

        let result = await printer.print(testReceipt())

        XCTAssertEqual(delivery(of: result), .indeterminate)
        XCTAssertEqual(printer.state, .failed)
        let sendsAfterFailure = transport.sent.count
        let refused = await printer.print(testReceipt())
        XCTAssertEqual(delivery(of: refused), .notSent)
        XCTAssertEqual(transport.sent.count, sendsAfterFailure, "falha tardia não pode repetir o cupom")
    }

    func testTypedFailureDistinguishesBeforeAndAfterFirstByteWithoutRetry() async {
        for expectedDelivery in [ThermalPrintDelivery.notSent, .indeterminate] {
            let transport = FakeTransport()
            let printer = await readyPrinter(transport)
            transport.results = [
                .failed(message: "Falha sintética.", delivery: expectedDelivery),
            ]
            let sendsBefore = transport.sent.count

            let result = await printer.print(MarkerReceipt(value: 0x41))
            await Task.yield()

            XCTAssertEqual(delivery(of: result), expectedDelivery)
            XCTAssertEqual(transport.sent.count, sendsBefore + 1)
            XCTAssertEqual(printer.state, .failed)
        }
    }

    func testFiveAcceptedJobsReachTheTransportInFIFOOrderOneAtATime() async {
        let transport = FakeTransport()
        let printer = await readyPrinter(transport)
        transport.clearSent()
        transport.completesAutomatically = false

        for value in UInt8(1)...UInt8(5) {
            XCTAssertTrue(printer.printAccepted(MarkerReceipt(value: value)))
        }

        await waitUntil { transport.sent.count == 1 }
        XCTAssertEqual(transport.sent, [Data([1])])

        for completed in 1...5 {
            XCTAssertEqual(transport.pendingCount, 1, "só um trabalho pode ocupar o transporte")
            transport.completeNext(.delivered)
            await waitUntil { transport.sent.count == min(completed + 1, 5) }
        }

        await waitUntil { printer.state == .ready }
        XCTAssertEqual(transport.sent, (UInt8(1)...UInt8(5)).map { Data([$0]) })
        XCTAssertEqual(transport.pendingCount, 0)
        XCTAssertEqual(printer.state, .ready)
    }

    func testResetCancelsPendingJobAndLateCallbackCannotRestoreState() async {
        let transport = FakeTransport()
        let printer = await readyPrinter(transport)
        transport.clearSent()
        transport.completesAutomatically = false

        XCTAssertTrue(printer.printAccepted(MarkerReceipt(value: 1)))
        XCTAssertTrue(printer.printAccepted(MarkerReceipt(value: 2)))
        await waitUntil { transport.sent.count == 1 }

        printer.reset()
        transport.completeNext(.delivered)
        await Task.yield()
        await Task.yield()

        XCTAssertEqual(transport.sent, [Data([1])], "o job pendente não pode enviar depois do reset")
        XCTAssertEqual(printer.state, .idle)
        printer.confirmTestReceipt()
        XCTAssertEqual(printer.state, .idle)
    }

    func testPrintAndRetestAreRejectedDuringCandidateTestAndConfirmation() async {
        let transport = FakeTransport()
        let printer = await readyPrinter(transport)
        transport.clearSent()
        transport.completesAutomatically = false
        let candidateB = BluetoothPrinterCandidate(id: 2, label: "Impressora Bluetooth 2")

        XCTAssertTrue(printer.testAccepted(candidateB))
        await waitUntil { transport.sent.count == 1 }
        XCTAssertFalse(printer.printAccepted(MarkerReceipt(value: 7)))
        let refusedPrint = await printer.print(MarkerReceipt(value: 8))
        XCTAssertEqual(delivery(of: refusedPrint), .notSent)
        XCTAssertFalse(printer.printTestReceiptAgainAccepted())
        let refusedRetest = await printer.printTestReceiptAgain()
        XCTAssertEqual(delivery(of: refusedRetest), .notSent)
        XCTAssertEqual(printer.state, .testing)
        XCTAssertEqual(transport.sent.count, 1)

        transport.completeNext(.delivered)
        await waitUntil { printer.state == .awaitingConfirmation }
        XCTAssertFalse(printer.printAccepted(MarkerReceipt(value: 9)))
        XCTAssertFalse(printer.printTestReceiptAgainAccepted())
        XCTAssertEqual(printer.state, .awaitingConfirmation)
        XCTAssertEqual(transport.sent.count, 1)
    }

    func testCoreBluetoothMapsWriteBoundaryToTypedDelivery() {
        XCTAssertEqual(
            CoreBluetoothPrinterTransport.deliveryForFailure(writeStarted: false),
            .notSent
        )
        XCTAssertEqual(
            CoreBluetoothPrinterTransport.deliveryForFailure(writeStarted: true),
            .indeterminate
        )
    }

    func testTeardownWatchdogAcceptsOnlyCurrentDisconnectingGeneration() {
        XCTAssertTrue(CoreBluetoothPrinterTransport.teardownTimeoutMatches(
            scheduledGeneration: 7,
            currentGeneration: 7,
            isDisconnecting: true
        ))
        XCTAssertFalse(CoreBluetoothPrinterTransport.teardownTimeoutMatches(
            scheduledGeneration: 6,
            currentGeneration: 7,
            isDisconnecting: true
        ))
        XCTAssertFalse(CoreBluetoothPrinterTransport.teardownTimeoutMatches(
            scheduledGeneration: 7,
            currentGeneration: 7,
            isDisconnecting: false
        ))
    }

    func testRadioOffInterruptsTheSearch() {
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport)
        printer.search()

        transport.onStateChange?(.poweredOff)

        let expectation = expectation(description: "estado aplicado")
        Task { @MainActor in
            XCTAssertEqual(printer.state, .poweredOff)
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1)
    }

    /// A escolha preservada guarda só o perfil, e volta a valer sem novo teste quando a impressora
    /// é reencontrada sozinha.
    func testAdoptedPrinterIsRestoredWhenFoundAlone() async {
        let store = InMemoryPrinterSelectionStore()
        let first = await readyPrinter(FakeTransport(), store: store)
        XCTAssertEqual(
            store.read().of(.bluetooth),
            .bluetooth(profileId: BluetoothThermalPrinterController.profileId)
        )
        _ = first

        let transport = FakeTransport()
        let restored = BluetoothThermalPrinterController(transport: transport, store: store)
        restored.restoreAdoptedPrinter()
        transport.publish([BluetoothPrinterCandidate(id: 3, label: "Impressora Bluetooth 1")])
        await waitUntil { restored.state == .ready }

        XCTAssertEqual(restored.state, .ready)
        let result = await restored.print(testReceipt())
        XCTAssertEqual(result, .delivered)
    }

    /// Regressão do iPhone 7: depois de fechar o processo, o primeiro toque precisa aguardar o
    /// anúncio BLE e imprimir; não pode responder "toque de novo".
    func testFirstPrintAfterRestartWaitsForBluetoothRediscovery() async {
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.bluetooth(profileId: BluetoothThermalPrinterController.profileId)))
        let transport = FakeTransport()
        let restored = BluetoothThermalPrinterController(transport: transport, store: store)

        let job = Task { await restored.print(testReceipt()) }
        await Task.yield()
        transport.publish([BluetoothPrinterCandidate(id: 9, label: "T210")])

        let result = await job.value
        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(transport.sent.count, 1)
    }

    func testFirstRetestAfterRestartWaitsForBluetoothRediscovery() async {
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.bluetooth(profileId: BluetoothThermalPrinterController.profileId)))
        let transport = FakeTransport()
        let restored = BluetoothThermalPrinterController(transport: transport, store: store)

        let job = Task { await restored.printTestReceiptAgain() }
        await Task.yield()
        transport.publish([BluetoothPrinterCandidate(id: 10, label: "T210")])

        let result = await job.value
        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(transport.sent.count, 1)
    }

    /// O botão de reimpressão só existe com impressora adotada, e reenvia o comprovante.
    func testReprintRequiresAnAdoptedPrinter() async {
        let transport = FakeTransport()
        let idle = BluetoothThermalPrinterController(transport: transport, store: InMemoryPrinterSelectionStore())
        let refused = await idle.printTestReceiptAgain()
        XCTAssertEqual(delivery(of: refused), .notSent)

        let printer = await readyPrinter(FakeTransport())
        let result = await printer.printTestReceiptAgain()
        XCTAssertEqual(result, .delivered)
    }

    /**
     A bancada de 20/08, reproduzida: a T210 adotada, a MTP-II ligada ao lado, e a retomada.

     Com as duas anunciando, quem recebe o cupom é a que a pessoa adotou — e é a identidade que
     decide, não a ordem em que os anúncios chegaram. Aqui a MTP-II chega primeiro, justamente
     para que "a primeira da lista" não possa passar por acerto.
     */
    func testRetomadaEntreDuasImprimeNaImpressoraAdotada() async {
        let t210 = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let mtpII = UUID(uuidString: "0A2C55E1-9D33-4B18-8F41-71E2B6C0D4A9")!
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )))
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)

        printer.restoreAdoptedPrinter()
        transport.publish([
            BluetoothPrinterCandidate(id: 1, label: "MTP-II_BD7E", peripheralIdentifier: mtpII),
            BluetoothPrinterCandidate(id: 2, label: "T210_D0E9", peripheralIdentifier: t210),
        ])
        await waitUntil { printer.state == .ready }

        let result = await printer.print(testReceipt())

        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(transport.sentTo.map(\.peripheralIdentifier), [t210])
    }

    /**
     A MTP-II ligada sozinha não herda o lugar da T210 dormindo. Este é o defeito medido.

     `found.count == 1` bastava para adotar, e o cupom da foto compartilhada saiu numa impressora
     que nem instalada estava, com o layout da outra. Com identidade guardada, uma candidata que
     não bate não vira impressora adotada: nada é enviado, e quem pede papel ouve não.
     */
    func testRetomadaNaoAdotaAUnicaQueNaoBate() async {
        let t210 = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let mtpII = UUID(uuidString: "0A2C55E1-9D33-4B18-8F41-71E2B6C0D4A9")!
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )))
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)

        printer.restoreAdoptedPrinter()
        transport.publish([
            BluetoothPrinterCandidate(id: 1, label: "MTP-II_BD7E", peripheralIdentifier: mtpII),
        ])
        // A candidata publicada é o que prova que a decisão de retomada já foi tomada; sem esperar
        // por ela, "não ficou pronta" também seria verdade antes de o controlador ver a lista.
        await waitUntil { printer.candidates.count == 1 }

        XCTAssertNotEqual(printer.state, .ready)
        XCTAssertFalse(printer.printAccepted(testReceipt()))
        XCTAssertFalse(printer.printTestReceiptAgainAccepted())
        XCTAssertTrue(transport.sent.isEmpty, "nenhum byte pode sair numa impressora que não é a dela")
        // A escolha guardada continua de pé: quem não foi encontrada não é quem foi trocada.
        XCTAssertEqual(store.read().of(.bluetooth)?.peripheralIdentifier, t210)
    }

    /// A T210 acordando no meio da mesma busca é adotada sem novo comprovante — ela é a mesma
    /// unidade que uma pessoa já confirmou no papel.
    func testAImpressoraAdotadaQueAparecaDepoisAindaERetomada() async {
        let t210 = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let mtpII = UUID(uuidString: "0A2C55E1-9D33-4B18-8F41-71E2B6C0D4A9")!
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )))
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)

        printer.restoreAdoptedPrinter()
        transport.publish([
            BluetoothPrinterCandidate(id: 1, label: "MTP-II_BD7E", peripheralIdentifier: mtpII),
        ])
        await waitUntil { printer.candidates.count == 1 }
        XCTAssertNotEqual(printer.state, .ready)
        transport.publish([
            BluetoothPrinterCandidate(id: 1, label: "MTP-II_BD7E", peripheralIdentifier: mtpII),
            BluetoothPrinterCandidate(id: 2, label: "T210_D0E9", peripheralIdentifier: t210),
        ])
        await waitUntil { printer.state == .ready }

        let result = await printer.print(testReceipt())
        XCTAssertEqual(result, .delivered)
        XCTAssertEqual(transport.sentTo.map(\.peripheralIdentifier), [t210])
    }

    /**
     Entrada legada, sem identidade: o comportamento antigo continua inteiro.

     É a paridade com o Android, onde `address` nulo cai em `singleOrNull`. Quem adotou antes desta
     correção não perde a impressora nem é obrigado a readotar — candidata única volta a valer, e
     duas continuam exigindo escolha.
     */
    func testRetomadaLegadaSemIdentidadeMantemACandidataUnica() async {
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.bluetooth(profileId: BluetoothThermalPrinterController.profileId)))
        XCTAssertNil(store.read().of(.bluetooth)?.peripheralIdentifier)

        let duas = FakeTransport()
        let comDuas = BluetoothThermalPrinterController(transport: duas, store: store)
        comDuas.restoreAdoptedPrinter()
        duas.publish([
            BluetoothPrinterCandidate(id: 1, label: "MTP-II_BD7E"),
            BluetoothPrinterCandidate(id: 2, label: "T210_D0E9"),
        ])
        await waitUntil { comDuas.candidates.count == 2 }
        XCTAssertEqual(comDuas.state, .candidatesFound)
        XCTAssertFalse(comDuas.printAccepted(testReceipt()))
        XCTAssertTrue(duas.sent.isEmpty)

        let uma = FakeTransport()
        let comUma = BluetoothThermalPrinterController(transport: uma, store: store)
        comUma.restoreAdoptedPrinter()
        uma.publish([BluetoothPrinterCandidate(id: 1, label: "T210_D0E9")])
        await waitUntil { comUma.state == .ready }

        XCTAssertEqual(comUma.state, .ready)
        let entregue = await comUma.print(testReceipt())
        XCTAssertEqual(entregue, .delivered)
    }

    /**
     A confirmação humana do papel é o que grava a identidade, e readotar **a mesma unidade**
     substitui em vez de empilhar duplicata.

     Este teste já afirmou também que a segunda adoção substituía a primeira, porque com uma
     seleção por transporte as duas operações eram a mesma. Não são: readotar é a impressora de
     sempre; adotar a segunda é outra impressora, e está em
     ``testAdotarASegundaPortatilMantemAPrimeiraInstalada``.
     */
    func testConfirmacaoGravaAIdentidadeEReadotarAMesmaNaoDuplica() async {
        let primeira = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let store = InMemoryPrinterSelectionStore()
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)

        printer.search()
        transport.publish([
            BluetoothPrinterCandidate(id: 1, label: "T210_D0E9", peripheralIdentifier: primeira),
        ])
        await waitUntil { !printer.candidates.isEmpty }
        let primeiroTeste = await printer.test(printer.candidates[0])
        XCTAssertEqual(primeiroTeste, .delivered)
        // Antes da confirmação humana nada foi guardado — nem perfil, nem identidade.
        XCTAssertNil(store.read().of(.bluetooth))
        printer.confirmTestReceipt()

        XCTAssertEqual(
            store.read().of(.bluetooth),
            .bluetooth(
                profileId: BluetoothThermalPrinterController.profileId,
                peripheralIdentifier: primeira
            )
        )

        // A mesma unidade, confirmada de novo: mesma chave de instalação, nenhuma duplicata.
        printer.search()
        transport.publish([
            BluetoothPrinterCandidate(id: 4, label: "T210_D0E9", peripheralIdentifier: primeira),
        ])
        await waitUntil { !printer.candidates.isEmpty }
        let readocao = await printer.test(printer.candidates[0])
        XCTAssertEqual(readocao, .delivered)
        printer.confirmTestReceipt()

        XCTAssertEqual(store.read().selections.count, 1)
        XCTAssertEqual(store.read().of(.bluetooth)?.peripheralIdentifier, primeira)
    }

    /**
     Adotar a segunda portátil mantém a primeira instalada. É o `f3b13db` do Android neste lado.

     A régua antiga era "uma impressora por transporte", e ela apagava em silêncio uma instalação
     que uma pessoa tinha confirmado no papel — sem aviso e sem confirmação. Duas portáteis no mesmo
     balcão são duas instalações legítimas, ainda que compartilhem o perfil.
     */
    func testAdotarASegundaPortatilMantemAPrimeiraInstalada() async {
        let t210 = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let mtpII = UUID(uuidString: "0A2C55E1-9D33-4B18-8F41-71E2B6C0D4A9")!
        let store = InMemoryPrinterSelectionStore()
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)

        printer.search()
        transport.publish([
            BluetoothPrinterCandidate(id: 1, label: "T210_D0E9", peripheralIdentifier: t210),
        ])
        await waitUntil { !printer.candidates.isEmpty }
        _ = await printer.test(printer.candidates[0])
        printer.confirmTestReceipt()

        printer.search()
        transport.publish([
            BluetoothPrinterCandidate(id: 2, label: "MTP-II_BD7E", peripheralIdentifier: mtpII),
        ])
        await waitUntil { !printer.candidates.isEmpty }
        _ = await printer.test(printer.candidates[0])
        printer.confirmTestReceipt()

        let guardadas = store.read()
        XCTAssertEqual(guardadas.selections.count, 2, "a primeira não pode sumir sem ninguém mandar")
        XCTAssertEqual(
            Set(guardadas.selections.compactMap(\.peripheralIdentifier)),
            [t210, mtpII]
        )
        // A recém-confirmada assume: foi a última escolha consciente.
        XCTAssertEqual(guardadas.activeSelection?.peripheralIdentifier, mtpII)
        // Mesmo perfil, duas unidades: a chave que as separa é a instalação, não o perfil.
        XCTAssertEqual(Set(guardadas.selections.map(\.profileId)).count, 1)
        XCTAssertEqual(Set(guardadas.selections.map(\.installationId)).count, 2)
    }

    /**
     Procurar não desinstala — nem quando a varredura volta vazia.

     É o `972abbd` do Android. Quem toca em "procurar" para instalar a segunda portátil, ou só para
     conferir se a dela aparece, não pediu para desinstalar a que estava. Descartar continua sendo
     ``BluetoothThermalPrinterController/reset()``, e ele tira **uma** impressora: a em uso.
     */
    func testProcurarNaoDesinstalaAPortatilGuardada() async {
        let t210 = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let mtpII = UUID(uuidString: "0A2C55E1-9D33-4B18-8F41-71E2B6C0D4A9")!
        let store = InMemoryPrinterSelectionStore()
        let primeira = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )
        let segunda = PersistedPrinterSelection.bluetooth(
            profileId: "550e8400-e29b-41d4-a716-446655440000",
            peripheralIdentifier: mtpII
        )
        store.save(store.read().with(primeira).with(segunda))
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)

        printer.search()
        transport.publish([])

        XCTAssertEqual(store.read().selections.count, 2)
        XCTAssertEqual(store.read().activeInstallationId, segunda.installationId)

        // Descartar é outro botão, e ele tira só a que está em uso.
        printer.reset()

        XCTAssertEqual(store.read().selections, [primeira])
    }

    /// Com mais de uma candidata a retomada não pode adivinhar: a pessoa escolhe.
    func testRestoreAsksWhenSeveralPrintersAppear() {
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.bluetooth(profileId: BluetoothThermalPrinterController.profileId)))
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)

        printer.restoreAdoptedPrinter()
        transport.publish([
            BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1"),
            BluetoothPrinterCandidate(id: 2, label: "Impressora Bluetooth 2"),
        ])

        XCTAssertEqual(printer.state, .candidatesFound)
        XCTAssertFalse(printer.printAccepted(testReceipt()))
    }

    /// Nada é preservado antes da confirmação humana do papel.
    func testNothingIsPersistedBeforeConfirmation() async {
        let store = InMemoryPrinterSelectionStore()
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)
        printer.search()
        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])
        await waitUntil { !printer.candidates.isEmpty }

        let result = await printer.test(printer.candidates[0])
        XCTAssertEqual(result, .delivered)

        XCTAssertNil(store.read().activeSelection)
    }

    /// Duas impressoras convivem, e só a ativa recebe os cupons.
    func testPrintersFromBothTransportsCoexist() {
        let store = InMemoryPrinterSelectionStore()
        store.save(
            store.read()
                .with(.localWifi(profileId: LocalWifiThermalPrinterController.profileId))
                .with(.bluetooth(profileId: BluetoothThermalPrinterController.profileId))
        )

        let selections = store.read()

        XCTAssertEqual(selections.selections.count, 2)
        XCTAssertEqual(selections.active, PrinterTransport.bluetooth)
        XCTAssertEqual(selections.activated(at: .localWifi).active, PrinterTransport.localWifi)
    }

    /// Descartar um transporte não pode levar o outro junto.
    func testRemovingOneTransportKeepsTheOther() {
        let store = InMemoryPrinterSelectionStore()
        store.save(
            store.read()
                .with(.localWifi(profileId: LocalWifiThermalPrinterController.profileId))
                .with(.bluetooth(profileId: BluetoothThermalPrinterController.profileId))
        )

        let remaining = store.read().without(.bluetooth)

        XCTAssertEqual(remaining.selections.count, 1)
        XCTAssertEqual(remaining.active, PrinterTransport.localWifi)
    }

    func testCoordinatorDisplaysMeasuredProfileName() throws {
        let selectionStore = InMemoryPrinterSelectionStore()
        let profileStore = PrinterProfileStore(dataStore: CoordinatorMemoryProfileDataStore())
        let profile = try MeasuredProfile(
            id: UUID(),
            displayName: "Portátil homologada",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 40,
            printableDots: 320,
            codePage: .cp860,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )
        try profileStore.save(profile)
        selectionStore.save(
            selectionStore.read().with(.bluetooth(profileId: profile.id))
        )

        let coordinator = ThermalPrintingCoordinator(
            store: selectionStore,
            bluetooth: BluetoothThermalPrinterController(
                transport: FakeTransport(),
                store: selectionStore,
                profileStore: profileStore
            ),
            profileStore: profileStore
        )

        XCTAssertEqual(coordinator.adoptedPrinters.first?.displayName, "Portátil homologada")
        XCTAssertNil(coordinator.adoptedPrinters.first?.warning)
    }

    /**
     A adotada publica a largura do perfil, e é a mesma que vai sair no papel.

     Sem este campo o hospedeiro desfazia o mapeamento por `displayName` para descobrir em quantos
     pontos rasterizar — e dois perfis com o mesmo nome, que a bancada produz sozinha ao medir a
     mesma impressora duas vezes, devolvem duas larguras e nenhuma decisão. 320 aqui é uma medição
     que não é nem 384 nem 576: é justamente a largura que um par fixo não teria como adivinhar.
     */
    func testAdotadaPublicaALarguraEOPerfilResolvido() throws {
        let selectionStore = InMemoryPrinterSelectionStore()
        let profileStore = PrinterProfileStore(dataStore: CoordinatorMemoryProfileDataStore())
        let profile = try MeasuredProfile(
            id: UUID(),
            displayName: "Portátil homologada",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 40,
            printableDots: 320,
            codePage: .cp860,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )
        try profileStore.save(profile)
        selectionStore.save(selectionStore.read().with(.bluetooth(profileId: profile.id)))

        let coordinator = ThermalPrintingCoordinator(
            store: selectionStore,
            bluetooth: BluetoothThermalPrinterController(
                transport: FakeTransport(),
                store: selectionStore,
                profileStore: profileStore
            ),
            profileStore: profileStore
        )
        let adotada = try XCTUnwrap(coordinator.adoptedPrinters.first)

        XCTAssertEqual(adotada.printableDots, 320)
        XCTAssertEqual(adotada.profileId, profile.id)
        // A mesma largura que o cupom vai usar: os dois saem do mesmo resolvedor.
        XCTAssertEqual(ReceiptLayout(profile: PrinterProfile(profile)).printableDots, 320)
        // Perfil não é identidade, e o que é publicado aqui não pode virar endereço nem aparelho.
        XCTAssertTrue(isPublishedPrinterProfileID(profile.id) || UUID(uuidString: profile.id) != nil)
    }

    /// Sem store de perfis não há o que resolver: nome genérico, e largura ausente em vez de um
    /// palpite. Palpite de largura sai como logotipo de meia página no papel.
    func testSemStoreDePerfisALarguraNaoEAdivinhada() {
        let selectionStore = InMemoryPrinterSelectionStore(
            selection: .bluetooth(profileId: BluetoothThermalPrinterController.profileId)
        )

        let coordinator = ThermalPrintingCoordinator(
            store: selectionStore,
            bluetooth: BluetoothThermalPrinterController(
                transport: FakeTransport(),
                store: selectionStore
            )
        )

        XCTAssertNil(coordinator.adoptedPrinters.first?.printableDots)
        XCTAssertNil(coordinator.adoptedPrinters.first?.profileId)
        XCTAssertEqual(coordinator.adoptedPrinters.first?.displayName, "Portátil 58mm")
    }

    func testCoordinatorWarnsAboutUnknownProfileWithoutPersistingTemporary() {
        let selectionStore = InMemoryPrinterSelectionStore(
            selection: .bluetooth(profileId: "perfil.desconhecido")
        )
        let profileStore = PrinterProfileStore(dataStore: CoordinatorMemoryProfileDataStore())

        let coordinator = ThermalPrintingCoordinator(
            store: selectionStore,
            bluetooth: BluetoothThermalPrinterController(
                transport: FakeTransport(),
                store: selectionStore,
                profileStore: profileStore
            ),
            profileStore: profileStore
        )

        XCTAssertEqual(coordinator.adoptedPrinters.first?.displayName, "Impressora temporária")
        XCTAssertNotNil(coordinator.adoptedPrinters.first?.warning)
        XCTAssertEqual(profileStore.profiles(), [])
        // A largura publicada é a conservadora que o papel vai receber, não uma ausência: quem
        // rasteriza precisa de um número, e o `warning` já diz que ele não foi medido.
        XCTAssertEqual(coordinator.adoptedPrinters.first?.printableDots, 384)
    }

    /// O formato neutro não reconhece campos de endpoint. A leitura histórica pertence ao app
    /// hospedeiro, que os descarta antes de construir esta seleção.
    func testPersistedSelectionRejectsAddressAndNeverDescribesEndpoint() throws {
        let endpoint = try XCTUnwrap(LocalWifiPrinterEndpoint(ipAddress: "192.168.31.88", port: 9_100))
        let legacy = Data(
            #"{"transport":"localWifi","address":"192.168.31.88","port":9100,"profileId":"generic.counter.escpos"}"#.utf8
        )
        let selection = PersistedPrinterSelection.localWifi(
            profileId: LocalWifiThermalPrinterController.profileId
        )
        let encoded = try JSONEncoder().encode(selection)

        XCTAssertEqual("\(endpoint)", "LocalWifiPrinterEndpoint([REDACTED])")
        XCTAssertThrowsError(try JSONDecoder().decode(PersistedPrinterSelection.self, from: legacy))
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("192.168.31.88"))
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("address"))
        XCTAssertEqual(selection.redactedDescription, "localWifi(\(LocalWifiThermalPrinterController.profileId))")
        XCTAssertFalse("\(testReceipt())".contains(protectedQRVector))
        XCTAssertTrue("\(testReceipt())".contains("[REDACTED]"))
    }

    func testSelectionProfileIDRejectsTechnicalIdentifiersButAcceptsCanonicalLocalUUID() throws {
        for technical in [
            "192.168.1.40",
            "aa:bb:cc:dd:ee:ff",
            "VID:1234:PID:5678",
            "printer.192.168.1.40",
            "printer.aa-bb-cc-dd-ee-ff",
            "printer.vid-1234-pid-5678",
            "printer.550e8400-e29b-41d4-a716-446655440000",
        ] {
            let selection = PersistedPrinterSelection.localWifi(profileId: technical)
            XCTAssertThrowsError(try JSONEncoder().encode(selection), technical)
            XCTAssertFalse(selection.description.contains(technical))
            XCTAssertTrue(
                PersistedPrinterSelections(selections: [selection], active: .localWifi)
                    .selections.isEmpty
            )
            let encoded = Data(
                #"{"transport":"localWifi","profileId":"\#(technical)"}"#.utf8
            )
            XCTAssertThrowsError(
                try JSONDecoder().decode(PersistedPrinterSelection.self, from: encoded),
                technical
            )
        }

        let localProfileID = "550e8400-e29b-41d4-a716-446655440000"
        let measured = PersistedPrinterSelection.bluetooth(profileId: localProfileID)
        let published = PersistedPrinterSelection.localWifi(profileId: "3nstar.pos58.escpos")
        XCTAssertEqual(
            try JSONDecoder().decode(
                PersistedPrinterSelection.self,
                from: JSONEncoder().encode(published)
            ),
            published
        )
        XCTAssertEqual(
            try JSONDecoder().decode(
                PersistedPrinterSelection.self,
                from: JSONEncoder().encode(measured)
            ),
            measured
        )
        XCTAssertEqual(
            PersistedPrinterSelections(selections: [measured], active: .bluetooth).activeSelection,
            measured
        )
    }

    /// O namespace temporário não pode atravessar nenhuma fronteira de persistência, mesmo quando
    /// o valor tem a forma de um slug válido e não carrega endpoint ou identificador técnico.
    func testTemporarySelectionCannotCrossPersistenceBoundary() {
        let profileID = "temporary.localWifi"
        let selection = PersistedPrinterSelection.localWifi(profileId: profileID)

        XCTAssertFalse(selection.hasValidProfileID)
        XCTAssertThrowsError(try JSONEncoder().encode(selection))
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                PersistedPrinterSelection.self,
                from: Data(#"{"transport":"localWifi","profileId":"temporary.localWifi"}"#.utf8)
            )
        )

        let selections = PersistedPrinterSelections(selections: [selection], active: .localWifi)
        let store = InMemoryPrinterSelectionStore()
        store.save(selections)

        XCTAssertTrue(selections.selections.isEmpty)
        XCTAssertNil(store.read().of(.localWifi))
    }

    /**
     O registro gravado antes de a identidade existir continua abrindo, e continua saindo igual.

     É o preço que a correção não pode cobrar: se o payload antigo deixasse de decodificar, toda
     impressora já adotada sumiria na atualização do app — não como erro, como lista vazia — e a
     pessoa teria que procurar e confirmar tudo de novo.
     */
    func testSelecaoBluetoothAntigaDecodificaSemIdentidade() throws {
        let antiga = Data(#"{"transport":"bluetooth","profileId":"generic.portable58.escpos"}"#.utf8)

        let decodificada = try JSONDecoder().decode(PersistedPrinterSelection.self, from: antiga)

        XCTAssertEqual(decodificada, .bluetooth(profileId: "generic.portable58.escpos"))
        XCTAssertNil(decodificada.peripheralIdentifier)
        let reencodada = String(decoding: try JSONEncoder().encode(decodificada), as: UTF8.self)
        XCTAssertFalse(reencodada.contains("peripheralIdentifier"), "sem identidade, o payload é o antigo")
    }

    /// A identidade atravessa o disco inteira, e não atravessa nenhum texto observável.
    func testIdentidadeDoPerifericoSobreviveAoRoundTripESoAoStore() throws {
        let identidade = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let selecao = PersistedPrinterSelection.bluetooth(
            profileId: "generic.portable58.escpos",
            peripheralIdentifier: identidade
        )

        let codificada = try JSONEncoder().encode(selecao)
        let voltou = try JSONDecoder().decode(PersistedPrinterSelection.self, from: codificada)

        XCTAssertEqual(voltou, selecao)
        XCTAssertEqual(voltou.peripheralIdentifier, identidade)
        XCTAssertNotEqual(
            voltou,
            .bluetooth(profileId: "generic.portable58.escpos"),
            "duas unidades do mesmo perfil não podem ser a mesma seleção"
        )
        // O UUID vive no registro cifrado do chaveiro. Fora dele, nem descrição nem depuração.
        XCTAssertEqual(selecao.description, "bluetooth(generic.portable58.escpos)")
        XCTAssertEqual(selecao.debugDescription, "bluetooth(generic.portable58.escpos)")
        XCTAssertFalse(selecao.description.contains(identidade.uuidString))
        XCTAssertFalse("\(PersistedPrinterSelections().with(selecao))".contains(identidade.uuidString))
    }

    /**
     O schema continua fechado: só o nome canônico da identidade entra.

     A porta que a identidade abriu tem exatamente a largura de um campo. Um vizinho de nome
     parecido é campo desconhecido como qualquer outro, e o Wi-Fi não recebe identidade nenhuma —
     seria endereço entrando pela lateral, que é o que o formato neutro existe para impedir.
     */
    func testSchemaDeSelecaoAceitaSoAIdentidadeCanonicaEApenasNoBluetooth() throws {
        for vizinho in ["peripheralUUID", "peripheralAddress", "identifier", "uuid"] {
            let encoded = Data(
                #"{"transport":"bluetooth","profileId":"generic.portable58.escpos","\#(vizinho)":"6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01"}"#.utf8
            )
            XCTAssertThrowsError(
                try JSONDecoder().decode(PersistedPrinterSelection.self, from: encoded),
                vizinho
            )
        }

        let noWifi = Data(
            #"{"transport":"localWifi","profileId":"elgin.i9full2.escpos","peripheralIdentifier":"6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01"}"#.utf8
        )
        XCTAssertThrowsError(try JSONDecoder().decode(PersistedPrinterSelection.self, from: noWifi))
        XCTAssertNil(PersistedPrinterSelection.localWifi(profileId: "elgin.i9full2.escpos").peripheralIdentifier)

        let canonica = Data(
            #"{"transport":"bluetooth","profileId":"generic.portable58.escpos","peripheralIdentifier":"6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01"}"#.utf8
        )
        XCTAssertEqual(
            try JSONDecoder().decode(PersistedPrinterSelection.self, from: canonica).peripheralIdentifier,
            UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")
        )
    }

    /// O campo desconhecido continua barrado — a identidade viaja sob o nome canônico, provado
    /// em ``testSchemaDeSelecaoAceitaSoAIdentidadeCanonicaEApenasNoBluetooth``.
    func testSelectionDecodeRejectsUnknownTechnicalUUIDField() {
        let encoded = Data(
            #"{"transport":"bluetooth","profileId":"generic.portable58.escpos","peripheralUUID":"550e8400-e29b-41d4-a716-446655440000"}"#.utf8
        )

        XCTAssertThrowsError(
            try JSONDecoder().decode(PersistedPrinterSelection.self, from: encoded)
        )
    }

    /**
     Toda retomada termina, mesmo quando a impressora está desligada.

     Medido no iPhone 7 em 21/08: quatro impressoras instaladas e nenhuma respondendo, e a busca
     que o controlador abre sozinho ao subir ficava em `.searching` para sempre. `.searching` é
     ocupação, e ocupação eterna foi o que deixou a tela de impressoras inteira cinza — sem
     mensagem e sem saída. Estado eterno não é espera: é defeito. A saída é a recusa honesta.

     A varredura que a pessoa pede continua aberta, e o prazo não corta quem responde: é o padrão
     de quinze segundos que as demais retomadas desta suíte atravessam sem serem interrompidas.
     */
    func testARetomadaDesisteEmVezDeProcurarParaSempre() async {
        let t210 = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )))
        let transport = FakeTransport()

        let printer = BluetoothThermalPrinterController(
            transport: transport,
            store: store,
            reconnectDeadline: {}
        )

        await waitUntil { printer.state == .printerUnavailable }
        XCTAssertFalse(printer.state.isBusy, "ocupação eterna é o defeito")
        // Desistir de reencontrar não desinstala: a escolha continua guardada, e a pessoa decide.
        XCTAssertEqual(store.read().of(.bluetooth)?.peripheralIdentifier, t210)
        // E a tela sabe em qual card dizer que ninguém respondeu.
        XCTAssertEqual(
            printer.reconnectingInstallationId,
            store.read().of(.bluetooth)?.installationId
        )
        XCTAssertTrue(transport.sent.isEmpty)
    }

    /**
     A preferência de emissão chega ao cupom, e é relida **na hora do cupom**.

     Aplicada no *setter* do layout adotado, ela só valeria depois de readotar a impressora: a
     pessoa trocaria o ajuste em Ajustes, mandaria imprimir e não veria diferença nenhuma. Espelha o
     `a preferência de emissão é relida a cada cupom` do Android.
     */
    func testAPreferenciaDeEmissaoEhRelidaNaHoraDoCupom() async throws {
        let escolha = EscolhaDeEmissao()
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(
            transport: transport,
            store: InMemoryPrinterSelectionStore(),
            codeEmissionOverride: { id in escolha.leia(id) }
        )
        printer.search()
        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])
        await waitUntil { !printer.candidates.isEmpty }
        _ = await printer.test(printer.candidates[0])
        printer.confirmTestReceipt()
        let perfil = try perfilDeEmissao(nativeQrHonored: true)
        XCTAssertTrue(printer.confirmHomologatedProfile(perfil))

        let entrega = await printer.print(QrOnlyReceipt(qrDeEmissao))
        XCTAssertEqual(entrega, .delivered)
        let padrao = transport.sent.last ?? Data()
        XCTAssertTrue(contains(padrao, [0x1d, 0x76, 0x30, 0x00]), "o padrão continua rasterizando")
        XCTAssertFalse(contains(padrao, [0x1d, 0x28, 0x6b]), "o padrão não pede QR à firmware")

        // A pessoa troca o ajuste com o app aberto; o cupom seguinte já sai pelo outro caminho.
        escolha.escreva(ThermalCodeEmissionPreferences(qrEmission: .native))
        let entregaNativa = await printer.print(QrOnlyReceipt(qrDeEmissao))
        XCTAssertEqual(entregaNativa, .delivered)
        let nativo = transport.sent.last ?? Data()
        XCTAssertTrue(contains(nativo, [0x1d, 0x28, 0x6b]), "o modo nativo pede o QR à firmware")
        XCTAssertFalse(contains(nativo, [0x1d, 0x76, 0x30, 0x00]), "o modo nativo não rasteriza")

        // Sempre pelo id do perfil adotado: a escolha é por impressora, nunca global.
        XCTAssertEqual(Set(escolha.consultados), [perfil.id])
    }

    /**
     A trava vale no caminho de produção, e não só no construtor do layout.

     Aqui está a razão de o controlador guardar o perfil adotado, e não só o identificador dele: a
     autorização vem da capacidade medida, e ela não sobrevive dentro do layout — `rasterized` é ao
     mesmo tempo "o padrão" e "o que a medição permitiu".
     */
    func testPreferenciaNativaSemCapacidadeMedidaSaiRasterizadaNoPapel() async throws {
        let escolha = EscolhaDeEmissao()
        escolha.escreva(ThermalCodeEmissionPreferences(qrEmission: .native, barcodeEmission: .native))
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(
            transport: transport,
            store: InMemoryPrinterSelectionStore(),
            codeEmissionOverride: { id in escolha.leia(id) }
        )
        printer.search()
        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])
        await waitUntil { !printer.candidates.isEmpty }
        _ = await printer.test(printer.candidates[0])
        printer.confirmTestReceipt()
        let perfil = try perfilDeEmissao(nativeQrHonored: nil)
        XCTAssertNil(perfil.nativeQrHonored)
        XCTAssertTrue(printer.confirmHomologatedProfile(perfil))

        let entrega = await printer.print(QrOnlyReceipt(qrDeEmissao))
        XCTAssertEqual(entrega, .delivered)

        let cupom = transport.sent.last ?? Data()
        XCTAssertTrue(contains(cupom, [0x1d, 0x76, 0x30, 0x00]))
        XCTAssertFalse(contains(cupom, [0x1d, 0x28, 0x6b]))
    }

    /// Sem impressora homologada não há perfil adotado, e sem perfil não há preferência a
    /// consultar: o comprovante do M1 continua saindo pelo layout estático de sempre.
    func testSemPerfilAdotadoAPreferenciaNaoEhConsultada() async {
        let escolha = EscolhaDeEmissao()
        escolha.escreva(ThermalCodeEmissionPreferences(qrEmission: .native, barcodeEmission: .native))
        let transport = FakeTransport()
        let printer = BluetoothThermalPrinterController(
            transport: transport,
            store: InMemoryPrinterSelectionStore(),
            codeEmissionOverride: { id in escolha.leia(id) }
        )
        printer.search()
        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])
        await waitUntil { !printer.candidates.isEmpty }
        _ = await printer.test(printer.candidates[0])
        printer.confirmTestReceipt()

        let entrega = await printer.print(QrOnlyReceipt(qrDeEmissao))
        XCTAssertEqual(entrega, .delivered)

        let cupom = transport.sent.last ?? Data()
        XCTAssertTrue(contains(cupom, [0x1d, 0x76, 0x30, 0x00]))
        XCTAssertFalse(contains(cupom, [0x1d, 0x28, 0x6b]))
        XCTAssertTrue(escolha.consultados.isEmpty)
    }

    private func perfilDeEmissao(nativeQrHonored: Bool?) throws -> PrinterProfile {
        let capabilities = try PrinterCapabilities(
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: nil,
            nativeQrHonored: nativeQrHonored
        )
        return PrinterProfile(
            id: "00000000-0000-4000-8000-0000000000e1",
            displayName: "Portátil de teste",
            source: .measured,
            measuredAt: Date(timeIntervalSince1970: 1),
            capabilities: capabilities
        )
    }

    private func readyPrinter(
        _ transport: FakeTransport,
        store: any PrinterSelectionStoring = InMemoryPrinterSelectionStore()
    ) async -> BluetoothThermalPrinterController {
        let printer = BluetoothThermalPrinterController(transport: transport, store: store)
        printer.search()
        transport.publish([BluetoothPrinterCandidate(id: 1, label: "Impressora Bluetooth 1")])
        await waitUntil { !printer.candidates.isEmpty }
        let result = await printer.test(printer.candidates[0])
        XCTAssertEqual(result, .delivered)
        printer.confirmTestReceipt()
        return printer
    }

    private func delivery(of result: ThermalPrintResult) -> ThermalPrintDelivery? {
        guard case let .failed(_, delivery) = result else { return nil }
        return delivery
    }

    private func waitUntil(
        _ condition: @escaping () -> Bool,
        attempts: Int = 100
    ) async {
        for _ in 0..<attempts {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("A operação assíncrona não avançou dentro do limite do teste.")
    }

    private final class FakeTransport: BluetoothPrinterTransporting {
        var onStateChange: ((BluetoothPrinterRadioState) -> Void)?
        var onCandidates: (([BluetoothPrinterCandidate]) -> Void)?

        var results: [ThermalPrintResult] = []
        var completesAutomatically = true
        private(set) var sent: [Data] = []
        /// Em qual impressora cada cupom entrou. É a única forma de a suíte responder a pergunta
        /// que o papel respondeu errado em 20/08: saiu na dela, ou na que estava ligada ao lado?
        private(set) var sentTo: [BluetoothPrinterCandidate] = []
        private var pending: [(ThermalPrintResult) -> Void] = []

        var pendingCount: Int { pending.count }

        func startScan() {}
        func stopScan() {}
        func disconnect() {}

        func publish(_ candidates: [BluetoothPrinterCandidate]) {
            onCandidates?(candidates)
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }

        func send(
            _ payload: Data,
            to candidate: BluetoothPrinterCandidate,
            completion: @escaping (ThermalPrintResult) -> Void
        ) {
            sent.append(payload)
            sentTo.append(candidate)
            if completesAutomatically {
                completion(nextResult())
            } else {
                pending.append(completion)
            }
        }

        func clearSent() {
            sent = []
            sentTo = []
        }

        func completeNext(_ result: ThermalPrintResult) {
            guard !pending.isEmpty else { return }
            pending.removeFirst()(result)
        }

        private func nextResult() -> ThermalPrintResult {
            results.isEmpty ? .delivered : results.removeFirst()
        }
    }
}

private final class MarkerReceipt: ThermalReceiptPayload {
    private var value: UInt8?

    init(value: UInt8) { self.value = value }

    func receiptBytes(layout: ReceiptLayout) -> Data? {
        value.map { Data([$0]) }
    }

    func clear() { value = nil }
}

private final class CoordinatorMemoryProfileDataStore: PrinterProfileDataStoring {
    private var data: Data?

    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}

/// Endereço sem assinatura: o que estes cupons provam é o comando, não o conteúdo.
private let qrDeEmissao = "https://queven.app/printher"

/// Cupom mínimo que exercita o caminho `layout.qr`, o que escolhe o modo.
private final class QrOnlyReceipt: ThermalReceiptPayload {
    private var value: String?

    init(_ value: String) { self.value = value }

    func receiptBytes(layout: ReceiptLayout) -> Data? { value.flatMap { layout.qr(payload: $0) } }

    func clear() { value = nil }
}

/// O ajuste do hospedeiro, que muda enquanto o app roda — e registra por qual impressora foi
/// perguntado. `@unchecked Sendable` porque tudo aqui acontece na mesma thread do teste.
private final class EscolhaDeEmissao: @unchecked Sendable {
    private(set) var consultados: [String] = []
    private var preferencia: ThermalCodeEmissionPreferences?

    func escreva(_ nova: ThermalCodeEmissionPreferences) { preferencia = nova }

    func leia(_ profileId: String) -> ThermalCodeEmissionPreferences? {
        consultados.append(profileId)
        return preferencia
    }
}
