import CryptoKit
import Foundation

/// Impressora já confirmada neste aparelho. Espelha o `PersistedPrinterSelection` do Android:
/// uma **instalação** — perfil mais o destino técnico — e nunca cupom, assinatura ou QR.
///
/// Além do perfil, a seleção guarda a **identidade física** da unidade escolhida: o `identifier`
/// que o CoreBluetooth dá ao periférico, ou o endpoint `host:porta` da impressora de rede. Nenhum
/// dos dois é o MAC do rádio; os dois moram só dentro do store cifrado e nunca aparecem em log,
/// erro ou `description`.
///
/// Guardar só o perfil já foi decisão explícita aqui, e o papel a desmentiu em 20/08: com a T210
/// adotada e dormindo, o cupom saiu na GoldenSky MTP-II — que nem instalada estava — porque a
/// retomada adotava a única que respondesse. Perfil diz *como* imprimir; identidade diz *em qual*.
///
/// O Wi-Fi tinha o mesmo defeito, e por muito tempo teve uma justificativa escrita aqui: "o Wi-Fi
/// não guarda identidade nenhuma; aceitar o campo dele seria abrir uma porta lateral para endereço
/// entrar no formato neutro". A porta lateral é real, mas a conclusão estava trocada — o endpoint
/// não entra no **perfil**, entra na instalação cifrada, que é exatamente onde o `AGENTS.md` manda
/// guardar "endpoint de rede, endereço Bluetooth ou VID/PID/serial". Sem ele, `beginSearch` adotava
/// a única que respondesse à varredura, que é o mesmo cupom na impressora errada com outro
/// transporte.
public enum PersistedPrinterSelection: Codable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    case localWifi(profileId: String, endpoint: PersistedNetworkEndpoint?)
    case bluetooth(profileId: String, peripheralIdentifier: UUID?)

    /// Seleção sem identidade: entrada legada, gravada antes de a identidade existir, e o que
    /// sobra quando a adoção não conheceu o periférico. A retomada trata esse caso como o Android
    /// trata `address` nulo — candidata única, e só ela.
    public static func bluetooth(profileId: String) -> PersistedPrinterSelection {
        .bluetooth(profileId: profileId, peripheralIdentifier: nil)
    }

    /// O mesmo para o Wi-Fi: registro gravado antes de o endpoint existir continua abrindo, e
    /// continua sendo retomado pela candidata única.
    public static func localWifi(profileId: String) -> PersistedPrinterSelection {
        .localWifi(profileId: profileId, endpoint: nil)
    }

    private enum CodingKeys: String, CodingKey {
        case transport, profileId, peripheralIdentifier, endpoint
    }

    private enum Transport: String, Codable {
        case localWifi, bluetooth
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: PrinterSelectionFieldKey.self)
        let presentFields = Set(fields.allKeys.map(\.stringValue))
        guard presentFields.isSubset(of: Self.allowedFieldNames) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Campo de seleção não permitido.")
            )
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decoded: PersistedPrinterSelection
        switch try container.decode(Transport.self, forKey: .transport) {
        case .localWifi:
            // Cada transporte reconhece **a sua** identidade e recusa a do outro: UUID de
            // periférico numa seleção de rede é campo desconhecido como qualquer outro.
            guard !presentFields.contains(CodingKeys.peripheralIdentifier.stringValue) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Campo de seleção não permitido.")
                )
            }
            decoded = .localWifi(
                profileId: try container.decode(String.self, forKey: .profileId),
                endpoint: try container.decodeIfPresent(PersistedNetworkEndpoint.self, forKey: .endpoint)
            )
        case .bluetooth:
            guard !presentFields.contains(CodingKeys.endpoint.stringValue) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Campo de seleção não permitido.")
                )
            }
            // Ausente é o payload gravado antes de a identidade existir: decodifica com nil, e a
            // pessoa não perde a impressora dela por causa de uma atualização do app.
            decoded = .bluetooth(
                profileId: try container.decode(String.self, forKey: .profileId),
                peripheralIdentifier: try container.decodeIfPresent(
                    UUID.self,
                    forKey: .peripheralIdentifier
                )
            )
        }
        guard decoded.hasValidProfileID else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Identificador de perfil inválido.")
            )
        }
        self = decoded
    }

    public func encode(to encoder: Encoder) throws {
        guard hasValidProfileID else {
            throw EncodingError.invalidValue(
                self,
                .init(codingPath: encoder.codingPath, debugDescription: "Identificador de perfil inválido.")
            )
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .localWifi(profileId, endpoint):
            try container.encode(Transport.localWifi, forKey: .transport)
            try container.encode(profileId, forKey: .profileId)
            // Mesma regra do Bluetooth: sem identidade, o payload continua byte a byte o antigo.
            try container.encodeIfPresent(endpoint, forKey: .endpoint)
        case let .bluetooth(profileId, peripheralIdentifier):
            try container.encode(Transport.bluetooth, forKey: .transport)
            try container.encode(profileId, forKey: .profileId)
            // Sem identidade o payload continua byte a byte o antigo: quem nunca a teve não ganha
            // campo, e um kit mais velho volta a ler o mesmo registro.
            try container.encodeIfPresent(peripheralIdentifier, forKey: .peripheralIdentifier)
        }
    }

    /// A descrição contém somente o perfil público; nunca um endereço técnico nem a identidade
    /// física da unidade.
    var redactedDescription: String {
        guard hasValidProfileID else { return "printerSelection(profile=[INVALID])" }
        switch self {
        case let .localWifi(profileId, _): return "localWifi(\(profileId))"
        case let .bluetooth(profileId, _): return "bluetooth(\(profileId))"
        }
    }

    public var description: String { redactedDescription }
    public var debugDescription: String { redactedDescription }

    var profileId: String {
        switch self {
        case let .localWifi(profileId, _): return profileId
        case let .bluetooth(profileId, _): return profileId
        }
    }

    /// Identidade física da unidade adotada, quando o transporte a conhece. Interna de propósito:
    /// serve para reencontrar exatamente esta impressora e para mais nada — não atravessa a
    /// superfície, não vira rótulo e não entra em nenhum texto observável.
    var peripheralIdentifier: UUID? {
        switch self {
        case .localWifi: return nil
        case let .bluetooth(_, peripheralIdentifier): return peripheralIdentifier
        }
    }

    /// Endpoint da unidade de rede adotada. Mesma regra do ``peripheralIdentifier``: interno,
    /// nunca observável, e existe só para reencontrar esta impressora.
    var networkEndpoint: PersistedNetworkEndpoint? {
        switch self {
        case let .localWifi(_, endpoint): return endpoint
        case .bluetooth: return nil
        }
    }

    /**
     Identidade física da unidade, quando o transporte a conhece.

     **Interna e nunca observável.** É UUID de periférico ou endpoint de rede — exatamente o que o
     `AGENTS.md` proíbe em log, erro, `description` e telemetria. Ela existe aqui por um motivo só:
     distinguir duas unidades que compartilham o mesmo perfil. Quem precisa falar de uma instalação
     para fora usa ``installationId``, que é derivado e opaco.
     */
    var physicalIdentity: String? {
        switch self {
        case let .localWifi(_, endpoint):
            return endpoint.map { "wifi:\($0.ipv4Address):\($0.port)" }
        case let .bluetooth(_, peripheralIdentifier):
            return peripheralIdentifier.map { "ble:\($0.uuidString)" }
        }
    }

    /**
     Identificador estável e opaco desta instalação.

     Perfil mais um resumo da identidade física. Foi isto que faltou: a instalação era chaveada só
     pelo transporte, então adotar uma segunda impressora **apagava a primeira em silêncio** — sem
     confirmação, sem aviso, e levando junto uma instalação que uma pessoa tinha confirmado no
     papel.

     Sem identidade conhecida, cai no perfil sozinho — que é o comportamento antigo e o correto
     para esse caso: readotar a mesma impressora sem endereço precisa substituir, não empilhar
     duplicatas.

     O resumo é hash truncado, não o endereço: este valor atravessa a superfície e aparece em
     ``AdoptedPrinter``.
     */
    var installationId: String {
        guard let physicalIdentity else { return profileId }
        return "\(profileId)#\(identityDigest(physicalIdentity))"
    }

    /**
     A mesma unidade apontando para outro perfil.

     A identidade física não muda, e é ela que diz **qual** impressora é esta. Por isso trocar o
     perfil de uma instalação é edição, não adoção de outra impressora: quando o identificador do
     perfil se mantém, ``installationId`` também se mantém, e a lista continua com um card só.
     */
    func replacingProfile(_ profileId: String) -> PersistedPrinterSelection {
        switch self {
        case let .localWifi(_, endpoint):
            return .localWifi(profileId: profileId, endpoint: endpoint)
        case let .bluetooth(_, peripheralIdentifier):
            return .bluetooth(profileId: profileId, peripheralIdentifier: peripheralIdentifier)
        }
    }

    var hasValidProfileID: Bool { Self.isPersistentProfileID(profileId) }

    private static func isPersistentProfileID(_ value: String) -> Bool {
        // UUID local medido é válido apenas quando ocupa o identificador inteiro. Assim um slug
        // futuro não pode disfarçar UUID de peripheral, IP, MAC ou VID/PID em um prefixo legível.
        if UUID(uuidString: value)?.uuidString.lowercased() == value { return true }
        return isPublishedPrinterProfileID(value)
    }

    private static let allowedFieldNames: Set<String> = [
        "transport", "profileId", "peripheralIdentifier", "endpoint",
    ]
}

