import Darwin
import Foundation

/// Endpoint efêmero de uma impressora. O endereço não é persistido nem incluído em representações
/// de depuração; ele só aparece na lista que a pessoa solicitou.
public struct LocalWifiPrinterEndpoint: Hashable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let ipAddress: String
    public let port: Int
    private let octets: [UInt8]

    public init?(ipAddress: String, port: Int) {
        let trimmed = ipAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed == ipAddress, (1...65_535).contains(port) else { return nil }
        let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let parsed = parts.compactMap { part -> UInt8? in
            guard !part.isEmpty, part.count <= 3, part.allSatisfy(\.isNumber), let value = UInt8(part) else {
                return nil
            }
            return value
        }
        guard parsed.count == 4, Self.isPrivate(parsed) else { return nil }
        self.octets = parsed
        self.ipAddress = parsed.map(String.init).joined(separator: ".")
        self.port = port
    }

    init?(octets: [UInt8], port: Int) {
        guard octets.count == 4, Self.isPrivate(octets), (1...65_535).contains(port) else { return nil }
        self.octets = octets
        self.ipAddress = octets.map(String.init).joined(separator: ".")
        self.port = port
    }

    public var description: String { "LocalWifiPrinterEndpoint([REDACTED])" }
    public var debugDescription: String { description }

    var addressValue: UInt32 {
        octets.reduce(0) { partial, byte in (partial << 8) | UInt32(byte) }
    }

    /// Só RFC1918. A impressora está na mesma rede privada; um endereço público aqui seria
    /// tentativa de mandar o cupom para fora da rede.
    private static func isPrivate(_ bytes: [UInt8]) -> Bool {
        guard bytes.count == 4 else { return false }
        return bytes[0] == 10 ||
            (bytes[0] == 172 && (16...31).contains(bytes[1])) ||
            (bytes[0] == 192 && bytes[1] == 168)
    }
}

public struct LocalWifiPrinterCandidate: Identifiable, Hashable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let id: Int
    public let label: String
    public let ipAddress: String
    let endpoint: LocalWifiPrinterEndpoint

    init?(id: Int, order: Int, endpoint: LocalWifiPrinterEndpoint) {
        guard id > 0, order > 0 else { return nil }
        self.id = id
        self.label = "Impressora encontrada \(order)"
        self.ipAddress = endpoint.ipAddress
        self.endpoint = endpoint
    }

    public var description: String { "LocalWifiPrinterCandidate(id=\(id))" }
    public var debugDescription: String { description }
}

