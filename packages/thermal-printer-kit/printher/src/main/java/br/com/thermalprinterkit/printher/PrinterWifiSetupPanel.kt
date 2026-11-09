package br.com.thermalprinterkit.printher

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.thermalprinterkit.PrinterHomologationHost
import br.com.thermalprinterkit.PrinterWifiConfigurationFamily
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.ThermalPrinterState
import br.com.thermalprinterkit.ThermalWifiFrame
import br.com.thermalprinterkit.ThermalWifiKeyType
import br.com.thermalprinterkit.ThermalWifiMode
import br.com.thermalprinterkit.ThermalWifiProbe
import br.com.thermalprinterkit.ThermalWifiProbeReading
import br.com.thermalprinterkit.ThermalWifiProtocol
import br.com.thermalprinterkit.ThermalWifiValidation
import br.com.thermalprinterkit.byteCount
import br.com.thermalprinterkit.recordWifiConfigurationFamily
import br.com.thermalprinterkit.rejection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Grava a rede Wi-Fi dentro da impressora, a partir de campos tipados.
 *
 * Gêmeo de `ios/Printher/PrinterWifiSetupView.swift`. As regras e as frases moram em
 * [PrinterWifiSetupContract], que é gêmeo do contrato de lá; este painel só desenha o que aquele
 * contrato decide, e **não escreve nenhuma frase própria** — frase escrita aqui fica fora das
 * afirmações de segurança da suíte.
 *
 * **Por que ela mora no kit e não no app.** Tem dois públicos, como o comando cru: nós, com hardware
 * na bancada, e quem está travado com um modelo que nunca teremos. E tem uma razão a mais, esta
 * cara: em 21/08/2026 um quadro de configuração foi digitado à mão no painel de comando cru, faltou
 * um byte, o frame deslocado gravou assim mesmo — SSID truncado — e a unidade saiu da rede. **Não
 * existe caminho de hexadecimal digitado aqui**: os bytes só nascem de [ThermalWifiFrame], a partir
 * de campos que já passaram pela régua do kit.
 *
 * O fluxo tem quatro passos — ver [PrinterWifiSetupStage] — e eles são **estado de sessão**, não uma
 * função do alvo. A tela **não some** quando não há alvo: explicar o que falta é justamente o
 * trabalho dela ali. Ela some só quando o hospedeiro não oferece sessão efêmera nenhuma, no
 * precedente de [PrinterTransportPanel]: sem essa capacidade não há gesto possível, e um painel
 * permanentemente inerte só ensinaria que o kit está quebrado.
 *
 * **Escopo desta versão:** a família sem resposta de volta entra apenas pelo quadro que grava
 * somente Wi-Fi. O quadro completo dela reescreve IP, máscara e gateway sempre — não existe "não
 * mexa neste campo" — e endereço errado tira a impressora da rede sem DHCP para socorrer.
 */
