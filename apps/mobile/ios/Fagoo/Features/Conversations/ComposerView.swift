import SwiftUI
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers

/// Composer da conversa: texto multilinha, anexos (galeria, câmera, arquivos), voz, localização, contato,
/// nota interna, tipo automático/documento, progresso de upload e pedido pendente com a mesma Idempotency-Key.
struct ComposerView: View {
    @ObservedObject var vm: ConversationViewModel
    @StateObject private var recorder = VoiceRecorder()
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var showLocation = false
    @State private var showContactPicker = false
    @State private var showManualContact = false
    @State private var importing = false
    @State private var localError: String?
    @FocusState private var focused: Bool

    private var draftEmpty: Bool { vm.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var hasMedia: Bool { !vm.attachments.isEmpty || vm.voice != nil }

    var body: some View {
        VStack(spacing: 8) {
            if let error = vm.actionError ?? localError {
                banner(text: error, color: .red) { vm.actionError = nil; localError = nil }
            }
            if let info = vm.info {
                banner(text: info, color: .secondary) { vm.info = nil }
            }
            if let pending = vm.pending { pendingBanner(pending) }
            if let q = vm.quote { quoteStrip(q) }
            if vm.editing != nil { editStrip }
            if !vm.attachments.isEmpty { attachmentsStrip }
            if let v = vm.voice { voiceStrip(v) }
            if let l = vm.location {
                draftStrip(icon: "mappin.and.ellipse", text: "Localização: \(String(format: "%.5f, %.5f", l.latitude, l.longitude))\(l.name.isEmpty ? "" : " · \(l.name)")") { vm.location = nil }
            }
            if let c = vm.contactDraft {
                draftStrip(icon: "person.crop.circle", text: "Contato: \(c.name) · \(c.phone)") { vm.contactDraft = nil }
            }
            if let e = recorder.error { Text(e).font(.caption).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading) }
            if recorder.isRecording || recorder.processing { recordingBar } else { inputRow }
            if let p = vm.progress {
                HStack(spacing: 6) { ProgressView(); Text(p).font(.caption).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if importing {
                HStack(spacing: 6) { ProgressView(); Text("Preparando arquivos…").font(.caption).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .onDisappear { Task { await recorder.cancel() } }
        .sheet(isPresented: $showPhotos) {
            PhotoLibraryPicker(limit: max(1, 10 - vm.attachments.count)) { items in
                showPhotos = false
                guard !items.isEmpty else { return }
                importing = true
                Task {
                    for item in items where vm.attachments.count < 10 {
                        if let a = await AttachmentFactory.from(photoResult: item) { vm.addAttachment(a) }
                    }
                    importing = false
                }
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                for url in urls where vm.attachments.count < 10 {
                    if let a = AttachmentFactory.from(fileURL: url) { vm.addAttachment(a) }
                    else { localError = "Não foi possível ler \(url.lastPathComponent)." }
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(onPicked: { a in vm.addAttachment(a) }, onDone: { showCamera = false })
                .ignoresSafeArea()
        }
        // Localização/contato e arquivos são excludentes (o servidor rejeita anexo com type location/contacts).
        .sheet(isPresented: $showLocation) { LocationSheet { vm.setLocation($0) } }
        .sheet(isPresented: $showContactPicker) {
            ContactPickerView(onPicked: { vm.setContactDraft($0) }, onDone: { showContactPicker = false })
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showManualContact) { ManualContactSheet(initial: vm.contactDraft) { vm.setContactDraft($0) } }
    }

    // MARK: Linha principal

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            attachMenu
            AppMultilineField(vm.editing != nil ? "Novo texto da mensagem" : "Mensagem", text: $vm.draft, lines: 1...6)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .disabled(vm.composerLocked)
            if vm.busy {
                ProgressView().frame(width: 36, height: 36)
            } else if vm.can("voice"), draftEmpty, vm.attachments.isEmpty, vm.voice == nil, vm.location == nil, vm.contactDraft == nil, vm.editing == nil, vm.pending == nil {
                Button {
                    focused = false
                    Task { await recorder.start { result in if let result { vm.setVoice(result) } } }
                } label: { Image(systemName: "mic.circle.fill").font(.system(size: 34)) }
                .buttonStyle(.plain)
                .accessibilityLabel("Gravar áudio")
            } else {
                Button {
                    focused = false
                    vm.send()
                } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 34)) }
                .buttonStyle(.plain)
                .disabled(!vm.canSend)
                .accessibilityLabel(vm.pending != nil ? "Tentar novamente" : "Enviar")
            }
        }
    }

    private var attachMenu: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Fotos e vídeos", systemImage: "photo.on.rectangle") }
            Button {
                if CameraPicker.isAvailable { showCamera = true } else { localError = "Este aparelho não tem câmera disponível." }
            } label: { Label("Câmera", systemImage: "camera") }
            Button { showFiles = true } label: { Label("Arquivo", systemImage: "doc") }
            if vm.can("location") {
                Button { showLocation = true } label: { Label(hasMedia ? "Localização (remove os anexos)" : "Localização", systemImage: "mappin.and.ellipse") }
            }
            if vm.can("contacts") {
                Menu {
                    Button { showContactPicker = true } label: { Label("Dos meus contatos", systemImage: "person.crop.circle") }
                    Button { showManualContact = true } label: { Label("Digitar nome e telefone", systemImage: "keyboard") }
                } label: { Label(hasMedia ? "Contato (remove os anexos)" : "Contato", systemImage: "person.crop.rectangle") }
            }
            if !vm.attachments.isEmpty {
                Picker("Tipo do conteúdo", selection: $vm.sendKind) {
                    ForEach(SendKind.allCases) { Text($0.title).tag($0) }
                }
            }
            if !draftEmpty, vm.editing == nil {
                Divider()
                Button { Task { await vm.sendNote() } } label: { Label("Enviar como nota interna", systemImage: "note.text") }
            }
        } label: {
            Image(systemName: "plus.circle.fill").font(.system(size: 30))
        }
        .disabled(vm.composerLocked || vm.editing != nil)
        .accessibilityLabel("Anexar")
    }

