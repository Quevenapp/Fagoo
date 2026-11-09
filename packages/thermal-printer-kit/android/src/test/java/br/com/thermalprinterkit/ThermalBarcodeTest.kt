package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A régua de módulos e os dois emissores de código.
 *
 * **O bloco de paridade é o que mais importa aqui.** Os vetores de
 * [ThermalBarcodeParityVectors] são literais idênticos, caractere a caractere, aos de
 * `ios/Tests/ThermalPrinterKitTests/ThermalBarcodeTests.swift`. Não são a saída da implementação
 * gravada de volta: saíram de uma referência escrita à parte, a partir da especificação de cada
 * simbologia, e o Code 128 de cada um foi **decodificado de volta** ao conteúdo de origem antes de
 * virar literal. Quem mudar a régua de um lado só faz esta suíte falhar alto nos dois.
 *
 * As seis que chegaram depois — EAN-8, UPC-A, UPC-E, Code 39, Codabar e Code 93 — saíram do mesmo
 * método: referência escrita da especificação, decodificador que volta dos módulos ao conteúdo
 * conferindo verificador, e cruzamento valor a valor com uma implementação alheia. O UPC-E ganhou
 * ainda uma varredura dos 2.000.000 de seis-dígitos, que é de onde vem a regra de canonicidade.
 *
 * O que estes testes **não** provam: que um leitor lê o papel, e que alguma firmware aceita `GS k`
 * ou `GS ( k`. Isso é bancada, e nada aqui autoriza chamar de verificado.
 */
class ThermalBarcodeTest {
    // --- paridade entre plataformas ----------------------------------------------------------

    @Test
    fun `os modulos de cada vetor sao os mesmos das duas plataformas`() {
        ThermalBarcodeParityVectors.ALL.forEach { vector ->
            val modules = ThermalBarcode.modules(vector.value, vector.symbology)
            assertNotNull("${vector.symbology} ${vector.value} não codificou", modules)
            assertEquals(
                "${vector.symbology} ${vector.value}",
                vector.modules,
                modules!!.joinToString("") { if (it) "1" else "0" },
            )
        }
    }

    @Test
    fun `o dado nativo de cada vetor e o mesmo das duas plataformas`() {
        ThermalBarcodeParityVectors.ALL.forEach { vector ->
            assertArrayEquals(
                "${vector.symbology} ${vector.value}",
                vector.nativeData,
                ThermalBarcode.nativeData(vector.value, vector.symbology),
            )
        }
    }

    @Test
    fun `o comando nativo do Code 128 sai byte a byte igual ao do iOS`() {
        assertArrayEquals(
            ThermalBarcodeParityVectors.NATIVE_CODE_128,
            EscPosThermalCommands.barcodeNative(
                value = "PRINTHER",
                symbology = ThermalBarcodeSymbology.CODE_128,
                moduleWidthDots = 2,
                heightDots = 80,
                humanReadable = true,
            ),
        )
    }

    @Test
    fun `o comando nativo do EAN 13 sai byte a byte igual ao do iOS`() {
        assertArrayEquals(
            ThermalBarcodeParityVectors.NATIVE_EAN_13,
            EscPosThermalCommands.barcodeNative(
                value = "789100031595",
                symbology = ThermalBarcodeSymbology.EAN_13,
                moduleWidthDots = 3,
                heightDots = 96,
                humanReadable = false,
            ),
        )
    }

    @Test
    fun `o comando nativo do ITF sai byte a byte igual ao do iOS`() {
        assertArrayEquals(
            ThermalBarcodeParityVectors.NATIVE_ITF,
            EscPosThermalCommands.barcodeNative(
                value = "1234567890",
                symbology = ThermalBarcodeSymbology.ITF,
                moduleWidthDots = 2,
                heightDots = 24,
                humanReadable = false,
            ),
        )
    }

    @Test
    fun `o QR nativo sai byte a byte igual ao do iOS`() {
        assertArrayEquals(
            ThermalBarcodeParityVectors.QR_NATIVE,
            EscPosThermalCommands.qrNative(
                value = "PRINTHER",
                moduleSizeDots = 4,
                errorCorrection = 3,
            ),
        )
    }

    @Test
    fun `o raster do codigo de barras sai byte a byte igual ao do iOS`() {
        assertArrayEquals(
            ThermalBarcodeParityVectors.rasterItf00(),
            EscPosThermalCommands.barcodeRaster(
                value = "00",
                symbology = ThermalBarcodeSymbology.ITF,
                moduleWidthDots = 2,
                heightDots = 24,
                printableDots = 384,
            ),
        )
    }

    @Test
    fun `o comando nativo do Codabar sai byte a byte igual ao do iOS`() {
        assertArrayEquals(
            ThermalBarcodeParityVectors.NATIVE_CODABAR,
            EscPosThermalCommands.barcodeNative(
                value = "a123456789b",
                symbology = ThermalBarcodeSymbology.CODABAR,
                moduleWidthDots = 2,
                heightDots = 48,
                humanReadable = true,
            ),
        )
    }

    @Test
    fun `o comando nativo do UPC E leva o UPC A expandido`() {
        assertArrayEquals(
            ThermalBarcodeParityVectors.NATIVE_UPC_E,
            EscPosThermalCommands.barcodeNative(
                value = "01234565",
                symbology = ThermalBarcodeSymbology.UPC_E,
                moduleWidthDots = 3,
                heightDots = 80,
                humanReadable = false,
            ),
        )
    }

    @Test
    fun `o raster do UPC E sai byte a byte igual ao do iOS`() {
        assertArrayEquals(
            ThermalBarcodeParityVectors.rasterUpcE(),
            EscPosThermalCommands.barcodeRaster(
                value = "01234565",
                symbology = ThermalBarcodeSymbology.UPC_E,
                moduleWidthDots = 2,
                heightDots = 24,
                printableDots = 384,
            ),
        )
    }

