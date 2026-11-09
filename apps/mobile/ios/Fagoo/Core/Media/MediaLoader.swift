import Foundation
import UniformTypeIdentifiers

/// Authorized online reads; only short-lived protected files for the system viewer/player.
actor MediaLoader {
    static let shared = MediaLoader()
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fagoo-private-media", isDirectory: true)
    private var epoch = UUID()
    func data(mediaId: String, profileId: String, api: APIClient) async throws -> Data {
        let current = epoch
        let bytes = try await api.raw(.get, "v1/communication/units/\(profileId)/media/\(mediaId)/content")
        guard current == epoch else { throw CancellationError() }; try api.checkValid(); return bytes
    }
    func fileURL(for file: MediaFile, profileId: String, api: APIClient) async throws -> URL {
        let current = epoch
        let bytes = try await data(mediaId: file.id, profileId: profileId, api: api)
        guard current == epoch else { throw CancellationError() }; try api.checkValid()
        let folder = directory.appendingPathComponent(UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at: folder,withIntermediateDirectories:true)
        let url = folder.appendingPathComponent(Self.safeFileName(file))
        try bytes.write(to:url,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication]); return url
    }
    func clear() {
        epoch = UUID()
        try? FileManager.default.removeItem(at:directory)
        let voice = FileManager.default.temporaryDirectory.appendingPathComponent("fagoo-voice",isDirectory:true)
        try? FileManager.default.removeItem(at:voice)
    }
    /// Nome seguro para o sistema de arquivos, com extensão coerente com o tipo MIME.
    static func safeFileName(_ file: MediaFile) -> String {
        var name = file.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let forbidden = CharacterSet(charactersIn: "/\\:*?\"<>|\u{0}")
        name = String(name.unicodeScalars.map { forbidden.contains($0) ? "_" : Character($0) })
        if name.isEmpty || name == "." || name == ".." { name = "anexo" }
        if (name as NSString).pathExtension.isEmpty, let ext = extensionFor(mimeType: file.type) { name += "." + ext }
        return String(name.prefix(120))
    }

    static func extensionFor(mimeType: String) -> String? {
        let mime = mimeType.split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces).lowercased() ?? mimeType
        if mime == "audio/ogg" { return "ogg" }
        return UTType(mimeType: mime)?.preferredFilenameExtension
    }
}

extension MediaFile {
    var mimeBase: String { type.split(separator: ";").first.map { String($0).trimmingCharacters(in: .whitespaces).lowercased() } ?? type.lowercased() }
    var isImage: Bool { mimeBase.hasPrefix("image/") }
    var isVideo: Bool { mimeBase.hasPrefix("video/") }
    var isAudio: Bool { mimeBase.hasPrefix("audio/") }
    var isDocument: Bool { !isImage && !isVideo && !isAudio }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: size, countStyle: .file) }
}
