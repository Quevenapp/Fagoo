import Foundation

/// Envio de comando ESC/POS cru.
///
/// Mora no pacote, e não no app de bancada, porque tem dois públicos com o mesmo direito a ele: nós,
/// medindo hardware que compramos, e o usuário travado com um modelo que nunca teremos. É dele que
/// sai diagnóstico aproveitável — "mandei `1d5600` e não cortou" diz o que "não imprime" não diz.
///
/// Explicação obrigatória antes de qualquer envio. Ela fica em produção e em teste para que uma
/// simplificação visual não transforme uma ferramenta de diagnóstico em um botão destrutivo
/// silencioso.
public let rawCommandRiskWarning =
    "Comandos ESC/POS podem gravar configuração não volátil — emulação, velocidade serial ou " +
    "densidade — e deixar a impressora alterada mesmo após desligar; a pessoa deve conhecer " +
    "o efeito e o comando de reversão."

public protocol RawCommandSending {
    /// A conclusão só pode ser chamada quando o transporte não retiver mais o buffer.
    func send(_ buffer: NSMutableData, completion: @escaping (Result<Void, Error>) -> Void)
}

/// Buffer efêmero que nunca serializa ou descreve os bytes recebidos.
public final class RawHexCommand: CustomStringConvertible {
    public static let maximumByteCount = 256

    private let buffer: NSMutableData
    private var consumed = false

    public var byteCount: Int { buffer.length }
    public var description: String { "RawHexCommand(byteCount: \(byteCount), content: [REDACTED])" }

    public init(text: String) throws {
        let compact = text.filter { !$0.isWhitespace }
        guard !compact.isEmpty else { throw RawHexCommandError.empty }
        guard compact.count.isMultiple(of: 2) else { throw RawHexCommandError.incompleteByte }
        guard compact.count / 2 <= Self.maximumByteCount else { throw RawHexCommandError.tooLong }
        guard compact.allSatisfy(\.isHexDigit) else { throw RawHexCommandError.invalidCharacter }

        var bytes = [UInt8]()
        bytes.reserveCapacity(compact.count / 2)
        var index = compact.startIndex
        while index < compact.endIndex {
            let next = compact.index(index, offsetBy: 2)
            guard let byte = UInt8(compact[index..<next], radix: 16) else {
                throw RawHexCommandError.invalidCharacter
            }
            bytes.append(byte)
            index = next
        }
        buffer = NSMutableData(bytes: &bytes, length: bytes.count)
        _ = bytes.withUnsafeMutableBytes { raw in
            raw.initializeMemory(as: UInt8.self, repeating: 0)
        }
    }

    public func send(using sender: RawCommandSending, completion: @escaping (Result<Void, Error>) -> Void) {
        precondition(!consumed, "O comando cru já foi consumido.")
        consumed = true
        // Retém o próprio comando até o callback. Se só o NSMutableData fosse capturado, o
        // `deinit` poderia zerá-lo enquanto o transporte ainda estivesse preparando o envio.
        sender.send(buffer) { [self] result in
            buffer.resetBytes(in: NSRange(location: 0, length: buffer.length))
            completion(result)
        }
    }

    public func clear() {
        guard !consumed else { return }
        consumed = true
        buffer.resetBytes(in: NSRange(location: 0, length: buffer.length))
    }

    deinit {
        buffer.resetBytes(in: NSRange(location: 0, length: buffer.length))
    }
}

public enum RawHexCommandError: LocalizedError {
    case empty
    case incompleteByte
    case invalidCharacter
    case tooLong

    public var errorDescription: String? {
        switch self {
        case .empty: return "Informe ao menos um byte hexadecimal."
        case .incompleteByte: return "Cada byte hexadecimal precisa de dois dígitos."
        case .invalidCharacter: return "O comando deve conter apenas bytes hexadecimais."
        case .tooLong: return "O comando cru pode ter no máximo 256 bytes."
        }
    }
}

public struct RawCommandConfirmation: Equatable {
    public let byteCount: Int
    public let warning = rawCommandRiskWarning
}

public final class RawCommandController {
    private let sender: RawCommandSending
    private var pending: RawHexCommand?

    public init(sender: RawCommandSending) {
        self.sender = sender
    }

    public func prepare(_ text: String) throws -> RawCommandConfirmation {
        pending?.clear()
        let command = try RawHexCommand(text: text)
        pending = command
        return RawCommandConfirmation(byteCount: command.byteCount)
    }

    public func confirm(completion: @escaping (Result<Void, Error>) -> Void) {
        guard let command = pending else {
            completion(.failure(RawCommandControllerError.nothingPending))
            return
        }
        pending = nil
        command.send(using: sender, completion: completion)
    }

    public func cancel() {
        pending?.clear()
        pending = nil
    }
}

public enum RawCommandControllerError: LocalizedError {
    case nothingPending

    public var errorDescription: String? { "Nenhum comando cru aguarda confirmação." }
}
