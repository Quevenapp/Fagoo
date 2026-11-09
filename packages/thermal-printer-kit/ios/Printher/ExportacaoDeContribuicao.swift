import Foundation
import ThermalPrinterKit

/**
 O pacote pronto para sair, do jeito que o diálogo do sistema precisa dele.

 Três coisas e nada mais, porque é exatamente o que o seletor de exportação consome: o conteúdo, o
 nome sugerido e — para a tela — o que o pacote não leva. Nenhum campo é `URL`, `UIViewController`
 nem `UTType`: este tipo atravessa a fronteira entre o que se prova sem tela e o que não se prova.

 - Note: `semMedida` **não é erro**. É o que a pessoa que exporta precisa saber que continua sem
   medida do outro lado. Ver ``ItemSemMedida``.
 */
public struct PacoteDeContribuicao: Equatable, Sendable {
    public let conteudo: Data
    public let nomeDoArquivo: String
    public let semMedida: [ItemSemMedida]

    /**
     O tipo próprio, e não `public.json`.

     Não é um literal deste arquivo: vem de ``PrinterContribution/typeIdentifier``, que é o mesmo
     valor que o `Info.plist` do app publicado declara em `UTExportedTypeDeclarations`. Dois
     literais seriam duas verdades, e a que envelhecesse mandaria o pacote para um destino que não
     sabe abri-lo.

     No Android o campo equivalente é o MIME, porque lá a filtragem é por MIME. Aqui não há campo de
     MIME: quem filtra no iOS é o identificador de tipo, e escrever o MIME também neste módulo seria
     inventar um terceiro literal para uma informação que só o `Info.plist` precisa ter.
     */
    public var tipoUniforme: String { PrinterContribution.typeIdentifier }

    /**
     As frases que a tela mostra sob "o que não vai junto".

     Derivadas de `semMedida`: a tela não tem uma segunda lista para manter em dia, e o que ela lê é
     o que o pacote realmente deixou de fora.
     */
    public var frasesDoQueNaoVaiJunto: [String] { semMedida.map(\.fraseParaQuemExporta) }
}

/**
 O que o pacote v1 **não** carrega, dito para quem está exportando.

 ## Por que esta lista mora aqui, e não no kit

 No Kotlin ela é `PrinterContributionUnmeasured`, do kit, e o módulo de tela só escreve a frase. O
 kit Swift **não publica enum equivalente** — medido por busca em 30/08/2026: não há `Unmeasured`
 em `ios/Sources/`, e `ios/Sources/` não é deste lote. Então a lista foi escrita aqui, com os
 mesmos nomes de valor do enum do Kotlin em `rawValue`, e a divergência ficou coberta por prova em
 vez de por compilador:

 1. `rawValue` é fixado por literal na suíte, e é o mesmo nome que o leitor de mesa devolve a quem
    importa. Se um lado renomear, a outra ponta continua dizendo o nome antigo e o teste denuncia.
 2. ``chaveAusenteNoPacote`` amarra cada item ao **JSON que o escritor do kit emite**: a suíte
    confere que nenhuma dessas chaves aparece no pacote. No dia em que o kit passar a carregar uma
    delas, o teste fica vermelho e o valor tem de sair daqui — que é a mesma trava do Kotlin, um
    momento depois (suíte, e não compilação).

 O `switch` de ``fraseParaQuemExporta`` continua exaustivo de propósito: um valor novo **não
 compila** até ganhar frase.
 */
public enum ItemSemMedida: String, CaseIterable, Equatable, Sendable {
    /// `GS ( k` honrado? Sem isso o QR sai rasterizado, que é o caminho seguro.
    case nativeQR = "NATIVE_QR"

    /// O mesmo para o `GS k` do código de barras.
    case nativeBarcode = "NATIVE_BARCODE"

    /// O teto de vazão de raster.
    case rasterThroughput = "RASTER_THROUGHPUT"

    /// Logotipo em NV.
    case nvLogo = "NV_LOGO"

    /// Como esta impressora aceita configuração de rede.
    case wifiConfiguration = "WIFI_CONFIGURATION"