/**
 Endpoint da impressora de rede adotada, dentro do registro cifrado.

 Espelha o `PersistedNetworkEndpoint` do Android, inclusive na redação: o endereço não aparece em
 `description` nem em `debugDescription`, porque este valor viaja junto com objetos que caem em log
 de erro sem ninguém decidir isso.

 Só IPv4 privado, pela mesma razão do ``LocalWifiPrinterEndpoint``: um endereço público aqui seria
 uma impressora fora da rede local, e a validação é a mesma para não haver duas respostas sobre o
 que é um endpoint aceitável.
 */
public struct PersistedNetworkEndpoint: Codable, Equatable, Hashable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible {
    public let ipv4Address: String
    public let port: Int

    public init?(ipv4Address: String, port: Int) {
        guard let endpoint = LocalWifiPrinterEndpoint(ipAddress: ipv4Address, port: port) else {
            return nil
        }
        self.ipv4Address = endpoint.ipAddress
        self.port = endpoint.port
    }

    init(_ endpoint: LocalWifiPrinterEndpoint) {
        ipv4Address = endpoint.ipAddress
        port = endpoint.port
    }

    /// Volta ao endpoint operacional. Opcional porque a validação vive lá: um registro adulterado
    /// no chaveiro não pode virar destino de cupom só por estar gravado.
    var localEndpoint: LocalWifiPrinterEndpoint? {
        LocalWifiPrinterEndpoint(ipAddress: ipv4Address, port: port)
    }

