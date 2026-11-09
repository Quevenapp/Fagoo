import Foundation
import XCTest
@testable import ThermalPrinterKit

final class PrinterProbePayloadsTests: XCTestCase {
    private let probeTearFeed: UInt8 = 12

    func testLinhaDePaginaMedeAsCincoLetrasQueDistinguem() {
        let payload = PrinterProbePayloads.textEncoding()
        let utf8 = Data("UTF-8: \(PrinterProbePayloads.textEncodingSample)\n".utf8)

        // `café, açúcar, três` era cego: `é ç ú ê` têm o mesmo desenho em CP437 e CP860.
        XCTAssertTrue(payload.contains(Data([0x84, 0x87, 0x94, 0xA0, 0x88])))
        XCTAssertTrue(payload.contains(utf8))
        XCTAssertFalse(payload.contains(Data([0x1B, 0x74])))
    }

    /// Só o corpo do texto: cabeçalho e rodapé saem por comparação com a renderização vazia.
    private func encodedSample(_ page: ThermalCodePage) -> Data {
        func render(_ value: String) -> Data {
            EscPos.text(value, alignment: 0, bold: false, size: 0, codePage: page)
        }
        let comAmostra = [UInt8](render(PrinterProbePayloads.textEncodingSample))
        let vazio = [UInt8](render(""))
        var prefixo = 0
        while prefixo < vazio.count, comAmostra[prefixo] == vazio[prefixo] { prefixo += 1 }
        var sufixo = 0
        while sufixo < vazio.count - prefixo,
              comAmostra[comAmostra.count - 1 - sufixo] == vazio[vazio.count - 1 - sufixo] {
            sufixo += 1
        }
        return Data(comAmostra[prefixo..<(comAmostra.count - sufixo)])
    }

    func testListOpensWithAsciiFirmwareDefaultAndUtf8() {
        let candidates = PrinterProbePayloads.codePageCandidates

        // As três primeiras são o que a tela perguntava numa etapa separada até 12/08. Quem está
        // com o papel na mão responde qual linha saiu legível, não qual modelo de codificação quer.
        XCTAssertEqual(
            candidates.prefix(3).map(\.textEncoding),
            [.ascii, .firmwareDefaultPage, .utf8]
        )
        XCTAssertEqual(String(candidates.prefix(3).map(\.letter)), "abc")
        // A linha `a` é o piso: sem acento nenhum, e por isso não pode carregar página.
        XCTAssertNil(candidates[0].codePage)
        XCTAssertNil(candidates[0].selector)
        XCTAssertEqual(candidates[1].codePage, .cp860)
        XCTAssertNil(candidates[1].selector)
        // Uma letra por linha, sem furo e sem passar do alfabeto: a resposta é uma letra.
        XCTAssertEqual(
            String(candidates.map(\.letter)),
            String("abcdefghijklmnopqrstuvwxyz".prefix(candidates.count))
        )
        // Nomes antes de endereços. A CP858 caiu: para esta frase ela emite os mesmos bytes da
        // CP850, e a lista precisava caber no alfabeto.
        XCTAssertEqual(
            candidates.filter { !$0.isAddress && $0.textEncoding == .singleByteCodePage }.map(\.codePage),
            [.cp850, .cp1252]
        )
        XCTAssertEqual(candidates.filter(\.isAddress).map(\.selector), Array(UInt8(0)...UInt8(20)).map { $0 })
        XCTAssertTrue(candidates.filter(\.isAddress).allSatisfy { $0.codePage == .cp860 })
        // Nenhuma linha repetida: duas iguais no papel deixariam a escolha ambígua.
        let identities = Set(candidates.map {
            "\($0.textEncoding.rawValue)/\($0.selector.map(String.init) ?? "-")/\($0.codePage?.label ?? "-")"
        })
        XCTAssertEqual(identities.count, candidates.count)
    }

    func testNoCandidateFoldsThePhraseToAscii() {
        // Com as cinco letras soltas, uma página incapaz de `ã` saía visivelmente errada. Com a
        // frase, ela sairia `cao, acoes, avo` — limpa, legível e sem acento nenhum, que é o que
        // alguém escolheria por engano. Por isso esse texto existe uma vez só, na linha `a`.
        for candidate in PrinterProbePayloads.codePageCandidates where candidate.textEncoding.usesCodePage {
            let page = candidate.codePage!
            for scalar in PrinterProbePayloads.codePageSample.unicodeScalars where !scalar.isASCII {
                XCTAssertNotNil(page.encode(scalar), "\(candidate.label) dobraria \(scalar) para ASCII")
            }
        }
    }

    func testEachRowComesFromTheSellingEncoder() throws {
        let receipt = PrinterProbePayloads.codePage()

        for candidate in PrinterProbePayloads.codePageCandidates {
            XCTAssertTrue(
                receipt.contains(PrinterProbePayloads.codePageRow(candidate)),
                candidate.label
            )
        }
        // A linha sem seleção só é honesta se nenhum `ESC t` a preceder na tira.
        let firstRow = PrinterProbePayloads.codePageRow(PrinterProbePayloads.codePageCandidates[0])
        let start = try XCTUnwrap(receipt.range(of: firstRow)).lowerBound
        XCTAssertNil(receipt[receipt.startIndex..<start].range(of: Data([0x1b, 0x74])))
    }

    func testStripShowsNoTechnicalCode() {
        let receipt = PrinterProbePayloads.codePage()

        // Nome de página e endereço são vocabulário da bancada. No papel só existem letra e frase;
        // o código aparece no comprovante final, onde serve ao catálogo.
        for forbidden in ["CP8", "CP4", "CP1", "n=", "PAGINA", "GABARITO"] {
            XCTAssertNil(receipt.range(of: Data(forbidden.utf8)), forbidden)
        }
        for candidate in PrinterProbePayloads.codePageCandidates {
            XCTAssertNotNil(receipt.range(of: Data("\(candidate.letter)) ".utf8)))
        }
    }

    func testAnnouncedLineCountBelongsToThisPrinter() {
        let candidates = PrinterProbePayloads.codePageCandidates.count
        let narrow = PrinterProbePayloads.codePageProbeLineCount(printableColumns: 32)
        let wide = PrinterProbePayloads.codePageProbeLineCount(printableColumns: 48)

        // Em 58 mm a frase não cabe numa linha; em 80 mm cabe. Duas linhas de instrução mais a
        // linha em branco que separa a lista.
        // Com as maiúsculas a amostra ocupa duas linhas nas duas larguras: 58 caracteres não cabem
        // nem em 48 colunas.
        let instrucao = PrinterProbePayloads.codePageInstructions.filter { $0 == "\n" }.count
        XCTAssertEqual(narrow, 2 * candidates + instrucao)
        XCTAssertEqual(wide, 2 * candidates + instrucao)
    }

