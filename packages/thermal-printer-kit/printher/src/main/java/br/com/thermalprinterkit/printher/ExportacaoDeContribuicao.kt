package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PRINTER_CONTRIBUTION_MIME_TYPE
import br.com.thermalprinterkit.PrinterContributionUnmeasured
import br.com.thermalprinterkit.PrinterProfileSource
import br.com.thermalprinterkit.createPrinterContributionJson
import java.text.Normalizer

/**
 * O pacote pronto para sair, do jeito que o diálogo do sistema precisa dele.
 *
 * Três campos e nada mais, porque é exatamente o que `ACTION_CREATE_DOCUMENT` consome: o conteúdo,
 * o nome sugerido e o tipo. Nenhum deles é `Context`, `Uri` ou `Intent` — este tipo atravessa a
 * fronteira entre o que se prova sem tela e o que não se prova (ver [EntregaDeContribuicao]).
 *
 * @property semMedida o que o formato v1 **não** carrega. Não é erro: é o que a pessoa que exporta
 *   precisa saber que continua sem medida do outro lado. A lista vem do kit
 *   ([PrinterContributionUnmeasured]) e não é reescrita aqui — ver [frasesDoQueNaoVaiJunto].
 */
class PacoteDeContribuicao(
    val conteudo: ByteArray,
    val nomeDoArquivo: String,
    val semMedida: List<PrinterContributionUnmeasured>,
) {
    /**
     * O tipo próprio, e não `application/json`.
     *
     * Não é um literal deste arquivo: vem de [PRINTER_CONTRIBUTION_MIME_TYPE], que é o mesmo valor
     * que o `Info.plist` do app iOS declara em `UTTypeTagSpecification/public.mime-type`. Dois
     * literais seriam duas verdades, e a que envelhecesse mandaria o pacote para uma folha de
     * compartilhamento onde o destino não aparece.
     */
    val mimeType: String = PRINTER_CONTRIBUTION_MIME_TYPE

    /**
     * As frases que a tela mostra sob "o que não vai junto".
     *
     * Derivadas de [semMedida], que veio do enum do kit: a tela não tem uma segunda lista para
     * manter em dia, e o que ela lê é o que o pacote realmente deixou de fora.
     */
    val frasesDoQueNaoVaiJunto: List<String>
        get() = semMedida.map(PrinterContributionUnmeasured::fraseParaQuemExporta)

    /** Igualdade por conteúdo: `ByteArray` compara por referência, e a suíte compara pacotes. */
    override fun equals(other: Any?): Boolean =
        other is PacoteDeContribuicao &&
            conteudo.contentEquals(other.conteudo) &&
            nomeDoArquivo == other.nomeDoArquivo &&
            semMedida == other.semMedida

    override fun hashCode(): Int =
        (conteudo.contentHashCode() * 31 + nomeDoArquivo.hashCode()) * 31 + semMedida.hashCode()
}

/**
 * Por que o gesto **não** aparece.
 *
 * Três dos quatro valores espelham um `require` de `createPrinterContributionJson`. O quarto,
 * [NOME_NAO_EXPORTAVEL], não espelha nada do escritor Kotlin: ele não tem — e agora não precisa ter
 * — guarda nenhuma para o `displayName`, porque **não há regra de nome que o pacote imponha além da
 * que `MeasuredProfile` já impõe**. A assimetria que o lote de 30/08/2026 pela manhã registrou aqui
 * fechou pelo outro lado: quem mudou foi o escritor Swift, que largou a guarda ASCII. Ver
 * `PrinterContribution.displayNameIsPackageable`, onde estão as quatro medições.
 */
enum class MotivoParaNaoContribuir {
    /**
     * O perfil não saiu de uma medição local.
     *
     * O escritor recusa qualquer `source` que não seja `MEASURED`, com a razão dele: contribuição é
     * medição, e perfil embutido ou temporário não mediu nada. Aqui a recusa é **antes** do botão.
     */
    PERFIL_NAO_MEDIDO,

    /** O hospedeiro não soube dizer a versão do sistema. Ver `requireValidVersionLabel`. */
    VERSAO_DO_SISTEMA_INVALIDA,

    /** O hospedeiro não soube dizer a versão do app. Ver `requireValidVersionLabel`. */
    VERSAO_DO_APP_INVALIDA,

