import XCTest
@testable import ThermalPrinterKit

final class PrinterProfileTests: XCTestCase {
    func testTodoCardDeCatalogoOfereceOsQuatroTransportes() {
        let expected = Set(PrinterCapabilityTransport.allCases)
        for profile in BundledPrinterProfiles.all {
            XCTAssertEqual(profile.transports, expected, profile.displayName)
        }
    }

    func testCapabilityKeyMatchesTheCrossPlatformVector() throws {
        // Os pinos v1 `07d245a1…` (Android) e `36cdbe79…` (iOS) mudam conscientemente: a chave v2
        // inclui o modelo de codificação, pois UTF-8 e página emitem bytes diferentes no fio.
        let vector = try PrinterCapabilities(
            transports: [.localWifi, .usb],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: .cp850,
            cutProtocol: .gsV1,
            cutFeedLines: 5,
            statusProtocol: .dleEot,
            tcpPort: 9_100
        )
        XCTAssertEqual(
            vector.capabilityKey.rawValue,
            "28b8b8523fc0456e2cad4e8861a97b2d7bb8fb606bf75eaaef31e4d72a9cdd52"
        )
        XCTAssertEqual(BundledPrinterProfiles.elginI9Full2.capabilityKey.rawValue,
                       "442d145253c1699e09b0e3094321ca9a4737ba2f0ee9dd799787771d136fadd5")
    }

    func testCapabilityKeyExcludesIdentityNameDateAndSource() throws {
        let first = try measured(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            name: "Modelo A",
            date: Date(timeIntervalSince1970: 1_000)
        )
        let second = try measured(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!,
            name: "Outra marca e modelo",
            date: Date(timeIntervalSince1970: 2_000)
        )
        let secondWithFirmware = try MeasuredProfile.validated(
            id: second.id,
            displayName: second.displayName,
            measuredAt: second.measuredAt,
            source: second.source,
            capabilities: second.capabilities,
            firmwareVersion: "SV3.2.2"
        )

        XCTAssertEqual(first.capabilityKey, second.capabilityKey)
        XCTAssertEqual(second.capabilityKey, secondWithFirmware.capabilityKey)
        XCTAssertFalse(first.capabilityKey.rawValue.contains(first.id))
        XCTAssertFalse(first.capabilityKey.rawValue.contains(first.displayName))
        XCTAssertEqual(first.capabilityKey.rawValue.count, 64)
    }

    func testModeloDeCodificacaoEntraNaChavePorqueMudaOsBytes() throws {
        let ascii = try PrinterCapabilities(
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: nil
        )
        let utf8 = try PrinterCapabilities(
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .utf8,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: nil
        )

        XCTAssertNotEqual(ascii.capabilityKey, utf8.capabilityKey)
    }

    func testMeasuredProfileRequiresLocalUUIDAndStatusNone() throws {
        let profile = try measured()

        XCTAssertNotNil(UUID(uuidString: profile.id))
        XCTAssertEqual(profile.source, .measured)
        XCTAssertEqual(profile.statusProtocol, .none)
        XCTAssertGreaterThan(profile.measuredAtEpochMillis, 0)
    }

    func testDisplayNameRejectsEndpointAndTechnicalIdentifiers() {
        let unsafeNames = [
            "Impressora 192.168.1.40",
            "Impressora AA:BB:CC:DD:EE:FF",
            "Impressora VID 1234",
            "Modelo PID 5678",
            "Peripheral 123",
            "550e8400-e29b-41d4-a716-446655440000",
        ]

        for unsafeName in unsafeNames {
            XCTAssertThrowsError(try measured(name: unsafeName), unsafeName) { error in
                XCTAssertEqual(error as? PrinterProfileValidationError, .invalidDisplayName)
            }
        }
        XCTAssertNoThrow(try measured(name: "Elgin i9FULL 2"))
    }

    func testGeometryAcceptsOnlyThePrintedRasterCandidates() {
        XCTAssertNoThrow(try capabilities(paper: .mm58, dots: 256))
        XCTAssertNoThrow(try capabilities(paper: .mm80, dots: 640))
        XCTAssertThrowsError(try capabilities(paper: .mm58, dots: 352)) { error in
            XCTAssertEqual(error as? PrinterProfileValidationError, .invalidGeometry)
        }
        XCTAssertThrowsError(try capabilities(paper: .mm80, dots: 320)) { error in
            XCTAssertEqual(error as? PrinterProfileValidationError, .invalidGeometry)
        }
    }