    func testT210RecebeAFraseCP860NaLinhaCanonicaEEmN08() throws {
        let candidates = PrinterProbePayloads.codePageCandidates
        let canonical = try XCTUnwrap(candidates.first { $0.isAddress && $0.selector == 3 })
        let measured = try XCTUnwrap(candidates.first { $0.isAddress && $0.selector == 8 })
        let phrase = Data(PrinterProbePayloads.codePageSample.unicodeScalars.map {
            ThermalCodePage.cp860.encode($0) ?? UInt8($0.value)
        })

        XCTAssertEqual(canonical.codePage, .cp860)
        XCTAssertEqual(measured.codePage, .cp860)
        // Mesma frase, mesmos bytes de texto; só o endereço muda. Na T210, n=03 aponta para CP437
        // e a frase sai `cäo, açoes`; n=08 aponta para CP860 e sai inteira. Prova física pendente.
        for candidate in [canonical, measured] {
            XCTAssertNotNil(PrinterProbePayloads.codePageRow(candidate).range(of: phrase), candidate.label)
        }
    }

    func testProbesWithoutCutEndWithEnoughFeedToClearTheTearBar() {
        // Com 4 linhas a MP-4200 e a i9 seguraram régua raster e amostra dentro da impressora.
        // O avanço vai em quebras de linha porque a MP-4200 ignora `ESC d`.
        let tail = Data(repeating: 0x0a, count: Int(probeTearFeed))
        let probes = [
            PrinterProbePayloads.geometry(paperWidth: .mm58),
            PrinterProbePayloads.geometry(paperWidth: .mm80),
            PrinterProbePayloads.textEncoding(),
            PrinterProbePayloads.codePage(),
            PrinterProbePayloads.cutProtocol(),
        ]

        for probe in probes {
            XCTAssertEqual(probe.suffix(tail.count), tail)
        }
    }

    func testSondasDepoisDoAvancoTerminamNaMedidaDaImpressoraECorte() {
        // Oito é deliberadamente diferente do palpite curto de cinco: depois da sonda de avanço,
        // conservar cinco cortaria texto numa firmware com vão maior e usar doze desperdiçaria
        // papel numa impressora que já respondeu oito.
        let measuredFeed = 8
        let ending = Data(repeating: 0x0a, count: measuredFeed)
            + CutProtocol.gsV1.command
        let probes = [
            PrinterProbePayloads.textEncoding(cutProtocol: .gsV1, cutFeedLines: measuredFeed),
            PrinterProbePayloads.codePage(cutProtocol: .gsV1, cutFeedLines: measuredFeed),
        ]

        for probe in probes {
            XCTAssertEqual(probe.suffix(ending.count), ending)
            XCTAssertNotEqual(
                probe.suffix(Int(probeTearFeed) + CutProtocol.gsV1.command.count),
                Data(repeating: 0x0a, count: Int(probeTearFeed)) + CutProtocol.gsV1.command
            )
        }
    }

    func testSondasComCorteDeAvancoEmbutidoNaoAcrescentamLF() {
        for dialect in [CutProtocol.gsV65, .gsV66] {
            let probes = [
                PrinterProbePayloads.textEncoding(cutProtocol: dialect, cutFeedLines: 0),
                PrinterProbePayloads.codePage(cutProtocol: dialect, cutFeedLines: 0),
            ]
            for payload in probes {
                XCTAssertEqual(payload.suffix(dialect.command.count), dialect.command)
                XCTAssertNotEqual(
                    // Cinco é só um comprimento de amostra: o que se afirma é que não há avanço
                    // nenhum antes do comando destes dialetos.
                    payload.dropLast(dialect.command.count).suffix(5),
                    Data(repeating: 0x0a, count: 5)
                )
            }
        }
    }

    func testCutProbeWarnsAgainstPullingAndNeverTellsToGiveUpOnPartial() {
        let receipt = PrinterProbePayloads.cutProtocol()

        // A aba do corte parcial rasga na mão igual a picote: quem puxa antes de olhar perde a
        // única prova de que o comando parcial foi obedecido.
        XCTAssertTrue(receipt.contains(Data("Nao puxe as tiras antes de ver".utf8)))
        XCTAssertTrue(receipt.contains(Data("passa a ser o corte de toda venda".utf8)))
        // MP-4200 e i9 fazem parcial; o papel não pode mandar trocar por total.
        XCTAssertFalse(receipt.contains(Data("nao faz parcial".utf8)))
        XCTAssertFalse(receipt.contains(Data("escolha o total".utf8)))
    }

    func testNoCutBlockFeedsPaperAfterTheCommand() {
        let receipt = [UInt8](PrinterProbePayloads.cutProtocol())
        let feed: [UInt8] = [0x1b, 0x64]

        // Cada linha empurrada depois de um corte parcial puxa a tira presa pela aba.
        for candidate in PrinterProbePayloads.cutProtocolCandidates where !candidate.commandBytes.isEmpty {
            let command = [UInt8](candidate.commandBytes)
            for start in receipt.indices where Array(receipt[start...].prefix(command.count)) == command {
                let after = Array(receipt[(start + command.count)...].prefix(feed.count))
                XCTAssertNotEqual(after, feed, "\(candidate.cutProtocol)")
            }
        }
    }

    func testCutModeSwapsTheSiblingAndKeepsTheMeasuredDialect() {
        // Dialeto é medido; modo é escolha. Antes os dois viviam no mesmo campo e a ordem dos
        // candidatos (totais primeiro) fazia toda impressora terminar em corte total.
        XCTAssertEqual(CutProtocol.gsV0.withCutMode(.partial), .gsV1)
        XCTAssertEqual(CutProtocol.gsV1.withCutMode(.total), .gsV0)
        XCTAssertEqual(CutProtocol.gsV65.withCutMode(.partial), .gsV66)
        XCTAssertEqual(CutProtocol.gsV66.withCutMode(.total), .gsV65)
        XCTAssertEqual(CutProtocol.escI.withCutMode(.partial), .escM)
        XCTAssertEqual(CutProtocol.escM.withCutMode(.total), .escI)
        XCTAssertEqual(CutProtocol.none.withCutMode(.partial), CutProtocol.none)
        XCTAssertNil(CutProtocol.none.cutMode)
        for dialect in CutProtocol.allCases where dialect.hasCutter {
            XCTAssertEqual(dialect.withCutMode(.partial).cutMode, .partial)
            XCTAssertEqual(dialect.withCutMode(.total).cutMode, .total)
            // O irmão nunca sai da família de avanço embutido, que é a regra do perfil.
            XCTAssertEqual(dialect.withCutMode(.partial).hasEmbeddedFeed, dialect.hasEmbeddedFeed)
        }
    }

    func testIsolatedCutEndsAtTheCommandWithNothingAfterIt() throws {
        for dialect in CutProtocol.allCases where dialect.hasCutter {
            let payload = try XCTUnwrap(PrinterProbePayloads.isolatedCut(dialect))
            XCTAssertEqual(payload.suffix(dialect.command.count), dialect.command)
            // Sem avanço extra nos que já carregam o próprio: seria corte em posição errada.
            XCTAssertEqual(
                payload.contains(Data(repeating: 0x0a, count: Int(probeTearFeed))),
                !dialect.hasEmbeddedFeed
            )
        }
        XCTAssertNil(PrinterProbePayloads.isolatedCut(.none))
    }

