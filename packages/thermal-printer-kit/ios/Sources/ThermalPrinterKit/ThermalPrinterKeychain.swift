import Foundation
import Security

enum ThermalPrinterKeychainError: Error {
    case unusableItem
}

/**
 Onde o item do chaveiro é realmente gravado.

 A costura existe por um motivo sem contorno: grupo de acesso é entitlement assinado, e a suíte
 lógica roda um binário sem assinatura nenhuma. Sem uma dublê, "o grupo entra em **toda** query"
 só teria prova no aparelho — e é exatamente a query que esquece o grupo que faz a extensão abrir
 um item próprio e não achar a impressora que o app adotou.
 */
protocol ThermalPrinterKeychainBackend: AnyObject {
    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, data: Data?)
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func add(_ item: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

/// O chaveiro do sistema, único caminho em produção.
final class SecItemKeychainBackend: ThermalPrinterKeychainBackend {
    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, data: Data?) {
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        return (status, value as? Data)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func add(_ item: [String: Any]) -> OSStatus {
        SecItemAdd(item as CFDictionary, nil)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

/// Persistência privada do kit. Serviço e contas são neutros; aliases de consumidores pertencem
/// ao importador fornecido pelo próprio app e nunca são conhecidos por esta implementação.
final class ThermalPrinterKeychain: @unchecked Sendable {
    private let service = "br.com.thermalprinterkit.selection"
    /// Grupo de acesso do chaveiro, quando o hospedeiro compartilha o item com suas extensões.
    /// `nil` é o comportamento histórico e o default em toda a cadeia.
    private let accessGroup: String?
    private let backend: any ThermalPrinterKeychainBackend

    init(
        accessGroup: String? = nil,
        backend: any ThermalPrinterKeychainBackend = SecItemKeychainBackend()
    ) {
        self.accessGroup = accessGroup
        self.backend = backend
    }

    func read<T: Decodable>(_ type: T.Type, account: String) throws -> T? {
        var query = itemQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let result = backend.copyMatching(query)
        if result.status == errSecItemNotFound { return nil }
        guard result.status == errSecSuccess, let data = result.data else {
            throw ThermalPrinterKeychainError.unusableItem
        }
        return try JSONDecoder().decode(type, from: data)
    }

    func write<T: Encodable>(_ value: T, account: String) throws {
        let data = try JSONEncoder().encode(value)
        let query = itemQuery(account: account)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = backend.update(query, attributes: attributes)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw ThermalPrinterKeychainError.unusableItem }
        var add = query
        attributes.forEach { add[$0.key] = $0.value }
        guard backend.add(add) == errSecSuccess else {
            throw ThermalPrinterKeychainError.unusableItem
        }
    }

    func remove(account: String) throws {
        let status = backend.delete(itemQuery(account: account))
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ThermalPrinterKeychainError.unusableItem
        }
    }

    /**
     A query que identifica o item, e o único lugar onde o grupo de acesso entra.

     Ler, gravar e apagar passam por aqui porque o item do chaveiro é endereçado pela query
     **inteira**: uma delas sem o grupo endereçaria outro item, e o defeito apareceria como
     seleção que some ao voltar da extensão — nunca como erro.

     A chave só existe quando o hospedeiro pede. `kSecAttrAccessGroup` com um grupo que o
     entitlement não declara faz a operação inteira falhar, e quem nunca pediu compartilhamento
     perderia a seleção que já tinha gravado.
     */
    private func itemQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}
