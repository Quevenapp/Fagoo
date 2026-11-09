import SwiftUI
import PhotosUI
import UIKit
import ContactsUI
import CoreLocation
import MapKit
import AVFoundation
import UniformTypeIdentifiers

/// Converte o que a pessoa escolheu (galeria, câmera, arquivos) em `PendingAttachment`.
enum AttachmentFactory {
    private static var stamp: String {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"; return f.string(from: Date())
    }

    /// Item escolhido no seletor do sistema, disponível também no iOS 15.
    static func from(photoResult result: PHPickerResult) async -> PendingAttachment? {
        let provider = result.itemProvider
        guard let identifier = provider.registeredTypeIdentifiers.first(where: {
            guard let type = UTType($0) else { return false }
            return type.conforms(to: .image) || type.conforms(to: .movie)
        }) else { return nil }
        let data: Data? = await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, _ in continuation.resume(returning: data) }
        }
        guard let data else { return nil }
        let type = UTType(identifier)
        let mime = type?.preferredMIMEType ?? ""
        let ext = type?.preferredFilenameExtension ?? "bin"
        if type?.conforms(to: .image) == true || mime.hasPrefix("image/") {
            return fromImageData(data, mime: mime, ext: ext)
        }
        if type?.conforms(to: .movie) == true || mime.hasPrefix("video/") {
            if mime == "video/mp4" || mime == "video/3gpp" {
                return PendingAttachment(data: data, name: "video-\(stamp).\(ext)", mimeType: mime)
            }
            // QuickTime/HEVC etc.: reexporta como MP4 compatível.
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("fagoo-video-\(UUID().uuidString).\(ext)")
            try? data.write(to: tmp)
            defer { try? FileManager.default.removeItem(at: tmp) }
            if let mp4 = await exportMP4(from: tmp) { return PendingAttachment(data: mp4, name: "video-\(stamp).mp4", mimeType: "video/mp4") }
            return PendingAttachment(data: data, name: "video-\(stamp).\(ext)", mimeType: mime.isEmpty ? "video/quicktime" : mime)
        }
        return PendingAttachment(data: data, name: "arquivo-\(stamp).\(ext)", mimeType: mime.isEmpty ? "application/octet-stream" : mime)
    }

    static func fromImageData(_ data: Data, mime: String, ext: String) -> PendingAttachment? {
        guard let ui = UIImage(data: data) else { return nil }
        let accepted = ["image/jpeg", "image/png", "image/gif", "image/webp"]
        if accepted.contains(mime) {
            return PendingAttachment(data: data, name: "foto-\(stamp).\(ext)", mimeType: mime, thumbnail: thumbnail(ui))
        }
        guard let jpeg = ui.jpegData(compressionQuality: 0.85) else { return nil }
        return PendingAttachment(data: jpeg, name: "foto-\(stamp).jpg", mimeType: "image/jpeg", thumbnail: thumbnail(ui))
    }

    /// Foto da câmera.
    static func from(image: UIImage) -> PendingAttachment? {
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return nil }
        return PendingAttachment(data: jpeg, name: "foto-\(stamp).jpg", mimeType: "image/jpeg", thumbnail: thumbnail(image))
    }

    /// Arquivo escolhido em Arquivos (com escopo de segurança).
    static func from(fileURL url: URL) -> PendingAttachment? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return nil }
        let mime = PendingAttachment.mimeType(for: url)
        var thumb: UIImage? = nil
        if mime.hasPrefix("image/"), let ui = UIImage(data: data) { thumb = thumbnail(ui) }
        return PendingAttachment(data: data, name: url.lastPathComponent, mimeType: mime, thumbnail: thumb)
    }

    /// Vídeo gravado pela câmera (.mov) convertido em MP4.
    static func fromVideo(url: URL) async -> PendingAttachment? {
        if let mp4 = await exportMP4(from: url) { return PendingAttachment(data: mp4, name: "video-\(stamp).mp4", mimeType: "video/mp4") }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return PendingAttachment(data: data, name: "video-\(stamp).\(url.pathExtension.isEmpty ? "mov" : url.pathExtension)", mimeType: PendingAttachment.mimeType(for: url))
    }

    static func exportMP4(from source: URL) async -> Data? {
        let asset = AVURLAsset(url: source)
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else { return nil }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("fagoo-export-\(UUID().uuidString).mp4")
        export.outputURL = out
        export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = true
        await export.export()
        defer { try? FileManager.default.removeItem(at: out) }
        guard export.status == .completed else { return nil }
        return try? Data(contentsOf: out)
    }

    static func thumbnail(_ image: UIImage, maxSide: CGFloat = 240) -> UIImage {
        let size = image.size
        guard size.width > maxSide || size.height > maxSide else { return image }
        let scale = maxSide / max(size.width, size.height)
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
    }

    /// Telefone no formato aceito pelo servidor: dígitos com DDI, opcionalmente iniciado por "+".
    static func normalizePhone(_ raw: String) -> String {
        let digits = raw.filter { $0.isNumber }
        return raw.trimmingCharacters(in: .whitespaces).hasPrefix("+") ? "+" + digits : digits
    }
}

