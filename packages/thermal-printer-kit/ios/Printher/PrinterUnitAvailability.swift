import Foundation
import ThermalPrinterKit

/**
 O que a lista de impressoras aceita num instante, unidade por unidade.

 Existe por causa do defeito medido no iPhone 7 em 21/08. Quatro impressoras instaladas — três
 Bluetooth e a J-SPEED P80 de rede, que era a ativa e estava desligada — e a tela **inteira**
 ficava cinza: os quatro "Testar", as quatro engrenagens, as quatro lixeiras e o "Adicionar
 impressora". Permanente, sem uma linha dizendo o que acontecia, e sem saída: não dava para trocar
 de impressora, excluir a que travava nem adicionar outra. A causa era uma só condição de tela
 alimentada pelos dois transportes ao mesmo tempo.

 Três regras saem daí, e é para prová-las sem tela que elas moram fora da View:

 1. **Ocupação é do transporte que está ocupado.** Bytes a caminho pelo Wi-Fi não dizem nada sobre
    as unidades Bluetooth, e vice-versa.
 2. **Procurar não é ocupar.** Varredura não escreve no fio; ela informa o card daquela unidade e
    não fecha ação nenhuma. Tratá-la como envio foi o que travou a tela por causa de uma
    impressora desligada.
 3. **Saída de emergência não desabilita.** Excluir e adicionar são o único caminho de volta quando
    a ativa não responde, e nenhum estado os fecha.

 O que continua bloqueando é o que sempre precisou bloquear: um envio em curso naquele transporte
 — o controlador guarda uma conexão por meio físico, e um segundo envio seria o segundo cupom na
 mesma impressora — e a instalação em curso, com a pergunta do papel ou o assistente abertos.
 */
struct PrinterUnitActivity: Equatable {
    /// Esta unidade já é a que recebe os recibos.
    var isActive = false
    /// O transporte **desta** unidade está com bytes a caminho.
    var transportIsSending = false
    /// Um comprovante de card está a caminho por este transporte, de qualquer unidade dele: mirar
    /// outra moveria a conexão em memória no meio do envio.
    var receiptIsUnderwayOnTransport = false
    /// A pergunta do papel ou o assistente estão abertos.
    var setupIsOpen = false
}

enum PrinterUnitAvailability {
    /// Trocar quem recebe os recibos. Fechada só quando esta já é a ativa ou quando um envio deste
    /// transporte está em curso — trocar de impressora no meio de um cupom moveria a conexão dele.
    static func allowsActivation(_ activity: PrinterUnitActivity) -> Bool {
        !activity.isActive && !isSending(activity)
    }

    /// Mandar o comprovante desta unidade.
    static func allowsTest(_ activity: PrinterUnitActivity) -> Bool { !isSending(activity) }

    /// Abrir as opções operacionais desta unidade.
    static func allowsConfiguration(_ activity: PrinterUnitActivity) -> Bool { !isSending(activity) }

    /// Sempre. Excluir é a saída de emergência: com a ativa inalcançável, é por ela que a pessoa
    /// volta a ter uma impressora.
    static func allowsRemoval(_ activity: PrinterUnitActivity) -> Bool { true }

    /// Sempre, e pelo mesmo motivo: sem esta porta, quem tem só uma impressora e ela não responde
    /// fica sem caminho nenhum.
    static func allowsAddingPrinter(_ activity: PrinterUnitActivity) -> Bool { true }

    private static func isSending(_ activity: PrinterUnitActivity) -> Bool {
        activity.transportIsSending || activity.receiptIsUnderwayOnTransport || activity.setupIsOpen
    }
}

/// Em que pé está o reencontro de uma unidade, do ponto de vista do card dela.
enum PrinterUnitReach: Equatable {
    /// Nada a dizer: ou ela está pronta, ou não é dela que o transporte está atrás.
    case none
    /// O transporte está procurando **esta** impressora agora.
    case searching
    /// A procura acabou sem ela. Não é silêncio nem espera eterna: é recusa honesta.
    case unreachable
}

enum PrinterUnitReachCopy {
    /**
     A leitura do reencontro para o card.

     `isTheUnitBeingReached` vem do id que o controlador publica: o transporte procura uma unidade
     por vez, e dizer "procurando" no card errado seria pior que não dizer nada.
     */
    static func reach(
        of progress: PrinterConnectionProgress,
        isTheUnitBeingReached: Bool
    ) -> PrinterUnitReach {
        guard isTheUnitBeingReached else { return .none }
        switch progress {
        case .connecting: return .searching
        case .connected: return .none
        case .unreachable: return .unreachable
        }
    }

    /// O que o card diz, no idioma da casa. `nil` quando não há o que dizer.
    static func message(
        _ reach: PrinterUnitReach,
        displayName: String,
        transport: PrinterTransport
    ) -> String? {
        switch reach {
        case .none:
            return nil
        case .searching:
            switch transport {
            case .bluetooth: return "Procurando \(displayName) por perto…"
            case .localWifi: return "Procurando \(displayName) na Wi-Fi…"
            }
        case .unreachable:
            switch transport {
            case .bluetooth:
                return "\(displayName) não respondeu. Ligue ela por perto e toque em Testar."
            case .localWifi:
                return "\(displayName) não respondeu. Ligue ela na mesma Wi-Fi e toque em Testar."
            }
        }
    }
}