@Composable
fun PrinterWifiSetupPanel(
    printer: ThermalPrinter,
    modifier: Modifier = Modifier,
) {
    val host = printer as? PrinterHomologationHost ?: return
    val scope = rememberCoroutineScope()
    val state by printer.state.collectAsStateWithLifecycle()
    val adopted by printer.adoptedPrinters.collectAsStateWithLifecycle()

    // Uma leitura por desenho, como o painel de comando cru do iOS faz com `canSendEphemeralCommand`.
    // O valor é sempre de um desenho atrás, e por isso o gesto relê antes de tocar no transporte.
    //
    // Os três sinais são o que **este** sistema consegue publicar de dentro de uma `@Composable`:
    // a candidata retida é o estado que o kit levanta quando uma foi testada e o papel ainda não foi
    // confirmado, e a permissão de envio é a instalação marcada como a que recebe. Alcançabilidade
    // real, que o iOS mede, aqui exigiria abrir `mutex` no desenho. Ver [PrinterWifiSetupTarget].
    val alvo =
        PrinterWifiSetupContract.target(
            hasEphemeralCandidate = state is ThermalPrinterState.SearchConfirmationRequired,
            canSend = adopted.any { it.active },
            hasAdoptedPrinter = adopted.isNotEmpty(),
        )

    /*
     * O perfil que recebe a resposta — e `null` quando não dá para saber qual é.
     *
     * **Com candidata retida, isto é `null`**, e é a correção mais importante desta camada. Os
     * bytes saem pela candidata; o perfil dela só existe depois da adoção. Ler ou gravar no da
     * instalada significaria medir uma impressora e guardar a resposta no perfil de outra — a tela
     * mostrando uma e o disco guardando a outra.
     *
     * É a mesma classe de defeito que a revisão pegou no comando cru em 21/08, quando a queda para
     * a adotada não era escopada ao transporte e os bytes saíam pela impressora errada.
     */
    val idDoPerfilAlvo =
        if (alvo == PrinterWifiSetupTarget.EPHEMERAL_CANDIDATE) {
            null
        } else {
            adopted.firstOrNull { it.active }?.profileId
        }

    // O passo é estado de sessão e **não** é derivado do alvo nem do perfil: perder o alvo fecha os
    // botões e deixa a frase do alvo visível, mas não apaga a pergunta respondida nem o formulário
    // digitado. A queda pós-escrita é o caminho normal desta tela, e ela derruba o alvo.
    var stage by remember { mutableStateOf<PrinterWifiSetupStage>(PrinterWifiSetupStage.Target) }

    // Enquanto o passo desenhado for o que veio do perfil, e não uma resposta desta sessão.
    var mostraFraseDoPerfil by remember { mutableStateOf(false) }

    // Um só conjunto de campos, e não um por família: trocar de família não pode apagar o nome da
    // rede já digitado, que costuma ser o mesmo nos dois formatos. A senha é a exceção, e sai em
    // toda troca — segredo guardado para um formulário que a pessoa deixou é segredo guardado à toa.
    //
    // `remember` puro, nunca `rememberSaveable`: o `Bundle` sobrevive à morte do processo, e isso
    // seria persistir a senha do cliente com outro nome.
    var ssid by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var security by remember { mutableStateOf<PrinterWifiSecurityChoice?>(null) }
    var keyType by remember { mutableStateOf<ThermalWifiKeyType?>(null) }
    var mode by remember { mutableStateOf<ThermalWifiMode?>(null) }

    var pending by remember { mutableStateOf<PrinterWifiPendingFrame?>(null) }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }

    /*
     A resposta que a impressora já deu antes, lida do perfil dela.

     **Semeia o passo, e não o define.** O efeito roda uma vez — chave `Unit` —, e só semeia
     enquanto ninguém mexeu na tela: o passo continua sendo estado de sessão, e o que o disco faz é
     dar o valor inicial dele. Derivar o passo de qualquer coisa fora da sessão traria de volta o
     defeito que este lado já teve, com a pergunta respondida apagada a cada perda de alvo.

     **Fora da composição e fora da thread principal**, na política já escrita em
     `ThermalPrinterScreen`: "Store é síncrono e pode tocar disco". Aqui vale ainda mais, porque a
     primeira leitura depois de uma atualização de formato regrava o registro inteiro.

     Só a instalada e ativa tem perfil para consultar: a candidata retida vive em memória e o perfil
     dela nunca foi persistido. Sem perfil, a tela abre como sempre abriu.
     */
    // Chaveado pelo id — e não por `Unit` — porque `adoptedPrinters` nasce vazia e é publicada
    // depois, de dentro da corrotina de restauração. Com `Unit` a semeadura roda uma vez, na
    // primeira composição, e numa abertura fria lê a lista vazia: a família gravada existiria em
    // disco e a tela abriria como se nunca tivesse sido medida.
    //
    // A chave inclui a candidata retida de propósito: quando ela some, o perfil da instalada volta
    // a ser o alvo legítimo e a semeadura precisa rodar.
    LaunchedEffect(idDoPerfilAlvo) {
        val gravada =
            withContext(Dispatchers.IO) {
                val id = idDoPerfilAlvo ?: return@withContext null
                runCatching {
                    host.profileStore.read().firstOrNull { it.id == id }?.wifiConfigurationFamily
                }.getOrNull()
            } ?: return@LaunchedEffect
        // A leitura pode voltar depois do primeiro toque. Sobrescrever o que a pessoa acabou de
        // responder — ou a tira que ela mandou imprimir — seria pior que não semear.
        if (stage == PrinterWifiSetupStage.Target && !busy) {
            stage = PrinterWifiSetupContract.initialStage(gravada)
            mostraFraseDoPerfil = true
        }
    }

    // Sair da tela zera o quadro pendente e esquece a senha, no contrato do
    // `.onDisappear { model.forgetSecret() }` do iOS: buffer com segredo não sobrevive à tela que o
    // montou, e a senha é do cliente.
    DisposableEffect(Unit) {
        onDispose {
            pending?.clear()
            pending = null
            password = ""
        }
    }

    val familia = (stage as? PrinterWifiSetupStage.Form)?.protocol

    /** A régua é a da camada de quadro, chamada e não reconstruída. */
    val validacao: ThermalWifiValidation? =
        when (familia) {
            ThermalWifiProtocol.US_W -> {
                val escolhida = security
                if (escolhida == null || mode == null) {
                    null
                } else {
                    // A senha vai **como está** para a régua, e não é apagada aqui conforme o ramo.
                    // Quem decide se ela cabe é o tipo do kit. Filtrar antes faria régua e
                    // construtor receberem entradas diferentes — e aí "a régua aceitou e o quadro
                    // não montou" deixaria de ser sinal de defeito para virar comportamento normal.
                    ThermalWifiFrame.validate(ssid, escolhida.security(password))
                }
            }
            ThermalWifiProtocol.US_ESC_US ->
                keyType?.let { ThermalWifiFrame.validate(it, ssid, password) }
            null -> null
        }

    /**
     * Volta à pergunta sem gastar outra tira. A tira já saiu; o que se desfaz é a resposta.
     *
     * **A senha sai junto, e o resto do formulário fica.** Esta é a única porta de saída de um
     * formulário fora do recomeço, e portanto o único caminho para trocar de família: o nome da rede
     * costuma servir aos dois formatos, mas segredo guardado para um formulário que a pessoa deixou
     * é segredo guardado à toa.
     */
    val responderDeNovo = {
        pending?.clear()
        pending = null
        stage = PrinterWifiSetupStage.Reading
        mostraFraseDoPerfil = false
        password = ""
        notice = null
        failed = false
    }

    /**
     * Desce a resposta ao perfil da impressora em uso, quando há perfil.
     *
     * **Não vira frase de tela, nem em caso de falha.** A resposta continua valendo na sessão de
     * qualquer jeito — o passo já avançou —, e a única coisa que se perde sem perfil é a
     * sobrevivência ao fechamento do app. O que a tela nunca faz é o contrário, afirmar que gravou.
     *
     * O `null` chega aqui de propósito, e é o caso indeterminado: ele existe para ser recusado num
     * lugar só, em vez de cada chamador lembrar de não gravá-lo.
     *
     * **Fora da thread principal**, como a leitura: gravar comita o registro inteiro em disco, e a
     * política deste módulo já diz que o store é síncrono e toca disco.
     */
    val gravarFamilia = { familia: PrinterWifiConfigurationFamily? ->
        val id = idDoPerfilAlvo
        if (familia != null && id != null) {
            // **Sem `scope.launch`.** O escopo da composição morre quando o painel sai de cena, e
            // os dois gestos que gravam — responder a leitura e escolher a família à mão — são
            // exatamente os que a pessoa costuma seguir de sair da tela. A corrotina seria
            // cancelada antes de rodar e nada chegaria ao disco, sem erro e sem aviso.
            //
            // `recordWifiConfigurationFamily` já é síncrono e `@Synchronized`. Gravar aqui bloqueia
            // o desenho por uma escrita de registro, que é o mesmo custo que o store já cobra de
            // quem adota uma impressora — e é preferível a uma resposta de papel perdida.
            runCatching { host.profileStore.recordWifiConfigurationFamily(familia, id) }
        }
        Unit
    }

    /**
     * Volta ao começo e esquece tudo: outra impressora pode ser outra família.
     *
     * **O que fica no perfil não é apagado aqui.** Aquela resposta custou uma tira de papel, e um
     * toque em "começar de novo" não é motivo para jogá-la fora — ela é substituída quando a pessoa
     * responder de novo, que é o que este gesto abre caminho para fazer.
     */
    val recomecar = {
        pending?.clear()
        pending = null
        stage = PrinterWifiSetupStage.Target
        mostraFraseDoPerfil = false
        ssid = ""
        password = ""
        security = null
        keyType = null
        mode = null
        notice = null
        failed = false
    }

    /**
     * O gesto que gasta papel, num lugar só.
     *
     * `busy` é desligado no `finally` da corrotina: sem isso, qualquer escape deixava o painel com
     * todos os botões desabilitados e sem uma linha dizendo o que houve — tela cinza permanente, que
     * é exatamente o defeito de 21/08 que [PrinterUnitAvailability] existe para não repetir.
     */
    val mandarATira = {
        notice = null
        failed = false
        // Fecha o botão no mesmo gesto: a tira custa papel, e dois toques seguidos gastariam duas
        // sem responder nada a mais.
        busy = true
        scope.launch {
            try {
                // A tira é lida do kit no instante do envio: aqui o `val` tem getter que devolve
                // cópia nova, e guardar a referência daria a qualquer um a chance de editá-la antes
                // do próximo envio.
                val desfecho = dispatchWifiBytes(host, ThermalWifiProbe.usWFamilyStrip)
                notice = PrinterWifiSetupContract.probeDispatchNotice(desfecho)
                failed = desfecho != PrinterWifiDispatch.REACHED_PRINTER
                // Só o despacho que chegou à impressora abre a pergunta. A leitura continua vindo
                // da pessoa olhando o papel, e de mais nada.
                PrinterWifiSetupContract.stageAfterProbe(desfecho)?.let { stage = it }
            } finally {
                busy = false
            }
        }
        Unit
    }

    PrinterDiagnosticsPanel(PrinterWifiSetupContract.PANEL_TITLE, modifier) {
        Text(PrinterWifiSetupContract.INTRO_NOTICE)
        Text(
            PrinterWifiSetupContract.targetNotice(alvo),
            modifier = Modifier.testTag("printer.diagnostics.wifi.target"),
        )

        // Só enquanto a resposta for a de antes: a partir da primeira resposta desta sessão, a
        // frase deixa de ser verdade.
        if (mostraFraseDoPerfil) {
            Text(
                PrinterWifiSetupContract.STORED_FAMILY_NOTICE,
                modifier = Modifier.testTag("printer.diagnostics.wifi.stored"),
            )
        }

        when (val passo = stage) {
            PrinterWifiSetupStage.Target -> {
                Text(PrinterWifiSetupContract.probeExplanation)
                Text(PrinterWifiSetupContract.probePaperCostNotice)
                Text(PrinterWifiSetupContract.portOutageNotice)
                WifiProbeButton(
                    label = PrinterWifiSetupContract.PROBE_BUTTON_TITLE,
                    tag = "printer.diagnostics.wifi.probe",
                    enabled = !busy && alvo.allowsSending,
                    onClick = mandarATira,
                )
            }

            PrinterWifiSetupStage.Reading -> {
                Text(
                    PrinterWifiSetupContract.READING_QUESTION,
                    style = MaterialTheme.typography.titleSmall,
                )
                // As frases são as do kit, e não as da tela: leitura que muda de palavra entre as
                // plataformas é outra medição. Elas interpolam os marcadores da própria tira.
                ThermalWifiProbeReading.entries.forEach { leitura ->
                    WifiChoiceButton(
                        label = leitura.label,
                        tag = "printer.diagnostics.wifi.reading.${leitura.name}",
                        selected = false,
                        enabled = !busy,
                        onClick = {
                            notice = null
                            failed = false
                            stage = PrinterWifiSetupContract.stage(leitura)
                            mostraFraseDoPerfil = false
                            // A resposta desce ao perfil aqui, e só aqui: depois de a pessoa
                            // responder, nunca antes de a tira sair. Os dois indeterminados
                            // devolvem `null` e não gravam nada — "não saiu nada" não é resposta
                            // sobre a impressora.
                            gravarFamilia(PrinterWifiSetupContract.recordableFamily(leitura))
                        },
                    )
                }
                WifiProbeButton(
                    label = PrinterWifiSetupContract.PROBE_AGAIN_BUTTON_TITLE,
                    tag = "printer.diagnostics.wifi.probe.again",
                    enabled = !busy && alvo.allowsSending,
                    onClick = mandarATira,
                )
            }

            is PrinterWifiSetupStage.Choice -> {
                // A dúvida tem frase própria no kit e a negativa tem frase própria da tela: a letra
                // solta é o único desfecho que **nega** a família, e ficar mudo ali sugeria que a
                // resposta não valeu.
                PrinterWifiSetupContract.unconfirmedNotice(passo.result)?.let {
                    Text(it, modifier = Modifier.testTag("printer.diagnostics.wifi.unconfirmed"))
                }
                // As duas saídas baratas vêm antes da decisão pesada. A tira custa papel; responder
                // de novo não custa nenhum, e é o caminho de quem só errou o botão.
                WifiProbeButton(
                    label = PrinterWifiSetupContract.PROBE_AGAIN_BUTTON_TITLE,
                    tag = "printer.diagnostics.wifi.probe.again",
                    enabled = !busy && alvo.allowsSending,
                    onClick = mandarATira,
                )
                TextButton(
                    onClick = responderDeNovo,
                    enabled = !busy,
                    modifier = Modifier.testTag("printer.diagnostics.wifi.answer.again"),
                ) {
                    Text(PrinterWifiSetupContract.ANSWER_AGAIN_BUTTON_TITLE)
                }
                Text(
                    PrinterWifiSetupContract.MANUAL_CHOICE_TITLE,
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(PrinterWifiSetupContract.MANUAL_CHOICE_EXPLANATION)
                Text(PrinterWifiSetupContract.MANUAL_CHOICE_PROOF_WARNING)
                Button(
                    onClick = {
                        notice = null
                        failed = false
                        stage =
                            PrinterWifiSetupStage.Form(
                                PrinterWifiSetupContract.manuallyChosenProtocol,
                            )
                        mostraFraseDoPerfil = false
                        // Escolha da pessoa, gravada como escolha: o perfil registra que ninguém
                        // mediu isto, e é essa distinção que impede uma sessão futura de ler
                        // declaração como medição.
                        gravarFamilia(PrinterWifiSetupContract.manuallyChosenFamily)
                    },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().testTag("printer.diagnostics.wifi.manual"),
                ) {
                    Text(PrinterWifiSetupContract.MANUAL_CHOICE_BUTTON_TITLE)
                }
            }

            is PrinterWifiSetupStage.Form -> {
                Text(PrinterWifiSetupContract.formProvenanceNotice(passo.protocol))

                if (passo.protocol == PrinterWifiSetupContract.manuallyChosenProtocol) {
                    Text(PrinterWifiSetupContract.MANUAL_CHOICE_PROOF_WARNING)
                    // Dito antes do envio, e não depois: quem configura pela rede que a própria
                    // impressora cria perde essa rede assim que ela entra na rede nova. Nesta
                    // família não há byte de modo, então é o único efeito possível.
                    Text(PrinterWifiSetupContract.ACCESS_POINT_HANDOFF_NOTICE)
                }

                // O modo vem antes do nome da rede porque ele muda o sentido do campo seguinte: em
                // ponto de acesso a rede é criada, em cliente ela é procurada. Perguntar o sentido
                // depois da resposta é o desenho errado.
                if (passo.protocol == ThermalWifiProtocol.US_W) {
                    Text(
                        PrinterWifiSetupContract.MODE_LABEL,
                        style = MaterialTheme.typography.titleSmall,
                    )
                    // A ordem é a do kit, que põe o ponto de acesso primeiro — ele o chama de rota
                    // de volta garantida. Pôr o modo cliente na frente é oferecer primeiro o modo
                    // que derruba o ponto de acesso pelo qual a pessoa pode estar conectada.
                    ThermalWifiMode.entries.forEach { escolha ->
                        WifiChoiceButton(
                            label = PrinterWifiSetupContract.label(escolha),
                            tag = "printer.diagnostics.wifi.mode.${escolha.name}",
                            selected = escolha == mode,
                            enabled = !busy,
                            onClick = {
                                notice = null
                                mode = escolha
                            },
                        )
                    }
                    mode?.let { Text(PrinterWifiSetupContract.modeWarning(it)) }
                }

                val rotuloDoNome =
                    PrinterWifiSetupContract.ssidFieldLabel(
                        if (passo.protocol == ThermalWifiProtocol.US_W) mode else null,
                    )
                OutlinedTextField(
                    value = ssid,
                    onValueChange = {
                        ssid = it
                        notice = null
                    },
                    label = { Text(rotuloDoNome) },
                    singleLine = true,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth().testTag("printer.diagnostics.wifi.ssid"),
                )

                Text(
                    PrinterWifiSetupContract.SECURITY_LABEL,
                    style = MaterialTheme.typography.titleSmall,
                )
                // Nada vem pré-selecionado: escolher segurança por padrão é a mesma classe de
                // suposição que o projeto recusou ao não fazer catálogo por modelo. E são duas
                // listas, não uma com um `if`: sete ramos contra dez posições, com fronteiras
                // diferentes.
                var pedeSenha = false
                if (passo.protocol == ThermalWifiProtocol.US_W) {
                    PrinterWifiSecurityChoice.entries.forEach { escolha ->
                        WifiChoiceButton(
                            label = escolha.label,
                            tag = "printer.diagnostics.wifi.security.${escolha.name}",
                            selected = escolha == security,
                            enabled = !busy,
                            onClick = {
                                notice = null
                                security = escolha
                                // Rede sem chave não tem onde guardar senha neste quadro — o
                                // firmware descarta —, então apagar é melhor que carregar um
                                // segredo que sairia no fio para nada.
                                if (!escolha.requiresPassword) password = ""
                            },
                        )
                    }
                    pedeSenha = security?.requiresPassword == true
                } else {
                    ThermalWifiKeyType.entries.forEach { tipo ->
                        WifiChoiceButton(
                            label = PrinterWifiSetupContract.label(tipo),
                            tag = "printer.diagnostics.wifi.keytype.${tipo.name}",
                            selected = tipo == keyType,
                            enabled = !busy,
                            onClick = {
                                notice = null
                                keyType = tipo
                                // Aqui o quadro sempre emite o campo de senha, e a régua do kit
                                // recusa chave em rede aberta. Apagar evita a recusa e evita mandar
                                // segredo em claro para nada.
                                if (!tipo.requiresPassword) password = ""
                            },
                        )
                    }
                    pedeSenha = keyType?.requiresPassword == true
                }

                if (pedeSenha) {
                    WifiPasswordField(password, busy) {
                        password = it
                        notice = null
                    }
                }

                // Enquanto falta escolha, a régua não tem o que responder — e botão cinza sem frase
                // é o defeito que já travou a lista de impressoras deste kit.
                PrinterWifiSetupContract.pendingChoiceNotice(
                    protocol = passo.protocol,
                    securityChosen =
                        if (passo.protocol == ThermalWifiProtocol.US_W) {
                            security != null
                        } else {
                            keyType != null
                        },
                    modeChosen = mode != null,
                )?.let { Text(it, modifier = Modifier.testTag("printer.diagnostics.wifi.pending")) }

                // A recusa vem pronta em pt-BR da camada de quadro; a tela mostra como está.
                validacao?.rejection?.let {
                    Text(it.message, modifier = Modifier.testTag("printer.diagnostics.wifi.rejection"))
                }
                validacao?.byteCount?.let { Text(PrinterWifiSetupContract.byteCountNotice(it)) }

                Button(
                    onClick = {
                        notice = null
                        failed = false
                        val bytes =
                            when (passo.protocol) {
                                ThermalWifiProtocol.US_W -> {
                                    val escolhida = security
                                    val modo = mode
                                    // Os mesmos campos que a régua acabou de aceitar, sem filtro no
                                    // meio: `null` aqui é inconsistência entre régua e construtor, e
                                    // não recusa de campo.
                                    if (escolhida == null || modo == null) {
                                        null
                                    } else {
                                        ThermalWifiFrame.usW(ssid, escolhida.security(password), modo)
                                    }
                                }
                                // Só o quadro que grava rede. O que reescreve IP, máscara e gateway
                                // fica de fora desta tela.
                                ThermalWifiProtocol.US_ESC_US ->
                                    keyType?.let {
                                        ThermalWifiFrame.usEscUsWifiOnly(it, ssid, password)
                                    }
                            }
                        if (bytes == null) {
                            failed = true
                            notice = PrinterWifiSetupContract.FRAME_CONSTRUCTION_FAILURE
                        } else {
                            pending?.clear()
                            pending =
                                PrinterWifiPendingFrame(
                                    bytes,
                                    PrinterWifiSetupContract.confirmationWarning(
                                        passo.protocol,
                                        if (passo.protocol == ThermalWifiProtocol.US_W) mode else null,
                                    ),
                                )
                            // A senha deixa a tela assim que o quadro existe, no molde do
                            // `hexText = ""` do comando cru: daqui em diante ela vive num buffer só,
                            // que é zerado no fim do envio. Entre este gesto e a confirmação há um
                            // diálogo aberto por tempo indefinido.
                            password = ""
                        }
                    },
                    enabled =
                        PrinterWifiSetupContract.allowsPreparing(alvo, busy, validacao),
                    modifier = Modifier.fillMaxWidth().testTag("printer.diagnostics.wifi.prepare"),
                ) {
                    Text(PrinterWifiSetupContract.PREPARE_BUTTON_TITLE)
                }

                // Voltar à pergunta sem gastar outra tira: o formulário aberto pela tira pode ter
                // vindo de uma leitura errada, e a correção não pode custar papel novo.
                TextButton(
                    onClick = responderDeNovo,
                    enabled = !busy,
                    modifier = Modifier.testTag("printer.diagnostics.wifi.form.answer.again"),
                ) {
                    Text(PrinterWifiSetupContract.ANSWER_AGAIN_BUTTON_TITLE)
                }
            }
        }

        if (busy) Text(PrinterWifiSetupContract.SENDING_NOTICE)
        notice?.let { Text(it, modifier = Modifier.testTag("printer.diagnostics.wifi.notice")) }
        if (stage != PrinterWifiSetupStage.Target) {
            TextButton(
                onClick = recomecar,
                enabled = !busy,
                modifier = Modifier.testTag("printer.diagnostics.wifi.restart"),
            ) {
                Text(PrinterWifiSetupContract.RESTART_BUTTON_TITLE)
            }
        }
    }

    pending?.let { quadro ->
        AlertDialog(
            onDismissRequest = {
                quadro.clear()
                pending = null
            },
            // O título carrega a contagem do que sai **no fio**, e não a do quadro: ver
            // [PrinterWifiSetupContract.announcedByteCount].
            title = { Text(PrinterWifiSetupContract.confirmationTitle(quadro.byteCount)) },
            text = { Text(quadro.warning) },
            confirmButton = {
                Button(
                    onClick = {
                        // O quadro é relido e soltado no mesmo gesto, em vez de vir do `let`: ele é
                        // consumível uma vez só, e um segundo toque no mesmo desenho encontraria um
                        // buffer já zerado. Assim o segundo toque simplesmente não acha nada.
                        val quadroAtual = pending
                        // A família vem do passo, e não de um padrão escolhido no diálogo: um
                        // padrão ali mandaria o quadro de uma família e anunciaria o comprovante da
                        // outra.
                        val protocolo = (stage as? PrinterWifiSetupStage.Form)?.protocol
                        pending = null
                        notice = null
                        failed = false
                        if (quadroAtual != null && protocolo != null) {
                            busy = true
                            scope.launch {
                                try {
                                    var desfecho = PrinterWifiDispatch.NO_TARGET
                                    // O buffer é zerado no `finally` de `sendWith`, dê no que der.
                                    quadroAtual.sendWith { bytes ->
                                        desfecho = dispatchWifiBytes(host, bytes)
                                    }
                                    notice =
                                        PrinterWifiSetupContract.sendOutcomeNotice(
                                            dispatch = desfecho,
                                            protocol = protocolo,
                                        )
                                    failed = desfecho != PrinterWifiDispatch.REACHED_PRINTER
                                } finally {
                                    busy = false
                                }
                            }
                        }
                    },
                    enabled = !busy,
                    modifier = Modifier.testTag("printer.diagnostics.wifi.confirm"),
                ) {
                    Text(PrinterWifiSetupContract.CONFIRM_BUTTON_TITLE)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        quadro.clear()
                        pending = null
                    },
                ) {
                    Text(PrinterWifiSetupContract.CANCEL_BUTTON_TITLE)
                }
            },
        )
    }
}

