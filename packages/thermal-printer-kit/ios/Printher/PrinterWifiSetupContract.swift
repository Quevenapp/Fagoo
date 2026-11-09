import Foundation
import ThermalPrinterKit

/*
 Gêmeo de `printher/src/main/java/br/com/thermalprinterkit/printher/PrinterWifiSetupContract.kt`.

 Molde de `PrinterUnitAvailability`: os nomes de tipo e de função são os **mesmos** dos dois lados,
 e a forma muda só onde a linguagem obriga — `enum` com valor associado aqui, `sealed interface`
 lá. Quem mexer numa regra mexe nas duas.

 **Este docblock existe porque a divergência já aconteceu.** As duas telas foram escritas em
 paralelo, uma por plataforma, e divergiram no fluxo — não só nas palavras: máquinas de estado
 diferentes, regras diferentes para abrir a pergunta do papel, e uma frase afirmando a saída da
 tira antes de perguntar o que saiu. Cada lado fixou a própria divergência por literal na própria
 suíte, e as duas passavam verdes discordando. Nada prendia um contrato ao outro; agora prende
 isto, mais os literais compartilhados fixados nas duas suítes.

 **Toda frase de tela mora aqui, e nenhuma na View.** Frase escrita dentro do `body` fica fora do
 alcance das afirmações de segurança — a proibição de marca e opcode e a checagem de vazamento de
 senha varrem `todasAsFrasesDaTela`, e o que não desce até aqui não é varrido. Foi assim que doze
 linhas da tela ficaram sem cobertura nenhuma.
 */

/**
 Onde a configuração de rede está, dos quatro passos que ela tem.

 Mora fora da View pela razão de sempre nesta superfície — ``PrinterUnitAvailability``,
 ``PrinterManualAddress``, ``PrinterHomologationUIContract``: a decisão de qual formulário abrir é
 afirmável sem tela, e escrita dentro do `body` ela só seria afirmável com aparelho.

 **É estado de sessão, e não uma função do alvo.** O passo não pode ser derivado do alvo, e este é
 o ponto em que o Android divergia: lá `TARGET` era "não há alvo" e o passo voltava para ele a cada
 perda de alvo. Só que **a queda pós-escrita é o caminho normal desta tela** — a tira e o quadro
 derrubam a conexão que os entregou —, e derrubar o alvo junto apagava a pergunta das quatro
 leituras e o formulário digitado exatamente depois de os bytes saírem. Aqui perder o alvo fecha o
 botão e mostra a frase do alvo; não desfaz o que a pessoa já respondeu.

 **O passo `target` não é enfeite de abertura.** Ele é onde a tela diz por onde os bytes vão sair,
 ou o que falta para saírem; sem ele, "não aconteceu nada" seria a única resposta de quem não tem
 impressora alcançável.
 */
enum PrinterWifiSetupStage: Equatable {
    /// Antes da tira. A tela mostra o alvo, o custo em papel e o que vai acontecer.
    case target

    /// A tira foi mandada e a escrita começou. A leitura vem da pessoa olhando o papel, e de mais
    /// nada. Ver ``PrinterWifiDispatch/advancesToReading``.
    case reading

    /// A leitura chegou e não abriu formulário nenhum. Resta mandar a tira de novo, responder de
    /// novo, ou escolher à mão o formato que nenhuma tira confirma.
    case choice(ThermalWifiProbeResult)

    /// O formato está definido — pela tira ou pela pessoa — e o formulário é o dele.
    case form(ThermalWifiProtocol)
}

/**
 Por onde a tira e o quadro saem, ou o que falta para saírem.

 **O motivo e a permissão são o mesmo valor**, que é a forma de `printingUnavailableReason`
 (ThermalPrinterView.swift): não existe estado em que um diga sim e o outro não. Aqui ele é um enum
 em vez de um `String?` porque os dois casos que **podem** também têm o que dizer — por onde os
 bytes vão sair não é a mesma informação que "podem sair" —, e a tela mostra a frase nos quatro.

 **São quatro, e não dois, pela regra do AGENTS.md de não maquiar um motivo com o outro.** "Nunca
 houve impressora" e "há impressora instalada que não recebe agora" mandam a pessoa a lugares
 diferentes; uma frase só para os dois manda procurar no lugar errado.

 **O quarto caso é um só de propósito, e as duas plataformas medem metade dele cada uma.** O iOS
 sabe dizer "instalada e inalcançável" (``ThermalPrinterConfiguration/canSendEphemeralCommand``
 confere estado e rede); o Android sabe dizer "instalada e não marcada em uso" (o `active` do
 store). Nenhum dos dois sabe dizer o do outro, e inventar o eixo que falta seria medir o silêncio.
 Então o caso é o fato que os dois medem — **há impressora instalada e nenhuma delas recebe envio
 agora** — e a frase nomeia os dois gestos que resolvem, porque a tela honestamente não sabe qual
 dos dois falta.

 **A frase nunca nomeia a unidade.** `displayName` é exatamente onde marca e modelo moram (AGENTS.md,
 contratos do M2), e o Android interpolava `displayName` aqui: a frase podia conter o nome do
 fabricante por construção, e o teste que proíbe marca só passava porque a fixture se chamava
 "Balcão".
 */
