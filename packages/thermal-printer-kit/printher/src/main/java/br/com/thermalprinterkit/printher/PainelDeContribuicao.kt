package br.com.thermalprinterkit.printher

import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PRINTER_CONTRIBUTION_MIME_TYPE

/**
 * Quem sabe entregar o pacote ao sistema — **ponto de injeção, porque diálogo de sistema não se
 * prova nesta bancada.**
 *
 * O padrão é o de `SeletorDeArquivoDeContribuicao`, do lado de mesa, e o motivo é o mesmo: o que
 * decide fica exercitável sem tela, e o `Intent` sai do caminho. Aqui isso quer dizer que **montar
 * o pacote, nomear o arquivo, decidir se o gesto aparece e escrever a frase que a pessoa lê** são
 * todos de [ExportacaoDeContribuicao], e o que sobra para a borda é abrir um diálogo do sistema e
 * escrever bytes num `Uri` que o sistema devolveu. Nada disso é decisão.
 *
 * A implementação de verdade é [lembrarEntregaPorArquivo], e **ela não tem prova neste lote**: um
 * teste de unidade JVM não abre `ActivityResultContracts`, e a suíte instrumentada deste módulo
 * imprime de verdade, então não roda sem bancada.
 */
fun interface EntregaDeContribuicao {
    fun entregar(pacote: PacoteDeContribuicao)
}

/**
 * As duas versões que o escritor do kit exige como dados.
 *
 * O escritor é puro de propósito — "a função é pura e recebe versões como dados para que o core não
 * consulte `Context`, pacote, aparelho ou rede". Quem consulta é este módulo, que já vive do lado do
 * hospedeiro; e por vir num tipo, o preparo inteiro continua chamável de um teste de unidade com
 * dois literais.
 */
data class VersoesDoAparelho(
    val sistema: String,
    val app: String,
)

/**
 * As versões deste aparelho — **borda**: lê `Build` e o `PackageManager`.
 *
 * Nenhuma das duas é endereço: `Build.VERSION.RELEASE` é o rótulo público do Android e
 * `versionName` é o rótulo público do app. Serial, `ANDROID_ID` e nome de aparelho não são lidos
 * aqui e não têm campo no pacote.
 *
 * Quando o `PackageManager` não responde, a versão volta vazia — e vazia o preparo **não oferece o
 * gesto**, em vez de mandar um pacote sem procedência. Ver
 * [MotivoParaNaoContribuir.VERSAO_DO_APP_INVALIDA].
 */
@Composable
fun lembrarVersoesDoAparelho(): VersoesDoAparelho {
    val context = LocalContext.current
    return remember(context) {
        VersoesDoAparelho(
            sistema = Build.VERSION.RELEASE ?: "",
            app = versaoDoApp(context),
        )
    }
}

private fun versaoDoApp(context: Context): String =
    runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
    }.getOrDefault("")

/**
 * A borda: o diálogo do sistema que recebe o pacote e o grava com o nome e o tipo declarados.
 *
 * ## Por que `ACTION_CREATE_DOCUMENT`, e não a folha de compartilhamento com `FileProvider`
 *
 * Três medições decidiram isto, e nenhuma é gosto:
 *
 * 1. **O destino lê um arquivo do disco.** `ImportadorDeContribuicao`, do lado de mesa, recebe um
 *    `Path` de um seletor de arquivo. O que precisa chegar lá é um **arquivo com nome**, e não um
 *    texto colado num corpo de e-mail.
 * 2. **O tipo próprio existe justamente para o sistema filtrar antes da folha**, e a extensão que o
 *    `Info.plist` do app iOS declara é `printercontribution`. Um `Intent.EXTRA_TEXT` não carrega
 *    nome de arquivo nenhum, então não carrega extensão nenhuma.
 * 3. **`FileProvider` não cabe numa biblioteca.** Ele exige um `<provider>` no `AndroidManifest`, e
 *    este módulo é consumido por apps hospedeiros: pôr o provider aqui obrigaria todo consumidor a
 *    carregar uma superfície de permissão que ele não pediu. O KDoc do escritor já argumenta contra
 *    o `FileProvider` pelo tamanho do pacote; `ACTION_CREATE_DOCUMENT` é o caminho que produz
 *    arquivo nomeado **sem** provider, sem permissão e sem entrada de manifesto.
 *
 * ## O que aqui não é medido
 *
 * Se o seletor de documentos do Android preserva a extensão de um MIME próprio que ele não conhece
 * — em vez de acrescentar uma sua — **não foi medido**: exige aparelho, e este lote não encostou em
 * aparelho. O nome sugerido vai completo, com a extensão, que é o que se pode garantir daqui.
 */