    public var description: String { "PersistedNetworkEndpoint([REDACTED])" }
    public var debugDescription: String { description }

    private enum CodingKeys: String, CodingKey {
        case ipv4Address, port
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: PrinterSelectionFieldKey.self)
        guard Set(fields.allKeys.map(\.stringValue)) == Set(["ipv4Address", "port"]) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Campo de endpoint não permitido.")
            )
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let decoded = PersistedNetworkEndpoint(
            ipv4Address: try container.decode(String.self, forKey: .ipv4Address),
            port: try container.decode(Int.self, forKey: .port)
        ) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Endpoint de impressora inválido.")
            )
        }
        self = decoded
    }
}

/**
 Resumo curto e estável da identidade física, para poder sair do kit sem levar o endereço junto.

 SHA-256 truncado, como no Android. Não é segredo criptográfico — é anti-vazamento: o
 ``AdoptedPrinter`` atravessa a superfície e chega ao app hospedeiro, e o `AGENTS.md` proíbe
 endereço, MAC e serial fora do store cifrado. Doze hex bastam para separar as impressoras de um
 balcão sem reconstruir o endereço.
 */
internal func identityDigest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
        .prefix(6)
        .map { String(format: "%02x", $0) }
        .joined()
}

/// Subconjunto publicável que pode atravessar a persistência sem carregar destino técnico.
/// Aceita marca iniciada por número (`3nstar`, por exemplo), como os IDs embutidos.
internal func isPublishedPrinterProfileID(_ value: String) -> Bool {
    guard value.range(of: #"^[a-z0-9][a-z0-9._-]{2,79}$"#, options: .regularExpression) != nil,
          !value.hasPrefix("temporary.")
    else { return false }
    let technicalPatterns = [
        #"(?:^|[._-])(?:ip|mac|vid|pid|uuid|peripheral|endpoint|serial)(?:[._-]|$)"#,
        #"(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:$|[^0-9])"#,
        #"(?i)(?:^|[^0-9a-f])(?:[0-9a-f]{2}[-:]){5}[0-9a-f]{2}(?:$|[^0-9a-f])"#,
        #"(?i)(?:^|[^0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:$|[^0-9a-f])"#,
        #"(?i)usb[._-]?[0-9a-f]{4}[._-]?[0-9a-f]{4}"#,
        #"(?i)(?:vid[._-]?[0-9a-f]{4}.*pid[._-]?[0-9a-f]{4}|pid[._-]?[0-9a-f]{4}.*vid[._-]?[0-9a-f]{4})"#,
        #"(?i)(?:mac|device|peripheral|serial|endpoint)[._-]?[0-9a-f]{12,}"#,
    ]
    return !technicalPatterns.contains {
        value.range(of: $0, options: .regularExpression) != nil
    }
}

private struct PrinterSelectionFieldKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

/**
 Meios físicos disponíveis no iPhone e no iPad.

 O Android tem quatro; aqui são dois. **Não existe USB no iOS**: falar com um acessório USB exige
 certificação MFi e o chip de autenticação da Apple dentro da impressora, coisa que impressora
 térmica de balcão não tem. Bluetooth clássico (SPP) cai na mesma regra — por isso o transporte
 Bluetooth daqui é BLE puro, via GATT. Não tente contornar.
 */
public enum PrinterTransport: String, Codable, CaseIterable, Hashable, Sendable {
    case localWifi, bluetooth

    public var label: String {
        switch self {
        case .localWifi: return "Wi-Fi"
        case .bluetooth: return "Bluetooth"
        }
    }
}

extension PersistedPrinterSelection {
    var transport: PrinterTransport {
        switch self {
        case .localWifi: return .localWifi
        case .bluetooth: return .bluetooth
        }
    }
}

/**
 Impressoras confirmadas neste aparelho e qual **unidade** recebe os cupons.

 Espelha o `PersistedPrinterSelections` do Android. Já foi "uma por transporte", e essa régua é o
 defeito: com uma seleção por meio físico, adotar a segunda portátil apagava a primeira sem avisar,
 e duas impressoras iguais no mesmo balcão eram indistinguíveis. Agora a chave é a instalação —
 perfil mais resumo da identidade —, então duas unidades do mesmo modelo coexistem, duas no mesmo
 transporte coexistem, e readotar a mesma continua substituindo em vez de duplicar.
 */
public struct PersistedPrinterSelections: Codable, Equatable {
    private(set) var selections: [PersistedPrinterSelection]
    private(set) var active: PrinterTransport?
    /**
     Qual unidade recebe os cupons.

     O transporte sozinho deixou de bastar quando duas instalações podem compartilhar o meio
     físico: ele apontaria para as duas. `active` continua gravado porque é o que o payload antigo
     tem, e é por ele que a migração reconstrói esta chave.
     */
    private(set) var activeInstallationId: String?

    public init(
        selections: [PersistedPrinterSelection] = [],
        active: PrinterTransport? = nil,
        activeInstallationId: String? = nil
    ) {
        // Antes a deduplicação era por transporte, e era ela que traduzia "duas iguais no balcão"
        // em "uma some". O que não pode repetir é a mesma unidade.
        let unique = selections.filter(\.hasValidProfileID).reduce(into: [PersistedPrinterSelection]()) { result, selection in
            if !result.contains(where: { $0.installationId == selection.installationId }) {
                result.append(selection)
            }
        }
        let resolved = activeInstallationId.flatMap { id in unique.first { $0.installationId == id } }
            ?? active.flatMap { transport in unique.first { $0.transport == transport } }
            ?? unique.first
        self.selections = unique
        self.active = resolved?.transport
        self.activeInstallationId = resolved?.installationId
    }

    /// A unidade daquele meio físico que está em uso, e só então a primeira encontrada. Preferir a
    /// ativa importa porque duas instalações podem dividir o transporte.
    func of(_ transport: PrinterTransport) -> PersistedPrinterSelection? {
        activeSelection.flatMap { $0.transport == transport ? $0 : nil }
            ?? selections.first { $0.transport == transport }
    }

    func ofProfile(_ profileId: String) -> PersistedPrinterSelection? {
        selections.first { $0.profileId == profileId }
    }

    /// Preciso: resolve a unidade, e não a primeira que compartilha o perfil.
    func ofInstallation(_ installationId: String) -> PersistedPrinterSelection? {
        selections.first { $0.installationId == installationId }
    }

    /**
     A impressora recém-confirmada assume como ativa: foi a última escolha consciente.

     Substitui apenas a **mesma unidade** — readotar a impressora de sempre não empilha duplicata.
     Uma segunda unidade, do mesmo modelo ou do mesmo transporte, entra ao lado da primeira em vez
     de apagá-la.
     */
    func with(_ selection: PersistedPrinterSelection) -> PersistedPrinterSelections {
        guard selection.hasValidProfileID else { return self }
        return PersistedPrinterSelections(
            selections: selections.filter { $0.installationId != selection.installationId } + [selection],
            active: selection.transport,
            activeInstallationId: selection.installationId
        )
    }

    /**
     Troca **uma** instalação por outra sem mexer em quem recebe os cupons.

     É a irmã de ``with(_:)`` para a edição, e a diferença entre as duas é o motivo de existirem
     separadas. `with(_:)` é adoção: a impressora recém-confirmada assume como ativa porque foi a
     última escolha consciente. Editar a página de código de uma unidade parada não é escolher essa
     unidade — e assumir a ativa aqui tiraria o cupom da impressora que estava servindo o balcão,
     sem ninguém pedir.

     A posição na lista também se preserva: a lista é o que a pessoa vê, e um card que pula para o
     fim depois de uma edição parece outra impressora.
     */
    func replacingInstallation(
        _ installationId: String,
        with selection: PersistedPrinterSelection
    ) -> PersistedPrinterSelections {
        guard selection.hasValidProfileID,
              selections.contains(where: { $0.installationId == installationId })
        else { return self }
        return PersistedPrinterSelections(
            selections: selections.map { $0.installationId == installationId ? selection : $0 },
            active: active,
            activeInstallationId: activeInstallationId == installationId
                ? selection.installationId
                : activeInstallationId
        )
    }

    /// Compatibilidade: leva **todas** as unidades daquele meio físico. Quem quer excluir uma
    /// impressora chama ``withoutInstallation(_:)``.
    func without(_ transport: PrinterTransport) -> PersistedPrinterSelections {
        let remaining = selections.filter { $0.transport != transport }
        let next = activeSelection?.transport == transport ? remaining.first : activeSelection
        return PersistedPrinterSelections(
            selections: remaining,
            active: next?.transport,
            activeInstallationId: next?.installationId
        )
    }

    /**
     Remove uma unidade só.

     Diferente de ``without(_:)``, que leva junto toda instalação daquele transporte — apagar a
     segunda MTP-II não pode desinstalar a primeira.
     */
    func withoutInstallation(_ installationId: String) -> PersistedPrinterSelections {
        let remaining = selections.filter { $0.installationId != installationId }
        let next = activeInstallationId == installationId ? remaining.first : activeSelection
        return PersistedPrinterSelections(
            selections: remaining,
            active: next?.transport,
            activeInstallationId: next?.installationId
        )
    }

    /// Desinstala a unidade em uso daquele transporte, e só ela.
    func withoutActiveAt(_ transport: PrinterTransport) -> PersistedPrinterSelections {
        guard let active = activeSelection, active.transport == transport else { return self }
        return withoutInstallation(active.installationId)
    }

    /// Compatibilidade: ativa a primeira unidade confirmada deste transporte.
    func activated(at transport: PrinterTransport) -> PersistedPrinterSelections {
        guard let selection = selections.first(where: { $0.transport == transport }) else { return self }
        return activatedInstallation(selection.installationId)
    }

    func activatedInstallation(_ installationId: String) -> PersistedPrinterSelections {
        guard let selection = ofInstallation(installationId) else { return self }
        return PersistedPrinterSelections(
            selections: selections,
            active: selection.transport,
            activeInstallationId: selection.installationId
        )
    }

    var activeSelection: PersistedPrinterSelection? {
        activeInstallationId.flatMap(ofInstallation)
            ?? active.flatMap { transport in selections.first { $0.transport == transport } }
    }

    private enum CodingKeys: String, CodingKey {
        case selections, active, activeInstallationId
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: PrinterSelectionFieldKey.self)
        guard Set(fields.allKeys.map(\.stringValue))
            .isSubset(of: Set(["selections", "active", "activeInstallationId"]))
        else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Campo de coleção não permitido.")
            )
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Registro gravado antes das instalações múltiplas não sabia de unidade. A ativa é
        // reconstruída a partir do transporte ativo, que era a única chave que existia — e como
        // naquele formato cabia uma por transporte, a reconstrução é exata.
        self.init(
            selections: try container.decode([PersistedPrinterSelection].self, forKey: .selections),
            active: try container.decodeIfPresent(PrinterTransport.self, forKey: .active),
            activeInstallationId: try container.decodeIfPresent(String.self, forKey: .activeInstallationId)
        )
    }

    public func encode(to encoder: Encoder) throws {
        guard selections.allSatisfy(\.hasValidProfileID) else {
            throw EncodingError.invalidValue(
                self,
                .init(codingPath: encoder.codingPath, debugDescription: "Coleção de seleção inválida.")
            )
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(selections, forKey: .selections)
        try container.encodeIfPresent(active, forKey: .active)
        try container.encodeIfPresent(activeInstallationId, forKey: .activeInstallationId)
    }
}