enum PrinterWifiSetupTarget: Equatable {
    /// Há candidata retida em memória; é por ela que tudo sai.
    case ephemeralCandidate
    /// Sem candidata, mas a impressora instalada recebe os envios — é a queda que o
    /// `fallingBackToAdopted` pede, e é o público inteiro desta tela.
    case adoptedPrinter
    /// Nunca houve impressora neste aparelho.
    case noPrinter
    /// Há impressora instalada, e nenhuma delas recebe envio agora.
    case adoptedUnavailable

    var allowsSending: Bool {
        switch self {
        case .ephemeralCandidate, .adoptedPrinter: return true
        case .noPrinter, .adoptedUnavailable: return false
        }
    }
}

/**
 O que aconteceu com os bytes, do ponto de vista de quem está olhando a tela.

 **Este tipo tem três casos e nenhum deles é "deu certo".** Tanto a tira quanto o quadro rodam o
 emissor AT do módulo, e o emissor AT derruba o modo transparente — ou seja, os dois **matam a
 conexão que os entregou** (``ThermalWifiProbe/dropsDeliveringConnection``). Uma falha de transporte
 logo depois da escrita é o caminho normal, não um defeito, e tratá-la como falha faria a tela pedir
 reenvio de um quadro que já gravou.

 O que separa os casos é o que o kit já sabe distinguir, e que esta tela deixava cair no chão: a
 divisão de ``ThermalPrintDelivery``, publicada por ``PrinterProbeFailure``. Antes da primeira
 escrita nada saiu e reenviar é seguro; depois dela, o desfecho está no papel e mais lugar nenhum.

 **`noTarget` é separado, e não é "a conexão caiu".** Sem remetente algum nenhum byte saiu do
 telefone, e o agregado diz isso de duas formas ao mesmo tempo: `sendEphemeralCommand` devolve
 `false` e o callback traz ``PrinterProbeFailure/rejected``. Colapsar isso em "a conexão caiu" é a
 mesma classe de erro de 21/08/2026, com socket morto tratado como falha da sonda — agora ao
 contrário: ausência de remetente tratada como queda. Pior no caminho da tira, onde a tela ainda
 perguntaria "o que saiu no papel?" sem papel nenhum.
 */
enum PrinterWifiDispatch: Equatable {
    /// Não havia alvo. Nada foi para o fio, e a tela repete o motivo de quatro casos.
    case noTarget

    /// A escrita não começou. Nada chegou à impressora, e mandar de novo é seguro.
    case notSent

    /// A escrita começou. O que aconteceu depois disso está no papel, e a tela não sabe.
    case reachedPrinter

    /// Só o despacho que chegou à impressora abre a pergunta da leitura.
    ///
    /// Se nada saiu do telefone não há papel sobre o que perguntar, e perguntar assim mesmo
    /// convidaria a responder "não saiu nada" — que é a leitura de uma tira que nunca foi mandada,
    /// e viraria medição inventada.
    var advancesToReading: Bool { self == .reachedPrinter }
}

/**
 Os sete ramos de segurança da família que a tira confirma, no vocabulário do roteador.

 **Existe porque ``ThermalWifiSecurity`` não é lista, é gramática**: lá os sete ramos nascem de
 casos com valor associado, e um seletor de tela precisa de sete opções lado a lado. A conversão é
 nesta direção só — de escolha para segurança —, e nunca por índice: os dez valores de
 ``ThermalWifiKeyType`` da outra família moram noutro seletor, e mapear um no outro por posição é a
 armadilha que os dois docblocks do kit nomeiam.

 Nenhum caso carrega senha. A senha entra na conversão e sai no quadro; ela não fica guardada em
 nenhum agregado desta tela, para não haver `description` sintetizado que a publique.
 */
enum PrinterWifiSecurityChoice: String, CaseIterable, Equatable {
    case open = "OPEN"
    case wepOpen = "WEP_OPEN"
    case wepShared = "WEP_SHARED"
    case wpaTKIP = "WPA_TKIP"
    case wpaAES = "WPA_AES"
    case wpa2TKIP = "WPA2_TKIP"
    case wpa2AES = "WPA2_AES"

    /// Rótulos do roteador, que é onde a pessoa lê isto — não do firmware.
    var label: String {
        switch self {
        case .open: return "Rede aberta, sem senha"
        case .wepOpen: return "WEP com autenticação aberta"
        case .wepShared: return "WEP com chave compartilhada"
        case .wpaTKIP: return "WPA (TKIP)"
        case .wpaAES: return "WPA (AES)"
        case .wpa2TKIP: return "WPA2 (TKIP)"
        case .wpa2AES: return "WPA2 (AES)"
        }
    }

