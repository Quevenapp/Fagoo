import SwiftUI
import AVKit
import AVFoundation
import QuickLook
import UIKit

/// Item para `.sheet(item:)`/`.fullScreenCover(item:)` com um arquivo local.
struct LocalFileItem: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// Imagem privada (exige Authorization): miniatura via MediaLoader; toque abre o visualizador com zoom e compartilhar.
struct AuthenticatedImageView: View {
    @EnvironmentObject private var container: AppContainer
    let file: MediaFile
    let profileId: String
    @State private var image: UIImage?
    @State private var failed = false
    @State private var showViewer = false

    var body: some View {
        Group {
            if let image {
                Button { showViewer = true } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: 240, maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .fullScreenCover(isPresented: $showViewer) { ImageViewerView(file: file, profileId: profileId, image: image) }
            } else if failed {
                Label("Imagem indisponível", systemImage: "photo").font(.footnote).foregroundStyle(.secondary)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.15)).frame(width: 180, height: 140)
                    ProgressView()
                }
            }
        }
        .task(id: file.id) {
            guard image == nil else { return }
            do {
                let data = try await MediaLoader.shared.data(mediaId: file.id, profileId: profileId, api: container.api)
                if let ui = UIImage(data: data) { image = ui } else { failed = true }
            } catch { failed = true }
        }
    }
}

/// Visualizador em tela cheia com zoom (pinça) e ShareLink.
struct ImageViewerView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    let file: MediaFile
    let profileId: String
    let image: UIImage
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    @State private var shareURL: URL?

    var body: some View {
        AppNavigationStack {
            GeometryReader { geo in
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: geo.size.width, height: geo.size.height)
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(
                        MagnificationGesture()
                            .onChanged { value in scale = max(1, min(6, lastScale * value)) }
                            .onEnded { _ in lastScale = scale; if scale <= 1 { offset = .zero; lastOffset = .zero } }
                    )
                    .simultaneousGesture(
                        DragGesture()
                            .onChanged { value in
                                guard scale > 1 else { return }
                                offset = CGSize(width: lastOffset.width + value.translation.width, height: lastOffset.height + value.translation.height)
                            }
                            .onEnded { _ in lastOffset = offset }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation { if scale > 1 { scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero } else { scale = 2.5; lastScale = 2.5 } }
                    }
            }
            .background(Color.black)
            .ignoresSafeArea()
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .appDarkNavigationBar()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fechar") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    if let shareURL {
                        AppShareLink(item: shareURL) { Image(systemName: "square.and.arrow.up") }
                    } else {
                        ProgressView()
                    }
                }
            }
            .task {
                shareURL = try? await MediaLoader.shared.fileURL(for: file, profileId: profileId, api: container.api)
            }
        }
    }
}

/// Cartão de vídeo: abre um player autenticado (AVURLAsset com cabeçalho Authorization).
struct VideoAttachmentView: View {
    let file: MediaFile
    let profileId: String
    @State private var show = false

    var body: some View {
        Button { show = true } label: {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.75)).frame(width: 64, height: 64)
                    Image(systemName: "play.fill").foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.name.isEmpty ? "Vídeo" : file.name).font(.footnote.weight(.medium)).lineLimit(2)
                    Text("Vídeo · \(file.sizeLabel)").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $show) { VideoPlayerSheet(file: file, profileId: profileId) }
    }
}

struct VideoPlayerSheet: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    let file: MediaFile
    let profileId: String
    @State private var player: AVPlayer?
    @State private var shareURL: URL?

    var body: some View {
        AppNavigationStack {
            Group {
                if let player {
                    VideoPlayer(player: player).ignoresSafeArea(edges: .bottom)
                } else {
                    ProgressView()
                }
            }
            .background(Color.black)
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fechar") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    if let shareURL { AppShareLink(item: shareURL) { Image(systemName: "square.and.arrow.up") } }
                }
            }
            .task {
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
                guard let asset = try? await AuthenticatedAsset.make(file: file, profileId: profileId, api: container.api), !Task.isCancelled else { return }
                let p = AVPlayer(playerItem: AVPlayerItem(asset: asset))
                player = p
                p.play()
            }
            .onDisappear { player?.pause(); player = nil }
            .task { shareURL = try? await MediaLoader.shared.fileURL(for: file, profileId: profileId, api: container.api) }
        }
    }
}

enum AuthenticatedAsset {
    /// Download through the cancellable session first; AVPlayer never receives bearer headers.
    static func make(file: MediaFile, profileId: String, api: APIClient) async throws -> AVURLAsset {
        let url = try await MediaLoader.shared.fileURL(for: file, profileId: profileId, api: api)
        try api.checkValid(); return AVURLAsset(url: url)
    }
}

/// Player de áudio/voz embutido na bolha: reproduzir/pausar e progresso.
struct AudioPlayerView: View {
    @EnvironmentObject private var container: AppContainer
    let file: MediaFile
    let profileId: String
    let isVoice: Bool
    @StateObject private var model = AudioPlayerModel()