    @Test
    fun `os rawValue dos enums sao os mesmos das duas plataformas`() {
        assertEquals(
            listOf("RASTERIZED", "NATIVE"),
            ThermalCodeEmission.entries.map { it.name },
        )
        assertEquals(ThermalCodeEmission.RASTERIZED, ThermalCodeEmission.DEFAULT)
        assertEquals(
            listOf(
                "CODE_128", "EAN_13", "ITF", "EAN_8", "UPC_A", "UPC_E",
                "CODE_39", "CODABAR", "CODE_93",
            ),
            ThermalBarcodeSymbology.entries.map { it.name },
        )
        // Os mesmos `m` que o interpretador ESC/POS da fachada de Mac já mapeia. Divergir aqui
        // criaria duas verdades sobre o mesmo comando.
        assertEquals(
            listOf(73, 67, 70, 68, 65, 66, 69, 71, 72),
            ThermalBarcodeSymbology.entries.map { it.nativeSelector },
        )
        assertEquals(
            listOf(
                10 to 10, 11 to 7, 10 to 10, 7 to 7, 9 to 9, 9 to 7,
                10 to 10, 10 to 10, 10 to 10,
            ),
            ThermalBarcodeSymbology.entries.map {
                it.quietZoneModulesStart to it.quietZoneModulesEnd
            },
        )
    }

    @Test
    fun `os limites publicados sao os mesmos das duas plataformas`() {
        assertEquals(2..6, ThermalBarcode.MODULE_WIDTH_DOTS_RANGE)
        assertEquals(24..255, ThermalBarcode.HEIGHT_DOTS_RANGE)
        assertEquals(80, ThermalBarcode.DEFAULT_HEIGHT_DOTS)
        assertEquals(1..128, ThermalBarcode.CODE_128_LENGTH_RANGE)
        assertEquals(12..13, ThermalBarcode.EAN_13_LENGTH_RANGE)
        assertEquals(2..64, ThermalBarcode.ITF_LENGTH_RANGE)
        assertEquals(7..8, ThermalBarcode.EAN_8_LENGTH_RANGE)
        assertEquals(11..12, ThermalBarcode.UPC_A_LENGTH_RANGE)
        assertEquals(6..8, ThermalBarcode.UPC_E_LENGTH_RANGE)
        assertEquals(11..12, ThermalBarcode.UPC_E_EXPANDED_LENGTH_RANGE)
        assertEquals(1..64, ThermalBarcode.CODE_39_LENGTH_RANGE)
        assertEquals(3..64, ThermalBarcode.CODABAR_LENGTH_RANGE)
        assertEquals(1..64, ThermalBarcode.CODE_93_LENGTH_RANGE)
        assertEquals(
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. \$/+%",
            ThermalBarcode.CODE_39_ALPHABET,
        )
        assertEquals(ThermalBarcode.CODE_39_ALPHABET, ThermalBarcode.CODE_93_ALPHABET)
        assertEquals("0123456789-\$:/.+", ThermalBarcode.CODABAR_DATA_ALPHABET)
        assertEquals("ABCD", ThermalBarcode.CODABAR_DELIMITERS)
        assertEquals(8..640, ThermalBarcode.PRINTABLE_DOTS_RANGE)
        assertEquals(1..16, ThermalBarcode.QR_NATIVE_MODULE_SIZE_DOTS_RANGE)
        assertEquals(1..4, ThermalBarcode.QR_NATIVE_ERROR_CORRECTION_RANGE)
        assertEquals(512, ThermalBarcode.QR_NATIVE_MAX_BYTES)
        assertEquals(255, ThermalBarcode.MAX_NATIVE_DATA_BYTES)
    }

    // --- estrutura de cada simbologia, conferível na régua --------------------------------------

    @Test
    fun `o Code 128 tem onze modulos por valor e treze na parada`() {
        // Início + dados + verificador = 11 módulos cada; a parada soma 13 pela barra dupla.
        // "PRINTHER" são oito valores de dado no conjunto B: 10 valores de 11 mais 13 = 123.
        assertEquals(123, ThermalBarcode.moduleCount("PRINTHER", ThermalBarcodeSymbology.CODE_128)!!)
        // "12345678" entra no conjunto C e vira quatro pares: 6 valores de 11 mais 13 = 79.
        assertEquals(79, ThermalBarcode.moduleCount("12345678", ThermalBarcodeSymbology.CODE_128)!!)
    }

    @Test
    fun `o EAN 13 tem sempre noventa e cinco modulos e as tres guardas no lugar`() {
        val modules =
            ThermalBarcode.modules("5901234123457", ThermalBarcodeSymbology.EAN_13)!!
        assertEquals(95, modules.size)
        assertEquals(listOf(true, false, true), modules.subList(0, 3))
        assertEquals(listOf(false, true, false, true, false), modules.subList(45, 50))
        assertEquals(listOf(true, false, true), modules.subList(92, 95))
    }

    @Test
    fun `o ITF cresce nove modulos por digito sobre os nove do quadro`() {
        listOf(2, 4, 10, 64).forEach { length ->
            val value = "1".repeat(length)
            assertEquals(
                9 + 9 * length,
                ThermalBarcode.moduleCount(value, ThermalBarcodeSymbology.ITF)!!,
            )
        }
    }

    @Test
    fun `o EAN 8 tem sessenta e sete modulos e nao esconde digito na paridade`() {
        val modules = ThermalBarcode.modules("96385074", ThermalBarcodeSymbology.EAN_8)!!
        assertEquals(67, modules.size)
        assertEquals(listOf(true, false, true), modules.subList(0, 3))
        assertEquals(listOf(false, true, false, true, false), modules.subList(31, 36))
        assertEquals(listOf(true, false, true), modules.subList(64, 67))
    }

