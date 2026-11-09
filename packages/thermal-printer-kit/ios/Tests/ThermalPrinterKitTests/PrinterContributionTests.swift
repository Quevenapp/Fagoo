import Foundation
import XCTest
@testable import ThermalPrinterKit

final class PrinterContributionTests: XCTestCase {
    func testPacoteSegueContratoCrossPlatformComJSONEstavelELegivel() throws {
        let profile = try measuredProfile()

        let first = try PrinterContribution.package(
            for: profile,
            osVersion: "15.8.8",
            appVersion: "3.4.5"
        )
        let second = try PrinterContribution.package(
            for: profile,
            osVersion: "15.8.8",
            appVersion: "3.4.5"
        )
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: first) as? [String: Any]
        )
        let exported = try XCTUnwrap(root["profile"] as? [String: Any])

        XCTAssertEqual(first, second)
        XCTAssertTrue(try XCTUnwrap(String(data: first, encoding: .utf8)).contains("\n  \"kind\""))
        XCTAssertEqual(root["kind"] as? String, "printher.printer-contribution")
        XCTAssertEqual(root["version"] as? Int, 1)
        XCTAssertEqual(exported["displayName"] as? String, "T210 bancada")
        XCTAssertEqual(exported["firmwareVersion"] as? String, "SV3.2.2")
        XCTAssertEqual(exported["transports"] as? [String], ["BLUETOOTH_LE", "LOCAL_WIFI"])
        XCTAssertEqual(exported["paperWidthMm"] as? Int, 58)
        XCTAssertEqual(exported["printableColumns"] as? Int, 32)
        XCTAssertEqual(exported["printableDots"] as? Int, 384)
        XCTAssertEqual(exported["textEncoding"] as? String, "SINGLE_BYTE_CODE_PAGE")
        XCTAssertEqual(exported["codePage"] as? String, "CP860")
        XCTAssertEqual(exported["codePageSelector"] as? Int, 8)
        XCTAssertEqual(exported["cutProtocol"] as? String, "ESC_M")
        XCTAssertEqual(exported["cutModeHonored"] as? Bool, true)
        XCTAssertEqual(exported["cutFeedLines"] as? Int, 5)
        XCTAssertEqual(exported["dialect"] as? String, "EPSON_COMPATIBLE")
        XCTAssertEqual(exported["capabilityKey"] as? String, profile.capabilityKey.rawValue)
        XCTAssertEqual(exported["measuredAtEpochMillis"] as? Int64, 1_234_567_890_000)
        XCTAssertEqual(
            root["platform"] as? [String: String],
            ["os": "ios", "osVersion": "15.8.8", "appVersion": "3.4.5"]
        )
    }

    func testPacoteNuncaExportaIdentificadorTecnicoNemIDLocal() throws {
        let profile = try measuredProfile()
        let data = try PrinterContribution.package(
            for: profile,
            osVersion: "15.8.8",
            appVersion: "3.4.5"
        )
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))
        let forbidden = [
            "\"id\"", "profileId", "ipAddress", "address", "endpoint", "macAddress",
            "peripheralUUID", "serial", "vid", "pid", profile.id,
        ]

        for value in forbidden {
            XCTAssertFalse(text.localizedCaseInsensitiveContains(value), value)
        }
    }

    func testCamposOpcionaisNulosContinuamPresentesEUTF8UsaGrafiaAndroid() throws {
        let profile = try MeasuredProfile(
            displayName: "MTP-II",
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
        let data = try PrinterContribution.package(
            for: profile,
            osVersion: "15.8.8",
            appVersion: "3.4.5"
        )
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let exported = try XCTUnwrap(root["profile"] as? [String: Any])

        XCTAssertTrue(exported["firmwareVersion"] is NSNull)
        XCTAssertTrue(exported["codePage"] is NSNull)
        XCTAssertTrue(exported["codePageSelector"] is NSNull)
        XCTAssertEqual(exported["textEncoding"] as? String, "UTF8")
    }

    func testNomeDaPessoaViajaIntactoNoJSONUTF8() throws {
        // **A guarda ASCII deste escritor saiu em 30/08/2026**, e este teste é o que a impede de
        // voltar. Ela recusava "Impressora da José" porque perguntava a
        // `PrinterDeclaredIdentity.sanitizeField`, que é a régua da identidade que a FIRMWARE
        // declara no `GS I` — 64 bytes de ASCII imprimível, contra os 80 caracteres que
        // `MeasuredProfile` aceita. As quatro medições estão no KDoc de
        // `displayNameIsPackageable`. O pacote é UTF-8, e o golden do contrato compartilhado no
        // Android já provava isso com este mesmo nome.
        for nome in ["Impressora da José", "Cozinha do Balcão", "キッチン", "Кухня", "Ελληνικά"] {
            let profile = try MeasuredProfile(
                displayName: nome,
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

            let data = try PrinterContribution.package(
                for: profile,
                osVersion: "15.8.8",
                appVersion: "3.4.5"
            )

            // O JSON é bytes UTF-8, e o nome está lá com os mesmos escalares que a pessoa digitou.
            let exported = try XCTUnwrap(
                try XCTUnwrap(
                    try JSONSerialization.jsonObject(with: data) as? [String: Any]
                )["profile"] as? [String: Any]
            )
            XCTAssertEqual(exported["displayName"] as? String, nome)
            XCTAssertTrue(
                try XCTUnwrap(String(data: data, encoding: .utf8)).contains(nome),
                "O nome \(nome) tem de sair no pacote sem dobra nenhuma."
            )
        }
    }

    func testARegraDoNomeEADoPerfilMedidoENaoADaFirmware() throws {
        // O que sobrou da guarda: o que `MeasuredProfile.validateDisplayName` já exige — pontas sem
        // espaço (o que também recusa vazio e só-espaço), de 1 a 80 caracteres, e nada de controle.
        for nome in ["", "   ", " Cozinha ", "Cozinha\nBalcão", "Cozinha\u{0}Balcão",
                     String(repeating: "a", count: 81)] {
            XCTAssertFalse(
                PrinterContribution.displayNameIsPackageable(nome),
                "O nome [\(nome)] não pode virar pacote."
            )
        }
        // E a fronteira pelo outro lado, senão um mutante que recusasse tudo passaria. Note os 80:
        // com a régua da firmware, 65 bytes já morriam.
        for nome in [String(repeating: "a", count: 80), "キッチン", "Cozinha do Balcão",
                     "AÁ:BB:CC:DD:EE:FF", "Cozinha: Balcão"] {
            XCTAssertTrue(
                PrinterContribution.displayNameIsPackageable(nome),
                "O nome \(nome) tem de virar pacote."
            )
        }

        // **O teto é o do perfil, e não o do protocolo.** Se alguém trocar
        // `maxDisplayNameCharacters` pelo `maxFieldBytes` do `GS I`, este par denuncia.
        XCTAssertEqual(PrinterContribution.maxDisplayNameCharacters, 80)
        XCTAssertEqual(PrinterDeclaredIdentity.maxFieldBytes, 64)
    }

    func testOEscritorNuncaRecusaNomeQueOPerfilAceita() throws {
        // **O acordo, e é ele que faz o `guard` do escritor ser fronteira em vez de segunda regra.**
        // Hoje o `throw .invalidDisplayName` é inalcançável por perfil de verdade: todo caminho até
        // `MeasuredProfile` — inicializador, `validated` e o decodificador — aplica as mesmas três
        // condições. Se um dia as duas réguas divergirem, é aqui que se descobre, e não com o gesto
        // sumindo na cara de quem acabou de homologar.
        for nome in ["", "   ", " Cozinha ", "Cozinha\nBalcão", String(repeating: "a", count: 81),
                     String(repeating: "a", count: 80), "キッチン", "Cozinha do Balcão",
                     "AÁ:BB:CC:DD:EE:FF", "Cozinha: Balcão"] {
            let perfilNasceu = (try? MeasuredProfile(
                displayName: nome,
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
            )) != nil
            XCTAssertEqual(
                PrinterContribution.displayNameIsPackageable(nome),
                perfilNasceu,
                "O escritor e o perfil discordam sobre [\(nome)]."
            )
        }
    }

    func testAsVersoesDePlataformaContinuamExigindoASCII() throws {
        // A guarda saiu do `displayName` e **ficou** nos dois rótulos técnicos, onde ela está
        // certa: `osVersion` e `appVersion` são montados pelo hospedeiro a partir de números, não
        // digitados por ninguém. Sem este teste, "relaxar a guarda" viraria relaxá-la nos três.
        let profile = try measuredProfile()

        XCTAssertThrowsError(
            try PrinterContribution.package(for: profile, osVersion: "18.5 já", appVersion: "3.4.5")
        ) { erro in
            XCTAssertEqual(erro as? PrinterContributionError, .invalidPlatformVersion)
        }
        XCTAssertThrowsError(
            try PrinterContribution.package(for: profile, osVersion: "18.5", appVersion: "3.4.5-café")
        ) { erro in
            XCTAssertEqual(erro as? PrinterContributionError, .invalidPlatformVersion)
        }
        XCTAssertNoThrow(
            try PrinterContribution.package(for: profile, osVersion: "18.5", appVersion: "3.4.5")
        )
    }

    func testTipoDoPacoteEProprioNuncaPublicJson() {
        // Espelha o MIME do Android. O par é contrato entre dois apps: mudá-lo de um lado só
        // derruba o caminho em silêncio, porque o destino deixa de ser oferecido na folha.
        XCTAssertEqual(
            "br.com.pixelgoods.printher.printer-contribution",
            PrinterContribution.typeIdentifier
        )
    }

    private func measuredProfile() throws -> MeasuredProfile {
        try MeasuredProfile(
            id: UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!,
            displayName: "T210 bancada",
            measuredAt: Date(timeIntervalSince1970: 1_234_567_890),
            transports: [.localWifi, .bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: .cp860,
            codePageSelector: 8,
            cutProtocol: .escM,
            cutFeedLines: 5,
            tcpPort: 9_100,
            firmwareVersion: "SV3.2.2"
        )
    }
}
