import Foundation
import AVFoundation

/// Resultado de uma gravação pronta para envio.
struct VoiceRecording: Equatable {
    var url: URL
    var mimeType: String      // audio/ogg (voz) ou audio/mp4 (áudio comum)
    var contentType: String   // "voice" ou "audio"
    var fileName: String
    var duration: TimeInterval
    var size: Int64

    var isVoice: Bool { contentType == "voice" }
}

/// Grava mensagens de voz com `AVAudioRecorder` em Opus/CAF (48 kHz, mono, 24 kbps) e remuxa para Ogg/Opus.
/// Se o aparelho não gravar Opus ou a conversão falhar, grava/exporta M4A/AAC e envia como "audio".
@MainActor
final class VoiceRecorder: ObservableObject {
    static let maxDuration: TimeInterval = 120

    @Published private(set) var isRecording = false
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var level: Float = 0
    @Published private(set) var processing = false
    @Published var recording: VoiceRecording?
    @Published var error: String?

    private var recorder: AVAudioRecorder?
    private var monitor: Task<Void, Never>?
    private var currentURL: URL?
    private var currentIsOpus = false
    private var finishHandler: ((VoiceRecording?) -> Void)?

    private var workDirectory: URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fagoo-voice", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Pede permissão de microfone (true quando concedida).
    func requestPermission() async -> Bool {
        let session = AVAudioSession.sharedInstance()
        switch session.recordPermission {
        case .granted: return true
        case .denied: return false
        default:
            return await withCheckedContinuation { cont in
                session.requestRecordPermission { ok in cont.resume(returning: ok) }
            }
        }
    }

    /// Inicia a gravação (até 2 min). `onFinish` recebe o arquivo pronto (ou nil ao descartar).
    func start(onFinish: @escaping (VoiceRecording?) -> Void) async {
        guard !isRecording, !processing else { return }
        error = nil
        recording = nil
        guard await requestPermission() else {
            error = "Permita o microfone em Ajustes para gravar mensagens de voz."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            self.error = "Não foi possível preparar o áudio: \(error.localizedDescription)"
            return
        }
        let stamp = Int(Date().timeIntervalSince1970)
        let opusURL = workDirectory.appendingPathComponent("voz-\(stamp).caf")
        let opusSettings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatOpus),
            AVSampleRateKey: 48000.0,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 24000,
        ]
        var rec: AVAudioRecorder?
        var isOpus = true
        if let r = try? AVAudioRecorder(url: opusURL, settings: opusSettings), r.prepareToRecord() {
            rec = r
        } else {
            isOpus = false
            let m4aURL = workDirectory.appendingPathComponent("audio-\(stamp).m4a")
            let aacSettings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44100.0,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64000,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            if let r = try? AVAudioRecorder(url: m4aURL, settings: aacSettings), r.prepareToRecord() { rec = r }
        }
        rec?.isMeteringEnabled = true
        guard let rec, rec.record(forDuration: Self.maxDuration) else {
            error = "Não foi possível iniciar a gravação."
            return
        }
        recorder = rec
        currentURL = rec.url
        currentIsOpus = isOpus
        finishHandler = onFinish
        isRecording = true
        duration = 0
        monitor?.cancel()
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard let self, let r = self.recorder else { return }
                if r.isRecording {
                    r.updateMeters()
                    self.duration = r.currentTime
                    self.level = max(0, min(1, (r.averagePower(forChannel: 0) + 50) / 50))
                } else if self.isRecording {
                    // Limite de 2 min atingido: o gravador parou sozinho.
                    await self.finalize(discard: false)
                    return
                }
            }
        }
    }

    /// Para e prepara o arquivo para envio.
    func stop() async { await finalize(discard: false) }

    /// Para e descarta a gravação.
    func cancel() async { await finalize(discard: true) }

    private func finalize(discard: Bool) async {
        monitor?.cancel()
        monitor = nil
        guard let rec = recorder else { return }
        let elapsed = rec.currentTime
        if rec.isRecording { rec.stop() }
        recorder = nil
        isRecording = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        let handler = finishHandler
        finishHandler = nil
        guard let url = currentURL else { handler?(nil); return }
        currentURL = nil
        if discard || elapsed < 0.5 {
            try? FileManager.default.removeItem(at: url)
            if !discard { error = "Gravação muito curta." }
            handler?(nil)
            return
        }
        processing = true
        defer { processing = false }
        let isOpus = currentIsOpus
        let result: VoiceRecording? = await Task.detached(priority: .userInitiated) { () async -> VoiceRecording? in
            if isOpus {
                let ogg = url.deletingPathExtension().appendingPathExtension("ogg")
                if (try? OggOpusMuxer.convert(cafURL: url, to: ogg)) != nil, let size = Self.fileSize(ogg), size > 0 {
                    try? FileManager.default.removeItem(at: url)
                    return VoiceRecording(url: ogg, mimeType: "audio/ogg", contentType: "voice", fileName: "mensagem-de-voz.ogg", duration: elapsed, size: size)
                }
                // Conversão falhou: reexporta para M4A/AAC e envia como áudio comum.
                let m4a = url.deletingPathExtension().appendingPathExtension("m4a")
                if await Self.exportM4A(from: url, to: m4a), let size = Self.fileSize(m4a), size > 0 {
                    try? FileManager.default.removeItem(at: url)
                    return VoiceRecording(url: m4a, mimeType: "audio/mp4", contentType: "audio", fileName: "audio.m4a", duration: elapsed, size: size)
                }
                return nil
            }
            guard let size = Self.fileSize(url), size > 0 else { return nil }
            return VoiceRecording(url: url, mimeType: "audio/mp4", contentType: "audio", fileName: "audio.m4a", duration: elapsed, size: size)
        }.value
        if result == nil { error = "Não foi possível preparar o áudio gravado." }
        recording = result
        handler?(result)
    }

    nonisolated private static func fileSize(_ url: URL) -> Int64? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
    }

    nonisolated private static func exportM4A(from source: URL, to destination: URL) async -> Bool {
        let asset = AVURLAsset(url: source)
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else { return false }
        try? FileManager.default.removeItem(at: destination)
        export.outputURL = destination
        export.outputFileType = .m4a
        await export.export()
        return export.status == .completed
    }

    nonisolated static func format(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