    /// Se este ramo tem onde guardar uma senha. No ramo aberto o quadro colapsa os três bytes em
    /// zeros e não há campo nenhum — por isso a tela esconde o campo em vez de recusá-lo depois.
    var requiresPassword: Bool { self != .open }

    func security(password: String) -> ThermalWifiSecurity {
        switch self {
        case .open: return .open
        case .wepOpen: return .wepOpen(password: password)
        case .wepShared: return .wepShared(password: password)
        case .wpaTKIP: return .wpaPSK(cipher: .noneTKIP, password: password)
        case .wpaAES: return .wpaPSK(cipher: .wepAES, password: password)
        case .wpa2TKIP: return .wpa2PSK(cipher: .noneTKIP, password: password)
        case .wpa2AES: return .wpa2PSK(cipher: .wepAES, password: password)
        }
    }
}

/**
 Tudo o que esta tela decide sem tela.

 Frase do kit não é reescrita aqui — ``ThermalWifiProbeReading/label``,
 ``ThermalWifiProbeIndeterminacy/message`` e ``ThermalWifiRejection/message`` vêm prontas e passam
 inteiras. O que este tipo escreve é o que só a tela sabe: por onde os bytes saem, o que a pessoa
 perde ao gravar, e onde procurar o comprovante quando a impressora não imprime nenhum.

 **Nada aqui cita byte, opcode ou nome de família em hexadecimal.** O texto é para quem está com a
 impressora na mão, não para quem leu a reversão.
 */
enum PrinterWifiSetupContract {
    // MARK: - a abertura

    static let panelTitle = "Rede Wi-Fi da impressora"

    /// O que esta tela faz, e o que ela não consegue provar. As duas metades são medição de bancada
    /// de 21-22/08: depois do envio o app não recebe resposta nenhuma, e a conexão que entregou o
    /// comando é derrubada pelo próprio comando.
    static let introNotice =
        "Grava a rede Wi-Fi dentro da impressora, e não volta sozinho. O comprovante é o papel: depois do envio o app não recebe resposta nenhuma. Se você está falando com ela pela rede, a conexão cai no meio — isso é esperado."

    // MARK: - o alvo

    static func target(
        hasEphemeralCandidate: Bool,
        canSend: Bool,
        hasAdoptedPrinter: Bool
    ) -> PrinterWifiSetupTarget {
        if hasEphemeralCandidate { return .ephemeralCandidate }
        if canSend { return .adoptedPrinter }
        return hasAdoptedPrinter ? .adoptedUnavailable : .noPrinter
    }

    /// A frase é imperativa e nomeia o gesto que resolve, nos dois casos em que há gesto; nos dois
    /// em que não há, ela diz por onde os bytes saem. Nunca descreve o defeito, e nunca nomeia a
    /// unidade — é em `displayName` que marca e modelo moram.
    static func targetNotice(_ target: PrinterWifiSetupTarget) -> String {
        switch target {
        case .ephemeralCandidate:
            return "Uma candidata está retida somente em memória: a tira e a configuração saem por ela."
        case .adoptedPrinter:
            return "Sem candidata em memória: a tira e a configuração saem pela impressora instalada e pronta."
        case .noPrinter:
            return "Nenhuma candidata em memória e nenhuma impressora instalada. Procure a impressora no scan de rede local ou em Configuração antes de configurar a rede dela."
        case .adoptedUnavailable:
            // Os dois gestos, porque a tela não sabe qual dos dois falta: uma plataforma mede
            // alcançabilidade e a outra mede "em uso", e nenhuma mede as duas. Ver
            // `PrinterWifiSetupTarget`.
            return "Há impressora instalada, e nenhuma delas recebe envio agora. Ligue a impressora e deixe ela perto do celular, na mesma Wi-Fi, e marque ela como a impressora em uso."
        }
    }

    /// A recusa no instante do gesto, quando o alvo sumiu entre um desenho e o toque.
    ///
    /// **É frase de desfecho, e não a frase de contexto do alvo.** Repetir a frase do alvo aqui —
    /// que é o que o Android fazia — responde ao toque em gravar com a linha que já estava
    /// desenhada no topo, e num dos quatro casos ela é afirmativa: "a rede será gravada", dita como
    /// resposta a um gesto em que nada foi gravado.
    static let noTargetAtGesture =
        "Nenhuma impressora alcançável agora: nem candidata em memória, nem instalada e pronta."

    // MARK: - a tira

    /// O custo em papel, contado da tira e não escrito aqui. Ver ``ThermalWifiProbePaperCost``.
    ///
    /// Lê `maximumStrips` — custo anunciado antes de gastar é o pior caso. As duas constantes são
    /// iguais por construção, e as duas suítes fixam essa igualdade; ler uma de cada lado eram duas
    /// contas para a mesma pergunta.
    static var probePaperCostNotice: String {
        let tiras = ThermalWifiProbePaperCost.maximumStrips
        return tiras == 1
            ? "Sai uma tira curta de papel."
            : "Saem até \(tiras) tiras curtas de papel."
    }

