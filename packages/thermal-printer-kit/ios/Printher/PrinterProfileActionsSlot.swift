import SwiftUI
import ThermalPrinterKit

/// Ponto neutro para o app hospedeiro acrescentar ações a um perfil medido.
///
/// O apagamento para `AnyView` mantém os inicializadores públicos estáveis e evita tornar toda a
/// superfície genérica. O slot recebe apenas o perfil já confirmado, sem expor rascunho, destino
/// efêmero ou estado interno da sessão.
@available(iOS 15.0, macOS 12.0, *)
struct PrinterProfileActionsSlot {
    private let makeContent: ((MeasuredProfile) -> AnyView)?

    init(_ makeContent: ((MeasuredProfile) -> AnyView)? = nil) {
        self.makeContent = makeContent
    }

    var isEmpty: Bool { makeContent == nil }

    func content(for profile: MeasuredProfile) -> AnyView? {
        makeContent?(profile)
    }
}
