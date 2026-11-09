import Foundation

/**
 Bytes de uma sonda, e **o dialeto em que ela foi montada**.

 **O campo do dialeto é o cinto de segurança.** Antes, o portão do envio olhava só o alvo: "esta
 impressora fala ESC/POS?". Ele acertava por acaso, porque só existia um conjunto de sondas. Com dois
 conjuntos, a pergunta certa é outra — **estes bytes falam a língua desta impressora?** — e ela só é
 respondível se os bytes souberem de onde vieram.

 Sem este campo, a sequência Procomp recém-escrita seria recusada pelo mesmo portão que existe para
 protegê-la, e a de ESC/POS voltaria a poder alcançar a IM453H se alguém trocasse o portão de lugar.
 Ver ``PrinterHomologationSession``.

 Espelha `PrinterProbe` de `android/src/main/java/br/com/thermalprinterkit/PrinterHomologationProbes.kt`.
 */
public struct PrinterProbe: Equatable, Sendable {
    public let bytes: Data
    public let dialect: EscPosDialect

    public init(bytes: Data, dialect: EscPosDialect) {
        self.bytes = bytes
        self.dialect = dialect
    }

    public var size: Int { bytes.count }
}

/**
 Qual série de tiras a homologação envia, escolhida pelo **dialeto do alvo**.

 **Por que existe.** Até este lote havia uma série só, e ela era ESC/POS de ponta a ponta. A
 homologação não tinha como perguntar "que língua esta impressora fala?" — nem como recusar, porque
 no lado Swift não havia portão nenhum. Com duas séries, a escolha precisa de um lugar, e este é o
 lugar: um `switch` exaustivo, sem `default`, do mesmo formato de ``EscPosDialectGate``. **Dialeto
 novo não compila até alguém responder aqui qual série ele recebe** — e não existe padrão razoável,
 porque o padrão silencioso seria "manda ESC/POS", que é o defeito que travou a IM453H.

 **O que é comum e o que é próprio.** As duas séries medem as mesmas coisas, na mesma ordem, com as
 mesmas réguas: quem lê uma tira de uma família reconhece a da outra. O que muda é o envelope dos
 bytes — e, em duas etapas, se a tira **existe**. Ver ``nativeCode(printableDots:)`` e
 ``codePage(cutProtocol:cutFeedLines:)``.

 **A forma é a do Swift, e não a do Kotlin.** Lá a régua de avanço é uma lista de `CutFeedProbeStrip`
 e não há tira de geometria por largura; aqui a máquina manda a régua inteira num payload só e tem
 ``geometry(paperWidth:)``. Espelhar a forma do outro lado obrigaria a inventar um caminho que
 nenhuma das duas máquinas usa.
 */
public protocol PrinterHomologationProbeSet {
    /// A tira que abre toda medição: as réguas de 58 e 80 mm lado a lado.
    func paperWidthRulers() -> PrinterProbe

    /// A régua da largura já escolhida — colunas e faixas raster daquela bobina.
    func geometry(paperWidth: PrinterPaperWidth) -> PrinterProbe

    /// A régua completa de colunas e de dots, para quem não reconheceu o papel na tira anterior.
    func fullGeometry() -> PrinterProbe

    /// A tira de altura declarada que devolve o fator de compensação vertical.
    func rasterThroughput(printableDots: Int) -> PrinterProbe?

    /**
     A tira que mede se a firmware desenha QR e barras pelo comando nativo, ou `nil` quando **este
     dialeto não tem comando nativo medido**.

     `nil` não é "esta impressora não sabe": é "não há tira honesta a mandar". A máquina pula a etapa
     e grava os dois campos ausentes — a mesma ausência de
     ``PrinterHomologationMachine/skipNativeCodeMeasurement()``, que significa que ninguém mediu.

     **A largura inválida também devolve `nil`**, como na série ESC/POS de sempre. As duas ausências
     se distinguem por ``measuresNativeCode``, que não depende de largura nenhuma.
     */
    func nativeCode(printableDots: Int) -> PrinterProbe?

    /**
     Se esta série tem tira de código nativo. Verdadeiro exatamente quando
     ``nativeCode(printableDots:)`` devolve bytes para uma largura válida.

     É uma pergunta separada porque a máquina precisa decidir **se entra na etapa** antes de haver
     largura para montar a tira, e montar uma sonda só para descobrir que ela existe seria pagar um
     raster para responder um booleano. As duas respostas não podem divergir, e é isso que
     `HomologacaoProcompTests` prende.
     */
    var measuresNativeCode: Bool { get }

    /**
     Os comandos de corte que esta série coloca no papel, um por tira.

     A série ESC/POS manda seis porque a firmware é quem escolhe qual atende. Outra série pode mandar
     um só; o que ela não pode é mandar zero e ainda assim declarar guilhotina.
     */
    var cutCandidates: [CutProtocol] { get }