    /// Quanto tempo a impressora pode ficar muda depois de cada envio, da aritmética do kit.
    static var portOutageNotice: String {
        "Depois de cada envio a impressora pode ficar até \(ThermalWifiProbe.worstCasePortOutageSeconds) segundos sem responder, enquanto reconfigura o rádio."
    }

    /// O que a tira faz, com os marcadores interpolados da própria sonda.
    ///
    /// Copiados como literal, eles congelariam uma tira que a sonda pode não emitir mais — é a
    /// mesma razão pela qual ``ThermalWifiProbeReading/label`` mora no kit.
    static var probeExplanation: String {
        "A impressora vai imprimir uma tira curta, com \(ThermalWifiProbe.openingMarker) em cima e \(ThermalWifiProbe.closingMarker) embaixo. O que aparecer entre os dois é o que diz como esta impressora aceita configuração."
    }

    static let probeButtonTitle = "Imprimir a tira de identificação"
    static let probeAgainButtonTitle = "Imprimir a tira de novo"

    /// Volta para a pergunta sem gastar outra tira. A tira custa papel, e o custo é anunciado
    /// justamente para não ser gasto à toa: corrigir uma resposta errada não pode exigir papel novo.
    static let answerAgainButtonTitle = "Responder de novo"

    static let restartButtonTitle = "Começar de novo"
    static let sendingNotice = "Mandando os bytes"
    static let readingQuestion = "O que saiu no papel?"

    /**
     Do que o agregado devolveu para o que a tela pode afirmar.

     `hadSender` é o `Bool` de
     ``ThermalPrinterConfiguration/sendEphemeralCommand(_:fallingBackToAdopted:completion:)``, e ele
     **não pode ser descartado**: era o `_ =` que fazia "não havia remetente" chegar à tela como "a
     conexão caiu". Ele e ``PrinterProbeFailure/rejected`` dizem a mesma coisa por dois caminhos, e
     a tela aceita qualquer um dos dois.

     `interrupted` e `success` colapsam de propósito: os dois querem dizer "os bytes começaram a
     sair", e é só isso que qualquer um deles prova. Sucesso no TCP confirma escrita no socket, não
     papel — e aqui nem o socket sobrevive ao comando.
     */
    static func dispatch(
        result: PrinterProbeSendResult,
        hadSender: Bool
    ) -> PrinterWifiDispatch {
        guard hadSender else { return .noTarget }
        switch result {
        case .success: return .reachedPrinter
        case .failure(.rejected): return .noTarget
        case .failure(.unavailable): return .notSent
        case .failure(.interrupted): return .reachedPrinter
        }
    }

    /**
     Para onde o passo vai depois de tentar a tira, ou `nil` para ficar onde está.

     Só o despacho que chegou à impressora abre a pergunta — ver
     ``PrinterWifiDispatch/advancesToReading``. Nos outros dois a tela fica no passo em que estava,
     com a frase do desfecho: sem papel não há o que perguntar.
     */
    static func stageAfterProbe(_ dispatch: PrinterWifiDispatch) -> PrinterWifiSetupStage? {
        dispatch.advancesToReading ? .reading : nil
    }

    /// O que dizer sobre o envio da tira — sem afirmar, em nenhum dos três casos, o que saiu no
    /// papel.
    ///
    /// **"Os bytes começaram a sair" e não "a tira saiu".** O transporte prova que a escrita
    /// começou, não que a tira imprimiu; afirmar a saída enviesa contra a leitura "não saiu nada",
    /// que é exatamente a que separa "engoliu o comando" de "não chegou byte".
    static func probeDispatchNotice(_ dispatch: PrinterWifiDispatch) -> String {
        switch dispatch {
        case .noTarget:
            // A frase do alvo **não** entra aqui, nem por parâmetro: ela é contexto, já está
            // desenhada no topo, e num dos quatro casos é afirmativa.
            return noTargetAtGesture
        case .notSent:
            // Sem promessa de resposta na cauda: a tela inteira é construída sobre
            // `readsResponseBytes == false`, e não existe "chegar a responder".
            return "Nada saiu deste telefone. Confira a conexão e mande a tira de novo."
        case .reachedPrinter:
            return "Os bytes começaram a sair. Pela rede, a conexão cai logo depois, e isso é esperado. Agora olhe o papel: só ele responde."
        }
    }

    // MARK: - a família

    /**
     Da leitura para o passo seguinte.

     Derivado de ``ThermalWifiProbeResult/confirmedProtocol``, e não de um `switch` escrito de novo:
     sem família confirmada não há quadro a montar, e com família confirmada há exatamente um.
     Reescrever a conta aqui criaria um segundo lugar onde ela pode discordar do kit.

     **É aqui que a tela consulta se há escolha à mão a oferecer**, e por isso não existe uma
     segunda função dizendo a mesma coisa: `offersManualChoice` era chamada só pela suíte, e regra
     que a tela decide noutro lugar prova a si mesma.
     */
    static func stage(after reading: ThermalWifiProbeReading) -> PrinterWifiSetupStage {
        let result = ThermalWifiProbe.result(for: reading)
        guard let confirmed = result.confirmedProtocol else { return .choice(result) }
        return .form(confirmed)
    }