/**
 * Entrega os bytes e devolve só o que dá para afirmar sobre eles.
 *
 * O desfecho do transporte **não** vira sucesso nem fracasso aqui: tanto a tira quanto o quadro
 * rodam o emissor AT do módulo, que derruba o modo transparente e, com ele, a conexão que os
 * entregou. Falha depois da escrita é o caminho normal. Quem classifica é
 * [PrinterWifiSetupContract.dispatch], sobre `ThermalPrintDelivery` — o único sinal que o kit tem
 * para separar "não começou a escrever" de "começou, e o resto está no papel".
 *
 * **Abrir a sessão fica dentro do `try`, e falha ali conta como escrita que não começou.** Fora
 * dele, uma exceção de `openSession()` subia por esta função e saía da corrotina sem passar por
 * `busy = false` nem por frase nenhuma: o painel ficava com todos os botões desabilitados e sem uma
 * linha dizendo o que houve. É o defeito de 21/08 que [PrinterUnitAvailability] existe para não
 * repetir. E o desfecho é `NOT_SENT` porque abrir a sessão é anterior a qualquer escrita — chamá-lo
 * de "pode ter chegado" abriria a pergunta do papel sem papel nenhum.
 */
private suspend fun dispatchWifiBytes(
    host: PrinterHomologationHost,
    bytes: ByteArray,
): PrinterWifiDispatch {
    val target =
        try {
            host.openHomologationTarget()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            // A resolução do alvo acontece antes de qualquer escrita: se ela falhou, nada saiu.
            null
        } ?: return PrinterWifiDispatch.NO_TARGET
    val session =
        try {
            target.openSession()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            return PrinterWifiDispatch.NOT_SENT
        }
    return try {
        PrinterWifiSetupContract.dispatch(session.send(bytes))
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        PrinterWifiSetupContract.dispatchOfUnexpectedFailure()
    } finally {
        session.close()
    }
}