    @Test
    fun `o UPC A e o EAN 13 de zero mais os doze, e nao os doze como corpo`() {
        // A armadilha clássica desta simbologia, fixada em teste: o símbolo do UPC-A é o do EAN-13
        // com um zero na frente — e o verificador é o mesmo dígito, não um recalculado.
        val upcA = ThermalBarcode.modules("036000291452", ThermalBarcodeSymbology.UPC_A)!!
        val ean13 = ThermalBarcode.modules("0036000291452", ThermalBarcodeSymbology.EAN_13)!!
        assertEquals(95, upcA.size)
        assertEquals(ean13, upcA)
        // E tratar os doze do UPC-A como corpo de EAN-13 dá outro número: a prova de que não é a
        // mesma conta.
        assertEquals(
            ThermalBarcodeValidation.Accepted("0360002914522"),
            ThermalBarcode.validate("036000291452", ThermalBarcodeSymbology.EAN_13),
        )
    }

    @Test
    fun `o UPC E tem cinquenta e um modulos e a guarda de fim de seis`() {
        val modules = ThermalBarcode.modules("01234565", ThermalBarcodeSymbology.UPC_E)!!
        assertEquals(51, modules.size)
        assertEquals(listOf(true, false, true), modules.subList(0, 3))
        assertEquals(
            listOf(false, true, false, true, false, true),
            modules.subList(45, 51),
        )
    }

    @Test
    fun `o Code 39 cresce dezesseis modulos por caractere sobre os trinta e um do quadro`() {
        listOf("A", "PRINTHER", "A".repeat(64)).forEach { value ->
            assertEquals(
                16 * value.length + 31,
                ThermalBarcode.moduleCount(value, ThermalBarcodeSymbology.CODE_39)!!,
            )
        }
    }

    @Test
    fun `o Code 93 cresce nove modulos por caractere sobre os trinta e sete do quadro`() {
        // Trinta e sete = quatro caracteres de quadro (início, C, K e fim) mais a barra final.
        listOf("A", "PRINTHER", "A".repeat(64)).forEach { value ->
            assertEquals(
                9 * value.length + 37,
                ThermalBarcode.moduleCount(value, ThermalBarcodeSymbology.CODE_93)!!,
            )
        }
    }

    @Test
    fun `o Codabar leva as marcas de inicio e fim como dado`() {
        // Marca minúscula é a mesma marca, e vira maiúscula no conteúdo normalizado — que é o que
        // vai para o `GS k` e para a legenda.
        assertEquals(
            ThermalBarcodeValidation.Accepted("A0A"),
            ThermalBarcode.validate("a0a", ThermalBarcodeSymbology.CODABAR),
        )
        assertEquals(
            ThermalBarcode.modules("A0A", ThermalBarcodeSymbology.CODABAR),
            ThermalBarcode.modules("a0a", ThermalBarcodeSymbology.CODABAR),
        )
        // Marcas diferentes dão símbolos diferentes: elas **são** dado.
        assertTrue(
            ThermalBarcode.modules("A0A", ThermalBarcodeSymbology.CODABAR) !=
                ThermalBarcode.modules("A0B", ThermalBarcodeSymbology.CODABAR),
        )
    }

    @Test
    fun `todo simbolo comeca e termina em barra nas nove simbologias`() {
        ThermalBarcodeParityVectors.ALL.forEach { vector ->
            val modules = ThermalBarcode.modules(vector.value, vector.symbology)!!
            assertTrue("${vector.symbology} ${vector.value}", modules.first())
            assertTrue("${vector.symbology} ${vector.value}", modules.last())
        }
    }

    // --- validação e frases --------------------------------------------------------------------

