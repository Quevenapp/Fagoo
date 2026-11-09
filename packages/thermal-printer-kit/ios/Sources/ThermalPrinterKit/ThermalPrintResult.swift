import Foundation

/**
 Quanto o kit sabe sobre a entrega quando um envio falha.

 `notSent` significa que a falha aconteceu antes do primeiro byte do recibo. `indeterminate`
 significa que a transmissão começou e o kit não pode afirmar se nada, parte ou tudo chegou à
 impressora; esse estado nunca autoriza reimpressão automática.
 */
public enum ThermalPrintDelivery: Equatable, Sendable {
    case notSent
    case indeterminate
}

/** Resultado final de um trabalho, e não a mera aceitação dele pela fila. */
public enum ThermalPrintResult: Equatable, Sendable {
    /** O transporte concluiu o envio. Papel físico ainda depende da prova na impressora. */
    case delivered

    /** O transporte falhou, distinguindo com segurança se a transmissão chegou a começar. */
    case failed(message: String, delivery: ThermalPrintDelivery)
}
