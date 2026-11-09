import Foundation

public protocol PrinterProfileDataStoring: AnyObject {
    func readProfileData() throws -> Data?
    func writeProfileData(_ data: Data?) throws
}

public final class UserDefaultsPrinterProfileDataStore: PrinterProfileDataStoring {
    /// Chave do registro, em um lugar só: os dois inicializadores precisam gravar sob a mesma, ou
    /// app e extensão dividiriam a suíte e ainda assim leriam registros diferentes.
    public static let defaultKey = "thermal-printer-measured-profiles-v1"

    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = defaultKey
    ) {
        self.defaults = defaults
        self.key = key
    }

    /**
     Perfis na suíte compartilhada entre o app e suas extensões (o app group).

     Falha em vez de cair no `.standard` porque cair seria o silêncio: a extensão gravaria perfil
     no container dela, o app continuaria lendo o dele, e a impressora adotada sairia com a largura
     de outra — sem erro em lugar nenhum, só no papel. `UserDefaults(suiteName:)` recusa o nome do
     próprio bundle e o domínio global; um app group que o entitlement não declara não é recusado
     aqui, e sim no aparelho.

     A seleção da impressora viaja por ``KeychainPrinterSelectionStore``, com o grupo de acesso do
     chaveiro. Compartilhar só um dos dois é pior que não compartilhar nenhum.
     */
    public convenience init?(suiteName: String, key: String = defaultKey) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
        self.init(defaults: defaults, key: key)
    }

    public func readProfileData() throws -> Data? { defaults.data(forKey: key) }

    public func writeProfileData(_ data: Data?) throws {
        if let data {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

public enum PrinterProfileStoreError: Error, Equatable, LocalizedError {
    case corruptRecord
    case unsupportedVersion
    case fieldNotAllowed
    case profileWasNotConfirmed

    public var errorDescription: String? {
        switch self {
        case .corruptRecord: return "Registro de perfil inválido."
        case .unsupportedVersion: return "Versão de armazenamento de perfil incompatível."
        case .fieldNotAllowed: return "O registro contém um campo que não pode ser persistido."
        case .profileWasNotConfirmed: return "O perfil não foi confirmado no armazenamento neutro."
        }
    }
}

/// Store neutro de capacidades medidas. O JSON tem schema fechado: endpoint, IP, MAC, VID, PID,
/// UUID de periférico ou qualquer extensão futura desconhecida faz o registro inteiro ser
/// rejeitado, em vez de ser silenciosamente copiado para disco.
public final class PrinterProfileStore {
    private struct Envelope: Codable {
        let version: Int
        let profiles: [MeasuredProfile]
    }

    /**
     O mesmo envelope, mas com cada perfil isolado do vizinho.

     **Por que existe.** `[MeasuredProfile]` decodifica o vetor inteiro ou nenhum: um elemento que
     este kit nao entende derruba a leitura toda, e `profiles()` trata isso como corrupcao e APAGA o
     arquivo. Medido em 27/08/2026 com um `dialect` desconhecido — que e como um perfil de Diebold
     IM453H contribuido pelo Android chegaria: o perfil bom do balco ia junto, e ele custou papel.

     **Perfil de um kit mais novo nao e corrupcao**, e essa e a distincao que o vetor cru nao sabe
     fazer. A decisao escrita — descartar em vez de aproveitar meio registro — continua valendo para
     o registro que falhou; o que ela nunca disse foi que os OUTROS deviam morrer junto.

     `try?` engole qualquer erro daquele elemento, e isso e deliberado: o que este tipo promete e
     isolamento, nao diagnostico. Quantos cairam e o que [PrinterProfileStore] devolve a quem le, e e
     por isso que o descarte nao e silencioso.
     */
    private struct IsolatedEnvelope: Decodable {
        let version: Int
        let slots: [Slot]

        struct Slot: Decodable {
            let profile: MeasuredProfile?

            init(from decoder: Decoder) throws {
                profile = try? MeasuredProfile(from: decoder)
            }
        }

        private enum CodingKeys: String, CodingKey {
            case version, profiles
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            version = try container.decode(Int.self, forKey: .version)
            slots = try container.decode([Slot].self, forKey: .profiles)
        }
    }

    private let dataStore: any PrinterProfileDataStoring
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let lock = NSLock()

    public init(dataStore: any PrinterProfileDataStoring = UserDefaultsPrinterProfileDataStore()) {
        self.dataStore = dataStore
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
    }

    /**
     Leitura tolerante para a interface.

     A regra escrita continua valendo para o registro que falhou: corrupção é descartada, não há
     rascunho recuperável, e uma confirmação nova em papel é mais segura que meio registro. **O que
     mudou em 27/08/2026 é o alcance dela.** O vetor de perfis decodificava tudo ou nada, então um
     perfil que este kit não entende — um `dialect` de um kit mais novo, por exemplo — derrubava a
     leitura inteira e o arquivo era apagado, levando junto medições que custaram papel. Perfil de
     kit mais novo não é corrupção; é o formato andando para frente.

     Agora cada perfil cai sozinho (ver `IsolatedEnvelope`), e **quantos caíram sai por
     ``profilesRead()``** — descarte silencioso trocaria um sumiço visível por um invisível, que é
     pior: a pessoa perderia uma impressora da lista sem nunca descobrir por quê.

     O apagar-tudo fica para o caso em que ele continua certo: envelope que não decodifica, versão
     que este kit não conhece, allowlist violada. Aí não há perfil nenhum a salvar.
     */
    public func profiles() -> [MeasuredProfile] { profilesRead().profiles }

    /**
     A mesma leitura, com o que ela teve de descartar.

     `unreadable` é o número de perfis que estavam no arquivo e este kit não conseguiu ler. Zero é o
     caso normal. Qualquer coisa acima disso é uma impressora que sumiu da lista de alguém, e quem
     desenha a interface precisa poder dizer isso.
     */
    public func profilesRead() -> (profiles: [MeasuredProfile], unreadable: Int) {
        lock.lock()
        defer { lock.unlock() }
        do {
            return try readLocked()
        } catch {
            try? dataStore.writeProfileData(nil)
            return ([], 0)
        }
    }

    public func profile(id: String) -> MeasuredProfile? {
        profiles().first { $0.id.caseInsensitiveCompare(id) == .orderedSame }
    }

    public func save(_ profile: MeasuredProfile) throws {
        let validated = try Self.validate(profile)
        lock.lock()
        defer { lock.unlock() }
        var current = try readLocked().profiles
        current.removeAll { $0.id.caseInsensitiveCompare(validated.id) == .orderedSame }
        current.append(validated)
        try writeLocked(Self.ordered(current))
    }

    /**
     Grava, no perfil desta impressora, como ela aceita configuração de rede.

     **Read-modify-write, e com releitura**, no contrato de `ThermalPrinterConfiguration.persist`: o
     que a tela tem é uma resposta sobre um campo, e o que o store recebe é um `MeasuredProfile`
     inteiro. Reconstruí-lo na tela apagaria em silêncio tudo o que a tela não conhece — foi assim
     que a homologação da T210 se perdeu depois de 44 impressões, e é o defeito que a edição manual
     ainda tem hoje com o fator de compensação.

     Devolve `false` sem gravar quando não há perfil para escrever: a candidata retida em memória
     não tem perfil persistido, e a impressora instalada pode nem ter sido resolvida para um. **A
     resposta da pessoa continua valendo na sessão** — quem chama não pode transformar isto em
     recomeço —, ela só não sobrevive ao fechamento do app, e fingir que sobreviveu seria pior.

     Espelho de `PrinterProfileStore.recordWifiConfigurationFamily` do Android.
     */
    @discardableResult
    public func recordWifiConfigurationFamily(
        _ family: PrinterWifiConfigurationFamily,
        forProfileId id: String
    ) -> Bool {
        guard let current = profile(id: id) else { return false }
        guard current.wifiConfigurationFamily != family else { return true }
        do {
            let updated = try current.withWifiConfigurationFamily(family)
            try save(updated)
            // Relê antes de dizer que gravou. Perfil que o store aceitou e devolve diferente é a
            // falha que precisa aparecer aqui, e não no papel de quem configurar a rede de novo.
            return profile(id: id) == updated
        } catch {
            return false
        }
    }

    public func remove(id: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let remaining = try readLocked().profiles.filter { $0.id.caseInsensitiveCompare(id) != .orderedSame }
        if remaining.isEmpty {
            try dataStore.writeProfileData(nil)
        } else {
            try writeLocked(remaining)
        }
    }

    public func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        try dataStore.writeProfileData(nil)
    }

    /// Entrada destinada a migração ou restauração. A allowlist é conferida antes do `Codable`,
    /// pois o decoder padrão ignoraria uma chave técnica desconhecida.
    public func restoreStrictly(from data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        let profiles = try decodeStrict(data).profiles
        try writeLocked(Self.deduplicated(profiles))
    }

    public func encodedProfiles() throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        return try encoder.encode(Envelope(version: Self.version, profiles: try readLocked().profiles))
    }

    private func readLocked() throws -> (profiles: [MeasuredProfile], unreadable: Int) {
        guard let data = try dataStore.readProfileData() else { return ([], 0) }
        let decoded = try decodeStrict(data, tolerante: true)
        if decoded.discardedRetiredProfiles {
            // Versões antigas chegaram a persistir perfis vindos da rede junto das medições.
            // Limpar o envelope na própria leitura impede que esse dado extinto volte a aparecer,
            // sem apagar a medição local que continua sendo a fonte de verdade do aparelho.
            if decoded.profiles.isEmpty {
                try? dataStore.writeProfileData(nil)
            } else {
                try? writeLocked(decoded.profiles)
            }
        }
        return (decoded.profiles, decoded.unreadable)
    }

    private func writeLocked(_ profiles: [MeasuredProfile]) throws {
        let profiles = try profiles.map(Self.validate)
        let data = try encoder.encode(Envelope(version: Self.version, profiles: profiles))
        // **O que este kit nao sabe ler volta ao disco intacto.** Ver `preservados()`: sem isto o
        // primeiro `save` depois de uma leitura tolerante apagaria de vez o perfil ilegivel, e a
        // leitura que salvou os vizinhos teria so adiado a perda.
        let guardados = preservados()
        guard !guardados.isEmpty else {
            try dataStore.writeProfileData(data)
            return
        }
        guard let raiz = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let escritos = raiz["profiles"] as? [[String: Any]],
              let juntos = try? JSONSerialization.data(
                  withJSONObject: ["version": Self.version, "profiles": escritos + guardados],
                  options: [.sortedKeys]
              )
        else {
            // Nao consegui reanexar: escrever sem os preservados seria apaga-los em silencio, que e
            // exatamente o que este caminho existe para impedir.
            throw PrinterProfileStoreError.corruptRecord
        }
        try dataStore.writeProfileData(juntos)
        return
    }

    /**
     - Parameter tolerante: `false` — o padrao — recusa o arquivo INTEIRO ao ver campo fora da
       allowlist ou perfil que nao decodifica. `true` descarta so o perfil e devolve quantos foram.

     **A diferenca nao e de rigor, e de origem do dado, e confundir as duas custaria caro nos dois
     sentidos.** `restoreStrictly` recebe arquivo de FORA: ali um `ipAddress` ou um `macAddress` num
     perfil nao e "campo que este kit nao conhece", e endereco de rede entrando por uma porta que
     nao devia aceitar — recusar o arquivo inteiro e a resposta certa, e ha prova exigindo isso
     campo a campo. `profiles()` le o arquivo que este mesmo app escreveu: ali um campo novo e o
     formato andando para frente, e apagar as medicoes dos vizinhos por causa dele foi o defeito
     medido em 27/08/2026.
     */
    private func decodeStrict(
        _ data: Data,
        tolerante: Bool = false
    ) throws -> (profiles: [MeasuredProfile], discardedRetiredProfiles: Bool, unreadable: Int) {
        let filtered = try Self.removingRetiredCatalogProfiles(from: data)
        let particao = try Self.partitionAllowlist(filtered.data)
        if !tolerante, !particao.recusados.isEmpty {
            throw PrinterProfileStoreError.fieldNotAllowed
        }
        // O arquivo que vai ao decodificador leva **so** os perfis que cabem na allowlist. Os
        // outros ja estao contados como ilegiveis e ficam guardados no disco por `preservados()`.
        let soAceitos: Data
        do {
            soAceitos = try JSONSerialization.data(
                withJSONObject: ["version": Self.version, "profiles": particao.aceitos]
            )
        } catch {
            throw PrinterProfileStoreError.corruptRecord
        }
        // **O modo estrito NAO passa pelo envelope isolado**, e isto nao e simetria perdida: o
        // isolamento usa `try?` por perfil, e `try?` engole o erro. Quem importa arquivo de fora
        // precisa saber QUAL campo recusou — `invalidSource`, `invalidDisplayName` —, e ha prova
        // exigindo cada um pelo nome. Trocar isso por um `corruptRecord` generico faria a pessoa
        // procurar corrupcao onde havia um identificador tecnico escondido no nome.
        if !tolerante {
            let estrito: Envelope
            do {
                estrito = try decoder.decode(Envelope.self, from: soAceitos)
            } catch let error as PrinterProfileValidationError {
                throw error
            } catch {
                throw PrinterProfileStoreError.corruptRecord
            }
            guard estrito.version == Self.version else { throw PrinterProfileStoreError.unsupportedVersion }
            return (try Self.deduplicated(estrito.profiles.map(Self.validate)), filtered.discarded, 0)
        }
        let envelope: IsolatedEnvelope
        do {
            envelope = try decoder.decode(IsolatedEnvelope.self, from: soAceitos)
        } catch let error as PrinterProfileValidationError {
            throw error
        } catch {
            throw PrinterProfileStoreError.corruptRecord
        }
        guard envelope.version == Self.version else { throw PrinterProfileStoreError.unsupportedVersion }
        // **O perfil que nao decodifica cai sozinho, e nao leva os vizinhos.** Ver
        // [IsolatedEnvelope] para a medicao que mudou isto. `validate` continua sendo cobrado de
        // quem decodificou: um perfil legivel porem invalido nao entra na lista por outra porta.
        let lidos = envelope.slots.compactMap(\.profile)
        // Os dois jeitos de um perfil ser ilegivel, somados: campo que a allowlist nao conhece, e
        // valor que o decodificador nao entende. O primeiro e o caso de um kit mais novo ter
        // acrescentado campo; o segundo, de ter acrescentado valor a um campo que ja existia — um
        // `dialect` novo, por exemplo. Os dois derrubavam o arquivo inteiro antes de 27/08/2026.
        let ilegiveis = particao.recusados.count + (envelope.slots.count - lidos.count)
        return (
            try Self.deduplicated(lidos.map(Self.validate)),
            filtered.discarded,
            ilegiveis
        )
    }

    private static func validate(_ profile: MeasuredProfile) throws -> MeasuredProfile {
        try MeasuredProfile.validated(
            id: profile.id,
            displayName: profile.displayName,
            measuredAt: profile.measuredAt,
            source: profile.source,
            capabilities: profile.capabilities,
            firmwareVersion: profile.firmwareVersion
        )
    }

    private static func deduplicated(_ profiles: [MeasuredProfile]) throws -> [MeasuredProfile] {
        var byID: [String: MeasuredProfile] = [:]
        for profile in try profiles.map({ try validate($0) }) {
            let key = profile.id.lowercased()
            if let previous = byID[key], previous.measuredAt > profile.measuredAt { continue }
            byID[key] = profile
        }
        return ordered(Array(byID.values))
    }

    private static func ordered(_ profiles: [MeasuredProfile]) -> [MeasuredProfile] {
        profiles.sorted { lhs, rhs in
            if lhs.measuredAt != rhs.measuredAt { return lhs.measuredAt > rhs.measuredAt }
            return lhs.id < rhs.id
        }
    }

    /**
     Separa os perfis que este kit sabe ler dos que ele nao sabe — **sem condenar o arquivo**.

     A allowlist existe para um campo desconhecido nao ser copiado de volta ao disco em silencio, e
     isso continua valendo. O que mudou em 27/08/2026 e o ALCANCE: ela derrubava o arquivo INTEIRO,
     e `profiles()` traduzia isso em apagar tudo. Um perfil de um kit mais novo — com um campo que
     este ainda nao tem — levava junto as medicoes que custaram papel.

     A raiz continua fatal, e ai a diferenca e real: envelope sem `version` ou sem `profiles` nao
     tem perfil nenhum a salvar.

     - Returns: os perfis aceitos e os recusados, os dois na forma crua. Os recusados voltam para
       `writeLocked` poder devolve-los ao disco intactos — ver [preservados].
     */
    private static func partitionAllowlist(
        _ data: Data
    ) throws -> (aceitos: [[String: Any]], recusados: [[String: Any]]) {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw PrinterProfileStoreError.corruptRecord
        }
        guard let root = object as? [String: Any], Set(root.keys) == rootKeys,
              let profiles = root["profiles"] as? [[String: Any]]
        else { throw PrinterProfileStoreError.fieldNotAllowed }
        var aceitos: [[String: Any]] = []
        var recusados: [[String: Any]] = []
        for profile in profiles {
            let capabilities = profile["capabilities"] as? [String: Any]
            let cabe = Set(profile.keys).isSubset(of: profileKeys)
                && requiredProfileKeys.isSubset(of: Set(profile.keys))
                && capabilities.map { Set($0.keys).isSubset(of: capabilityKeys) } == true
                && capabilities.map { requiredCapabilityKeys.isSubset(of: Set($0.keys)) } == true
            if cabe { aceitos.append(profile) } else { recusados.append(profile) }
        }
        return (aceitos, recusados)
    }

    /**
     Os perfis que este kit nao sabe ler, na forma crua em que estao no disco.

     **Existe para a escrita nao terminar o servico que a leitura se recusou a fazer.** Sem isto,
     `save` faria read-modify-write com a lista ja filtrada e apagaria de vez o perfil ilegivel —
     trocar uma perda total imediata por uma perda parcial no proximo `save` nao e conserto.

     Guardados intactos: quando este app for atualizado e passar a entender o campo, a impressora
     volta sozinha. **Nao medido:** que exista de fato uma versao futura que os leia.
     */
    private func preservados() -> [[String: Any]] {
        guard let data = (try? dataStore.readProfileData()) ?? nil else { return [] }
        // **O mesmo pre-filtro da leitura, e omiti-lo custou uma prova vermelha.** Sem
        // `removingRetiredCatalogProfiles` aqui, um perfil de catalogo aposentado — que a leitura
        // acabou de descartar de proposito — voltaria ao disco pela porta da preservacao, e o dado
        // extinto que aquele filtro existe para enterrar ressuscitaria a cada gravacao.
        guard let semAposentados = try? Self.removingRetiredCatalogProfiles(from: data) else { return [] }
        guard let particao = try? Self.partitionAllowlist(semAposentados.data) else { return [] }
        // **Os dois jeitos de ser ilegivel, e o segundo custou uma prova vermelha.** A allowlist
        // pega o CAMPO desconhecido; ela deixa passar o VALOR desconhecido num campo que ela
        // conhece — um `dialect` novo tem chave conhecida e valor que o enum nao tem. Guardar so os
        // recusados pela allowlist deixaria `save` apagar exatamente o caso que motivou tudo isto.
        return particao.recusados + particao.aceitos.filter { !decodifica($0) }
    }

    /// Aquele perfil, sozinho, atravessa o decodificador? Serve para separar o ilegivel do legivel
    /// sem depender de identidade: um perfil que nao decodifica nao tem `id` para comparar.
    private func decodifica(_ profile: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: profile) else { return false }
        return (try? decoder.decode(MeasuredProfile.self, from: data)) != nil
    }

    private static func removingRetiredCatalogProfiles(
        from data: Data
    ) throws -> (data: Data, discarded: Bool) {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw PrinterProfileStoreError.corruptRecord
        }
        guard var root = object as? [String: Any], Set(root.keys) == rootKeys,
              let profiles = root["profiles"] as? [[String: Any]]
        else { throw PrinterProfileStoreError.fieldNotAllowed }

        let retained = profiles.filter { ($0["source"] as? String) != retiredCatalogSource }
        guard retained.count != profiles.count else { return (data, false) }
        root["profiles"] = retained
        do {
            return (try JSONSerialization.data(withJSONObject: root), true)
        } catch {
            throw PrinterProfileStoreError.corruptRecord
        }
    }

    private static let version = 1
    private static let retiredCatalogSource = "CATALOG"
    private static let rootKeys: Set<String> = ["version", "profiles"]
    private static let profileKeys: Set<String> = [
        "id", "displayName", "measuredAt", "source", "capabilities", "firmwareVersion",
    ]
    private static let requiredProfileKeys: Set<String> = [
        "id", "displayName", "measuredAt", "source", "capabilities",
    ]
    private static let capabilityKeys: Set<String> = [
        "transports", "paperWidth", "printableColumns", "printableDots", "codePage",
        "cutProtocol", "cutFeedLines", "dialect", "statusProtocol", "tcpPort",
        // Medidos na bancada e opcionais: perfil antigo não os tem, e por isso ficam fora de
        // `requiredCapabilityKeys`. Esquecê-los aqui faz o store rejeitar o próprio registro que
        // acabou de gravar — foi o que perdeu a homologação da T210 com "o perfil não pôde ser
        // salvo", depois de 44 impressões.
        "codePageSelector", "cutModeHonored", "textEncoding", "maxRasterBytesPerSecond",
        "verticalRasterScale", "wifiConfigurationFamily",
        // As duas respostas da sonda de código nativo. Perfil medido antes dela não as tem, então
        // ficam aqui e **não** em `requiredCapabilityKeys`.
        "nativeQrHonored", "nativeBarcodeHonored",
    ]
    /// O piso do v1, e ele não cresce. Nenhum dos campos medidos entra aqui: perfil gravado antes
    /// de cada um deles não os tem, e exigi-los rejeitaria toda medição já feita — pelo mesmo
    /// caminho silencioso que `profiles()` transforma em disco apagado.
    private static let requiredCapabilityKeys: Set<String> = [
        "transports", "paperWidth", "printableColumns", "printableDots", "cutProtocol",
        "cutFeedLines", "dialect", "statusProtocol",
    ]
}

/// O consumidor conhece as chaves e aliases antigos; o core conhece apenas a ordem segura da
/// migração. A exclusão só é autorizada depois de o registro neutro ser relido e comparado.
public protocol LegacyPrinterProfileImporting {
    func readLegacyPrinterProfiles() throws -> [MeasuredProfile]
    func removeLegacyPrinterProfilesAfterConfirmedImport() throws
}

public struct PrinterProfileImporter {
    public init() {}

    @discardableResult
    public func migrate(
        from importer: any LegacyPrinterProfileImporting,
        into store: PrinterProfileStore
    ) throws -> Int {
        let legacy = try importer.readLegacyPrinterProfiles()
        for profile in legacy { try store.save(profile) }
        let confirmed = store.profiles()
        guard legacy.allSatisfy({ wanted in confirmed.contains(wanted) }) else {
            throw PrinterProfileStoreError.profileWasNotConfirmed
        }
        try importer.removeLegacyPrinterProfilesAfterConfirmedImport()
        return legacy.count
    }
}