    @Test
    fun `conteudo vazio e recusado em qualquer simbologia`() {
        ThermalBarcodeSymbology.entries.forEach { symbology ->
            val result = ThermalBarcode.validate("", symbology)
            assertEquals(
                ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.Empty),
                result,
            )
        }
        assertEquals("Digite o conteúdo do código.", ThermalBarcodeRejection.Empty.message)
    }

    @Test
    fun `o Code 128 recusa acento e recusa acima de cento e vinte e oito caracteres`() {
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonAscii),
            ThermalBarcode.validate("ação", ThermalBarcodeSymbology.CODE_128),
        )
        assertEquals(
            "O código aceita apenas letras e números sem acento.",
            ThermalBarcodeRejection.NonAscii.message,
        )
        assertEquals(
            ThermalBarcodeValidation.Accepted("A".repeat(128)),
            ThermalBarcode.validate("A".repeat(128), ThermalBarcodeSymbology.CODE_128),
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.TooLong(128)),
            ThermalBarcode.validate("A".repeat(129), ThermalBarcodeSymbology.CODE_128),
        )
        assertEquals(
            "O código aceita no máximo 128 caracteres.",
            ThermalBarcodeRejection.TooLong(128).message,
        )
    }

    @Test
    fun `o EAN 13 calcula o verificador de doze digitos e confere o de treze`() {
        assertEquals(
            ThermalBarcodeValidation.Accepted("7891000315958"),
            ThermalBarcode.validate("789100031595", ThermalBarcodeSymbology.EAN_13),
        )
        assertEquals(
            ThermalBarcodeValidation.Accepted("7891000315958"),
            ThermalBarcode.validate("7891000315958", ThermalBarcodeSymbology.EAN_13),
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.BadCheckDigit),
            ThermalBarcode.validate("7891000315957", ThermalBarcodeSymbology.EAN_13),
        )
        assertEquals(
            "O dígito verificador não confere.",
            ThermalBarcodeRejection.BadCheckDigit.message,
        )
    }

    @Test
    fun `o EAN 13 recusa comprimento fora de doze ou treze e recusa letra`() {
        listOf("1", "12345678901", "12345678901234").forEach { value ->
            assertEquals(
                value,
                ThermalBarcodeValidation.Rejected(
                    ThermalBarcodeRejection.WrongLength("12 ou 13 dígitos"),
                ),
                ThermalBarcode.validate(value, ThermalBarcodeSymbology.EAN_13),
            )
        }
        assertEquals(
            "Este código precisa de 12 ou 13 dígitos.",
            ThermalBarcodeRejection.WrongLength("12 ou 13 dígitos").message,
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonDigit),
            ThermalBarcode.validate("78910003159A", ThermalBarcodeSymbology.EAN_13),
        )
        assertEquals("Este código aceita apenas dígitos.", ThermalBarcodeRejection.NonDigit.message)
    }

    @Test
    fun `o ITF recusa comprimento impar em vez de completar com zero`() {
        assertEquals(
            ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength(
                    "um número par de dígitos, de 2 a 64",
                ),
            ),
            ThermalBarcode.validate("12345", ThermalBarcodeSymbology.ITF),
        )
        assertEquals(
            "Este código precisa de um número par de dígitos, de 2 a 64.",
            ThermalBarcodeRejection.WrongLength("um número par de dígitos, de 2 a 64").message,
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonDigit),
            ThermalBarcode.validate("12AB", ThermalBarcodeSymbology.ITF),
        )
        assertNull(ThermalBarcode.modules("12345", ThermalBarcodeSymbology.ITF))
    }

    @Test
    fun `o EAN 8 e o UPC A calculam o verificador e conferem o que veio`() {
        assertEquals(
            ThermalBarcodeValidation.Accepted("96385074"),
            ThermalBarcode.validate("9638507", ThermalBarcodeSymbology.EAN_8),
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.BadCheckDigit),
            ThermalBarcode.validate("96385075", ThermalBarcodeSymbology.EAN_8),
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength("7 ou 8 dígitos"),
            ),
            ThermalBarcode.validate("963850", ThermalBarcodeSymbology.EAN_8),
        )
        assertEquals(
            ThermalBarcodeValidation.Accepted("036000291452"),
            ThermalBarcode.validate("03600029145", ThermalBarcodeSymbology.UPC_A),
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.BadCheckDigit),
            ThermalBarcode.validate("036000291453", ThermalBarcodeSymbology.UPC_A),
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength("11 ou 12 dígitos"),
            ),
            ThermalBarcode.validate("0360002914", ThermalBarcodeSymbology.UPC_A),
        )
    }

    @Test
    fun `o UPC E aceita as duas formas e recusa o que nao tem forma`() {
        // Seis dígitos, sistema numérico assumido 0.
        assertEquals(
            ThermalBarcodeValidation.Accepted("00425261"),
            ThermalBarcode.validate("042526", ThermalBarcodeSymbology.UPC_E),
        )
        // O UPC-A equivalente diz o mesmo número.
        assertEquals(
            ThermalBarcodeValidation.Accepted("04252614"),
            ThermalBarcode.validate("042100005264", ThermalBarcodeSymbology.UPC_E),
        )
        assertEquals(
            ThermalBarcodeValidation.Accepted("04252614"),
            ThermalBarcode.validate("04210000526", ThermalBarcodeSymbology.UPC_E),
        )
        // UPC-A cujos zeros não estão onde a compressão exige não tem forma UPC-E.
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NotCompressible),
            ThermalBarcode.validate("036000291452", ThermalBarcodeSymbology.UPC_E),
        )
        // Sistema numérico fora de 0 e 1 também não.
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NotCompressible),
            ThermalBarcode.validate("2425261", ThermalBarcodeSymbology.UPC_E),
        )
        // **Não canônico**: `000003` e `000000` expandem para o mesmo UPC-A, e a firmware que
        // recebe o `GS k m=66` desenharia o segundo. Recusar é o que mantém raster e nativo iguais.
        assertEquals(
            ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NotCompressible),
            ThermalBarcode.validate("000003", ThermalBarcodeSymbology.UPC_E),
        )
        assertEquals(
            ThermalBarcodeValidation.Accepted("00000000"),
            ThermalBarcode.validate("000000", ThermalBarcodeSymbology.UPC_E),
        )
        assertEquals(
            "Este número não tem forma UPC-E.",
            ThermalBarcodeRejection.NotCompressible.message,
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength(
                    "6, 7 ou 8 dígitos, ou 11 ou 12 dígitos na forma UPC-A",
                ),
            ),
            ThermalBarcode.validate("0123456789", ThermalBarcodeSymbology.UPC_E),
        )
    }

    @Test
    fun `o Code 39 e o Code 93 recusam minuscula e recusam o asterisco`() {
        val allowed = "dígitos, letras maiúsculas e os sinais - . espaço \$ / + %"
        listOf(ThermalBarcodeSymbology.CODE_39, ThermalBarcodeSymbology.CODE_93).forEach {
            assertEquals(
                it.name,
                ThermalBarcodeValidation.Rejected(
                    ThermalBarcodeRejection.UnsupportedContent(allowed),
                ),
                ThermalBarcode.validate("abc", it),
            )
            // O `*` é marca de quadro, não conteúdo — e o `GS k m=69` também não o aceita.
            assertEquals(
                it.name,
                ThermalBarcodeValidation.Rejected(
                    ThermalBarcodeRejection.UnsupportedContent(allowed),
                ),
                ThermalBarcode.validate("A*B", it),
            )
            assertEquals(
                it.name,
                ThermalBarcodeValidation.Accepted("AB-12. \$/+%"),
                ThermalBarcode.validate("AB-12. \$/+%", it),
            )
        }
        assertEquals(
            "Este código aceita apenas dígitos, letras maiúsculas e os sinais - . espaço \$ / + %.",
            ThermalBarcodeRejection.UnsupportedContent(allowed).message,
        )
    }

    @Test
    fun `o Codabar exige marca nas duas pontas e alfabeto proprio no miolo`() {
        val allowed = "dígitos e os sinais - \$ : / . + entre as marcas A, B, C ou D"
        assertEquals(
            ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.UnsupportedContent(allowed),
            ),
            ThermalBarcode.validate("123456", ThermalBarcodeSymbology.CODABAR),
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.UnsupportedContent(allowed),
            ),
            ThermalBarcode.validate("A12E", ThermalBarcodeSymbology.CODABAR),
        )
        // Marca no meio também não: ela só existe nas pontas.
        assertEquals(
            ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.UnsupportedContent(allowed),
            ),
            ThermalBarcode.validate("A1B2C", ThermalBarcodeSymbology.CODABAR),
        )
        assertEquals(
            ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength(
                    "de 3 a 64 caracteres, contando as marcas de início e fim",
                ),
            ),
            ThermalBarcode.validate("AB", ThermalBarcodeSymbology.CODABAR),
        )
        assertEquals(
            ThermalBarcodeValidation.Accepted("A-\$:/.+0B"),
            ThermalBarcode.validate("A-\$:/.+0B", ThermalBarcodeSymbology.CODABAR),
        )
    }

    @Test
    fun `a recusa por largura tem frase propria porque quem sabe a largura e o layout`() {
        assertEquals(
            "O código não cabe na largura desta impressora.",
            ThermalBarcodeRejection.DoesNotFit.message,
        )
    }

    // --- codificar para medir ------------------------------------------------------------------

    @Test
    fun `a largura de modulo sai da divisao da area imprimivel pela contagem`() {
        // "12345678" tem 79 módulos e 20 de zona: 99 no total. 384 / 99 = 3.
        assertEquals(
            3,
            ThermalBarcode.moduleWidthDots("12345678", ThermalBarcodeSymbology.CODE_128, 384)!!,
        )
        // O teto de seis vale mesmo em papel largo: 640 / 47 seriam 13.
        assertEquals(6, ThermalBarcode.moduleWidthDots("00", ThermalBarcodeSymbology.ITF, 640)!!)
    }

    @Test
    fun `codigo que nao cabe nem no modulo minimo devolve nulo`() {
        // 64 dígitos de ITF são 585 módulos e 605 com zona: nem dois pontos por módulo cabem em 640.
        assertNull(
            ThermalBarcode.moduleWidthDots("12".repeat(32), ThermalBarcodeSymbology.ITF, 640),
        )
        // "00" com zona são 47 módulos; a dois pontos são 94, e 88 não os comporta.
        assertNull(ThermalBarcode.moduleWidthDots("00", ThermalBarcodeSymbology.ITF, 88))
        // Largura que não é múltiplo de oito não empacota, mesmo com folga de sobra.
        assertNull(ThermalBarcode.moduleWidthDots("00", ThermalBarcodeSymbology.ITF, 380))
    }

    // --- emissores crus dizem não ---------------------------------------------------------------

    @Test
    fun `o raster recusa numero fora da faixa em vez de emitir barra torta`() {
        val ok =
            EscPosThermalCommands.barcodeRaster(
                value = "PRINTHER",
                symbology = ThermalBarcodeSymbology.CODE_128,
                moduleWidthDots = 2,
                heightDots = 80,
                printableDots = 384,
            )
        assertNotNull(ok)
        listOf(1, 7).forEach { width ->
            assertNull(
                EscPosThermalCommands.barcodeRaster(
                    "PRINTHER", ThermalBarcodeSymbology.CODE_128, width, 80, 384,
                ),
            )
        }
        listOf(23, 256).forEach { height ->
            assertNull(
                EscPosThermalCommands.barcodeRaster(
                    "PRINTHER", ThermalBarcodeSymbology.CODE_128, 2, height, 384,
                ),
            )
        }
        // Largura que não é múltiplo de oito não empacota, e 648 passa do papel homologável.
        listOf(380, 648).forEach { printable ->
            assertNull(
                EscPosThermalCommands.barcodeRaster(
                    "PRINTHER", ThermalBarcodeSymbology.CODE_128, 2, 80, printable,
                ),
            )
        }
        // Conteúdo recusado pela simbologia nunca vira bytes.
        assertNull(
            EscPosThermalCommands.barcodeRaster(
                "12345", ThermalBarcodeSymbology.ITF, 2, 80, 384,
            ),
        )
        // Símbolo que não cabe na largura também não.
        assertNull(
            EscPosThermalCommands.barcodeRaster(
                "PRINTHER", ThermalBarcodeSymbology.CODE_128, 6, 80, 384,
            ),
        )
    }

    @Test
    fun `o nativo recusa numero fora da faixa em vez de montar comando torto`() {
        assertNull(
            EscPosThermalCommands.barcodeNative(
                "PRINTHER", ThermalBarcodeSymbology.CODE_128, 1, 80, false,
            ),
        )
        assertNull(
            EscPosThermalCommands.barcodeNative(
                "PRINTHER", ThermalBarcodeSymbology.CODE_128, 2, 256, false,
            ),
        )
        // Verificador errado não vira comando: o `GS k` sairia com um número que nenhum leitor
        // aceita, e a firmware não confere nada por nós.
        assertNull(
            EscPosThermalCommands.barcodeNative(
                "7891000315957", ThermalBarcodeSymbology.EAN_13, 2, 80, false,
            ),
        )
    }

    @Test
    fun `o QR nativo recusa payload vazio acentuado ou fora dos limites`() {
        assertNull(EscPosThermalCommands.qrNative("", 4, 3))
        assertNull(EscPosThermalCommands.qrNative("ação", 4, 3))
        assertNull(EscPosThermalCommands.qrNative("A".repeat(513), 4, 3))
        assertNull(EscPosThermalCommands.qrNative("PRINTHER", 0, 3))
        assertNull(EscPosThermalCommands.qrNative("PRINTHER", 17, 3))
        assertNull(EscPosThermalCommands.qrNative("PRINTHER", 4, 0))
        assertNull(EscPosThermalCommands.qrNative("PRINTHER", 4, 5))
    }

    @Test
    fun `o nivel de correcao do QR nativo vai como quarenta e oito mais o nivel`() {
        listOf(1 to 0x30, 2 to 0x31, 3 to 0x32, 4 to 0x33).forEach { (level, byte) ->
            val command = EscPosThermalCommands.qrNative("PRINTHER", 4, level)!!
            // O byte da função 169 é o último do segundo bloco: 3 do `ESC a 1` mais os 8 da 167.
            assertEquals(level.toString(), byte, command[3 + 8 + 7].toInt() and 0xff)
        }
    }

    @Test
    fun `o lado do QR sem zona de silencio e o do simbolo`() {
        // Versão 1 tem 21 módulos de lado, e um payload de um byte cabe nela em qualquer nível.
        assertEquals(21, EscPosThermalCommands.qrModuleSide("A", 3)!!)
        assertNull(EscPosThermalCommands.qrModuleSide("", 3))
        assertNull(EscPosThermalCommands.qrModuleSide("ação", 3))
        assertNull(EscPosThermalCommands.qrModuleSide("A", 0))
        // Payload maior obriga versão maior, e o lado cresce de quatro em quatro.
        val bigger = EscPosThermalCommands.qrModuleSide("A".repeat(200), 3)!!
        assertTrue(bigger > 21)
        assertEquals(1, bigger % 4)
    }

    // --- o mesmo símbolo nos dois modos ----------------------------------------------------------

    @Test
    fun `o conjunto C escolhido pelo desenho e o mesmo que viaja no escape nativo`() {
        // Quatro dígitos ou mais em corrida par entram em C; a régua e o `GS k` têm de concordar,
        // senão o mesmo texto sairia com dois símbolos conforme o ajuste de emissão.
        assertArrayEquals(
            byteArrayOf(0x7b, 0x43, 12, 34, 56, 78),
            ThermalBarcode.nativeData("12345678", ThermalBarcodeSymbology.CODE_128),
        )
        // Corrida ímpar sai com o primeiro dígito em B e o resto em C, sem sobra.
        assertArrayEquals(
            byteArrayOf(0x7b, 0x42, 0x31, 0x7b, 0x43, 23, 45, 67, 89),
            ThermalBarcode.nativeData("123456789", ThermalBarcodeSymbology.CODE_128),
        )
        // Menos de quatro dígitos não compensa trocar de conjunto, exceto o par sozinho.
        assertArrayEquals(
            byteArrayOf(0x7b, 0x42, 0x31, 0x32, 0x33),
            ThermalBarcode.nativeData("123", ThermalBarcodeSymbology.CODE_128),
        )
        assertArrayEquals(
            byteArrayOf(0x7b, 0x43, 12),
            ThermalBarcode.nativeData("12", ThermalBarcodeSymbology.CODE_128),
        )
    }

    @Test
    fun `a chave do conteudo sai dobrada porque ela e o escape do protocolo`() {
        assertArrayEquals(
            byteArrayOf(0x7b, 0x42, 0x7b, 0x7b, 0x71, 0x7d),
            ThermalBarcode.nativeData("{q}", ThermalBarcodeSymbology.CODE_128),
        )
    }

    @Test
    fun `o EAN 13 nativo viaja com os treze digitos que o desenho usou`() {
        assertArrayEquals(
            "7891000315958".toByteArray(Charsets.US_ASCII),
            ThermalBarcode.nativeData("789100031595", ThermalBarcodeSymbology.EAN_13),
        )
    }

    @Test
    fun `o raster do mesmo conteudo tem a largura que a contagem de modulos previu`() {
        // 27 módulos de "00" mais 20 de zona, a dois pontos, são 94 pontos — e 96 empacotados.
        val command =
            EscPosThermalCommands.barcodeRaster(
                "00", ThermalBarcodeSymbology.ITF, 2, 24, 384,
            )!!
        // `ESC a 1` e então `GS v 0 0 xL xH yL yH`.
        assertEquals(96 / 8, command[3 + 4].toInt())
        assertEquals(0, command[3 + 5].toInt())
        assertEquals(24, command[3 + 6].toInt())
    }
}