@Composable
fun lembrarEntregaPorArquivo(): EntregaDeContribuicao {
    val context = LocalContext.current
    // O conteúdo precisa sobreviver à ida ao seletor: quem volta é só o `Uri` do destino.
    val pendente = remember { arrayOfNulls<ByteArray>(1) }
    val seletor =
        rememberLauncherForActivityResult(
            ActivityResultContracts.CreateDocument(PRINTER_CONTRIBUTION_MIME_TYPE),
        ) { destino ->
            val bytes = pendente[0]
            pendente[0] = null
            if (destino != null && bytes != null) {
                // Desistir de gravar não é erro que mereça derrubar a tela de quem acabou de
                // homologar: o perfil já está salvo, e o pacote se refaz com outro toque.
                runCatching {
                    context.contentResolver.openOutputStream(destino)?.use { saida ->
                        saida.write(bytes)
                    }
                }
            }
        }
    return remember(seletor) {
        EntregaDeContribuicao { pacote ->
            pendente[0] = pacote.conteudo
            seletor.launch(pacote.nomeDoArquivo)
        }
    }
}

/**
 * O gesto, na tela: um botão e as três coisas que a pessoa precisa saber antes de tocar nele.
 *
 * **Ele só existe para quem tem perfil medido.** A decisão não é um `if` desta função: é
 * [ExportacaoDeContribuicao.preparar], que devolve [PreparoDaContribuicao.NaoOferecido] e faz o
 * painel inteiro não compor nada. Perfil embutido ou temporário não vê botão, e por isso não vê o
 * `require` do escritor estourar.
 *
 * ## As três frases, e por que elas são estas
 *
 * 1. **O que sai** — a medição, não a impressora. A tela acabou de prometer que a configuração fica
 *    neste aparelho, e a promessa continua verdadeira: o que atravessa é uma cópia do que o papel
 *    mostrou.
 * 2. **O que não sai** — endereço nenhum. É a garantia que faz a contribuição ser aceitável, e ela
 *    tem prova em `ContribuicaoSemEnderecoTest`, não a palavra desta frase.
 * 3. **O que não vai junto** — a lista do kit, dita para quem manda. Ver
 *    [PacoteDeContribuicao.frasesDoQueNaoVaiJunto].
 *
 * Nenhuma frase nomeia o aparelho de destino. O módulo não sabe — e não pode saber — se do outro
 * lado há um computador, outro celular ou nada; a mesma regra que
 * [PrinterHomologationLocalOnlyCopy] já sustenta para as frases de permanência.
 */
@Composable
fun ContribuicaoDaMedicaoPanel(
    perfil: MeasuredProfile,
    theme: ThermalPrinterTheme,
    modifier: Modifier = Modifier,
    versoes: VersoesDoAparelho = lembrarVersoesDoAparelho(),
    entrega: EntregaDeContribuicao = lembrarEntregaPorArquivo(),
) {
    val preparo = ExportacaoDeContribuicao.preparar(perfil, versoes.sistema, versoes.app)
    if (preparo !is PreparoDaContribuicao.Pronto) return
    val pacote = preparo.pacote

    NoticeCard(
        title = TITULO_DA_CONTRIBUICAO,
        body = CORPO_DA_CONTRIBUICAO,
        tone = NoticeTone.INFO,
        theme = theme,
        modifier = modifier.fillMaxWidth().testTag("thermal-printer.contribution.notice"),
    )
    // Aqui havia o aviso do nome dobrado, e ele saiu junto com a dobra em 30/08/2026: o nome vai
    // no pacote como a pessoa o escreveu, então não há nada a avisar. Um aviso sobre uma dobra que
    // não acontece mais seria ruído, e ruído é o que faz a pessoa parar de ler a lista logo abaixo
    // — essa, sim, ainda tem o que dizer.
    Text(
        AVISO_DO_QUE_NAO_VAI_JUNTO,
        style = MaterialTheme.typography.bodySmall,
    )
    pacote.frasesDoQueNaoVaiJunto.forEach { frase ->
        Text("• $frase", style = MaterialTheme.typography.bodySmall)
    }
    OutlinedButton(
        onClick = { entrega.entregar(pacote) },
        modifier = Modifier.fillMaxWidth().testTag("thermal-printer.contribution.share"),
    ) {
        Text(ROTULO_DA_CONTRIBUICAO)
    }
}

/**
 * O título do gesto.
 *
 * "Medição" e não "impressora": o que sai é o que o papel mostrou. E "outro aparelho" e não
 * "computador", porque quem sabe o que existe do outro lado não é este módulo.
 */
internal const val TITULO_DA_CONTRIBUICAO = "Levar esta medição para outro aparelho"

internal const val CORPO_DA_CONTRIBUICAO =
    "Sai um arquivo com o que o papel mostrou: largura, colunas, acento, corte e avanço. " +
        "Não sai o endereço desta impressora, nem o cadastro deste aparelho."

internal const val AVISO_DO_QUE_NAO_VAI_JUNTO = "O que ninguém mediu, e por isso não vai junto:"

internal const val ROTULO_DA_CONTRIBUICAO = "Salvar o arquivo da medição"