// MARK: Câmera

/// UIImagePickerController (câmera) embrulhado: foto → JPEG; vídeo → MP4.
struct CameraPicker: UIViewControllerRepresentable {
    var onPicked: (PendingAttachment) -> Void
    var onDone: () -> Void

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoQuality = .typeMedium
        picker.videoMaximumDuration = 120
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked, onDone: onDone) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPicked: (PendingAttachment) -> Void
        let onDone: () -> Void
        init(onPicked: @escaping (PendingAttachment) -> Void, onDone: @escaping () -> Void) {
            self.onPicked = onPicked
            self.onDone = onDone
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let url = info[.mediaURL] as? URL {
                let picked = onPicked, done = onDone
                Task { @MainActor in
                    if let a = await AttachmentFactory.fromVideo(url: url) { picked(a) }
                    done()
                }
                return
            }
            if let image = (info[.editedImage] ?? info[.originalImage]) as? UIImage, let a = AttachmentFactory.from(image: image) {
                onPicked(a)
            }
            onDone()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onDone() }
    }
}

// MARK: Contatos do sistema

struct ContactPickerView: UIViewControllerRepresentable {
    var onPicked: (ContactDraft) -> Void
    var onDone: () -> Void

    func makeUIViewController(context: Context) -> CNContactPickerViewController {
        let picker = CNContactPickerViewController()
        picker.delegate = context.coordinator
        picker.predicateForEnablingContact = NSPredicate(format: "phoneNumbers.@count > 0")
        return picker
    }

    func updateUIViewController(_ uiViewController: CNContactPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked, onDone: onDone) }

    final class Coordinator: NSObject, CNContactPickerDelegate {
        let onPicked: (ContactDraft) -> Void
        let onDone: () -> Void
        init(onPicked: @escaping (ContactDraft) -> Void, onDone: @escaping () -> Void) {
            self.onPicked = onPicked
            self.onDone = onDone
        }

        func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
            let phone = contact.phoneNumbers.first?.value.stringValue ?? ""
            onPicked(ContactDraft(name: name.isEmpty ? "Contato" : name, phone: AttachmentFactory.normalizePhone(phone)))
            onDone()
        }

        func contactPickerDidCancel(_ picker: CNContactPickerViewController) { onDone() }
    }
}

/// Nome e telefone digitados à mão.
struct ManualContactSheet: View {
    var initial: ContactDraft? = nil
    var onUse: (ContactDraft) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var phone = ""

    private var valid: Bool {
        let p = AttachmentFactory.normalizePhone(phone)
        let digits = p.filter { $0.isNumber }
        return !name.trimmingCharacters(in: .whitespaces).isEmpty && digits.count >= 8 && digits.count <= 16
    }

    var body: some View {
        AppNavigationStack {
            Form {
                Section {
                    TextField("Nome", text: $name).textContentType(.name)
                    TextField("Telefone com DDI (5511999990000)", text: $phone).keyboardType(.phonePad).textContentType(.telephoneNumber)
                } footer: {
                    Text("O cartão é enviado ao cliente pelo WhatsApp. Use o número completo com código do país.")
                }
            }
            .navigationTitle("Compartilhar contato")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Usar") { onUse(ContactDraft(name: name.trimmingCharacters(in: .whitespaces), phone: AttachmentFactory.normalizePhone(phone))); dismiss() }.disabled(!valid)
                }
            }
            .onAppear { if let initial { name = initial.name; phone = initial.phone } }
        }
    }
}

