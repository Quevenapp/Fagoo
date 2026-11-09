import XCTest
@testable import ThermalPrinterKit

/**
 A sonda de família `1F 77`, byte a byte e leitura por leitura.

 **O bloco de paridade é o que mais importa aqui.** Os vetores de `ThermalWifiProbeParityVectors` são
 literais idênticos, caractere a caractere, aos de
 `android/src/test/java/br/com/thermalprinterkit/ThermalWifiProbeTest.kt`. Não são a saída da
 implementação gravada de volta: a tira é a que a bancada exercitou em 21/08/2026 na Bematech PP-10W
 e em 21–22/08/2026 na GoldenSky GS-T80C-WF, e cada leitura tem um desfecho que saiu em papel.

 O que estes testes **não** provam: que a impressora está na rede, que a conexão sobreviveu ou que o
 bloco que saiu descreve a configuração que a pessoa quer. A sonda mede uma coisa só — se a tabela
 vendor `1F` existe e despacha — e o teste mais importante do arquivo é o que fixa que ela se cala
 quando não mediu.
 */
final class ThermalWifiProbeTests: XCTestCase {
    // MARK: - paridade entre plataformas

    func testATiraDaSondaSaiByteAByteIgualAODoAndroid() {
        XCTAssertEqual(
            ThermalWifiProbe.usWFamilyStrip,
            Data(ThermalWifiProbeParityVectors.usWFamilyStrip)
        )
    }

    func testCadaLeituraLevaAoResultadoQueSaiuEmPapel() {
        for vector in ThermalWifiProbeParityVectors.readings {
            XCTAssertEqual(ThermalWifiProbe.result(for: vector.reading), vector.result, vector.name)
            XCTAssertEqual(
                ThermalWifiProbe.result(for: vector.reading).confirmedProtocol,
                vector.confirmedProtocol,
                vector.name
            )
        }
    }

    func testAsQuatroLeiturasMedidasEstaoTodasNoBlocoDeParidade() {
        // Ordem e conjunto, juntos: leitura nova sem vetor faz este teste cair antes de a derivação
        // dela existir em uma só das plataformas.
        XCTAssertEqual(
            ThermalWifiProbeParityVectors.readings.map(\.reading),
            ThermalWifiProbeReading.allCases
        )
    }

    func testOsNomesDosEnumsSaoOsMesmosDasDuasPlataformas() {
        XCTAssertEqual(
            ThermalWifiProbeReading.allCases.map(\.rawValue),
            ThermalWifiProbeParityVectors.readings.map(\.rawValue)
        )
        XCTAssertEqual(
            ThermalWifiProbeIndeterminacy.allCases.map(\.rawValue),
            ["SUBCOMMAND_SWALLOWED", "PROBE_DID_NOT_PRINT"]
        )
    }

    func testOsRotulosDaLeituraSaoOsMesmosDasDuasPlataformas() {
        XCTAssertEqual(
            ThermalWifiProbeReading.allCases.map(\.label),
            ThermalWifiProbeParityVectors.readings.map(\.label)
        )
    }

    func testAsFrasesDeIndeterminacaoSaoAsMesmasDasDuasPlataformas() {
        XCTAssertEqual(
            ThermalWifiProbeIndeterminacy.allCases.map(\.message),
            ThermalWifiProbeParityVectors.indeterminacyMessages
        )
    }

    func testOContratoDeEntregaEOMesmoDasDuasPlataformas() {
        XCTAssertEqual(ThermalWifiProbe.readsResponseBytes, ThermalWifiProbeParityVectors.readsResponseBytes)
        XCTAssertEqual(
            ThermalWifiProbe.dropsDeliveringConnection,
            ThermalWifiProbeParityVectors.dropsDeliveringConnection
        )
        XCTAssertEqual(
            ThermalWifiProbe.writesConfiguration,
            ThermalWifiProbeParityVectors.writesConfiguration
        )
        XCTAssertEqual(ThermalWifiProbe.atCommandCount, ThermalWifiProbeParityVectors.atCommandCount)
        XCTAssertEqual(
            ThermalWifiProbe.atCommandTimeoutSeconds,
            ThermalWifiProbeParityVectors.atCommandTimeoutSeconds
        )
        XCTAssertEqual(
            ThermalWifiProbe.worstCasePortOutageSeconds,
            ThermalWifiProbeParityVectors.worstCasePortOutageSeconds
        )
    }