    /**
     A frase de quem manda, e não de quem recebe.

     O leitor de mesa diz "chegou sem medida"; aqui a pessoa ainda está com a impressora na frente.
     São duas conversas sobre a mesma lista, e por isso duas frases.
     */
    public var fraseParaQuemExporta: String {
        switch self {
        case .nativeQR:
            return "se esta impressora desenha QR sozinha (lá o QR sai como imagem, que é o caminho seguro)"
        case .nativeBarcode:
            return "se ela desenha código de barras sozinha"
        case .rasterThroughput:
            return "a velocidade máxima que ela aguenta receber imagem"
        case .nvLogo:
            return "se ela guarda logotipo na memória dela"
        case .wifiConfiguration:
            return "como ela aceita configuração de rede"
        }
    }

    /**
     A propriedade que o pacote **não** traz por causa deste item, quando existe uma.

     É o que amarra a lista ao kit em vez de a uma memória: a suíte lê o JSON emitido e exige que
     nenhuma destas chaves esteja lá. `nvLogo` devolve `nil` porque logotipo em NV não tem
     propriedade em lugar nenhum do kit — nem no perfil medido, nem no pacote —, e inventar um nome
     de chave aqui seria fixar uma coisa que não existe.
     */
    public var chaveAusenteNoPacote: String? {
        switch self {
        case .nativeQR: return "nativeQrHonored"
        case .nativeBarcode: return "nativeBarcodeHonored"
        case .rasterThroughput: return "maxRasterBytesPerSecond"
        case .nvLogo: return nil
        case .wifiConfiguration: return "wifiConfigurationFamily"
        }
    }
}

/**
 Por que o gesto **não** aparece.

 Cada valor espelha um `guard` de ``PrinterContribution/package(for:osVersion:appVersion:)``, e a
 correspondência não é por cópia da regra: o escritor do kit Swift lança
 ``PrinterContributionError``, que é um enum tipado, e o preparo traduz o erro dele em vez de
 repetir a condição.

 **Não há valor para "o perfil não foi medido", e a ausência é a decisão.** No Kotlin ele existe
 porque lá `MeasuredProfile` aceita `source` embutido ou temporário. No Swift, `MeasuredProfile`
 **não pode existir** com outro `source`: tanto o inicializador público quanto `validated` — por
 onde o decodificador passa — recusam com `PrinterProfileValidationError.invalidSource`. Um valor
 aqui seria um ramo que nenhum teste alcança. É a mesma omissão que o Android fez com
 `measuredAtEpochMillis`, pelo mesmo motivo, e o invariante que a sustenta está fixado na suíte.
 */
public enum MotivoParaNaoContribuir: Equatable, Sendable {
    /**
     O nome da impressora não pode virar pacote.

     **Este motivo encolheu em 30/08/2026, e é do que sobrou que ele fala.** Ele nasceu grande
     porque o escritor exigia o que `PrinterDeclaredIdentity.sanitizeField` devolve intacto — ASCII
     imprimível em até 64 bytes —, e por isso engolia o caso comum do balcão brasileiro: "Cozinha do
     Balcão" caía aqui, e o gesto respondia dobrando o acento antes de empacotar. Aquela guarda saiu
     (as quatro medições estão em `PrinterContribution.displayNameIsPackageable`), e com ela saiu a
     dobra: **o nome da pessoa viaja como ela o escreveu**, acento, japonês, grego e tudo.

     O que ainda cai aqui é só o que `MeasuredProfile` também não aceita naquele campo:

     - nome vazio, ou só de espaço;
     - nome com caractere de controle dentro — um `\n` no meio do rótulo não é nome, e o outro lado
       não teria como mostrá-lo;
     - nome acima do que o perfil permite (80 caracteres).

     **Hoje nenhum desses chega até o gesto**, porque `MeasuredProfile` os recusa na construção e é
     por lá que todo perfil entra. O valor existe como fronteira — o escritor é público e lança
     ``PrinterContributionError/invalidDisplayName``, e o `switch` que o traduz tem de continuar
     exaustivo para o dia em que a régua do perfil e a do pacote deixarem de coincidir. O par no
     Android é `MotivoParaNaoContribuir.NOME_NAO_EXPORTAVEL`.
     */
    case nomeNaoExportavel