// MARK: Localização

/// Uma leitura de posição do aparelho com permissão "enquanto usa".
final class LocationProvider: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var location: CLLocation?
    @Published var error: String?
    @Published var busy = false
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    func request() {
        error = nil
        guard CLLocationManager.locationServicesEnabled() else { error = "Os serviços de localização estão desligados."; return }
        busy = true
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .denied, .restricted: busy = false; error = "Permita a localização em Ajustes para usar a posição atual."
        default: manager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard busy else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: manager.requestLocation()
        case .denied, .restricted: busy = false; error = "Permissão de localização negada."
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        busy = false
        location = locations.last
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        busy = false
        self.error = "Não foi possível obter a posição: \(error.localizedDescription)"
    }
}

private struct MapPoint: Identifiable {
    let id = UUID()
    var coordinate: CLLocationCoordinate2D
}

/// Posição atual (com permissão e revisão no mapa) ou coordenadas manuais.
struct LocationSheet: View {
    var onUse: (LocationDraft) -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var provider = LocationProvider()
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var name = ""
    @State private var address = ""
    @State private var region = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: -15.7801, longitude: -47.9292), span: MKCoordinateSpan(latitudeDelta: 0.02, longitudeDelta: 0.02))
    @State private var geocoding = false

    private var coordinate: CLLocationCoordinate2D? {
        guard let lat = Double(latitude.replacingOccurrences(of: ",", with: ".")), let lon = Double(longitude.replacingOccurrences(of: ",", with: ".")),
              abs(lat) <= 90, abs(lon) <= 180 else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    var body: some View {
        AppNavigationStack {
            Form {
                Section {
                    Button {
                        provider.request()
                    } label: {
                        HStack {
                            Label("Usar minha posição atual", systemImage: "location.fill")
                            Spacer()
                            if provider.busy || geocoding { ProgressView() }
                        }
                    }
                    if let e = provider.error { Text(e).font(.footnote).foregroundStyle(.red) }
                } footer: {
                    Text("A localização é usada apenas quando você escolhe compartilhá-la. Revise antes de enviar.")
                }
                Section("Coordenadas") {
                    TextField("Latitude (ex.: -23.5505)", text: $latitude).keyboardType(.numbersAndPunctuation)
                    TextField("Longitude (ex.: -46.6333)", text: $longitude).keyboardType(.numbersAndPunctuation)
                    TextField("Nome do local (opcional)", text: $name)
                    TextField("Endereço (opcional)", text: $address)
                }
                if let coordinate {
                    Section("Revisão") {
                        Map(coordinateRegion: $region, interactionModes: [.zoom, .pan], annotationItems: [MapPoint(coordinate: coordinate)]) { point in
                            MapMarker(coordinate: point.coordinate, tint: .red)
                        }
                        .frame(height: 220)
                        .listRowInsets(EdgeInsets())
                    }
                }
            }
            .navigationTitle("Compartilhar localização")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Usar") {
                        if let c = coordinate {
                            onUse(LocationDraft(latitude: c.latitude, longitude: c.longitude, name: String(name.prefix(200)), address: String(address.prefix(500))))
                            dismiss()
                        }
                    }
                    .disabled(coordinate == nil)
                }
            }
            .onReceive(provider.$location) { loc in
                guard let loc else { return }
                latitude = String(format: "%.6f", loc.coordinate.latitude)
                longitude = String(format: "%.6f", loc.coordinate.longitude)
                region.center = loc.coordinate
                Task { await reverseGeocode(loc) }
            }
            .onChange(of: latitude) { _ in if let c = coordinate { region.center = c } }
            .onChange(of: longitude) { _ in if let c = coordinate { region.center = c } }
        }
    }

    private func reverseGeocode(_ loc: CLLocation) async {
        guard address.isEmpty else { return }
        geocoding = true
        defer { geocoding = false }
        if let place = try? await CLGeocoder().reverseGeocodeLocation(loc).first {
            let parts = [place.thoroughfare, place.subThoroughfare].compactMap { $0 }.joined(separator: ", ")
            let city = [place.locality, place.administrativeArea].compactMap { $0 }.joined(separator: " - ")
            address = [parts, city].filter { !$0.isEmpty }.joined(separator: ", ")
            if name.isEmpty, let n = place.name, n != parts { name = n }
        }
    }
}