    // MARK: - a tira que a bancada exercitou

    func testATiraEExatamenteOsDoisMarcadoresEOSubcomandoNoMeio() {
        // `"A\n" + 1F 78 + "\nB\n"`. Os sete bytes: o par `1F 78` saiu do iPhone por TCP 9100 em 21/08/2026 e
        // trouxeram de volta `Mode:` / `SSID:` / `PWD:` na PP-10W.
        let tira = ThermalWifiProbe.usWFamilyStrip
        XCTAssertEqual(tira.count, 19)
        XCTAssertEqual(Array(tira[0..<2]), [0x41, 0x0a])
        XCTAssertEqual(Array(tira[2..<4]), [0x1f, 0x78])
        // A quebra vem ANTES do marcador de fecho: sem ela, um `0x78` não reconhecido sairia
        // colado no `B`, e o rótulo prometeria um `x` sozinho que o papel nunca mostraria.
        XCTAssertEqual(Array(tira[4..<7]), [0x0a, 0x42, 0x0a])
        // O avanço final, sem o qual o marcador de fecho fica dentro da impressora e a pessoa não
        // consegue responder "saiu o B?". Medido na PP-10W em 23/08.
        XCTAssertEqual(Array(tira[7...]), Array(repeating: 0x0a, count: 12))
    }

    func testOsMarcadoresSaoOsDaTiraENaoLiteraisSoltos() {
        // Os marcadores existem porque "não saiu nada" é ambíguo: sem eles, "o comando foi engolido"
        // e "a impressora não recebeu bytes" produzem o mesmo papel em branco — a ambiguidade que
        // custou meia hora de bancada em 21/08. Se a frase que a pessoa lê e os bytes que saem
        // discordarem, a tira deixa de ser legível, e é isso que este teste impede.
        let tira = ThermalWifiProbe.usWFamilyStrip
        XCTAssertEqual(tira.first, ThermalWifiProbe.openingMarker.asciiValue)
        // O fecho não é mais o penúltimo byte: depois dele vem o avanço que o tira de dentro da
        // impressora. Procurar pela posição fixa esconderia justamente essa mudança.
        let posicaoDoFecho = tira.count - 1 - Int(ThermalWifiProbe.tearFeedLines) - 1
        XCTAssertEqual(tira[posicaoDoFecho], ThermalWifiProbe.closingMarker.asciiValue)
        for leitura in ThermalWifiProbeReading.allCases {
            XCTAssertTrue(
                leitura.label.contains(ThermalWifiProbe.openingMarker),
                "A frase de \(leitura.rawValue) não cita o marcador de abertura."
            )
        }
    }

    func testOsMarcadoresNaoColidemEntreSiNemComALetraDoSubcomando() {
        // Se o marcador fosse `x`, o caso 3 — `A`, um `x`, `B` — viraria indistinguível dos outros
        // dois, e a tira pararia de medir o que existe para medir.
        let abre = ThermalWifiProbe.openingMarker
        let fecha = ThermalWifiProbe.closingMarker
        let letra = ThermalWifiProbe.unrecognizedSubcommandLetter
        XCTAssertNotEqual(abre, fecha)
        XCTAssertNotEqual(abre, letra)
        XCTAssertNotEqual(fecha, letra)
    }

    func testALetraDoSubcomandoNaoReconhecidoEADoProprioByteDaTira() {
        // `0x78` é `x`. A letra sai do byte e não de uma digitação: publicá-la como literal deixaria
        // a frase descrever uma tira diferente da que sai, no dia em que o subcomando mudar.
        XCTAssertEqual(ThermalWifiProbe.unrecognizedSubcommandLetter, "x")
        let byteDoSubcomando = ThermalWifiProbe.usWFamilyStrip[3]
        XCTAssertEqual(ThermalWifiProbe.unrecognizedSubcommandLetter.asciiValue, byteDoSubcomando)
    }