@Composable
private fun WifiPasswordField(
    value: String,
    busy: Boolean,
    onValueChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(PrinterWifiSetupContract.PASSWORD_FIELD_LABEL) },
        singleLine = true,
        enabled = !busy,
        // A chave é do cliente: ela não aparece em claro na tela, nem em hexadecimal em lugar
        // nenhum, nem em log, nem em descrição de erro.
        //
        // `PasswordVisualTransformation` mascara pixel e mais nada. Sem dizer ao teclado que isto é
        // senha, o IME trata como texto comum: entra no dicionário de aprendizado pessoal, aparece
        // na barra de sugestões e pode ser proposta noutro app. Mascarar a tela e vazar para o
        // teclado seria proteger a metade que não importa.
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions =
            KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrect = false),
        modifier = Modifier.fillMaxWidth().testTag("printer.diagnostics.wifi.password"),
    )
    Text(PrinterWifiSetupContract.PASSWORD_NOTICE)
}

/** O gesto que gasta papel. Preenchido, porque é o que a pessoa veio fazer. */
@Composable
private fun WifiProbeButton(
    label: String,
    tag: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().testTag(tag),
    ) {
        Text(label)
    }
}

/** Molde do `ChoiceButton` da homologação: o preenchido mostra qual lado está valendo. */
@Composable
private fun WifiChoiceButton(
    label: String,
    tag: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    if (selected) {
        Button(
            onClick = onClick,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth().testTag(tag),
        ) {
            Text(label)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth().testTag(tag),
        ) {
            Text(label)
        }
    }
}