    /// O hospedeiro não soube dizer a versão do sistema, ou ela não passa no mesmo filtro.
    case versaoDoSistemaInvalida

    /// O hospedeiro não soube dizer a versão do app.
    case versaoDoAppInvalida

    /**
     O escritor recusou por um motivo que esta versão do módulo não sabe nomear.

     **Inalcançável hoje**, e é o `switch` exaustivo sobre ``PrinterContributionError`` que mantém
     assim: um caso novo lá não compila aqui até ganhar tradução. Este valor existe porque `throws`
     em Swift não é tipado — a linguagem exige um `catch` final —, e a escolha na saída dele é
     **fechar**: sem gesto, em vez de gesto que estoura.
     */
    case escritorRecusou
}

/// O desfecho de preparar a contribuição. Recusa é desfecho, nunca exceção.
public enum PreparoDaContribuicao: Equatable, Sendable {
    /// Há o que contribuir, e o pacote já está montado.
    case pronto(PacoteDeContribuicao)

    /// Não há o que contribuir. **O gesto não aparece**, e a pessoa não vê botão que estoura.
    case naoOferecido(MotivoParaNaoContribuir)
}

/**
 As duas versões que o escritor do kit exige como dados.

 O escritor é puro de propósito — recebe as versões como argumentos para o core não consultar
 `Bundle`, aparelho nem rede. Quem consulta é este módulo, que já vive do lado do hospedeiro; e por
 vir num tipo, o preparo inteiro continua chamável de um teste com dois literais.
 */
public struct VersoesDoAparelho: Equatable, Sendable {
    public let sistema: String
    public let app: String

    public init(sistema: String, app: String) {
        self.sistema = sistema
        self.app = app
    }

    /**
     As versões deste aparelho — **borda**: lê `ProcessInfo` e o `Info.plist` do app.

     Nenhuma das duas é endereço: a do sistema é o rótulo público do iOS e a do app é o
     `CFBundleShortVersionString`. `identifierForVendor`, nome do aparelho e modelo não são lidos
     aqui e não têm campo no pacote.

     Quando o `Info.plist` não traz a versão curta, ela volta vazia — e vazia o preparo **não
     oferece o gesto**, em vez de mandar um pacote sem procedência. Ver
     ``MotivoParaNaoContribuir/versaoDoAppInvalida``.
     */
    public static var doAparelho: VersoesDoAparelho {
        VersoesDoAparelho(sistema: rotuloDoSistema(), app: rotuloDoApp())
    }

    /// `18.5`, e não `Version 18.5 (Build 22F76)`: o rótulo público, montado dos números, sem
    /// número de compilação — que é identidade de instalação e não tem por que viajar.
    static func rotuloDoSistema() -> String {
        let versao = ProcessInfo.processInfo.operatingSystemVersion
        let base = "\(versao.majorVersion).\(versao.minorVersion)"
        return versao.patchVersion == 0 ? base : "\(base).\(versao.patchVersion)"
    }

    static func rotuloDoApp() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }
}

