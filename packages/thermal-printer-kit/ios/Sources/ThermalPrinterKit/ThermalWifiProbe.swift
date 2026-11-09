import Foundation

/**
 O que a pessoa viu no papel depois da tira da sonda de família.

 **É a leitura, não a conclusão** — o mesmo padrão de ``PrinterHomologationResponse``, onde quem está
 na frente da impressora responde o que saiu e a conta é da máquina. Aqui a diferença pesa mais que
 nas outras sondas: a pergunta "é uma Rongta?" seria respondida pela caixa, pelo rótulo ou pelo
 palpite de quem vende, e foi exatamente o catálogo por modelo que este projeto decidiu não fazer.
 Medido em 21/08/2026: por catálogo alguém poria a GoldenSky GS-T80C-WF na lista por ser "Wi-Fi com
 9100", e o `1F 77` iria para uma impressora que não o entende.

 **São quatro casos, e eles não têm a mesma procedência** — a lista é fechada, mas honesta sobre
 isso. Dois saíram em papel na bancada de 21/08/2026: o bloco de configuração na Bematech PP-10W, e
 o silêncio na GoldenSky GS-T80C-WF. O terceiro, a letra solta, é **previsto pelo firmware** e ainda
 não saiu em impressora nenhuma daqui: a comparação `cmp r4,#0x20 / bhs` joga todo byte ≥ 0x20 no
 buffer de impressão, então um `1F` não reconhecido deixaria o `0x78` virar texto. O quarto é a tira
 não tendo saído, e ele existe aqui justamente para não ser confundido com o segundo — sem marcador,
 os dois são indistinguíveis, e foi essa confusão que custou meia hora de bancada em 21/08.

 Espelho literal de `ThermalWifiProbeReading` em `ThermalWifiProbe.kt`.
 */
public enum ThermalWifiProbeReading: String, CaseIterable, Sendable {
    /// Saiu o marcador de abertura, o bloco `Mode:` / `SSID:` / `PWD:`, e o marcador de fecho.
    ///
    /// Medido na Bematech PP-10W em 21/08/2026, por TCP 9100 a partir de um iPhone.
    case blockBetweenMarkers = "BLOCK_BETWEEN_MARKERS"

    /// Saíram os dois marcadores, e nada entre eles.
    ///
    /// Medido na GoldenSky GS-T80C-WF em 21/08/2026: o texto simples saiu e o `1F 78` sumiu sem
    /// deixar rastro. **Isto não é a assinatura da GoldenSky** — é a assinatura de qualquer firmware
    /// que consuma o byte seguinte ao `1F`, e a própria PP-10W faz o mesmo com `1F 4E`, que nem
    /// existe na tabela dela.
    case markersOnly = "MARKERS_ONLY"

    /// Saiu o marcador de abertura, uma letra solta, e o marcador de fecho.
    ///
    /// A letra é o próprio `0x78` virando texto — ver
    /// ``ThermalWifiProbe/unrecognizedSubcommandLetter``. Quem imprime a letra não reconheceu o `1F`
    /// nem como prefixo.
    case letterBetweenMarkers = "LETTER_BETWEEN_MARKERS"

    /// Não saiu nada, nem o marcador de abertura.
    ///
    /// **Não é resposta sobre a família.** O marcador é texto puro, que toda impressora desta
    /// bancada imprime pela 9100; se ele não saiu, o que faltou foram os bytes chegarem — ou o papel.
    case nothingPrinted = "NOTHING_PRINTED"

