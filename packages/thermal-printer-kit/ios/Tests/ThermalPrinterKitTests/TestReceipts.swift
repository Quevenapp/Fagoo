import Foundation
@testable import ThermalPrinterKit

/**
 Payload exclusivo dos testes do kit.

 Ele reproduz os mesmos bytes históricos que cobriram a extração, mas não importa nem conhece os
 tipos de domínio do consumidor. Assim a suíte continua protegendo raster, layout e limpeza de
 capacidade sem acoplar o kit ao vocabulário que originou o vetor.
 */
final class TestReceiptPayload: ThermalReceiptPayload, CustomStringConvertible, CustomDebugStringConvertible {
    private var qrPayload: Data?
    private let stallName: String?

    init(qrPayload: String, stallName: String?) {
        self.qrPayload = Data(qrPayload.utf8)
        self.stallName = stallName
    }

    func receiptBytes(layout: ReceiptLayout) -> Data? {
        guard let bytes = qrPayload,
              let qrText = String(data: bytes, encoding: .utf8),
              let qr = EscPos.qrRaster(payload: qrText, widthDots: layout.qrWidthDots)
        else { return nil }

        // Os textos de domínio abaixo são um vetor test-only congelado pelo M1. Nomes de tipos,
        // fixtures e APIs foram neutralizados; mudar estas strings enfraqueceria a prova byte a byte.
        var data = EscPos.initialize()
        data.append(layout.text(layout.wrap("Quermesse São João") + "\n", alignment: 1, bold: true))
        data.append(layout.text(String(Self.separator.prefix(layout.columns)) + "\n", alignment: 0))
        data.append(
            layout.text(
                layout.wrap("CERVEJA", scale: 2) + "\n",
                alignment: 1,
                bold: true,
                size: Self.doubleSize
            )
        )
        data.append(layout.text("R$ 10,00\n", alignment: 1))
        data.append(qr)
        data.append(layout.text("Ficha 1-4237\n", alignment: 1, bold: true))
        if let stallName {
            data.append(layout.text(layout.wrap("Barraca: \(stallName)") + "\n", alignment: 1))
        }
        data.append(layout.finish())
        return data
    }

    func clear() {
        let range = 0..<(qrPayload?.count ?? 0)
        qrPayload?.resetBytes(in: range)
        qrPayload = nil
    }

    var description: String { "TestReceiptPayload(qrPayload=[REDACTED])" }
    var debugDescription: String { description }

    private static let doubleSize: UInt8 = 17
    private static let separator = String(repeating: "-", count: 48)
}

func testReceipt(
    qrPayload: String = protectedQRVector,
    stallName: String? = "Bebidas"
) -> TestReceiptPayload {
    TestReceiptPayload(qrPayload: qrPayload, stallName: stallName)
}

/// Vetor sintético e fixo de compatibilidade. Seus bytes permanecem intocados no M2.
let protectedQRVector =
    "QF1.1.4237.3.792II2EnbL76ypQHAR0l1juluh66aEAEvG71Lrabm1GdltnJWIWL4nimMAFGC9A4QtcZC6CZ_8trMy7XSV8pCQ"

func contains(_ data: Data, _ pattern: [UInt8]) -> Bool {
    guard !pattern.isEmpty, data.count >= pattern.count else { return false }
    let bytes = Array(data)
    return (0...(bytes.count - pattern.count)).contains { start in
        Array(bytes[start..<(start + pattern.count)]) == pattern
    }
}