    var body: some View {
        HStack(spacing: 10) {
            Button {
                Task {
                    if model.player == nil {
                        guard let asset = try? await AuthenticatedAsset.make(file: file, profileId: profileId, api: container.api) else { return }
                        model.prepare(asset: asset)
                    }
                    model.toggle()
                }
            } label: {
                Image(systemName: model.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 34))
            }
            .buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 4) {
                ProgressView(value: model.progress).progressViewStyle(.linear)
                HStack {
                    Text(isVoice ? "Mensagem de voz" : (file.name.isEmpty ? "Áudio" : file.name)).font(.caption).lineLimit(1)
                    Spacer()
                    Text(model.timeLabel).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        }
        .frame(minWidth: 200)
        .onDisappear { model.stop() }
    }
}

@MainActor
final class AudioPlayerModel: ObservableObject {
    @Published var playing = false
    @Published var progress: Double = 0
    @Published var timeLabel = "0:00"
    private(set) var player: AVPlayer?
    private var observer: Any?
    private var endObserver: NSObjectProtocol?

    func prepare(asset: AVURLAsset) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        let item = AVPlayerItem(asset: asset)
        let p = AVPlayer(playerItem: item)
        player = p
        observer = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
            let current = time.seconds
            Task { @MainActor in
                guard let self, let item = self.player?.currentItem else { return }
                let total = item.duration.seconds
                if total.isFinite, total > 0 {
                    self.progress = max(0, min(1, current / total))
                    self.timeLabel = "\(VoiceRecorder.format(current)) / \(VoiceRecorder.format(total))"
                } else {
                    self.timeLabel = VoiceRecorder.format(current)
                }
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.playing = false
                self?.progress = 0
                self?.player?.seek(to: .zero)
            }
        }
    }

    func toggle() {
        guard let player else { return }
        if playing { player.pause(); playing = false } else { player.play(); playing = true }
    }

    func stop() {
        player?.pause()
        if let observer, let player { player.removeTimeObserver(observer) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        observer = nil
        endObserver = nil
        player = nil
        playing = false
    }
}

/// Documento: nome, tamanho, abrir (QuickLook) e compartilhar.
struct DocumentAttachmentView: View {
    @EnvironmentObject private var container: AppContainer
    let file: MediaFile
    let profileId: String
    @State private var downloading = false
    @State private var localURL: URL?
    @State private var preview: LocalFileItem?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { Task { await open() } } label: {
                HStack(spacing: 10) {
                    Image(systemName: icon).font(.title2).foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(file.name.isEmpty ? "Documento" : file.name).font(.footnote.weight(.medium)).lineLimit(2).multilineTextAlignment(.leading)
                        Text(file.size > 0 ? file.sizeLabel : "Baixar anexo").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    if downloading { ProgressView() } else { Image(systemName: "arrow.down.circle").foregroundStyle(.secondary) }
                }
            }
            .buttonStyle(.plain)
            if let localURL {
                AppShareLink(item: localURL) { Label("Compartilhar", systemImage: "square.and.arrow.up").font(.caption) }
            }
            if let error { Text(error).font(.caption2).foregroundStyle(.red) }
        }
        .frame(minWidth: 200)
        .sheet(item: $preview) { item in QuickLookPreview(url: item.url).ignoresSafeArea() }
    }

    private var icon: String {
        let m = file.mimeBase
        if m == "application/pdf" { return "doc.richtext" }
        if m.contains("spreadsheet") || m.contains("excel") { return "tablecells" }
        if m.contains("presentation") || m.contains("powerpoint") { return "rectangle.on.rectangle" }
        if m.hasPrefix("text/") { return "doc.plaintext" }
        return "doc"
    }

    private func open() async {
        error = nil
        if localURL == nil {
            downloading = true
            do { localURL = try await MediaLoader.shared.fileURL(for: file, profileId: profileId, api: container.api) }
            catch { self.error = APIError.describe(error) }
            downloading = false
        }
        if let localURL { preview = LocalFileItem(url: localURL) }
    }
}

/// QLPreviewController embrulhado para abrir documentos baixados.
struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return UINavigationController(rootViewController: controller)
    }

    func updateUIViewController(_ uiViewController: UINavigationController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

/// Decide a visualização de um anexo pelo tipo MIME.
struct AttachmentView: View {
    let file: MediaFile
    let profileId: String
    var isVoiceMessage = false

    var body: some View {
        if file.isImage { AuthenticatedImageView(file: file, profileId: profileId) }
        else if file.isVideo { VideoAttachmentView(file: file, profileId: profileId) }
        else if file.isAudio { AudioPlayerView(file: file, profileId: profileId, isVoice: isVoiceMessage || file.mimeBase == "audio/ogg") }
        else { DocumentAttachmentView(file: file, profileId: profileId) }
    }
}
