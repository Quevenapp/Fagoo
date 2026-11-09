package br.com.thermalprinterkit

/**
 * Como cada dialeto se chama para quem está com a impressora na mão, e a tradução de volta.
 *
 * **Por que isto vive no kit, e não na tela de cada plataforma.** A pergunta "em que língua esta
 * impressora fala?" nasceu no programa de mesa do Windows em 04/09/2026, e ganhou um espelho em
 * Swift para o Mac. Dois arquivos, duas listas, dois `when` — e a tradução entre rótulo e dialeto é
 * exatamente a parte que pode dar errado em silêncio: trocar a ordem dos botões e não trocar a do
 * `when` faz "Padrão" gravar `PROCOMP_ESC_P` e, pior, "Diebold Procomp" gravar `EPSON_COMPATIBLE`.
 * Esse defeito produziria exatamente a sequência que travou a IM453H em 23/08/2026 — e a
 * formulação é essa, e não "é o defeito que travou": em 23/08 esta frente não tinha uma linha de
 * código, e a pergunta só nasceu em 04/09. Uma cópia por plataforma é uma chance por plataforma de
 * cometê-lo.
 *
 * Aqui a fonte é uma só **do lado Kotlin**, e é honesto dizer só isso: o arquivo é Kotlin puro e
 * atravessa para o `:core-jvm` pela mesma regra de exclusão que leva o [EscPosDialectGate] e o
 * [ProcompEscP] ao Windows e ao Mac de mesa, mas o espelho Swift
 * (`ios/macos/.../DialetoNoMenuDeMedicao.swift`) **continua de pé e não foi unificado**. Enquanto
 * ele existir, a troca de ordem que este arquivo tornou impossível em Kotlin continua possível lá.
 *
 * **O que se perde ao errar não é só papel.** Medido numa Diebold IM453H em 23/08/2026: o
 * comprovante de teste ESC/POS — prólogo do transporte (`DLE EOT` de status e `ESC @`) e um QR em
 * `GS v 0` no corpo — saiu como código no papel **e travou o aparelho**. A tecla física de avanço
 * parou de responder, `ESC r` não recuperou, e a recuperação medida foi desligar e ligar. O papel
 * perdido é o de menos: o que se perde é o atendimento parado até alguém ir fisicamente até a
 * impressora. Ver [EscPosDialectGate] e `docs/diebold-im453h.md`.
 *
 * **A ordem sai de `entries`, e não de uma lista escrita à mão.** O jeito anterior era
 * `listOf(EPSON_COMPATIBLE, PROCOMP_ESC_P)` com um teste conferindo que nenhum dialeto ficou de
 * fora — teste que só falha depois de alguém rodá-lo. Aqui a lista **é** [EscPosDialect.entries],
 * ordenada por um `when` exaustivo sem `else`: um dialeto novo entra no menu sozinho, e não
 * compila até que alguém diga em que posição ele fica e como ele se chama no balcão. Ficar de fora
 * do menu deixou de ser possível; ficar sem rótulo deixou de compilar.
 */
object DialetoNoBalcao {

    /**
     * A ordem em que as opções aparecem, e **a mesma lista** que traduz a resposta de volta.
     *
     * Os dois lados saem daqui de propósito: é a unificação que impede o botão certo de gravar o
     * dialeto errado. O primeiro é o que nasce com o foco — ver [posicao].
     */
    val ordem: List<EscPosDialect> = EscPosDialect.entries.sortedBy(::posicao)