struct LocalWifiPrinterSubnet: Hashable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    private let hostValue: UInt32
    private let networkValue: UInt32
    private let broadcastValue: UInt32
    let prefixLength: Int

    /// Identidade é o CIDR, **não** o endereço do celular.
    ///
    /// A igualdade sintetizada incluía `hostValue`, e o controlador compara a rede da busca com a
    /// atual antes de testar uma candidata. Bastava o telefone trocar de IP na mesma rede — renovar
    /// o DHCP no AP da impressora é o caso comum — para as candidatas serem descartadas e a tela
    /// voltar para o endereço manual. Medido no iPhone 7 com a P80 em Wi-Fi direto: achava a
    /// impressora e voltava para a tela do IP ao iniciar o teste. O Android sempre comparou só
    /// `networkValue` e `prefixLength`; era divergência, e o errado era este lado.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.networkValue == rhs.networkValue && lhs.prefixLength == rhs.prefixLength
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(networkValue)
        hasher.combine(prefixLength)
    }

    init?(hostAddress: String, prefixLength: Int) {
        guard (24...30).contains(prefixLength), let host = LocalWifiPrinterEndpoint(ipAddress: hostAddress, port: 9_100) else {
            return nil
        }
        self.init(hostValue: host.addressValue, prefixLength: prefixLength)
    }

    init?(hostBytes: [UInt8], netmaskBytes: [UInt8]) {
        guard hostBytes.count == 4, netmaskBytes.count == 4 else { return nil }
        let hostValue = Self.value(hostBytes)
        let mask = Self.value(netmaskBytes)
        guard Self.isContiguousMask(mask) else { return nil }
        let prefix = mask.nonzeroBitCount
        guard (24...30).contains(prefix), LocalWifiPrinterEndpoint(octets: hostBytes, port: 9_100) != nil else {
            return nil
        }
        self.init(hostValue: hostValue, prefixLength: prefix)
    }

    private init?(hostValue: UInt32, prefixLength: Int) {
        let mask = UInt32.max << UInt32(32 - prefixLength)
        let network = hostValue & mask
        let broadcast = network | ~mask
        guard hostValue != network, hostValue != broadcast else { return nil }
        self.hostValue = hostValue
        self.networkValue = network
        self.broadcastValue = broadcast
        self.prefixLength = prefixLength
    }

    /// Varredura da /24 a /30 inteira. Não há Bonjour: impressora térmica de balcão não anuncia
    /// serviço nenhum, e a única forma de achá-la é bater na porta 9100 de cada endereço.
    func discoveryCandidates(port: Int = 9_100) -> [LocalWifiPrinterEndpoint] {
        guard port == 9_100 else { return [] }
        return ((networkValue + 1)..<broadcastValue).compactMap { value in
            guard value != hostValue else { return nil }
            return LocalWifiPrinterEndpoint(octets: Self.bytes(value), port: port)
        }
    }

    func isSelectable(_ endpoint: LocalWifiPrinterEndpoint) -> Bool {
        let value = endpoint.addressValue
        return value > networkValue && value < broadcastValue && value != hostValue
    }

    var description: String { "LocalWifiPrinterSubnet([REDACTED])" }
    var debugDescription: String { description }

    private static func value(_ bytes: [UInt8]) -> UInt32 {
        bytes.reduce(0) { partial, byte in (partial << 8) | UInt32(byte) }
    }

    private static func bytes(_ value: UInt32) -> [UInt8] {
        [
            UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff), UInt8(value & 0xff),
        ]
    }

    private static func isContiguousMask(_ mask: UInt32) -> Bool {
        let inverted = ~mask
        return inverted == 0 || (inverted & (inverted + 1)) == 0
    }
}

public struct LocalWifiPrinterNetwork: Hashable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    let subnet: LocalWifiPrinterSubnet

    public var description: String { "LocalWifiPrinterNetwork([REDACTED])" }
    public var debugDescription: String { description }
}

public protocol LocalWifiPrinterNetworkProviding {
    func currentNetwork() -> LocalWifiPrinterNetwork?
}

public struct SystemLocalWifiPrinterNetworkProvider: LocalWifiPrinterNetworkProviding {
    /**
     Quais interfaces valem como "a Wi-Fi local", em ordem de preferência. `nil` aceita qualquer uma.

     **Por que o parâmetro existe, e por que o default é `["en0"]`.** Em iPhone e iPad `en0` é a
     Wi-Fi, sempre — o default preserva byte a byte o que o kit já fazia, e nenhuma chamada
     existente muda. **Num Mac isso não é garantido:** `en0` pode ser a Ethernet embutida, um
     adaptador Thunderbolt, ou nada; o nome depende da ordem em que o sistema enumerou as placas.
     Não há nome fixo para procurar, e é por isso que a alternativa é `nil` em vez de outro nome.

     Aceitar qualquer interface não afrouxa o que protege: quem decide continua sendo
     ``LocalWifiPrinterSubnet``, que só aceita IPv4 **RFC1918** com prefixo /24 a /30 — o que já
     descarta o loopback (127/8), o link-local (169.254/16) e os túneis, sem precisar conhecer o
     nome de nenhum deles.
     */
    private let interfaceNames: [String]?

    public init(interfaceNames: [String]? = ["en0"]) {
        self.interfaceNames = interfaceNames
    }

    public func currentNetwork() -> LocalWifiPrinterNetwork? {
        Self.network(from: Self.systemInterfaces(), acceptedNames: interfaceNames)
    }

    /// Leitura crua do sistema, separada da escolha para a escolha poder ser provada sem placa de
    /// rede nenhuma — em CI, num Mac de Ethernet ou num iPhone, o mesmo teste vale.
    private static func systemInterfaces() -> [(name: String, address: [UInt8], netmask: [UInt8])] {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return [] }
        defer { freeifaddrs(interfaces) }