    func isolatedCut(_ cutProtocol: CutProtocol) -> PrinterProbe?

    /// A régua de avanço inteira num envio só — a forma que a máquina do Swift usa.
    func cutFeed(cutProtocol: CutProtocol) -> PrinterProbe?

    /**
     A tira de páginas de código, ou `nil` quando o emissor deste dialeto **não consulta** a página
     do perfil.

     Mesma regra do ``nativeCode(printableDots:)``: tira que produz resposta que ninguém emite é
     papel gasto para decidir nada. A máquina pula a etapa e o perfil fica como a codificação daquele
     dialeto já é.
     */
    func codePage(cutProtocol: CutProtocol, cutFeedLines: Int) -> PrinterProbe?

    /// Se esta série tem tira de página. Verdadeiro exatamente quando
    /// ``codePage(cutProtocol:cutFeedLines:)`` devolve bytes.
    var measuresCodePage: Bool { get }

    /// `nil` quando o perfil não é desta série — recusa, e não parada do processo. Ver
    /// ``ProcompHomologationProbeSet/finalReceipt(profile:identity:transport:decoration:)``.
    func finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?,
        decoration: (any ReceiptDecoration)?
    ) -> PrinterProbe?

    /// Tiras que saem em toda medição desta série, o comprovante final incluído.
    var minimumStrips: Int { get }

    /// O teto: com guilhotina, régua de avanço inteira e a régua completa de geometria.
    var maximumStrips: Int { get }
}

/// A escolha, e o único lugar dela. Ver ``PrinterHomologationProbeSet``.
public func printerHomologationProbeSet(_ dialect: EscPosDialect) -> any PrinterHomologationProbeSet {
    switch dialect {
    case .epsonCompatible: return EscPosHomologationProbeSet()
    case .procompEscP: return ProcompHomologationProbeSet()
    }
}

/// A série de sempre, byte a byte igual à de antes deste protocolo existir.
struct EscPosHomologationProbeSet: PrinterHomologationProbeSet {
    func paperWidthRulers() -> PrinterProbe {
        probe(PrinterProbePayloads.paperWidthRulers())
    }

    func geometry(paperWidth: PrinterPaperWidth) -> PrinterProbe {
        probe(PrinterProbePayloads.geometry(paperWidth: paperWidth))
    }

    func fullGeometry() -> PrinterProbe {
        probe(PrinterProbePayloads.fullGeometry())
    }

    func rasterThroughput(printableDots: Int) -> PrinterProbe? {
        PrinterProbePayloads.rasterThroughput(printableDots: printableDots).map(probe)
    }

    func nativeCode(printableDots: Int) -> PrinterProbe? {
        PrinterProbePayloads.nativeCode(printableDots: printableDots).map(probe)
    }

    var measuresNativeCode: Bool { true }

    /**
     Todos os dialetos saem antes de qualquer pergunta.

     Parar no primeiro que corta economiza papel e esconde o que a impressora faz nos outros — foi
     assim que a MP-4200 quase passou como "corta parcial e pronto", medido em 12/08.
     */
    var cutCandidates: [CutProtocol] { PrinterHomologationMachine.allCutProtocols }

    func isolatedCut(_ cutProtocol: CutProtocol) -> PrinterProbe? {
        PrinterProbePayloads.isolatedCut(cutProtocol).map(probe)
    }

    func cutFeed(cutProtocol: CutProtocol) -> PrinterProbe? {
        PrinterProbePayloads.cutFeed(cutProtocol: cutProtocol).map(probe)
    }

    func codePage(cutProtocol: CutProtocol, cutFeedLines: Int) -> PrinterProbe? {
        probe(PrinterProbePayloads.codePage(cutProtocol: cutProtocol, cutFeedLines: cutFeedLines))
    }

    var measuresCodePage: Bool { true }

    func finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?,
        decoration: (any ReceiptDecoration)?
    ) -> PrinterProbe? {
        probe(
            PrinterProbePayloads.finalReceipt(
                profile: profile,
                identity: identity,
                transport: transport,
                decoration: decoration
            )
        )
    }

    var minimumStrips: Int { PrinterHomologationPaperCost.minimumStrips }
    var maximumStrips: Int { PrinterHomologationPaperCost.maximumStrips }

    /// Estes bytes **são** ESC/POS, venha de onde vier o perfil: ``PrinterProbePayloads`` abre em
    /// `ESC @` e emite `GS v 0` sem consultar dialeto nenhum. Carimbar o dialeto do perfil aqui
    /// deixaria uma tira ESC/POS passar por Procomp no portão do envio.
    private func probe(_ bytes: Data) -> PrinterProbe {
        PrinterProbe(bytes: bytes, dialect: .epsonCompatible)
    }
}