    /**
     * Onde cada dialeto fica na fila.
     *
     * `EPSON_COMPATIBLE` em primeiro é **frequência**, e não preferência de marca: é o que a
     * esmagadora maioria das térmicas de balcão fala, então é a ordem que acerta quase sempre.
     *
     * **E não é o lado barato do erro — é o caro, e isso precisa ficar escrito.** Aqui esteve dito
     * o contrário. A medição diz que errar para este lado é justamente o que trava: ESC/POS numa
     * Diebold deixa o aparelho inoperante (`docs/diebold-im453h.md`, "não **só** sai ilegível: ele
     * deixa a impressora inoperante"). O erro barato é o outro — Procomp numa Epson estraga uma
     * medição, não o aparelho.
     *
     * A ordem continua esta porque o custo esperado é o produto do preço pela frequência, e a
     * Diebold é uma família contra todas as outras. Quem paga por ela é quem não leu a pergunta —
     * e é por isso que a frase da [pergunta] carrega o aviso do travamento, e que o descritor USB
     * contradiz quem responde errado. A ordem sozinha não é a proteção.
     */
    private fun posicao(dialect: EscPosDialect): Int =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> 0
            EscPosDialect.PROCOMP_ESC_P -> 1
        }

    /**
     * Como cada dialeto se chama para quem está no balcão.
     *
     * Nome de família, e não sigla de protocolo: quem está medindo tem a impressora na mão e lê a
     * etiqueta dela, não o manual do firmware. `when` exaustivo e sem `else`, pela mesma razão do
     * [EscPosDialectGate]: o padrão silencioso seria "Padrão", e o padrão silencioso é o defeito.
     */
    fun rotulo(dialect: EscPosDialect): String =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> "Padrão (ESC/POS)"
            EscPosDialect.PROCOMP_ESC_P -> "Diebold Procomp"
        }

    /**
     * A linha de baixo de cada opção, para quem responde numa tela de toque.
     *
     * A janela do Windows é um `JOptionPane` de botões, onde só cabe o rótulo, e a frase inteira da
     * [pergunta] carrega o resto. Uma tela de telefone cabe mais, e quem está no balcão responde
     * melhor reconhecendo a marca da própria impressora do que decidindo sobre um protocolo. Por
     * isso a explicação é lista de marcas, e não descrição de dialeto.
     */
    fun explicacao(dialect: EscPosDialect): String =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE ->
                "Epson, Elgin, Bematech, Tomate, Knup, e quase toda térmica de balcão."
            EscPosDialect.PROCOMP_ESC_P ->
                "A linha Diebold Procomp — IM453H e parentes. Confira a etiqueta."
        }

    /** Os rótulos na ordem dos botões. */
    val rotulos: List<String> get() = ordem.map(::rotulo)

    /**
     * O que a janela devolve, do índice do botão ao dialeto.
     *
     * `null` para qualquer coisa que não seja um botão — `JOptionPane.CLOSED_OPTION` é `-1`, e
     * fechar a janela **cancela a medição** em vez de escolher o padrão. Quem não respondeu não
     * escolheu, e seguir com um palpite é o que trava a IM453H.
     */
    fun doIndice(indice: Int): EscPosDialect? = ordem.getOrNull(indice)

    /**
     * A frase da pergunta.
     *
     * Ela diz **o que se perde ao errar**, e o que se perde não é papel: é a impressora parada até
     * alguém ir fisicamente até ela desligar e ligar. Uma pergunta de protocolo sem essa frase
     * seria respondida no chute pela metade das pessoas.
     *
     * @param displayName o nome que a pessoa já deu à impressora, quando ele existe. No telefone a
     *   pergunta vem antes de haver nome — a medição começa pela grade de modelos —, e aí a frase
     *   fala da "impressora" em vez de inventar um nome que ninguém escolheu.
     */
    fun pergunta(displayName: String? = null): String {
        val alvo = displayName?.trim()?.takeIf { it.isNotEmpty() } ?: "impressora"
        return "Em que língua a $alvo fala?\n\n" +
            "Quase toda impressora térmica de balcão fala ESC/POS — Epson, Elgin, Bematech, " +
            "Tomate, as portáteis. A linha Diebold Procomp (IM453H e parentes) fala outra, e " +
            "mandar ESC/POS para ela não sai errado no papel: trava o aparelho, e só desligar e " +
            "ligar recupera.\n\n" +
            "Na dúvida, confira a etiqueta da impressora antes de responder."
    }

    /** O título da saída para quem não sabe responder. Ver [comoDescobrir]. */
    const val COMO_DESCOBRIR_TITULO = "Não sabe? A impressora responde sozinha."

    /**
     * O caminho para quem não sabe, e ele **não gasta um byte nosso**.
     *
     * Toda térmica de balcão imprime um autoteste disparado pela própria firmware, sem host. Na
     * IM453H ele foi medido em 23/08/2026 e traz modelo, firmware, colunas, tabela de caracteres,
     * guilhotina e a interface selecionada. **Não é "quase todo o perfil"** — a escala vertical de
     * raster, o comando de corte que a firmware atende e o seletor de página continuam sendo coisa
     * de tira. Mas para a pergunta desta tela ele basta sozinho, e é o melhor instrumento
     * disponível aqui porque é dela, não nosso:
     * qualquer sonda que mandássemos teria de escolher um dialeto antes de saber qual é.
     *
     * O detalhe do "soltar" é o que separa duas coisas na IM453H: soltar quando o led apaga imprime
     * o autoteste; **manter pressionado** abre o Menu de Configuração, que muda o alvo da medição
     * em vez de descrevê-lo.
     */
    fun comoDescobrir(): String =
        "Desligue a impressora, ligue de novo segurando a tecla de avanço de papel e solte quando " +
            "o led vermelho apagar. Ela imprime sozinha uma folha com o modelo dela — é o que " +
            "responde esta pergunta, e não gasta nada além desse papel.\n\n" +
            "Se sair \"IM453H\", é ${rotulo(EscPosDialect.PROCOMP_ESC_P)}. Qualquer outro modelo " +
            "de balcão, ${rotulo(EscPosDialect.EPSON_COMPATIBLE)}."

    /**
     * O que o aparelho **declarou de si mesmo** sugere sobre a língua dele — ou `null`.
     *
     * **A assimetria é o ponto deste método, e não um descuido.** Ele devolve
     * [EscPosDialect.PROCOMP_ESC_P] ou `null`, **nunca** [EscPosDialect.EPSON_COMPATIBLE]. O
     * descritor **confirma, não nega**: um aparelho que se anuncia "Diebold" é uma Diebold, mas um
     * que não se anuncia assim não provou nada — pode ser uma paralela atrás de um conversor, um
     * hub que reescreve o nome, ou um modelo cujo descritor é genérico. Devolver "é Epson" aqui
     * seria transformar ausência de indício em medição, que é a forma exata do defeito que este
     * kit passa o tempo inteiro fechando.
     *
     * Por isso o resultado **pré-responde** a pergunta e **contradiz** uma resposta errada
     * (ver [avisoDeDescritorContrariado]); ele não substitui a pergunta e não escolhe sozinho.
     *
     * Medido em 23/08/2026, e sem gastar papel nem escrever byte no caminho de impressão: o
     * descritor USB da IM453H traz `manufacturer_name=Diebold` e `product_name=IM453H`
     * (`docs/diebold-im453h.md`, seção M1). É a **única** identidade que o kit consegue obter dessa
     * impressora sem risco — o `GS I`, que é como ele pergunta identidade a todo mundo, é comando
     * `GS`, e ela não tem nenhum.
     *
     * @param nomesDeclarados fabricante, produto, nome pareado do Bluetooth, o que houver. Nulos e
     *   vazios são ignorados, para o chamador não precisar filtrar antes.
     */
    fun suspeitaPeloDescritor(vararg nomesDeclarados: String?): EscPosDialect? {
        val texto =
            nomesDeclarados
                .filterNotNull()
                .joinToString(" ")
                .lowercase()
                .filter { it.isLetterOrDigit() || it.isWhitespace() }
        return if (MARCADORES_PROCOMP.any { texto.contains(it) }) {
            EscPosDialect.PROCOMP_ESC_P
        } else {
            null
        }
    }

    /**
     * O aviso para quando o aparelho se anuncia de uma família e a pessoa respondeu outra — ou
     * `null` quando não há contradição.
     *
     * É a única coisa que o descritor tem autoridade para fazer contra uma resposta humana:
     * **avisar**. Ele não troca o dialeto escolhido, porque a pessoa está com a impressora na mão e
     * o descritor não; mas deixar passar em silêncio um "Padrão (ESC/POS)" escolhido para um
     * aparelho que se chama Diebold seria guardar a informação que evita o travamento.
     */
    fun avisoDeDescritorContrariado(
        escolhido: EscPosDialect,
        vararg nomesDeclarados: String?,
    ): String? =
        avisoDeSuspeitaContrariada(
            escolhido = escolhido,
            suspeita = suspeitaPeloDescritor(*nomesDeclarados),
            nomeDeclarado = nomesDeclarados.firstOrNull { !it.isNullOrBlank() },
        )

    /**
     * A mesma frase de [avisoDeDescritorContrariado], para quem **já tem a suspeita** e não os
     * nomes que a produziram.
     *
     * É o caso da candidata na tela: a suspeita é levantada na enumeração USB, onde os dois nomes
     * existem, e viaja até a lista como um campo só. Recalculá-la a partir do rótulo **pode** dar
     * outra resposta, porque o rótulo é só o nome de **produto** e o de **fabricante** não vai à
     * tela. Na unidade medida os dois denunciam (`IM453H` e `Diebold`), então ali daria no mesmo;
     * o campo existe para o caso em que só o fabricante denuncia — e para o rótulo poder ser o
     * genérico do kit sem a suspeita se perder junto.
     */
    fun avisoDeSuspeitaContrariada(
        escolhido: EscPosDialect,
        suspeita: EscPosDialect?,
        nomeDeclarado: String?,
    ): String? {
        if (suspeita == null || suspeita == escolhido) return null
        val nome = nomeDeclarado?.trim()?.takeIf { it.isNotEmpty() } ?: "este aparelho"
        return "O aparelho \"$nome\" se anuncia com nome da linha ${rotulo(suspeita)}, e a " +
            "resposta desta medição foi ${rotulo(escolhido)}. Mandar ESC/POS para uma Diebold não " +
            "sai errado no papel: trava o aparelho, e só desligar e ligar recupera. Confira a " +
            "etiqueta antes de imprimir."
    }

    /**
     * Os pedaços de nome que denunciam a família Procomp.
     *
     * `diebold` e `im453h` foram **lidos no descritor** da unidade de bancada em 23/08/2026.
     * `procomp` é o nome da família no manual e nunca foi visto num descritor — está aqui porque o
     * custo dos dois erros é assimétrico: suspeitar à toa faz aparecer um aviso que a pessoa
     * dispensa, e não suspeitar deixa passar o comprovante que trava o aparelho.
     */
    private val MARCADORES_PROCOMP = listOf("diebold", "procomp", "im453h")
}