/**
 * Os vetores fixos da paridade Android–iOS.
 *
 * **Estes literais são idênticos aos de `ThermalBarcodeTests.swift`.** Quem alterar um altera o
 * outro no mesmo commit, ou as duas suítes discordam — que é exatamente o que se quer que aconteça
 * quando as réguas divergirem.
 */
internal object ThermalBarcodeParityVectors {
    internal class Vector(
        val symbology: ThermalBarcodeSymbology,
        val value: String,
        val modules: String,
        native: List<Int>,
    ) {
        val nativeData: ByteArray = ByteArray(native.size) { native[it].toByte() }
    }

    val ALL =
        listOf(
            Vector(
                ThermalBarcodeSymbology.CODE_128,
                "PRINTHER",
                "110100100001110111011011000101110110001000101011100011011011100010110001010001" +
                    "000110100011000101110101100001001100011101011",
                listOf(123, 66, 80, 82, 73, 78, 84, 72, 69, 82),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_128,
                "12345678",
                "110100111001011001110010001011000111000101101100001010010001110110110001110" +
                    "1011",
                listOf(123, 67, 12, 34, 56, 78),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_128,
                "A1",
                "110100100001010001100010011100110100001001101100011101011",
                listOf(123, 66, 65, 49),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_128,
                "{q}",
                "11010010000111101101101001011110010100011110110011100101100011101011",
                listOf(123, 66, 123, 123, 113, 125),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_128,
                "AB1234567CD",
                "110100100001010001100010001011000100111001101011101111011101101110101110110" +
                    "0010000101100101111011101000100011010110001000111101010001100011101011",
                listOf(123, 66, 65, 66, 49, 123, 67, 23, 45, 67, 123, 66, 67, 68),
            ),
            Vector(
                ThermalBarcodeSymbology.EAN_13,
                "789100031595",
                "10101101110010111001100101001110001101010011101010100001011001101001110111010" +
                    "010011101001000101",
                listOf(55, 56, 57, 49, 48, 48, 48, 51, 49, 53, 57, 53, 56),
            ),
            Vector(
                ThermalBarcodeSymbology.EAN_13,
                "5901234123457",
                "10100010110100111011001100100110111101001110101010110011011011001000010101110" +
                    "010011101000100101",
                listOf(53, 57, 48, 49, 50, 51, 52, 49, 50, 51, 52, 53, 55),
            ),
            Vector(
                ThermalBarcodeSymbology.ITF,
                "1234567890",
                "101011101000101011100011101110100010100011101000111000101010001010111000111010" +
                    "111010001110001011101",
                listOf(49, 50, 51, 52, 53, 54, 55, 56, 57, 48),
            ),
            Vector(
                ThermalBarcodeSymbology.ITF,
                "00",
                "101010101110001110001011101",
                listOf(48, 48),
            ),
            Vector(
                ThermalBarcodeSymbology.EAN_8,
                "9638507",
                "1010001011010111101111010110111010101001110111001010001001011100101",
                listOf(57, 54, 51, 56, 53, 48, 55, 52),
            ),
            Vector(
                ThermalBarcodeSymbology.EAN_8,
                "12345670",
                "1010011001001001101111010100011010101001110101000010001001110010101",
                listOf(49, 50, 51, 52, 53, 54, 55, 48),
            ),
            Vector(
                ThermalBarcodeSymbology.UPC_A,
                "03600029145",
                "1010001101011110101011110001101000110100011010101011011001110100110011010111" +
                    "0010011101101100101",
                listOf(48, 51, 54, 48, 48, 48, 50, 57, 49, 52, 53, 50),
            ),
            Vector(
                ThermalBarcodeSymbology.UPC_A,
                "012345678905",
                "1010001101001100100100110111101010001101100010101010100001000100100100011101" +
                    "0011100101001110101",
                listOf(48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 53),
            ),
            Vector(
                ThermalBarcodeSymbology.UPC_E,
                "01234565",
                "101011001100100110111101001110101110010101111010101",
                listOf(48, 49, 50, 51, 52, 53, 48, 48, 48, 48, 54, 53),
            ),
            Vector(
                ThermalBarcodeSymbology.UPC_E,
                "042526",
                "101010011100111010010011011100100100110101111010101",
                listOf(48, 48, 52, 50, 53, 50, 48, 48, 48, 48, 54, 49),
            ),
            Vector(
                ThermalBarcodeSymbology.UPC_E,
                "042100005264",
                "101001110100100110111001001101101011110011001010101",
                listOf(48, 52, 50, 49, 48, 48, 48, 48, 53, 50, 54, 52),
            ),
            // Sistema numérico 1: a tabela de paridade inverte inteira, e é a única diferença.
            Vector(
                ThermalBarcodeSymbology.UPC_E,
                "1425261",
                "101010001100100110111001001001100001010110011010101",
                listOf(49, 52, 50, 49, 48, 48, 48, 48, 53, 50, 54, 49),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_39,
                "PRINTHER",
                "1000101110111010101110111010001011101010111000101011101000111010101011101000" +
                    "1110101011101110001011101010001110101110101110001010111010101110001010001011" +
                    "1011101",
                listOf(80, 82, 73, 78, 84, 72, 69, 82),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_39,
                "ABC-123",
                "1000101110111010111010100010111010111010001011101110111010001010100010101110" +
                    "1110111010001010111010111000101011101110111000101010100010111011101",
                listOf(65, 66, 67, 45, 49, 50, 51),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_39,
                "A",
                "10001011101110101110101000101110100010111011101",
                listOf(65),
            ),
            Vector(
                ThermalBarcodeSymbology.CODABAR,
                "A123456789B",
                "1011100010001010101110001010100010111011100010101010111010001011101010001010" +
                    "00101011101000101110101000111010101110100010101000100010111",
                listOf(65, 49, 50, 51, 52, 53, 54, 55, 56, 57, 66),
            ),
            Vector(
                ThermalBarcodeSymbology.CODABAR,
                "C40156B",
                "1010001000111010111010001010101000111010101110001011101010001010001010111010" +
                    "00100010111",
                listOf(67, 52, 48, 49, 53, 54, 66),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_93,
                "PRINTHER",
                "1010111101000101101101100101011000101010001101101001101011001001100100101101" +
                    "100101001110101100010101010111101",
                listOf(80, 82, 73, 78, 84, 72, 69, 82),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_93,
                "TEST93",
                "1010111101101001101100100101101011001101001101000010101010000101011101101001" +
                    "000101010111101",
                listOf(84, 69, 83, 84, 57, 51),
            ),
            Vector(
                ThermalBarcodeSymbology.CODE_93,
                "A",
                "1010111101101010001101010001100101101010111101",
                listOf(65),
            ),
        )

