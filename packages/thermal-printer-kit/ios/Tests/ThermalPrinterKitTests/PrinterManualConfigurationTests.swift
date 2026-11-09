import XCTest
@testable import ThermalPrinterKit

/// A configuração manual sem tela: o que a pessoa declara, o que isso vira em perfil e o que
/// acontece com a instalação que já existia.
final class PrinterManualConfigurationTests: XCTestCase {
    // MARK: - Defaults conservadores

    func testOPontoDePartidaNaoPrometeAcentoNemCorte() {
        let estreita = PrinterManualConfiguration.conservative(displayName: "Impressora nova")

        XCTAssertEqual(estreita.paperWidth, .mm58)
        XCTAssertEqual(estreita.printableColumns, 32)
        XCTAssertEqual(estreita.printableDots, 384)
        XCTAssertFalse(estreita.hasCutter)
        XCTAssertEqual(estreita.cutProtocol, .none)
        XCTAssertEqual(estreita.cutFeedLines, 0)
        XCTAssertNil(estreita.codePage)
        XCTAssertNil(estreita.codePageSelector)
        XCTAssertEqual(estreita.textEncoding, .ascii)

        let larga = PrinterManualConfiguration.conservative(
            displayName: "Impressora nova",
            paperWidth: .mm80
        )
        XCTAssertEqual(larga.printableColumns, 48)
        XCTAssertEqual(larga.printableDots, 576)
    }

    /// Nenhuma opção é deduzida de outra impressora: trocar a bobina devolve a geometria dela, e
    /// não a que estava na tela. Foi assim que a T210 ganhou 80 mm e quebrou "impressor / a".
    func testTrocarALarguraDevolveAGeometriaDaBobinaEscolhida() {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")
        configuracao.printableColumns = 42
        configuracao.printableDots = 320

        configuracao.selectPaperWidth(.mm80)

        XCTAssertEqual(configuracao.printableColumns, 48)
        XCTAssertEqual(configuracao.printableDots, 576)
    }

    func testGuilhotinaAusenteZeraComandoEAvancoEPresenteComecaNoCorteTotal() {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")

        configuracao.selectCutter(true)
        XCTAssertEqual(configuracao.cutProtocol, .gsV0)

        configuracao.selectCutFeedLines(6)
        XCTAssertEqual(configuracao.cutFeedLines, 6)

        configuracao.selectCutter(false)
        XCTAssertEqual(configuracao.cutProtocol, .none)
        XCTAssertEqual(configuracao.cutFeedLines, 0)
        XCTAssertEqual(configuracao.allowedCutFeedLines, [0])
    }

    /// `GS V 65/66` já carregam o avanço de `0x50`; oferecer avanço separado seria empurrar papel
    /// duas vezes.
    func testComandoComAvancoEmbutidoRecusaAvancoSeparado() {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")
        configuracao.selectCutter(true)
        configuracao.selectCutFeedLines(10)

        configuracao.selectCutProtocol(.gsV65)

        XCTAssertEqual(configuracao.cutFeedLines, 0)
        XCTAssertEqual(configuracao.allowedCutFeedLines, [0])
        configuracao.selectCutFeedLines(4)
        XCTAssertEqual(configuracao.cutFeedLines, 0, "Avanço embutido não aceita distância própria.")

        configuracao.selectCutProtocol(.escM)
        XCTAssertEqual(configuracao.allowedCutFeedLines, PrinterCapabilities.allowedCutFeedLines)
    }

    func testOsComandosOferecidosSaoOsMesmosDoAndroidSemLegadoNemAusencia() {
        XCTAssertEqual(
            PrinterManualConfiguration.cutProtocolChoices,
            [.gsV0, .gsV1, .gsV65, .gsV66, .escI, .escM]
        )
        XCTAssertFalse(PrinterManualConfiguration.cutProtocolChoices.contains(.none))
    }

    // MARK: - Aviso de página ausente

    func testPerfilSemPaginaDeCodigoSaiAvisado() {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")

        XCTAssertTrue(configuracao.foldsAccentsToASCII)
        let aviso = try? XCTUnwrap(configuracao.warning)
        XCTAssertEqual(aviso, PrinterManualConfiguration.foldedAccentsWarning)
        XCTAssertTrue(configuracao.warning?.contains("Impressao") == true)

        let cp850 = try? XCTUnwrap(
            PrinterProbePayloads.codePageCandidates.first { $0.codePage == .cp850 && !$0.isAddress }
        )
        configuracao.select(XCTUnwrapped(cp850))
        XCTAssertFalse(configuracao.foldsAccentsToASCII)
        XCTAssertNil(configuracao.warning)
    }

    /// UTF-8 não tem página e mesmo assim preserva acento: o aviso é sobre a dobra, não sobre o
    /// campo estar vazio.
    func testUTF8NaoRecebeOAvisoDaDobra() {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")
        let utf8 = PrinterProbePayloads.codePageCandidates.first { $0.textEncoding == .utf8 }

        configuracao.select(XCTUnwrapped(utf8))

        XCTAssertNil(configuracao.codePage)
        XCTAssertNil(configuracao.warning)
    }

    // MARK: - Montagem do perfil declarado

