import Foundation

/// Converte a gravação Opus-em-CAF do `AVAudioRecorder` em um arquivo Ogg/Opus válido (RFC 7845),
/// sem reencodar: lê os chunks `desc`, `pakt` e `data` do CAF e reempacota os pacotes Opus em páginas Ogg
/// com `OpusHead`, `OpusTags`, lacing, granule positions e CRC32 (polinômio 0x04c11db7, sem reflexão).
enum OggOpusMuxer {
    enum MuxError: LocalizedError {
        case notCAF, missingChunk(String), notOpus, malformed(String), empty
        var errorDescription: String? {
            switch self {
            case .notCAF: return "O arquivo gravado não é CAF."
            case .missingChunk(let c): return "Gravação sem o bloco \(c)."
            case .notOpus: return "A gravação não está em Opus."
            case .malformed(let m): return "Gravação inválida: \(m)."
            case .empty: return "A gravação está vazia."
            }
        }
    }

    /// Conteúdo relevante de um CAF com Opus.
    struct CAFAudio: Equatable {
        var sampleRate: Double
        var channels: Int
        var framesPerPacket: Int
        var packets: [Data]
        var primingFrames: Int
        var validFrames: Int64
    }

    static let defaultPreSkip = 312

    // MARK: Conversão

    /// Lê `cafURL` e grava um Ogg/Opus em `oggURL`.
    static func convert(cafURL: URL, to oggURL: URL) throws {
        let caf = try parseCAF(try Data(contentsOf: cafURL))
        guard !caf.packets.isEmpty else { throw MuxError.empty }
        let ogg = ogg(packets: caf.packets, channels: max(1, caf.channels), preSkip: caf.primingFrames > 0 ? caf.primingFrames : defaultPreSkip, inputSampleRate: UInt32(caf.sampleRate > 0 ? caf.sampleRate : 48000), validFrames: caf.validFrames > 0 ? caf.validFrames : nil)
        try ogg.write(to: oggURL, options: .atomic)
    }

    // MARK: CAF

    static func parseCAF(_ data: Data) throws -> CAFAudio {
        let bytes = [UInt8](data)
        guard bytes.count >= 8, bytes[0] == 0x63, bytes[1] == 0x61, bytes[2] == 0x66, bytes[3] == 0x66 else { throw MuxError.notCAF } // "caff"
        var offset = 8
        var sampleRate = 0.0, channels = 0, framesPerPacket = 0, bytesPerPacket = 0
        var formatID = ""
        var audio: [UInt8] = []
        var packetSizes: [Int]? = nil
        var priming = 0
        var validFrames: Int64 = 0
        var sawDesc = false, sawData = false

        while offset + 12 <= bytes.count {
            let type = String(bytes: bytes[offset..<offset + 4], encoding: .isoLatin1) ?? ""
            let declared = readInt64BE(bytes, offset + 4)
            offset += 12
            let available = bytes.count - offset
            let size: Int = declared < 0 ? available : Int(min(declared, Int64(available)))
            let body = bytes[offset..<offset + size]
            switch type {
            case "desc":
                guard size >= 32 else { throw MuxError.malformed("desc curto") }
                sampleRate = Double(bitPattern: UInt64(bitPattern: readInt64BE(bytes, offset)))
                formatID = String(bytes: bytes[offset + 8..<offset + 12], encoding: .isoLatin1) ?? ""
                bytesPerPacket = Int(readUInt32BE(bytes, offset + 16))
                framesPerPacket = Int(readUInt32BE(bytes, offset + 20))
                channels = Int(readUInt32BE(bytes, offset + 24))
                sawDesc = true
            case "pakt":
                guard size >= 24 else { throw MuxError.malformed("pakt curto") }
                let count = readInt64BE(bytes, offset)
                validFrames = readInt64BE(bytes, offset + 8)
                priming = Int(Int32(bitPattern: readUInt32BE(bytes, offset + 16)))
                var p = offset + 24
                let end = offset + size
                var sizes: [Int] = []
                sizes.reserveCapacity(Int(max(0, min(count, 1_000_000))))
                while p < end, Int64(sizes.count) < count {
                    var value = 0
                    var done = false
                    while p < end {
                        let b = Int(bytes[p]); p += 1
                        value = (value << 7) | (b & 0x7f)
                        if b & 0x80 == 0 { done = true; break }
                    }
                    if !done { break }
                    sizes.append(value)
                }
                packetSizes = sizes
            case "data":
                guard size >= 4 else { throw MuxError.malformed("data curto") }
                audio = Array(body.dropFirst(4)) // editCount
                sawData = true
            default:
                break
            }
            offset += size
            if declared < 0 { break }
        }
        guard sawDesc else { throw MuxError.missingChunk("desc") }
        guard formatID == "opus" else { throw MuxError.notOpus }
        guard sawData else { throw MuxError.missingChunk("data") }

        var packets: [Data] = []
        if let sizes = packetSizes {
            var p = 0
            for s in sizes {
                guard s >= 0, p + s <= audio.count else { break }
                if s > 0 { packets.append(Data(audio[p..<p + s])) }
                p += s
            }
        } else if bytesPerPacket > 0 {
            var p = 0
            while p + bytesPerPacket <= audio.count {
                packets.append(Data(audio[p..<p + bytesPerPacket]))
                p += bytesPerPacket
            }
        } else {
            throw MuxError.missingChunk("pakt")
        }
        return CAFAudio(sampleRate: sampleRate, channels: channels, framesPerPacket: framesPerPacket, packets: packets, primingFrames: priming, validFrames: validFrames)
    }