    func testATiraNaoCarregaNenhumByteQueOsDocumentosProibem() {
        // A lista das duas famílias, junta: `1F 77` grava a configuração, `1F 6D` grava MAC,
        // `1F 69` põe IP fixo, `1F 62 44 00` desliga DHCP, `1F 25` mexe em máscara/gateway,
        // `1F 4E` não existe na tabela US, `03` é o canal de atualização que apaga flash, `12 54`
        // é o autoteste (inofensivo, mas não é o que esta tira mede), e `1F 1B 1F` é o cabeçalho da
        // outra família, cujo próximo byte do fluxo viraria seletor.
        let proibidos: [[UInt8]] = [
            [0x1f, 0x77], [0x1f, 0x6d], [0x1f, 0x69], [0x1f, 0x62, 0x44, 0x00],
            [0x1f, 0x25], [0x1f, 0x4e], [0x03], [0x12, 0x54],
            [0x1f, 0x1b, 0x1f],
        ]
        let tira = Array(ThermalWifiProbe.usWFamilyStrip)
        for proibido in proibidos {
            XCTAssertFalse(Self.tira(tira, contem: proibido), "A tira carrega \(Self.hex(proibido))")
        }
        // E o `1F` aparece uma vez só, com o `78` colado nele: qualquer outro `1F` na tira faria o
        // byte seguinte virar subcomando de alguma coisa.
        XCTAssertEqual(tira.filter { $0 == 0x1f }.count, 1)
        XCTAssertEqual(tira[tira.firstIndex(of: 0x1f)! + 1], 0x78)
    }

    // MARK: - leitura ambígua nunca vira família confirmada

    func testLeituraAmbiguaNuncaViraFamiliaConfirmada() {
        // **É o teste central desta camada.** Os dois casos ambíguos são coisas diferentes e nenhum
        // dos dois autoriza configurar: "saiu A e B, sem bloco" prova que algo consumiu o `1F` — e a
        // própria PP-10W faz isso com `1F 4E`, que nem existe na tabela dela —, e "não saiu nada"
        // não é resposta sobre a família, é a tira não tendo saído. Colapsar qualquer um dos dois em
        // "confirmada" mandaria `1F 77` para uma impressora que não o entende; colapsar em "ausente"
        // gravaria uma medição que ninguém fez.
        let ambiguas: [ThermalWifiProbeReading] = [.markersOnly, .nothingPrinted]
        for leitura in ambiguas {
            let resultado = ThermalWifiProbe.result(for: leitura)
            XCTAssertNotEqual(resultado, .usWFamilyHonored, leitura.rawValue)
            XCTAssertNotEqual(resultado, .usWFamilyAbsent, leitura.rawValue)
            XCTAssertNil(resultado.confirmedProtocol, leitura.rawValue)
            XCTAssertFalse(resultado.authorizesConfiguration, leitura.rawValue)
        }
        // E são dois desfechos distintos, não um só: quem receber `nothingPrinted` tem de poder
        // mandar de novo, e quem receber `markersOnly` já mandou e mediu.
        XCTAssertEqual(
            ThermalWifiProbe.result(for: .markersOnly),
            .indeterminate(reason: .subcommandSwallowed)
        )
        XCTAssertEqual(
            ThermalWifiProbe.result(for: .nothingPrinted),
            .indeterminate(reason: .probeDidNotPrint)
        )
        XCTAssertNotEqual(
            ThermalWifiProbe.result(for: .markersOnly),
            ThermalWifiProbe.result(for: .nothingPrinted)
        )
    }

    func testSoOBlocoNoMeioAutorizaConfigurar() {
        for leitura in ThermalWifiProbeReading.allCases {
            XCTAssertEqual(
                ThermalWifiProbe.result(for: leitura).authorizesConfiguration,
                leitura == .blockBetweenMarkers,
                leitura.rawValue
            )
        }
        XCTAssertEqual(ThermalWifiProbe.result(for: .blockBetweenMarkers).confirmedProtocol, .usW)
    }

