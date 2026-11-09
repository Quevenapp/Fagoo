// SPDX-License-Identifier: AGPL-3.0-only
import Foundation
import CryptoKit

struct PanelEffectReceipt: Codable { let job: String; let claim: String; let result: String }

/// Only technical receipts are durable: never commands, messages, customer data or printable payloads.
final class PanelJournal {
    private struct State: Codable { var pendingCommand: String?; var effects: [PanelEffectReceipt] = [] }
    private let url: URL
    private var state: State
    init(origin: URL, device: String, directory: URL? = nil) throws {
        let folder = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("FagooPanelReceipts", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var excluded = folder; var values = URLResourceValues(); values.isExcludedFromBackup = true; try excluded.setResourceValues(values)
        let key = SHA256.hash(data: Data((origin.absoluteString + "|" + device).utf8)).map { String(format: "%02x", $0) }.joined()
        url = folder.appendingPathComponent(key + ".json")
        if FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url); guard data.count < 1_048_576 else { throw PanelFailure.journalUnavailable }
            state = try JSONDecoder().decode(State.self, from: data)
        } else { state = State() }
    }
    var pendingCommand: String? { state.pendingCommand }
    var receipts: [PanelEffectReceipt] { state.effects }
    func setPending(_ value: String?) throws { var next = state; next.pendingCommand = value; try save(next) }
    func record(_ receipt: PanelEffectReceipt) throws {
        var next = state; next.effects.removeAll { $0.job == receipt.job }; next.effects.append(receipt)
        guard next.effects.count <= 1_000 else { throw PanelFailure.journalUnavailable }; try save(next)
    }
    func confirmed(_ id: String) throws { var next = state; next.effects.removeAll { $0.job == id }; try save(next) }
    private func save(_ next: State) throws {
        try JSONEncoder().encode(next).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); state = next
    }
}