    /// A frase que descreve esta leitura, para quem está com a tira na mão escolher.
    ///
    /// **Mora no kit pela mesma razão que as frases de ``ThermalWifiRejection``:** a leitura é a
    /// medição, e uma medição que muda de palavra entre Android e iOS é uma medição diferente. Os
    /// marcadores entram por interpolação, e não por literal, para a frase nunca descrever uma tira
    /// que a sonda não emite.
    public var label: String {
        let abre = ThermalWifiProbe.openingMarker
        let fecha = ThermalWifiProbe.closingMarker
        switch self {
        case .blockBetweenMarkers:
            return "Saiu \(abre), depois um bloco com Mode, SSID e PWD, depois \(fecha)."
        case .markersOnly:
            return "Saiu \(abre) e saiu \(fecha), e nada entre os dois."
        case .letterBetweenMarkers:
            return "Saiu \(abre), depois um \(ThermalWifiProbe.unrecognizedSubcommandLetter) sozinho, depois \(fecha)."
        case .nothingPrinted:
            return "Não saiu nada, nem o \(abre)."
        }
    }
}

/**
 Por que a sonda não concluiu nada, quando não conclui.

 **Os dois casos são coisas diferentes, e nenhum dos dois autoriza configurar.** Um diz que a
 impressora recebeu os bytes e engoliu o comando; o outro diz que a tira não saiu, e portanto que
 ninguém mediu coisa alguma. Colapsar os dois em "família ausente" seria transformar falta de medição
 em medição — e o preço de errar aqui é mandar `1F 77` para uma impressora que não o entende, ou não
 mandar para uma que entende.

 Espelho literal de `ThermalWifiProbeIndeterminacy` em `ThermalWifiProbe.kt`.
 */
public enum ThermalWifiProbeIndeterminacy: String, CaseIterable, Sendable {
    /// Os marcadores saíram e o comando sumiu no meio.
    ///
    /// A GoldenSky faz isso porque o cabeçalho dela é `1F 1B 1F` e o parser descarta o par ao ver um
    /// `78` onde esperava `1B`. Só que **não é só ela**: a PP-10W engoliu `1F 4E` do mesmo jeito em
    /// 21/08/2026, e o `4E` nem está na tabela vendor dela. Um comando engolido prova que o `1F` é
    /// prefixo de alguma coisa, e nada além disso.
    case subcommandSwallowed = "SUBCOMMAND_SWALLOWED"

    /// A tira não saiu.
    ///
    /// Não há o que concluir de papel em branco: nem os marcadores, que são texto puro, chegaram.
    case probeDidNotPrint = "PROBE_DID_NOT_PRINT"

    /// O que dizer a quem mediu — sempre incluindo por que isto **não** é uma resposta.
    public var message: String {
        switch self {
        case .subcommandSwallowed:
            return "O comando sumiu sem deixar marca no papel. Qualquer impressora que engula o prefixo faz isso, então isto não identifica a família."
        case .probeDidNotPrint:
            return "A tira não saiu. Confira papel e conexão e mande de novo: isto não é resposta sobre a impressora."
        }
    }
}

/**
 O que a tira mediu sobre a família `1F 77`.

 **A sonda só fala de uma família, de propósito.** Não existe caso ``ThermalWifiProtocol/usEscUs``
 aqui, e não é omissão: nenhuma leitura de papel distingue a GoldenSky de uma impressora qualquer que
 engula o `1F`, e a única maneira de "confirmá-la" seria escrever o quadro dela ou travar o parser à
 espera dos NUL — foi o que a bancada fez de propósito em 22/08/2026, com um `B3` não terminado que
 deixou a impressora esperando. Instrumento que precisa quebrar a impressora para medir não é sonda.
 **A GoldenSky é escolha explícita da pessoa**, e por isso ela não pode ser um desfecho deste tipo nem
 por engano de construção do chamador — os casos conclusivos não carregam valor associado.

 Espelho literal de `ThermalWifiProbeResult` em `ThermalWifiProbe.kt`.
 */
public enum ThermalWifiProbeResult: Equatable, Sendable {
    /// A família `1F 77` é honrada: o `1F 78` produziu o efeito documentado, no papel.
    case usWFamilyHonored
    /// A família `1F 77` não existe nesta impressora: o `1F` não foi reconhecido nem como prefixo.
    case usWFamilyAbsent
    /// Não dá para dizer. Ver ``ThermalWifiProbeIndeterminacy``.
    case indeterminate(reason: ThermalWifiProbeIndeterminacy)