    func testOAtalhoDoMotivoDevolveExatamenteOsDesfechosIndeterminados() {
        XCTAssertEqual(
            ThermalWifiProbe.result(for: .markersOnly).indeterminacy,
            .subcommandSwallowed
        )
        XCTAssertEqual(
            ThermalWifiProbe.result(for: .nothingPrinted).indeterminacy,
            .probeDidNotPrint
        )
        XCTAssertNil(ThermalWifiProbe.result(for: .blockBetweenMarkers).indeterminacy)
        XCTAssertNil(ThermalWifiProbe.result(for: .letterBetweenMarkers).indeterminacy)
        // Ter motivo e autorizar são incompatíveis: um resultado com os dois seria uma tela que
        // libera o quadro e explica, na mesma frase, por que não mediu nada.
        for resultado in Self.todosOsResultados() where resultado.indeterminacy != nil {
            XCTAssertFalse(resultado.authorizesConfiguration, "\(resultado)")
        }
    }

    func testAAutorizacaoNuncaDiscordaDaFamiliaConfirmada() {
        // Um estado em que `authorizesConfiguration` diz sim e `confirmedProtocol` é nulo deixaria a
        // tela mandar quadro nenhum, ou mandar o quadro de uma família que não foi medida.
        for resultado in Self.todosOsResultados() {
            XCTAssertEqual(resultado.authorizesConfiguration, resultado.confirmedProtocol != nil)
        }
    }

    // MARK: - a GoldenSky é escolha explícita, nunca conclusão da sonda

    func testNenhumaLeituraConfirmaAFamiliaDaGoldenSky() {
        // A GoldenSky engole o `1F 78` porque o cabeçalho dela é `1F 1B 1F` e o parser descarta o
        // par ao ver um `78` onde esperava `1B`. Mas qualquer firmware que consuma o byte seguinte
        // ao `1F` produz a mesma tira, então papel nenhum a identifica. Confirmá-la exigiria
        // escrever o quadro dela ou travar o parser à espera dos NUL — que foi o que a bancada fez
        // de propósito em 22/08, e não é instrumento.
        for leitura in ThermalWifiProbeReading.allCases {
            XCTAssertNotEqual(
                ThermalWifiProbe.result(for: leitura).confirmedProtocol,
                .usEscUs,
                leitura.rawValue
            )
        }
        for resultado in Self.todosOsResultados() {
            XCTAssertNotEqual(resultado.confirmedProtocol, .usEscUs)
        }
    }

    // MARK: - a pessoa relata a leitura, não a conclusão

    func testNenhumaFraseDaSondaCitaMarcaModeloOuFamilia() {
        // O padrão do kit: quem está com a tira na mão responde o que viu. Uma frase que diga
        // "Rongta" ou "GoldenSky" transforma a pergunta em "que impressora é esta?", que é catálogo
        // — e catálogo é exatamente o que este projeto decidiu não fazer, porque em 21/08 alguém
        // poria a GoldenSky na lista por ser "80 mm com Wi-Fi".
        let proibidas = [
            "Rongta", "Bematech", "GoldenSky", "PP-10W", "RPP200", "GS-T80C",
            "1F 77", "1F 1B 1F", "compatível", "compativel", "suportada", "incompatível",
        ]
        let frases = ThermalWifiProbeReading.allCases.map(\.label)
            + ThermalWifiProbeIndeterminacy.allCases.map(\.message)
        for frase in frases {
            for proibida in proibidas {
                XCTAssertFalse(
                    frase.localizedCaseInsensitiveContains(proibida),
                    "\(frase) — cita \(proibida)"
                )
            }
        }
    }

    func testCadaFraseDeIndeterminacaoDizQueAquiloNaoEResposta() {
        // A indeterminação só serve se ela chegar como indeterminação. "Sumiu" e "não saiu" são
        // fáceis de ler como "não tem", e é essa leitura que a frase precisa desfazer.
        for indeterminacao in ThermalWifiProbeIndeterminacy.allCases {
            XCTAssertTrue(indeterminacao.message.contains("não"), indeterminacao.rawValue)
            XCTAssertFalse(indeterminacao.message.isEmpty, indeterminacao.rawValue)
        }
        XCTAssertEqual(
            Set(ThermalWifiProbeIndeterminacy.allCases.map(\.message)).count,
            ThermalWifiProbeIndeterminacy.allCases.count
        )
    }

