package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.EscPosThermalCommands
import br.com.thermalprinterkit.PrinterWifiConfigurationFamily
import br.com.thermalprinterkit.ThermalPrintDelivery
import br.com.thermalprinterkit.ThermalPrintResult
import br.com.thermalprinterkit.ThermalWifiCipher
import br.com.thermalprinterkit.ThermalWifiKeyType
import br.com.thermalprinterkit.ThermalWifiMode
import br.com.thermalprinterkit.ThermalWifiProbe
import br.com.thermalprinterkit.ThermalWifiProbePaperCost
import br.com.thermalprinterkit.ThermalWifiProbeReading
import br.com.thermalprinterkit.ThermalWifiProbeResult
import br.com.thermalprinterkit.ThermalWifiProtocol
import br.com.thermalprinterkit.ThermalWifiSecurity
import br.com.thermalprinterkit.ThermalWifiValidation
import br.com.thermalprinterkit.byteCount

/*
 * Gêmeo de `ios/Printher/PrinterWifiSetupContract.swift`.
 *
 * Molde de [PrinterUnitAvailability]: os nomes de tipo e de função são os **mesmos** dos dois
 * lados, e a forma muda só onde a linguagem obriga — `sealed interface` aqui, `enum` com valor
 * associado lá. Quem mexer numa regra mexe nas duas.
 *
 * **Este docblock existe porque a divergência já aconteceu.** As duas telas foram escritas em
 * paralelo, uma por plataforma, e divergiram no fluxo — não só nas palavras: máquinas de estado
 * diferentes, regras diferentes para abrir a pergunta do papel, e uma frase afirmando a saída da
 * tira antes de perguntar o que saiu. Cada lado fixou a própria divergência por literal na própria
 * suíte, e as duas passavam verdes discordando. Nada prendia um contrato ao outro; agora prende
 * isto, mais os literais compartilhados fixados nas duas suítes.
 *
 * **Toda frase de tela mora aqui, e nenhuma na `@Composable`.** Frase escrita na tela fica fora do
 * alcance das afirmações de segurança — a proibição de marca e opcode e a checagem de vazamento de
 * senha varrem [PrinterWifiSetupContract.todasAsFrases], e o que não desce até aqui não é varrido.
 *
 * **A senha nunca entra em tipo que sintetize `toString`.** Ela chega às funções daqui como
 * parâmetro solto e sai no quadro; nenhum `data class` deste arquivo a guarda. O único tipo que
 * carrega bytes com segredo é [PrinterWifiPendingFrame], e ele redige a descrição à mão — regra do
 * AGENTS.md, seção Segurança, com o precedente de `RawHexCommand` e de `ThermalWifiSecurity`.
 */

// --- 1. os quatro passos -------------------------------------------------------------------------

/**
 * Onde a configuração de rede está, dos quatro passos que ela tem.
 *
 * Mora fora da `@Composable` pela razão de sempre nesta superfície — [PrinterUnitAvailability],
 * `transportMeasurementLines`: a decisão de qual formulário abrir é afirmável sem tela, e escrita
 * dentro da composição ela só seria afirmável com aparelho.
 *
 * **É estado de sessão, e não uma função do alvo.** Este é exatamente o ponto em que este lado
 * divergia: `TARGET` era "não há alvo", derivado a cada desenho, e a tela voltava para ele a cada
 * perda de alvo. Só que **a queda pós-escrita é o caminho normal desta tela** — a tira e o quadro
 * derrubam a conexão que os entregou, e `fail()` publica o estado de falha — e derrubar o passo
 * junto apagava a pergunta das quatro leituras **e** o formulário digitado exatamente depois de os
 * bytes saírem. Agora perder o alvo fecha o botão e mostra a frase do alvo; não desfaz o que a
 * pessoa já respondeu.
 *
 * **O passo [Target] não é enfeite de abertura.** Ele é onde a tela diz por onde os bytes vão sair,
 * ou o que falta para saírem; sem ele, "não aconteceu nada" seria a única resposta de quem não tem
 * impressora alcançável.
 */
internal sealed interface PrinterWifiSetupStage {
    /** Antes da tira. A tela mostra o alvo, o custo em papel e o que vai acontecer. */
    data object Target : PrinterWifiSetupStage

    /**
     * A tira foi mandada e a escrita começou. A leitura vem da pessoa olhando o papel, e de mais
     * nada. Ver [PrinterWifiDispatch.advancesToReading].
     */
    data object Reading : PrinterWifiSetupStage

    /**
     * A leitura chegou e não abriu formulário nenhum. Resta mandar a tira de novo, responder de
     * novo, ou escolher à mão o formato que nenhuma tira confirma.
     */
    data class Choice(val result: ThermalWifiProbeResult) : PrinterWifiSetupStage

    /** O formato está definido — pela tira ou pela pessoa — e o formulário é o dele. */
    data class Form(val protocol: ThermalWifiProtocol) : PrinterWifiSetupStage
}

// --- 2. o alvo -----------------------------------------------------------------------------------

/**
 * Por onde a tira e o quadro saem, ou o que falta para saírem.
 *
 * **O motivo e a permissão são o mesmo valor**, como `printingUnavailableReason` no iOS: não existe
 * estado em que um diga sim e o outro não. É enum, e não `String?`, porque os dois casos que
 * **podem** também têm o que dizer — por onde os bytes vão sair não é a mesma informação que "podem
 * sair" —, e a tela mostra a frase nos quatro.
 *
 * **São quatro, e não dois, pela regra do AGENTS.md de não maquiar um motivo com o outro.** "Nunca
 * houve impressora" e "há impressora instalada que não recebe agora" mandam a pessoa a lugares
 * diferentes; uma frase só para os dois manda procurar no lugar errado.
 *
 * **O quarto caso é um só de propósito, e as duas plataformas medem metade dele cada uma.** Este
 * lado sabe dizer "instalada e não marcada em uso" (o `active` do store); o iOS sabe dizer
 * "instalada e inalcançável" (`canSendEphemeralCommand` confere estado e rede). Nenhum dos dois
 * sabe dizer o do outro, e inventar o eixo que falta seria medir o silêncio. Então o caso é o fato
 * que os dois medem — **há impressora instalada e nenhuma delas recebe envio agora** — e a frase
 * nomeia os dois gestos que resolvem, porque a tela honestamente não sabe qual dos dois falta.
 *
 * **A frase nunca nomeia a unidade.** `displayName` é exatamente onde marca e modelo moram
 * (AGENTS.md, contratos do M2), e era ele que este lado interpolava aqui: a frase podia conter o
 * nome do fabricante por construção, e o teste que proíbe marca só passava porque a fixture se
 * chamava "Balcão".
 */
