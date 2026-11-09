import Foundation

/**
 Serializa trabalhos de impressão na ordem em que foram aceitos.

 Uma impressora térmica é um destino serial. Duas fichas da mesma venda não podem disputar o
 transporte, e uma falha tardia nunca pode fazer a fila repetir o trabalho por conta própria.
 */
@MainActor
public final class ThermalPrintJobQueue {
    private struct Job {
        let run: () async -> Void
        let cancel: (ThermalPrintResult) -> Void
    }

    private var jobs: [Job] = []
    private var isDraining = false

    /// Fila vazia. Existe explicitamente porque o inicializador implícito de uma classe pública
    /// continua `internal`: sem este, outro módulo enxergaria a fila e não conseguiria criá-la, e
    /// a alternativa seria cada módulo ter a sua — que é justamente a duplicação que esta classe
    /// existe para evitar. Corpo vazio, mesmo estado inicial de sempre.
    public init() {}

    /// Enfileira e aguarda o desfecho final deste trabalho, preservando FIFO.
    public func run(
        _ operation: @escaping () async -> ThermalPrintResult
    ) async -> ThermalPrintResult {
        await withCheckedContinuation { continuation in
            append(Job(
                run: { continuation.resume(returning: await operation()) },
                cancel: { continuation.resume(returning: $0) }
            ))
        }
    }

    /**
     Compatibilidade explícita para chamadores que só precisam saber se o trabalho entrou na fila.

     O retorno nunca significa papel entregue. O desfecho continua sendo consumido internamente
     apenas para atualizar o estado; não existe repetição automática em nenhum ramo.
     */
    public func accept(
        _ operation: @escaping () async -> ThermalPrintResult
    ) {
        append(Job(
            run: { _ = await operation() },
            cancel: { _ in }
        ))
    }

    /// Encerra apenas o que ainda não começou. O trabalho ativo conserva o resultado real do
    /// transporte; o controller usa sua geração para impedir que ele restaure estado cancelado.
    public func cancelPending(returning result: ThermalPrintResult) {
        let pending = jobs
        jobs.removeAll()
        for job in pending { job.cancel(result) }
    }

    private func append(_ job: Job) {
        jobs.append(job)
        guard !isDraining else { return }
        isDraining = true
        // A própria fila fica viva até concluir todos os trabalhos. Se o controller sair de
        // memória enquanto um chamador aguarda `run`, capturar `self` fracamente deixaria a
        // continuation suspensa para sempre.
        Task { @MainActor in
            await drain()
        }
    }

    private func drain() async {
        while !jobs.isEmpty {
            let job = jobs.removeFirst()
            await job.run()
        }
        isDraining = false
    }
}