    /// A família que esta sonda confirmou, ou `nil` enquanto ela não confirmou nenhuma.
    ///
    /// É o encaixe com ``ThermalWifiFrame``: quem tem isto não-nulo tem a família cujo quadro pode
    /// montar. `nil` cobre os três outros desfechos de uma vez, porque nenhum deles é permissão.
    public var confirmedProtocol: ThermalWifiProtocol? {
        self == .usWFamilyHonored ? .usW : nil
    }

    /// Se esta medição autoriza montar e enviar quadro de configuração.
    ///
    /// **Derivado de ``confirmedProtocol``, e não escrito à parte**, para não existir estado em que
    /// um diga sim e o outro não: sem família confirmada não há quadro a montar, e com família
    /// confirmada há exatamente um.
    public var authorizesConfiguration: Bool { confirmedProtocol != nil }

    /// O motivo da dúvida, ou `nil` quando a sonda concluiu.
    ///
    /// Atalho no molde de ``ThermalWifiValidation/rejection``: sem ele, todo chamador escreveria o
    /// mesmo `if case` à mão, e um deles escreveria errado.
    public var indeterminacy: ThermalWifiProbeIndeterminacy? {
        if case .indeterminate(let reason) = self { return reason }
        return nil
    }
}

/**
 A família de configuração Wi-Fi desta impressora, **do jeito que ela sobrevive ao disco**.

 **Não é ``ThermalWifiProbeResult``, e a diferença é o ponto.** Aquele tipo tem quatro desfechos e um
 deles carrega o indeterminado; espelhá-lo aqui tornaria "não saiu nada" e "os marcadores saíram sem
 o bloco" **representáveis em disco**, e um perfil gravado assim afirmaria medição onde não houve
 nenhuma. O indeterminado não é resposta sobre a impressora: é a ausência de resposta, e a ausência
 já tem forma — `nil`, que é o que todo perfil gravado antes deste campo devolve.

 **Os três casos registram COMO o valor foi determinado, e não só qual é a família.** São duas
 procedências diferentes, e colapsá-las faria uma sessão futura acreditar que houve medição onde
 houve escolha:

 - ``measuredUsWHonored`` e ``measuredUsWAbsent`` saíram da tira: a pessoa leu o papel e
   ``ThermalWifiProbe/result(for:)`` concluiu. São medição.
 - ``chosenUsEscUs`` saiu da pessoa. Não existe sonda que confirme aquela família — os 28 comandos
   dela são escrita persistente, nenhum lê e nenhum imprime —, então quem a escolhe **declara**.

 **A negativa é persistida junto, e de propósito.** Ela custou uma tira de papel, e sem ela a tela
 reoferece a sonda a quem já respondeu. O que ela nega é a família `1F 77`; o que ela **não** diz é
 qual é a família da impressora, e por isso ``configuredProtocol`` é `nil` nela.

 **Sem caminho de construção que aceite o indeterminado**, na mesma disciplina que faz os desfechos
 conclusivos de ``ThermalWifiProbeResult`` não carregarem valor associado: ``init(measured:)`` é
 falível, e é a única porta que vem da sonda.

 **Fora da `capabilityKey`**, como ``PrinterCapabilities/cutModeHonored``: ela é identidade de
 capacidade, e duas impressoras com as mesmas capacidades têm de compartilhar chave. Este campo não
 altera um único byte de cupom — decide qual quadro a tela de configuração monta, e quadro de
 configuração não é cupom.

 Espelho literal de `PrinterWifiConfigurationFamily` em `ThermalWifiProbe.kt`.
 */
public enum PrinterWifiConfigurationFamily: String, Codable, CaseIterable, Sendable {
    /// Medido: a tira saiu com o bloco entre os marcadores, e a família `1F 77` é honrada.
    case measuredUsWHonored = "MEASURED_US_W_HONORED"