internal enum class PrinterWifiSetupTarget {
    /** Uma candidata testada continua retida em memória, e é ela que `openHomologationTarget` prefere. */
    EPHEMERAL_CANDIDATE,

    /** Sem candidata retida, mas a impressora instalada recebe os envios. */
    ADOPTED_PRINTER,

    /** Nunca houve impressora neste aparelho. */
    NO_PRINTER,

    /** Há impressora instalada, e nenhuma delas recebe envio agora. */
    ADOPTED_UNAVAILABLE,
    ;

    val allowsSending: Boolean
        get() = this == EPHEMERAL_CANDIDATE || this == ADOPTED_PRINTER
}

// --- 3. o despacho, e o que ele **não** prova ----------------------------------------------------

/**
 * O que aconteceu com os bytes, do ponto de vista de quem está olhando a tela.
 *
 * **Este tipo tem três casos e nenhum deles é "deu certo".** Tanto a tira quanto o quadro rodam o
 * emissor AT do módulo, e o emissor AT derruba o modo transparente — ou seja, os dois **matam a
 * conexão que os entregou** (`ThermalWifiProbe.DROPS_DELIVERING_CONNECTION`). Uma falha de
 * transporte logo depois da escrita é o caminho normal, não um defeito, e tratá-la como falha faria
 * a tela pedir reenvio de um quadro que já gravou.
 *
 * O que separa os casos é o que o kit já sabe distinguir: [ThermalPrintDelivery]. Antes da primeira
 * escrita nada saiu e reenviar é seguro; depois dela, o desfecho está no papel e mais lugar nenhum.
 *
 * **[NO_TARGET] é separado, e não é "a conexão caiu".** Sem alvo nenhum byte saiu do telefone. Do
 * lado do iOS esse caso chegava colapsado em "a conexão caiu, e isso é esperado" — a mesma classe de
 * erro de 21/08/2026, com socket morto tratado como falha da sonda, agora ao contrário.
 */
internal enum class PrinterWifiDispatch {
    /** Não havia alvo. Nada foi para o fio, e a tela diz isso com frase própria. */
    NO_TARGET,

    /** A escrita não começou. Nada chegou à impressora, e mandar de novo é seguro. */
    NOT_SENT,

    /** A escrita começou. O que aconteceu depois disso está no papel, e a tela não sabe. */
    REACHED_PRINTER,
    ;

    /**
     * Só o despacho que chegou à impressora abre a pergunta da leitura.
     *
     * Se nada saiu do telefone não há papel sobre o que perguntar, e perguntar assim mesmo
     * convidaria a responder "não saiu nada" — que é a leitura de uma tira que nunca foi mandada, e
     * viraria medição inventada.
     */
    val advancesToReading: Boolean
        get() = this == REACHED_PRINTER
}

// --- 4. as escolhas do formulário ----------------------------------------------------------------

/**
 * Os sete ramos de segurança da família que a tira confirma, no vocabulário do roteador.
 *
 * **Existe porque `ThermalWifiSecurity` não é lista, é gramática**: lá os sete ramos nascem de casos
 * com valor associado, e um seletor de tela precisa de sete opções lado a lado. A conversão é nesta
 * direção só — de escolha para segurança —, e nunca por índice: os dez valores de
 * [ThermalWifiKeyType] da outra família moram noutro seletor, e mapear um no outro por posição é a
 * armadilha que os dois docblocks do kit nomeiam.
 *
 * Nenhum caso carrega senha. A senha entra na conversão e sai no quadro; ela não fica guardada em
 * nenhum agregado desta tela, para não haver `toString` sintetizado que a publique.
 */
internal enum class PrinterWifiSecurityChoice(
    val label: String,
) {
    OPEN("Rede aberta, sem senha"),
    WEP_OPEN("WEP com autenticação aberta"),
    WEP_SHARED("WEP com chave compartilhada"),
    WPA_TKIP("WPA (TKIP)"),
    WPA_AES("WPA (AES)"),
    WPA2_TKIP("WPA2 (TKIP)"),
    WPA2_AES("WPA2 (AES)"),
    ;

    /** Rede sem chave não tem onde guardar senha nesta família: o campo some em vez de ser ignorado. */
    val requiresPassword: Boolean
        get() = this != OPEN

    fun security(password: String): ThermalWifiSecurity =
        when (this) {
            OPEN -> ThermalWifiSecurity.Open
            WEP_OPEN -> ThermalWifiSecurity.WepOpen(password)
            WEP_SHARED -> ThermalWifiSecurity.WepShared(password)
            WPA_TKIP -> ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.NONE_TKIP, password)
            WPA_AES -> ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.WEP_AES, password)
            WPA2_TKIP -> ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.NONE_TKIP, password)
            WPA2_AES -> ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, password)
        }
}

// --- 5. o quadro pendente entre os dois gestos ---------------------------------------------------