        var found: [(name: String, address: [UInt8], netmask: [UInt8])] = []
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            let interface = current.pointee
            guard
                let address = interface.ifa_addr,
                let netmask = interface.ifa_netmask,
                address.pointee.sa_family == UInt8(AF_INET),
                netmask.pointee.sa_family == UInt8(AF_INET)
            else {
                continue
            }
            let addressIn = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
            let netmaskIn = netmask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
            found.append((
                name: String(cString: interface.ifa_name),
                address: bytes(addressIn.sin_addr),
                netmask: bytes(netmaskIn.sin_addr)
            ))
        }
        return found
    }

    /**
     A escolha, pura: primeira interface aceita cuja sub-rede o kit reconhece.

     Com lista de nomes, a **ordem da lista** manda — quem pediu `["en0", "en1"]` quer `en0` mesmo
     que `en1` apareça antes na enumeração do sistema. Sem lista, manda a ordem do sistema, que é a
     única preferência que existe quando ninguém sabe o nome.
     */
    static func network(
        from interfaces: [(name: String, address: [UInt8], netmask: [UInt8])],
        acceptedNames: [String]?
    ) -> LocalWifiPrinterNetwork? {
        let ordered: [(name: String, address: [UInt8], netmask: [UInt8])]
        if let acceptedNames {
            ordered = acceptedNames.flatMap { name in interfaces.filter { $0.name == name } }
        } else {
            ordered = interfaces
        }
        for interface in ordered {
            guard let subnet = LocalWifiPrinterSubnet(
                hostBytes: interface.address,
                netmaskBytes: interface.netmask
            ) else {
                continue
            }
            return LocalWifiPrinterNetwork(subnet: subnet)
        }
        return nil
    }

    private static func bytes(_ address: in_addr) -> [UInt8] {
        let value = UInt32(bigEndian: address.s_addr)
        return [
            UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff), UInt8(value & 0xff),
        ]
    }
}

public enum LocalWifiPrinterState: Equatable {
    case idle
    case searching
    case candidatesFound
    case testing
    case awaitingConfirmation
    case ready
    case wifiUnavailable
    case invalidAddress
    case printerUnavailable
    case printing
    case failed

    public var title: String {
        switch self {
        case .idle: return "Escolha uma impressora"
        case .searching: return "Procurando na Wi-Fi"
        case .candidatesFound: return "Escolha a impressora"
        case .testing: return "Enviando comprovante"
        case .awaitingConfirmation: return "Confirme o comprovante"
        case .ready: return "Impressora pronta"
        case .wifiUnavailable: return "Wi-Fi local não disponível"
        case .invalidAddress: return "Endereço não disponível"
        case .printerUnavailable: return "Impressora não encontrada"
        case .printing: return "Imprimindo o cupom"
        case .failed: return "Não foi possível imprimir"
        }
    }

    public var message: String {
        switch self {
        case .idle: return "Escolha o modelo e procure uma impressora na rede Wi-Fi local."
        case .searching: return "Procurando possíveis impressoras na rede Wi-Fi local."
        case .candidatesFound: return "Escolha uma candidata pelo IP para enviar um comprovante de teste."
        case .testing: return "Aguarde o envio do comprovante de teste."
        case .awaitingConfirmation: return "Confirme se o papel saiu na impressora escolhida."
        case .ready: return "A impressora confirmada está pronta para receber envios."
        case .wifiUnavailable: return "Conecte o iPhone ou iPad à mesma Wi-Fi privada da impressora e tente novamente."
        case .invalidAddress: return "Informe um IP privado da Wi-Fi atual e uma porta válida. Na i9FULL 2, use normalmente 9100."
        case .printerUnavailable: return "Confira energia, cabo Ethernet da impressora e a conexão ao mesmo roteador."
        case .printing: return "Enviando o cupom para a impressora confirmada."
        case .failed: return "Tente novamente. A seleção atual não foi mantida."
        }
    }

    public var isBusy: Bool { self == .searching || self == .testing || self == .printing }
}