    /// Medido: a tira saiu com a letra solta, e a impressora **nega** a família `1F 77`.
    ///
    /// Informação cara e conclusiva; não diz qual é a família desta impressora, só qual não é.
    case measuredUsWAbsent = "MEASURED_US_W_ABSENT"

    /// Escolhido pela pessoa: `1F 1B 1F`. Nenhuma tira confirma esta família, e este caso não
    /// finge que alguma confirmou.
    case chosenUsEscUs = "CHOSEN_US_ESC_US"

    /// A medição que sobrevive ao disco, ou `nil` quando a sonda não mediu nada.
    ///
    /// O indeterminado devolve `nil` porque gravá-lo seria gravar a ausência de medição — e o
    /// chamador que receber `nil` não tem o que persistir, em vez de ter um caso a persistir.
    public init?(measured result: ThermalWifiProbeResult) {
        switch result {
        case .usWFamilyHonored: self = .measuredUsWHonored
        case .usWFamilyAbsent: self = .measuredUsWAbsent
        case .indeterminate: return nil
        }
    }

    /// A família cujo quadro pode ser montado, ou `nil` quando o valor gravado não autoriza
    /// nenhum.
    ///
    /// Molde de ``ThermalWifiProbeResult/confirmedProtocol``: derivado num lugar só, para não
    /// existir estado em que um diga sim e o outro não.
    public var configuredProtocol: ThermalWifiProtocol? {
        switch self {
        case .measuredUsWHonored: return .usW
        case .chosenUsEscUs: return .usEscUs
        case .measuredUsWAbsent: return nil
        }
    }

    /// Se este valor veio de papel. `false` diz que veio da pessoa — e é essa diferença que o
    /// campo existe para carregar até o disco.
    public var wasMeasured: Bool { self != .chosenUsEscUs }
}

/**
 O custo em papel da sonda de família, contado da tira em vez de escrito à mão na tela.

 Segue o molde de ``PrinterHomologationPaperCost``, e pela mesma razão: escrito na tela o número
 divergiu entre as plataformas e ficou parado enquanto as sondas mudavam. Quem sabe quanto papel sai
 é quem monta a tira.

 **Fica fora da conta da homologação, de propósito.** Lá as parcelas somam o que uma homologação
 inteira gasta e são anunciadas antes de começar; esta tira sai quando alguém vai configurar a rede,
 em impressora que pode estar homologada há semanas. Somá-la em
 ``PrinterHomologationPaperCost/minimumStrips`` faria toda homologação anunciar um pedaço de papel
 que ela nunca imprime.

 **Não existe sonda de custo zero para esta pergunta.** O `1F 76` responde por bytes, e o painel de
 comando cru do kit não lê de volta — lacuna nomeada em `docs/pp10w-configuracao-wifi.md`. Enquanto
 não houver caminho de leitura, a única sonda que existe é a que imprime.

 Espelho literal de `ThermalWifiProbePaperCost` em `ThermalWifiProbe.kt`.
 */
public enum ThermalWifiProbePaperCost {
    /// A tira da sonda: os dois marcadores e o que a impressora fizer entre eles, num envio só.
    public static let familyProbe = 1

    /// **Os quatro desfechos custam a mesma tira**, e é isso que estas duas constantes iguais dizem.
    /// O que muda entre eles é o que a impressora imprime dentro da tira, não quantas saem — então a
    /// tela pode anunciar o preço antes de mandar, sem ramo e sem "de X a Y".
    public static var minimumStrips: Int { familyProbe }

    /// Ver ``minimumStrips``.
    public static var maximumStrips: Int { familyProbe }
}

