import XCTest
@testable import ThermalPrinterKit

/**
 O modelo de **instalações múltiplas**: várias impressoras confirmadas neste aparelho, uma ativa.

 A régua antiga era "uma seleção por transporte", e ela apagava em silêncio: adotar a segunda
 portátil levava a primeira junto, sem aviso e sem confirmação, e o que sumia era uma instalação
 que alguém tinha confirmado no papel. Aqui a chave é a unidade — perfil mais resumo da identidade
 física —, e é essa chave que separa "readotar a de sempre" de "instalar mais uma".
 */
final class PrinterInstallationsTests: XCTestCase {
    private let t210 = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
    private let mtpII = UUID(uuidString: "0A2C55E1-9D33-4B18-8F41-71E2B6C0D4A9")!
    private let portatil = "generic.portable58.escpos"
    private let balcao = "generic.counter.escpos"

    // MARK: - Chave da unidade

    /// Duas unidades do mesmo modelo convivem; a mesma unidade, readotada, substitui.
    func testDuasUnidadesDoMesmoPerfilCoexistemEReadotarSubstitui() {
        let primeira = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: t210)
        let segunda = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: mtpII)

        let duas = PersistedPrinterSelections().with(primeira).with(segunda)

        XCTAssertEqual(duas.selections.count, 2)
        XCTAssertEqual(duas.activeSelection, segunda)
        XCTAssertEqual(duas.with(primeira).selections.count, 2, "readotar não empilha duplicata")
        XCTAssertEqual(duas.with(primeira).activeSelection, primeira, "quem foi reconfirmada assume")
    }

    /// Duas no mesmo transporte é a régua nova: nada de "uma por meio físico".
    func testDuasUnidadesNoMesmoTransporteEDePerfisDiferentesCoexistem() {
        let medido = "550e8400-e29b-41d4-a716-446655440000"
        let guardadas = PersistedPrinterSelections()
            .with(.bluetooth(profileId: portatil, peripheralIdentifier: t210))
            .with(.bluetooth(profileId: medido, peripheralIdentifier: mtpII))

        XCTAssertEqual(guardadas.selections.count, 2)
        XCTAssertEqual(guardadas.selections.map(\.transport), [.bluetooth, .bluetooth])
        XCTAssertEqual(guardadas.ofInstallation(guardadas.selections[0].installationId)?.profileId, portatil)
    }

    /// Sem identidade conhecida a chave cai no perfil sozinho — o comportamento antigo, que é o
    /// correto para esse caso: a mesma impressora sem endereço substitui, não duplica.
    func testSemIdentidadeAChaveEOPerfilSozinho() {
        let semIdentidade = PersistedPrinterSelection.bluetooth(profileId: portatil)

        let guardadas = PersistedPrinterSelections().with(semIdentidade).with(semIdentidade)

        XCTAssertEqual(guardadas.selections.count, 1)
        XCTAssertEqual(semIdentidade.installationId, portatil)
        XCTAssertNil(semIdentidade.physicalIdentity)
    }

    /**
     O identificador de instalação é opaco: hash truncado, nunca o endereço.

     Ele atravessa a superfície dentro do ``AdoptedPrinter`` e chega ao app hospedeiro. Se
     carregasse o UUID do periférico ou o IP da impressora, seria o endereço saindo do store
     cifrado pela porta da frente.
     */
    func testInstallationIdEOpacoENaoCarregaEnderecoNemUUID() throws {
        let ble = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: t210)
        let wifi = PersistedPrinterSelection.localWifi(
            profileId: balcao,
            endpoint: try XCTUnwrap(PersistedNetworkEndpoint(ipv4Address: "192.168.31.88", port: 9_100))
        )

        for (selecao, identidade) in [(ble, t210.uuidString), (wifi, "192.168.31.88")] {
            let id = selecao.installationId
            XCTAssertFalse(id.contains(identidade), id)
            XCTAssertFalse(id.lowercased().contains(identidade.lowercased()), id)
            XCTAssertTrue(id.hasPrefix("\(selecao.profileId)#"), id)
            // Doze hex: o mesmo tamanho do resumo do Android, e curto demais para reconstruir MAC.
            XCTAssertEqual(id.split(separator: "#").last?.count, 12, id)
        }
        XCTAssertEqual(ble.installationId, ble.installationId, "o resumo é estável")
        XCTAssertNotEqual(
            ble.installationId,
            PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: mtpII).installationId
        )
        XCTAssertFalse("\(wifi)".contains("192.168.31.88"))
        XCTAssertFalse("\(try XCTUnwrap(wifi.networkEndpoint))".contains("192.168.31.88"))
    }

    // MARK: - Exclusão por unidade

    /// Remover a segunda MTP-II não pode desinstalar a primeira.
    func testRemoverUmaUnidadeNaoLevaAIrma() {
        let primeira = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: t210)
        let segunda = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: mtpII)
        let duas = PersistedPrinterSelections().with(primeira).with(segunda)

        let restou = duas.withoutInstallation(segunda.installationId)

        XCTAssertEqual(restou.selections, [primeira])
        XCTAssertEqual(restou.activeSelection, primeira, "a ativa removida passa a bola, não some")
        XCTAssertEqual(duas.withoutInstallation(primeira.installationId).activeSelection, segunda)
    }

    /// Excluir a impressora em uso daquele meio não pode levar a irmã do mesmo meio.
    func testExcluirAAtivaDoTransporteDeixaAOutraDoMesmoTransporte() {
        let primeira = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: t210)
        let segunda = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: mtpII)
        let duas = PersistedPrinterSelections().with(primeira).with(segunda)

        XCTAssertEqual(duas.withoutActiveAt(.bluetooth).selections, [primeira])
        // `without(transport)` continua existindo, e continua levando todas: é compatibilidade,
        // não a operação de excluir uma impressora.
        XCTAssertTrue(duas.without(.bluetooth).selections.isEmpty)
    }

    /// A ativa é por unidade. Com duas iguais instaladas, o transporte marcaria as duas.
    func testAAtivaEPorUnidadeENaoPorTransporte() {
        let primeira = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: t210)
        let segunda = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: mtpII)
        let duas = PersistedPrinterSelections().with(primeira).with(segunda)

        let trocada = duas.activatedInstallation(primeira.installationId)

        XCTAssertEqual(trocada.activeInstallationId, primeira.installationId)
        XCTAssertEqual(trocada.active, PrinterTransport.bluetooth)
        XCTAssertEqual(trocada.of(.bluetooth), primeira, "`of` resolve a ativa, não a primeira da lista")
        XCTAssertEqual(
            duas.activatedInstallation("perfil.que.nao.existe").activeInstallationId,
            segunda.installationId,
            "instalação desconhecida não muda quem recebe os cupons"
        )
    }

    // MARK: - Migração do chaveiro

    /**
     Payload gravado antes de a identidade existir (pré-`7d8b422`), literal.

     Se ele deixasse de decodificar, toda impressora adotada sumiria na atualização do app — não
     como erro, como lista vazia — e a pessoa teria que procurar e confirmar tudo de novo.
     */
    func testPayloadAntigoSemIdentidadeAtravessaInteiro() throws {
        let antigo = Data(#"""
        {"selections":[{"transport":"bluetooth","profileId":"generic.portable58.escpos"},\#
        {"transport":"localWifi","profileId":"generic.counter.escpos"}],"active":"bluetooth"}
        """#.utf8)

        let guardadas = try JSONDecoder().decode(PersistedPrinterSelections.self, from: antigo)

        XCTAssertEqual(guardadas.selections.count, 2)
        XCTAssertEqual(guardadas.of(.bluetooth), .bluetooth(profileId: portatil))
        XCTAssertEqual(guardadas.of(.localWifi), .localWifi(profileId: balcao))
        XCTAssertNil(guardadas.of(.bluetooth)?.peripheralIdentifier)
        XCTAssertNil(guardadas.of(.localWifi)?.networkEndpoint)
        // A ativa é reconstruída pelo transporte, que era a única chave que existia. Como naquele
        // formato cabia uma por transporte, a reconstrução é exata.
        XCTAssertEqual(guardadas.active, PrinterTransport.bluetooth)
        XCTAssertEqual(guardadas.activeInstallationId, portatil)
        XCTAssertEqual(guardadas.activeSelection, .bluetooth(profileId: portatil))
    }

    /// Payload da retomada por identidade (pós-`7d8b422`), literal: a identidade sobrevive e vira
    /// chave de instalação.
    func testPayloadComIdentidadeBluetoothAtravessaInteiro() throws {
        let comIdentidade = Data(#"""
        {"selections":[{"transport":"bluetooth","profileId":"generic.portable58.escpos",\#
        "peripheralIdentifier":"6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01"}],"active":"bluetooth"}
        """#.utf8)

        let guardadas = try JSONDecoder().decode(PersistedPrinterSelections.self, from: comIdentidade)
        let unica = try XCTUnwrap(guardadas.selections.first)

        XCTAssertEqual(unica, .bluetooth(profileId: portatil, peripheralIdentifier: t210))
        XCTAssertEqual(guardadas.activeInstallationId, unica.installationId)
        XCTAssertNotEqual(guardadas.activeInstallationId, portatil, "com identidade, a chave não é o perfil")
        XCTAssertFalse(try XCTUnwrap(guardadas.activeInstallationId).contains(t210.uuidString))
    }

    /// O formato novo volta inteiro do disco: duas unidades e qual delas recebe os cupons.
    func testRoundTripDoFormatoNovoPreservaAsDuasUnidadesEAAtiva() throws {
        let primeira = PersistedPrinterSelection.bluetooth(profileId: portatil, peripheralIdentifier: t210)
        let segunda = PersistedPrinterSelection.localWifi(
            profileId: balcao,
            endpoint: try XCTUnwrap(PersistedNetworkEndpoint(ipv4Address: "192.168.31.88", port: 9_100))
        )
        let guardadas = PersistedPrinterSelections()
            .with(segunda)
            .with(primeira)
            .activatedInstallation(segunda.installationId)

        let dados = try JSONEncoder().encode(guardadas)
        let voltou = try JSONDecoder().decode(PersistedPrinterSelections.self, from: dados)

        XCTAssertEqual(voltou, guardadas)
        XCTAssertEqual(voltou.selections.count, 2)
        XCTAssertEqual(voltou.activeSelection, segunda)
        XCTAssertEqual(voltou.of(.localWifi)?.networkEndpoint?.port, 9_100)
        XCTAssertEqual(voltou.of(.bluetooth)?.peripheralIdentifier, t210)
    }

    /// Sem identidade, o registro gravado é byte a byte o antigo: quem nunca teve não ganha campo,
    /// e um kit mais velho volta a ler o mesmo item do chaveiro.
    func testSemIdentidadeOPayloadContinuaSendoOAntigo() throws {
        let texto = String(
            decoding: try JSONEncoder().encode(PersistedPrinterSelection.localWifi(profileId: balcao)),
            as: UTF8.self
        )

        XCTAssertFalse(texto.contains("endpoint"))
        XCTAssertFalse(texto.contains("peripheralIdentifier"))
    }

    // MARK: - Schema fechado

    /**
     O endpoint entra pelo nome canônico, só no Wi-Fi, e só com os dois campos dele.

     A porta que a identidade de rede abriu tem exatamente a largura de um campo. Vizinho de nome
     parecido é campo desconhecido como qualquer outro, e o Bluetooth não recebe endpoint nenhum —
     seria endereço entrando pela lateral, que é o que o formato neutro existe para impedir.
     */
    func testSchemaAceitaSoOEndpointCanonicoEApenasNoWifi() throws {
        for vizinho in ["address", "host", "ipAddress", "networkEndpoint", "endPoint"] {
            let disfarcado = Data(#"""
            {"transport":"localWifi","profileId":"generic.counter.escpos",\#
            "\#(vizinho)":{"ipv4Address":"192.168.31.88","port":9100}}
            """#.utf8)
            XCTAssertThrowsError(
                try JSONDecoder().decode(PersistedPrinterSelection.self, from: disfarcado),
                vizinho
            )
        }

        let noBluetooth = Data(#"""
        {"transport":"bluetooth","profileId":"generic.portable58.escpos",\#
        "endpoint":{"ipv4Address":"192.168.31.88","port":9100}}
        """#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(PersistedPrinterSelection.self, from: noBluetooth))
        XCTAssertNil(PersistedPrinterSelection.bluetooth(profileId: portatil).networkEndpoint)

        let canonico = Data(#"""
        {"transport":"localWifi","profileId":"generic.counter.escpos",\#
        "endpoint":{"ipv4Address":"192.168.31.88","port":9100}}
        """#.utf8)
        let decodificado = try JSONDecoder().decode(PersistedPrinterSelection.self, from: canonico)
        XCTAssertEqual(decodificado.networkEndpoint?.ipv4Address, "192.168.31.88")
        XCTAssertEqual(decodificado.networkEndpoint?.port, 9_100)
    }

    /// O endpoint também tem schema fechado, e a mesma validação do endpoint operacional: campo a
    /// mais, campo a menos e endereço fora da rede privada não viram destino de cupom.
    func testEndpointRecusaCampoDesconhecidoEEnderecoForaDaRedePrivada() {
        let comExtra = Data(#"""
        {"transport":"localWifi","profileId":"generic.counter.escpos",\#
        "endpoint":{"ipv4Address":"192.168.31.88","port":9100,"mac":"aa:bb:cc:dd:ee:ff"}}
        """#.utf8)
        let semPorta = Data(#"""
        {"transport":"localWifi","profileId":"generic.counter.escpos",\#
        "endpoint":{"ipv4Address":"192.168.31.88"}}
        """#.utf8)
        let publico = Data(#"""
        {"transport":"localWifi","profileId":"generic.counter.escpos",\#
        "endpoint":{"ipv4Address":"8.8.8.8","port":9100}}
        """#.utf8)

        for payload in [comExtra, semPorta, publico] {
            XCTAssertThrowsError(try JSONDecoder().decode(PersistedPrinterSelection.self, from: payload))
        }
        XCTAssertNil(PersistedNetworkEndpoint(ipv4Address: "8.8.8.8", port: 9_100))
        XCTAssertNil(PersistedNetworkEndpoint(ipv4Address: "192.168.31.88", port: 0))
    }

    /// A coleção também: `activeInstallationId` entrou, e nada mais entrou junto.
    func testColecaoRecusaCampoDesconhecido() {
        let comExtra = Data(#"""
        {"selections":[],"active":null,"activeProfileId":"generic.counter.escpos"}
        """#.utf8)

        XCTAssertThrowsError(
            try JSONDecoder().decode(PersistedPrinterSelections.self, from: comExtra)
        )
    }

    /// Instalação ativa que não existe na lista não pode sobreviver ao disco apontando para nada.
    func testAtivaOrfaNoPayloadCaiNaPrimeiraInstalada() throws {
        let orfa = Data(#"""
        {"selections":[{"transport":"bluetooth","profileId":"generic.portable58.escpos"}],\#
        "active":"bluetooth","activeInstallationId":"perfil.que.nao.existe"}
        """#.utf8)

        let guardadas = try JSONDecoder().decode(PersistedPrinterSelections.self, from: orfa)

        XCTAssertEqual(guardadas.activeInstallationId, portatil)
        XCTAssertEqual(guardadas.activeSelection, .bluetooth(profileId: portatil))
    }
}

/// As APIs por unidade, vistas de onde a superfície as chama.
@MainActor
final class PrinterInstallationCoordinatorTests: XCTestCase {
    private let t210 = UUID(uuidString: "6B1DF3B4-6A0F-4E7B-9F2C-1C4E5A8D9B01")!
    private let mtpII = UUID(uuidString: "0A2C55E1-9D33-4B18-8F41-71E2B6C0D4A9")!

    /**
     A escolha aparece no toque; a reconexão vem depois e só atualiza a prontidão.

     É a lição do Android: publicar a lista só no fim da reconexão deixa o check congelado na
     unidade anterior por segundos de varredura BLE, e na bancada isso se lê como "não dá para
     selecionar a outra".
     */
    func testAtivarUmaUnidadePublicaAEscolhaNoToque() throws {
        let primeira = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )
        let segunda = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: mtpII
        )
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(primeira).with(segunda))
        let coordinator = makeCoordinator(store: store)

        XCTAssertEqual(coordinator.adoptedPrinters.count, 2)
        XCTAssertEqual(
            coordinator.adoptedPrinters.filter(\.active).map(\.installationId),
            [segunda.installationId]
        )

        coordinator.activateInstallation(primeira.installationId)

        XCTAssertEqual(
            coordinator.adoptedPrinters.filter(\.active).map(\.installationId),
            [primeira.installationId],
            "a lista publicada precisa refletir o toque, e não o fim da varredura"
        )
        XCTAssertEqual(store.read().activeInstallationId, primeira.installationId)
        // As duas continuam instaladas: ativar é escolher, não trocar.
        XCTAssertEqual(coordinator.adoptedPrinters.count, 2)
        XCTAssertEqual(Set(coordinator.adoptedPrinters.map(\.id)).count, 2)
    }

    /**
     Remover uma unidade preserva a irmã e o perfil medido que as duas compartilham.

     Duas MTP-II do mesmo balcão dividem a medição feita na bancada. Apagar o perfil junto com a
     primeira exclusão deixaria a segunda imprimindo na largura conservadora, sem erro em lugar
     nenhum — medição do usuário nunca se perde por efeito colateral.
     */
    func testRemoverUmaUnidadePreservaAIrmaEOPerfilMedidoCompartilhado() throws {
        let profileStore = PrinterProfileStore(dataStore: InstallationsMemoryProfileDataStore())
        let medido = try MeasuredProfile(
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
        try profileStore.save(medido)
        let primeira = PersistedPrinterSelection.bluetooth(profileId: medido.id, peripheralIdentifier: t210)
        let segunda = PersistedPrinterSelection.bluetooth(profileId: medido.id, peripheralIdentifier: mtpII)
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(primeira).with(segunda))
        let coordinator = makeCoordinator(store: store, profileStore: profileStore)

        coordinator.removeInstallation(segunda.installationId)

        XCTAssertEqual(store.read().selections, [primeira])
        XCTAssertEqual(coordinator.adoptedPrinters.map(\.installationId), [primeira.installationId])
        XCTAssertEqual(coordinator.adoptedPrinters.first?.printableDots, 320)
        XCTAssertEqual(profileStore.profiles(), [medido], "a irmã ainda usa a medição")
        // A ativa removida passa a bola em vez de deixar o balcão sem impressora.
        XCTAssertEqual(coordinator.adoptedPrinters.first?.active, true)

        coordinator.removeInstallation(primeira.installationId)

        XCTAssertTrue(store.read().selections.isEmpty)
        XCTAssertTrue(coordinator.adoptedPrinters.isEmpty)
        XCTAssertTrue(profileStore.profiles().isEmpty, "sem ninguém apontando, a medição sai junto")
    }

    /// Excluir a portátil não pode desinstalar a impressora de rede, e vice-versa.
    func testRemoverUmaUnidadeNaoAtingeOOutroTransporte() {
        let portatil = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )
        let balcao = PersistedPrinterSelection.localWifi(
            profileId: LocalWifiThermalPrinterController.profileId
        )
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(balcao).with(portatil))
        let coordinator = makeCoordinator(store: store)

        coordinator.removeInstallation(portatil.installationId)

        XCTAssertEqual(store.read().selections, [balcao])
        XCTAssertEqual(coordinator.adoptedPrinters.map(\.transport), [.localWifi])
        XCTAssertEqual(store.read().activeInstallationId, balcao.installationId)
    }

    /// Instalação desconhecida não muda nada — nem a ativa, nem a lista, nem os perfis.
    func testUnidadeDesconhecidaNaoMudaNada() {
        let portatil = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(portatil))
        let coordinator = makeCoordinator(store: store)

        coordinator.activateInstallation("nao.existe")
        coordinator.removeInstallation("nao.existe")

        XCTAssertEqual(store.read().selections, [portatil])
        XCTAssertEqual(store.read().activeInstallationId, portatil.installationId)
        XCTAssertEqual(coordinator.adoptedPrinters.count, 1)
    }

    /**
     A bancada de duas portáteis, em teste: alternar a ativa troca em qual delas o cupom sai.

     É a pergunta que o papel respondeu errado em 20/08, agora com as duas instaladas: não basta a
     lista mostrar o check no lugar certo, o cupom precisa sair na que está marcada.
     */
    func testAlternarAAtivaTrocaAImpressoraQueRecebeOCupom() async {
        let primeira = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )
        let segunda = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: mtpII
        )
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(primeira).with(segunda))
        let radio = SilentBleTransport(ligadas: [t210, mtpII])
        let coordinator = makeCoordinator(store: store, bluetooth: radio)

        coordinator.activateInstallation(primeira.installationId)
        await waitUntil { coordinator.bluetooth.state == .ready }
        let naPrimeira = await coordinator.print(ReciboDeUnidade())

        XCTAssertEqual(naPrimeira, .delivered)
        XCTAssertEqual(radio.enviadoPara, [t210])

        coordinator.activateInstallation(segunda.installationId)
        await waitUntil { coordinator.bluetooth.state == .ready }
        let naSegunda = await coordinator.print(ReciboDeUnidade())

        XCTAssertEqual(naSegunda, .delivered)
        XCTAssertEqual(radio.enviadoPara, [t210, mtpII], "o cupom sai na marcada, não na que respondeu")
    }

    /**
     O cheque do dono, em teste: Testar no card da parada sai **nela**, com a ativa ligada do lado.

     Foi o que o papel desmentiu no iPhone 7 em 20/08 — tocar em Testar na MTP-II, que não era a
     ativa, imprimiu na outra. A causa é o controlador guardar uma conexão por transporte: a da
     unidade que está servindo. É a impressão silenciosa na impressora errada, que é a violação que
     a casa não admite.
     */
    func testTestarAUnidadeParadaSaiNelaESemTrocarAAtiva() async {
        let primeira = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )
        let segunda = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: mtpII
        )
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(primeira).with(segunda))
        let radio = SilentBleTransport(ligadas: [t210, mtpII])
        let coordinator = makeCoordinator(store: store, bluetooth: radio)
        await waitUntil { coordinator.bluetooth.state == .ready }

        let resultado = await coordinator.testInstallation(primeira.installationId)

        XCTAssertEqual(resultado, .delivered)
        XCTAssertEqual(radio.enviadoPara, [t210], "o comprovante saiu numa impressora que ninguém pediu")
        XCTAssertEqual(
            store.read().activeInstallationId,
            segunda.installationId,
            "um teste não escolhe impressora"
        )
        XCTAssertEqual(
            coordinator.adoptedPrinters.filter(\.active).map(\.installationId),
            [segunda.installationId]
        )

        // A conexão em memória da ativa volta: o recibo seguinte sai onde sempre saiu.
        await waitUntil { coordinator.bluetooth.state == .ready }
        let recibo = await coordinator.print(ReciboDeUnidade())

        XCTAssertEqual(recibo, .delivered)
        XCTAssertEqual(radio.enviadoPara, [t210, mtpII])
    }

    /// Testar a própria ativa é o caminho de sempre: mesmo destino e mesmos bytes.
    func testTestarAAtivaContinuaSaindoNelaComOsMesmosBytes() async {
        let primeira = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )
        let segunda = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: mtpII
        )
        let porUnidade = SilentBleTransport(ligadas: [t210, mtpII])
        let porTransporte = SilentBleTransport(ligadas: [t210, mtpII])
        let comUnidade = makeCoordinator(store: storeCom(primeira, segunda), bluetooth: porUnidade)
        let comTransporte = makeCoordinator(store: storeCom(primeira, segunda), bluetooth: porTransporte)
        await waitUntil { comUnidade.bluetooth.state == .ready && comTransporte.bluetooth.state == .ready }

        let novo = await comUnidade.testInstallation(segunda.installationId)
        let antigo = await comTransporte.test(.bluetooth)

        XCTAssertEqual(novo, antigo)
        XCTAssertEqual(porUnidade.enviadoPara, [mtpII])
        XCTAssertEqual(porUnidade.enviados, porTransporte.enviados, "o comprovante da ativa mudou de bytes")
    }

    /**
     Unidade fora de alcance: recusa nomeando a impressora, e nenhum byte em impressora nenhuma.

     Pelo Wi-Fi porque ali a varredura termina: no BLE a busca segue aberta até o prazo, e o que
     este teste precisa provar é o desfecho — cair na ativa, que está ligada e respondendo ao lado,
     seria o defeito de origem com outro nome.
     */
    func testUnidadeForaDeAlcanceRecusaNomeadaESemPapelEmNinguem() async throws {
        let profileStore = PrinterProfileStore(dataStore: InstallationsMemoryProfileDataStore())
        let doBar = try MeasuredProfile(
            id: UUID(),
            displayName: "Impressora do bar",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.localWifi],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: .cp850,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: 9_100
        )
        try profileStore.save(doBar)
        let ativa = PersistedPrinterSelection.localWifi(
            profileId: LocalWifiThermalPrinterController.profileId,
            endpoint: try XCTUnwrap(PersistedNetworkEndpoint(ipv4Address: "192.168.1.41", port: 9_100))
        )
        let parada = PersistedPrinterSelection.localWifi(
            profileId: doBar.id,
            endpoint: try XCTUnwrap(PersistedNetworkEndpoint(ipv4Address: "192.168.1.40", port: 9_100))
        )
        let store = InMemoryPrinterSelectionStore()
        store.save(store.read().with(parada).with(ativa))
        // Só a ativa responde: a parada está desligada, como a impressora do balcão à noite.
        let rede = SubredeDeBancada(respondendo: ["192.168.1.41"])
        let coordinator = makeCoordinator(store: store, profileStore: profileStore, wifi: rede)
        await waitUntil { coordinator.localWifi.state == .ready }

        let resultado = await coordinator.testInstallation(parada.installationId)

        XCTAssertEqual(
            resultado,
            .failed(
                message: "Impressora do bar não respondeu — confira se ela está ligada.",
                delivery: .notSent
            )
        )
        XCTAssertTrue(rede.enviadoPara.isEmpty, "saiu papel numa impressora que a pessoa não pediu")
        XCTAssertEqual(store.read().activeInstallationId, ativa.installationId)

        // A recusa não pode custar a conexão da ativa.
        await waitUntil { coordinator.localWifi.state == .ready }
        let recibo = await coordinator.print(ReciboDeUnidade())
        XCTAssertEqual(recibo, .delivered)
        XCTAssertEqual(rede.enviadoPara.map(\.ipAddress), ["192.168.1.41"])
    }

    /// Instalação desconhecida não vira comprovante em impressora nenhuma.
    func testUnidadeDesconhecidaNaoImprimeEmNinguem() async {
        let portatil = PersistedPrinterSelection.bluetooth(
            profileId: BluetoothThermalPrinterController.profileId,
            peripheralIdentifier: t210
        )
        let radio = SilentBleTransport(ligadas: [t210])
        let coordinator = makeCoordinator(store: storeCom(portatil), bluetooth: radio)
        await waitUntil { coordinator.bluetooth.state == .ready }

        let resultado = await coordinator.testInstallation("nao.existe")

        XCTAssertEqual(
            resultado,
            .failed(message: "Esta impressora não está instalada neste aparelho.", delivery: .notSent)
        )
        XCTAssertTrue(radio.enviadoPara.isEmpty)
    }

    private func storeCom(_ selecoes: PersistedPrinterSelection...) -> InMemoryPrinterSelectionStore {
        let store = InMemoryPrinterSelectionStore()
        store.save(selecoes.reduce(store.read()) { $0.with($1) })
        return store
    }

    private func makeCoordinator(
        store: any PrinterSelectionStoring,
        profileStore: PrinterProfileStore? = nil,
        bluetooth: SilentBleTransport = SilentBleTransport(),
        wifi: SubredeDeBancada? = nil
    ) -> ThermalPrintingCoordinator {
        let rede: any LocalWifiPrinterNetworkProviding = wifi == nil
            ? OfflineWifiNetworkProvider()
            : BancadaWifiNetworkProvider()
        let porRede: any LocalWifiPrinterTransport = wifi ?? SilentWifiTransport()
        return ThermalPrintingCoordinator(
            store: store,
            localWifi: LocalWifiThermalPrinterController(
                networkProvider: rede,
                transport: porRede,
                store: store,
                profileStore: profileStore
            ),
            bluetooth: BluetoothThermalPrinterController(
                transport: bluetooth,
                store: store,
                profileStore: profileStore
            ),
            profileStore: profileStore
        )
    }

    private func waitUntil(_ condition: @escaping () -> Bool, attempts: Int = 1_000) async {
        for _ in 0..<attempts {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("A operação assíncrona não avançou dentro do limite do teste.")
    }
}

/// Rádio de bancada: anuncia as portáteis ligadas e registra em qual delas cada cupom entrou.
/// Sem nenhuma ligada, é o rádio mudo que os testes de store usam.
private final class SilentBleTransport: BluetoothPrinterTransporting {
    var onStateChange: ((BluetoothPrinterRadioState) -> Void)?
    var onCandidates: (([BluetoothPrinterCandidate]) -> Void)?

    private let ligadas: [UUID]
    private(set) var enviadoPara: [UUID?] = []
    /// O papel, e não só o destino: é o que prova que testar a ativa não mudou byte nenhum.
    private(set) var enviados: [Data] = []

    init(ligadas: [UUID] = []) {
        self.ligadas = ligadas
    }

    func startScan() {
        guard !ligadas.isEmpty else { return }
        onCandidates?(
            ligadas.enumerated().map { indice, identificador in
                BluetoothPrinterCandidate(
                    id: indice + 1,
                    label: "Portátil \(indice + 1)",
                    peripheralIdentifier: identificador
                )
            }
        )
    }

    func stopScan() {}
    func disconnect() {}
    func send(
        _ payload: Data,
        to candidate: BluetoothPrinterCandidate,
        completion: @escaping (ThermalPrintResult) -> Void
    ) {
        guard !ligadas.isEmpty else {
            return completion(.failed(message: "Sem rádio no teste.", delivery: .notSent))
        }
        enviadoPara.append(candidate.peripheralIdentifier)
        enviados.append(payload)
        completion(.delivered)
    }
}

/// Sub-rede de bancada: só os endereços ligados respondem, e `enviadoPara` diz em qual unidade o
/// papel saiu — a pergunta que o comprovante responde no balcão.
private final class SubredeDeBancada: LocalWifiPrinterTransport, @unchecked Sendable {
    private let respondendo: Set<String>
    private(set) var enviadoPara: [LocalWifiPrinterEndpoint] = []

    init(respondendo: [String]) {
        self.respondendo = Set(respondendo)
    }

    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool {
        respondendo.contains(endpoint.ipAddress)
    }

    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws {
        enviadoPara.append(endpoint)
    }
}

private struct BancadaWifiNetworkProvider: LocalWifiPrinterNetworkProviding {
    func currentNetwork() -> LocalWifiPrinterNetwork? {
        LocalWifiPrinterSubnet(hostAddress: "192.168.1.10", prefixLength: 24)
            .map(LocalWifiPrinterNetwork.init(subnet:))
    }
}

private final class ReciboDeUnidade: ThermalReceiptPayload {
    func receiptBytes(layout: ReceiptLayout) -> Data? { Data([0x41]) }
    func clear() {}
}

private struct OfflineWifiNetworkProvider: LocalWifiPrinterNetworkProviding {
    func currentNetwork() -> LocalWifiPrinterNetwork? { nil }
}

private struct SilentWifiTransport: LocalWifiPrinterTransport {
    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool { false }
    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws {
        throw LocalWifiPrinterTransportError.unavailable
    }
}

private final class InstallationsMemoryProfileDataStore: PrinterProfileDataStoring {
    private var data: Data?

    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}
