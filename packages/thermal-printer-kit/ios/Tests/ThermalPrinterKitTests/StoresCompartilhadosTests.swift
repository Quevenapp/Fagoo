import Foundation
import Security
import XCTest
@testable import ThermalPrinterKit

/**
 App e extensão precisam enxergar a mesma impressora adotada e os mesmos perfis.

 O que estes testes protegem é o **endereçamento**: o item do chaveiro é achado pela query inteira
 e o perfil pela dupla suíte/chave. Uma query que esqueça o grupo de acesso, ou um inicializador
 que caia no `.standard` quando a suíte não abre, não devolve erro nenhum — devolve "nenhuma
 impressora adotada" para quem acabou de adotar uma. O defeito só apareceria no papel.
 */
final class StoresCompartilhadosTests: XCTestCase {
    // MARK: - Seleção no chaveiro

    /// Dois stores no mesmo grupo são o mesmo item: um grava, o outro lê.
    func testDoisStoresNoMesmoGrupoDeAcessoLeemAMesmaSelecao() {
        let chaveiro = ChaveiroSimulado()
        let app = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(accessGroup: grupo, backend: chaveiro)
        )
        let extensao = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(accessGroup: grupo, backend: chaveiro)
        )

        app.save(PersistedPrinterSelections().with(.bluetooth(profileId: perfil)))

        XCTAssertEqual(extensao.read().activeSelection, .bluetooth(profileId: perfil))
        XCTAssertEqual(extensao.read().active, .bluetooth)
    }

    /// E o inverso, que é o caso de uso: a extensão adota, o app reabre e encontra.
    func testOQueAExtensaoGravaOAppEnxergaEOQueUmApagaSomeNoOutro() {
        let chaveiro = ChaveiroSimulado()
        let app = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(accessGroup: grupo, backend: chaveiro)
        )
        let extensao = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(accessGroup: grupo, backend: chaveiro)
        )

        extensao.save(PersistedPrinterSelections().with(.localWifi(profileId: perfil)))
        XCTAssertEqual(app.read().activeSelection, .localWifi(profileId: perfil))

        app.clear()
        XCTAssertNil(extensao.read().activeSelection)
    }

    /**
     Grupo diferente é item diferente, e nenhum grupo é um terceiro item.

     Esta é a asserção que prova que o grupo entra em toda query: se `read` ou `clear` esquecesse
     dele, o store sem grupo enxergaria o que o store com grupo gravou.
     */
    func testGrupoDiferenteEItemDiferenteESemGrupoNaoEnxergaNadaDoGrupo() {
        let chaveiro = ChaveiroSimulado()
        let comGrupo = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(accessGroup: grupo, backend: chaveiro)
        )
        let outroGrupo = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(accessGroup: "grupo.de.outro.app", backend: chaveiro)
        )
        let semGrupo = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(backend: chaveiro)
        )

        comGrupo.save(PersistedPrinterSelections().with(.bluetooth(profileId: perfil)))

        XCTAssertNil(outroGrupo.read().activeSelection)
        XCTAssertNil(semGrupo.read().activeSelection)
        XCTAssertEqual(comGrupo.read().activeSelection, .bluetooth(profileId: perfil))
    }

    /// Default `nil`: a query é a de sempre, sem a chave do grupo. Passar `nil` para
    /// `kSecAttrAccessGroup` não é o mesmo que não passar — seria uma query inválida no aparelho.
    func testSemGrupoNenhumaQueryCarregaAChaveDoGrupoDeAcesso() {
        let chaveiro = ChaveiroSimulado()
        let store = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(backend: chaveiro)
        )

        store.save(PersistedPrinterSelections().with(.bluetooth(profileId: perfil)))
        _ = store.read()
        store.clear()

        XCTAssertFalse(chaveiro.queries.isEmpty)
        for query in chaveiro.queries {
            XCTAssertNil(query[kSecAttrAccessGroup as String])
            XCTAssertEqual(query[kSecAttrAccount as String] as? String, "printer-selections-v1")
        }
    }

    /// Com grupo, **todas** elas carregam. É uma asserção sobre o conjunto, não sobre a primeira:
    /// um `clear` sem grupo apagaria o item do processo e deixaria o compartilhado vivo.
    func testComGrupoTodaQueryCarregaOGrupo() {
        let chaveiro = ChaveiroSimulado()
        let store = KeychainPrinterSelectionStore(
            keychain: ThermalPrinterKeychain(accessGroup: grupo, backend: chaveiro)
        )

        store.save(PersistedPrinterSelections().with(.bluetooth(profileId: perfil)))
        _ = store.read()
        store.clear()

        XCTAssertFalse(chaveiro.queries.isEmpty)
        for query in chaveiro.queries {
            XCTAssertEqual(query[kSecAttrAccessGroup as String] as? String, grupo)
        }
    }

    // MARK: - Perfis na suíte

    /// Dois data stores na mesma suíte são o mesmo registro: um grava o perfil, o outro o lê.
    func testDoisStoresNaMesmaSuiteLeemOsMesmosPerfis() throws {
        let suite = try XCTUnwrap(UserDefaults(suiteName: nomeDaSuite))
        defer { suite.removePersistentDomain(forName: nomeDaSuite) }

        let doApp = try XCTUnwrap(UserDefaultsPrinterProfileDataStore(suiteName: nomeDaSuite))
        let daExtensao = try XCTUnwrap(UserDefaultsPrinterProfileDataStore(suiteName: nomeDaSuite))
        let perfil = try perfilMedido()

        try PrinterProfileStore(dataStore: doApp).save(perfil)

        let lidos = PrinterProfileStore(dataStore: daExtensao).profiles()
        XCTAssertEqual(lidos, [perfil])
        XCTAssertEqual(lidos.first?.capabilities.printableDots, 384)
    }

    /// Suíte que o sistema recusa devolve `nil` em vez de virar `.standard`: se caísse, a extensão
    /// gravaria perfil no container dela e o app leria o dele, sem erro em lugar nenhum.
    func testSuiteRecusadaNaoViraStandardEmSilencio() {
        XCTAssertNil(UserDefaultsPrinterProfileDataStore(suiteName: UserDefaults.globalDomain))
    }

    /// Default continua no `.standard` e sob a mesma chave de sempre.
    func testDefaultContinuaGravandoNoStandardSobAChaveHistorica() throws {
        let chave = UserDefaultsPrinterProfileDataStore.defaultKey
        defer { UserDefaults.standard.removeObject(forKey: chave) }
        XCTAssertEqual(chave, "thermal-printer-measured-profiles-v1")

        try PrinterProfileStore(dataStore: UserDefaultsPrinterProfileDataStore())
            .save(try perfilMedido())

        XCTAssertNotNil(UserDefaults.standard.data(forKey: chave))
    }

    // MARK: - Apoio

    private let grupo = "grupo.de.acesso.simulado"
    private let perfil = "generic.portable58.escpos"
    private let nomeDaSuite = "br.com.thermalprinterkit.testes.suite-compartilhada"

    private func perfilMedido() throws -> MeasuredProfile {
        try MeasuredProfile(
            id: UUID(),
            displayName: "Impressora medida",
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )
    }
}