/**
 A série da Diebold Procomp. Ver ``ProcompHomologationProbes`` para o que cada tira mede.

 Duas etapas devolvem `nil` aqui, e é medição: nesta firmware o comando nativo nunca saiu em papel, e
 o emissor de texto não consulta a página do perfil.
 */
struct ProcompHomologationProbeSet: PrinterHomologationProbeSet {
    func paperWidthRulers() -> PrinterProbe { ProcompHomologationProbes.paperWidthRulers() }

    func geometry(paperWidth: PrinterPaperWidth) -> PrinterProbe {
        ProcompHomologationProbes.geometry(paperWidth: paperWidth)
    }

    func fullGeometry() -> PrinterProbe { ProcompHomologationProbes.fullGeometry() }

    func rasterThroughput(printableDots: Int) -> PrinterProbe? {
        ProcompHomologationProbes.rasterThroughput(printableDots: printableDots)
    }

    /// `ESC ( k` e `ESC | 0` existem no manual e nunca saíram em papel. Não há tira honesta.
    func nativeCode(printableDots: Int) -> PrinterProbe? { nil }

    var measuresNativeCode: Bool { false }

    /**
     Um candidato só, e ele é o **lugar do corte no formato comum**, não uma medição desta unidade.

     `MeasuredProfile.hasCutter` é `cutProtocol != .none`, e ``CutProtocol`` inteiro é ESC/POS: não há
     valor que signifique `ESC w`. `.gsV1` é o que mais perto chega do que a bancada viu — corte
     parcial, sem avanço embutido, o que mantém a régua de avanço obrigatória —, e **nenhum byte `GS`
     sai desta série**: quem emite é `procompFinish`, sempre com `ESC w`. A folha final diz isso em
     letra, para ninguém transcrever `GS V 1` como se fosse medida — ver
     ``ProcompHomologationProbes/profileLines(profile:identity:transport:)``.
     */
    var cutCandidates: [CutProtocol] { [.gsV1] }

    func isolatedCut(_ cutProtocol: CutProtocol) -> PrinterProbe? {
        ProcompHomologationProbes.isolatedCut()
    }

    func cutFeed(cutProtocol: CutProtocol) -> PrinterProbe? { ProcompHomologationProbes.cutFeed() }

    /// `procompText` codifica em ABICOMP e não lê a página do perfil. A resposta não teria uso.
    func codePage(cutProtocol: CutProtocol, cutFeedLines: Int) -> PrinterProbe? { nil }

    var measuresCodePage: Bool { false }

    /// `nil` quando o perfil não fala Procomp. Aqui esteve uma `precondition`, que derruba o
    /// processo em release — e o erro de fiação que ela pegava vira, por este caminho, uma recusa
    /// que a sessão sabe mostrar (`.finalReceiptFailed`, com "tentar de novo"). Medido em
    /// 04/09/2026: com a precondição, trocar o dialeto da máquina matava o processo de teste com
    /// signal 5 antes de qualquer asserção rodar.
    func finalReceipt(
        profile: MeasuredProfile,
        identity: PrinterDeclaredIdentity?,
        transport: PrinterTransport?,
        decoration: (any ReceiptDecoration)?
    ) -> PrinterProbe? {
        ProcompHomologationProbes.finalReceipt(
            profile: profile,
            identity: identity,
            transport: transport,
            decoration: decoration
        )
    }

    /// Largura, vazão e comprovante final. Sem tira de código nativo e sem tira de página.
    var minimumStrips: Int {
        PrinterHomologationPaperCost.widthRulers
            + PrinterHomologationPaperCost.rasterThroughput
            + PrinterHomologationPaperCost.finalReceipt
    }

    var maximumStrips: Int {
        minimumStrips
            + PrinterHomologationPaperCost.fullGeometry
            + cutCandidates.count
            + PrinterHomologationPaperCost.cutFeedStrips
    }
}

public extension PrinterHomologationPaperCost {
    /**
     O piso e o teto de papel **por dialeto**.

     Os `static` sem dialeto continuam existindo e continuam valendo para a série ESC/POS: eles são o
     que `Printher/PrinterHomologationView.swift` já lê para anunciar "São de N a M tiras curtas de
     teste", e mexer neles seria mexer fora do escopo deste lote. Estes dois são o caminho para quem
     **sabe** o dialeto do alvo — a conta Procomp é menor porque a série não tem tira de código
     nativo nem tira de página.
     */
    static func minimumStrips(_ dialect: EscPosDialect) -> Int {
        printerHomologationProbeSet(dialect).minimumStrips
    }

    static func maximumStrips(_ dialect: EscPosDialect) -> Int {
        printerHomologationProbeSet(dialect).maximumStrips
    }
}