    /**
     * O nome da impressora não pode virar pacote.
     *
     * **Este motivo encolheu em 30/08/2026, e é do que sobrou que ele fala.** Ele nasceu grande
     * porque a régua era `PrinterDeclaredIdentity.sanitizeField` — ASCII imprimível em até 64 bytes
     * —, e por isso engolia o caso comum do balcão brasileiro: `Cozinha do Balcão` caía aqui, e o
     * gesto respondia dobrando o acento antes de empacotar. A régua saiu (as quatro medições estão
     * em `PrinterContribution.displayNameIsPackageable`, do lado Swift), e com ela saiu a dobra:
     * **o nome da pessoa viaja como ela o escreveu**, acento, japonês, grego e tudo.
     *
     * O que ainda cai aqui é só o que `MeasuredProfile` também não aceita naquele campo: nome
     * vazio ou só de espaço, nome com caractere de controle dentro, e nome acima dos 80 caracteres
     * que o perfil permite.
     *
     * **Hoje nenhum desses chega até o gesto**, porque `MeasuredProfile` os recusa na construção e
     * é por lá que todo perfil entra — ver [ExportacaoDeContribuicao.nomeExportavel]. O valor
     * existe como fronteira e como par de `MotivoParaNaoContribuir.nomeNaoExportavel` no iOS, onde
     * o `switch` sobre o erro tipado do escritor tem de continuar exaustivo.
     */
    NOME_NAO_EXPORTAVEL,
}

/** O desfecho de preparar a contribuição. Recusa é desfecho, nunca exceção. */
sealed interface PreparoDaContribuicao {
    /** Há o que contribuir, e o pacote já está montado. */
    data class Pronto(val pacote: PacoteDeContribuicao) : PreparoDaContribuicao

    /** Não há o que contribuir. **O gesto não aparece**, e a pessoa não vê botão que estoura. */
    data class NaoOferecido(val motivo: MotivoParaNaoContribuir) : PreparoDaContribuicao
}

/**
 * O gesto que produz o pacote de contribuição — **tudo o que decide, sem uma linha de tela.**
 *
 * ## O buraco que isto fecha
 *
 * Medido por grep em 28/08/2026: `createPrinterContributionJson` tinha **zero chamadores de
 * produção** em `android/`, `ios/`, `android-lab`, `ios-lab`, `printher/` e no repositório vizinho
 * do app — só testes o chamavam. Do outro lado, o Printher de mesa **já sabe ler**: a bandeja tem a
 * ação `IMPORTAR_PERFIL`, rotulada *"Adotar impressora homologada no celular…"*, e o leitor é
 * `ImportacaoDeContribuicao.kt`. O rótulo apontava para um arquivo que nenhum app emitia. Este
 * arquivo é o emissor.
 *
 * ## Por que aqui, e não no kit
 *
 * O escritor é puro de propósito — recebe as versões como dados para o core não consultar `Context`,
 * pacote nem aparelho. Quem sabe a versão do Android e a do app é o hospedeiro, e o módulo
 * `printher` é a superfície de UI que já vive do lado do hospedeiro. O escritor continua sem saber
 * onde roda; o gesto mora onde a homologação termina, que é onde está quem tem o que contribuir.
 *
 * ## Por que oferecer é montar
 *
 * [preparar] é ao mesmo tempo a decisão de mostrar o botão e a construção do pacote: a tela mostra o
 * gesto **se e somente se** o preparo devolveu [PreparoDaContribuicao.Pronto]. Um par
 * `podeContribuir()` / `preparar()` teria duas cópias das mesmas condições, e o dia em que elas
 * divergissem seria o dia em que o `require` do escritor estoura na cara de quem acabou de
 * homologar. Montar custa uma string de menos de 1 KB; a divergência custa um crash.
 *
 * ## O que o pacote não leva, e por que não há uma segunda lista aqui
 *
 * O que o formato v1 não carrega está **no kit**, em [PrinterContributionUnmeasured], e é de lá que
 * a tela tira o que dizer. Este arquivo escreve só a **frase em português para quem exporta** — o
 * leitor de mesa tem a frase dele, para quem importa, e as duas conversas são diferentes ("isto não
 * vai" contra "isto chegou sem medida"). A lista em si não é duplicada.
 *
 * O `when` de [fraseParaQuemExporta] é exaustivo de propósito: um valor novo no enum do kit **não
 * compila** aqui até ganhar frase. É a trava que impede a divergência que o KDoc do leitor não tem
 * — lá o conjunto devolvido é um `setOf` literal dos cinco valores, e um sexto valor no enum
 * passaria por ele em silêncio. Se isso acontecer, quem quebra primeiro é este arquivo, e é de
 * propósito.
 */