    func testAsEscolhasViramUmPerfilLocalComAsCapacidadesDeclaradas() throws {
        var configuracao = PrinterManualConfiguration.conservative(
            displayName: "Impressora do balcão",
            paperWidth: .mm80
        )
        configuracao.printableColumns = 46
        configuracao.printableDots = 512
        configuracao.selectCutter(true)
        configuracao.selectCutProtocol(.escM)
        configuracao.selectCutFeedLines(8)
        configuracao.select(XCTUnwrapped(
            PrinterProbePayloads.codePageCandidates.first { $0.codePage == .cp850 && !$0.isAddress }
        ))

        let perfil = try configuracao.profile(
            id: identificador,
            transports: [.localWifi],
            measuredAt: Date(timeIntervalSince1970: 1_000)
        )

        XCTAssertEqual(perfil.id, identificador)
        XCTAssertEqual(perfil.source, .measured)
        XCTAssertEqual(perfil.displayName, "Impressora do balcão")
        XCTAssertEqual(perfil.paperWidthMm, 80)
        XCTAssertEqual(perfil.printableColumns, 46)
        XCTAssertEqual(perfil.printableDots, 512)
        XCTAssertEqual(perfil.cutProtocol, .escM)
        XCTAssertEqual(perfil.cutFeedLines, 8)
        XCTAssertEqual(perfil.codePage, .cp850)
        XCTAssertEqual(perfil.textEncoding, .singleByteCodePage)
        XCTAssertNil(perfil.codePageSelector, "Nome de página não grava endereço.")
        // Porta é capacidade do protocolo; nenhum endereço atravessa o perfil.
        XCTAssertEqual(perfil.capabilities.tcpPort, 9_100)
        // Perfil novo não promete status sem sonda própria.
        XCTAssertEqual(perfil.statusProtocol, .none)
    }

    func testEnderecoDeESCTGravaOSeletorMedidoENomeDePaginaNao() throws {
        var porEndereco = PrinterManualConfiguration.conservative(displayName: "T210")
        let endereco = PrinterProbePayloads.codePageCandidates.first { $0.isAddress && $0.selector == 8 }
        porEndereco.select(XCTUnwrapped(endereco))

        XCTAssertEqual(porEndereco.codePageSelector, 8)
        let perfil = try porEndereco.profile(id: identificador, transports: [.bluetoothLE])
        XCTAssertEqual(perfil.codePageSelector, 8)
        XCTAssertEqual(perfil.codePage, .cp860)
        // Bluetooth não é rede: sem porta no perfil.
        XCTAssertNil(perfil.capabilities.tcpPort)
    }

    func testAConfiguracaoVoltaInteiraDoPerfilQueEleProduziu() throws {
        var declarada = PrinterManualConfiguration.conservative(
            displayName: "Impressora",
            paperWidth: .mm80
        )
        declarada.selectCutter(true)
        declarada.selectCutProtocol(.gsV1)
        declarada.selectCutFeedLines(4)
        declarada.select(XCTUnwrapped(
            PrinterProbePayloads.codePageCandidates.first { $0.textEncoding == .firmwareDefaultPage }
        ))

        let perfil = try declarada.profile(id: identificador, transports: [.localWifi])

        XCTAssertEqual(PrinterManualConfiguration(perfil), declarada)
        XCTAssertTrue(declarada.matches(PrinterProfile(perfil)))
    }

    // MARK: - Os quatro campos que nenhuma tela declara

    /**
     A declaração carrega os quatro campos medidos tardios de quem já os tem.

     Nenhuma tela de celular pede isto — é API, e quem a preenche é quem transcreve a régua do
     comprovante em papel (`Vazão: 38/48 mm | fator 0,79`). Sem esta porta, a única maneira de o
     fator chegar ao perfil seria repetir a homologação inteira.
     */
    func testADeclaracaoCarregaOsQuatroCamposMedidosTardios() throws {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "T210 do balcão")
        configuracao.maxRasterBytesPerSecond = 4_096
        configuracao.verticalRasterScale = 0.79
        configuracao.nativeQrHonored = false
        configuracao.nativeBarcodeHonored = true

        let perfil = try configuracao.profile(id: identificador, transports: [.bluetoothLE])