    /**
     O que gravar no perfil depois desta leitura, ou `nil` quando não há o que gravar.

     Derivado de ``ThermalWifiProbe/result(for:)`` e de ``PrinterWifiConfigurationFamily/init(measured:)``,
     e não de um `switch` escrito de novo: um segundo lugar decidindo isto é um segundo lugar onde
     ele pode discordar do kit — e aqui discordar significa gravar no perfil uma família que a tira
     não mostrou.

     **`nil` cobre os dois indeterminados, e é o que o Bruno fixou:** "não saiu nada" e "os
     marcadores saíram sem o bloco" não são resposta sobre a impressora, e gravá-los seria gravar a
     ausência de medição. A tela avança do mesmo jeito — o passo é de sessão —, ela só não escreve.
     */
    static func recordableFamily(
        after reading: ThermalWifiProbeReading
    ) -> PrinterWifiConfigurationFamily? {
        PrinterWifiConfigurationFamily(measured: ThermalWifiProbe.result(for: reading))
    }

    /**
     O que gravar quando a pessoa escolhe a segunda família à mão.

     Separado de ``recordableFamily(after:)`` porque a procedência é outra, e é justamente a
     procedência que este campo existe para carregar: aqui ninguém mediu nada. A suíte prende este
     valor a ``manuallyChosenProtocol``, para as duas constantes não poderem descrever famílias
     diferentes.
     */
    static let manuallyChosenFamily: PrinterWifiConfigurationFamily = .chosenUsEscUs

    /**
     Onde a tela abre quando o perfil já responde a pergunta.

     **Semeia o passo inicial, e não o define continuamente.** ``PrinterWifiSetupStage`` é estado de
     sessão de propósito — a queda pós-escrita é o caminho normal desta tela, e derivar o passo de
     qualquer coisa fora dela apaga a pergunta respondida e o formulário digitado exatamente depois
     de os bytes saírem. Esta função é chamada uma vez, na construção do estado, e nunca mais.

     A negativa medida abre em ``choice``, e não em ``target``: ela é conclusão, não lacuna. Quem já
     gastou a tira e descobriu que a impressora recusa aquela família precisa ver isso escrito e a
     escolha à mão ao lado — reoferecer a sonda seria cobrar papel por uma resposta que já existe.
     */
    static func initialStage(
        for family: PrinterWifiConfigurationFamily?
    ) -> PrinterWifiSetupStage {
        guard let family else { return .target }
        if let confirmed = family.configuredProtocol { return .form(confirmed) }
        return .choice(.usWFamilyAbsent)
    }

    /**
     O que a tela diz quando abriu já respondida.

     **Ela precisa dizer que a resposta é de antes.** Sem isto, quem entra na tela vê o formulário
     aberto e não tem como saber se alguma tira saiu agora — e ``formProvenanceNotice(for:)``, que
     descreve a procedência, está no presente. A frase também nomeia o gesto que remede, porque
     "começar de novo" só se lê como remedição quando alguém diz que é isso que ele faz.

     Some assim que a pessoa responde de novo: a partir daí a resposta é desta sessão.
     */
    static let storedFamilyNotice =
        "Esta impressora já tinha respondido isto antes, e a resposta ficou guardada com ela. Para medir de novo, toque em começar de novo e imprima a tira."

    /**
     O que a tela diz quando a leitura não abriu formulário nenhum.

     No caso indeterminado a frase é a do kit, inteira: ela já explica por que aquilo **não** é
     resposta, e reescrevê-la faria a mesma medição ter duas palavras. Na negativa o kit não publica
     frase — o tipo diz "ausente" e mais nada —, então esta é da tela, e ela descreve o que a pessoa
     viu no papel em vez de nomear formato nenhum.

     **A negativa precisa de frase justamente por ser o desfecho mais conclusivo dos quatro**: a
     letra solta é o único que **nega** a família. O Android desenhava só `indeterminacy`, que é
     nulo ali, e a pessoa respondia a pergunta e não lia nada — a tela sugerindo que a resposta não
     valeu.
     */
    static func unconfirmedNotice(_ result: ThermalWifiProbeResult) -> String? {
        if let indeterminacy = result.indeterminacy { return indeterminacy.message }
        switch result {
        case .usWFamilyAbsent:
            return "A impressora imprimiu o comando como texto em vez de obedecer: ela não aceita configuração deste jeito."
        case .usWFamilyHonored, .indeterminate:
            return nil
        }
    }

    /**
     A única família que a pessoa pode escolher à mão.

     **Não é omissão da sonda, é o que a bancada mediu:** nenhuma leitura de papel a distingue de
     uma impressora qualquer que engula o prefixo, e a única maneira de "confirmá-la" seria escrever
     o quadro dela ou travar o parser à espera do terminador — foi o que a bancada fez de propósito
     em 22/08/2026. Instrumento que precisa quebrar a impressora para medir não é sonda.
     */
    static let manuallyChosenProtocol: ThermalWifiProtocol = .usEscUs