    val NATIVE_CODE_128: ByteArray =
        bytes(
            0x1b, 0x61, 0x01, 0x1d, 0x68, 0x50, 0x1d, 0x77, 0x02, 0x1d, 0x48, 0x02, 0x1d, 0x66,
            0x00, 0x1d, 0x6b, 0x49, 0x0a, 0x7b, 0x42, 0x50, 0x52, 0x49, 0x4e, 0x54, 0x48, 0x45,
            0x52, 0x1b, 0x61, 0x00,
        )

    val NATIVE_EAN_13: ByteArray =
        bytes(
            0x1b, 0x61, 0x01, 0x1d, 0x68, 0x60, 0x1d, 0x77, 0x03, 0x1d, 0x48, 0x00, 0x1d, 0x66,
            0x00, 0x1d, 0x6b, 0x43, 0x0d, 0x37, 0x38, 0x39, 0x31, 0x30, 0x30, 0x30, 0x33, 0x31,
            0x35, 0x39, 0x35, 0x38, 0x1b, 0x61, 0x00,
        )

    val NATIVE_ITF: ByteArray =
        bytes(
            0x1b, 0x61, 0x01, 0x1d, 0x68, 0x18, 0x1d, 0x77, 0x02, 0x1d, 0x48, 0x00, 0x1d, 0x66,
            0x00, 0x1d, 0x6b, 0x46, 0x0a, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
            0x30, 0x1b, 0x61, 0x00,
        )