public protocol PrinterSelectionStoring: AnyObject {
    func read() -> PersistedPrinterSelections
    func save(_ selections: PersistedPrinterSelections)
    func clear()
}

public final class KeychainPrinterSelectionStore: PrinterSelectionStoring {
    private let keychain: ThermalPrinterKeychain
    private let account = "printer-selections-v1"

    /**
     - Parameter accessGroup: grupo de acesso do chaveiro (`kSecAttrAccessGroup`), quando o app e
       suas extensões precisam enxergar **a mesma** impressora adotada. O default `nil` mantém o
       item no container do processo: byte a byte o comportamento de sempre para quem não pede
       nada.

       O grupo precisa estar declarado no entitlement dos dois lados; um grupo não declarado faz
       toda operação do chaveiro falhar, e a falha se apresenta como seleção que não existe. Perfis
       viajam por outro store — ver ``UserDefaultsPrinterProfileDataStore`` —, e os dois precisam
       ser compartilhados juntos: impressora adotada sem o perfil dela é largura errada no papel.
     */
    public init(accessGroup: String? = nil) {
        keychain = ThermalPrinterKeychain(accessGroup: accessGroup)
    }

    /// Entrada da suíte: o grupo de acesso só se prova com um chaveiro dublê, porque entitlement
    /// exige binário assinado. Ver ``ThermalPrinterKeychainBackend``.
    init(keychain: ThermalPrinterKeychain) {
        self.keychain = keychain
    }