        XCTAssertEqual(perfil.maxRasterBytesPerSecond, 4_096)
        XCTAssertEqual(perfil.verticalRasterScale, 0.79)
        XCTAssertEqual(perfil.nativeQrHonored, false)
        XCTAssertEqual(perfil.nativeBarcodeHonored, true)
        // A volta é inteira: a configuração aberta do perfil declara o mesmo que ele guarda.
        XCTAssertEqual(PrinterManualConfiguration(perfil), configuracao)
    }

    /**
     Paridade com o Android, fixada por literal nas duas suítes.

     O mesmo perfil declarado do mesmo jeito precisa sair igual nas duas plataformas, e a chave é o
     que prova isso sem impressora: ela leva o fator em milésimos inteiros, justamente porque
     formatação de ponto flutuante não promete a mesma string dos dois lados. O literal gêmeo está
     em `ManualConfigurationLateFieldsTest` do `:printher`.
     */
    func testAChaveDoPerfilComFatorEAMesmaDasDuasPlataformas() throws {
        var declarada = PrinterManualConfiguration.conservative(displayName: "T210 do balcão")
        declarada.verticalRasterScale = 0.8

        let perfil = try declarada.profile(
            id: identificador,
            transports: Set(PrinterCapabilityTransport.allCases)
        )

        XCTAssertEqual(
            perfil.capabilityKey.rawValue,
            "9d0b8093b21e428ce931f875929ca60d906a75d02a2f22bb207fc52db9155d29"
        )
    }

    /// Quem nunca viu sonda nenhuma continua nascendo sem os quatro: nada completa a lacuna
    /// sozinho, e é isso que mantém o perfil declarado indistinguível do que sempre foi.
    func testSemPerfilAnteriorESemDeclaracaoOsQuatroNascemAusentes() throws {
        let perfil = try PrinterManualConfiguration
            .conservative(displayName: "Impressora nova")
            .profile(id: identificador, transports: [.bluetoothLE])

        XCTAssertNil(perfil.maxRasterBytesPerSecond)
        XCTAssertNil(perfil.verticalRasterScale)
        XCTAssertNil(perfil.nativeQrHonored)
        XCTAssertNil(perfil.nativeBarcodeHonored)
    }

    /// O declarado ganha do anterior — quem transcreve uma régua nova está corrigindo a antiga — e
    /// o que ninguém declarou continua vindo da medição. É o mesmo `?:` do Android.
    func testODeclaradoPrevaleceEOOmitidoVemDoPerfilAnterior() throws {
        let anterior = try MeasuredProfile(
            id: UUID(uuidString: identificador)!,
            displayName: "T210 do balcão",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil,
            maxRasterBytesPerSecond: 4_096,
            verticalRasterScale: 0.8,
            nativeQrHonored: false,
            nativeBarcodeHonored: true
        )
        var declarada = PrinterManualConfiguration.conservative(displayName: "T210 do balcão")
        declarada.verticalRasterScale = 0.9

        let perfil = try declarada
            .preservingLateMeasurements(from: anterior)
            .profile(id: identificador, transports: [.bluetoothLE])

        XCTAssertEqual(perfil.verticalRasterScale, 0.9)
        XCTAssertEqual(perfil.maxRasterBytesPerSecond, 4_096)
        XCTAssertEqual(perfil.nativeQrHonored, false)
        XCTAssertEqual(perfil.nativeBarcodeHonored, true)
    }

    /// As faixas continuam sendo do perfil: declarar fora delas não vira perfil nenhum.
    func testFatorForaDaFaixaMedidaNaoViraPerfil() {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")
        configuracao.verticalRasterScale = 0.4
        XCTAssertThrowsError(try configuracao.profile(id: identificador, transports: [.bluetoothLE]))

        var comVazao = PrinterManualConfiguration.conservative(displayName: "Impressora")
        comVazao.maxRasterBytesPerSecond = 128
        XCTAssertThrowsError(try comVazao.profile(id: identificador, transports: [.bluetoothLE]))
    }

    /**
     Trocar a página de código não apaga a resposta da tela de rede.

     Esta tela **reconstrói o perfil do zero**, e o que ela não carrega some sem erro em lugar
     nenhum — é a mesma classe de defeito que faz um campo falhar dezenas de impressões depois,
     longe da causa. O campo não é editável aqui: ele viaja para não se perder, exatamente como
     `cutModeHonored`.
     */
    func testEditarAPaginaNaoApagaAResostaDaTelaDeRede() throws {
        let medido = try MeasuredProfile(
            id: XCTUnwrapped(UUID(uuidString: identificador)),
            displayName: "T210 de bancada",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.localWifi],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutModeHonored: false,
            cutFeedLines: 0,
            tcpPort: 9_100,
            wifiConfigurationFamily: .measuredUsWHonored
        )

        var declarada = PrinterManualConfiguration(medido)
        XCTAssertEqual(declarada.wifiConfigurationFamily, .measuredUsWHonored)
        declarada.select(XCTUnwrapped(
            PrinterProbePayloads.codePageCandidates.first { $0.isAddress && $0.selector == 8 }
        ))

        let editado = try declarada.profile(id: medido.id, transports: [.localWifi])

        XCTAssertEqual(editado.codePageSelector, 8)
        XCTAssertEqual(editado.wifiConfigurationFamily, .measuredUsWHonored)
        // E o vizinho de mesma natureza continua preservado: os dois viajam pela mesma razão.
        XCTAssertFalse(editado.cutModeHonored)
    }

    /// Quem escolheu o catálogo e não mexeu em nada entra por ele mesmo, sem criar uma medição
    /// local que ninguém pediu.
    func testConfiguracaoIntactaContinuaSendoADoCatalogo() {
        let catalogo = BundledPrinterProfiles.elginI9Full2
        var configuracao = PrinterManualConfiguration(catalogo)

        XCTAssertTrue(configuracao.matches(catalogo))

        configuracao.selectCutter(true)
        XCTAssertFalse(configuracao.matches(catalogo))
    }

    /// A recusa do perfil é honesta e não diz onde mexer. A tela precisa do campo, não do motivo
    /// técnico — botão apagado em silêncio é a outra metade do mesmo defeito.
    func testADeclaracaoDizOQueFaltaNoCampoEmQueSeMexe() {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")
        XCTAssertNil(configuracao.blockingHint)

        configuracao.printableColumns = 0
        XCTAssertEqual(
            configuracao.blockingHint,
            "Informe quantos caracteres cabem numa linha, de 24 a 96."
        )

        configuracao.printableColumns = 32
        configuracao.displayName = "   "
        XCTAssertEqual(
            configuracao.blockingHint,
            "Dê um nome para reconhecer esta impressora na lista."
        )
    }

    func testColunasForaDoContratoNaoViramPerfil() {
        var configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")
        configuracao.printableColumns = 12

        XCTAssertThrowsError(try configuracao.profile(id: identificador, transports: [.bluetoothLE])) {
            XCTAssertEqual($0 as? PrinterProfileValidationError, .invalidGeometry)
        }
    }

    func testDataNovaNuncaEmpataComAAnterior() {
        let anterior = Date(timeIntervalSince1970: 5_000)
        let seguinte = PrinterManualConfiguration.nextMeasurementDate(
            after: anterior,
            now: Date(timeIntervalSince1970: 4_000)
        )

        XCTAssertGreaterThan(seguinte, anterior)
        XCTAssertGreaterThan(
            PrinterManualConfiguration.nextMeasurementDate(after: nil).timeIntervalSince1970,
            0
        )
    }

    // MARK: - Regravação da unidade instalada

    @MainActor
    func testEditarUmaUnidadeMedidaRegravaAMesmaInstalacao() throws {
        let fixture = Fixture()
        let original = try fixture.instalarMedida(
            displayName: "Portátil da frente",
            transport: .bluetooth,
            identity: .bluetooth
        )
        let antes = try XCTUnwrap(fixture.selections.read().selections.first)

        var configuracao = try XCTUnwrap(
            fixture.configuration.manualConfiguration(for: antes.installationId)
        )
        configuracao.select(XCTUnwrapped(
            PrinterProbePayloads.codePageCandidates.first { $0.codePage == .cp850 && !$0.isAddress }
        ))
        let regravado = try fixture.configuration.saveManualConfiguration(
            configuracao,
            for: antes.installationId
        )

        XCTAssertEqual(regravado.id, original.id, "Editar não troca a medição de identificador.")
        XCTAssertEqual(regravado.codePage, .cp850)
        XCTAssertEqual(fixture.profiles.profiles().count, 1, "A edição não deixa medição órfã.")
        let depois = fixture.selections.read().selections
        XCTAssertEqual(depois.count, 1, "A lista continua com um card só.")
        XCTAssertEqual(depois.first?.installationId, antes.installationId)
        XCTAssertEqual(depois.first?.profileId, original.id)
    }

    /// Catálogo é compartilhado e não se edita: a declaração vira medição local, e a unidade
    /// continua sendo uma só — ela passa a apontar para a medição nova no lugar da antiga.
    @MainActor
    func testEditarUnidadeDeCatalogoCriaMedicaoLocalSemDuplicarOCard() throws {
        let fixture = Fixture()
        let catalogo = BundledPrinterProfiles.portable58mm
        let instalada = fixture.instalarCatalogo(catalogo, identity: .bluetooth)

        var configuracao = try XCTUnwrap(
            fixture.configuration.manualConfiguration(for: instalada.installationId)
        )
        configuracao.selectCutter(true)
        configuracao.selectCutProtocol(.escI)
        let declarado = try fixture.configuration.saveManualConfiguration(
            configuracao,
            for: instalada.installationId
        )

        XCTAssertNotEqual(declarado.id, catalogo.id)
        XCTAssertNotNil(UUID(uuidString: declarado.id))
        XCTAssertEqual(declarado.cutProtocol, .escI)
        let depois = fixture.selections.read().selections
        XCTAssertEqual(depois.count, 1)
        XCTAssertEqual(depois.first?.profileId, declarado.id)
        // A identidade física é a mesma impressora; só o perfil mudou de lugar.
        XCTAssertEqual(depois.first?.peripheralIdentifier, instalada.peripheralIdentifier)
    }

    /// Editar uma impressora parada não pode tirar o cupom da que está servindo o balcão.
    @MainActor
    func testEditarUnidadeParadaNaoRoubaAImpressoraAtiva() throws {
        let fixture = Fixture()
        let ativa = fixture.instalarCatalogo(BundledPrinterProfiles.elginI9Full2, identity: .wifi)
        let parada = fixture.instalarCatalogo(BundledPrinterProfiles.portable58mm, identity: .bluetooth)
        fixture.selections.save(
            fixture.selections.read().activatedInstallation(ativa.installationId)
        )

        var configuracao = try XCTUnwrap(
            fixture.configuration.manualConfiguration(for: parada.installationId)
        )
        configuracao.displayName = "Portátil do estoque"
        _ = try fixture.configuration.saveManualConfiguration(
            configuracao,
            for: parada.installationId
        )

        let guardadas = fixture.selections.read()
        XCTAssertEqual(guardadas.activeInstallationId, ativa.installationId)
        XCTAssertEqual(guardadas.selections.count, 2)
        XCTAssertEqual(guardadas.selections.first?.installationId, ativa.installationId)
    }

    @MainActor
    func testEditarUnidadeQueSaiuDaListaFalhaSemMexerEmNada() {
        let fixture = Fixture()
        let configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")

        XCTAssertThrowsError(
            try fixture.configuration.saveManualConfiguration(configuracao, for: "nao.existe")
        ) {
            XCTAssertEqual($0 as? PrinterManualConfigurationError, .installationNotFound)
        }
        XCTAssertTrue(fixture.profiles.profiles().isEmpty)
        XCTAssertTrue(fixture.selections.read().selections.isEmpty)
    }

    /// Duas unidades que dividem a mesma medição continuam dividindo depois da edição: a bancada
    /// mediu um modelo, não um aparelho.
    @MainActor
    func testMedicaoCompartilhadaContinuaCompartilhadaDepoisDaEdicao() throws {
        let fixture = Fixture()
        let medida = try fixture.instalarMedida(
            displayName: "Portátil 1",
            transport: .bluetooth,
            identity: .bluetooth
        )
        let irma = PersistedPrinterSelection.bluetooth(
            profileId: medida.id,
            peripheralIdentifier: UUID(uuidString: "cf5a4c22-9e0f-4b6a-8d13-2a7c9f5e1d44")!
        )
        fixture.selections.save(fixture.selections.read().with(irma))
        let primeira = try XCTUnwrap(
            fixture.selections.read().selections.first { $0.installationId != irma.installationId }
        )

        var configuracao = try XCTUnwrap(
            fixture.configuration.manualConfiguration(for: primeira.installationId)
        )
        configuracao.selectPaperWidth(.mm80)
        _ = try fixture.configuration.saveManualConfiguration(
            configuracao,
            for: primeira.installationId
        )

        XCTAssertEqual(fixture.selections.read().selections.count, 2)
        XCTAssertEqual(fixture.profiles.profiles().count, 1)
        XCTAssertEqual(fixture.profiles.profiles().first?.paperWidthMm, 80)
    }

    /**
     Trocar só a página de código de uma T210 já medida não apaga a régua da sonda.

     `verticalRasterScale` é a compensação do encolhimento constante isolado em 20/08; sem ela,
     foto, logotipo e QR voltam a sair ~20% mais curtos e o cupom continua saindo — o defeito é
     mudo. O mesmo vale para o freio de vazão, que existe contra a rajada que corrompeu foto na
     portátil 58 mm. Nenhuma tela declara os quatro, então quem os preserva é a gravação.
     */
    @MainActor
    func testEditarPerfilMedidoPreservaOsQuatroCamposMedidosTardios() throws {
        let fixture = Fixture()
        let original = try fixture.instalarMedidaComReguaDaSonda(
            displayName: "T210 do balcão",
            transport: .bluetooth,
            identity: .bluetooth
        )
        let instalada = try XCTUnwrap(fixture.selections.read().selections.first)

        var configuracao = try XCTUnwrap(
            fixture.configuration.manualConfiguration(for: instalada.installationId)
        )
        configuracao.select(XCTUnwrapped(
            PrinterProbePayloads.codePageCandidates.first { $0.codePage == .cp850 && !$0.isAddress }
        ))
        let regravado = try fixture.configuration.saveManualConfiguration(
            configuracao,
            for: instalada.installationId
        )

        XCTAssertEqual(regravado.codePage, .cp850, "A troca pedida aconteceu.")
        XCTAssertEqual(regravado.maxRasterBytesPerSecond, original.maxRasterBytesPerSecond)
        XCTAssertEqual(regravado.verticalRasterScale, original.verticalRasterScale)
        XCTAssertEqual(regravado.nativeQrHonored, original.nativeQrHonored)
        XCTAssertEqual(regravado.nativeBarcodeHonored, original.nativeBarcodeHonored)
        // O que o disco devolve é o que a gravação prometeu.
        let relido = try XCTUnwrap(fixture.profiles.profile(id: regravado.id))
        XCTAssertEqual(relido.verticalRasterScale, 0.8)
    }

    /// Regravar sem mexer em nada não pode mover a chave de capacidade: o fator entra nela, e uma
    /// chave que se move faz a medição deixar de casar com a que já foi contribuída.
    @MainActor
    func testRegravarSemMudancaMantemAChaveDeCapacidade() throws {
        let fixture = Fixture()
        let original = try fixture.instalarMedidaComReguaDaSonda(
            displayName: "T210 do balcão",
            transport: .bluetooth,
            identity: .bluetooth
        )
        let instalada = try XCTUnwrap(fixture.selections.read().selections.first)

        let configuracao = try XCTUnwrap(
            fixture.configuration.manualConfiguration(for: instalada.installationId)
        )
        let regravado = try fixture.configuration.saveManualConfiguration(
            configuracao,
            for: instalada.installationId
        )

        XCTAssertEqual(regravado.capabilityKey, original.capabilityKey)
    }

    /// Quem grava a declaração não precisa tê-la aberto da medição: quem responde "qual é o perfil
    /// anterior" é o `previous` do store, o mesmo que já preserva a versão de firmware.
    @MainActor
    func testDeclaracaoMontadaDoZeroNaoApagaAMedicaoDaUnidade() throws {
        let fixture = Fixture()
        let original = try fixture.instalarMedidaComReguaDaSonda(
            displayName: "T210 do balcão",
            transport: .bluetooth,
            identity: .bluetooth
        )
        let instalada = try XCTUnwrap(fixture.selections.read().selections.first)

        let doZero = PrinterManualConfiguration.conservative(displayName: "T210 do balcão")
        let regravado = try fixture.configuration.saveManualConfiguration(
            doZero,
            for: instalada.installationId
        )

        XCTAssertEqual(regravado.verticalRasterScale, original.verticalRasterScale)
        XCTAssertEqual(regravado.maxRasterBytesPerSecond, original.maxRasterBytesPerSecond)
        XCTAssertEqual(regravado.nativeQrHonored, original.nativeQrHonored)
        XCTAssertEqual(regravado.nativeBarcodeHonored, original.nativeBarcodeHonored)
    }

    /**
     A unidade que aponta para o catálogo **não tem medição tardia para preservar**, e é isto que
     este caso afirma.

     Ele já foi escrito comparando o perfil gravado com a entrada do catálogo, e não media nada:
     nenhuma entrada declara os quatro campos — todas nascem com os quatro ausentes —, então as
     quatro asserções eram `nil` contra `nil` e passavam igual com e sem a preservação. A premissa
     agora é afirmada onde ela mora, no catálogo inteiro: quem um dia acrescentar medição tardia a
     uma entrada compartilhada é avisado aqui, e não no papel.
     */
    @MainActor
    func testUnidadeDeCatalogoNaoTemMedicaoTardiaParaPreservar() throws {
        for entrada in BundledPrinterProfiles.all {
            XCTAssertNil(entrada.maxRasterBytesPerSecond, entrada.displayName)
            XCTAssertNil(entrada.verticalRasterScale, entrada.displayName)
            XCTAssertNil(entrada.nativeQrHonored, entrada.displayName)
            XCTAssertNil(entrada.nativeBarcodeHonored, entrada.displayName)
        }

        let fixture = Fixture()
        let catalogo = BundledPrinterProfiles.portable58mm
        let instalada = fixture.instalarCatalogo(catalogo, identity: .bluetooth)

        var configuracao = try XCTUnwrap(
            fixture.configuration.manualConfiguration(for: instalada.installationId)
        )
        configuracao.selectCutter(true)
        let declarado = try fixture.configuration.saveManualConfiguration(
            configuracao,
            for: instalada.installationId
        )

        XCTAssertEqual(declarado.cutProtocol, .gsV0, "A escolha pedida aconteceu.")
        XCTAssertNil(declarado.maxRasterBytesPerSecond)
        XCTAssertNil(declarado.verticalRasterScale)
        XCTAssertNil(declarado.nativeQrHonored)
        XCTAssertNil(declarado.nativeBarcodeHonored)
        // O catálogo é compartilhado e não se edita: o que nasce daqui é medição local nova.
        XCTAssertNotEqual(declarado.id, catalogo.id)
        XCTAssertEqual(fixture.profiles.profiles().map(\.id), [declarado.id])
    }

    /// A mesma unidade de catálogo, agora com uma entrada que **tem** os quatro campos: quem os
    /// carrega ali é a declaração, porque não há medição local para consultar — é o app de mesa
    /// transcrevendo a régua do comprovante (`Vazão: 38/48 mm | fator 0,79`). Sem isto a rota
    /// declarada gravaria a unidade sem compensação, com o cupom saindo normalmente.
    @MainActor
    func testEditarUnidadeDeCatalogoGravaOsQuatroCamposDeclarados() throws {
        let fixture = Fixture()
        let catalogo = BundledPrinterProfiles.portable58mm
        let instalada = fixture.instalarCatalogo(catalogo, identity: .bluetooth)

        var configuracao = try XCTUnwrap(
            fixture.configuration.manualConfiguration(for: instalada.installationId)
        )
        configuracao.maxRasterBytesPerSecond = 4_096
        configuracao.verticalRasterScale = 0.79
        configuracao.nativeQrHonored = false
        configuracao.nativeBarcodeHonored = true

        let declarado = try fixture.configuration.saveManualConfiguration(
            configuracao,
            for: instalada.installationId
        )

        XCTAssertEqual(declarado.maxRasterBytesPerSecond, 4_096)
        XCTAssertEqual(declarado.verticalRasterScale, 0.79)
        XCTAssertEqual(declarado.nativeQrHonored, false)
        XCTAssertEqual(declarado.nativeBarcodeHonored, true)
        // O que o disco devolve é o que a gravação prometeu.
        let relido = try XCTUnwrap(fixture.profiles.profile(id: declarado.id))
        XCTAssertEqual(relido.verticalRasterScale, 0.79)
    }

    // MARK: - O rascunho só vira disco depois do papel

    @MainActor
    func testDeclaracaoSoEGravadaDepoisDaConfirmacaoDoPapel() async throws {
        let fixture = Fixture(network: StubNetwork(hostAddress: "192.168.1.10", prefixLength: 24))
        var configuracao = PrinterManualConfiguration.conservative(
            displayName: "Impressora de rede",
            paperWidth: .mm80
        )
        configuracao.selectCutter(true)
        configuracao.selectCutProtocol(.gsV0)
        configuracao.selectCutFeedLines(5)
        configuracao.select(XCTUnwrapped(
            PrinterProbePayloads.codePageCandidates.first { $0.codePage == .cp850 && !$0.isAddress }
        ))
        let declarado = try configuracao.profile(id: identificador, transports: [.localWifi])

        fixture.configuration.testManual(
            ipAddress: "192.168.1.41",
            portText: "9100",
            declaring: declarado
        )
        try await fixture.waitFor { fixture.configuration.localWifi.state == .awaitingConfirmation }

        XCTAssertTrue(fixture.profiles.profiles().isEmpty, "O rascunho não pode chegar ao disco.")
        // O comprovante saiu com as opções declaradas: é assim que a pessoa vê o acento e o corte
        // certos antes de confirmar.
        let comprovante = try XCTUnwrap(fixture.wifi.sent.last)
        XCTAssertNotNil(comprovante.range(of: Data([0x1b, 0x74, 0x02])), "Faltou o `ESC t` da CP850.")
        XCTAssertNotNil(comprovante.range(of: Data([0x1d, 0x56, 0x00])), "Faltou o corte declarado.")

        XCTAssertEqual(fixture.configuration.handleInitialReceipt(.printedCorrectly), .adopted)

        XCTAssertEqual(fixture.profiles.profiles(), [declarado])
        let instalada = try XCTUnwrap(fixture.selections.read().of(.localWifi))
        XCTAssertEqual(instalada.profileId, declarado.id)
        XCTAssertEqual(instalada.networkEndpoint?.ipv4Address, "192.168.1.41")
    }

    @MainActor
    func testComprovanteRecusadoNaoDeixaAConfiguracaoDeclaradaNoDisco() async throws {
        let fixture = Fixture(network: StubNetwork(hostAddress: "192.168.1.10", prefixLength: 24))
        let declarado = try PrinterManualConfiguration
            .conservative(displayName: "Impressora de rede", paperWidth: .mm80)
            .profile(id: identificador, transports: [.localWifi])

        fixture.configuration.testManual(
            ipAddress: "192.168.1.41",
            portText: "9100",
            declaring: declarado
        )
        try await fixture.waitFor { fixture.configuration.localWifi.state == .awaitingConfirmation }
        XCTAssertEqual(fixture.configuration.handleInitialReceipt(.notPrinted), .discarded)

        XCTAssertTrue(fixture.profiles.profiles().isEmpty)
        XCTAssertTrue(fixture.selections.read().selections.isEmpty)
    }

    /// O comprovante de conferência sai pela candidata em memória, com o layout da tela — e não
    /// com o que estiver gravado. É ele que mostra o acento e o corte antes de qualquer gravação.
    @MainActor
    func testComprovanteDeConferenciaSaiComAsOpcoesDaTelaSemGravarNada() async throws {
        let fixture = Fixture(network: StubNetwork(hostAddress: "192.168.1.10", prefixLength: 24))
        fixture.configuration.testManual(ipAddress: "192.168.1.41", portText: "9100")
        try await fixture.waitFor { fixture.configuration.localWifi.state == .awaitingConfirmation }
        let enviadosAntes = fixture.wifi.sent.count

        var configuracao = PrinterManualConfiguration.conservative(
            displayName: "Impressora de rede",
            paperWidth: .mm80
        )
        configuracao.select(XCTUnwrapped(
            PrinterProbePayloads.codePageCandidates.first { $0.codePage == .cp1252 && !$0.isAddress }
        ))
        configuracao.selectCutter(true)
        configuracao.selectCutProtocol(.escM)

        var resultado: PrinterProbeSendResult?
        XCTAssertTrue(
            fixture.configuration.sendManualConfigurationTestReceipt(configuracao) { resultado = $0 }
        )
        try await fixture.waitFor { resultado != nil }

        XCTAssertEqual(resultado, .success)
        XCTAssertEqual(fixture.wifi.sent.count, enviadosAntes + 1)
        let comprovante = try XCTUnwrap(fixture.wifi.sent.last)
        XCTAssertNotNil(comprovante.range(of: Data([0x1b, 0x74, 0x10])), "Faltou o `ESC t` da CP1252.")
        XCTAssertNotNil(comprovante.range(of: Data([0x1b, 0x6d])), "Faltou o `ESC m` declarado.")
        XCTAssertTrue(fixture.profiles.profiles().isEmpty, "Conferir não grava nada.")
        XCTAssertTrue(fixture.selections.read().selections.isEmpty)
    }

    /// A rota do Android: instala com as opções informadas, sem enviar sonda nenhuma, e o perfil
    /// só existe depois que o store confirma a releitura.
    @MainActor
    func testInstalarPelaDeclaracaoGravaOPerfilEAdotaAUnidade() async throws {
        let fixture = Fixture(network: StubNetwork(hostAddress: "192.168.1.10", prefixLength: 24))
        fixture.configuration.testManual(ipAddress: "192.168.1.41", portText: "9100")
        try await fixture.waitFor { fixture.configuration.localWifi.state == .awaitingConfirmation }

        var configuracao = PrinterManualConfiguration.conservative(
            displayName: "Impressora do balcão",
            paperWidth: .mm80
        )
        configuracao.selectCutter(true)
        configuracao.selectCutProtocol(.gsV0)
        configuracao.selectCutFeedLines(5)
        let enviados = fixture.wifi.sent.count

        let instalado = try fixture.configuration.adoptManualConfiguration(configuracao)

        XCTAssertEqual(fixture.wifi.sent.count, enviados, "A rota declarada não envia sonda.")
        XCTAssertEqual(fixture.profiles.profiles(), [instalado])
        let unidade = try XCTUnwrap(fixture.selections.read().of(.localWifi))
        XCTAssertEqual(unidade.profileId, instalado.id)
        XCTAssertEqual(unidade.networkEndpoint?.ipv4Address, "192.168.1.41")
        XCTAssertFalse(fixture.configuration.hasEphemeralProbeTarget)
    }

    /**
     A mesma queda, na rede: instalada pelo endereço digitado, o comando cru sai sem candidata.

     O caso Bluetooth mora na suíte de homologação; este existe porque o ramo Wi-Fi tem uma condição
     a mais, e ela precisa estar viva no teste — `adoptedProbeSender` da rede só devolve sender
     quando a rede atual é a mesma da instalação. É a `StubNetwork` desta fixture que casa as duas;
     com um provedor que devolvesse nada, o teste passaria a medir a fixture, e não o conserto.

     `adoptManualConfiguration` continua fora da queda, e é por isso que ele aparece aqui com a
     candidata em memória, instalando como sempre instalou: o comando cru é o gesto **seguinte**.
     */
    @MainActor
    func testOComandoCruSaiPelaImpressoraDeRedeInstaladaSemCandidataEmMemoria() async throws {
        let fixture = Fixture(network: StubNetwork(hostAddress: "192.168.1.10", prefixLength: 24))
        fixture.configuration.testManual(ipAddress: "192.168.1.41", portText: "9100")
        try await fixture.waitFor { fixture.configuration.localWifi.state == .awaitingConfirmation }
        let instalado = try fixture.configuration.adoptManualConfiguration(
            PrinterManualConfiguration.conservative(
                displayName: "Impressora do balcão",
                paperWidth: .mm80
            )
        )
        let enviados = fixture.wifi.sent.count

        XCTAssertFalse(fixture.configuration.hasEphemeralProbeTarget)
        XCTAssertTrue(fixture.configuration.canSendEphemeralCommand)

        var resultado: PrinterProbeSendResult?
        XCTAssertTrue(
            fixture.configuration.sendEphemeralCommand(Data([0x1b, 0x40]), fallingBackToAdopted: true) { resultado = $0 }
        )
        try await fixture.waitFor { resultado != nil }

        XCTAssertEqual(resultado, .success)
        XCTAssertEqual(fixture.wifi.sent.count, enviados + 1)
        XCTAssertEqual(fixture.wifi.sent.last, Data([0x1b, 0x40]))
        XCTAssertEqual(fixture.profiles.profiles(), [instalado], "Comando cru não grava perfil.")
        XCTAssertEqual(fixture.selections.read().selections.count, 1)
        XCTAssertFalse(fixture.configuration.hasEphemeralProbeTarget)
    }


    @MainActor
    func testSemCandidataEmMemoriaNadaEDeclaradoNemImpresso() {
        let fixture = Fixture()
        let configuracao = PrinterManualConfiguration.conservative(displayName: "Impressora")

        var resultado: PrinterProbeSendResult?
        XCTAssertFalse(
            fixture.configuration.sendManualConfigurationTestReceipt(configuracao) { resultado = $0 }
        )
        XCTAssertEqual(resultado, .failure(.rejected))
        XCTAssertThrowsError(try fixture.configuration.adoptManualConfiguration(configuracao)) {
            XCTAssertEqual($0 as? PrinterManualConfigurationError, .printerNotAvailable)
        }
        XCTAssertTrue(fixture.profiles.profiles().isEmpty)
    }

    // MARK: - Apoio

    private let identificador = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"

    private func XCTUnwrapped<T>(
        _ value: T?,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> T {
        guard let value else {
            XCTFail("Valor ausente.", file: file, line: line)
            fatalError("Valor ausente.")
        }
        return value
    }
}

