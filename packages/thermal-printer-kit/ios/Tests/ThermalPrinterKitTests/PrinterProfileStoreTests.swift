import Foundation
import XCTest
@testable import ThermalPrinterKit

final class PrinterProfileStoreTests: XCTestCase {
    func testProfilesSurviveAStoreRestartWithoutUsingTheHostKeychain() throws {
        let backend = MemoryProfileDataStore()
        let firstStore = PrinterProfileStore(dataStore: backend)
        let profile = try measured()

        try firstStore.save(profile)
        let restarted = PrinterProfileStore(dataStore: backend)

        XCTAssertEqual(restarted.profiles(), [profile])
    }

    func testUTF8AtravessaCodableAllowlistEReaberturaDoStore() throws {
        let backend = MemoryProfileDataStore()
        let profile = try MeasuredProfile(
            displayName: "MTP-II de bancada",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .utf8,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )

        try PrinterProfileStore(dataStore: backend).save(profile)
        let restored = PrinterProfileStore(dataStore: backend).profiles().first

        XCTAssertEqual(restored, profile)
        XCTAssertEqual(restored?.textEncoding, .utf8)
    }

    func testEnderecoDaT210AtravessaCodableAllowlistEReaberturaDoStore() throws {
        let backend = MemoryProfileDataStore()
        let profile = try MeasuredProfile(
            displayName: "T210 de bancada",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: .cp860,
            textEncoding: .singleByteCodePage,
            codePageSelector: 8,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )

        try PrinterProfileStore(dataStore: backend).save(profile)
        let restored = PrinterProfileStore(dataStore: backend).profiles().first
        let root = try jsonObject(try XCTUnwrap(backend.data))
        let storedProfiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        let capabilities = try XCTUnwrap(storedProfiles.first?["capabilities"] as? [String: Any])

        XCTAssertEqual(restored, profile)
        XCTAssertEqual(restored?.codePageSelector, 8)
        XCTAssertEqual(capabilities["codePageSelector"] as? Int, 8)
    }

    /**
     O teto de vazão sobrevive ao disco, e só quando foi medido.

     É onde ele morreria em silêncio: campo novo que não atravessa o Codable faz o perfil relido
     diferir do salvo, e a sessão recusa a adoção com "persistenceFailed" — foi o que aconteceu com
     a T210 e o seletor de página, depois de 44 impressões. Aqui o preço de perder o campo é a foto
     voltar a encolher, sem erro em lugar nenhum.
     */
    func testTetoDeVazaoAtravessaCodableAllowlistEReaberturaDoStore() throws {
        let backend = MemoryProfileDataStore()
        let profile = try MeasuredProfile(
            displayName: "T210 de bancada",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil,
            maxRasterBytesPerSecond: 8_192
        )

        try PrinterProfileStore(dataStore: backend).save(profile)
        let restored = PrinterProfileStore(dataStore: backend).profiles().first
        let root = try jsonObject(try XCTUnwrap(backend.data))
        let storedProfiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        let capabilities = try XCTUnwrap(storedProfiles.first?["capabilities"] as? [String: Any])

        XCTAssertEqual(restored, profile)
        XCTAssertEqual(restored?.maxRasterBytesPerSecond, 8_192)
        XCTAssertEqual(capabilities["maxRasterBytesPerSecond"] as? Int, 8_192)
    }