/**
 O gesto que produz o pacote de contribuição — **tudo o que decide, sem uma linha de tela.**

 ## O buraco que isto fecha

 Medido por busca em 30/08/2026: ``PrinterContribution/package(for:osVersion:appVersion:)`` tinha
 **zero chamadores de produção** — só `ios/Tests` o chamava. Do outro lado, o Printher de mesa **já
 sabe ler**: a bandeja tem a ação `IMPORTAR_PERFIL`, rotulada *"Adotar impressora homologada no
 celular…"*, e o leitor é `ImportacaoDeContribuicao.kt`. O rótulo apontava para um arquivo que o
 iOS não emitia. O Android ganhou o emissor; este arquivo é o do iOS.

 ## Por que aqui, e não no kit

 O escritor é puro de propósito. Quem sabe a versão do iOS e a do app é o hospedeiro, e o alvo
 `Printher` é a superfície que já vive do lado dele. O escritor continua sem saber onde roda; o
 gesto mora onde a homologação termina, que é onde está quem tem o que contribuir.

 ## Por que oferecer é montar

 ``preparar(perfil:versaoDoSistema:versaoDoApp:)`` é ao mesmo tempo a decisão de mostrar o botão e a
 construção do pacote: a tela mostra o gesto **se e somente se** o preparo devolveu ``
 PreparoDaContribuicao/pronto(_:)``. Um par `podeContribuir()` / `preparar()` teria duas cópias das
 mesmas condições, e o dia em que divergissem seria o dia em que o `throw` do escritor cai na cara
 de quem acabou de homologar. Montar custa menos de 1 KB; a divergência custa um crash.

 ## A diferença de plataforma que vale a pena registrar

 O Android **teve** de copiar a regra de versão do escritor, porque lá ela é privada e o `require`
 só produz mensagem. Aqui nenhuma regra é copiada: o escritor lança ``PrinterContributionError``,
 tipado, e o preparo traduz o erro dele. A única pergunta que este arquivo faz por conta própria é
 *qual das duas versões* falhou — e ela é feita à **mesma função** que o escritor usa,
 `PrinterDeclaredIdentity.sanitizeField`, que aqui é pública. Menos cópia, e por acidente de
 visibilidade, não por mérito.
 */
public enum ExportacaoDeContribuicao {
    /**
     A extensão do arquivo, e ela **não** é escolha deste lote.

     O app publicado já declara o tipo exportado `br.com.pixelgoods.printher.printer-contribution`
     no `Info.plist`, e a `public.filename-extension` que ele lista é esta. Divergir aqui faria o
     mesmo pacote ser reconhecido num aparelho e não no outro. O Android fixa o mesmo literal, pelo
     mesmo motivo, no módulo dele.
     */
    public static let extensaoDoArquivo = "printercontribution"

    /// O nome quando não sobra letra nenhuma do nome da impressora.
    public static let nomeGenerico = "impressora"

    /// Teto do miolo do nome, antes da extensão. Nome de arquivo comprido some no seletor.
    public static let maximoDoMiolo = 48

    /**
     Monta o pacote, ou diz por que não há o que montar.

     As condições são as do escritor, e chegam aqui como erro tipado em vez de como cópia. Ver o
     comentário de tipo sobre a diferença de plataforma.

     ## O nome da pessoa viaja intacto

     Entre 30/08/2026 de manhã e 30/08/2026 de tarde este gesto **dobrava o acento** do
     `displayName` antes de empacotar, e avisava a pessoa disso. Fazia-o porque o escritor do kit
     recusava nome fora do ASCII imprimível. Aquela guarda saiu — as quatro medições que a tiraram
     estão em `PrinterContribution.displayNameIsPackageable` —, e com ela saiu a dobra e o aviso que
     a acompanhava. **A pessoa batizou a impressora em português, e o nome chega do outro lado como
     ela escreveu.** O pacote é UTF-8 declarado, e sempre foi.

     A dobra que **fica** é outra, e é a de ``nomeDeArquivo(_:)``: aquilo é sistema de arquivos, com
     alfabeto fechado e uma segunda tranca contra endereço, e continua certo. As duas nunca foram a
     mesma coisa — só compartilhavam ``semAcento(_:)``.

     Nada aqui mexe no emparelhamento: a `capabilityKey` **não inclui o `displayName`**. O canônico é
     `v2|transportes|largura|colunas|dots|encoding|codePage|corte|feed|dialeto|status|porta` mais o
     sufixo de escala (`PrinterProfile.swift:570-579`). O leitor de mesa reconhece a medição pela
     chave, e não pelo rótulo.
     */
    public static func preparar(
        perfil: MeasuredProfile,
        versaoDoSistema: String,
        versaoDoApp: String
    ) -> PreparoDaContribuicao {
        do {
            let conteudo = try PrinterContribution.package(
                for: perfil,
                osVersion: versaoDoSistema,
                appVersion: versaoDoApp
            )
            return .pronto(
                PacoteDeContribuicao(
                    conteudo: conteudo,
                    // O nome do arquivo dobra por conta própria, e é a única dobra que sobrou: ele
                    // vai para o sistema de arquivos, e o do pacote vai para a bandeja de alguém.
                    nomeDoArquivo: nomeDeArquivo(perfil.displayName),
                    // A lista inteira, e não uma cópia parcial dela: o pacote v1 não carrega
                    // nenhum destes cinco, e o dia em que carregar um é o dia em que o valor sai.
                    semMedida: ItemSemMedida.allCases
                )
            )
        } catch let erro as PrinterContributionError {
            // Exaustivo de propósito: um `guard` novo no escritor não compila aqui até ganhar
            // motivo, que é a trava contra o botão aparecer para uma condição que ninguém nomeou.
            switch erro {
            case .invalidDisplayName:
                return .naoOferecido(.nomeNaoExportavel)
            case .invalidPlatformVersion:
                return .naoOferecido(
                    motivoDaVersao(sistema: versaoDoSistema, app: versaoDoApp)
                )
            }
        } catch {
            return .naoOferecido(.escritorRecusou)
        }
    }