    func testCadaLeituraTemUmaFrasePropria() {
        let frases = ThermalWifiProbeReading.allCases.map(\.label)
        XCTAssertEqual(Set(frases).count, frases.count)
        XCTAssertTrue(frases.allSatisfy { !$0.isEmpty })
    }

    // MARK: - o que sobrevive ao disco

    /// O indeterminado não tem como ser gravado, e é isso que separa este tipo do da sonda.
    ///
    /// Espelhar ``ThermalWifiProbeResult`` no perfil tornaria "não saiu nada" e "os marcadores
    /// saíram sem o bloco" representáveis em disco — e um perfil assim afirmaria medição onde não
    /// houve nenhuma. A ausência de medição já tem forma: `nil`.
    func testOIndeterminadoNaoTemComoSerGravadoNoPerfil() {
        for motivo in ThermalWifiProbeIndeterminacy.allCases {
            XCTAssertNil(
                PrinterWifiConfigurationFamily(measured: .indeterminate(reason: motivo)),
                "\(motivo) virou valor gravável"
            )
        }
        // E não há outro caminho: os três casos do tipo são exatamente os que a lista abaixo fixa.
        XCTAssertEqual(
            PrinterWifiConfigurationFamily.allCases,
            [.measuredUsWHonored, .measuredUsWAbsent, .chosenUsEscUs]
        )
    }

    /// Os dois desfechos conclusivos da tira viram valor gravado, e a negativa junto.
    ///
    /// A negativa custou papel e é conclusiva: sem gravá-la, a tela reoferece a sonda a quem já
    /// respondeu.
    func testOsDoisDesfechosConclusivosViramValorGravado() {
        XCTAssertEqual(
            PrinterWifiConfigurationFamily(measured: .usWFamilyHonored),
            .measuredUsWHonored
        )
        XCTAssertEqual(
            PrinterWifiConfigurationFamily(measured: .usWFamilyAbsent),
            .measuredUsWAbsent
        )
    }

    /// O valor gravado diz **como** foi determinado, e não só qual é a família.
    ///
    /// É a decisão de desenho inteira: a primeira família é medida pela tira, a segunda é escolha
    /// da pessoa porque nenhuma sonda a confirma. Guardar as duas do mesmo jeito faria uma sessão
    /// futura acreditar que houve medição onde houve escolha.
    func testOValorGravadoCarregaAProcedenciaEnaoSoAFamilia() {
        XCTAssertTrue(PrinterWifiConfigurationFamily.measuredUsWHonored.wasMeasured)
        XCTAssertTrue(PrinterWifiConfigurationFamily.measuredUsWAbsent.wasMeasured)
        XCTAssertFalse(PrinterWifiConfigurationFamily.chosenUsEscUs.wasMeasured)

        // E medido não é sinônimo de configurável: a negativa é medição conclusiva e mesmo assim
        // não autoriza quadro nenhum, porque ela diz qual família **não** é.
        XCTAssertEqual(PrinterWifiConfigurationFamily.measuredUsWHonored.configuredProtocol, .usW)
        XCTAssertEqual(PrinterWifiConfigurationFamily.chosenUsEscUs.configuredProtocol, .usEscUs)
        XCTAssertNil(PrinterWifiConfigurationFamily.measuredUsWAbsent.configuredProtocol)
    }

    /// A família da GoldenSky nunca chega ao perfil por medição, nem por engano de construção.
    ///
    /// Mesma disciplina de ``ThermalWifiProbeResult``, onde os desfechos conclusivos não carregam
    /// valor associado: a única porta que vem da sonda é `init(measured:)`, e nenhuma leitura de
    /// papel sai dela com a segunda família.
    func testNenhumaLeituraGravaASegundaFamiliaComoMedida() {
        for leitura in ThermalWifiProbeReading.allCases {
            let gravavel = PrinterWifiConfigurationFamily(
                measured: ThermalWifiProbe.result(for: leitura)
            )
            XCTAssertNotEqual(gravavel, .chosenUsEscUs, "\(leitura) gravaria escolha como medição")
            if let gravavel { XCTAssertTrue(gravavel.wasMeasured) }
        }
    }