object ExportacaoDeContribuicao {
    /**
     * A extensão do arquivo, e ela **não** é escolha deste lote.
     *
     * O app iOS do repositório vizinho já declara o tipo exportado
     * `br.com.pixelgoods.printher.printer-contribution` no `Info.plist`, e a
     * `public.filename-extension` que ele lista é esta. Divergir aqui faria o mesmo pacote ser
     * reconhecido num aparelho e não no outro.
     */
    const val EXTENSAO: String = "printercontribution"

    /** O nome quando não sobra letra nenhuma do nome da impressora. Ver [nomeDeArquivo]. */
    const val NOME_GENERICO: String = "impressora"

    /** Teto do miolo do nome, antes da extensão. Nome de arquivo comprido some no seletor. */
    const val MAXIMO_DO_MIOLO: Int = 48

    /**
     * Monta o pacote, ou diz por que não há o que montar.
     *
     * As condições são as mesmas de `createPrinterContributionJson`, verificadas antes dele:
     * `source == MEASURED`, o nome de exibição e os dois rótulos de versão. A outra exigência do
     * escritor — `requireNotNull(measuredAtEpochMillis)` — **não** vira condição aqui porque ela não
     * é alcançável: `MeasuredProfile` já exige `measuredAtEpochMillis != null && > 0` sempre que
     * `source` é `MEASURED` (`MeasuredProfile.kt:215-219`). Repeti-la seria escrever um ramo que
     * nenhum teste consegue tocar. `ExportacaoDeContribuicaoTest` fixa essa invariante do kit.
     *
     * ## O nome da pessoa viaja intacto
     *
     * Entre a manhã e a tarde de 30/08/2026 este gesto **dobrava o acento** do `displayName` antes
     * de empacotar, e avisava a pessoa disso. Fazia-o porque o escritor Swift recusava nome fora do
     * ASCII imprimível, e a assimetria entre as duas plataformas era resolvida dobrando nos dois
     * lados. Aquela guarda saiu — as quatro medições que a tiraram estão em
     * `PrinterContribution.displayNameIsPackageable` —, e com ela saiu a dobra e o aviso que a
     * acompanhava. **A pessoa batizou a impressora em português, e o nome chega do outro lado como
     * ela escreveu.** O pacote é UTF-8 declarado, e sempre foi: o golden do contrato compartilhado
     * em `PrinterContributionTest` fixa `"displayName": "Impressora da José"` por literal.
     *
     * A dobra que **fica** é outra, e é a de [nomeDeArquivo]: aquilo é sistema de arquivos, com
     * alfabeto fechado e uma segunda tranca contra endereço, e continua certo. As duas nunca foram
     * a mesma coisa — só compartilhavam [semAcento].
     *
     * Nada aqui mexe no emparelhamento: a `capabilityKey` **não inclui o `displayName`**. O leitor
     * de mesa reconhece a medição pela chave, e não pelo rótulo.
     */
    fun preparar(
        perfil: MeasuredProfile,
        versaoDoSistema: String,
        versaoDoApp: String,
    ): PreparoDaContribuicao {
        if (perfil.source != PrinterProfileSource.MEASURED) {
            return PreparoDaContribuicao.NaoOferecido(MotivoParaNaoContribuir.PERFIL_NAO_MEDIDO)
        }
        if (!nomeExportavel(perfil.displayName)) {
            return PreparoDaContribuicao.NaoOferecido(MotivoParaNaoContribuir.NOME_NAO_EXPORTAVEL)
        }
        if (!rotuloDeVersaoValido(versaoDoSistema)) {
            return PreparoDaContribuicao.NaoOferecido(
                MotivoParaNaoContribuir.VERSAO_DO_SISTEMA_INVALIDA,
            )
        }
        if (!rotuloDeVersaoValido(versaoDoApp)) {
            return PreparoDaContribuicao.NaoOferecido(MotivoParaNaoContribuir.VERSAO_DO_APP_INVALIDA)
        }
        return PreparoDaContribuicao.Pronto(
            PacoteDeContribuicao(
                conteudo =
                    createPrinterContributionJson(
                        profile = perfil,
                        osVersion = versaoDoSistema,
                        appVersion = versaoDoApp,
                    ),
                // O nome do arquivo dobra por conta própria, e é a única dobra que sobrou: ele vai
                // para o sistema de arquivos, e o do pacote vai para a bandeja de alguém.
                nomeDoArquivo = nomeDeArquivo(perfil.displayName),
                // A lista inteira do kit, e não uma cópia dela: o pacote v1 não carrega nenhum
                // destes cinco, e o dia em que carregar um é o dia em que o valor sai do enum.
                semMedida = PrinterContributionUnmeasured.entries.toList(),
            ),
        )
    }