/**
 * Os bytes prontos, esperando a confirmação — com a senha dentro deles.
 *
 * Molde de `RawHexCommand`, e pelas mesmas duas razões: a descrição é redigida à mão, para nenhum
 * log de estado publicar a chave do cliente, e o buffer é zerado no `finally` do envio, para o
 * segredo não ficar vivo na heap depois de sair pelo fio.
 *
 * Não passa por `RawCommandController`: aquele é o caminho do hexadecimal digitado, e **esta tela
 * existe justamente porque um quadro digitado à mão perdeu um byte, gravou deslocado e tirou uma
 * impressora da rede**. Aqui os bytes só nascem de `ThermalWifiFrame`, a partir de campos tipados.
 */
internal class PrinterWifiPendingFrame(
    private val bytes: ByteArray,
    val warning: String,
) {
    private var consumed = false

    /** O tamanho do quadro. O que a tela **anuncia** é [PrinterWifiSetupContract.announcedByteCount]. */
    val byteCount: Int
        get() = bytes.size

    suspend fun sendWith(send: suspend (ByteArray) -> Unit) {
        check(!consumed) { "O quadro de rede já foi consumido." }
        consumed = true
        try {
            send(bytes)
        } finally {
            bytes.fill(0)
        }
    }

    fun clear() {
        if (!consumed) {
            consumed = true
            bytes.fill(0)
        }
    }

    override fun toString(): String = "PrinterWifiPendingFrame(byteCount=$byteCount, conteúdo=[REDACTED])"
}

// --- 6. tudo o que esta tela decide sem pixel nenhum ---------------------------------------------

/**
 * Tudo o que esta tela decide sem tela.
 *
 * Frase do kit não é reescrita aqui — [ThermalWifiProbeReading.label],
 * `ThermalWifiProbeIndeterminacy.message` e `ThermalWifiRejection.message` vêm prontas e passam
 * inteiras. O que este objeto escreve é o que só a tela sabe: por onde os bytes saem, o que a pessoa
 * perde ao gravar, e onde procurar o comprovante quando a impressora não imprime nenhum.
 *
 * **Nada aqui cita byte, opcode ou nome de família em hexadecimal.** O texto é para quem está com a
 * impressora na mão, não para quem leu a reversão.
 */
internal object PrinterWifiSetupContract {
    // --- a abertura ------------------------------------------------------------------------------

    const val PANEL_TITLE = "Rede Wi-Fi da impressora"

    /**
     * O que esta tela faz, e o que ela não consegue provar. As duas metades são medição de bancada
     * de 21-22/08: depois do envio o app não recebe resposta nenhuma, e a conexão que entregou o
     * comando é derrubada pelo próprio comando.
     */
    const val INTRO_NOTICE =
        "Grava a rede Wi-Fi dentro da impressora, e não volta sozinho. O comprovante é o papel: " +
            "depois do envio o app não recebe resposta nenhuma. Se você está falando com ela pela " +
            "rede, a conexão cai no meio — isso é esperado."

    // --- o alvo ----------------------------------------------------------------------------------

    /**
     * O alvo, do que cada plataforma consegue publicar.
     *
     * **É estimativa de um desenho atrás, de propósito.** Aqui quem sabe se há alvo é
     * `openHomologationTarget()`, que é suspensa e abre `mutex` — não dá para consultá-la dentro de
     * uma `@Composable`. Então a tela habilita pelo que está publicado e **relê no instante do
     * gesto**, exatamente como o painel de comando cru do iOS relê `canSendEphemeralCommand`. O
     * pior caso desta leitura é a frase nomear a candidata quando o quadro já sairia pela instalada
     * — nunca autorizar um envio que não tem alvo, porque aí o despacho devolve [PrinterWifiDispatch.NO_TARGET].
     *
     * A candidata retida vence a instalada porque é isso que `openHomologationTarget()` faz, e é
     * por isso que ela é a primeira cláusula em vez de um ramo qualquer.
     */
    fun target(
        hasEphemeralCandidate: Boolean,
        canSend: Boolean,
        hasAdoptedPrinter: Boolean,
    ): PrinterWifiSetupTarget =
        when {
            hasEphemeralCandidate -> PrinterWifiSetupTarget.EPHEMERAL_CANDIDATE
            canSend -> PrinterWifiSetupTarget.ADOPTED_PRINTER
            hasAdoptedPrinter -> PrinterWifiSetupTarget.ADOPTED_UNAVAILABLE
            else -> PrinterWifiSetupTarget.NO_PRINTER
        }

    /**
     * A frase é imperativa e nomeia o gesto que resolve, nos dois casos em que há gesto; nos dois em
     * que não há, ela diz por onde os bytes saem. Nunca descreve o defeito, e nunca nomeia a unidade
     * — é em `displayName` que marca e modelo moram.
     */
    fun targetNotice(target: PrinterWifiSetupTarget): String =
        when (target) {
            PrinterWifiSetupTarget.EPHEMERAL_CANDIDATE ->
                "Uma candidata está retida somente em memória: a tira e a configuração saem por ela."
            PrinterWifiSetupTarget.ADOPTED_PRINTER ->
                "Sem candidata em memória: a tira e a configuração saem pela impressora instalada e pronta."
            PrinterWifiSetupTarget.NO_PRINTER ->
                "Nenhuma candidata em memória e nenhuma impressora instalada. Procure a impressora " +
                    "no scan de rede local ou em Configuração antes de configurar a rede dela."
            // Os dois gestos, porque a tela não sabe qual dos dois falta: uma plataforma mede
            // alcançabilidade e a outra mede "em uso", e nenhuma mede as duas. Ver
            // [PrinterWifiSetupTarget].
            PrinterWifiSetupTarget.ADOPTED_UNAVAILABLE ->
                "Há impressora instalada, e nenhuma delas recebe envio agora. Ligue a impressora e " +
                    "deixe ela perto do celular, na mesma Wi-Fi, e marque ela como a impressora em uso."
        }