    public func read() -> PersistedPrinterSelections {
        // Registro ilegível é descartado em silêncio: a pessoa apenas escolhe de novo.
        if let stored = try? keychain.read(PersistedPrinterSelections.self, account: account) {
            return stored
        }
        try? keychain.remove(account: account)
        return PersistedPrinterSelections()
    }

    public func save(_ selections: PersistedPrinterSelections) {
        try? keychain.write(selections, account: account)
    }

    public func clear() {
        try? keychain.remove(account: account)
    }
}

/// O app hospedeiro conhece seu serviço, suas contas e seu AAD antigos. O kit conhece apenas a
/// ordem transacional: ler, gravar no store neutro, reler e só então autorizar a exclusão.
public protocol LegacyPrinterSelectionImporting {
    func readLegacyPrinterSelections() throws -> PersistedPrinterSelections?
    func removeLegacyPrinterSelectionsAfterConfirmedImport() throws
}

public enum PrinterSelectionImportError: Error, Equatable {
    case selectionWasNotConfirmed
}

public struct PrinterSelectionImporter {
    public init() {}

    @discardableResult
    public func migrate(
        from importer: any LegacyPrinterSelectionImporting,
        into store: any PrinterSelectionStoring
    ) throws -> Bool {
        guard let legacy = try importer.readLegacyPrinterSelections() else { return false }
        store.save(legacy)
        guard store.read() == legacy else { throw PrinterSelectionImportError.selectionWasNotConfirmed }
        try importer.removeLegacyPrinterSelectionsAfterConfirmedImport()
        return true
    }
}

final class InMemoryPrinterSelectionStore: PrinterSelectionStoring {
    private var current: PersistedPrinterSelections

    init(selection: PersistedPrinterSelection? = nil) {
        current = selection.map { PersistedPrinterSelections().with($0) } ?? PersistedPrinterSelections()
    }

    func read() -> PersistedPrinterSelections { current }

    func save(_ selections: PersistedPrinterSelections) { current = selections }

    func clear() { current = PersistedPrinterSelections() }
}