    func testQRWidthUsesColumnsDotsAndThe160DotSafetyFloor() throws {
        XCTAssertNil(PrinterCapabilities.safeQRWidth(printableColumns: 13, printableDots: 384))
        XCTAssertEqual(
            PrinterCapabilities.safeQRWidth(printableColumns: 14, printableDots: 384),
            168
        )
        XCTAssertEqual(try capabilities(paper: .mm58, dots: 256).qrWidthDots, 256)
        XCTAssertEqual(BundledPrinterProfiles.elginI9Full2.capabilities.qrWidthDots, 320)
    }

    func testResolverUsesIDThenCapabilityThenBundledThenTemporary() throws {
        let older = try measured(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            name: "Medição por ID",
            date: Date(timeIntervalSince1970: 1_000)
        )
        let newer = try measured(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!,
            name: "Medição equivalente recente",
            date: Date(timeIntervalSince1970: 2_000)
        )
        let resolver = PrinterProfileResolver(measured: [older, newer])

        XCTAssertEqual(
            resolver.resolve(
                profileId: older.id,
                capabilityKey: newer.capabilityKey,
                transport: .localWifi
            ).id,
            older.id
        )
        XCTAssertEqual(
            resolver.resolve(
                profileId: "ausente",
                capabilityKey: older.capabilityKey,
                transport: .localWifi
            ).id,
            newer.id
        )
        XCTAssertEqual(
            PrinterProfileResolver(measured: []).resolve(
                profileId: BundledPrinterProfiles.elginI9Full2.id,
                transport: .localWifi
            ).source,
            .bundled
        )

        let temporary = PrinterProfileResolver(measured: []).resolve(
            profileId: "desconhecido",
            transport: .bluetooth
        )
        XCTAssertEqual(temporary.source, .temporary)
        XCTAssertFalse(temporary.isPersistent)
        XCTAssertNil(temporary.codePage)
        XCTAssertEqual(temporary.cutProtocol, .none)
        XCTAssertEqual(temporary.statusProtocol, .none)
        XCTAssertNotNil(temporary.warning)
    }

    private func measured(
        id: UUID = UUID(),
        name: String = "Impressora medida",
        date: Date = Date(timeIntervalSince1970: 1_000)
    ) throws -> MeasuredProfile {
        try MeasuredProfile(
            id: id,
            displayName: name,
            measuredAt: date,
            transports: [.localWifi, .usb],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: .cp850,
            cutProtocol: .gsV1,
            cutFeedLines: 5,
            tcpPort: 9_100
        )
    }

    func testEnderecoMedidoDaPaginaFicaForaDaChaveDeCapacidade() throws {
        // A T210 atende a CP860 em `ESC t 8`, não no 3 canônico. Duas impressoras que produzem o
        // mesmo papel continuam equivalentes ainda que cheguem à página por `n` diferente.
        let canonico = try paginaCP860(seletor: nil)
        let medidoNaT210 = try paginaCP860(seletor: 8)

        XCTAssertEqual(canonico.capabilityKey, medidoNaT210.capabilityKey)
        XCTAssertEqual(medidoNaT210.codePageSelector, 8)
        XCTAssertNil(canonico.codePageSelector)
    }

    /// Duas medições que só diferem no teto continuam sendo a mesma capacidade: os bytes emitidos
    /// são idênticos, muda só o ritmo com que saem do rádio. Pô-lo na chave mudaria a chave de todo
    /// perfil já medido para distinguir papéis iguais.
    func testTetoDeVazaoFicaForaDaChaveDeCapacidade() throws {
        let semTeto = try capabilities(paper: .mm58, dots: 384)
        let comTeto = try PrinterCapabilities(
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: nil,
            maxRasterBytesPerSecond: 8_192
        )

        XCTAssertEqual(semTeto.capabilityKey, comTeto.capabilityKey)
        XCTAssertEqual(comTeto.maxRasterBytesPerSecond, 8_192)
        XCTAssertNil(semTeto.maxRasterBytesPerSecond)
    }