    /**
     * A recusa no instante do gesto, quando o alvo sumiu entre um desenho e o toque.
     *
     * **É frase de desfecho, e não a frase de contexto do alvo.** Repetir a frase do alvo aqui — que
     * era o que este lado fazia — responde ao toque em gravar com a linha que já estava desenhada no
     * topo, e num dos quatro casos ela era afirmativa: "a rede será gravada", dita como resposta a
     * um gesto em que nada foi gravado.
     */
    const val NO_TARGET_AT_GESTURE =
        "Nenhuma impressora alcançável agora: nem candidata em memória, nem instalada e pronta."

    // --- a tira ----------------------------------------------------------------------------------

    /**
     * O custo em papel, contado da tira e não escrito aqui. Ver `ThermalWifiProbePaperCost`.
     *
     * Lê `maximumStrips` — custo anunciado antes de gastar é o pior caso. As duas constantes são
     * iguais por construção, e as duas suítes fixam essa igualdade; ler uma de cada lado eram duas
     * contas para a mesma pergunta.
     */
    val probePaperCostNotice: String
        get() {
            val tiras = ThermalWifiProbePaperCost.maximumStrips
            return if (tiras == 1) {
                "Sai uma tira curta de papel."
            } else {
                "Saem até $tiras tiras curtas de papel."
            }
        }

    /** Quanto tempo a impressora pode ficar muda depois de cada envio, da aritmética do kit. */
    val portOutageNotice: String
        get() =
            "Depois de cada envio a impressora pode ficar até " +
                "${ThermalWifiProbe.worstCasePortOutageSeconds} segundos sem responder, enquanto " +
                "reconfigura o rádio."

    /**
     * O que a tira faz, com os marcadores interpolados da própria sonda.
     *
     * Copiados como literal, eles congelariam uma tira que a sonda pode não emitir mais — é a mesma
     * razão pela qual [ThermalWifiProbeReading.label] mora no kit.
     */
    val probeExplanation: String
        get() =
            "A impressora vai imprimir uma tira curta, com ${ThermalWifiProbe.OPENING_MARKER} em " +
                "cima e ${ThermalWifiProbe.CLOSING_MARKER} embaixo. O que aparecer entre os dois é " +
                "o que diz como esta impressora aceita configuração."

    const val PROBE_BUTTON_TITLE = "Imprimir a tira de identificação"

    const val PROBE_AGAIN_BUTTON_TITLE = "Imprimir a tira de novo"

    /**
     * Volta para a pergunta sem gastar outra tira. A tira custa papel, e o custo é anunciado
     * justamente para não ser gasto à toa: corrigir uma resposta errada não pode exigir papel novo.
     */
    const val ANSWER_AGAIN_BUTTON_TITLE = "Responder de novo"

    const val RESTART_BUTTON_TITLE = "Começar de novo"

    const val SENDING_NOTICE = "Mandando os bytes"

    const val READING_QUESTION = "O que saiu no papel?"

    /**
     * Do desfecho do transporte para o que a tela pode afirmar.
     *
     * `Printed` e `INDETERMINATE` colapsam de propósito: os dois querem dizer "os bytes começaram a
     * sair", e é só isso que qualquer um deles prova. `Printed` no TCP confirma escrita no socket,
     * não papel — e aqui nem o socket sobrevive ao comando.
     */
    fun dispatch(result: ThermalPrintResult): PrinterWifiDispatch =
        when (result) {
            ThermalPrintResult.Printed -> PrinterWifiDispatch.REACHED_PRINTER
            is ThermalPrintResult.Failed ->
                when (result.delivery) {
                    ThermalPrintDelivery.NOT_SENT -> PrinterWifiDispatch.NOT_SENT
                    ThermalPrintDelivery.INDETERMINATE -> PrinterWifiDispatch.REACHED_PRINTER
                }
        }

    /**
     * Exceção escapando do transporte: conta como "pode ter chegado".
     *
     * O lado seguro é este. Dizer "não saiu" quando saiu faria a pessoa reenviar um quadro que já
     * gravou e, na família com cupom, reescrever por cima do que ela ainda ia conferir. Dizer "pode
     * ter chegado" custa uma olhada no papel — que é o comprovante de qualquer jeito.
     *
     * **A mesma regra vale no iOS, escrita noutra camada.** Lá a fronteira do erro sem tipo está
     * dentro do kit, no `catch` genérico de `LocalWifiPrinterProbeSender.sendProbe`, que devolve
     * `PrinterProbeFailure.interrupted` pela mesma razão. Ela mora em lugares diferentes porque é em
     * lugares diferentes que a exceção escapa; o desfecho é o mesmo, e as duas suítes o fixam.
     */
    fun dispatchOfUnexpectedFailure(): PrinterWifiDispatch = PrinterWifiDispatch.REACHED_PRINTER

    /**
     * Para onde o passo vai depois de tentar a tira, ou `null` para ficar onde está.
     *
     * Só o despacho que chegou à impressora abre a pergunta — ver
     * [PrinterWifiDispatch.advancesToReading]. Nos outros dois a tela fica no passo em que estava,
     * com a frase do desfecho: sem papel não há o que perguntar.
     */
    fun stageAfterProbe(dispatch: PrinterWifiDispatch): PrinterWifiSetupStage? =
        if (dispatch.advancesToReading) PrinterWifiSetupStage.Reading else null

    /**
     * O que dizer sobre o envio da tira — sem afirmar, em nenhum dos três casos, o que saiu no papel.
     *
     * **"Os bytes começaram a sair" e não "a tira saiu".** O transporte prova que a escrita começou,
     * não que a tira imprimiu; afirmar a saída — que era o que este lado fazia — enviesa contra a
     * leitura "não saiu nada", que é exatamente a que separa "engoliu o comando" de "não chegou
     * byte", e a frase ficava visível ao mesmo tempo que a pergunta.
     */
    fun probeDispatchNotice(dispatch: PrinterWifiDispatch): String =
        when (dispatch) {
            // A frase do alvo **não** entra aqui, nem por parâmetro: ela é contexto, já está
            // desenhada no topo, e num dos quatro casos é afirmativa.
            PrinterWifiDispatch.NO_TARGET -> NO_TARGET_AT_GESTURE
            // Sem promessa de resposta na cauda: a tela inteira é construída sobre
            // `readsResponseBytes == false`, e não existe "chegar a responder".
            PrinterWifiDispatch.NOT_SENT ->
                "Nada saiu deste telefone. Confira a conexão e mande a tira de novo."
            PrinterWifiDispatch.REACHED_PRINTER ->
                "Os bytes começaram a sair. Pela rede, a conexão cai logo depois, e isso é " +
                    "esperado. Agora olhe o papel: só ele responde."
        }

