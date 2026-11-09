import Foundation
import ThermalPrinterKit

/**
 Em que pé está a reconexão de uma impressora recém-ativada.

 A escolha e a prontidão são informações diferentes: ``ThermalPrintingCoordinator/activateInstallation(_:)``
 grava e publica no mesmo toque — a lista muda na hora —, e só depois a varredura vai atrás da
 unidade. É esta separação que este tipo serve: dizer quando o aviso "Conectando…" sai da tela, sem
 transformar uma varredura em andamento em recusa prematura nem uma recusa em tela travada.
 */
enum PrinterConnectionProgress: Equatable {
    /// A varredura ainda pode encontrar a unidade. Continuar esperando.
    case connecting
    /// A unidade respondeu e está pronta para receber cupom.
    case connected
    /// Não adianta mais esperar. A escolha continua gravada; a conexão é que não aconteceu.
    case unreachable
}

/// Traduz o estado de cada transporte para a espera da tela. Fica fora da View porque é a única
/// parte do "Conectando…" que dá para provar sem aparelho.
enum PrinterConnectionReadiness {
    /**
     Bluetooth.

     `candidatesFound` continua sendo espera: com identidade guardada, a retomada BLE deixa a
     varredura correndo e adota assim que a unidade dela anunciar — desistir na primeira leva de
     candidatas seria recusar uma impressora que ainda vai aparecer. `idle` é recusa porque a
     reconexão liga a varredura no mesmo toque: encontrar o controlador parado depois disso
     significa que não havia o que retomar.
     */
    static func progress(of state: BluetoothPrinterState) -> PrinterConnectionProgress {
        switch state {
        case .ready:
            return .connected
        case .idle, .unauthorized, .poweredOff, .printerUnavailable, .failed:
            return .unreachable
        case .searching, .candidatesFound, .connecting, .testing, .awaitingConfirmation, .printing:
            return .connecting
        }
    }

    /**
     Wi-Fi.

     Aqui `candidatesFound` é recusa, e a diferença com o Bluetooth é real: a varredura de rede
     termina de uma vez, e quando nenhuma das que responderam é a unidade guardada o controlador
     abandona a retomada e passa a listar candidatas. Não há segunda leva para esperar.
     */
    static func progress(of state: LocalWifiPrinterState) -> PrinterConnectionProgress {
        switch state {
        case .ready:
            return .connected
        case .idle, .candidatesFound, .wifiUnavailable, .invalidAddress, .printerUnavailable, .failed:
            return .unreachable
        case .searching, .testing, .awaitingConfirmation, .printing:
            return .connecting
        }
    }

    /// Quantas amostras de 100 ms cada transporte merece antes de a espera virar recusa.
    ///
    /// São os mesmos prazos que os controladores já se dão para reencontrar a impressora adotada
    /// antes de imprimir: quinze segundos no BLE, que anuncia devagar, e oito na varredura de uma
    /// /24. Um prazo mais curto aqui faria a tela desistir de uma impressora que o cupom ainda
    /// alcançaria.
    static func attemptSamples(for transport: PrinterTransport) -> Int {
        switch transport {
        case .bluetooth: return 150
        case .localWifi: return 80
        }
    }
}