    static let manualChoiceTitle = "Tentar o outro formato de configuração"

    /// **Sem marca e sem modelo, de propósito.** Nomear o fabricante aqui reabriria o catálogo por
    /// modelo — a decisão que este projeto já tomou ao contrário —, e a regra está fixada por
    /// literal em duas suítes. Uma impressora entra nesta escolha por alguém decidir, não por estar
    /// numa lista.
    static let manualChoiceExplanation =
        "Existe um segundo formato de configuração. Nenhuma tira consegue confirmá-lo: quem o entende não responde nada, e quem não o entende também não. Por isso a escolha é sua, e não uma medição — e é por isso que o comprovante muda de lugar."

    /// O aviso que acompanha a escolha à mão, e que muda o lugar do comprovante.
    static let manualChoiceProofWarning =
        "Impressoras deste formato não imprimem cupom depois de gravar: elas só apitam. Para conferir o que ficou gravado, tire o autoteste dela — três cliques no avanço de papel — e leia a rede na tira."

    static let manualChoiceButtonTitle = "Configurar por este formato"

    // MARK: - o formulário

    /// O nome do campo muda com o modo porque o campo muda de sentido: em ponto de acesso a rede é
    /// criada, em cliente ela é procurada.
    static func ssidFieldLabel(for mode: ThermalWifiMode?) -> String {
        switch mode {
        case .accessPoint: return "Nome da rede que a impressora vai criar"
        case .station: return "Nome da rede em que a impressora vai entrar"
        case nil: return "Nome da rede"
        }
    }

    static let passwordFieldLabel = "Senha da rede"

    /// A senha fica só enquanto a tela está viva; a frase existe para a pessoa saber disso **antes**
    /// de digitar.
    static let passwordNotice =
        "A senha fica somente nesta tela enquanto ela está aberta: não é salva, nem registrada, nem mostrada depois."

    static let securityLabel = "Segurança da rede"

    /// O estado vazio do seletor do iOS.
    ///
    /// Único rótulo sem gêmeo do outro lado, e de propósito: ele é afordância de controle, não
    /// frase. O `Picker` do iOS precisa de uma linha para "nenhuma escolha"; a lista de botões do
    /// Android diz a mesma coisa por nenhum botão estar preenchido. O que a pessoa **lê** sobre a
    /// escolha que falta é ``pendingChoiceNotice(for:securityChosen:modeChosen:)``, e essa é igual
    /// nos dois.
    static let securityPlaceholder = "Escolha"

    static let modeLabel = "Como a impressora vai ficar na rede"

    /**
     O que abriu este formulário.

     Pode ser fixa por família sem guardar procedência: a primeira só se alcança pela tira, e a
     segunda só pela escolha da pessoa — nenhuma leitura de papel abre a segunda. A frase da segunda
     nega que ali houve medição, porque não houve.
     */
    static func formProvenanceNotice(for wifiProtocol: ThermalWifiProtocol) -> String {
        switch wifiProtocol {
        case .usW:
            return "A tira identificou como esta impressora aceita configuração."
        case .usEscUs:
            return "Você escolheu este formato: nenhuma tira o confirma, e a impressora não avisa se ele estiver errado."
        }
    }

    /**
     O que ainda falta escolher, quando falta.

     **Botão cinza sem frase é o defeito que já travou a lista de impressoras deste kit** em 21/08 —
     a tela inteira desabilitada, sem uma linha dizendo o que acontecia. Aqui os seletores nascem
     vazios de propósito, então a tela tem de dizer que estão. `nil` quando a régua já pode
     responder.
     */
    static func pendingChoiceNotice(
        for wifiProtocol: ThermalWifiProtocol,
        securityChosen: Bool,
        modeChosen: Bool
    ) -> String? {
        // A ordem é a do formulário: o modo vem antes porque muda o sentido do campo de nome, e
        // perguntar o sentido depois da resposta é o desenho errado.
        if wifiProtocol == .usW, !modeChosen {
            return "Escolha como a impressora vai ficar na rede."
        }
        return securityChosen ? nil : "Escolha a segurança da rede."
    }

    static func label(for mode: ThermalWifiMode) -> String {
        switch mode {
        case .accessPoint: return "Ponto de acesso: a impressora cria a própria rede"
        case .station: return "Cliente: a impressora entra na rede que você informar"
        }
    }