/**
 A sonda que descobre **pelo papel** se a impressora honra a família `1F 77`.

 A tira é `"A\n" + 1F 78 + "\nB\n"`, e cada pedaço dela tem uma medição atrás:

 - **`1F 78` é o único subcomando `1F` da Rongta com efeito visível que não grava nada.** Ele
   reimprime da flash o bloco `Mode:` / `SSID:` / `PWD:` e re-executa o mesmo emissor AT que o
   `1F 77` usa. Foi ele que fechou a questão em 21/08/2026: o `1F 78` produziu o bloco e o `1F 4E`
   — que não existe na tabela — não produziu nada, e é essa discriminação que prova que a tabela é
   real.
 - **Os marcadores existem porque "não saiu nada" é ambíguo.** Sem eles não há como separar "o
   comando foi engolido" de "a impressora não recebeu bytes", e essa ambiguidade custou meia hora de
   bancada em 21/08/2026 — o `1F 76` e o `1F 4E` deram papel em branco idêntico e quase sustentaram a
   conclusão errada.

 **A sonda derruba a própria conexão que a entregou.** O `1F 78` re-executa o emissor AT, que tira o
 módulo Wi-Fi do modo transparente — e é o transparente que faz a porta 9100 existir. Medido em
 21/08/2026: depois de um `1F 78` bem-sucedido, os comandos seguintes foram para um socket morto e
 nunca chegaram. Quem chamar **não espera resposta**, toma o papel como comprovante, e reconecta
 antes do próximo comando. Ver ``readsResponseBytes`` e ``dropsDeliveringConnection``.

 Esta camada é pura: não conhece socket, não escolhe destino, não lê resposta e não persiste nada.
 Espelho literal de `ThermalWifiProbe.kt`; quem mexer numa regra aqui mexe nas duas, e a suíte de
 paridade existe para gritar quando isso não acontecer.
 */
public enum ThermalWifiProbe {
    // MARK: - a tira

    /// Abre a tira. É texto puro: se ele não sair, o que faltou foram os bytes, não a família.
    public static let openingMarker: Character = "A"

    /// Fecha a tira. Sem ele, "saiu só o `A`" e "saiu o `A` e o resto ainda vem" são a mesma coisa
    /// para quem está olhando o papel.
    public static let closingMarker: Character = "B"

    /**
     A tira inteira, `41 0A 1F 78 0A 42 0A` — `A`, o comando, e `B`, cada um na sua linha.

     **A quebra antes do `B` não é enfeite.** Sem ela, quando o `1F` não é reconhecido, o `0x78`
     cai no buffer de impressão, o `0x42` cai atrás e a linha sai como `xB` — e o rótulo que a
     pessoa escolhe prometeria um `x` sozinho que nunca apareceria. É a tira que a bancada de
     22/08 exercitou de fato.

     **Vai numa escrita só, e a garantia aqui não é a do `1F 77`.** Este subcomando é a entrada
     `x` da tabela US, com `nparam = 0`: ele não lê campo variável nenhum, então não há o parser
     travado do handler `'w'` (vaddr `0x83a6`, timeout `−1`). São sete bytes, cabem em qualquer
     bloco, e a escrita única é hábito da família, não requisito deste comando.

     **Esta tira derruba a conexão que a entregou.** O `1F 78` re-executa o emissor AT, que tira o
     módulo do modo transparente — e é o transparente que faz a porta 9100 existir. Medido em
     21/08: depois de um `1F 78` bem-sucedido, os comandos seguintes foram para um socket morto.
     Não espere resposta: **o comprovante é o papel.** Ver ``dropsDeliveringConnection``.

     **Não há variação nem parâmetro.** Um seletor de subcomando aqui seria o caminho para pedir
     `1F 77` (grava), `1F 6D` (troca o MAC) ou `1F 69` (IP fixo) por argumento — a mesma porta que
     ``ThermalWifiFrame`` fechou ao manter os opcodes privados.

     É um `let` de `Data`, que tem semântica de valor: quem recebe a tira recebe uma cópia e não tem
     como editar a próxima. No gêmeo, onde `ByteArray` é mutável, o mesmo contrato exige devolver
     array novo a cada leitura — mesma garantia, formas diferentes.
     */
    public static let usWFamilyStrip: Data = {
        var strip = markerLine(openingMarker)
        strip.append(vendorPrefix)
        strip.append(reprintSubcommand)
        strip.append(lineFeed)
        strip.append(markerLine(closingMarker))
        // Sem este avanço o marcador de fecho fica **dentro** da impressora, entre a cabeça e a
        // serrilha, e a pessoa não consegue responder "saiu o B?" porque não vê o B. Medido na
        // Bematech PP-10W em 23/08. É o mesmo defeito que a homologação já tinha resolvido — daí
        // reusar a medida dela em vez de inventar outra.
        strip.append(Data(repeating: lineFeed, count: Int(tearFeedLines)))
        return strip
    }()

