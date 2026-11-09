import Foundation

/// Erro devolvido pela API no formato {"error":{"code","message","request_id"}} ou falha de rede traduzida.
struct APIError: LocalizedError, Equatable {
    var status: Int
    var code: String
    var message: String
    var requestId: String?
    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 }
    var isIdempotencyConflict: Bool { code == "idempotency_conflict" }
    var isDefinitiveWriteRejection: Bool { (400..<500).contains(status) && ![408, 429].contains(status) && !["operation_unknown", "idempotency_conflict"].contains(code) }

    static func describe(_ error: Error) -> String {
        if let e = error as? APIError { return e.message }
        if let e = error as? URLError {
            switch e.code {
            case .cannotFindHost, .dnsLookupFailed: return "Servidor não encontrado. Confira o endereço e a conexão."
            case .timedOut: return "O servidor demorou a responder."
            case .serverCertificateUntrusted, .secureConnectionFailed, .serverCertificateHasBadDate: return "Falha de certificado HTTPS no servidor."
            case .notConnectedToInternet, .networkConnectionLost: return "Sem conexão com a internet."
            default: return "Falha de rede. Verifique sua conexão."
            }
        }
        return error.localizedDescription
    }
}
