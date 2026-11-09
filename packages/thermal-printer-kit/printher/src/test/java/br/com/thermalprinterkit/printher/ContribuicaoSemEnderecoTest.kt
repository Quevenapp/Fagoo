package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.EscPosDialect
import br.com.thermalprinterkit.CutProtocol
import br.com.thermalprinterkit.MeasuredProfile
import br.com.thermalprinterkit.PrinterTransport
import br.com.thermalprinterkit.ThermalCodePage
import br.com.thermalprinterkit.ThermalTextEncoding
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **Nada de endereço sai daqui** — nem no pacote, nem no nome do arquivo.
 *
 * Esta é a garantia que faz a contribuição ser aceitável de se pedir a alguém: o pacote v1 carrega
 * capacidade, e nunca identidade física. Ela **não pode depender de ninguém lembrar** dela na
 * próxima vez que um campo for acrescentado, e por isso está escrita como prova em vez de como
 * parágrafo de KDoc.
 *
 * ## Duas trancas, e por que duas
 *
 * O kit já prova que o **JSON** não leva `id`, endpoint nem identificador técnico
 * (`PrinterContributionTest`). O que ele **não** cobre é o que este lote acrescentou: o **nome do
 * arquivo**, que é a única coisa nova que sai do aparelho e que a pessoa vê, escolhe onde salvar e
 * manda para outro aparelho. Um nome de arquivo com o IP da impressora atravessaria o e-mail
 * inteiro sem nunca ter entrado no JSON.
 *
 * A primeira tranca é `MeasuredProfile`, que recusa `displayName` casando com IP, MAC, UUID ou
 * VID/PID. A segunda é [ExportacaoDeContribuicao.nomeDeArquivo], que reduz a `[a-z0-9-]` **e depois
 * confere o que sobrou** — a redução sozinha não basta, e o teste que provou isso está aqui embaixo.
 * Uma tranca só é uma tranca que alguém desfaz sem saber.
 *
 * ## O que isto não prova
 *
 * Nada aqui saiu em papel, e nenhum pacote de aparelho de verdade foi lido: todos os pacotes desta
 * suíte saem do escritor do próprio kit.
 */
class ContribuicaoSemEnderecoTest {
    @Test
    fun `o pacote emitido pelo gesto nao contem o identificador local do perfil`() {
        val perfil = perfilMedido("Impressora da cozinha")

        val texto = conteudoComoTexto(perfil)

        assertFalse(
            "O UUID local é identidade da instalação, e não tem campo no pacote v1.",
            texto.contains(perfil.id),
        )
    }

    @Test
    fun `nenhum formato de endereco sobrevive no pacote emitido`() {
        val texto = conteudoComoTexto(perfilMedido("Impressora da cozinha"))

        FORMATOS_DE_ENDERECO.forEach { (nome, padrao) ->
            assertFalse(
                "O pacote carrega algo com forma de $nome: ${padrao.find(texto)?.value}",
                padrao.containsMatchIn(texto),
            )
        }
    }

    @Test
    fun `o proprio perfil recusa nome com endereco, entao ele nao chega ao nome do arquivo`() {
        // A primeira tranca. Se ela cair, este teste avisa antes de o nome do arquivo virar o
        // caminho de vazamento.
        listOf(
            "Impressora 192.168.0.10",
            "Balcao AA:BB:CC:DD:EE:FF",
            "Cozinha 00000000-0000-4000-8000-000000000077",
            "Impressora VID 1234",
        ).forEach { nome ->
            assertTrue(
                "MeasuredProfile precisa continuar recusando o nome: $nome",
                runCatching { perfilMedido(nome) }.isFailure,
            )
        }
    }

    @Test
    fun `o nome do arquivo so deixa passar letra minuscula, digito e hifen`() {
        // A segunda tranca, medida contra as mesmas formas — mesmo sabendo que a primeira já as
        // recusa. Os separadores que fazem um endereço ser legível (`.`, `:`, `-` agrupado) são o
        // que esta função apaga, e é isso que sobra de proteção se a primeira tranca cair.
        listOf(
            "Impressora 192.168.0.10",
            "AA:BB:CC:DD:EE:FF",
            "Cozinha  do balcão",
            "impressora@rede.local:9100",
        ).forEach { nome ->
            val arquivo = ExportacaoDeContribuicao.nomeDeArquivo(nome)

            assertTrue(
                "Nome de arquivo fora do alfabeto seguro: $arquivo",
                ALFABETO_SEGURO.matches(arquivo),
            )
            (FORMATOS_DE_ENDERECO + PORTA_DE_REDE).forEach { (formato, padrao) ->
                assertFalse(
                    "O nome de arquivo $arquivo ainda tem forma de $formato.",
                    padrao.containsMatchIn(arquivo),
                )
            }
        }
    }

