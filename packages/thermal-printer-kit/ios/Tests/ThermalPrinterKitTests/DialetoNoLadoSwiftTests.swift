import CoreGraphics
import Foundation
import XCTest
@testable import ThermalPrinterKit

/**
 O dialeto no lado Swift — **os dois que existem, e o que ainda não existe.**

 Este arquivo nasceu em 27/08/2026 como estopim. Naquele dia o kit Swift tinha **um** dialeto: não
 havia `PROCOMP_ESC_P` no enum, não havia emissor Procomp na árvore, e um perfil de Diebold IM453H
 contribuído pelo Android chegava ao Mac sem ninguém que soubesse falar com ela. O teste de cima
 afirmava essa ausência e trazia escrita a lista do que quebraria no dia em que ela deixasse de
 valer.

 **Esse dia foi 30/08/2026, e este arquivo passou a afirmar o mundo novo.** O que a lista mandava
 fazer está feito, e cada item virou prova aqui ou em `ThermalMonochromeRasterTests`:

 1. `ReceiptLayout.monochromeRaster` chamava `EscPosRasterEmitter.emit` **direto**; agora pergunta a
    ``ReceiptLayout/rasterEmission``, como `imageRaster` e `qrRaster`. O teto de largura foi junto:
    ele era o do `GS v 0` (65535 bytes) e agora é o do envelope de cada dialeto — o `ESC n` endereça
    255. Ver `testALarguraRecusadaEADoDialetoENaoADoEscPos`.
 2. `ReceiptLayout` não carregava dialeto nenhum; agora carrega, e ele vem do perfil.
 3. `PrinterProfileStore.profiles()` **não** apaga mais o arquivo inteiro quando a decodificação
    falha — isso foi consertado em 27/08/2026, antes deste lote, e os testes abaixo continuam
    guardando o conserto. O que mudou hoje é que `PROCOMP_ESC_P` **deixou de ser** um valor
    desconhecido: ele decodifica.

 **Nada aqui saiu em papel**, e nada aqui abre socket ou toca impressora.
 */
final class DialetoNoLadoSwiftTests: XCTestCase {

    /**
     Os dois dialetos do kit — **e o que fazer quando entrar um terceiro.**

     Não é um teste sobre um número. É o único ponto da árvore Swift onde a lista de dialetos está
     escrita como afirmação, e é ela que sustenta cada `switch` que decide bytes.

     **O que quebra sozinho no dia de um terceiro caso**, e é de propósito: os `switch` de
     ``ReceiptLayout/rasterEmission``, de `ReceiptLayout.text`, de `ReceiptLayout.finish` e de
     `nativeCodeAllowed` são exaustivos e **não compilam**. Compilador é melhor guarda que teste.

     **O que NÃO quebra sozinho, e por isso está escrito aqui:**

     1. o **leitor de contribuição** (`PrinterContribution.swift`) exporta `dialect` como string e não
        tem contraparte de leitura neste kit — um perfil contribuído por outra plataforma ainda não
        entra por ele. Ver o relatório do lote C41;
     2. **não há como escolher o dialeto pelo iPhone.** O Kotlin tem
        `prepareTemporaryDiscoveryProfile(dialect:)`; aqui `BundledPrinterProfiles` não tem card
        Procomp e `PrinterProfileResolver.temporaryProfile` monta sempre `.epsonCompatible`. O único
        jeito de um alvo Procomp alcançar a homologação deste kit continua sendo um perfil medido
        relido do disco — o contribuído pelo Android. A descoberta fica fora do kit e não foi tocada.

     **Dois itens saíram desta lista em 04/09/2026, e cada um virou prova:**

     * `MeasuredProfile.init(id:displayName:...)` **recebe dialeto** e o repassa às capacidades — ver
       `HomologacaoProcompTests.testHomologarADieboldAdotaUmPerfilProcompENaoUmEscPos`;
     * a série de sondas deixou de ser ESC/POS de ponta a ponta: existe `ProcompHomologationProbes`,
       existe o portão de ``EscPosDialectGate`` antes do envio, e nenhum byte `GS` alcança um alvo
       Procomp — ver `HomologacaoProcompTests` e `RecusaDeDialetoTests`.
     */
    func testOsDoisDialetos_eOQueFazerQuandoEntrarUmTerceiro() {
        XCTAssertEqual(
            EscPosDialect.allCases,
            [.epsonCompatible, .procompEscP],
            """
            Mudou a lista de dialetos do kit Swift. O compilador cobra os `switch`; o que ele não
            cobra está no comentário deste teste — leitor de contribuição, `MeasuredProfile.init`
            sem dialeto, e a série de sondas de homologação.
            """
        )
        // O `rawValue` é contrato de disco e entra na `capabilityKey`. Ele não pode ser reescrito
        // por conveniência: perfil medido no disco de alguém decodifica por esta string.
        XCTAssertEqual(EscPosDialect.epsonCompatible.rawValue, "EPSON_COMPATIBLE")
        XCTAssertEqual(EscPosDialect.procompEscP.rawValue, "PROCOMP_ESC_P")
    }