    func testTextOnlyEmitsTheSizeCommandWhenItActuallyResizes() {
        let normal = EscPos.text("AVANCO 5", alignment: 0, bold: false, size: 0, codePage: nil)
        let doubled = EscPos.text("5", alignment: 1, bold: true, size: 0x11, codePage: nil)

        // A MP-4200 TH engole só o `GS` e manda o `!` para o papel: saiu "!0" no número e
        // "!!Escolha" na instrução da sonda de avanço.
        XCTAssertFalse(normal.contains(Data([0x1d, 0x21])))
        // Quem amplia continua pedindo o tamanho e devolvendo a zero no fim, senão vaza para o
        // bloco seguinte, que não emite mais o comando.
        XCTAssertTrue(doubled.contains(Data([0x1d, 0x21, 0x11])))
        XCTAssertEqual(doubled.suffix(3), Data([0x1d, 0x21, 0x00]))
    }

    func testNoProbeEmitsTheSizeCommand() {
        var payloads = [
            PrinterProbePayloads.geometry(paperWidth: .mm58),
            PrinterProbePayloads.geometry(paperWidth: .mm80),
            PrinterProbePayloads.codePage(),
            PrinterProbePayloads.cutProtocol(),
        ]
        payloads += CutProtocol.allCases.compactMap { PrinterProbePayloads.cutFeed(cutProtocol: $0) }
        payloads += CutProtocol.allCases.compactMap { PrinterProbePayloads.isolatedCut($0) }

        for payload in payloads {
            // A MP-4200 engole só o `GS` e manda o `!` para o papel: a tira saía "!5" e "!!Escolha".
            XCTAssertFalse(payload.contains(Data([0x1d, 0x21])))
        }
    }

    /// O comprovante final prova exatamente o que a tira mediu — maiúscula inclusive.
    ///
    /// Enquanto a amostra era só minúscula, esta linha dizia menos do que o papel precisava: a
    /// T210 passou na tira com `cão, ações, avô` e falhou no título, porque `Ç` e `Í` moram na
    /// metade alta da tabela e nunca tinham sido medidos.
    ///
    /// O perfil do teste é UTF-8 de propósito: ali o texto sai nos bytes do próprio caractere. O QR
    /// fica de fora porque raster é imagem, e imagem tem qualquer byte.
    func testFinalReceiptRepeatsTheMeasuredSampleWithUppercase() throws {
        let profile = try MeasuredProfile(
            id: UUID(),
            displayName: "MTP-II de bancada",
            measuredAt: Date(timeIntervalSince1970: 1),
            transports: [.bluetoothLE],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .utf8,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )
        let receipt = PrinterProbePayloads.finalReceipt(profile: profile)
        let rasterStart = try XCTUnwrap(receipt.range(of: Data([0x1d, 0x76, 0x30])))
        let text = try XCTUnwrap(String(data: receipt[receipt.startIndex..<rasterStart.lowerBound], encoding: .utf8))

        // A quebra do perfil pode trocar um espaço da amostra por uma quebra de linha: o que se
        // afirma é que a amostra inteira está lá, não em que coluna ela terminou.
        let oneLine = text.replacingOccurrences(of: "\n", with: " ")
        XCTAssertTrue(oneLine.contains(PrinterProbePayloads.codePageSample))
        XCTAssertTrue(oneLine.contains("ação, opção, São João"))
        XCTAssertTrue(PrinterProbePayloads.codePageSample.contains { $0.isUppercase && !$0.isASCII })
        XCTAssertTrue(PrinterProbePayloads.codePageSample.contains { $0.isLowercase && !$0.isASCII })
    }

    /// Nenhuma linha do comprovante final estoura a largura medida.
    ///
    /// Medido no papel da T210 em 12/08, já com 58 mm e 32 colunas certos: "Codificação: Padrão da
    /// impressora" tem 33 caracteres, a firmware quebrou na coluna exata e saiu "impressor / a".
    /// Palavra partida é a assinatura que a tela ensina a procurar para largura errada.
    func testFinalReceiptNeverExceedsTheMeasuredWidth() throws {
        for columns in [32, 48] {
            // O caso pior de cada linha nova: fator gravado — a redação com os dois números — e
            // modo não honrado, que é a mais comprida das três redações do corte.
            let comMedidaTardia = try MeasuredProfile(
                id: UUID(),
                displayName: "Impressora de bancada com nome comprido de propósito",
                measuredAt: Date(timeIntervalSince1970: 1),
                transports: [.bluetoothLE],
                paperWidth: columns == 32 ? .mm58 : .mm80,
                printableColumns: columns,
                printableDots: columns == 32 ? 384 : 576,
                codePage: nil,
                textEncoding: .utf8,
                cutProtocol: .gsV0,
                cutModeHonored: false,
                cutFeedLines: 4,
                tcpPort: nil,
                verticalRasterScale: 38.0 / Double(PrinterProbePayloads.rasterThroughputStripMillimetres)
            )
            let semMedidaTardia = try MeasuredProfile(
                id: UUID(),
                displayName: "Impressora de bancada com nome comprido de propósito",
                measuredAt: Date(timeIntervalSince1970: 1),
                transports: [.bluetoothLE],
                paperWidth: columns == 32 ? .mm58 : .mm80,
                printableColumns: columns,
                printableDots: columns == 32 ? 384 : 576,
                codePage: nil,
                textEncoding: .utf8,
                cutProtocol: .none,
                cutFeedLines: 0,
                tcpPort: nil
            )
            for profile in [comMedidaTardia, semMedidaTardia] {
                let longLines = try printedLines(of: profile).filter { $0.count > columns }
                XCTAssertEqual(longLines, [], "\(columns) colunas")
            }
        }
    }

