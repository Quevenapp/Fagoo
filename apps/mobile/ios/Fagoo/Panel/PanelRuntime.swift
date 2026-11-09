// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import Combine
import AVFoundation
import ThermalPrinterKit

@MainActor
final class PanelSpeech: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var completion: CheckedContinuation<Bool, Never>?
    override init() { super.init(); synthesizer.delegate = self }
    func say(_ text: String, volume: Float) async -> Bool {
        stop()
        return await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: false); return }
                completion = continuation
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
                try? AVAudioSession.sharedInstance().setActive(true)
                let utterance = AVSpeechUtterance(string: text)
                utterance.voice = AVSpeechSynthesisVoice(language: "pt-BR"); utterance.volume = min(1, max(0, volume))
                synthesizer.speak(utterance)
            }
        }, onCancel: { Task { @MainActor in self.stop() } })
    }
    func stop() { synthesizer.stopSpeaking(at: .immediate); finish(false) }
    private func finish(_ value: Bool) { let callback = completion; completion = nil; callback?.resume(returning: value); try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finish(true) }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finish(false) }
}

final class FagooTicketReceipt: ThermalReceiptPayload {
    private var payload: PanelJobPayload?
    init(_ payload: PanelJobPayload) { self.payload = payload }
    func clear() { payload = nil }
    func receiptBytes(layout: ReceiptLayout) -> Data? {
        guard let payload, let number = payload.display_number else { return nil }
        // Strip controls so server strings cannot introduce printer commands.
        func clean(_ text: String) -> String { String(text.unicodeScalars.filter { $0.value >= 32 && $0.value != 127 }.prefix(250)) }
        var data = EscPos.initialize()
        data += layout.text(clean(payload.unit ?? "FAGOO") + "\n", alignment: 1, bold: true)
        data += layout.text(clean(payload.queue ?? "Sua senha") + "\n", alignment: 1)
        data += layout.text(clean(number) + "\n", alignment: 1, bold: true, size: 0x11)
        if let link = payload.tracking_url, let url = URL(string: link), url.scheme == "https", url.user == nil, url.password == nil,
           let qr = layout.qrRaster(payload: link) {
            data += qr; data += layout.text("Acompanhe pela internet\n", alignment: 1)
        }
        if let footer = payload.footer, !footer.isEmpty { data += layout.text(clean(footer) + "\n", alignment: 1) }
        data += layout.finish(); return data
    }
}