/**
 Chaveiro em memória endereçado pela query inteira — serviço, conta **e** grupo de acesso.

 É essa chave composta que dá o teste: a dublê não tem como "quase achar" o item, do mesmo jeito
 que o chaveiro do sistema não tem. Ela também guarda toda query recebida, para as asserções sobre
 a forma do que sai daqui para o `SecItem`.
 */
private final class ChaveiroSimulado: ThermalPrinterKeychainBackend {
    private(set) var queries: [[String: Any]] = []
    private var itens: [Endereco: Data] = [:]

    struct Endereco: Hashable {
        let service: String?
        let account: String?
        let accessGroup: String?
    }

    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, data: Data?) {
        queries.append(query)
        guard let data = itens[endereco(query)] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, data)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        queries.append(query)
        let endereco = endereco(query)
        guard itens[endereco] != nil else { return errSecItemNotFound }
        itens[endereco] = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func add(_ item: [String: Any]) -> OSStatus {
        queries.append(item)
        let endereco = endereco(item)
        guard itens[endereco] == nil else { return errSecDuplicateItem }
        itens[endereco] = item[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        queries.append(query)
        guard itens.removeValue(forKey: endereco(query)) != nil else { return errSecItemNotFound }
        return errSecSuccess
    }

    private func endereco(_ query: [String: Any]) -> Endereco {
        Endereco(
            service: query[kSecAttrService as String] as? String,
            account: query[kSecAttrAccount as String] as? String,
            accessGroup: query[kSecAttrAccessGroup as String] as? String
        )
    }
}