    // --- a família -------------------------------------------------------------------------------

    /**
     * Da leitura para o passo seguinte.
     *
     * Derivado de `ThermalWifiProbeResult.confirmedProtocol`, e não de um `when` escrito de novo:
     * sem família confirmada não há quadro a montar, e com família confirmada há exatamente um.
     * Reescrever a conta aqui criaria um segundo lugar onde ela pode discordar do kit.
     *
     * **É aqui que a tela consulta se há escolha à mão a oferecer**, e por isso não existe uma
     * segunda função dizendo a mesma coisa: `offersSelfTestFamily` era chamada só pela suíte, e
     * regra que a tela decide noutro lugar prova a si mesma.
     */
    fun stage(after: ThermalWifiProbeReading): PrinterWifiSetupStage {
        val result = ThermalWifiProbe.result(after)
        val confirmed = result.confirmedProtocol ?: return PrinterWifiSetupStage.Choice(result)
        return PrinterWifiSetupStage.Form(confirmed)
    }

    /**
     * O que gravar no perfil depois desta leitura, ou `null` quando não há o que gravar.
     *
     * Derivado de [ThermalWifiProbe.result] e de [PrinterWifiConfigurationFamily.measured], e não de
     * um `when` escrito de novo: um segundo lugar decidindo isto é um segundo lugar onde ele pode
     * discordar do kit — e aqui discordar significa gravar no perfil uma família que a tira não
     * mostrou.
     *
     * **`null` cobre os dois indeterminados, e é o que o Bruno fixou:** "não saiu nada" e "os
     * marcadores saíram sem o bloco" não são resposta sobre a impressora, e gravá-los seria gravar a
     * ausência de medição. A tela avança do mesmo jeito — o passo é de sessão —, ela só não escreve.
     */
    fun recordableFamily(after: ThermalWifiProbeReading): PrinterWifiConfigurationFamily? =
        PrinterWifiConfigurationFamily.measured(ThermalWifiProbe.result(after))

    /**
     * O que gravar quando a pessoa escolhe a segunda família à mão.
     *
     * Separado de [recordableFamily] porque a procedência é outra, e é justamente a procedência que
     * este campo existe para carregar: aqui ninguém mediu nada. A suíte prende este valor a
     * [manuallyChosenProtocol], para as duas constantes não poderem descrever famílias diferentes.
     */
    val manuallyChosenFamily: PrinterWifiConfigurationFamily =
        PrinterWifiConfigurationFamily.CHOSEN_US_ESC_US

    /**
     * Onde a tela abre quando o perfil já responde a pergunta.
     *
     * **Semeia o passo inicial, e não o define continuamente.** [PrinterWifiSetupStage] é estado de
     * sessão de propósito — a queda pós-escrita é o caminho normal desta tela, e derivar o passo de
     * qualquer coisa fora dela apaga a pergunta respondida e o formulário digitado exatamente depois
     * de os bytes saírem. Este lado já cometeu esse erro uma vez, com o passo derivado do alvo.
     * Esta função é chamada uma vez, na construção do estado, e nunca mais.
     *
     * A negativa medida abre em [PrinterWifiSetupStage.Choice], e não em [PrinterWifiSetupStage.Target]:
     * ela é conclusão, não lacuna. Quem já gastou a tira e descobriu que a impressora recusa aquela
     * família precisa ver isso escrito e a escolha à mão ao lado — reoferecer a sonda seria cobrar
     * papel por uma resposta que já existe.
     */
    fun initialStage(family: PrinterWifiConfigurationFamily?): PrinterWifiSetupStage {
        val confirmada = family ?: return PrinterWifiSetupStage.Target
        return confirmada.configuredProtocol?.let { PrinterWifiSetupStage.Form(it) }
            ?: PrinterWifiSetupStage.Choice(ThermalWifiProbeResult.UsWFamilyAbsent)
    }

    /**
     * O que a tela diz quando abriu já respondida.
     *
     * **Ela precisa dizer que a resposta é de antes.** Sem isto, quem entra na tela vê o formulário
     * aberto e não tem como saber se alguma tira saiu agora — e [formProvenanceNotice], que descreve
     * a procedência, está no presente. A frase também nomeia o gesto que remede, porque "começar de
     * novo" só se lê como remedição quando alguém diz que é isso que ele faz.
     *
     * Some assim que a pessoa responde de novo: a partir daí a resposta é desta sessão.
     */
    const val STORED_FAMILY_NOTICE =
        "Esta impressora já tinha respondido isto antes, e a resposta ficou guardada com ela. " +
            "Para medir de novo, toque em começar de novo e imprima a tira."