@MainActor
private final class Fixture {
    let selections = MemorySelections()
    let profiles = PrinterProfileStore(dataStore: MemoryProfileData())
    let wifi = RecordingWifiTransport()
    let configuration: ThermalPrinterConfiguration

    enum Identity {
        case wifi
        case bluetooth
    }

    init(network: StubNetwork? = nil) {
        configuration = ThermalPrinterConfiguration(
            selectionStore: selections,
            profileStore: profiles,
            networkProvider: network ?? StubNetwork(hostAddress: nil, prefixLength: 24),
            localWifiTransport: wifi,
            bluetoothTransport: SilentBluetooth()
        )
    }

    /// Instala direto no store: a engrenagem edita o que já está guardado, e nenhuma parte disso
    /// depende de rádio.
    @discardableResult
    func instalarCatalogo(
        _ profile: PrinterProfile,
        identity: Identity
    ) -> PersistedPrinterSelection {
        let selection = selecao(profileId: profile.id, identity: identity)
        selections.save(selections.read().with(selection))
        return selection
    }

    @discardableResult
    func instalarMedida(
        displayName: String,
        transport: PrinterTransport,
        identity: Identity
    ) throws -> MeasuredProfile {
        let perfil = try PrinterManualConfiguration
            .conservative(displayName: displayName, paperWidth: .mm58)
            .profile(
                id: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
                transports: [transport.capabilityTransport],
                measuredAt: Date(timeIntervalSince1970: 1_000)
            )
        try profiles.save(perfil)
        selections.save(selections.read().with(selecao(profileId: perfil.id, identity: identity)))
        return perfil
    }