    /// A letra que aparece no papel quando o `1F` não é reconhecido nem como prefixo: o próprio
    /// `0x78` caindo no buffer de impressão como texto.
    ///
    /// **Derivada do byte, e não digitada**, porque ela é o byte. Se o subcomando um dia mudar, a
    /// frase que a pessoa lê muda junto, em vez de passar a descrever uma tira que não existe.
    public static let unrecognizedSubcommandLetter = Character(UnicodeScalar(reprintSubcommand))

    // MARK: - a derivação

    /**
     Da leitura para o resultado.

     Os três primeiros desfechos foram medidos em papel em 21/08/2026; o quarto é o que sobra quando
     a tira não sai. O `switch` é exaustivo sobre um enum fechado: leitura nova para de compilar aqui
     até alguém dizer o que ela significa.
     */
    public static func result(for reading: ThermalWifiProbeReading) -> ThermalWifiProbeResult {
        switch reading {
        case .blockBetweenMarkers:
            // O bloco só pode ter vindo do handler `1F 78`: nada mais na tira imprime `Mode:` /
            // `SSID:` / `PWD:`, e esses três rótulos são literais do firmware da Rongta. Medido na
            // Bematech PP-10W.
            return .usWFamilyHonored
        case .letterBetweenMarkers:
            // A letra é o `0x78` impresso como texto: o `1F` não foi consumido como prefixo, então
            // não existe tabela vendor lendo o byte seguinte. É o único desfecho que **nega** a
            // família, e nega porque mostra o byte inteiro no papel.
            return .usWFamilyAbsent
        case .markersOnly:
            // Os bytes chegaram — os marcadores provam — e o par `1F 78` sumiu. Isso prova que algo
            // consumiu o `1F`, e só. Medido na GoldenSky GS-T80C-WF, mas a própria PP-10W faz
            // idêntico com `1F 4E`: concluir "GoldenSky" aqui seria catálogo disfarçado de medição.
            return .indeterminate(reason: .subcommandSwallowed)
        case .nothingPrinted:
            // Nem o marcador de abertura saiu, e ele é texto puro que toda impressora desta bancada
            // imprime pela 9100. Papel em branco não fala sobre a tabela vendor: fala sobre os bytes
            // não terem chegado. Virar "família ausente" aqui gravaria uma medição que não houve.
            return .indeterminate(reason: .probeDidNotPrint)
        }
    }

    // MARK: - o contrato de entrega

    /// A sonda **não** lê resposta. O comprovante é o papel, que sai antes de a conexão cair.
    ///
    /// O painel de comando cru do kit não lê o caminho de volta (`PrinterProbeSendResult` só tem
    /// `.success` e `.failure`), e mesmo que lesse não haveria o que ler: o `1F 78` responde em
    /// papel, não em bytes.
    public static let readsResponseBytes = false

    /// **A sonda mata a conexão que a entregou.** Quem chama tem de tolerar a queda e reconectar
    /// antes do próximo comando; um `.failure` de socket logo depois do envio não significa que a
    /// tira não saiu.
    ///
    /// A Wi-Fi não cai: o que some é o túnel transparente que faz a 9100 existir, enquanto o MCU
    /// conversa AT com o módulo. Medido em 21/08/2026, quando os comandos seguintes a um `1F 78`
    /// bem-sucedido foram para um socket morto.
    public static let dropsDeliveringConnection = true