    /**
     Qual das duas versões o escritor recusou.

     O escritor confere as duas num `guard` só e devolve um erro só. A pergunta é feita à mesma
     função que ele usa — não a uma cópia da regra dele —, e na mesma ordem: o sistema primeiro.
     */
    private static func motivoDaVersao(sistema: String, app: String) -> MotivoParaNaoContribuir {
        exportavel(sistema) ? .versaoDoAppInvalida : .versaoDoSistemaInvalida
    }

    private static func exportavel(_ valor: String) -> Bool {
        PrinterDeclaredIdentity.sanitizeField(Data(valor.utf8)) == valor
    }

    /**
     A régua do acento, e desde 30/08/2026 ela serve **só ao nome do arquivo**.

     "Balcão" vira "Balcao": decompõe canonicamente, onde o `ã` vira `a` mais um acento que ocupa
     escalar próprio, e apaga as marcas sem espaçamento. Letra sem acento sobra; letra que não tem
     versão sem acento — japonês, russo, grego — não sobra nada, e aí ``nomeDeArquivo(_:)`` cai em
     ``nomeGenerico``, que é o desfecho certo para um nome de arquivo e seria o desfecho errado para
     o nome dentro do pacote.

     Ela **já não toca no `displayName` que viaja**: o pacote é UTF-8 e leva o nome como a pessoa o
     escreveu. Ver a seção "O nome da pessoa viaja intacto" em
     ``preparar(perfil:versaoDoSistema:versaoDoApp:)``.

     O par no Android é `ExportacaoDeContribuicao.semAcento`, com o mesmo NFD e a mesma classe
     `\p{Mn}`. As duas suítes fixam a mesma tabela de entradas e saídas por literal, porque é a
     única prova de acordo disponível entre duas linguagens.
     */
    static func semAcento(_ valor: String) -> String {
        var escalares = String.UnicodeScalarView()
        for escalar in valor.decomposedStringWithCanonicalMapping.unicodeScalars
        where escalar.properties.generalCategory != .nonspacingMark {
            escalares.append(escalar)
        }
        return String(escalares)
    }