    /// O comprovante final é a **fonte de transcrição** do cadastro de impressoras, e esta é a
    /// lista de linhas que ele promete.
    ///
    /// A partir de 20/08 o dono repassa o laboratório inteiro pela homologação e cadastra cada
    /// máquina lendo este papel. Um campo medido que não sai aqui é um campo que ninguém
    /// transcreve — e a falta só aparece depois de quinze impressoras. Um `contains` por linha não
    /// protegeria disso: ele passa igual quando uma linha some. A lista ordenada quebra quando
    /// alguém tira, renomeia ou reordena qualquer coisa.
    ///
    /// As linhas de modo do corte e de compensação entraram nesta lista em 20/08; as outras estão
    /// congeladas como já saíam. O Android fixa a sua lista equivalente em
    /// `PrinterHomologationProbesTest` — a ordem é a mesma, e as duas linhas novas são idênticas
    /// palavra por palavra; o resto do papel não é byte a byte igual entre as plataformas e nunca
    /// foi (o iOS quebra papel, colunas e dots em três linhas, e nomeia o corte "GS V 0").
    func testComprovanteFinalListaEmOrdemTudoQueOPerfilMedidoGuarda() throws {
        // Perfil em UTF-8 para o papel voltar legível sem uma tabela DOS no meio do teste; que os
        // rótulos saem na página medida quando existe uma já está fixado em
        // `testComprovanteFinalUsaAPaginaMedidaNosRotulos`.
        func perfil(
            cutModeHonored: Bool,
            verticalRasterScale: Double?,
            nativeQrHonored: Bool? = nil,
            nativeBarcodeHonored: Bool? = nil
        ) throws -> MeasuredProfile {
            try MeasuredProfile(
                id: UUID(uuidString: "6C3F1B6A-9F2D-4A1E-8F0B-2D5C7A91E4D3")!,
                displayName: "Inico T210",
                measuredAt: Date(timeIntervalSince1970: 1_700_000_000),
                transports: [.bluetoothLE],
                paperWidth: .mm58,
                printableColumns: 32,
                printableDots: 384,
                codePage: nil,
                textEncoding: .utf8,
                cutProtocol: .gsV0,
                cutModeHonored: cutModeHonored,
                cutFeedLines: 4,
                tcpPort: nil,
                verticalRasterScale: verticalRasterScale,
                nativeQrHonored: nativeQrHonored,
                nativeBarcodeHonored: nativeBarcodeHonored
            )
        }
        let medido = try perfil(
            cutModeHonored: false,
            verticalRasterScale: 38.0 / Double(PrinterProbePayloads.rasterThroughputStripMillimetres),
            // Um honra o comando e o outro não: é o par que prova que são duas capacidades, e não
            // uma só com dois nomes.
            nativeQrHonored: true,
            nativeBarcodeHonored: false
        )

        XCTAssertEqual(
            Array(try printedLines(of: medido, transport: .bluetooth).prefix(17)),
            [
                "Instalação concluída",
                "Inico T210",
                "",
                "Papel: 58 mm",
                "Colunas: 32",
                "Dots: 384",
                "Conexão: Bluetooth",
                "Página: Nenhuma (letra c)",
                "Codificação: UTF-8",
                "Corte: GS V 0",
                "Avanço: 4",
                "Modo do corte: sai diferente",
                "Vazão: 38/48 mm | fator 0,79",
                "QR nativo: sai como código",
                "Barras nativas: sai como texto",
                // A família de configuração de rede fecha o bloco das capacidades medidas: é a
                // única que não sai da série de tiras da homologação, e por isso a última antes do
                // carimbo de data. Aqui ela é a ausência, que é o que este perfil tem a dizer.
                "Config. de rede: não determinada",
                "Medida em: \(PrinterProbePayloads.localTimestamp(medido.measuredAt))",
            ]
        )

        // **Neutralidade.** Perfil sem fator, com a guilhotina obediente e anterior às duas sondas
        // tardias sai com o comprovante de sempre, e as linhas novas dizem exatamente a ausência —
        // que é a informação, e não a falta dela.
        let semMedidaTardia = try perfil(cutModeHonored: true, verticalRasterScale: nil)
        XCTAssertEqual(
            Array(try printedLines(of: semMedidaTardia, transport: .bluetooth)[11...15]),
            [
                "Modo do corte: sai como pedido",
                "Vazão: sem compensação",
                "QR nativo: não medido",
                "Barras nativas: não medido",
                "Config. de rede: não determinada",
            ]
        )
    }

    /// As duas linhas da sonda de código nativo, palavra por palavra, nos três estados.
    ///
    /// O Android fixa estes mesmos seis literais em `PrinterHomologationProbesTest`: é o par que
    /// garante que a mesma impressora homologada nos dois sistemas gere o mesmo texto para o
    /// cadastro.
    ///
    /// `não medido` é a terceira redação, e ela precisa existir: sem ela a ausência sairia como
    /// `sai como texto`, que é uma **afirmação** sobre uma firmware que ninguém mediu.
    func testAsDuasLinhasDoCodigoNativoDizemOsTresEstadosEmTrintaEDuasColunas() {
        XCTAssertEqual(PrinterProbePayloads.nativeQRLine(true), "QR nativo: sai como código\n")
        XCTAssertEqual(PrinterProbePayloads.nativeQRLine(false), "QR nativo: sai como texto\n")
        XCTAssertEqual(PrinterProbePayloads.nativeQRLine(nil), "QR nativo: não medido\n")
        XCTAssertEqual(
            PrinterProbePayloads.nativeBarcodeLine(true),
            "Barras nativas: sai como código\n"
        )
        XCTAssertEqual(
            PrinterProbePayloads.nativeBarcodeLine(false),
            "Barras nativas: sai como texto\n"
        )
        XCTAssertEqual(PrinterProbePayloads.nativeBarcodeLine(nil), "Barras nativas: não medido\n")

        // Cabem na 58 mm sem a quebra do layout precisar entrar: a mais longa tem 31 caracteres.
        for resposta in [true, false, nil] {
            XCTAssertLessThanOrEqual(
                PrinterProbePayloads.nativeQRLine(resposta).trimmingCharacters(in: .newlines).count,
                32
            )
            XCTAssertLessThanOrEqual(
                PrinterProbePayloads.nativeBarcodeLine(resposta)
                    .trimmingCharacters(in: .newlines).count,
                32
            )
        }
    }

    /// O comprovante de **teste** também lista as duas capacidades, nos três estados.
    ///
    /// É o papel que a pessoa tem na mão quando decide se o ajuste de emissão vale, e por isso ele
    /// carrega a mesma linha do comprovante final. As respostas vêm do perfil, e não do layout:
    /// depois de construído, um layout rasterizado não distingue "é o padrão" de "foi o máximo que
    /// a medição permitiu".
    func testComprovanteDeTesteListaAsDuasCapacidadesDoCodigoNativo() throws {
        let layout = ReceiptLayout(
            columns: 32,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            codePageSelector: nil,
            textEncoding: .utf8,
            cutProtocol: .none,
            cutFeedLines: 0,
            printableDots: 384
        )
        func papel(qr: Bool?, barras: Bool?) -> String {
            String(
                decoding: PrinterTestReceipt.bytes(
                    layout: layout,
                    nativeQrHonored: qr,
                    nativeBarcodeHonored: barras
                ),
                as: UTF8.self
            )
        }

        XCTAssertTrue(papel(qr: true, barras: false).contains("QR nativo: sai como código"))
        XCTAssertTrue(papel(qr: true, barras: false).contains("Barras nativas: sai como texto"))
        // Linha nenhuma some quando o valor é ausente: a ausência é a informação.
        XCTAssertTrue(papel(qr: nil, barras: nil).contains("QR nativo: não medido"))
        XCTAssertTrue(papel(qr: nil, barras: nil).contains("Barras nativas: não medido"))
    }