    /**
     **A chave de capacidade de um perfil que já existe não se moveu**, e isso é compatibilidade.

     `dialect.rawValue` entra na string canônica da `capabilityKey`, então um caso novo no enum
     mudaria a chave de **todo** perfil já medido e já contribuído se ele tocasse o valor do caso
     antigo. Perfil no disco de alguém custou papel; chave que anda sozinha os desemparelha do
     catálogo sem que ninguém veja.

     O pino de ponta a ponta é `PrinterProfileTests.testCapabilityKeyMatchesTheCrossPlatformVector`,
     que fixa dois SHA-256 por literal e **passou sem ser tocado** por este lote. Aqui fica a metade
     que explica por quê: o dialeto novo muda a chave, o antigo não.
     */
    func testAChaveDeCapacidadeSeMovePeloDialetoENaoPeloCasoNovoExistir() throws {
        let epson = try capacidades(dialect: .epsonCompatible)
        let procomp = try capacidades(dialect: .procompEscP)

        XCTAssertEqual(
            epson.capabilityKey.rawValue,
            "319ba05df84d232aefcfae218714e1b49ebe59ebccfb2dd8fcbe6831dc6c920a",
            "a chave do perfil ESC/POS de sempre não pode andar por causa de um caso novo no enum"
        )
        XCTAssertNotEqual(
            epson.capabilityKey,
            procomp.capabilityKey,
            "dois dialetos emitem bytes diferentes: não são a mesma medição e não compartilham chave"
        )
    }

    /**
     **Um perfil Procomp contribuído pelo Android agora é lido, em vez de descartado.**

     Este é o buraco que o lote fecha, medido do lado de fora: o mesmo arquivo que em 27/08/2026
     custava um perfil descartado hoje entrega uma impressora utilizável, com o dialeto intacto.
     */
    func testUmPerfilProcompContribuidoPeloAndroidAgoraELido() throws {
        let backend = DialetoMemoryProfileDataStore()
        let store = PrinterProfileStore(dataStore: backend)
        try store.save(try medido(id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!, nome: "Balcao 80mm"))
        try store.save(try medido(id: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!, nome: "Cozinha 58mm"))

        try backend.writeProfileData(try trocandoODialetoDoPrimeiro(backend, por: "PROCOMP_ESC_P"))

        let lido = PrinterProfileStore(dataStore: backend).profilesRead()

        XCTAssertEqual(lido.profiles.count, 2, "os dois perfis são legíveis agora")
        XCTAssertEqual(lido.unreadable, 0, "e nenhum é descartado")
        XCTAssertEqual(
            lido.profiles.first { $0.displayName == "Balcao 80mm" }?.dialect,
            .procompEscP,
            "o dialeto que veio do Android é o que o layout vai usar"
        )
    }