    /**
     O nome sugerido do arquivo, a partir do nome que a pessoa deu à impressora.

     ## Por que dá para usar o nome da impressora sem risco de endereço

     `MeasuredProfile` já recusa `displayName` que case com IP, MAC, UUID ou `VID`/`PID` — um nome
     com endereço nunca chega vivo até aqui. Mesmo assim esta função é uma **segunda tranca**,
     porque a garantia de privacidade não pode depender de uma tranca só nem de alguém lembrar
     dela: o que sai daqui é `[a-z0-9-]` mais a extensão, e o que ainda tiver forma de endereço
     depois disso é descartado.

     Acento vira letra sem acento em vez de virar hífen: "Cozinha — Balcão" precisa continuar
     legível no seletor de arquivo, que é o único lugar onde a pessoa reconhece o que está salvando.

     ## O hífen que quase virou o vazamento

     Achado do lado Android em 30/08/2026, reproduzido aqui por um teste que falhou **antes** de a
     conferência final existir: reduzir ao alfabeto seguro **não basta**. `AA:BB:CC:DD:EE:FF` vira
     `aa-bb-cc-dd-ee-ff`, que continua sendo um MAC legível — o hífen é separador de MAC tanto
     quanto os dois-pontos, e a mesma armadilha vale para um UUID, que já nasce com hífen. O
     alfabeto fechado apagou a pontuação errada e deixou a certa. Por isso a segunda tranca não é só
     a troca de caracteres: é a **conferência do que sobrou**, e o que ainda tiver forma de endereço
     cai em ``nomeGenerico``.

     IP não precisa de conferência: o ponto não sobrevive ao alfabeto, e `19216801` não é endereço
     nenhum — é um número. As duas formas conferidas são as duas que o hífen preserva.
     */
    public static func nomeDeArquivo(_ displayName: String) -> String {
        var miolo = semAcento(displayName)
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: hifen)
        miolo = String(miolo.prefix(maximoDoMiolo)).trimmingCharacters(in: hifen)
        if miolo.isEmpty { miolo = nomeGenerico }
        let temFormaDeEndereco = formasQueOHifenPreserva.contains { forma in
            miolo.range(of: forma, options: .regularExpression) != nil
        }
        return "\(temFormaDeEndereco ? nomeGenerico : miolo).\(extensaoDoArquivo)"
    }

    /**
     Escreve o pacote num arquivo temporário **com o nome do pacote**, e devolve onde ele ficou.

     ## Por que este passo existe, e por que ele é o que garante o nome do outro lado

     O consumidor é o Printher de mesa, que abre um `Path` vindo de um seletor de arquivo: o que
     precisa chegar lá é um **arquivo com nome e extensão**, e não um texto colado num corpo de
     e-mail. No iOS o único jeito de o nome ser exatamente o que este módulo escolheu é o nome já
     existir no disco antes de o diálogo abrir — o seletor de exportação grava o arquivo com o
     `lastPathComponent` que recebeu, e não com um nome derivado de tipo.

     É por isso que este passo fica **aqui**, e não do lado do diálogo: assim o nome que o leitor de
     mesa vai encontrar é exercitável na suíte, e o que sobra de não provável é só apresentar a
     tela. Ver ``PacoteDeContribuicao/nomeDoArquivo``.

     A pasta é nova a cada chamada porque duas impressoras batizadas igual produzem o mesmo nome de
     arquivo, e a segunda exportação não pode sobrescrever a primeira enquanto o diálogo da primeira
     ainda estiver de pé. O nome da pasta é sorteado na hora: não é identidade de aparelho, de
     instalação nem de impressora.

     Concatenar o nome como componente de caminho é seguro **porque o alfabeto é fechado**: o que
     ``nomeDeArquivo(_:)`` devolve é `[a-z0-9-]` mais a extensão, e nada disso é separador de
     caminho.
     */
    public static func arquivoTemporario(para pacote: PacoteDeContribuicao) throws -> URL {
        let pasta = FileManager.default.temporaryDirectory
            .appendingPathComponent("contribuicao-\(UUID().uuidString.lowercased())", isDirectory: true)
        try FileManager.default.createDirectory(at: pasta, withIntermediateDirectories: true)
        let arquivo = pasta.appendingPathComponent(pacote.nomeDoArquivo, isDirectory: false)
        try pacote.conteudo.write(to: arquivo, options: .atomic)
        return arquivo
    }

    private static let hifen = CharacterSet(charactersIn: "-")

    /// MAC e UUID — as duas formas de endereço que sobrevivem a `[a-z0-9-]`, porque o hífen é
    /// separador legítimo das duas. Ver ``nomeDeArquivo(_:)``.
    private static let formasQueOHifenPreserva = [
        "(?:[0-9a-f]{2}-){5}[0-9a-f]{2}",
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    ]
}