@MainActor
final class PanelRuntime: ObservableObject {
    @Published private(set) var device: PanelDevice?
    @Published private(set) var snapshot: PanelSnapshot?
    @Published private(set) var online = false
    @Published private(set) var busy = false
    @Published private(set) var message = "Conectando…"
    @Published private(set) var issued: PanelTicket?
    @Published private(set) var pendingCommand: String?
    @Published private(set) var effectNotice: String?
    let printer = ThermalPrinterConfiguration()
    private let api: PanelAPI?
    private let speech = PanelSpeech()
    private let claim = UUID().uuidString.lowercased()
    private var journal: PanelJournal?
    private var audioFloor: Int64 = 0
    private var clockOffset: TimeInterval = 0
    private var operationActive = false
    private var foreground = false
    private var issuedAt: Date?
    var now: Date { Date().addingTimeInterval(clockOffset) }
    init(apiBaseURL: URL, deviceToken: String) { api = try? PanelAPI(origin: apiBaseURL, token: deviceToken) }
    func suspend() { foreground = false; online = false; speech.stop() }
    func run() async {
        foreground = true; online = false
        guard let api else { message = "Vinculação inválida. Solicite uma nova autorização."; return }
        while !Task.isCancelled && foreground {
            if !operationActive {
                operationActive = true
                do { try await poll(api) }
                catch { failed(error) }
                operationActive = false
            }
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { break }
        }
        suspend()
    }
    private func poll(_ api: PanelAPI) async throws {
        let nextDevice = try await api.device()
        guard nextDevice.capabilities.contains("panel.read") else { throw PanelFailure.http(403) }
        if device?.id != nextDevice.id || journal == nil { journal = try PanelJournal(origin: api.origin, device: nextDevice.id) }
        let next = try await api.snapshot(nextDevice.unit_id)
        guard next.unit.id == nextDevice.unit_id, next.revision >= 0, let time = PanelRules.date(next.server_time) else { throw PanelFailure.invalidResponse }
        try Task.checkCancellation(); guard foreground else { throw CancellationError() }
        clockOffset = time.timeIntervalSinceNow
        if !online { audioFloor = next.revision }
        device = nextDevice; snapshot = next; online = true; message = "Conectado"; pendingCommand = journal?.pendingCommand
        if let issuedAt, Date().timeIntervalSince(issuedAt) >= 30 { issued = nil; self.issuedAt = nil; effectNotice = nil }
        guard let journal else { throw PanelFailure.journalUnavailable }
        for receipt in journal.receipts { try await api.ack(nextDevice.unit_id, receipt: receipt); try journal.confirmed(receipt.job) }
        if let id = journal.pendingCommand {
            let receipt: PanelCommandReceipt = try await api.request(PanelAPI.base(nextDevice.unit_id) + "/receipts/\(id)")
            if receipt.status == "confirmed", let result = receipt.response { try accept(result) }
        }
        for kind in ["print", "audio"] where nextDevice.capabilities.contains(kind == "print" ? "print.execute" : "audio.execute") {
            let jobs = try await api.jobs(nextDevice.unit_id, kind: kind, claim: claim, after: kind == "audio" ? audioFloor : 0)
            for job in jobs { try await execute(job, device: nextDevice, api: api, journal: journal) }
        }
    }
    private func execute(_ job: PanelJob, device: PanelDevice, api: PanelAPI, journal: PanelJournal) async throws {
        if let old = journal.receipts.first(where: { $0.job == job.id }) { try await api.ack(device.unit_id, receipt: old); try journal.confirmed(old.job); return }
        let fresh = try await api.snapshot(device.unit_id)
        guard fresh.unit.id == device.unit_id, let time = PanelRules.date(fresh.server_time) else { throw PanelFailure.invalidResponse }
        clockOffset = time.timeIntervalSinceNow
        try Task.checkCancellation(); guard foreground else { throw CancellationError() }
        // Persist uncertainty before a single byte can reach the printer. A crash only replays this ACK.
        try journal.record(PanelEffectReceipt(job: job.id, claim: job.claim_id, result: job.kind == "print" ? "incerto" : "skipped"))
        let result: String
        if (PanelRules.date(job.expires_at) ?? .distantPast) <= now { result = job.kind == "print" ? "falhou" : "skipped" }
        else if job.kind == "audio" {
            if fresh.device_settings?.muted == true || !PanelRules.canPlay(job, in: fresh, now: now) { result = "skipped" }
            else { result = await speech.say("Senha \(job.payload.display_number ?? ""), \(job.payload.desk ?? "balcão")", volume: fresh.device_settings?.volume ?? 1) ? "played" : "skipped" }
        } else if job.kind == "print" {
            try Task.checkCancellation(); guard foreground else { throw CancellationError() }
            let receipt = FagooTicketReceipt(job.payload)
            let outcome = await printer.coordinator.print(receipt); receipt.clear()
            switch outcome { case .delivered: result = "impresso"; case .failed(_, let delivery): result = delivery == .indeterminate ? "incerto" : "falhou" }
        } else { throw PanelFailure.invalidResponse }
        let receipt = PanelEffectReceipt(job: job.id, claim: job.claim_id, result: result)
        if job.kind == "print" {
            effectNotice = result == "incerto" ? "Não foi possível confirmar a impressão. A senha continua válida; peça ajuda ao atendimento antes de imprimir novamente." : result == "falhou" ? "A impressão não foi enviada. A senha continua válida; use o QR ou peça ajuda ao atendimento." : "Trabalho enviado à impressora. Retire seu comprovante."
        }
        try journal.record(receipt); try await api.ack(device.unit_id, receipt: receipt); try journal.confirmed(job.id)
    }
    func issue(queue: String, priority: Bool) async {
        guard !operationActive, foreground, online, !busy, pendingCommand == nil, let api, let device, let journal,
              device.capabilities.contains("ticket.issue") else { return }
        operationActive = true; busy = true; issued = nil; effectNotice = nil
        defer { busy = false; operationActive = false }
        do {
            let id = UUID().uuidString.lowercased(); try journal.setPending(id); pendingCommand = id
            let result: PanelCommand = try await api.request(PanelAPI.base(device.unit_id) + "/commands", body: [
                "command_id": id, "type": "ticket.issue", "payload": ["queue_id": queue, "priority": priority, "print": device.capabilities.contains("print.execute")]
            ])
            try accept(result)
        } catch { failed(error); message = "Confirmação interrompida. A mesma senha será consultada ao reconectar." }
    }
    func cancelUnconfirmed() async {
        guard !operationActive, foreground, online, let api, let device, let id = journal?.pendingCommand else { return }
        operationActive = true; defer { operationActive = false }
        do { let result: PanelCommand = try await api.request(PanelAPI.base(device.unit_id) + "/receipts/\(id)", body: ["cancel": true]); try accept(result) }
        catch { failed(error) }
    }
    private func accept(_ result: PanelCommand) throws {
        try journal?.setPending(nil); pendingCommand = nil; issued = result.result?.ticket
        if issued != nil { issuedAt = Date() }
        message = result.ok ? "Senha confirmada." : "Operação não executada. Confira a fila e tente novamente."
    }
    private func failed(_ error: Error) {
        online = false; speech.stop()
        if case PanelFailure.http(let code) = error, code == 401 || code == 403 {
            snapshot = nil; message = "Autorização do painel revogada. Solicite uma nova vinculação."
        } else if error is CancellationError { message = "Painel pausado." }
        else if case PanelFailure.journalUnavailable = error { message = "Não foi possível proteger os recibos. Solicite manutenção deste aparelho." }
        else { message = "Sem conexão com o Fagoo. Conecte-se à internet para continuar." }
    }
}