    /**
     * O nome cabe no pacote?
     *
     * **Até 30/08/2026 esta pergunta era feita a `PrinterDeclaredIdentity.sanitizeField`, e era a
     * pergunta errada.** Aquela função higieniza os bytes que a **firmware** declara sobre si mesma
     * no `GS I`; o `MAX_FIELD_BYTES = 64` dela é do protocolo, não do produto. Um nome que uma
     * PESSOA digitou não passa por ali — e, se passasse, seria cortado 16 caracteres antes do que
     * `MeasuredProfile` permite. As quatro medições que tiraram a guarda do escritor Swift estão em
     * `PrinterContribution.displayNameIsPackageable`.
     *
     * O que sobrou é o que `MeasuredProfile` já exige do mesmo campo (`MeasuredProfile.kt`, bloco
     * `init`): não em branco, no máximo [MAXIMO_DO_NOME] caracteres, e sem caractere de controle.
     * A regra de identificador técnico não é repetida aqui: ela é do tipo do perfil, que é a porta
     * por onde todo nome entra, e uma segunda cópia existiria só para divergir.
     *
     * **Hoje esta função nunca responde `false` para um perfil de verdade**, porque `MeasuredProfile`
     * recusa esses três casos na construção. Ela é fronteira, e é medida como fronteira: a suíte a
     * chama direto, com literais, e confere o **acordo** entre ela e o que o perfil aceita. Um
     * mutante que apagasse só a chamada em [preparar] sobreviveria; um que mexesse nesta régua, não.
     */
    internal fun nomeExportavel(nome: String): Boolean =
        nome.isNotBlank() && nome.length <= MAXIMO_DO_NOME && nome.none(Char::isISOControl)

    /**
     * O teto de caracteres do nome, e ele é o de `MeasuredProfile` — não o do protocolo.
     *
     * `PrinterDeclaredIdentity.MAX_FIELD_BYTES` é 64 e mede **bytes**, porque é o limite do campo
     * que a firmware devolve no `GS I`. Este é 80 e mede **caracteres**, porque é o limite que o
     * tipo do perfil impõe ao nome que a pessoa digitou. Dois números, dois donos.
     */
    internal const val MAXIMO_DO_NOME: Int = 80

    /**
     * O nome sugerido do arquivo, a partir do nome que a pessoa deu à impressora.
     *
     * ## Por que dá para usar o nome da impressora sem risco de endereço
     *
     * `MeasuredProfile` já recusa `displayName` que case com IP, MAC, UUID ou `VID`/`PID`
     * (`TECHNICAL_IDENTIFIER_PATTERNS`, `MeasuredProfile.kt:551-557`) — um nome com endereço nunca
     * chega vivo até aqui. Mesmo assim esta função é uma **segunda tranca**, porque a garantia de
     * privacidade não pode depender de uma tranca só nem de alguém lembrar dela: o que sai daqui é
     * `[a-z0-9-]` mais a extensão, e o que ainda tiver forma de endereço depois disso é descartado
     * — ver "O hífen que quase virou o vazamento", logo abaixo.
     *
     * Acento vira letra sem acento em vez de virar hífen: "Cozinha — Balcão" precisa continuar
     * legível no seletor de arquivo, que é o único lugar onde a pessoa reconhece o que está
     * salvando.
     *
     * ## O hífen que quase virou o vazamento
     *
     * Medido em 30/08/2026, por um teste que falhou antes de esta linha existir: reduzir ao alfabeto
     * seguro **não basta**. `AA:BB:CC:DD:EE:FF` vira `aa-bb-cc-dd-ee-ff`, que continua sendo um MAC
     * legível — o hífen é separador de MAC tanto quanto os dois-pontos, e a mesma armadilha vale
     * para um UUID, que já nasce com hífen. O alfabeto fechado apagou a pontuação errada e deixou a
     * certa. Por isso a segunda tranca não é só a troca de caracteres: é a **conferência do que
     * sobrou**, e o que ainda tiver forma de endereço cai em [NOME_GENERICO].
     *
     * IP não precisa de conferência: o ponto não sobrevive ao alfabeto, e `19216801` não é
     * endereço nenhum — é um número. As duas formas conferidas são as duas que o hífen preserva.
     */
    fun nomeDeArquivo(displayName: String): String {
        val miolo =
            semAcento(displayName)
                .lowercase()
                .replace(FORA_DO_ALFABETO_SEGURO, "-")
                .trim('-')
                .take(MAXIMO_DO_MIOLO)
                .trim('-')
                .ifEmpty { NOME_GENERICO }
        val seguro =
            if (FORMAS_QUE_O_HIFEN_PRESERVA.any { it.containsMatchIn(miolo) }) NOME_GENERICO else miolo
        return "$seguro.$EXTENSAO"
    }