    @Test
    fun `o que sobra com forma de endereco cai no nome generico`() {
        // Este teste falhou **antes** de a conferência existir, e é por isso que ela existe:
        // `AA:BB:CC:DD:EE:FF` virava `aa-bb-cc-dd-ee-ff`, que continua sendo um MAC legível — o
        // alfabeto seguro apaga os dois-pontos e mantém o hífen, que é separador de MAC também. O
        // mesmo vale para o UUID, que já nasce com hífen. Trocar caractere não é higienizar.
        assertEquals(
            "impressora.printercontribution",
            ExportacaoDeContribuicao.nomeDeArquivo("AA:BB:CC:DD:EE:FF"),
        )
        assertEquals(
            "impressora.printercontribution",
            ExportacaoDeContribuicao.nomeDeArquivo("00000000-0000-4000-8000-000000000077"),
        )
        // E o nome honesto que só por acaso tem hífen continua passando inteiro.
        assertEquals(
            "balcao-da-frente.printercontribution",
            ExportacaoDeContribuicao.nomeDeArquivo("Balcão-da-frente"),
        )
    }

    @Test
    fun `o nome do arquivo nao carrega o identificador local nem a chave de capacidade`() {
        // Nem o UUID da instalação nem o hash da capacidade entram no nome: o primeiro é
        // identidade, e o segundo é ruído que ninguém no balcão sabe ler.
        val perfil = perfilMedido("Balcao")

        val arquivo = ExportacaoDeContribuicao.nomeDeArquivo(perfil.displayName)

        assertEquals("balcao.printercontribution", arquivo)
        assertFalse(arquivo.contains(perfil.id))
        assertFalse(arquivo.contains(perfil.capabilityKey.value))
    }

    private fun conteudoComoTexto(perfil: MeasuredProfile): String {
        val preparo = ExportacaoDeContribuicao.preparar(perfil, "16", "2.4.0")
        return (preparo as PreparoDaContribuicao.Pronto)
            .pacote
            .conteudo
            .toString(StandardCharsets.UTF_8)
    }

    private fun perfilMedido(displayName: String): MeasuredProfile =
        MeasuredProfile.createLocal(
            id = "00000000-0000-4000-8000-000000000077",
            displayName = displayName,
            transports = setOf(PrinterTransport.LOCAL_WIFI),
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            codePage = ThermalCodePage.CP850,
            textEncoding = ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE,
            cutProtocol = CutProtocol.GS_V_1,
            cutFeedLines = 5,
            measuredAtEpochMillis = 1_700_000_000_000,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    private companion object {
        /**
         * As formas que denunciam identidade física, e não capacidade.
         *
         * São as mesmas de `MeasuredProfile.TECHNICAL_IDENTIFIER_PATTERNS`, reescritas aqui porque
         * lá elas são `internal` do outro módulo. Divergir não afrouxa a prova: uma forma a mais
         * aqui só torna esta suíte mais severa que a validação do perfil.
         */
        val FORMATOS_DE_ENDERECO =
            listOf(
                "IP" to Regex("(?:^|\\D)(?:\\d{1,3}\\.){3}\\d{1,3}(?:$|\\D)"),
                "MAC" to Regex("(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}"),
                "UUID" to Regex("(?i)\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b"),
            )

        /**
         * A porta de rede só e checada no **nome do arquivo**.
         *
         * No JSON ela seria falso positivo esperando acontecer — o proprio separador do formato e
         * `":"`, e um campo numerico novo colado no separador acusaria endereco onde ha geometria.
         * No nome do arquivo o alfabeto e fechado, entao a checagem e barata e nao envelhece.
         */
        val PORTA_DE_REDE = "porta de rede" to Regex(":\\d{2,5}\\b")

        val ALFABETO_SEGURO = Regex("^[a-z0-9-]+\\.printercontribution$")
    }
}