    /// Os nomes gravados são os mesmos das duas plataformas: eles vão para o disco, e disco que
    /// diverge entre plataformas é perfil que uma grava e a outra não lê.
    func testOsNomesGravadosSaoOsMesmosDasDuasPlataformas() {
        XCTAssertEqual(
            PrinterWifiConfigurationFamily.allCases.map(\.rawValue),
            ["MEASURED_US_W_HONORED", "MEASURED_US_W_ABSENT", "CHOSEN_US_ESC_US"]
        )
    }

    // MARK: - o custo em papel

    func testOCustoEmPapelNaoDependeDoDesfecho() {
        // Uma tira só, e o preço é o mesmo nos quatro desfechos: o que muda é o que a impressora
        // imprime dentro dela. Sem ramo, a tela anuncia o custo antes de mandar e não erra para
        // menos — que é o erro que a regra proíbe.
        XCTAssertEqual(ThermalWifiProbePaperCost.familyProbe, ThermalWifiProbeParityVectors.paperStrips)
        XCTAssertEqual(ThermalWifiProbePaperCost.minimumStrips, ThermalWifiProbeParityVectors.paperStrips)
        XCTAssertEqual(ThermalWifiProbePaperCost.maximumStrips, ThermalWifiProbeParityVectors.paperStrips)
        XCTAssertEqual(ThermalWifiProbePaperCost.minimumStrips, ThermalWifiProbePaperCost.maximumStrips)
    }

    func testOCustoDestaSondaNaoEntraNaContaDaHomologacao() {
        // A tira não é etapa de homologação: ela sai quando alguém vai configurar a rede, em
        // impressora que pode estar homologada há semanas. Somá-la ali faria toda homologação
        // anunciar um pedaço de papel que ela nunca imprime. As parcelas abaixo são as que
        // `PrinterHomologationPaperCost` declara, e nenhuma delas é esta sonda.
        XCTAssertEqual(
            PrinterHomologationPaperCost.widthRulers
                + PrinterHomologationPaperCost.rasterThroughput
                + PrinterHomologationPaperCost.nativeCode
                + PrinterHomologationPaperCost.codePage
                + PrinterHomologationPaperCost.finalReceipt,
            PrinterHomologationPaperCost.minimumStrips
        )
        XCTAssertEqual(
            PrinterHomologationPaperCost.minimumStrips
                + PrinterHomologationPaperCost.fullGeometry
                + PrinterHomologationPaperCost.cutProtocolStrips
                + PrinterHomologationPaperCost.cutFeedStrips,
            PrinterHomologationPaperCost.maximumStrips
        )
    }

    // MARK: - corpus

    /// Todo resultado que esta camada consegue produzir, inclusive os que nenhuma leitura produz.
    private static func todosOsResultados() -> [ThermalWifiProbeResult] {
        [.usWFamilyHonored, .usWFamilyAbsent]
            + ThermalWifiProbeIndeterminacy.allCases.map { ThermalWifiProbeResult.indeterminate(reason: $0) }
    }

    private static func tira(_ tira: [UInt8], contem agulha: [UInt8]) -> Bool {
        guard !agulha.isEmpty, agulha.count <= tira.count else { return false }
        return (0...(tira.count - agulha.count)).contains { inicio in
            Array(tira[inicio..<(inicio + agulha.count)]) == agulha
        }
    }

    private static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02X", $0) }.joined(separator: " ")
    }
}

/**
 Os vetores fixos da paridade Android–iOS.

 **Estes literais são idênticos aos de `ThermalWifiProbeTest.kt`.** Quem alterar um altera o outro no
 mesmo commit, ou as duas suítes discordam — que é exatamente o que se quer que aconteça quando as
 duas sondas divergirem, porque uma pessoa que responde "saiu A e B" no Android e no iOS tem de estar
 respondendo a mesma pergunta.

 De onde cada bloco veio, e nenhum deles é a saída desta implementação:
 - o par `1F 78` é o que devolveu o bloco na Bematech PP-10W e o que sumiu sem deixar `x` na
   GoldenSky GS-T80C-WF, ambos em 21/08/2026, pela TCP 9100; os marcadores `A` e `B` vêm do degrau 2
   de `docs/goldensky-configuracao-wifi.md`, exercitado em 22/08 — a tira inteira, com os dois
   juntos, é a composição das duas medições, não um envio único que alguém tenha feito;
 - os desfechos 1 e 2 saíram em papel; o 3 é previsto pelo firmware e nunca saiu; o 4 é a tira não
   tendo saído, e ele existe no tipo porque sem marcador ele é indistinguível do 2;
 - a conta do contrato de entrega vem do desmonte do emissor AT (vaddr `0xb2e8`–`0xba00`), com os
   nove comandos e o timeout de 5 s de cada um, em `docs/pp10w-configuracao-wifi.md`.
 */