    /// Perfil com dado suposto é pior que perfil nenhum: teto impossível é recusado, não corrigido.
    func testTetoDeVazaoForaDaFaixaERecusado() {
        for teto in [0, -1, PrinterCapabilities.allowedRasterBytesPerSecond.upperBound + 1] {
            XCTAssertThrowsError(
                try PrinterCapabilities(
                    transports: [.bluetoothLE],
                    paperWidth: .mm58,
                    printableColumns: 32,
                    printableDots: 384,
                    codePage: nil,
                    cutProtocol: .none,
                    cutFeedLines: 0,
                    statusProtocol: .none,
                    tcpPort: nil,
                    maxRasterBytesPerSecond: teto
                )
            ) { error in
                XCTAssertEqual(error as? PrinterProfileValidationError, .invalidRasterThroughput)
            }
        }
    }

    /**
     Duas medições que só diferem no fator **não** são a mesma capacidade.

     Este é o oposto do teto de vazão, e de propósito: o fator muda os bytes emitidos — a mesma foto
     vira 1,25x mais linhas com 0,80 —, então dois perfis que diferem nele produzem cupons
     diferentes. Casá-los pelo catálogo devolveria a foto encolhida por outro caminho.

     E a chave de quem **não** tem fator não se move: o campo só entra na string canônica quando
     existe, para nenhuma medição já feita mudar de identidade. O Android fixa a mesma regra.
     */
    func testFatorVerticalEntraNaChaveDeCapacidade() throws {
        let semFator = try capabilities(paper: .mm58, dots: 384)
        func comFator(_ escala: Double) throws -> PrinterCapabilities {
            try PrinterCapabilities(
                transports: [.bluetoothLE],
                paperWidth: .mm58,
                printableColumns: 32,
                printableDots: 384,
                codePage: nil,
                cutProtocol: .none,
                cutFeedLines: 0,
                statusProtocol: .none,
                tcpPort: nil,
                verticalRasterScale: escala
            )
        }

        XCTAssertNotEqual(semFator.capabilityKey, try comFator(0.8).capabilityKey)
        XCTAssertNotEqual(try comFator(0.8).capabilityKey, try comFator(0.75).capabilityKey)
        XCTAssertEqual(try comFator(0.8).capabilityKey, try comFator(0.8).capabilityKey)
        XCTAssertNil(semFator.verticalRasterScale)
    }

    /// Perfil com dado suposto é pior que perfil nenhum: fator impossível é recusado, não corrigido.
    func testFatorVerticalForaDaFaixaERecusado() {
        for fator in [0.0, 0.49, 1.01, -0.8] {
            XCTAssertThrowsError(
                try PrinterCapabilities(
                    transports: [.bluetoothLE],
                    paperWidth: .mm58,
                    printableColumns: 32,
                    printableDots: 384,
                    codePage: nil,
                    cutProtocol: .none,
                    cutFeedLines: 0,
                    statusProtocol: .none,
                    tcpPort: nil,
                    verticalRasterScale: fator
                )
            ) { error in
                XCTAssertEqual(error as? PrinterProfileValidationError, .invalidVerticalRasterScale)
            }
        }
    }

    func testEnderecoMedidoChegaAoPapelNoLugarDoCanonico() throws {
        let medido = EscPos.text("a", alignment: 0, bold: false, size: 0, codePage: .cp860, codePageSelector: 8)
        let padrao = EscPos.text("a", alignment: 0, bold: false, size: 0, codePage: .cp860)

        XCTAssertEqual(Array(medido.prefix(3)), [0x1b, 0x74, 0x08])
        XCTAssertEqual(Array(padrao.prefix(3)), [0x1b, 0x74, ThermalCodePage.cp860.rawValue])
    }

    private func paginaCP860(seletor: UInt8?) throws -> PrinterCapabilities {
        try PrinterCapabilities(
            transports: [.bluetooth],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: .cp860,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: nil,
            codePageSelector: seletor
        )
    }

    func testPerfilSobreviveAoCodableComSeletorEModoMedidos() throws {
        // A sessão só adota se o perfil relido for igual ao salvo. Campo novo fora do Codable faz
        // os dois diferirem em silêncio: foi o que perdeu a homologação da T210, com 44
        // impressões gastas e "o perfil não pôde ser salvo" no fim.
        let capacidades = try PrinterCapabilities(
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: .cp860,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: nil,
            codePageSelector: 8,
            cutModeHonored: false
        )

        let ida = try JSONEncoder().encode(capacidades)
        let volta = try JSONDecoder().decode(PrinterCapabilities.self, from: ida)

        XCTAssertEqual(volta, capacidades)
        XCTAssertEqual(volta.codePageSelector, 8)
        XCTAssertFalse(volta.cutModeHonored)
    }

