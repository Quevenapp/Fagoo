import Foundation

/**
 Um cupom pronto para virar bytes ESC/POS.

 Existe para manter a impressão sem domínio: quem sabe o que é uma venda, um item ou um relatório
 é a camada de cima. Aqui só se sabe montar bytes e mandar para a impressora.
 */
public protocol ThermalReceiptPayload: AnyObject {
    func receiptBytes(layout: ReceiptLayout) -> Data?

    /**
     Zera o material sensível depois da impressão.

     Uma assinatura de cupom pode ser token de capacidade: se sobrar na memória, sobra num heap dump.
     Os controladores chamam isto mesmo quando a impressão falha no meio.
     */
    func clear()
}