    /**
     * O que a tela diz quando a leitura não abriu formulário nenhum.
     *
     * No caso indeterminado a frase é a do kit, inteira: ela já explica por que aquilo **não** é
     * resposta, e reescrevê-la faria a mesma medição ter duas palavras. Na negativa o kit não
     * publica frase — o tipo diz "ausente" e mais nada —, então esta é da tela, e ela descreve o que
     * a pessoa viu no papel em vez de nomear formato nenhum.
     *
     * **A negativa precisa de frase justamente por ser o desfecho mais conclusivo dos quatro**: a
     * letra solta é o único que **nega** a família. Este lado desenhava só `indeterminacy`, que é
     * nulo ali, e a pessoa respondia a pergunta e não lia nada — a tela sugerindo que a resposta não
     * valeu.
     */
    fun unconfirmedNotice(result: ThermalWifiProbeResult): String? {
        result.indeterminacy?.let { return it.message }
        return when (result) {
            ThermalWifiProbeResult.UsWFamilyAbsent ->
                "A impressora imprimiu o comando como texto em vez de obedecer: ela não aceita " +
                    "configuração deste jeito."
            // Exaustivo de propósito, como o gêmeo iOS: com `else` um desfecho novo da sonda
            // voltaria a deixar **este** lado da tela mudo, em silêncio — que é exatamente o
            // defeito que esta função foi escrita para consertar.
            ThermalWifiProbeResult.UsWFamilyHonored -> null
            is ThermalWifiProbeResult.Indeterminate -> null
        }
    }

    /**
     * A única família que a pessoa pode escolher à mão.
     *
     * **Não é omissão da sonda, é o que a bancada mediu:** nenhuma leitura de papel a distingue de
     * uma impressora qualquer que engula o prefixo, e a única maneira de "confirmá-la" seria
     * escrever o quadro dela ou travar o parser à espera do terminador — foi o que a bancada fez de
     * propósito em 22/08/2026. Instrumento que precisa quebrar a impressora para medir não é sonda.
     */
    val manuallyChosenProtocol: ThermalWifiProtocol = ThermalWifiProtocol.US_ESC_US

    const val MANUAL_CHOICE_TITLE = "Tentar o outro formato de configuração"

    /**
     * **Sem marca e sem modelo, de propósito.** Nomear o fabricante aqui reabriria o catálogo por
     * modelo — a decisão que este projeto já tomou ao contrário —, e a regra está fixada por literal
     * em duas suítes. Uma impressora entra nesta escolha por alguém decidir, não por estar numa
     * lista.
     */
    const val MANUAL_CHOICE_EXPLANATION =
        "Existe um segundo formato de configuração. Nenhuma tira consegue confirmá-lo: quem o " +
            "entende não responde nada, e quem não o entende também não. Por isso a escolha é sua, " +
            "e não uma medição — e é por isso que o comprovante muda de lugar."

    /** O aviso que acompanha a escolha à mão, e que muda o lugar do comprovante. */
    const val MANUAL_CHOICE_PROOF_WARNING =
        "Impressoras deste formato não imprimem cupom depois de gravar: elas só apitam. Para " +
            "conferir o que ficou gravado, tire o autoteste dela — três cliques no avanço de " +
            "papel — e leia a rede na tira."

    const val MANUAL_CHOICE_BUTTON_TITLE = "Configurar por este formato"

    // --- o formulário ----------------------------------------------------------------------------

    /**
     * O nome do campo muda com o modo porque o campo muda de sentido: em ponto de acesso a rede é
     * criada, em cliente ela é procurada.
     */
    fun ssidFieldLabel(mode: ThermalWifiMode?): String =
        when (mode) {
            ThermalWifiMode.ACCESS_POINT -> "Nome da rede que a impressora vai criar"
            ThermalWifiMode.STATION -> "Nome da rede em que a impressora vai entrar"
            null -> "Nome da rede"
        }

    const val PASSWORD_FIELD_LABEL = "Senha da rede"

    /**
     * A senha fica só enquanto a tela está viva; a frase existe para a pessoa saber disso **antes**
     * de digitar.
     */
    const val PASSWORD_NOTICE =
        "A senha fica somente nesta tela enquanto ela está aberta: não é salva, nem registrada, " +
            "nem mostrada depois."

    const val SECURITY_LABEL = "Segurança da rede"

    const val MODE_LABEL = "Como a impressora vai ficar na rede"

    /**
     * O que abriu este formulário.
     *
     * Pode ser fixa por família sem guardar procedência: a primeira só se alcança pela tira, e a
     * segunda só pela escolha da pessoa — nenhuma leitura de papel abre a segunda. A frase da
     * segunda nega que ali houve medição, porque não houve.
     */
    fun formProvenanceNotice(protocol: ThermalWifiProtocol): String =
        when (protocol) {
            ThermalWifiProtocol.US_W ->
                "A tira identificou como esta impressora aceita configuração."
            ThermalWifiProtocol.US_ESC_US ->
                "Você escolheu este formato: nenhuma tira o confirma, e a impressora não avisa se " +
                    "ele estiver errado."
        }

    /**
     * O que ainda falta escolher, quando falta.
     *
     * **Botão cinza sem frase é o defeito que já travou a lista de impressoras deste kit** em
     * 21/08 — a tela inteira desabilitada, sem uma linha dizendo o que acontecia. Aqui os seletores
     * nascem vazios de propósito, então a tela tem de dizer que estão. `null` quando a régua já pode
     * responder.
     */
    fun pendingChoiceNotice(
        protocol: ThermalWifiProtocol,
        securityChosen: Boolean,
        modeChosen: Boolean,
    ): String? {
        // A ordem é a do formulário: o modo vem antes porque muda o sentido do campo de nome, e
        // perguntar o sentido depois da resposta é o desenho errado.
        if (protocol == ThermalWifiProtocol.US_W && !modeChosen) {
            return "Escolha como a impressora vai ficar na rede."
        }
        return if (securityChosen) null else "Escolha a segurança da rede."
    }

    /** O modo, dito pelo efeito e não pelo byte. */
    fun label(mode: ThermalWifiMode): String =
        when (mode) {
            ThermalWifiMode.ACCESS_POINT -> "Ponto de acesso: a impressora cria a própria rede"
            ThermalWifiMode.STATION -> "Cliente: a impressora entra na rede que você informar"
        }