    // MARK: Ogg

    /// Monta o fluxo Ogg completo: página OpusHead (BOS), OpusTags e páginas de áudio (última com EOS).
    static func ogg(packets: [Data], channels: Int, preSkip: Int, inputSampleRate: UInt32 = 48000, validFrames: Int64? = nil, serial: UInt32 = UInt32.random(in: 1..<UInt32.max), packetsPerPage: Int = 50) -> Data {
        var out = Data()
        out.append(page(packets: [opusHead(channels: channels, preSkip: preSkip, inputSampleRate: inputSampleRate)], granule: 0, serial: serial, sequence: 0, flags: 0x02))
        out.append(page(packets: [opusTags()], granule: 0, serial: serial, sequence: 1, flags: 0x00))
        guard !packets.isEmpty else { return out }

        let finalGranule: Int64? = validFrames.map { Int64(preSkip) + $0 }
        var sequence: UInt32 = 2
        var samples: Int64 = 0
        var index = 0
        while index < packets.count {
            var group: [Data] = []
            var segments = 0
            while index < packets.count, group.count < packetsPerPage {
                let need = packets[index].count / 255 + 1
                if segments + need > 255 { break }
                segments += need
                group.append(packets[index])
                samples += Int64(opusPacketSamples(packets[index]))
                index += 1
            }
            if group.isEmpty { // pacote gigante; impossível em Opus, mas evita laço infinito
                group.append(packets[index]); samples += Int64(opusPacketSamples(packets[index])); index += 1
            }
            let last = index >= packets.count
            var granule = samples
            if last, let f = finalGranule, f < granule { granule = f }
            out.append(page(packets: group, granule: granule, serial: serial, sequence: sequence, flags: last ? 0x04 : 0x00))
            sequence += 1
        }
        return out
    }

    /// Uma página Ogg com os pacotes informados (cada um inteiro na página).
    static func page(packets: [Data], granule: Int64, serial: UInt32, sequence: UInt32, flags: UInt8) -> Data {
        var lacing: [UInt8] = []
        for p in packets {
            var remaining = p.count
            while remaining >= 255 { lacing.append(255); remaining -= 255 }
            lacing.append(UInt8(remaining))
        }
        assert(lacing.count <= 255, "Página Ogg com mais de 255 segmentos")
        var header = Data()
        header.append(contentsOf: [0x4f, 0x67, 0x67, 0x53]) // OggS
        header.append(0) // versão
        header.append(flags)
        header.append(le64(UInt64(bitPattern: granule)))
        header.append(le32(serial))
        header.append(le32(sequence))
        header.append(contentsOf: [0, 0, 0, 0]) // CRC (preenchido depois)
        header.append(UInt8(lacing.count))
        header.append(contentsOf: lacing)
        var body = Data()
        for p in packets { body.append(p) }
        var pageData = header + body
        let crc = crc32(pageData)
        pageData.replaceSubrange(22..<26, with: le32(crc))
        return pageData
    }