    /// Perfil gravado antes do campo volta sem teto: aquele aparelho nunca mediu vazão, e o envio
    /// byte a byte é o que já saía no papel dele.
    func testRegistroLegadoSemTetoVoltaSemFreio() throws {
        var root = try jsonObject(try encodedEnvelope([measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        var capabilities = try XCTUnwrap(profiles[0]["capabilities"] as? [String: Any])
        capabilities.removeValue(forKey: "maxRasterBytesPerSecond")
        profiles[0]["capabilities"] = capabilities
        root["profiles"] = profiles
        let store = PrinterProfileStore(dataStore: MemoryProfileDataStore())

        try store.restoreStrictly(from: JSONSerialization.data(withJSONObject: root))

        XCTAssertNil(store.profiles().first?.maxRasterBytesPerSecond)
    }

    /**
     O fator de compensação sobrevive ao disco, e só quando foi medido.

     Mesma armadilha do teto: campo novo que não atravessa o Codable faz o perfil relido diferir do
     salvo, e a sessão recusa a adoção com "persistenceFailed". Aqui o preço de perder o campo é a
     foto voltar a sair 20% mais baixa na T210, sem erro em lugar nenhum.
     */
    func testFatorVerticalAtravessaCodableAllowlistEReaberturaDoStore() throws {
        let backend = MemoryProfileDataStore()
        let profile = try MeasuredProfile(
            displayName: "T210 de bancada",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil,
            verticalRasterScale: 0.8
        )

        try PrinterProfileStore(dataStore: backend).save(profile)
        let restored = PrinterProfileStore(dataStore: backend).profiles().first
        let root = try jsonObject(try XCTUnwrap(backend.data))
        let storedProfiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        let capabilities = try XCTUnwrap(storedProfiles.first?["capabilities"] as? [String: Any])

        XCTAssertEqual(restored, profile)
        XCTAssertEqual(restored?.verticalRasterScale, 0.8)
        XCTAssertEqual(capabilities["verticalRasterScale"] as? Double, 0.8)
    }

    /// Perfil gravado antes do campo volta sem compensação: aquela impressora nunca foi medida
    /// encolhendo, e o raster de sempre é o que já saía no papel dela.
    func testRegistroLegadoSemFatorVoltaSemCompensacao() throws {
        var root = try jsonObject(try encodedEnvelope([measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        var capabilities = try XCTUnwrap(profiles[0]["capabilities"] as? [String: Any])
        capabilities.removeValue(forKey: "verticalRasterScale")
        profiles[0]["capabilities"] = capabilities
        root["profiles"] = profiles
        let store = PrinterProfileStore(dataStore: MemoryProfileDataStore())

        try store.restoreStrictly(from: JSONSerialization.data(withJSONObject: root))

        XCTAssertNil(store.profiles().first?.verticalRasterScale)
    }

    /// As duas respostas da sonda de código nativo atravessam o `Codable` e a allowlist do store.
    ///
    /// **Este é o defeito que a frente veio fechar.** Campo medido fora do `CodingKeys` faz o perfil
    /// relido diferir do salvo, e a sessão recusa a adoção com "persistenceFailed" — depois da
    /// bobina gasta. E esquecer o nome na allowlist do store faz ele rejeitar o registro que acabou
    /// de gravar: foi o que perdeu a homologação da T210 depois de 44 impressões.
    ///
    /// `GS ( k` e `GS k` são comandos diferentes, e o par `(true, false)` é o caso que um campo só
    /// não saberia representar.
    func testRespostasDoCodigoNativoAtravessamCodableAllowlistEReaberturaDoStore() throws {
        for (qr, barras) in [(true, true), (true, false), (false, true), (false, false)] {
            let backend = MemoryProfileDataStore()
            let profile = try MeasuredProfile(
                displayName: "T210 de bancada",
                measuredAt: Date(timeIntervalSince1970: 1_000),
                transports: [.bluetoothLE],
                paperWidth: .mm58,
                printableColumns: 32,
                printableDots: 384,
                codePage: nil,
                textEncoding: .ascii,
                cutProtocol: .none,
                cutFeedLines: 0,
                tcpPort: nil,
                nativeQrHonored: qr,
                nativeBarcodeHonored: barras
            )

            try PrinterProfileStore(dataStore: backend).save(profile)
            let restored = PrinterProfileStore(dataStore: backend).profiles().first
            let root = try jsonObject(try XCTUnwrap(backend.data))
            let storedProfiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
            let capabilities = try XCTUnwrap(storedProfiles.first?["capabilities"] as? [String: Any])

            // Igualdade do perfil inteiro: é o que a sessão confere antes de trocar a seleção.
            XCTAssertEqual(restored, profile, "\(qr)/\(barras)")
            XCTAssertEqual(restored?.nativeQrHonored, qr)
            XCTAssertEqual(restored?.nativeBarcodeHonored, barras)
            XCTAssertEqual(capabilities["nativeQrHonored"] as? Bool, qr)
            XCTAssertEqual(capabilities["nativeBarcodeHonored"] as? Bool, barras)
        }
    }

    /// Perfil gravado antes da sonda volta com as duas ausentes, e ausente é um estado.
    ///
    /// `nil` não é "não" — é "ninguém perguntou" —, e é o que faz Ajustes mandar remedir em vez de
    /// afirmar que a firmware não entende o comando. É também o que mantém o cupom daquela
    /// impressora saindo exatamente como sai hoje: o padrão é rasterizado, e a trava exige `true`.
    func testRegistroLegadoSemAsRespostasVoltaSemMedicaoNenhuma() throws {
        var root = try jsonObject(try encodedEnvelope([measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        var capabilities = try XCTUnwrap(profiles[0]["capabilities"] as? [String: Any])
        capabilities.removeValue(forKey: "nativeQrHonored")
        capabilities.removeValue(forKey: "nativeBarcodeHonored")
        profiles[0]["capabilities"] = capabilities
        root["profiles"] = profiles
        let store = PrinterProfileStore(dataStore: MemoryProfileDataStore())

        try store.restoreStrictly(from: JSONSerialization.data(withJSONObject: root))

        XCTAssertNil(store.profiles().first?.nativeQrHonored)
        XCTAssertNil(store.profiles().first?.nativeBarcodeHonored)
    }

    /**
     A família de configuração de rede sobrevive ao disco, com a procedência intacta.

     As três asserções não são redundantes: a primeira pega o `Codable` incompleto, a segunda pega
     o campo trocado por outro, e a **terceira**, no JSON cru, é a única que pega a chave esquecida
     na allowlist do store — que não dá erro, apaga o registro inteiro na releitura seguinte.

     Store novo sobre o mesmo backend é o que reproduz reabrir o app.
     */
    func testFamiliaDeConfiguracaoAtravessaCodableAllowlistEReaberturaDoStore() throws {
        for familia in PrinterWifiConfigurationFamily.allCases {
            let backend = MemoryProfileDataStore()
            let profile = try measured().withWifiConfigurationFamily(familia)

            try PrinterProfileStore(dataStore: backend).save(profile)
            let restored = PrinterProfileStore(dataStore: backend).profiles().first
            let root = try jsonObject(try XCTUnwrap(backend.data))
            let storedProfiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
            let capabilities = try XCTUnwrap(storedProfiles.first?["capabilities"] as? [String: Any])

            XCTAssertEqual(restored, profile)
            XCTAssertEqual(restored?.wifiConfigurationFamily, familia)
            XCTAssertEqual(
                capabilities["wifiConfigurationFamily"] as? String,
                familia.rawValue,
                "a chave não chegou ao disco"
            )
        }
    }

    /**
     O caminho de restauração aceita a chave nova, e é o trajeto inteiro que ninguém percorria.

     `restoreStrictly` passa pela allowlist **antes** do `Codable` — chave nova ausente dali vira
     `fieldNotAllowed`, e `profiles()` engole esse erro apagando o disco. Este teste exporta pelo
     `encodedProfiles()` e restaura num store limpo, que é o trajeto real de migração e de
     restauração; os testes de campo medido que já existiam paravam antes dele.
     */
    func testAFamiliaGravadaAtravessaARestauracaoEstritaSemSerRecusada() throws {
        let origem = PrinterProfileStore(dataStore: MemoryProfileDataStore())
        let profile = try measured().withWifiConfigurationFamily(.chosenUsEscUs)
        try origem.save(profile)

        let destino = PrinterProfileStore(dataStore: MemoryProfileDataStore())
        try destino.restoreStrictly(from: try origem.encodedProfiles())

        XCTAssertEqual(destino.profiles(), [profile])
        XCTAssertEqual(destino.profiles().first?.wifiConfigurationFamily, .chosenUsEscUs)
    }

    /**
     Perfil gravado antes do campo volta com a pergunta em aberto.

     **`nil`, e não um padrão que pareça medição.** Aquela impressora nunca respondeu a tira, e
     qualquer família aqui mandaria o quadro de uma para uma impressora que pode ser da outra — a
     impressora errada não avisa, foi medido em 21/08.
     */
    func testRegistroLegadoSemFamiliaVoltaNaoDeterminado() throws {
        var root = try jsonObject(try encodedEnvelope([measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        var capabilities = try XCTUnwrap(profiles[0]["capabilities"] as? [String: Any])
        capabilities.removeValue(forKey: "wifiConfigurationFamily")
        profiles[0]["capabilities"] = capabilities
        root["profiles"] = profiles
        let store = PrinterProfileStore(dataStore: MemoryProfileDataStore())

        try store.restoreStrictly(from: JSONSerialization.data(withJSONObject: root))

        XCTAssertEqual(store.profiles().count, 1)
        XCTAssertNil(store.profiles().first?.wifiConfigurationFamily)
    }

    /// Gravar a resposta é read-modify-write, e devolve `false` sem inventar perfil quando não há
    /// um para escrever.
    ///
    /// A candidata retida em memória não tem perfil persistido, e a instalada pode nem ter sido
    /// resolvida para um. Criar o registro ali seria gravar uma impressora que ninguém homologou.
    func testGravarAFamiliaSemPerfilNaoInventaRegistro() throws {
        let store = PrinterProfileStore(dataStore: MemoryProfileDataStore())

        XCTAssertFalse(
            store.recordWifiConfigurationFamily(
                .measuredUsWHonored,
                forProfileId: UUID().uuidString.lowercased()
            )
        )
        XCTAssertTrue(store.profiles().isEmpty)
    }

    /// Gravar a resposta preserva o resto do perfil e confirma pela releitura.
    func testGravarAFamiliaPreservaOPerfilEConfirmaPelaReleitura() throws {
        let backend = MemoryProfileDataStore()
        let store = PrinterProfileStore(dataStore: backend)
        let profile = try measured()
        try store.save(profile)

        XCTAssertTrue(
            store.recordWifiConfigurationFamily(.measuredUsWAbsent, forProfileId: profile.id)
        )

        // Store novo sobre o mesmo backend: é o que acontece ao reabrir o app.
        let relido = try XCTUnwrap(PrinterProfileStore(dataStore: backend).profile(id: profile.id))
        XCTAssertEqual(relido.wifiConfigurationFamily, .measuredUsWAbsent)
        XCTAssertEqual(relido, try profile.withWifiConfigurationFamily(.measuredUsWAbsent))
        XCTAssertEqual(relido.measuredAt, profile.measuredAt)
    }

    func testRegistroLegadoSemModeloInferePaginaDeByteUnico() throws {
        var root = try jsonObject(try encodedEnvelope([measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        var capabilities = try XCTUnwrap(profiles[0]["capabilities"] as? [String: Any])
        capabilities.removeValue(forKey: "textEncoding")
        profiles[0]["capabilities"] = capabilities
        root["profiles"] = profiles
        let store = PrinterProfileStore(dataStore: MemoryProfileDataStore())

        try store.restoreStrictly(from: JSONSerialization.data(withJSONObject: root))

        XCTAssertEqual(store.profiles().first?.textEncoding, .singleByteCodePage)
    }

    func testFirmwareAtravessaCodableAllowlistEReaberturaDoStore() throws {
        let backend = MemoryProfileDataStore()
        let profile = try MeasuredProfile(
            displayName: "58E_BT",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.localWifi],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: 9_100,
            firmwareVersion: "SV3.2.2"
        )

        try PrinterProfileStore(dataStore: backend).save(profile)
        let restored = PrinterProfileStore(dataStore: backend).profiles().first

        XCTAssertEqual(restored, profile)
        XCTAssertEqual(restored?.firmwareVersion, "SV3.2.2")
    }

    func testCorruptionIsDiscardedOnRead() {
        let backend = MemoryProfileDataStore(data: Data("not-json".utf8))
        let store = PrinterProfileStore(dataStore: backend)

        XCTAssertEqual(store.profiles(), [])
        XCTAssertNil(backend.data)
    }

    func testDuplicateIDKeepsTheNewestMeasurement() throws {
        let backend = MemoryProfileDataStore()
        let store = PrinterProfileStore(dataStore: backend)
        let id = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let old = try measured(id: id, name: "Antiga", date: Date(timeIntervalSince1970: 1_000))
        let new = try measured(id: id, name: "Nova", date: Date(timeIntervalSince1970: 2_000))
        let envelope = try encodedEnvelope([old, new])

        try store.restoreStrictly(from: envelope)

        XCTAssertEqual(store.profiles(), [new])
    }

    func testEquivalentProfilesWithDifferentIDsAreNotDeduplicated() throws {
        let store = PrinterProfileStore(dataStore: MemoryProfileDataStore())
        let first = try measured(id: UUID(), name: "Primeira", date: Date(timeIntervalSince1970: 1_000))
        let second = try measured(id: UUID(), name: "Segunda", date: Date(timeIntervalSince1970: 2_000))

        try store.save(first)
        try store.save(second)

        XCTAssertEqual(store.profiles().count, 2)
        XCTAssertEqual(store.profiles().first, second)
        XCTAssertEqual(first.capabilityKey, second.capabilityKey)
    }

    func testStrictRestoreRejectsEndpointAndTechnicalIdentifiers() throws {
        let profile = try measured()
        for forbidden in ["ipAddress", "macAddress", "vid", "pid", "peripheralUUID", "endpoint"] {
            var root = try jsonObject(try encodedEnvelope([profile]))
            var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
            profiles[0][forbidden] = "nao-pode-ir-ao-disco"
            root["profiles"] = profiles
            let altered = try JSONSerialization.data(withJSONObject: root)

            XCTAssertThrowsError(
                try PrinterProfileStore(dataStore: MemoryProfileDataStore()).restoreStrictly(from: altered),
                "Campo deveria ser rejeitado: \(forbidden)"
            ) { error in
                XCTAssertEqual(error as? PrinterProfileStoreError, .fieldNotAllowed)
            }
        }
    }

    func testStrictRestoreRejectsBundledSource() throws {
        var root = try jsonObject(try encodedEnvelope([measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        profiles[0]["source"] = PrinterProfileSource.bundled.rawValue
        root["profiles"] = profiles

        XCTAssertThrowsError(
            try PrinterProfileStore(dataStore: MemoryProfileDataStore()).restoreStrictly(
                from: JSONSerialization.data(withJSONObject: root)
            )
        ) { error in
            XCTAssertEqual(error as? PrinterProfileValidationError, .invalidSource)
        }
    }

    func testLeituraDescartaOrigemDeCatalogoSemPerderMedicaoLocal() throws {
        let local = try measured(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            name: "Medição preservada"
        )
        var root = try jsonObject(try encodedEnvelope([local, try measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        profiles[1]["source"] = "CATALOG"
        // O registro remoto extinto sai do envelope, mas nunca às custas da medição feita no
        // aparelho: ela continua operacional e é regravada byte a byte pelo schema vigente.
        root["profiles"] = profiles
        let backend = MemoryProfileDataStore(
            data: try JSONSerialization.data(withJSONObject: root)
        )
        let store = PrinterProfileStore(dataStore: backend)

        XCTAssertEqual(store.profiles(), [local])
        let cleaned = try jsonObject(try XCTUnwrap(backend.data))
        let cleanedProfiles = try XCTUnwrap(cleaned["profiles"] as? [[String: Any]])
        XCTAssertEqual(cleanedProfiles.count, 1)
        XCTAssertEqual(cleanedProfiles.first?["id"] as? String, local.id)
        XCTAssertEqual(cleanedProfiles.first?["source"] as? String, "MEASURED")
    }

    func testFalhaAoLimparOrigemExtintaNaoEscondeMedicaoLocal() throws {
        let local = try measured(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            name: "Medição preservada"
        )
        var root = try jsonObject(try encodedEnvelope([local, try measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        profiles[1]["source"] = "CATALOG"
        root["profiles"] = profiles
        let backend = MemoryProfileDataStore(
            data: try JSONSerialization.data(withJSONObject: root)
        )
        backend.writeError = TestError.failed

        // A faxina pode ser repetida depois; perder acesso ao perfil medido por causa de uma
        // falha transitória de escrita seria pior que manter o envelope antigo por mais uma leitura.
        XCTAssertEqual(PrinterProfileStore(dataStore: backend).profiles(), [local])
        XCTAssertNotNil(backend.data)
    }

    func testStrictRestoreRejectsTechnicalIdentifierHiddenInDisplayName() throws {
        var root = try jsonObject(try encodedEnvelope([measured()]))
        var profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        profiles[0]["displayName"] = "Impressora 192.168.1.40"
        root["profiles"] = profiles

        XCTAssertThrowsError(
            try PrinterProfileStore(dataStore: MemoryProfileDataStore()).restoreStrictly(
                from: JSONSerialization.data(withJSONObject: root)
            )
        ) { error in
            XCTAssertEqual(error as? PrinterProfileValidationError, .invalidDisplayName)
        }
    }

    func testEncodedSchemaContainsOnlyTheAllowlistedProfileFields() throws {
        let backend = MemoryProfileDataStore()
        let store = PrinterProfileStore(dataStore: backend)
        try store.save(measured())
        let root = try jsonObject(try store.encodedProfiles())
        let profiles = try XCTUnwrap(root["profiles"] as? [[String: Any]])
        let profile = try XCTUnwrap(profiles.first)

        XCTAssertEqual(
            Set(profile.keys),
            ["id", "displayName", "measuredAt", "source", "capabilities"]
        )
        let capabilities = try XCTUnwrap(profile["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["textEncoding"] as? String, "SINGLE_BYTE_CODE_PAGE")
        XCTAssertFalse(capabilities.keys.contains("address"))
        XCTAssertFalse(capabilities.keys.contains("ipAddress"))
        XCTAssertFalse(capabilities.keys.contains("macAddress"))
        XCTAssertFalse(capabilities.keys.contains("vid"))
        XCTAssertFalse(capabilities.keys.contains("pid"))
        XCTAssertFalse(capabilities.keys.contains("peripheralUUID"))
    }

    func testProfileImportDoesNotDeleteLegacyWhenNeutralWriteFails() throws {
        let importer = RecordingLegacyProfileImporter(profiles: [try measured()])
        let backend = MemoryProfileDataStore()
        backend.writeError = TestError.failed

        XCTAssertThrowsError(
            try PrinterProfileImporter().migrate(
                from: importer,
                into: PrinterProfileStore(dataStore: backend)
            )
        )
        XCTAssertFalse(importer.didRemove)
    }

    func testProfileImportDeletesOnlyAfterNeutralStoreConfirms() throws {
        let profile = try measured()
        let importer = RecordingLegacyProfileImporter(profiles: [profile])
        let store = PrinterProfileStore(dataStore: MemoryProfileDataStore())

        XCTAssertEqual(try PrinterProfileImporter().migrate(from: importer, into: store), 1)
        XCTAssertEqual(store.profiles(), [profile])
        XCTAssertTrue(importer.didRemove)
        XCTAssertEqual(importer.events, ["read", "remove"])
    }

    func testSelectionImportDoesNotDeleteWhenSaveCannotBeConfirmed() throws {
        let importer = RecordingLegacySelectionImporter(
            selections: PersistedPrinterSelections().with(.localWifi(profileId: "perfil"))
        )
        let store = IgnoringSelectionStore()

        XCTAssertThrowsError(try PrinterSelectionImporter().migrate(from: importer, into: store)) { error in
            XCTAssertEqual(error as? PrinterSelectionImportError, .selectionWasNotConfirmed)
        }
        XCTAssertFalse(importer.didRemove)
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

    private func encodedEnvelope(_ profiles: [MeasuredProfile]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return try encoder.encode(TestEnvelope(version: 1, profiles: profiles))
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private struct TestEnvelope: Encodable {
    let version: Int
    let profiles: [MeasuredProfile]
}

private enum TestError: Error { case failed }

private final class MemoryProfileDataStore: PrinterProfileDataStoring {
    var data: Data?
    var writeError: Error?

    init(data: Data? = nil) { self.data = data }

    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws {
        if let writeError { throw writeError }
        self.data = data
    }
}

private final class RecordingLegacyProfileImporter: LegacyPrinterProfileImporting {
    let profiles: [MeasuredProfile]
    var events: [String] = []
    var didRemove = false

    init(profiles: [MeasuredProfile]) { self.profiles = profiles }

    func readLegacyPrinterProfiles() throws -> [MeasuredProfile] {
        events.append("read")
        return profiles
    }

    func removeLegacyPrinterProfilesAfterConfirmedImport() throws {
        events.append("remove")
        didRemove = true
    }
}

private final class RecordingLegacySelectionImporter: LegacyPrinterSelectionImporting {
    let selections: PersistedPrinterSelections
    var didRemove = false

    init(selections: PersistedPrinterSelections) { self.selections = selections }
    func readLegacyPrinterSelections() throws -> PersistedPrinterSelections? { selections }
    func removeLegacyPrinterSelectionsAfterConfirmedImport() throws { didRemove = true }
}

private final class IgnoringSelectionStore: PrinterSelectionStoring {
    func read() -> PersistedPrinterSelections { PersistedPrinterSelections() }
    func save(_ selections: PersistedPrinterSelections) {}
    func clear() {}
}