    /**
     * O que a pessoa perde ao gravar cada modo, dito **antes** de gravar.
     *
     * Medido em 21/08/2026: quem configura pelo ponto de acesso da própria impressora está na rede
     * dela, e ao virar cliente o telefone perde o AP no mesmo instante. Dizer isso depois seria
     * dizer para uma tela que a pessoa já não alcança.
     *
     * **São dois textos porque os dois modos perdem coisas diferentes**, e é isso que o aviso único
     * deste lado errava num ramo: anexado ao modo ponto de acesso ele dizia "essa rede desaparece
     * assim que a impressora entrar na rede nova", e nesse modo a impressora não entra em rede
     * nenhuma — ela cria a própria.
     */
    fun modeWarning(mode: ThermalWifiMode): String =
        when (mode) {
            ThermalWifiMode.STATION ->
                "Se o telefone está conectado à rede da própria impressora agora, ele perde essa " +
                    "rede no instante em que a impressora virar cliente. Reconecte o telefone à " +
                    "rede que você informou aqui."
            ThermalWifiMode.ACCESS_POINT ->
                "A impressora sai da Wi-Fi em que estiver e passa a ter rede própria. Para falar " +
                    "com ela de novo, o telefone precisa entrar nessa rede."
        }

    /**
     * A mesma perda, na família que não tem byte de modo.
     *
     * Ali o quadro grava nome e chave e a impressora entra na rede informada; não há ramo de ponto
     * de acesso a descrever. **O aviso precisa existir nas duas famílias** — quem configura pelo AP
     * da própria impressora perde a rede de qualquer uma delas —, e era só na primeira que o iOS o
     * disparava.
     */
    const val ACCESS_POINT_HANDOFF_NOTICE =
        "Se este telefone está conectado à rede criada pela própria impressora, essa rede " +
            "desaparece assim que a impressora entrar na rede nova. Reconecte o telefone à rede de " +
            "destino para reencontrar a impressora."

    /**
     * Rótulos dos dez valores da outra família, também no vocabulário do roteador.
     *
     * São dez contra os sete da primeira, com fronteiras diferentes — WEP dividido por tamanho de
     * chave, e um modo misto que a outra não tem. É a lista fechada do kit que manda aqui; a tela só
     * a traduz.
     */
    fun label(keyType: ThermalWifiKeyType): String =
        when (keyType) {
            ThermalWifiKeyType.OPEN -> "Rede aberta, sem senha"
            ThermalWifiKeyType.WEP_64 -> "WEP 64"
            ThermalWifiKeyType.WEP_128 -> "WEP 128"
            ThermalWifiKeyType.WPA_AES_PSK -> "WPA (AES)"
            ThermalWifiKeyType.WPA_TKIP_PSK -> "WPA (TKIP)"
            ThermalWifiKeyType.WPA_TKIP_AES_PSK -> "WPA (TKIP e AES)"
            ThermalWifiKeyType.WPA2_AES_PSK -> "WPA2 (AES)"
            ThermalWifiKeyType.WPA2_TKIP -> "WPA2 (TKIP)"
            ThermalWifiKeyType.WPA2_TKIP_AES_PSK -> "WPA2 (TKIP e AES)"
            ThermalWifiKeyType.WPA_WPA2_MIXED_MODE -> "WPA e WPA2 juntos"
        }

    /**
     * Se o segundo gesto pode ser oferecido.
     *
     * `validation` chega `null` enquanto a pessoa não escolheu tudo o que **não tem valor padrão** —
     * segurança nas duas famílias e modo na primeira. Nenhum deles é pré-selecionado de propósito: o
     * modo já foi "corrigido" ao contrário uma vez neste projeto e tirou uma impressora da rede, e a
     * segurança errada custa a mesma unidade. Um seletor que já vem respondido é uma resposta que
     * ninguém deu.
     */
    fun allowsPreparing(
        target: PrinterWifiSetupTarget,
        isSending: Boolean,
        validation: ThermalWifiValidation?,
    ): Boolean {
        if (!target.allowsSending || isSending) return false
        return validation?.byteCount != null
    }

    // --- a contagem anunciada --------------------------------------------------------------------

    /**
     * O que o caminho de envio deste sistema acrescenta antes do quadro, em bytes.
     *
     * **Aqui não é zero, e do outro lado é.** Os quatro caminhos de escrita do transporte —
     * `runReceiptBytes` da rede, e os de BLE, SPP e USB — escrevem o inicializador ESC/POS antes do
     * payload, e o caminho desta tela passa por eles: `openHomologationTarget()` → `openSession()`
     * → `send()` → `sendHomologationProbe` → `run*ReceiptBytes`. Nem a sessão nem a sonda tocam nos
     * bytes; quem prefixa é a porta. No iOS `sendEphemeralCommand` entrega os bytes ao transporte
     * sem tocá-los, e o gêmeo devolve zero.
     *
     * **Isto é lacuna medida, não decisão de tela**, e está escrito aqui para não voltar a passar
     * despercebido: o que a bancada exercitou em papel em 21-22/08 foi o cru, por TCP 9100 a partir
     * de um iPhone — ou seja, o caminho sem prefixo. Enquanto não houver rota de envio crua no host,
     * as duas plataformas emitem bytes diferentes para a mesma impressora no mesmo gesto, e a única
     * coisa que esta tela pode fazer é **anunciar o número verdadeiro de cada uma**. Tirar o prefixo
     * de `run*ReceiptBytes` mudaria toda impressão deste sistema, cupom de venda homologado
     * inclusive, e isso não se faz sem impressora na bancada.
     *
     * Lido do kit, e não escrito à mão: um literal aqui envelheceria separado do que a porta escreve.
     */
    val hostSendPrefixByteCount: Int
        get() = EscPosThermalCommands.initialize().size

    /**
     * O que sai no fio: o quadro mais o que o caminho de envio acrescenta.
     *
     * A tela anuncia **este** número, e não o do quadro. A contagem anunciada é uma medição: um
     * número que não descreve o que sai é uma medição errada, e este lado mentia por dois bytes em
     * dois portões enquanto a suíte fixava a contagem contra o quadro em vez de contra o fio.
     */
    fun announcedByteCount(frameByteCount: Int): Int = frameByteCount + hostSendPrefixByteCount