    /**
     O que a pessoa perde ao gravar cada modo, dito **antes** de gravar.

     Medido em 21/08/2026: quem configura pelo ponto de acesso da própria impressora está na rede
     dela, e ao virar cliente o telefone perde o AP no mesmo instante. Dizer isso depois seria dizer
     para uma tela que a pessoa já não alcança.

     **São dois textos porque os dois modos perdem coisas diferentes**, e é isso que o aviso único
     do Android errava num ramo: anexado ao modo ponto de acesso ele dizia "essa rede desaparece
     assim que a impressora entrar na rede nova", e nesse modo a impressora não entra em rede
     nenhuma — ela cria a própria.
     */
    static func modeWarning(for mode: ThermalWifiMode) -> String {
        switch mode {
        case .station:
            return "Se o telefone está conectado à rede da própria impressora agora, ele perde essa rede no instante em que a impressora virar cliente. Reconecte o telefone à rede que você informou aqui."
        case .accessPoint:
            return "A impressora sai da Wi-Fi em que estiver e passa a ter rede própria. Para falar com ela de novo, o telefone precisa entrar nessa rede."
        }
    }

    /**
     A mesma perda, na família que não tem byte de modo.

     Ali o quadro grava nome e chave e a impressora entra na rede informada; não há ramo de ponto de
     acesso a descrever. **O aviso precisa existir nas duas famílias** — quem configura pelo AP da
     própria impressora perde a rede de qualquer uma delas —, e era só na primeira que o iOS o
     disparava.
     */
    static let accessPointHandoffNotice =
        "Se este telefone está conectado à rede criada pela própria impressora, essa rede desaparece assim que a impressora entrar na rede nova. Reconecte o telefone à rede de destino para reencontrar a impressora."

    /// Rótulos dos dez valores da outra família, também no vocabulário do roteador.
    ///
    /// São dez contra os sete da primeira, com fronteiras diferentes — WEP dividido por tamanho de
    /// chave, e um modo misto que a outra não tem. É a lista fechada do kit que manda aqui; a tela
    /// só a traduz.
    static func label(for keyType: ThermalWifiKeyType) -> String {
        switch keyType {
        case .open: return "Rede aberta, sem senha"
        case .wep64: return "WEP 64"
        case .wep128: return "WEP 128"
        case .wpaAESPSK: return "WPA (AES)"
        case .wpaTKIPPSK: return "WPA (TKIP)"
        case .wpaTKIPAESPSK: return "WPA (TKIP e AES)"
        case .wpa2AESPSK: return "WPA2 (AES)"
        case .wpa2TKIP: return "WPA2 (TKIP)"
        case .wpa2TKIPAESPSK: return "WPA2 (TKIP e AES)"
        case .wpaWPA2MixedMode: return "WPA e WPA2 juntos"
        }
    }

    /**
     Se o segundo gesto pode ser oferecido.

     `validation` chega `nil` enquanto a pessoa não escolheu tudo o que **não tem valor padrão** —
     segurança nas duas famílias e modo na primeira. Nenhum deles é pré-selecionado de propósito:
     o modo já foi "corrigido" ao contrário uma vez neste projeto e tirou uma impressora da rede, e
     a segurança errada custa a mesma unidade. Um seletor que já vem respondido é uma resposta que
     ninguém deu.
     */
    static func allowsPreparing(
        target: PrinterWifiSetupTarget,
        isSending: Bool,
        validation: ThermalWifiValidation?
    ) -> Bool {
        guard target.allowsSending, !isSending else { return false }
        return validation?.byteCount != nil
    }

    // MARK: - a contagem anunciada

    /**
     O que o caminho de envio deste sistema acrescenta antes do quadro, em bytes.

     **Zero aqui, e não zero do outro lado.** No iOS `sendEphemeralCommand` entrega os bytes ao
     `PrinterProbeSending`, que os passa ao transporte sem tocá-los: o fio recebe exatamente a tira
     e exatamente o quadro. No Android os quatro caminhos de escrita do transporte prefixam o
     inicializador ESC/POS antes do payload, e por isso o gêmeo devolve o tamanho dele.

     **Isto é lacuna medida, não decisão de tela**, e está escrito aqui para não voltar a passar
     despercebido: o que a bancada exercitou em papel em 21-22/08 foi o cru, por TCP 9100 a partir
     de um iPhone — ou seja, o caminho sem prefixo. Enquanto o Android não tiver rota de envio crua,
     as duas plataformas emitem bytes diferentes para a mesma impressora no mesmo gesto, e a única
     coisa que esta tela pode fazer é **anunciar o número verdadeiro de cada uma**. Tirar o prefixo
     do transporte mudaria toda impressão do Android, cupom de venda homologado inclusive, e isso
     não se faz sem impressora na bancada.
     */
    static let hostSendPrefixByteCount = 0

    /// O que sai no fio: o quadro mais o que o caminho de envio acrescenta.
    ///
    /// A tela anuncia **este** número, e não o do quadro. A contagem anunciada é uma medição: um
    /// número que não descreve o que sai é uma medição errada, e o Android mentia por dois bytes em
    /// dois portões enquanto a suíte fixava a contagem contra o quadro em vez de contra o fio.
    static func announcedByteCount(frameByteCount: Int) -> Int {
        frameByteCount + hostSendPrefixByteCount
    }