    /**
     **O dialeto atravessa o perfil até o papel**, e não só até o disco.

     Sem esta prova, um perfil Procomp lido do disco montaria um layout ESC/POS e a impressora
     homologada voltaria a falar `GS v 0` no primeiro cupom — e só o papel mostraria, longe da causa.
     É o mesmo teste que o lado Kotlin escreveu em 26/08/2026 depois de a adoção perder o campo.
     */
    func testODialetoDoPerfilAtravessaOLayout() throws {
        let layout = ReceiptLayout(profile: try perfil(dialect: .procompEscP))

        XCTAssertEqual(layout.dialect, .procompEscP)
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 576,
                heightDots: 8,
                blackPixels: Array(repeating: true, count: 576 * 8)
            )
        )
        let bytes = try XCTUnwrap(layout.monochromeRaster(bitmap))
        XCTAssertFalse(bytes.contains(Self.gs))
        XCTAssertTrue(contem([0x1B, 0x6E], em: bytes))
        // E o layout com o mesmo perfil em ESC/POS continua sendo o de sempre.
        let epson = ReceiptLayout(profile: try perfil(dialect: .epsonCompatible))
        XCTAssertTrue(contem([0x1D, 0x76, 0x30], em: try XCTUnwrap(epson.monochromeRaster(bitmap))))
    }

    /**
     **O perigo que a medicao achou, e o conserto: um perfil ilegivel nao leva os vizinhos.**

     Ate 27/08/2026, `PrinterProfileStore.profiles()` tratava qualquer erro de decodificacao como
     corrupcao e chamava `writeProfileData(nil)`. Um perfil de IM453H contribuido pelo Android nao
     derrubava so a si mesmo: levava junto TODOS os perfis medidos daquele Mac, e cada um custou
     papel. Para corrupcao de verdade apagar e decisao escrita e defensavel; um perfil vindo de um
     kit mais novo nao e corrupcao, e o formato andando para frente.

     Decisao do Bruno em 27/08/2026: **descartar so o ilegivel, e avisar.** Descarte silencioso
     trocaria um sumico visivel por um invisivel — a pessoa perderia uma impressora da lista sem
     nunca descobrir por que.

     **O valor usado aqui deixou de ser `PROCOMP_ESC_P` em 30/08/2026**, e a troca é a medição: o
     caso passou a existir, então ele decodifica e não serve mais para provar a tolerância. O teste
     confere que o valor escolhido continua fora do enum — senão a prova envelheceria calada no dia
     do terceiro dialeto.

     Este teste cobre o caso do VALOR novo num campo que ja existe. O do campo novo esta abaixo, e
     sao caminhos diferentes no codigo: um morre no decodificador, o outro na allowlist.
     */
    func testUmDialetoDesconhecidoDerrubaSoOProprioPerfil() throws {
        let backend = DialetoMemoryProfileDataStore()
        let store = PrinterProfileStore(dataStore: backend)
        try store.save(try medido(id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!, nome: "Balcao 80mm"))
        try store.save(try medido(id: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!, nome: "Cozinha 58mm"))
        XCTAssertEqual(store.profiles().count, 2, "os dois precisam estar la antes")

        try backend.writeProfileData(try trocandoODialetoDoPrimeiro(backend, por: Self.dialetoDeUmKitMaisNovo))

        let lido = PrinterProfileStore(dataStore: backend).profilesRead()

        XCTAssertEqual(lido.profiles.count, 1, "o perfil bom sobrevive")
        XCTAssertEqual(lido.unreadable, 1, "e o descarte e contado, para a interface poder avisar")
        XCTAssertNotNil(try backend.readProfileData(), "o arquivo NAO pode ser apagado")
    }

    /**
     O outro caminho: **campo novo derruba so o proprio perfil, e nao a allowlist inteira.**

     `partitionAllowlist` recusava o arquivo INTEIRO ao ver uma chave que nao conhece, e isso e
     anterior ao decodificador — entao a isolacao por perfil sozinha nao cobriria este caso. Um kit
     mais novo que acrescente um campo medido novo cai exatamente aqui, e e o caso mais provavel dos
     dois: campo novo e como este formato cresceu ate hoje.
     */
    func testUmCampoDesconhecidoDerrubaSoOProprioPerfil() throws {
        let backend = DialetoMemoryProfileDataStore()
        let store = PrinterProfileStore(dataStore: backend)
        try store.save(try medido(id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!, nome: "Balcao 80mm"))
        try store.save(try medido(id: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!, nome: "Cozinha 58mm"))

        let raiz = try raizDoDisco(backend)
        var perfis = try XCTUnwrap(raiz["profiles"] as? [[String: Any]])
        perfis[0]["medicaoQueEsteKitNaoTem"] = 42
        try backend.writeProfileData(
            try JSONSerialization.data(withJSONObject: ["version": raiz["version"]!, "profiles": perfis])
        )

        let lido = PrinterProfileStore(dataStore: backend).profilesRead()

        XCTAssertEqual(lido.profiles.count, 1, "o perfil sem o campo novo sobrevive")
        XCTAssertEqual(lido.unreadable, 1)
        XCTAssertNotNil(try backend.readProfileData(), "o arquivo NAO pode ser apagado")
    }

    /**
     **A escrita nao termina o servico que a leitura se recusou a fazer.**

     Sem esta prova, o conserto seria meio conserto: `save` faz read-modify-write com a lista ja
     filtrada, entao o primeiro `save` depois de uma leitura tolerante apagaria de vez o perfil
     ilegivel. Trocar perda total imediata por perda parcial no proximo `save` nao e conserto — e
     adiamento, e pior, porque ninguem estaria olhando.

     Guardado intacto, a impressora volta sozinha no dia em que este app entender o campo — e o
     `PROCOMP_ESC_P` deste arquivo é o exemplo de que isso acontece de verdade: em 27/08 ele era
     ilegível aqui, e hoje é uma impressora na lista.
     */
    func testSalvarNaoApagaOPerfilQueEsteKitNaoSabeLer() throws {
        let backend = DialetoMemoryProfileDataStore()
        let store = PrinterProfileStore(dataStore: backend)
        try store.save(try medido(id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!, nome: "Balcao 80mm"))
        try backend.writeProfileData(try trocandoODialetoDoPrimeiro(backend, por: Self.dialetoDeUmKitMaisNovo))
        XCTAssertEqual(PrinterProfileStore(dataStore: backend).profilesRead().unreadable, 1)

        // Uma impressora nova é adotada DEPOIS, que é o gesto comum de quem não sabe que há um
        // perfil ilegível no arquivo.
        let depois = PrinterProfileStore(dataStore: backend)
        try depois.save(try medido(id: UUID(uuidString: "33333333-3333-4333-8333-333333333333")!, nome: "Balcao novo"))

        let raiz = try raizDoDisco(backend)
        let perfis = try XCTUnwrap(raiz["profiles"] as? [[String: Any]])
        XCTAssertEqual(perfis.count, 2, "o ilegível continua no disco, ao lado do novo")
        XCTAssertTrue(
            perfis.contains {
                ($0["capabilities"] as? [String: Any])?["dialect"] as? String
                    == Self.dialetoDeUmKitMaisNovo
            },
            "e continua com o dialeto que este kit não entende, intacto"
        )
        XCTAssertEqual(depois.profilesRead().unreadable, 1, "e continua contado como ilegível")
    }

    /**
     O bitmap composto sai em `GS v 0` no dialeto que tem `GS` — **o guarda de regressão do conserto.**

     O contra-exemplo do arquivo: sem ele, um roteamento que devolvesse `nil` ou vazio no caminho
     ESC/POS passaria em todas as provas de ausência de `GS`. O cupom de sempre tem de continuar
     saindo pelo emissor de sempre, byte a byte.
     */
    func testOBitmapCompostoDoDialetoEpsonContinuaSaindoEmGsV0() throws {
        let layout = ReceiptLayout(profile: BundledPrinterProfiles.epsonTmT20xII)
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 576,
                heightDots: 8,
                blackPixels: Array(repeating: true, count: 576 * 8)
            )
        )

        let bytes = try XCTUnwrap(layout.monochromeRaster(bitmap))

        // `GS v 0` = 1D 76 30. A busca é por subsequência para não depender de o emissor pôr ou não
        // o alinhamento na frente — divergência conhecida e já fixada entre Kotlin e Swift.
        XCTAssertTrue(
            contem([0x1D, 0x76, 0x30], em: bytes),
            "o corpo do cupom ESC/POS continua sendo `GS v 0`"
        )
    }

    /**
     **O cupom Procomp inteiro — texto, raster e fecho — sai sem um byte `GS`.**

     A IM453H não tem **nenhum** comando `GS`. Mandar-lhe `GS v 0`, em 23/08/2026, fez sair dois
     metros de código e o aparelho parar de responder, com a tecla de avanço morta e recuperação só
     no desligar e ligar.

     A prova é do **cupom**, e não de uma função: as quatro coisas que o layout emite atravessam o
     dialeto por caminhos diferentes — texto por `procompText`, raster por ``RasterEmission``, corte
     por `procompFinish` —, e foi exatamente uma dessas costuras que faltou no lado Kotlin até
     27/08/2026, deixando o corpo em `GS v 0` e o fecho em avanço Procomp **no mesmo cupom**.

     **Não medido:** nada disto saiu em papel numa IM453H por este lote. O que se mede aqui são os
     bytes.
     */
    func testOCupomProcompInteiroSaiSemUmByteGs() throws {
        let layout = layoutProcomp(hasCutter: true, cutFeedLines: 4)
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 576,
                heightDots: 30,
                blackPixels: (0..<(576 * 30)).map { $0 % 3 == 0 }
            )
        )

        var cupom = Data()
        cupom.append(layout.text("Café São João\n", alignment: 1, bold: true, size: dobrado))
        cupom.append(try XCTUnwrap(layout.qrRaster(payload: "PRINTHER-C41")))
        cupom.append(try XCTUnwrap(layout.monochromeRaster(bitmap)))
        cupom.append(try XCTUnwrap(layout.imageRasterDeTeste()))
        cupom.append(try XCTUnwrap(layout.barcode("7891234567895", symbology: .ean13)))
        cupom.append(layout.finish())

        XCTAssertFalse(
            cupom.contains(Self.gs),
            "nenhum 0x1D pode alcançar uma firmware sem GS, e `GS v 0` começa com ele"
        )
        // A forma exata, e não só a ausência: o `ESC n` do dialeto e o `ESC w` medido do fecho. Sem
        // esta metade, um cupom vazio passaria na asserção de cima — que é o formato de mentira que
        // este repositório persegue.
        XCTAssertTrue(contem([0x1B, 0x6E], em: cupom), "o envelope de raster tem de ser `ESC n`")
        XCTAssertEqual(Array([UInt8](layout.finish()).suffix(2)), [0x1B, 0x77], "o fecho é `ESC w`")
    }

    /**
     O mesmo layout, as **quatro** funções que emitem raster, e um dialeto só entre elas.

     É esta prova que localiza a assimetria sem depender de literal de byte nenhum: enquanto três
     funções consultavam o dialeto e uma não, o descuido parecia decisão. Aqui elas respondem juntas.
     */
    func testAsQuatroFuncoesDoMesmoLayoutConcordamSobreODialeto() throws {
        let layout = layoutProcomp()
        let bitmap = try XCTUnwrap(
            ThermalMonochromeBitmap(
                widthDots: 576,
                heightDots: 8,
                blackPixels: Array(repeating: true, count: 576 * 8)
            )
        )

        for (nome, bytes) in [
            ("qrRaster", try XCTUnwrap(layout.qrRaster(payload: "C41"))),
            ("monochromeRaster", try XCTUnwrap(layout.monochromeRaster(bitmap))),
            ("imageRaster", try XCTUnwrap(layout.imageRasterDeTeste())),
            ("barcode", try XCTUnwrap(layout.barcode("7891234567895", symbology: .ean13))),
        ] {
            XCTAssertFalse(bytes.contains(Self.gs), "\(nome) deixou escapar um byte GS")
            XCTAssertTrue(contem([0x1B, 0x6E], em: bytes), "\(nome) não emitiu o `ESC n` do dialeto")
        }
    }

    /**
     **O comando nativo não sai neste dialeto, nem quando alguém pede.**

     A IM453H tem QR nativo (`ESC ( k`) e código de barras nativo (`ESC | 0`) no manual, e **nenhum
     dos dois saiu em papel**. Aqui o pedido nativo chega pela preferência do hospedeiro, e o que
     sai é o raster medido: comando não medido nesta impressora custa o aparelho travado, não uma
     tira torta.
     */
    func testOModoNativoNaoAlcancaODialetoSemMedicao() throws {
        let layout = layoutProcomp().emitting(qr: .native, barcode: .native)

        let qr = try XCTUnwrap(layout.qr(payload: "C41"))
        let barras = try XCTUnwrap(layout.barcode("7891234567895", symbology: .ean13))

        XCTAssertFalse(qr.contains(Self.gs))
        XCTAssertFalse(barras.contains(Self.gs))
        XCTAssertTrue(contem([0x1B, 0x6E], em: qr), "o QR pedido nativo saiu rasterizado em `ESC n`")
        XCTAssertTrue(contem([0x1B, 0x6E], em: barras))
        // E a preferência continua sendo honrada onde a medição existe: o mutante do teste.
        let epson = ReceiptLayout(profile: BundledPrinterProfiles.epsonTmT20xII)
            .emitting(qr: .native, barcode: .native)
        XCTAssertTrue(
            contem([0x1D, 0x28, 0x6B], em: try XCTUnwrap(epson.qr(payload: "C41"))),
            "no dialeto que mediu o nativo, `GS ( k` continua saindo"
        )
    }

    // MARK: - Apoio

    /// O layout da IM453H: 80 mm, 48 colunas, sem página de código — a tabela é a de fábrica.
    private func layoutProcomp(hasCutter: Bool = false, cutFeedLines: Int = 0) -> ReceiptLayout {
        ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: hasCutter,
            codePage: nil,
            cutProtocol: hasCutter ? .gsV1 : CutProtocol.none,
            cutFeedLines: cutFeedLines,
            printableDots: 576,
            dialect: .procompEscP
        )
    }

    private var dobrado: ThermalTextSize {
        ThermalTextSize(widthMultiplier: 2, heightMultiplier: 2) ?? .normal
    }

    /// O perfil como ele chega do disco: capacidades medidas, com o dialeto que veio junto.
    private func perfil(dialect: EscPosDialect) throws -> PrinterProfile {
        PrinterProfile(
            id: "teste.dialeto.c41",
            displayName: "Impressora de teste",
            source: .measured,
            measuredAt: Date(timeIntervalSince1970: 1),
            capabilities: try capacidades(dialect: dialect)
        )
    }

    private func capacidades(dialect: EscPosDialect) throws -> PrinterCapabilities {
        try PrinterCapabilities(
            transports: [.usb],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .gsV1,
            cutFeedLines: 4,
            dialect: dialect,
            statusProtocol: .none,
            tcpPort: nil
        )
    }

    private func raizDoDisco(_ backend: DialetoMemoryProfileDataStore) throws -> [String: Any] {
        let data = try XCTUnwrap(try backend.readProfileData())
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// O arquivo que o store escreveu, com o dialeto do primeiro perfil trocado — é assim que um
    /// perfil vindo de outra plataforma chegaria a este disco.
    private func trocandoODialetoDoPrimeiro(
        _ backend: DialetoMemoryProfileDataStore,
        por dialeto: String
    ) throws -> Data {
        let raiz = try raizDoDisco(backend)
        var perfis = try XCTUnwrap(raiz["profiles"] as? [[String: Any]])
        var caps = try XCTUnwrap(perfis[0]["capabilities"] as? [String: Any])
        XCTAssertEqual(caps["dialect"] as? String, "EPSON_COMPATIBLE", "senão a prova é vazia")
        caps["dialect"] = dialeto
        perfis[0]["capabilities"] = caps
        return try JSONSerialization.data(withJSONObject: ["version": raiz["version"]!, "profiles": perfis])
    }

    private func medido(id: UUID, nome: String) throws -> MeasuredProfile {
        try MeasuredProfile(
            id: id,
            displayName: nome,
            measuredAt: Date(timeIntervalSince1970: 1_000),
            transports: [.bluetoothLE],
            paperWidth: .mm80,
            printableColumns: 48,
            printableDots: 576,
            codePage: nil,
            textEncoding: .utf8,
            cutProtocol: .none,
            cutFeedLines: 0,
            tcpPort: nil
        )
    }

    private func contem(_ agulha: [UInt8], em data: Data) -> Bool {
        let palheiro = [UInt8](data)
        guard palheiro.count >= agulha.count else { return false }
        return (0...(palheiro.count - agulha.count)).contains { inicio in
            Array(palheiro[inicio ..< inicio + agulha.count]) == agulha
        }
    }

    /// O primeiro byte de `GS v 0`, `GS !`, `GS V`, `GS ( k` e de todo comando `GS`.
    private static let gs: UInt8 = 0x1D

    /// Um valor que **não** é caso do enum, e o teste confere isso antes de usá-lo.
    private static let dialetoDeUmKitMaisNovo = "UM_DIALETO_QUE_ESTE_KIT_NAO_TEM"

    override func setUp() {
        super.setUp()
        XCTAssertNil(
            EscPosDialect(rawValue: Self.dialetoDeUmKitMaisNovo),
            "o valor 'desconhecido' das provas de tolerância virou um caso do enum: escolha outro"
        )
    }
}