    /// A sonda não grava configuração — mas **não é inerte**, e o contrato não pode fingir que é.
    ///
    /// O `1F 78` zera três flags que ninguém identificou e, se a configuração tiver mudado, o
    /// emissor AT pode terminar num `AT+Z` que reinicia o módulo. O `AT+Z` é condicional
    /// (`0xbcb2: cbz r4`), e com a configuração inalterada nada é reescrito e nada reinicia — medido
    /// em 21/08/2026, com a impressora de pé e o AP no ar depois da sonda.
    public static let writesConfiguration = false

    /// Quantos comandos o emissor AT dispara enquanto a 9100 está fora do ar (vaddr
    /// `0xb2e8`–`0xba00`): `AT+E`, `AT+UART`, `AT+WMODE`, `AT+WANN`, `AT+WSMAC`, `AT+WSLK`,
    /// `AT+NETP`, `AT+WSSSID`, `AT+WSKEY`.
    public static let atCommandCount = 9

    /// O timeout de cada um deles, em segundos.
    public static let atCommandTimeoutSeconds = 5

    /// O pior caso em que a porta 9100 fica fora do ar, em segundos.
    ///
    /// **É aritmética dos dois números acima, e não uma medida de cronômetro** — por isso ela sai da
    /// conta e não de um literal: ninguém mediu a janela real, e um literal aqui viraria "fato" no
    /// primeiro comentário que o copiasse. Na prática cada comando responde muito antes do timeout,
    /// e no fim o `AT+ENTM` devolve o modo transparente.
    public static var worstCasePortOutageSeconds: Int { atCommandCount * atCommandTimeoutSeconds }

    // MARK: - régua interna

    /// `1F` — o prefixo vendor. Vem daqui, e não de ``ThermalWifiProtocol/headerBytes``, porque lá o
    /// par é `1F 77`, que grava a flash; a sonda existe justamente para não ser aquele par.
    private static let vendorPrefix: UInt8 = 0x1f

    /// `78` — reimprime da flash o bloco de configuração e re-executa o emissor AT.
    ///
    /// **Privado, como os opcodes de ``ThermalWifiFrame``.** Publicado, ele seria meio comando pronto
    /// para o fio, e a outra metade a pessoa completa: `1F` mais qualquer byte já é uma entrada da
    /// lista de "bytes que NUNCA devem ser enviados" dos dois documentos de bancada.
    private static let reprintSubcommand: UInt8 = 0x78

    /// Avanço final, para o marcador de fecho sair de dentro da impressora.
    ///
    /// Mesmo valor e mesma razão de `probeTearFeedLines` das sondas de homologação: a distância
    /// entre a cabeça e a serrilha engole as últimas linhas, e 12 é o maior avanço que o próprio
    /// kit aceita como medida de corte — o único que garante a última linha do lado de fora em
    /// toda impressora já suportada.
    public static let tearFeedLines: UInt8 = 12

    private static let lineFeed: UInt8 = 0x0a

    /// O marcador e o avanço que o separa do que vem depois.
    ///
    /// Sem o `\n` os marcadores e o bloco sairiam na mesma linha, e "o que veio entre A e B" — que é
    /// toda a leitura — deixaria de ser uma pergunta com resposta visual.
    private static func markerLine(_ marker: Character) -> Data {
        // A faixa é escrita aqui, e não lida de ``ThermalWifiFrame``: lá ela vale para SSID e senha,
        // que são outra regra com o mesmo número. Compartilhar a constante faria uma mudança na
        // faixa de campo mexer, em silêncio, no que a sonda aceita como marcador.
        guard let byte = marker.asciiValue, (0x20...0x7e).contains(byte) else {
            preconditionFailure("Marcador fora do ASCII: a tira sai sem `ESC t` e nenhuma página está medida ainda.")
        }
        return Data([byte, lineFeed])
    }
}