    /// A tira de código nativo emite os dois comandos, sem legenda e sem payload sensível.
    ///
    /// O caso de falha desta sonda é o payload sair impresso como texto legível — é exatamente isso
    /// que a pergunta distingue —, então o que ela carrega tem de ser uma palavra e nada mais.
    func testATiraDeCodigoNativoMandaOsDoisComandosSemLegenda() throws {
        let bytes = try XCTUnwrap(PrinterProbePayloads.nativeCode(printableDots: 384))
        let texto = String(decoding: bytes, as: UTF8.self)

        XCTAssertTrue(texto.contains("SONDA DE CODIGO NATIVO"))
        XCTAssertTrue(texto.contains("Duas figuras saem abaixo"))
        // O rodapé nomeia o defeito antes de ele acontecer, com a palavra que os dois códigos
        // carregam: quem lê não julga "isso é um código?", reconhece o que a tira ensinou.
        XCTAssertTrue(texto.contains("palavra \(PrinterProbePayloads.nativeCodePayload) em letras"))

        // `GS ( k` (armazenar o símbolo) e `GS k` função B, os dois comandos que o passo mede.
        XCTAssertTrue(contains(bytes, [0x1d, 0x28, 0x6b]))
        XCTAssertTrue(contains(bytes, [0x1d, 0x6b, 73]))
        // HRI desligada: `GS H 0`. Com a legenda ligada, um código correto sai com letras embaixo.
        XCTAssertTrue(contains(bytes, [0x1d, 0x48, 0x00]))
        // Nada de gravação em memória não volátil: nem `GS ( E` nem `FS q` aparecem aqui.
        XCTAssertFalse(contains(bytes, [0x1d, 0x28, 0x45]))
        XCTAssertFalse(contains(bytes, [0x1c, 0x71]))
        // O alinhamento volta para a esquerda: o nativo é estado, e estado deixado ligado
        // desalinharia a tira seguinte.
        XCTAssertTrue(contains(bytes, [0x1b, 0x61, 0x00]))
    }

    /// A tira cabe na geometria mais estreita que este kit homologa.
    ///
    /// 256 pontos é a menor largura raster que a sonda de geometria oferece, e um símbolo mais largo
    /// que o papel sairia truncado — indistinguível de "a firmware não entendeu", que é a única
    /// coisa que esta tira existe para medir. É o número que decide o tamanho do payload.
    func testATiraDeCodigoNativoCabeEmTodaLarguraHomologavel() throws {
        for dots in [256, 288, 320, 384, 512, 576, 640] {
            XCTAssertNotNil(PrinterProbePayloads.nativeCode(printableDots: dots), "\(dots) dots")
        }
        let total = try XCTUnwrap(
            ThermalBarcode.totalModules(
                PrinterProbePayloads.nativeCodePayload,
                symbology: .code128
            )
        )
        XCTAssertLessThanOrEqual(total * ThermalBarcode.moduleWidthDotsRange.lowerBound, 256)
        XCTAssertNil(PrinterProbePayloads.nativeCode(printableDots: 100))
    }

    /// Onde a sequência de comando aparece nos bytes da tira.
    private func contains(_ data: Data, _ target: [UInt8]) -> Bool {
        let bytes = [UInt8](data)
        guard !target.isEmpty, target.count <= bytes.count else { return false }
        for start in 0...(bytes.count - target.count)
        where Array(bytes[start..<(start + target.count)]) == target {
            return true
        }
        return false
    }

    /// A linha da sonda de vazão, palavra por palavra, nos casos que a régua produz.
    ///
    /// O Android fixa estes mesmos literais em `PrinterHomologationProbesTest`: é o par que
    /// garante que a mesma impressora homologada nos dois sistemas gere o mesmo texto para o
    /// cadastro.
    func testALinhaDaSondaDizALeituraOEsperadoEOFator() {
        let esperado = Double(PrinterProbePayloads.rasterThroughputStripMillimetres)

        // "Usar padrão" e tira na medida: `nil` não guarda leitura, então não há milímetro a
        // citar — mas a linha continua saindo, que é o ponto desta frente.
        XCTAssertEqual(PrinterProbePayloads.verticalRasterScaleLine(nil), "Vazão: sem compensação\n")
        // A T210 da bancada, 20/08: 38 mm de 48 na régua, fator 0,79 no perfil.
        XCTAssertEqual(
            PrinterProbePayloads.verticalRasterScaleLine(38.0 / esperado),
            "Vazão: 38/48 mm | fator 0,79\n"
        )
        // A maior leitura que ainda conclui fator, e o piso da faixa do campo. Nos dois extremos o
        // milímetro reconstruído bate com o que a pessoa respondeu.
        XCTAssertEqual(
            PrinterProbePayloads.verticalRasterScaleLine(46.0 / esperado),
            "Vazão: 46/48 mm | fator 0,96\n"
        )
        XCTAssertEqual(
            PrinterProbePayloads.verticalRasterScaleLine(ReceiptLayout.allowedVerticalRasterScale.lowerBound),
            "Vazão: 24/48 mm | fator 0,50\n"
        )
    }

    /// A linha do modo do corte separa "atende o comando" de "entrega o modo".
    ///
    /// Medido na GoldenSky 80 mm em 10/08: os sete comandos foram obedecidos e o corte saiu
    /// **sempre parcial**, inclusive nos que pedem total. O Android fixa os mesmos literais.
    func testALinhaDoModoDoCorteSeparaComandoAtendidoDeModoEntregue() {
        XCTAssertEqual(
            PrinterProbePayloads.cutModeLine(cutProtocol: .gsV0, cutModeHonored: true),
            "Modo do corte: sai como pedido\n"
        )
        XCTAssertEqual(
            PrinterProbePayloads.cutModeLine(cutProtocol: .gsV0, cutModeHonored: false),
            "Modo do corte: sai diferente\n"
        )
        // Sem guilhotina o campo do perfil continua `true` por padrão, e afirmar "sai como pedido"
        // seria afirmar sobre um corte que não acontece.
        for honored in [true, false] {
            XCTAssertEqual(
                PrinterProbePayloads.cutModeLine(cutProtocol: .none, cutModeHonored: honored),
                "Modo do corte: sem guilhotina\n"
            )
        }
    }

