import Foundation

/**
 O freio de mão do raster: nunca deixa sair mais que `bytesPerSecond` bytes por segundo.

 **Por que existe**, medido na bancada em 20/08 com a Inico T210 por BLE: os mesmos 120 dots saem
 com 15,0 mm tanto numa banda única quanto em quinze bandas de oito, e um logotipo de 2 KB no topo
 de um cupom sai correto — mas a foto de 28 KB em largura cheia sai 22% mais curta, coerente,
 apenas encolhida. O que separa o caso bom do ruim é vazão, não geometria nem número de bandas: a
 firmware descarta **linhas inteiras** quando os bytes chegam mais rápido do que a cabeça térmica
 imprime. O ACK do ATT prova recepção no rádio, nunca impressão — é por isso que a escrita
 confirmada, que já dita o ritmo do enlace, não protege deste defeito.

 Não há heurística por modelo aqui: o número vem do perfil medido, e perfil sem medição continua
 `nil`, que é byte a byte como sempre foi.

 O tipo é puro e o relógio é argumento: quem espera é o transporte, com `asyncAfter`, porque
 segurar a fila do CoreBluetooth num `sleep` travaria os próprios callbacks que fazem o cupom
 avançar. Espelha o `RasterThroughputPacer` do Android.
 */
struct RasterThroughputPacer: Equatable {
    /// Faixa aceita, espelhada de ``PrinterCapabilities/allowedRasterBytesPerSecond``. Um teto fora
    /// dela é ignorado em vez de virar espera absurda: aqui não é o lugar de recusar perfil, e o
    /// tipo que valida capacidade já recusou antes de chegar ao disco.
    private let bytesPerSecond: Int?
    private var nextChunkAllowedAt: TimeInterval?

    init(bytesPerSecond: Int?) {
        if let bytesPerSecond,
           PrinterCapabilities.allowedRasterBytesPerSecond.contains(bytesPerSecond) {
            self.bytesPerSecond = bytesPerSecond
        } else {
            self.bytesPerSecond = nil
        }
    }

    /// Sem teto declarado ninguém espera, e os bytes saem exatamente como saíam.
    var paces: Bool { bytesPerSecond != nil }

    /**
     Quanto falta para o próximo bloco poder sair.

     O primeiro bloco nunca espera: o teto limita a **taxa**, e segurar o começo só atrasaria o
     cupom sem tirar byte nenhum da fila da impressora.
     */
    func delay(at now: TimeInterval) -> TimeInterval {
        guard let nextChunkAllowedAt else { return 0 }
        return max(0, nextChunkAllowedAt - now)
    }

    /// Registra que um bloco saiu agora e agenda quando o próximo pode sair.
    ///
    /// O `max` reabre a janela quando o transporte já anda mais devagar que o teto: sem ele o
    /// atraso viraria crédito, e o crédito viraria rajada no bloco seguinte — que é o próprio
    /// defeito que o teto existe para conter.
    mutating func recordChunk(bytes: Int, at now: TimeInterval) {
        guard let bytesPerSecond, bytes > 0 else { return }
        let base = max(now, nextChunkAllowedAt ?? now)
        nextChunkAllowedAt = base + TimeInterval(bytes) / TimeInterval(bytesPerSecond)
    }
}