private extension ReceiptLayout {
    /// Uma imagem mínima, em pontos, só para o caminho de foto atravessar o dialeto. A conversão de
    /// cinza é a de sempre; o que este arquivo mede é o envelope.
    func imageRasterDeTeste() -> Data? {
        let largura = 64
        let altura = 8
        let cinza = (0..<(largura * altura)).map { UInt8($0 % 2 == 0 ? 0 : 255) }
        guard let provider = CGDataProvider(data: Data(cinza) as CFData),
              let cgImage = CGImage(
                  width: largura,
                  height: altura,
                  bitsPerComponent: 8,
                  bitsPerPixel: 8,
                  bytesPerRow: largura,
                  space: CGColorSpaceCreateDeviceGray(),
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                  provider: provider,
                  decode: nil,
                  shouldInterpolate: false,
                  intent: .defaultIntent
              ),
              let imagem = ThermalImage.takeOwnership(cgImage)
        else { return nil }
        defer { imagem.clear() }
        return imageRaster(image: imagem, mode: .threshold)
    }
}

/// Store em memória, isolado deste arquivo: os outros testes têm os seus, e nomes iguais em alvos
/// diferentes já custaram tempo neste repositório.
private final class DialetoMemoryProfileDataStore: PrinterProfileDataStoring {
    private var data: Data?

    func readProfileData() throws -> Data? { data }
    func writeProfileData(_ data: Data?) throws { self.data = data }
}
