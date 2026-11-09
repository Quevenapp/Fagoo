// SPDX-License-Identifier: AGPL-3.0-only
import SwiftUI
import AVKit
import Printher
import ThermalPrinterKit
import CoreImage

/// The host must authorize onExitRequested online. This view never receives a human session.
@MainActor
struct FagooPanelView: View {
    @StateObject private var runtime: PanelRuntime
    @Environment(\.scenePhase) private var scenePhase
    @State private var surface = "chamada"
    let onExitRequested: () -> Void
    init(apiBaseURL: URL, deviceToken: String, onExitRequested: @escaping () -> Void) {
        _runtime = StateObject(wrappedValue: PanelRuntime(apiBaseURL: apiBaseURL, deviceToken: deviceToken))
        self.onExitRequested = onExitRequested
    }
    private var style: PanelStyle { .of(.from(id: runtime.snapshot?.device_settings?.template ?? runtime.snapshot?.config.template)) }
    var body: some View {
        VStack(spacing: 0) {
            header
            if let snapshot = runtime.snapshot {
                let functions = snapshot.config.functions.filter { $0 != "emitir" || runtime.device?.capabilities.contains("ticket.issue") == true }
                let selected = functions.contains(surface) ? surface : functions.first ?? "chamada"
                if functions.count > 1 {
                    Picker("Função do painel", selection: Binding(get: { selected }, set: { surface = $0 })) {
                        ForEach(functions, id: \.self) { Text(label($0)).tag($0) }
                    }.pickerStyle(.segmented).padding()
                }
                ScrollView {
                    VStack(spacing: 22) {
                        if selected == "emitir" { issuer(snapshot) }
                        else if selected == "pedidos" { orders(snapshot) }
                        else { calls(snapshot) }
                        if runtime.online { campaigns(snapshot, surface: selected) }
                        if !snapshot.config.footer.isEmpty { Text(snapshot.config.footer).font(style.text(18)).foregroundColor(style.muted) }
                    }.padding(24)
                }
            } else { Spacer(); Image(systemName: "network").font(.system(size: 54)); Text(runtime.message).multilineTextAlignment(.center).padding(); Spacer() }
            if !runtime.online {
                Label(runtime.message, systemImage: "wifi.slash").font(.headline).multilineTextAlignment(.center)
                    .padding().frame(maxWidth: .infinity).foregroundColor(.white).background(Color.red.opacity(0.85))
            }
        }
        .background(style.bg.ignoresSafeArea()).foregroundColor(style.fg).environment(\.panelStyle, style)
        .task(id: scenePhase) { if scenePhase == .active { await runtime.run() } else { runtime.suspend() } }
        .onAppear { PanelFonts.registerOnce(); UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { runtime.suspend(); UIApplication.shared.isIdleTimerDisabled = false }
    }
    private var header: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(runtime.snapshot?.config.title.isEmpty == false ? runtime.snapshot!.config.title : runtime.snapshot?.unit.name ?? "FAGOO")
                    .font(style.bold(26)).lineLimit(2)
                Text(runtime.device?.name ?? "Painel").font(style.text(15)).opacity(0.75)
            }
            Spacer()
            Button(action: onExitRequested) { Image(systemName: "lock.fill").font(.title2).padding(8) }.accessibilityLabel("Autorizar saída do painel")
        }.foregroundColor(style.headerFg).padding(20).background(style.headerBg)
            .overlay(alignment: .bottom) { Rectangle().fill(style.headerLine).frame(height: style.headerLineWidth) }
    }
    private func calls(_ snapshot: PanelSnapshot) -> some View {
        VStack(spacing: 20) {
            if let current = snapshot.recent_calls.first(where: { $0.status == "chamada" }) {
                let destination = PanelDestination.split(current.desk)
                VStack(spacing: 8) {
                    Text(style.label("Senha chamada")).font(style.bold(22))
                    Text(current.display_number).font(style.display(112)).minimumScaleFactor(0.35).lineLimit(1).accessibilityLabel("Senha \(current.display_number)")
                    HStack {
                        if style.arrow { Image(systemName: "arrow.right").font(.title) }
                        Text("\(destination.label) \(destination.value)").font(style.bold(38)).minimumScaleFactor(0.6).lineLimit(2)
                    }.padding(16).frame(maxWidth: .infinity).foregroundColor(style.destFg).background(style.destBg).cornerRadius(style.destPill ? 80 : style.radiusSmall)
                }.padding(24).frame(maxWidth: .infinity).foregroundColor(style.heroFg).background(style.heroBg).cornerRadius(style.radius)
            } else { Text("Aguarde a próxima chamada").font(style.bold(32)).padding(40) }
            if !snapshot.recent_calls.isEmpty {
                Text(style.label("Últimas chamadas")).font(style.bold(20)).frame(maxWidth: .infinity, alignment: .leading)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 12)], spacing: 12) {
                    ForEach(Array(snapshot.recent_calls.filter { $0.id != snapshot.recent_calls.first(where: { $0.status == "chamada" })?.id }.prefix(8))) { ticket in
                        VStack(spacing: 8) {
                            Text(ticket.display_number).font(style.display(46)).foregroundColor(style.queueColor(PanelQueueLetter.index(PanelQueueLetter.of(ticket.display_number))))
                            Text(ticket.desk ?? "Balcão").font(style.bold(24)).foregroundColor(style.prevDest)
                            if let time = PanelClock.hhmm(ticket.last_called_at, zone: TimeZone(identifier: snapshot.unit.timezone) ?? .current) { Text(time).font(style.text(16)).foregroundColor(style.muted) }
                        }.padding().frame(maxWidth: .infinity).background(style.surface).cornerRadius(style.radiusSmall)
                    }
                }
            }
        }
    }
    private func orders(_ snapshot: PanelSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(style.label("Pedidos")).font(style.bold(30))
            if snapshot.orders.isEmpty { Text("Os pedidos aparecerão aqui.").font(style.text(22)) }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 14)], spacing: 14) {
                ForEach(snapshot.orders) { order in
                    let ready = order.status == "pronto"
                    VStack(spacing: 8) {
                        Text(order.code).font(style.display(62)).lineLimit(1).minimumScaleFactor(0.5)
                        Text(ready ? "Pronto para retirada" : order.status == "retirado" ? "Retirado" : order.status == "cancelado" ? "Cancelado" : "Em preparo").font(style.bold(20))
                    }.padding(24).frame(maxWidth: .infinity).foregroundColor(ready ? style.readyFg : style.fg).background(ready ? style.readyBg : style.surface).cornerRadius(style.radius)
                }
            }
        }
    }
    private func issuer(_ snapshot: PanelSnapshot) -> some View {
        VStack(spacing: 22) {
            Text("Retire sua senha").font(style.bold(34))
            if let ticket = runtime.issued {
                VStack(spacing: 12) {
                    Text("Senha confirmada").font(style.bold(20)); Text(ticket.display_number).font(style.display(72))
                    if let link = ticket.tracking_url, let url = URL(string: link), url.scheme == "https", let qr = trackingQR(link) {
                        Image(uiImage: qr).interpolation(.none).resizable().scaledToFit().frame(width: 220,height: 220).padding(14).background(Color.white)
                        Text("Acompanhe pelo celular com internet").font(style.text(18))
                    }
                }
                    .padding().frame(maxWidth: .infinity).foregroundColor(style.heroFg).background(style.heroBg).cornerRadius(style.radius)
            }
            if let notice = runtime.effectNotice { Text(notice).font(style.text(18)).multilineTextAlignment(.center) }
            if runtime.pendingCommand != nil {
                Text("Consultando o resultado da emissão. Uma nova senha só será liberada após a confirmação.").multilineTextAlignment(.center)
                Button("Verificar e liberar emissão") { Task { await runtime.cancelUnconfirmed() } }.disabled(!runtime.online)
            }
            ForEach(snapshot.queues.filter(\.active)) { queue in
                VStack(spacing: 12) {
                    Text(queue.name).font(style.bold(24))
                    HStack(spacing: 16) {
                        Button("Atendimento normal") { Task { await runtime.issue(queue: queue.id, priority: false) } }
                        Button("Preferencial") { Task { await runtime.issue(queue: queue.id, priority: true) } }
                    }.buttonStyle(.borderedProminent).controlSize(.large).tint(style.accent)
                        .disabled(!runtime.online || runtime.busy || runtime.pendingCommand != nil)
                }.padding(24).frame(maxWidth: .infinity).background(style.surface).cornerRadius(style.radius)
            }
            Text(runtime.message).font(style.text(18))
        }
    }
    @ViewBuilder private func campaigns(_ snapshot: PanelSnapshot, surface: String) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let entries = PanelRules.campaigns(snapshot, surface: surface, now: runtime.now)
            let duration = entries.reduce(0) { $0 + max(1, $1.duration_seconds) }
            if let entry = campaign(entries, second: Int(context.date.timeIntervalSince1970) % max(1, duration)), let url = URL(string: entry.media_url) {
                VStack(spacing: 8) {
                    if entry.media_type.hasPrefix("video") { PanelCampaignVideo(url: url, muted: snapshot.device_settings?.muted ?? false, volume: snapshot.device_settings?.volume ?? 1).id(entry.id).frame(minHeight: 240) }
                    else { AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { ProgressView() }.frame(maxHeight: 380) }
                    if !entry.title.isEmpty { Text(entry.title).font(style.bold(20)) }
                }.frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: style.radius))
            }
        }
    }
    private func campaign(_ entries: [PanelCampaign], second: Int) -> PanelCampaign? {
        var cursor = second
        for entry in entries { cursor -= max(1, entry.duration_seconds); if cursor < 0 { return entry } }; return entries.first
    }
    private func label(_ mode: String) -> String { mode == "emitir" ? "Retirar senha" : mode == "pedidos" ? "Pedidos" : "Chamadas" }
    private func trackingQR(_ text: String) -> UIImage? {
        guard text.utf8.count <= 2048, let filter = CIFilter(name:"CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8),forKey:"inputMessage"); filter.setValue("M",forKey:"inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by:CGAffineTransform(scaleX:5,y:5)), let image = CIContext().createCGImage(output,from:output.extent) else { return nil }
        return UIImage(cgImage:image)
    }
}

/// Exposed only by the host's online authorized setup, outside the protected public panel.
@MainActor
struct FagooPanelPrinterSettingsView: View {
    @StateObject private var printer = ThermalPrinterConfiguration()
    var body: some View { ThermalPrinterView(printer: printer) }
}

private struct PanelCampaignVideo: View {
    let url: URL; let muted: Bool; let volume: Float
    @State private var player: AVPlayer?
    var body: some View {
        VideoPlayer(player: player).onAppear { let next = AVPlayer(url: url); next.isMuted = muted; next.volume = min(1, max(0, volume)); player = next; next.play() }
            .onDisappear { player?.pause(); player?.replaceCurrentItem(with: nil); player = nil }
            .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime)) { event in
                if let item = event.object as? AVPlayerItem, item === player?.currentItem { player?.seek(to: .zero); player?.play() }
            }.allowsHitTesting(false)
    }
}