    /**
     * A régua do acento, e desde 30/08/2026 ela serve **só ao nome do arquivo**.
     *
     * `Balcão` vira `Balcao`: decompõe em NFD, onde o `ã` vira `a` mais um acento que ocupa
     * caractere próprio, e apaga as marcas sem espaçamento (`\p{Mn}`). Letra sem acento sobra;
     * letra que não tem versão sem acento — japonês, russo, grego — não sobra nada, e aí
     * [nomeDeArquivo] cai em [NOME_GENERICO], que é o desfecho certo para um nome de arquivo e
     * seria o desfecho errado para o nome dentro do pacote.
     *
     * Ela **já não toca no `displayName` que viaja**: o pacote é UTF-8 e leva o nome como a pessoa
     * o escreveu. Ver a seção "O nome da pessoa viaja intacto" em [preparar].
     */
    internal fun semAcento(valor: String): String =
        Normalizer.normalize(valor, Normalizer.Form.NFD).replace(MARCAS_DE_ACENTO, "")

    /**
     * O mesmo que `requireValidVersionLabel` do escritor, dito como pergunta em vez de exceção.
     *
     * É a única regra do escritor copiada para cá, e a cópia é inevitável: a função dele é privada,
     * e o diretório `android/src/main` não é deste lote. Se as duas divergirem, o resultado é o
     * botão aparecer e o `require` estourar — que é exatamente o defeito que este arquivo existe
     * para não ter. `ExportacaoDeContribuicaoTest` mede a fronteira dos 128 caracteres pelos dois
     * lados contra o escritor de verdade, e é ela que denuncia a divergência.
     */
    private fun rotuloDeVersaoValido(valor: String): Boolean =
        valor.isNotBlank() && valor.length <= MAXIMO_DO_ROTULO_DE_VERSAO && valor.none(Char::isISOControl)

    private const val MAXIMO_DO_ROTULO_DE_VERSAO = 128

    private val MARCAS_DE_ACENTO = Regex("\\p{Mn}+")
    private val FORA_DO_ALFABETO_SEGURO = Regex("[^a-z0-9]+")

    /**
     * MAC e UUID — as duas formas de endereço que sobrevivem a `[a-z0-9-]`, porque o hífen é
     * separador legítimo das duas. Ver [nomeDeArquivo].
     */
    private val FORMAS_QUE_O_HIFEN_PRESERVA =
        listOf(
            Regex("(?:[0-9a-f]{2}-){5}[0-9a-f]{2}"),
            Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
        )
}

/**
 * O que este item **não vai levar**, dito para quem está exportando.
 *
 * A frase é de quem manda, e não de quem recebe: o leitor de mesa diz "chegou sem medida", e aqui a
 * pessoa ainda está com a impressora na frente. São duas conversas, e por isso duas frases sobre a
 * mesma lista — a lista, essa sim, é uma só, e vem do kit.
 */
internal fun PrinterContributionUnmeasured.fraseParaQuemExporta(): String =
    when (this) {
        PrinterContributionUnmeasured.NATIVE_QR ->
            "se esta impressora desenha QR sozinha (lá o QR sai como imagem, que é o caminho seguro)"
        PrinterContributionUnmeasured.NATIVE_BARCODE ->
            "se ela desenha código de barras sozinha"
        PrinterContributionUnmeasured.RASTER_THROUGHPUT ->
            "a velocidade máxima que ela aguenta receber imagem"
        PrinterContributionUnmeasured.NV_LOGO ->
            "se ela guarda logotipo na memória dela"
        PrinterContributionUnmeasured.WIFI_CONFIGURATION ->
            "como ela aceita configuração de rede"
    }