    val QR_NATIVE: ByteArray =
        bytes(
            0x1b, 0x61, 0x01, 0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x04, 0x1d, 0x28, 0x6b,
            0x03, 0x00, 0x31, 0x45, 0x32, 0x1d, 0x28, 0x6b, 0x0b, 0x00, 0x31, 0x50, 0x30, 0x50,
            0x52, 0x49, 0x4e, 0x54, 0x48, 0x45, 0x52, 0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51,
            0x30, 0x1b, 0x61, 0x00,
        )

    val NATIVE_CODABAR: ByteArray =
        bytes(
            0x1b, 0x61, 0x01, 0x1d, 0x68, 0x30, 0x1d, 0x77, 0x02, 0x1d, 0x48, 0x02, 0x1d, 0x66,
            0x00, 0x1d, 0x6b, 0x47, 0x0b, 0x41, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
            0x39, 0x42, 0x1b, 0x61, 0x00,
        )

    /**
     * O `GS k m=66` leva o **UPC-A expandido**, e não os oito comprimidos.
     *
     * `01234565` vira `012345000065`, doze bytes: é a especificação do comando que pede assim, e é
     * a firmware que comprime. Este vetor é o que prova que o kit não mandou o número errado.
     */
    val NATIVE_UPC_E: ByteArray =
        bytes(
            0x1b, 0x61, 0x01, 0x1d, 0x68, 0x50, 0x1d, 0x77, 0x03, 0x1d, 0x48, 0x00, 0x1d, 0x66,
            0x00, 0x1d, 0x6b, 0x42, 0x0c, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x30, 0x30, 0x30,
            0x30, 0x36, 0x35, 0x1b, 0x61, 0x00,
        )