enum ThermalWifiProbeParityVectors {
    /// `"A\n" + 1F 78 + "\nB\n"` — os sete bytes do comando, mais o avanço de 12 linhas.
    static let usWFamilyStrip: [UInt8] = [0x41, 0x0a, 0x1f, 0x78, 0x0a, 0x42, 0x0a] + Array(repeating: 0x0a, count: 12)

    struct ReadingVector {
        let name: String
        let reading: ThermalWifiProbeReading
        let rawValue: String
        let label: String
        let result: ThermalWifiProbeResult
        let confirmedProtocol: ThermalWifiProtocol?

        init(
            _ name: String,
            _ reading: ThermalWifiProbeReading,
            _ rawValue: String,
            _ label: String,
            _ result: ThermalWifiProbeResult,
            _ confirmedProtocol: ThermalWifiProtocol?
        ) {
            self.name = name
            self.reading = reading
            self.rawValue = rawValue
            self.label = label
            self.result = result
            self.confirmedProtocol = confirmedProtocol
        }
    }

    static let readings: [ReadingVector] = [
        // Desfecho 1, medido na Bematech PP-10W em 21/08/2026: saiu o bloco `Mode: AP` /
        // `SSID: Bematech` / `PWD: OPEN,NONE`, que são literais do firmware da Rongta. É o desfecho
        // que fechou a questão da tabela vendor, porque o `1F 4E` no mesmo dia não produziu nada.
        ReadingVector(
            "bloco entre os marcadores",
            .blockBetweenMarkers,
            "BLOCK_BETWEEN_MARKERS",
            "Saiu A, depois um bloco com Mode, SSID e PWD, depois B.",
            .usWFamilyHonored,
            .usW
        ),
        // Desfecho 2, medido na GoldenSky GS-T80C-WF em 21/08/2026: o texto simples saiu pela mesma
        // 9100 e o `1F 78` sumiu sem deixar `x`. Indeterminado, e não "GoldenSky".
        ReadingVector(
            "só os marcadores",
            .markersOnly,
            "MARKERS_ONLY",
            "Saiu A e saiu B, e nada entre os dois.",
            .indeterminate(reason: .subcommandSwallowed),
            nil
        ),
        // Desfecho 3: o `1F` não foi consumido como prefixo e o `0x78` caiu no buffer de impressão.
        // É o único desfecho que nega a família, e nega porque mostra o byte inteiro no papel.
        ReadingVector(
            "a letra entre os marcadores",
            .letterBetweenMarkers,
            "LETTER_BETWEEN_MARKERS",
            "Saiu A, depois um x sozinho, depois B.",
            .usWFamilyAbsent,
            nil
        ),
        // Desfecho 4: nem o marcador de abertura, que é texto puro. Não é resposta sobre a família.
        ReadingVector(
            "papel em branco",
            .nothingPrinted,
            "NOTHING_PRINTED",
            "Não saiu nada, nem o A.",
            .indeterminate(reason: .probeDidNotPrint),
            nil
        ),
    ]

    /// As frases de indeterminação, na ordem dos casos.
    static let indeterminacyMessages = [
        "O comando sumiu sem deixar marca no papel. Qualquer impressora que engula o prefixo faz isso, então isto não identifica a família.",
        "A tira não saiu. Confira papel e conexão e mande de novo: isto não é resposta sobre a impressora.",
    ]

    /// O contrato de entrega, declarado igual nas duas plataformas.
    static let readsResponseBytes = false
    static let dropsDeliveringConnection = true
    static let writesConfiguration = false
    static let atCommandCount = 9
    static let atCommandTimeoutSeconds = 5
    static let worstCasePortOutageSeconds = 45

    /// Uma tira, nos quatro desfechos.
    static let paperStrips = 1
}