    // MARK: Gravação

    private var recordingBar: some View {
        HStack(spacing: 12) {
            if recorder.processing {
                ProgressView()
                Text("Preparando áudio…").font(.footnote)
                Spacer()
            } else {
                Button { Task { await recorder.cancel() } } label: { Image(systemName: "trash").font(.title3) }
                    .buttonStyle(.plain).foregroundStyle(.red).accessibilityLabel("Descartar gravação")
                Circle().fill(Color.red).frame(width: 10, height: 10).opacity(0.5 + 0.5 * Double(recorder.level))
                Text(VoiceRecorder.format(recorder.duration)).font(.footnote.monospacedDigit())
                ProgressView(value: min(1, recorder.duration / VoiceRecorder.maxDuration)).progressViewStyle(.linear)
                Text("máx. 2:00").font(.caption2).foregroundStyle(.secondary)
                Button { Task { await recorder.stop() } } label: { Image(systemName: "stop.circle.fill").font(.system(size: 34)) }
                    .buttonStyle(.plain).accessibilityLabel("Parar gravação")
            }
        }
        .frame(minHeight: 40)
    }

    private func voiceStrip(_ v: VoiceRecording) -> some View {
        HStack(spacing: 10) {
            LocalAudioPreview(url: v.url)
            VStack(alignment: .leading, spacing: 2) {
                Text(v.isVoice ? "Mensagem de voz" : "Áudio (M4A)").font(.footnote.weight(.medium))
                Text("\(VoiceRecorder.format(v.duration)) · \(ConversationFormatting.bytes(v.size))" + (v.isVoice ? "" : " · enviado como áudio comum")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button { vm.voice = nil; try? FileManager.default.removeItem(at: v.url) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                .buttonStyle(.plain).disabled(vm.composerLocked)
        }
        .padding(8)
        .background(Color.secondary.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: Faixas auxiliares

    private var attachmentsStrip: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(vm.attachments) { a in
                        ZStack(alignment: .topTrailing) {
                            VStack(spacing: 2) {
                                if let t = a.thumbnail {
                                    Image(uiImage: t).resizable().scaledToFill().frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 8))
                                } else {
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.15)).frame(width: 64, height: 64)
                                        Image(systemName: a.kind == "video" ? "video" : (a.kind == "audio" ? "waveform" : "doc")).font(.title2).foregroundStyle(.secondary)
                                    }
                                }
                                Text(a.name).font(.caption2).lineLimit(1).frame(width: 72)
                                Text(a.sizeLabel).font(.caption2).foregroundStyle(.secondary)
                            }
                            Button { vm.attachments.removeAll { $0.id == a.id } } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .buttonStyle(.plain)
                            .offset(x: 4, y: -4)
                            .disabled(vm.composerLocked)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            Text(vm.sendKind == .document ? "Enviar como documento" : "Tipo automático pelo arquivo · Meta: foto até 5 MB, vídeo/áudio até 16 MB, documento até 100 MB")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func quoteStrip(_ q: Message) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(Color.accentColor).frame(width: 3, height: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text("Respondendo a \(vm.authorLabel(q))").font(.caption.weight(.semibold))
                Text(q.text.isEmpty ? "Anexo" : q.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            Button { vm.quote = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain)
        }
        .padding(8)
        .background(Color.secondary.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var editStrip: some View {
        HStack {
            Label("Editando mensagem (até 15 min após o envio)", systemImage: "pencil").font(.caption)
            Spacer()
            Button("Cancelar") { vm.cancelEdit() }.font(.caption)
        }
        .padding(8)
        .background(Color.orange.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func draftStrip(icon: String, text: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(Color.accentColor)
            Text(text).font(.caption).lineLimit(2)
            Spacer()
            Button(action: remove) { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain).disabled(vm.composerLocked)
        }
        .padding(8)
        .background(Color.secondary.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func pendingBanner(_ p: PendingRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Pedido guardado para repetição segura (\(p.summary)).", systemImage: "clock.arrow.circlepath").font(.caption)
            Text("A mesma identificação será reutilizada: nenhum envio duplicado.").font(.caption2).foregroundStyle(.secondary)
            HStack {
                Button("Tentar novamente") { vm.send() }.buttonStyle(.borderedProminent).controlSize(.small).disabled(vm.busy)
                Button("Abandonar pedido", role: .destructive) { vm.abandonPending() }.buttonStyle(.bordered).controlSize(.small).disabled(vm.busy)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func banner(text: String, color: Color, dismiss: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(text).font(.caption).foregroundStyle(color)
            Spacer()
            Button(action: dismiss) { Image(systemName: "xmark").font(.caption) }.buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(8)
        .background(color.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

/// Reproduz a gravação local antes de enviar.
struct LocalAudioPreview: View {
    let url: URL
    @StateObject private var model = LocalAudioModel()

    var body: some View {
        Button {
            model.toggle(url: url)
        } label: {
            Image(systemName: model.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 30))
        }
        .buttonStyle(.plain)
        .onDisappear { model.stop() }
    }
}

@MainActor
final class LocalAudioModel: NSObject, ObservableObject {
    @Published var playing = false
    private var player: AVAudioPlayer?
    private var monitor: Task<Void, Never>?

    func toggle(url: URL) {
        if playing { stop(); return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        guard let p = try? AVAudioPlayer(contentsOf: url) else { return }
        player = p
        p.play()
        playing = true
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard let self else { return }
                if self.player?.isPlaying != true { self.stop(); return }
            }
        }
    }

    func stop() {
        monitor?.cancel()
        monitor = nil
        player?.stop()
        player = nil
        playing = false
    }
}