    /**
     * O tamanho do envio, dito antes do gesto. É o que dá para mostrar sem repetir o segredo na tela
     * — a mesma razão pela qual `ThermalWifiValidation` carrega a contagem e não o quadro.
     */
    fun byteCountNotice(frameByteCount: Int): String =
        "A configuração sai em ${announcedByteCount(frameByteCount)} bytes, num envio só."

    // --- o portão de dois gestos ------------------------------------------------------------------

    /** O título já carrega a contagem, como o portão do comando cru carrega a dele. */
    fun confirmationTitle(frameByteCount: Int): String =
        "Confirmar ${announcedByteCount(frameByteCount)} bytes"

    /**
     * O mesmo rótulo do portão do comando cru, nas duas plataformas: é o vocabulário já estabelecido
     * para "vou mandar bytes que gravam configuração não volátil". O painel de comando cru **deste
     * módulo** já usava esta frase, e o painel novo divergia até do vizinho de tela.
     */
    const val CONFIRM_BUTTON_TITLE = "Conheço o efeito e a reversão"

    const val CANCEL_BUTTON_TITLE = "Cancelar"

    const val PREPARE_BUTTON_TITLE = "Revisar e gravar a rede"

    /**
     * O aviso do portão, montado do que cada família mede.
     *
     * **O comprovante é o papel, nunca a tela.** Depois do envio o app não vê resposta nenhuma: uma
     * família imprime o cupom com o que ficou gravado, a outra só apita.
     *
     * **Só a família com cupom promete a janela de correção.** Ela foi medida numa família só, em
     * 21/08/2026, quando um nome de rede errado tirou a unidade da rede assim que ela reiniciou.
     * Repeti-la na outra transformaria falta de medição em medição — é a mesma regra do AGENTS.md
     * que separa `null` medido de lacuna, e ela vale mais que a simetria da frase. Era o iOS que
     * prometia a janela nas duas.
     */
    fun confirmationWarning(
        protocol: ThermalWifiProtocol,
        mode: ThermalWifiMode?,
    ): String {
        val partes = mutableListOf("A rede é gravada agora, e a conexão vai cair no meio — isso é o normal, não é falha.")
        when (protocol) {
            ThermalWifiProtocol.US_W -> {
                partes +=
                    "O comprovante é o cupom que a impressora imprime na hora, com o modo, o nome " +
                        "da rede e a senha que ficaram gravados. Confira esse cupom: enquanto ela " +
                        "não reiniciar, dá para reenviar corrigido. A rede nova só passa a valer " +
                        "quando você desligar e ligar a impressora — e se o nome estiver errado, é " +
                        "esse boot que tira ela do ar."
                // O aviso do modo cobre a perda do ponto de acesso nos dois sentidos; o texto
                // genérico seria falso no ramo em que a impressora **cria** a rede em vez de entrar
                // numa.
                if (mode != null) partes += modeWarning(mode)
            }
            ThermalWifiProtocol.US_ESC_US -> {
                partes += MANUAL_CHOICE_PROOF_WARNING
                partes += "Se o nome da rede sair errado, a impressora sai da rede."
                // Aqui não há byte de modo: a impressora entra na rede informada, e é o único ramo
                // em que "entrar na rede nova" é verdade sem ressalva.
                partes += ACCESS_POINT_HANDOFF_NOTICE
            }
        }
        return partes.joinToString(" ")
    }

    // --- depois do envio --------------------------------------------------------------------------

    /**
     * O desfecho do envio, e ele nunca afirma o que saiu no papel.
     *
     * Nem o sucesso nem a queda provam papel, e aqui é pior: o quadro derruba o canal que o
     * entregou. Por isso a queda não repete envio sozinha e não nega a gravação; ela manda olhar o
     * papel, igual ao sucesso. O único desfecho em que reenviar é seguro sem olhar o papel é aquele
     * em que a escrita não começou.
     */
    fun sendOutcomeNotice(
        dispatch: PrinterWifiDispatch,
        protocol: ThermalWifiProtocol,
    ): String =
        when (dispatch) {
            PrinterWifiDispatch.NO_TARGET -> NO_TARGET_AT_GESTURE
            PrinterWifiDispatch.NOT_SENT ->
                "Nada saiu deste telefone: a rede da impressora não foi alterada. Confira a " +
                    "conexão e mande de novo."
            PrinterWifiDispatch.REACHED_PRINTER ->
                when (protocol) {
                    ThermalWifiProtocol.US_W ->
                        "Os bytes começaram a sair. O comprovante é o papel: procure o cupom com " +
                            "o modo, o nome da rede e a senha gravados. Confira esse cupom agora — " +
                            "enquanto ela não reiniciar, dá para mandar de novo corrigido. Quando " +
                            "estiver certo, desligue e ligue a impressora: a rede nova só vale " +
                            "depois disso. E se estiver errado, o próximo boot tira ela do ar."
                    ThermalWifiProtocol.US_ESC_US ->
                        "Os bytes começaram a sair. O comprovante é o papel. Se ela for deste " +
                            "formato, só apita: tire o autoteste dela, com três cliques no avanço " +
                            "de papel, para ver a rede gravada."
                }
        }

    /**
     * Quando a tela não conseguiu montar o quadro apesar de a régua ter aceitado os campos.
     *
     * **Não é recusa, e não pode ganhar frase de recusa.** As frases de recusa são da camada de
     * quadro e dizem o limite do campo; esta diz que a tela errou, e que nenhum byte saiu. A frase
     * nomeia o culpado de propósito: traduzi-la em "confira os dados" mandaria a pessoa caçar erro
     * num formulário correto.
     */
    const val FRAME_CONSTRUCTION_FAILURE =
        "A régua aceitou os campos e o quadro não foi montado. Isto é falha do aplicativo, não dos " +
            "dados informados: nada foi enviado à impressora."
}