    /**
     A linha da família de configuração de rede separa medido de declarado, nas quatro redações.

     `AGENTS.md` obriga a linha: o comprovante final é certidão transcrita para cadastro, e lista
     toda capacidade medida. Ela **continua saindo** quando o valor é ausente — a ausência é a
     informação, e campo que some da folha vira campo esquecido no cadastro.

     Os literais são os mesmos do Android, e a suíte de lá os fixa também.
     */
    func testALinhaDaConfiguracaoDeRedeSeparaMedidoDeDeclarado() {
        XCTAssertEqual(
            PrinterProbePayloads.wifiConfigurationFamilyLine(nil),
            "Config. de rede: não determinada\n"
        )
        XCTAssertEqual(
            PrinterProbePayloads.wifiConfigurationFamilyLine(.measuredUsWHonored),
            "Config. de rede: medida, aceitou\n"
        )
        XCTAssertEqual(
            PrinterProbePayloads.wifiConfigurationFamilyLine(.measuredUsWAbsent),
            "Config. de rede: medida, recusou\n"
        )
        // A única redação que **não** diz "medida", porque ninguém mediu: escrever "medida" aqui
        // poria no papel uma medição que não houve.
        XCTAssertEqual(
            PrinterProbePayloads.wifiConfigurationFamilyLine(.chosenUsEscUs),
            "Config. de rede: escolhida à mão\n"
        )
        // Cabe na 58 mm, nas quatro — e por um caractere. `layout.wrap` parte a linha que estourar,
        // e uma linha partida desloca tudo o que vem depois no papel que serve de transcrição.
        for familia in [nil] + PrinterWifiConfigurationFamily.allCases.map(Optional.some) {
            let linha = PrinterProbePayloads.wifiConfigurationFamilyLine(familia)
                .trimmingCharacters(in: .newlines)
            XCTAssertEqual(linha.count, 32, linha)
        }
    }

    /// A linha sai no comprovante final, inclusive no perfil que nunca respondeu.
    ///
    /// Capacidade medida sem linha no papel é a lacuna que o `AGENTS.md` fecha; e o perfil sem
    /// resposta é justamente o caso em que a linha ausente passaria despercebida.
    func testOComprovanteFinalTrazALinhaDaConfiguracaoDeRede() throws {
        // UTF-8 para o papel voltar legível sem uma tabela DOS no meio do teste — mesma escolha de
        // `testComprovanteFinalListaEmOrdemTudoQueOPerfilMedidoGuarda`.
        let profile = try MeasuredProfile(
            id: UUID(),
            displayName: "Portátil de bancada",
            measuredAt: Date(timeIntervalSince1970: 1),
            transports: [.localWifi],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: nil,
            textEncoding: .utf8,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: 9_100
        )

        XCTAssertTrue(
            try printedLines(of: profile).contains("Config. de rede: não determinada"),
            "o comprovante saiu sem a linha da configuração de rede"
        )
        XCTAssertTrue(
            try printedLines(of: profile.withWifiConfigurationFamily(.chosenUsEscUs))
                .contains("Config. de rede: escolhida à mão")
        )
    }