    /// Uma medição que já passou pela régua da sonda e pela tira de código nativo: é ela que a rota
    /// declarada apagava ao regravar.
    @discardableResult
    func instalarMedidaComReguaDaSonda(
        displayName: String,
        transport: PrinterTransport,
        identity: Identity
    ) throws -> MeasuredProfile {
        let perfil = try MeasuredProfile(
            id: UUID(uuidString: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e")!,
            displayName: displayName,
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [transport.capabilityTransport],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil,
            maxRasterBytesPerSecond: 4_096,
            verticalRasterScale: 0.8,
            nativeQrHonored: false,
            nativeBarcodeHonored: true
        )
        try profiles.save(perfil)
        selections.save(selections.read().with(selecao(profileId: perfil.id, identity: identity)))
        return perfil
    }

    func waitFor(
        _ condition: () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("A condição não aconteceu no prazo.", file: file, line: line)
    }

    private func selecao(profileId: String, identity: Identity) -> PersistedPrinterSelection {
        switch identity {
        case .wifi:
            return .localWifi(
                profileId: profileId,
                endpoint: PersistedNetworkEndpoint(ipv4Address: "192.168.0.87", port: 9_100)
            )
        case .bluetooth:
            return .bluetooth(
                profileId: profileId,
                peripheralIdentifier: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
            )
        }
    }
}

private final class MemorySelections: PrinterSelectionStoring {
    private var value = PersistedPrinterSelections()