    /**
     A família de configuração de rede atravessa o `Codable` de ida e volta, com a procedência
     intacta.

     Mesma armadilha do seletor de página: campo novo que não atravessa o `Codable` faz o perfil
     relido diferir do salvo, e a sessão recusa a adoção com "persistenceFailed". Aqui o preço de
     perder o campo é a tira de identificação sair de novo em toda abertura da tela — papel gasto
     por uma pergunta já respondida.

     Este teste falha mais perto da causa que o do store: sem passar pelo disco, ele isola o
     `CodingKeys` da allowlist.
     */
    func testFamiliaDeConfiguracaoAtravessaOCodableComAProcedencia() throws {
        for familia in PrinterWifiConfigurationFamily.allCases {
            let capacidades = try PrinterCapabilities(
                transports: [.localWifi],
                paperWidth: .mm58,
                printableColumns: 32,
                printableDots: 384,
                codePage: nil,
                cutProtocol: .none,
                cutFeedLines: 0,
                statusProtocol: .none,
                tcpPort: 9_100,
                wifiConfigurationFamily: familia
            )

            let ida = try JSONEncoder().encode(capacidades)
            let volta = try JSONDecoder().decode(PrinterCapabilities.self, from: ida)

            XCTAssertEqual(volta, capacidades)
            XCTAssertEqual(volta.wifiConfigurationFamily, familia)
            // A procedência é o motivo de o campo existir; se só a família voltasse, uma sessão
            // futura leria declaração como medição.
            XCTAssertEqual(volta.wifiConfigurationFamily?.wasMeasured, familia.wasMeasured)
        }
    }

    /**
     Duas medições que só diferem na família de configuração continuam sendo a mesma capacidade.

     Ela não muda um byte de cupom: decide qual quadro a tela de configuração monta, e quadro de
     configuração não é cupom. Pô-la na chave desassociaria todo perfil já medido e já contribuído
     para distinguir papéis idênticos — é a mesma régua que mantém `cutModeHonored` fora.
     */
    func testFamiliaDeConfiguracaoFicaForaDaChaveDeCapacidades() throws {
        let semFamilia = try PrinterCapabilities(
            transports: [.localWifi],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: 9_100
        )

        for familia in PrinterWifiConfigurationFamily.allCases {
            XCTAssertEqual(
                semFamilia.capabilityKey,
                semFamilia.withWifiConfigurationFamily(familia).capabilityKey,
                "\(familia) moveu a chave de capacidades"
            )
        }
    }

    /**
     Gravar a família preserva todo o resto da medição.

     A tela de rede não mediu geometria, página nem corte; ela responde uma pergunta só. Um caminho
     de escrita que reconstruísse o perfil apagaria em silêncio o que ela não conhece — que é o
     defeito que a edição manual ainda tem hoje com o fator de compensação.
     */
    func testGravarAFamiliaPreservaORestoDaMedicao() throws {
        let medido = try MeasuredProfile(
            id: UUID(uuidString: "00000000-0000-4000-8000-0000000000aa")!,
            displayName: "T210 de bancada",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.localWifi],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: .cp860,
            textEncoding: .singleByteCodePage,
            codePageSelector: 8,
            cutProtocol: .none,
            cutModeHonored: false,
            cutFeedLines: 0,
            tcpPort: 9_100,
            verticalRasterScale: 0.8,
            firmwareVersion: "SV3.2.2"
        )

        let comFamilia = try medido.withWifiConfigurationFamily(.measuredUsWHonored)

        XCTAssertEqual(comFamilia.wifiConfigurationFamily, .measuredUsWHonored)
        XCTAssertEqual(comFamilia.codePageSelector, 8)
        XCTAssertFalse(comFamilia.cutModeHonored)
        XCTAssertEqual(comFamilia.verticalRasterScale, 0.8)
        XCTAssertEqual(comFamilia.firmwareVersion, "SV3.2.2")
        // A data não anda: nada foi remedido no papel, e mexer nela reordenaria a lista de perfis
        // por causa de uma resposta de tela.
        XCTAssertEqual(comFamilia.measuredAt, medido.measuredAt)
        XCTAssertEqual(comFamilia.id, medido.id)
    }

    private func capabilities(
        paper: PrinterPaperWidth,
        dots: Int
    ) throws -> PrinterCapabilities {
        try PrinterCapabilities(
            transports: [.bluetoothLE],
            paperWidth: paper,
            printableColumns: paper.defaultPrintableColumns,
            printableDots: dots,
            codePage: nil,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: nil
        )
    }

}