    /// As linhas de texto do comprovante final, já sem comando ESC/POS e sem o raster do QR.
    ///
    /// Só o texto: comando ESC/POS não ocupa coluna. `ESC @` tem dois bytes e o resto do que este
    /// comprovante emite — `ESC a`, `ESC E`, `ESC t`, `GS !` — tem três. Serve a perfil sem página
    /// medida, cuja saída é UTF-8 ou a dobra ASCII — as duas atravessam UTF-8 sem perda.
    private func printedLines(
        of profile: MeasuredProfile,
        transport: PrinterTransport? = nil
    ) throws -> [String] {
        let receipt = PrinterProbePayloads.finalReceipt(profile: profile, transport: transport)
        let rasterStart = try XCTUnwrap(receipt.range(of: Data([0x1d, 0x76, 0x30])))
        let raw = try XCTUnwrap(
            String(data: receipt[receipt.startIndex..<rasterStart.lowerBound], encoding: .utf8)
        )
        var printed = ""
        var index = raw.startIndex
        while index < raw.endIndex {
            let scalar = raw.unicodeScalars[index]
            if scalar.value == 0x1B, raw.index(after: index) < raw.endIndex,
               raw.unicodeScalars[raw.index(after: index)].value == 0x40 {
                index = raw.index(index, offsetBy: 2)
            } else if scalar.value == 0x1B || scalar.value == 0x1D {
                index = raw.index(index, offsetBy: 3)
            } else {
                printed.append(raw[index])
                index = raw.index(after: index)
            }
        }
        return printed.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    /// Cada acento do português entra na amostra, nas duas caixas. A lista é escrita à mão porque é
    /// vocabulário, não tabela: quem acrescentar um acento precisa acrescentar aqui, e o teste avisa.
    func testSampleCoversThePortugueseAccentInventory() {
        let sample = PrinterProbePayloads.codePageSample

        for accent in "àãáâéêíóôõúÀÃÁÂÉÊÍÓÔÕÚçÇ" {
            XCTAssertTrue(sample.contains(accent), "falta \(accent) na amostra")
        }
        // E nada além disso: `ü Ü` saíram porque o trema caiu do português em 2009, e `ª º` porque
        // nada no kit nem no app imprime ordinal.
        for outside in "üÜªºñÑ" {
            XCTAssertFalse(sample.contains(outside), "\(outside) não pertence à amostra")
        }
        // Incluir `ª º` não pode ter derrubado nenhuma página da lista em silêncio.
        XCTAssertEqual(PrinterProbePayloads.codePageCandidates.count, 26)
    }

    func testStripInstructionsDoNotDependOnThePageBeingMeasured() {
        let receipt = PrinterProbePayloads.codePage()

        // A instrução sai em ASCII e antes de qualquer `ESC t`: ela precisa ser legível mesmo na
        // impressora cuja página é a errada — que é justamente a que vai usar esta tira.
        XCTAssertFalse(PrinterProbePayloads.codePageInstructions.contains { $0.asciiValue == nil })
        XCTAssertTrue(receipt.contains(Data("Escolha a letra da linha em".utf8)))
        XCTAssertTrue(receipt.contains(Data("maiusculas tambem.".utf8)))
    }

    func testSevenCutCandidatesMatchTheMeasuredCommandsByteForByte() {
        let candidates = PrinterProbePayloads.cutProtocolCandidates

        XCTAssertEqual(candidates.map(\.cutProtocol), [
            .gsV0, .gsV1, .gsV65, .gsV66, .escI, .escM, .none,
        ])
        XCTAssertEqual(candidates.map { [UInt8]($0.commandBytes) }, [
            [0x1d, 0x56, 0x00],
            [0x1d, 0x56, 0x01],
            [0x1d, 0x56, 0x41, 0x50],
            [0x1d, 0x56, 0x42, 0x50],
            [0x1b, 0x69],
            [0x1b, 0x6d],
            [],
        ])
    }

    func testGeometryPrintsTextRulerAndEveryRasterWidthFor58And80mm() {
        XCTAssertEqual(
            rasterWidths(in: PrinterProbePayloads.geometry(paperWidth: .mm58)),
            [256, 288, 320, 384]
        )
        XCTAssertEqual(
            rasterWidths(in: PrinterProbePayloads.geometry(paperWidth: .mm80)),
            [384, 512, 576, 640]
        )
        // Uma barra por largura, e cada uma com o comprimento exato que anuncia. Régua única na
        // largura máxima quebrava de linha em impressora mais estreita — visto na GoldenSky 80 mm,
        // de 48 colunas contra 64 do candidato — e deixava a pergunta sem resposta possível.
        for (width, columns) in [(PrinterPaperWidth.mm58, 48), (.mm80, 64)] {
            XCTAssertEqual(width.geometryProbeColumns, columns)
            let probe = PrinterProbePayloads.geometry(paperWidth: width)
            for candidate in 24...columns {
                let ruler = PrinterProbePayloads.textRuler(columns: candidate)
                XCTAssertEqual(ruler.count, candidate)
                XCTAssertTrue(ruler.hasSuffix(String(candidate)))
                XCTAssertTrue(probe.contains(Data((ruler + "\n").utf8)))
            }
        }
    }

    func testPaperComparisonUsesTheSameExactRulersAsGeometry() {
        let probe = PrinterProbePayloads.paperWidthRulers()

        for width in [PrinterPaperWidth.mm58, .mm80] {
            let ruler = PrinterProbePayloads.textRuler(columns: width.defaultPrintableColumns)
            XCTAssertEqual(ruler.count, width.defaultPrintableColumns)
            XCTAssertTrue(
                probe.contains(
                    Data(
                        "\(width.rawValue)mm\n\(ruler)\n\(width.defaultPrintableDots) Dots\n".utf8
                    )
                )
            )
        }
        XCTAssertEqual(rasterWidths(in: probe), [384, 576])
        XCTAssertFalse(probe.contains(Data("==================".utf8)))
    }

    func testComprovanteFinalUsaAPaginaMedidaNosRotulos() throws {
        // As sondas são ASCII para não depender do que ainda estão medindo. O comprovante é o
        // oposto: ele relata a medição, e sair "HOMOLOGACAO" sem acento numa impressora cuja
        // CP860 acabou de ser provada desmente o próprio papel. Visto na T210.
        let profile = try MeasuredProfile(
            id: UUID(),
            displayName: "T210 de bancada",
            measuredAt: Date(timeIntervalSince1970: 1),
            transports: [.bluetooth],
            paperWidth: .mm58,
            printableColumns: 32,
            printableDots: 384,
            codePage: .cp860,
            codePageSelector: 8,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )

        let receipt = PrinterProbePayloads.finalReceipt(profile: profile)

        // `Ç` da palavra HOMOLOGAÇÃO é 0x80 na CP860, e o endereço medido é o 8, não o canônico.
        XCTAssertTrue(receipt.contains(0x80), "O cabeçalho saiu sem acento.")
        XCTAssertTrue(
            receipt.range(of: Data([0x1b, 0x74, 0x08])) != nil,
            "O comprovante não usou o endereço de página medido."
        )
    }

    func testComprovanteFinalTerminaComQRRaster() throws {
        // O QR é a única peça do comprovante que prova o caminho raster na largura medida: texto
        // sai em qualquer firmware, faixa `GS v 0` não. O iOS não o imprimia, e isso só apareceu
        // na bancada — com a GoldenSky terminando a homologação sem QR nenhum, enquanto o Android
        // já o imprimia desde sempre.
        let profile = try MeasuredProfile(
            id: UUID(),
            displayName: "GoldenSky de bancada",
            measuredAt: Date(timeIntervalSince1970: 1),
            transports: [.localWifi],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: .cp860,
            cutProtocol: .gsV1,
            cutFeedLines: 4,
            tcpPort: 9100
        )

        let receipt = PrinterProbePayloads.finalReceipt(profile: profile)

        XCTAssertTrue(
            receipt.range(of: Data([0x1d, 0x76, 0x30, 0x00])) != nil,
            "O comprovante final saiu sem faixa GS v 0: o QR não foi impresso."
        )
    }

    /// O QR do comprovante final sai compensado, e é a linha nova que cobra isso.
    ///
    /// O comprovante final é o primeiro papel que sai já compensado. O Android sempre passou o
    /// fator ao emissor; o iOS chamava `EscPos.qrRaster` sem ele, e o QR saía oval na firmware que
    /// encolhe. Com o papel agora **declarando** `fator 0,79`, um QR não compensado desmentiria a
    /// própria linha impressa dois centímetros acima.
    func testOQRDoComprovanteFinalSaiCompensadoPeloFatorMedido() throws {
        func receipt(verticalRasterScale: Double?) throws -> Data {
            PrinterProbePayloads.finalReceipt(
                profile: try MeasuredProfile(
                    id: UUID(),
                    displayName: "Inico T210",
                    measuredAt: Date(timeIntervalSince1970: 1),
                    transports: [.bluetoothLE],
                    paperWidth: .mm58,
                    printableColumns: 32,
                    printableDots: 384,
                    codePage: nil,
                    textEncoding: .utf8,
                    cutProtocol: .none,
                    cutFeedLines: 0,
                    tcpPort: nil,
                    verticalRasterScale: verticalRasterScale
                )
            )
        }
        let fator = 38.0 / Double(PrinterProbePayloads.rasterThroughputStripMillimetres)
        let compensado = try receipt(verticalRasterScale: fator)
        let semFator = try receipt(verticalRasterScale: nil)

        // O QR compensado leva mais linhas de raster: o emissor manda `1/fator` delas.
        XCTAssertGreaterThan(compensado.count, semFator.count)
        let esperado = try XCTUnwrap(
            EscPos.qrRaster(
                payload: PrinterProbePayloads.finalReceiptQR,
                widthDots: 320,
                verticalRasterScale: fator
            )
        )
        XCTAssertNotNil(compensado.range(of: esperado))
        // **Neutralidade**: sem fator, o QR continua exatamente o de sempre.
        let semCompensacao = try XCTUnwrap(
            EscPos.qrRaster(payload: PrinterProbePayloads.finalReceiptQR, widthDots: 320)
        )
        XCTAssertNotNil(semFator.range(of: semCompensacao))
    }

    func testComprovanteFinalMostraIdentidadeDeclaradaSemSerial() throws {
        let profile = try MeasuredProfile(
            displayName: "GoldenSky 58E_BT",
            measuredAt: Date(timeIntervalSince1970: 1),
            transports: [.localWifi],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: nil,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: 9_100,
            firmwareVersion: "SV3.2.2"
        )
        let identity = PrinterDeclaredIdentity(
            firmwareVersion: "SV3.2.2",
            manufacturer: "GoldenSky",
            model: "58E_BT"
        )!

        let text = String(decoding: PrinterProbePayloads.finalReceipt(
            profile: profile,
            identity: identity,
            transport: .localWifi
        ), as: UTF8.self)

        XCTAssertTrue(text.contains("Fabricante: GoldenSky"))
        XCTAssertTrue(text.contains("Modelo: 58E_BT"))
        XCTAssertTrue(text.contains("Firmware: SV3.2.2"))
        XCTAssertTrue(text.contains("Conexao: Wi-Fi"))
        XCTAssertFalse(text.localizedCaseInsensitiveContains("serial"))
    }

    func testRasterRulerMarksAllFourBorders() throws {
        let command = PrinterProbePayloads.rasterRuler(widthDots: 256)
        XCTAssertEqual([UInt8](command.prefix(8)), [0x1d, 0x76, 0x30, 0x00, 32, 0, 24, 0])
        let pixels = [UInt8](command.dropFirst(8))

        XCTAssertEqual(Array(pixels.prefix(32)), Array(repeating: 0xff, count: 32))
        XCTAssertEqual(Array(pixels.suffix(32)), Array(repeating: 0xff, count: 32))
        XCTAssertEqual(pixels[32] & 0x80, 0x80)
        XCTAssertEqual(pixels[63] & 0x01, 0x01)
    }

    func testCutFeedWarnsAboutEightStripsAndNeverDuplicatesAdvance() throws {
        XCTAssertTrue(PrinterProbePayloads.cutFeedBenchWarning.contains("8 tiras"))
        let receipt = try XCTUnwrap(PrinterProbePayloads.cutFeed(cutProtocol: .gsV1))
        XCTAssertEqual(PrinterProbePayloads.cutFeedCandidates, [0, 2, 4, 5, 6, 8, 10, 12])
        // A invariante continua sendo "uma fonte de avanço só", agora em quebras de linha porque a
        // MP-4200 ignora `ESC d`: cada tira fecha com exatamente `lines` quebras de avanço coladas
        // no comando de corte — o bloco de texto termina em `ESC E 0`. Duas fontes de avanço
        // deixaram dez linhas em branco antes da serrilha na primeira impressão real.
        XCTAssertEqual(
            feedLinesBeforeEachCut(in: receipt, cut: CutProtocol.gsV1.command),
            PrinterProbePayloads.cutFeedCandidates
        )
        // O avanço vai impresso e numerado: o desperdício depois da linha de referência deixa de
        // ser papel em branco e vira contagem.
        for lines in PrinterProbePayloads.cutFeedCandidates where lines > 0 {
            XCTAssertTrue(receipt.contains(Data("\(lines) ---- DESPERDICIO".utf8)))
        }
        for lines in PrinterProbePayloads.cutFeedCandidates {
            // O número saía em corpo dobrado por `GS !`, comando que a MP-4200 imprime como `!`.
            // A moldura ASCII mantém as duas ocorrências que a tira precisa ter.
            let framedNumber = EscPos.text(
                ">>> \(lines) <<<\n",
                alignment: 0,
                bold: true,
                size: 0,
                codePage: nil
            )
            XCTAssertEqual(receipt.occurrences(of: framedNumber), 2)
        }
        XCTAssertNil(PrinterProbePayloads.cutFeed(cutProtocol: .none))
        XCTAssertNil(PrinterProbePayloads.cutFeed(cutProtocol: .gsV65))
        XCTAssertNil(PrinterProbePayloads.cutFeed(cutProtocol: .gsV66))
    }

    func testAvancoCurtoDeCincoTemUmaUnicaTiraEOMesmoVetorDoAvancado() throws {
        let curto = try XCTUnwrap(PrinterProbePayloads.cutFeed(cutProtocol: .gsV1, lines: 5))
        XCTAssertEqual(feedLinesBeforeEachCut(in: curto, cut: CutProtocol.gsV1.command), [5])
        XCTAssertEqual(curto.occurrences(of: Data(">>> 5 <<<".utf8)), 2)
        XCTAssertNil(PrinterProbePayloads.cutFeed(cutProtocol: .none, lines: 5))
        XCTAssertNil(PrinterProbePayloads.cutFeed(cutProtocol: .gsV65, lines: 5))
        XCTAssertNil(PrinterProbePayloads.cutFeed(cutProtocol: .gsV1, lines: 3))
    }

    /// Quantas linhas o papel anda entre a linha de referência e cada corte, na ordem do papel.
    /// Conta quebras porque o avanço agora vai impresso: a régua numerada anda o mesmo que o
    /// mesmo número de quebras em branco.
    private func feedLinesBeforeEachCut(in payload: Data, cut: Data) -> [Int] {
        let bytes = [UInt8](payload)
        let needle = [UInt8](cut)
        let marker = [UInt8]("REFERENCIA".utf8)
        var counts: [Int] = []
        var lineFeeds = 0
        var index = 0
        var counting = false
        while index < bytes.count {
            if index + needle.count <= bytes.count, Array(bytes[index..<(index + needle.count)]) == needle {
                counts.append(max(lineFeeds - 1, 0))
                lineFeeds = 0
                counting = false
                index += needle.count
                continue
            }
            if index + marker.count <= bytes.count, Array(bytes[index..<(index + marker.count)]) == marker {
                counting = true
                lineFeeds = 0
                index += marker.count
                continue
            }
            if counting, bytes[index] == 0x0a { lineFeeds += 1 }
            index += 1
        }
        return counts
    }

    private func rasterWidths(in data: Data) -> [Int] {
        let bytes = [UInt8](data)
        var widths: [Int] = []
        var index = 0
        while index + 8 <= bytes.count {
            if Array(bytes[index..<(index + 4)]) == [0x1d, 0x76, 0x30, 0x00] {
                let widthBytes = Int(bytes[index + 4]) | Int(bytes[index + 5]) << 8
                let height = Int(bytes[index + 6]) | Int(bytes[index + 7]) << 8
                widths.append(widthBytes * 8)
                index += 8 + widthBytes * height
            } else {
                index += 1
            }
        }
        return widths
    }

    /// A frase de confirmação saía sem passar pelo `wrap`, e quem quebrava era a firmware: o papel
    /// da P80 de 48 colunas saiu com "este comprovan / te saiu correto". Palavra partida no meio
    /// num comprovante que pede conferência é exatamente onde não se pode duvidar do texto.
    func testFraseDeConfirmacaoQuebraNaPalavra() throws {
        let profile = try MeasuredProfile(
            id: UUID(),
            displayName: "J-SPEED P80-Serials",
            measuredAt: Date(timeIntervalSince1970: 1),
            transports: [.localWifi],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: nil,
            cutProtocol: .gsV1,
            cutFeedLines: 5,
            tcpPort: 9_100
        )
        let bytes = PrinterProbePayloads.finalReceipt(profile: profile)
        let texto = String(decoding: bytes, as: UTF8.self)

        XCTAssertFalse(texto.contains("comprovan\nte"))
        XCTAssertTrue(texto.contains("comprovante"))
        for linha in texto.split(separator: "\n") where linha.first != "\u{1b}" {
            XCTAssertLessThanOrEqual(linha.count, profile.printableColumns + 8, String(linha))
        }
    }
}

private extension Data {
    func occurrences(of needle: Data) -> Int {
        guard !needle.isEmpty else { return 0 }
        var count = 0
        var start = startIndex
        while start < endIndex, let range = self[start...].range(of: needle) {
            count += 1
            start = range.upperBound
        }
        return count
    }

}