    func read() -> PersistedPrinterSelections { value }
    func save(_ selections: PersistedPrinterSelections) { value = selections }
    func clear() { value = PersistedPrinterSelections() }
}

private final class MemoryProfileData: PrinterProfileDataStoring {
    private var data: Data?

    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}

private struct StubNetwork: LocalWifiPrinterNetworkProviding {
    let hostAddress: String?
    let prefixLength: Int

    func currentNetwork() -> LocalWifiPrinterNetwork? {
        guard let hostAddress else { return nil }
        return LocalWifiPrinterSubnet(hostAddress: hostAddress, prefixLength: prefixLength)
            .map(LocalWifiPrinterNetwork.init)
    }
}

/// Aceita o comprovante sem responder à varredura — o caso que a configuração manual existe para
/// resolver — e guarda o que saiu, para a suíte conferir o papel declarado.
private final class RecordingWifiTransport: LocalWifiPrinterTransport, @unchecked Sendable {
    private(set) var sent: [Data] = []

    func probe(_ endpoint: LocalWifiPrinterEndpoint) async -> Bool { false }
    func send(_ data: Data, to endpoint: LocalWifiPrinterEndpoint) async throws { sent.append(data) }
}

private final class SilentBluetooth: BluetoothPrinterTransporting {
    var onStateChange: ((BluetoothPrinterRadioState) -> Void)?
    var onCandidates: (([BluetoothPrinterCandidate]) -> Void)?

    func startScan() {}
    func stopScan() {}
    func disconnect() {}
    func send(
        _ payload: Data,
        to candidate: BluetoothPrinterCandidate,
        completion: @escaping (ThermalPrintResult) -> Void
    ) {
        completion(.failed(message: "Sem rádio nesta suíte.", delivery: .notSent))
    }
}