    /**
     * A linha empacotada do UPC-E `01234565` a dois pontos por módulo, em papel de 384 pontos.
     *
     * Dezessete bytes. As zonas de silêncio do UPC-E são **assimétricas** — nove módulos à esquerda
     * e sete à direita —, e é isso que este vetor fixa: 51 módulos mais 16 de zona dão 134 pontos,
     * que sobem para 136 no múltiplo de oito, com o ponto de sobra dividido entre os dois lados.
     */
    private val RASTER_UPC_E_ROW =
        bytes(
            0x00, 0x00, 0x19, 0x9e, 0x1e, 0x18, 0x79, 0xfe, 0x61, 0xf9, 0x9f, 0x86,
            0x67, 0xf9, 0x99, 0x80, 0x00,
        )

    /** `ESC a 1`, uma banda `GS v 0` de 24 linhas iguais, e o `ESC a 0` que devolve o estado. */
    fun rasterUpcE(): ByteArray {
        val header = bytes(0x1b, 0x61, 0x01, 0x1d, 0x76, 0x30, 0x00, 0x11, 0x00, 0x18, 0x00)
        var command = header
        repeat(24) { command += RASTER_UPC_E_ROW }
        return command + bytes(0x1b, 0x61, 0x00)
    }

    /**
     * A linha empacotada do ITF "00" a dois pontos por módulo, em papel de 384 pontos.
     *
     * Doze bytes: dois zerados à esquerda e dois à direita são a zona de silêncio de dez módulos
     * mais o ponto de sobra do arredondamento para múltiplo de oito.
     */
    private val RASTER_ITF_00_ROW =
        bytes(0x00, 0x00, 0x06, 0x66, 0x67, 0xe0, 0x7e, 0x06, 0x7e, 0x60, 0x00, 0x00)

    /** `ESC a 1`, uma banda `GS v 0` de 24 linhas iguais, e o `ESC a 0` que devolve o estado. */
    fun rasterItf00(): ByteArray {
        val header = bytes(0x1b, 0x61, 0x01, 0x1d, 0x76, 0x30, 0x00, 0x0c, 0x00, 0x18, 0x00)
        var command = header
        repeat(24) { command += RASTER_ITF_00_ROW }
        return command + bytes(0x1b, 0x61, 0x00)
    }

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
}