    /// O tamanho do envio, dito antes do gesto. É o que dá para mostrar sem repetir o segredo na
    /// tela — a mesma razão pela qual ``ThermalWifiValidation`` carrega a contagem e não o quadro.
    static func byteCountNotice(_ frameByteCount: Int) -> String {
        "A configuração sai em \(announcedByteCount(frameByteCount: frameByteCount)) bytes, num envio só."
    }

    // MARK: - o portão de dois gestos

    /// O título já carrega a contagem, como o portão do comando cru carrega a dele.
    static func confirmationTitle(frameByteCount: Int) -> String {
        "Confirmar \(announcedByteCount(frameByteCount: frameByteCount)) bytes"
    }

    /// O mesmo rótulo do portão do comando cru, nas duas plataformas: é o vocabulário já
    /// estabelecido para "vou mandar bytes que gravam configuração não volátil".
    static let confirmButtonTitle = "Conheço o efeito e a reversão"

    static let cancelButtonTitle = "Cancelar"

    static let prepareButtonTitle = "Revisar e gravar a rede"

    /**
     O aviso do portão, montado do que cada família mede.

     **O comprovante é o papel, nunca a tela.** Depois do envio o app não vê resposta nenhuma: uma
     família imprime o cupom com o que ficou gravado, a outra só apita.

     **Só a família com cupom promete a janela de correção.** Ela foi medida numa família só, em
     21/08/2026, quando um nome de rede errado tirou a unidade da rede assim que ela reiniciou.
     Repeti-la na outra transformaria falta de medição em medição — é a mesma regra do AGENTS.md que
     separa `null` medido de lacuna, e ela vale mais que a simetria da frase.
     */
    static func confirmationWarning(
        for wifiProtocol: ThermalWifiProtocol,
        mode: ThermalWifiMode?
    ) -> String {
        var partes = [
            "A rede é gravada agora, e a conexão vai cair no meio — isso é o normal, não é falha.",
        ]
        switch wifiProtocol {
        case .usW:
            partes.append(
                "O comprovante é o cupom que a impressora imprime na hora, com o modo, o nome da rede e a senha que ficaram gravados. Confira esse cupom: enquanto ela não reiniciar, dá para reenviar corrigido. A rede nova só passa a valer quando você desligar e ligar a impressora — e se o nome estiver errado, é esse boot que tira ela do ar."
            )
            // O aviso do modo cobre a perda do ponto de acesso nos dois sentidos; o texto genérico
            // seria falso no ramo em que a impressora **cria** a rede em vez de entrar numa.
            if let mode { partes.append(modeWarning(for: mode)) }
        case .usEscUs:
            partes.append(manualChoiceProofWarning)
            partes.append("Se o nome da rede sair errado, a impressora sai da rede.")
            // Aqui não há byte de modo: a impressora entra na rede informada, e é o único ramo em
            // que "entrar na rede nova" é verdade sem ressalva.
            partes.append(accessPointHandoffNotice)
        }
        return partes.joined(separator: " ")
    }

    // MARK: - depois do envio

    /**
     O desfecho do envio, e ele nunca afirma o que saiu no papel.

     Nem o sucesso nem a queda provam papel, e aqui é pior: o quadro derruba o canal que o entregou.
     Por isso a queda não repete envio sozinha e não nega a gravação; ela manda olhar o papel, igual
     ao sucesso. O único desfecho em que reenviar é seguro sem olhar o papel é aquele em que a
     escrita não começou.
     */
    static func sendOutcomeNotice(
        dispatch: PrinterWifiDispatch,
        wifiProtocol: ThermalWifiProtocol
    ) -> String {
        switch dispatch {
        case .noTarget:
            return noTargetAtGesture
        case .notSent:
            return "Nada saiu deste telefone: a rede da impressora não foi alterada. Confira a conexão e mande de novo."
        case .reachedPrinter:
            switch wifiProtocol {
            case .usW:
                return "Os bytes começaram a sair. O comprovante é o papel: procure o cupom com o modo, o nome da rede e a senha gravados. Confira esse cupom agora — enquanto ela não reiniciar, dá para mandar de novo corrigido. Quando estiver certo, desligue e ligue a impressora: a rede nova só vale depois disso. E se estiver errado, o próximo boot tira a impressora do ar."
            case .usEscUs:
                return "Os bytes começaram a sair. O comprovante é o papel. Se ela for deste formato, só apita: tire o autoteste dela, com três cliques no avanço de papel, para ver a rede gravada."
            }
        }
    }

    /// Quando a tela não conseguiu montar o quadro apesar de a régua ter aceitado os campos.
    ///
    /// **Não é recusa, e não pode ganhar frase de recusa.** As frases de recusa são da camada de
    /// quadro e dizem o limite do campo; esta diz que a tela errou, e que nenhum byte saiu. A frase
    /// nomeia o culpado de propósito: traduzi-la em "confira os dados" mandaria a pessoa caçar erro
    /// num formulário correto.
    static let frameConstructionFailure =
        "A régua aceitou os campos e o quadro não foi montado. Isto é falha do aplicativo, não dos dados informados: nada foi enviado à impressora."
}