    static func opusHead(channels: Int, preSkip: Int, inputSampleRate: UInt32) -> Data {
        var d = Data("OpusHead".utf8)
        d.append(1) // versão
        d.append(UInt8(clamping: channels))
        d.append(le16(UInt16(clamping: preSkip)))
        d.append(le32(inputSampleRate))
        d.append(le16(0)) // ganho
        d.append(0) // família de mapeamento: mono/estéreo
        return d
    }

    static func opusTags(vendor: String = "Fagoo iOS") -> Data {
        var d = Data("OpusTags".utf8)
        let v = Data(vendor.utf8)
        d.append(le32(UInt32(v.count)))
        d.append(v)
        d.append(le32(0))
        return d
    }

    /// Amostras (a 48 kHz) de um pacote Opus a partir do byte TOC (RFC 6716 §3.1).
    static func opusPacketSamples(_ packet: Data) -> Int {
        guard let toc = packet.first else { return 0 }
        let config = Int(toc >> 3)
        let code = Int(toc & 0x03)
        let frameSamples: Int
        switch config {
        case 0...11: frameSamples = [480, 960, 1920, 2880][config % 4]        // SILK 10/20/40/60 ms
        case 12...15: frameSamples = (config % 2 == 0) ? 480 : 960            // híbrido 10/20 ms
        default: frameSamples = [120, 240, 480, 960][config % 4]             // CELT 2,5/5/10/20 ms
        }
        let frames: Int
        switch code {
        case 0: frames = 1
        case 1, 2: frames = 2
        default:
            guard packet.count >= 2 else { return 0 }
            frames = Int(packet[packet.startIndex + 1] & 0x3f)
        }
        return frameSamples * frames
    }

    // MARK: CRC32 do Ogg (0x04c11db7, inicial 0, sem reflexão, sem XOR final)

    private static let crcTable: [UInt32] = {
        (0..<256).map { i -> UInt32 in
            var r = UInt32(i) << 24
            for _ in 0..<8 { r = (r & 0x8000_0000) != 0 ? (r << 1) ^ 0x04c1_1db7 : r << 1 }
            return r
        }
    }()

    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0
        for b in data { crc = (crc << 8) ^ crcTable[Int((crc >> 24) & 0xff) ^ Int(b)] }
        return crc
    }

    // MARK: Auxiliares binários

    static func le16(_ v: UInt16) -> Data { Data([UInt8(v & 0xff), UInt8(v >> 8)]) }
    static func le32(_ v: UInt32) -> Data { Data([UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8(v >> 24)]) }
    static func le64(_ v: UInt64) -> Data { Data((0..<8).map { UInt8((v >> (UInt64($0) * 8)) & 0xff) }) }

    static func readUInt32BE(_ b: [UInt8], _ o: Int) -> UInt32 {
        (UInt32(b[o]) << 24) | (UInt32(b[o + 1]) << 16) | (UInt32(b[o + 2]) << 8) | UInt32(b[o + 3])
    }
    static func readInt64BE(_ b: [UInt8], _ o: Int) -> Int64 {
        var v: UInt64 = 0
        for i in 0..<8 { v = (v << 8) | UInt64(b[o + i]) }
        return Int64(bitPattern: v)
    }
    static func readUInt32LE(_ d: Data, _ o: Int) -> UInt32 {
        let i = d.startIndex + o
        return UInt32(d[i]) | (UInt32(d[i + 1]) << 8) | (UInt32(d[i + 2]) << 16) | (UInt32(d[i + 3]) << 24)
    }
    static func readInt64LE(_ d: Data, _ o: Int) -> Int64 {
        var v: UInt64 = 0
        for k in (0..<8).reversed() { v = (v << 8) | UInt64(d[d.startIndex + o + k]) }
        return Int64(bitPattern: v)
    }
}
