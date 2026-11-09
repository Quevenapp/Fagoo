package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Os dois quadros de configuração Wi-Fi, campo a campo.
 *
 * **O bloco de paridade é o que mais importa aqui.** Os vetores de
 * [ThermalWifiFrameParityVectors] são literais idênticos aos de
 * `ios/Tests/ThermalPrinterKitTests/ThermalWifiFrameTests.swift`. Não são a saída da implementação
 * gravada de volta: os da família `1F 77` saíram do gerador de referência `docs/quadro-wifi.py`,
 * escrito antes desta camada e a partir do desmonte do emissor do fabricante — e o gerador se prova
 * sozinho, porque reproduz exatamente o quadro de 15 bytes que saiu em papel em 21/08/2026. Os da
 * família `1F 1B 1F` saíram dos exemplos trabalhados de `docs/goldensky-configuracao-wifi.md`, que
 * traz os dois quadros já em hexadecimal.
 *
 * O que estes testes **não** provam, e a assimetria é real: que a GoldenSky grava. Da família
 * `1F 1B 1F` a bancada só provou, em 22/08/2026, que o cabeçalho de quatro bytes é honrado na TCP
 * 9100 e que o layout do `B3` está certo — com um quadro deliberadamente **não terminado**, que não
 * gravou nada. Da família `1F 77` há escrita confirmada em papel, nos dois sentidos do modo.
 */
class ThermalWifiFrameTest {
    // --- paridade entre plataformas ------------------------------------------------------------

    @Test
    fun `todo quadro da familia 1F 77 sai byte a byte igual ao do iOS`() {
        ThermalWifiFrameParityVectors.US_W.forEach { vector ->
            assertArrayEquals(
                vector.name,
                vector.frame,
                ThermalWifiFrame.usW(vector.ssid, vector.security, vector.mode),
            )
        }
    }

    @Test
    fun `todo quadro so de wifi da familia 1F 1B 1F sai byte a byte igual ao do iOS`() {
        ThermalWifiFrameParityVectors.US_ESC_US_WIFI_ONLY.forEach { vector ->
            assertArrayEquals(
                vector.name,
                vector.frame,
                ThermalWifiFrame.usEscUsWifiOnly(vector.keyType, vector.ssid, vector.password),
            )
        }
    }

    @Test
    fun `todo quadro completo da familia 1F 1B 1F sai byte a byte igual ao do iOS`() {
        ThermalWifiFrameParityVectors.US_ESC_US_ALL.forEach { vector ->
            assertArrayEquals(
                vector.name,
                vector.frame,
                ThermalWifiFrame.usEscUsAll(
                    vector.ip,
                    vector.netmask,
                    vector.gateway,
                    vector.keyType,
                    vector.ssid,
                    vector.password,
                ),
            )
        }
    }

    @Test
    fun `os nomes dos enums sao os mesmos das duas plataformas`() {
        assertEquals(listOf("US_W", "US_ESC_US"), ThermalWifiProtocol.entries.map { it.name })
        assertEquals(
            listOf("OPEN", "SHARED", "WPA_PSK", "WPA2_PSK"),
            ThermalWifiAuth.entries.map { it.name },
        )
        assertEquals(listOf("NONE_TKIP", "WEP_AES"), ThermalWifiCipher.entries.map { it.name })
        assertEquals(listOf("ACCESS_POINT", "STATION"), ThermalWifiMode.entries.map { it.name })
        assertEquals(
            listOf(
                "OPEN", "WEP_64", "WEP_128", "WPA_AES_PSK", "WPA_TKIP_PSK", "WPA_TKIP_AES_PSK",
                "WPA2_AES_PSK", "WPA2_TKIP", "WPA2_TKIP_AES_PSK", "WPA_WPA2_MIXED_MODE",
            ),
            ThermalWifiKeyType.entries.map { it.name },
        )
        assertEquals(
            listOf("IP", "NETMASK", "GATEWAY"),
            ThermalWifiAddressField.entries.map { it.name },
        )
    }

    @Test
    fun `os bytes de cada vocabulario sao os mesmos das duas plataformas`() {
        assertEquals(listOf(0, 1, 2, 3), ThermalWifiAuth.entries.map { it.byte })
        assertEquals(listOf(0, 1), ThermalWifiCipher.entries.map { it.byte })
        // `1` é AP e `0` é cliente, na ordem em que os casos são declarados. O firmware compara com
        // 1 (`0xb35c`) e manda todo o resto para o ramo STA.
        assertEquals(listOf(1, 0), ThermalWifiMode.entries.map { it.byte })
        // Dez valores contíguos, e nenhum deles é `0xFF` — o `CB_ERR` truncado que o handler da
        // GoldenSky não valida.
        assertEquals(listOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), ThermalWifiKeyType.entries.map { it.byte })
        assertFalse(ThermalWifiKeyType.entries.map { it.byte }.contains(0xff))
        assertEquals(
            listOf(false, true, true, true, true, true, true, true, true, true),
            ThermalWifiKeyType.entries.map { it.requiresPassword },
        )
    }

    @Test
    fun `os sete ramos do par auth cipher sao os mesmos das duas plataformas`() {
        // A tabela dos sete ramos desmontada em `0xb140`–`0xb1dc`: é ela que decide qual string vai
        // no `AT+WSKEY=`, e o cupom da impressora imprime essa string de volta. Os pares abaixo são
        // o oráculo em forma de bytes.
        val ramos: List<Triple<ThermalWifiSecurity, Int, Int>> =
            listOf(
                Triple(ThermalWifiSecurity.Open, 0, 0),
                Triple(ThermalWifiSecurity.WepOpen("12345678"), 0, 1),
                Triple(ThermalWifiSecurity.WepShared("12345678"), 1, 0),
                Triple(ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.NONE_TKIP, "12345678"), 2, 0),
                Triple(ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.WEP_AES, "12345678"), 2, 1),
                Triple(ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.NONE_TKIP, "12345678"), 3, 0),
                Triple(ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "12345678"), 3, 1),
            )
        assertEquals(ramos.map { it.second }, ramos.map { it.first.auth.byte })
        assertEquals(ramos.map { it.third }, ramos.map { it.first.cipher.byte })
    }

    @Test
    fun `os limites publicados sao os mesmos das duas plataformas`() {
        assertEquals(1..32, ThermalWifiFrame.SSID_LENGTH_RANGE)
        assertEquals(8..63, ThermalWifiFrame.PASSWORD_LENGTH_RANGE)
        assertEquals(0x20, ThermalWifiFrame.PRINTABLE_ASCII_MIN)
        assertEquals(0x7e, ThermalWifiFrame.PRINTABLE_ASCII_MAX)
        assertArrayEquals(byteArrayOf(0x1f, 0x77), ThermalWifiProtocol.US_W.headerBytes)
        assertArrayEquals(byteArrayOf(0x1f, 0x1b, 0x1f), ThermalWifiProtocol.US_ESC_US.headerBytes)
        assertEquals(listOf("1F 77", "1F 1B 1F"), ThermalWifiProtocol.entries.map { it.label })
    }

    @Test
    fun `as frases de recusa sao as mesmas das duas plataformas`() {
        assertEquals(
            ThermalWifiFrameParityVectors.REJECTION_MESSAGES,
            ThermalWifiFrameParityVectors.REJECTIONS.map { it.message },
        )
    }

    // --- o quadro que saiu em papel --------------------------------------------------------------

    @Test
    fun `o quadro confirmado em papel sai byte a byte como o cupom mostrou`() {
        // 21/08/2026, PP-10W nº 2, mandado de um iPhone por TCP 9100. Saiu o cupom `Mode: STA` /
        // `SSID: Bematech` / `PWD: OPEN,NONE`, e no boot seguinte a unidade subiu em modo cliente.
        // É o único quadro desta frente que já gravou de verdade.
        assertArrayEquals(
            bytes(0x1f, 0x77, 0x08, 0x42, 0x65, 0x6d, 0x61, 0x74, 0x65, 0x63, 0x68, 0x00, 0x00, 0x00, 0x01),
            ThermalWifiFrame.usW("Bematech", ThermalWifiSecurity.Open, ThermalWifiMode.ACCESS_POINT),
        )
    }

    @Test
    fun `o quadro de bancada da GoldenSky agora sai terminado em vez de travar o parser`() {
        // 22/08/2026: `1F 1B 1F B3 06` + oito `Z`, **sem** os dois NUL, mandado do A07 para
        // `10.10.100.254:9100`. Saiu só o `A` que vinha antes — o parser engoliu o resto esperando
        // um terminador que nunca chegou, e nada foi gravado. Esta camada não sabe emitir aquele
        // quadro: o mesmo SSID e o mesmo `KT` saem daqui com prefixo idêntico e com os dois NUL no
        // lugar, que é toda a diferença entre exercitar o parser e travá-lo.
        val quadro =
            ThermalWifiFrame.usEscUsWifiOnly(
                ThermalWifiKeyType.WPA2_AES_PSK,
                "ZZZZZZZZ",
                "senha12345",
            )
        assertNotNull(quadro)
        val prefixo = ThermalWifiFrameParityVectors.GOLDENSKY_BENCH_PREFIX
        assertArrayEquals(prefixo, quadro!!.copyOfRange(0, prefixo.size))
        assertEquals(0x00.toByte(), quadro.last())
        assertEquals(0x00.toByte(), quadro[prefixo.size])
    }

    // --- rede aberta -----------------------------------------------------------------------------

    @Test
    fun `rede aberta colapsa os tres bytes do meio em vez de levar senha`() {
        // O ramo `AA=0`/`EE=0` retorna em `0xb1c2` e descarta a chave, então uma senha aqui seria
        // segredo no fio sem efeito nenhum. Na API isso é impossível de escrever: o caso `Open` não
        // tem onde guardar uma — não há teste possível para o que não compila, e é essa a diferença
        // entre um par solto de `AA`/`EE` e este tipo fechado.
        val quadro = ThermalWifiFrame.usW("Bematech", ThermalWifiSecurity.Open, ThermalWifiMode.STATION)!!
        assertEquals(15, quadro.size)
        assertArrayEquals(bytes(0x00, 0x00, 0x00), quadro.copyOfRange(11, 14))
        assertEquals(
            15,
            ThermalWifiFrame.validate("Bematech", ThermalWifiSecurity.Open).byteCount,
        )
    }

    @Test
    fun `rede aberta da GoldenSky recusa senha em vez de manda-la no fio`() {
        // Aqui não há colapso: o `B3` emite `<SENHA>00` sempre, então uma senha numa rede de
        // `KT=0` iria mesmo para o fio, em claro.
        assertEquals(
            ThermalWifiRejection.PasswordOnOpenNetwork,
            ThermalWifiFrame.validate(ThermalWifiKeyType.OPEN, "Printer", "senha12345").rejection,
        )
        assertNull(ThermalWifiFrame.usEscUsWifiOnly(ThermalWifiKeyType.OPEN, "Printer", "senha12345"))
        // Sem senha ela sai, e o campo vazio é só o seu NUL terminador.
        assertArrayEquals(
            bytes(0x1f, 0x1b, 0x1f, 0xb3, 0x00, 0x50, 0x72, 0x69, 0x6e, 0x74, 0x65, 0x72, 0x00, 0x00),
            ThermalWifiFrame.usEscUsWifiOnly(ThermalWifiKeyType.OPEN, "Printer", ""),
        )
    }

    @Test
    fun `os dois sentidos do modo saem com o byte que o firmware le`() {
        // O mapeamento já foi invertido uma vez num documento, a partir de um envio corrompido, e a
        // "correção" tirou uma impressora da rede. Os dois sentidos ficam presos por literal.
        val ap = ThermalWifiFrame.usW("Bematech", ThermalWifiSecurity.Open, ThermalWifiMode.ACCESS_POINT)!!
        val sta = ThermalWifiFrame.usW("Bematech", ThermalWifiSecurity.Open, ThermalWifiMode.STATION)!!
        assertEquals(0x01.toByte(), ap.last())
        assertEquals(0x00.toByte(), sta.last())
        assertArrayEquals(ap.copyOfRange(0, ap.size - 1), sta.copyOfRange(0, sta.size - 1))
    }

    // --- limites de cada campo, nas duas pontas ---------------------------------------------------

    @Test
    fun `o SSID aceita os extremos da faixa e recusa os vizinhos`() {
        val seguranca = ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "senha12345")
        assertNotNull(ThermalWifiFrame.usW("R", seguranca, ThermalWifiMode.STATION))
        assertNotNull(ThermalWifiFrame.usW("A".repeat(32), seguranca, ThermalWifiMode.STATION))
        assertEquals(
            ThermalWifiRejection.SsidEmpty,
            ThermalWifiFrame.validate("", seguranca).rejection,
        )
        assertEquals(
            ThermalWifiRejection.SsidTooLong(32),
            ThermalWifiFrame.validate("A".repeat(33), seguranca).rejection,
        )
        // O firmware aceitaria 33 (`1 ≤ L1 ≤ 33`, vaddr `0x83bc`); quem para em 32 é o padrão Wi-Fi,
        // e vale a interseção. O byte `LL` é o comprimento, então o teto aparece no quadro.
        val cheio =
            ThermalWifiFrame.usW(
                "A".repeat(32),
                ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "b".repeat(63)),
                ThermalWifiMode.STATION,
            )!!
        // `1F 77`, `LL`, 32 bytes de SSID, `AA`, `EE`, `KK`, 63 bytes de senha e `MM`.
        assertEquals(102, cheio.size)
        assertEquals(32.toByte(), cheio[2])
        assertEquals(63.toByte(), cheio[37])
    }

    @Test
    fun `a senha aceita os extremos da faixa e recusa os vizinhos`() {
        // A interseção medida: o emissor do fabricante recusa `< 8` ou `> 0x40` (VA `0x436561`) e o
        // firmware recusa `≥ 0x40` (vaddr `0x83f4`).
        listOf(8, 63).forEach { tamanho ->
            val senha = "a".repeat(tamanho)
            assertNotNull(
                "senha de $tamanho",
                ThermalWifiFrame.usW(
                    "Rede8",
                    ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, senha),
                    ThermalWifiMode.STATION,
                ),
            )
            assertNotNull(
                "senha de $tamanho",
                ThermalWifiFrame.usEscUsWifiOnly(ThermalWifiKeyType.WPA2_AES_PSK, "Rede8", senha),
            )
        }
        listOf(0, 7, 64).forEach { tamanho ->
            val senha = "a".repeat(tamanho)
            assertEquals(
                "senha de $tamanho",
                ThermalWifiRejection.PasswordLength(8, 63),
                ThermalWifiFrame.validate(
                    "Rede8",
                    ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, senha),
                ).rejection,
            )
            assertEquals(
                "senha de $tamanho",
                ThermalWifiRejection.PasswordLength(8, 63),
                ThermalWifiFrame.validate(ThermalWifiKeyType.WPA2_AES_PSK, "Rede8", senha).rejection,
            )
        }
        // O piso de 8 é do emissor, não do padrão: uma chave WEP-40 de cinco caracteres é recusada
        // aqui de propósito, porque nenhuma medição desta bancada conseguiu enviar uma.
        assertNull(
            ThermalWifiFrame.usW(
                "Rede8",
                ThermalWifiSecurity.WepOpen("12345"),
                ThermalWifiMode.STATION,
            ),
        )
    }

    @Test
    fun `acento e recusado em vez de ser transliterado`() {
        // A GoldenSky converte por `CP_THREAD_ACP`, que depende da locale de quem enviou; a Rongta
        // conta `strlen` em bytes. Transliterar mudaria o nome da rede em silêncio, e um SSID de
        // quatro letras com acento já ocupa cinco bytes.
        assertEquals(
            ThermalWifiRejection.SsidNotAscii,
            ThermalWifiFrame.validate("Café", ThermalWifiSecurity.Open).rejection,
        )
        assertEquals(
            ThermalWifiRejection.PasswordNotAscii,
            ThermalWifiFrame.validate(
                "Rede8",
                ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "senhaçã12"),
            ).rejection,
        )
        assertNull(
            ThermalWifiFrame.usEscUsWifiOnly(ThermalWifiKeyType.WPA2_AES_PSK, "Café", "senha12345"),
        )
    }

    @Test
    fun `NUL no meio do campo e recusado em vez de truncar o quadro`() {
        // Na família `1F 1B 1F` o NUL é o terminador: um zero no meio do SSID fecharia o campo cedo
        // e a senha viraria continuação de outro. Na Rongta o firmware aborta em `0x83d8` se o
        // primeiro byte do SSID for zero. Quem barra os dois é o piso de 0x20 do ASCII imprimível.
        assertEquals(
            ThermalWifiRejection.SsidNotAscii,
            ThermalWifiFrame.validate("Re\u0000de", ThermalWifiSecurity.Open).rejection,
        )
        assertEquals(
            ThermalWifiRejection.PasswordNotAscii,
            ThermalWifiFrame.validate(
                ThermalWifiKeyType.WPA2_AES_PSK,
                "Rede8",
                "senha\u0000123",
            ).rejection,
        )
        assertNull(
            ThermalWifiFrame.usW("\u0000Rede", ThermalWifiSecurity.Open, ThermalWifiMode.STATION),
        )
        // O espaço, ao contrário, é 0x20 e passa: nome de rede com espaço existe e é legítimo.
        assertNotNull(
            ThermalWifiFrame.usW("Re de", ThermalWifiSecurity.Open, ThermalWifiMode.STATION),
        )
    }

    @Test
    fun `os octetos do B4 recusam fora da faixa e dizem qual campo esta errado`() {
        // O `B4` reescreve IP, máscara e gateway **sempre**; não existe "não mexa neste campo". Na
        // ferramenta original o retorno de `UpdateData` é ignorado e octeto em branco virava zero em
        // silêncio — aqui vira recusa, e a recusa nomeia o campo para a pessoa consertar o certo.
        val ok = listOf(192, 168, 1, 50)
        assertEquals(
            ThermalWifiRejection.AddressOctets(ThermalWifiAddressField.IP),
            ThermalWifiFrame.validate(
                listOf(192, 168, 1, 256), ok, ok,
                ThermalWifiKeyType.WPA2_AES_PSK, "Rede8", "12345678",
            ).rejection,
        )
        assertEquals(
            ThermalWifiRejection.AddressOctets(ThermalWifiAddressField.NETMASK),
            ThermalWifiFrame.validate(
                ok, listOf(255, 255, 255), ok,
                ThermalWifiKeyType.WPA2_AES_PSK, "Rede8", "12345678",
            ).rejection,
        )
        assertEquals(
            ThermalWifiRejection.AddressOctets(ThermalWifiAddressField.GATEWAY),
            ThermalWifiFrame.validate(
                ok, ok, listOf(192, 168, 1, -1),
                ThermalWifiKeyType.WPA2_AES_PSK, "Rede8", "12345678",
            ).rejection,
        )
        assertNull(
            ThermalWifiFrame.usEscUsAll(
                listOf(192, 168, 1, 50, 7), ok, ok,
                ThermalWifiKeyType.WPA2_AES_PSK, "Rede8", "12345678",
            ),
        )
    }

    @Test
    fun `o B4 aceita os octetos extremos e os poe em ordem natural`() {
        // 0 e 255 são endereços que ninguém quer, mas a camada valida faixa de octeto, não sentido
        // de rede: quem decide se o endereço serve é quem está com a foto do autoteste na mão. O que
        // não pode acontecer é `256` chegar ao fio como `0` por truncamento — por isso os parâmetros
        // são `Int` e a validação vem antes da conversão.
        val quadro =
            ThermalWifiFrame.usEscUsAll(
                listOf(0, 0, 0, 0),
                listOf(255, 255, 255, 255),
                listOf(10, 0, 0, 1),
                ThermalWifiKeyType.WPA_WPA2_MIXED_MODE,
                "Rede8",
                "12345678",
            )!!
        // Ordem natural `a.b.c.d`, provada por dois caminhos independentes no binário do fabricante:
        // o `IPM_GETADDRESS` do DDX e o default `192.168.123.100` do próprio executável.
        assertArrayEquals(
            bytes(0, 0, 0, 0, 255, 255, 255, 255, 10, 0, 0, 1),
            quadro.copyOfRange(4, 16),
        )
    }

    // --- entrada inválida nunca vira byte ---------------------------------------------------------

    @Test
    fun `entrada recusada nao produz byte nenhum nas tres funcoes`() {
        // Na Rongta os campos variáveis são lidos com timeout `−1` (vaddr `0x83a6`): quadro
        // incompleto trava o parser até chegarem bytes que nunca virão. Meio quadro é pior que
        // quadro nenhum, então recusa devolve `null` e não um prefixo.
        assertNull(ThermalWifiFrame.usW("", ThermalWifiSecurity.Open, ThermalWifiMode.STATION))
        assertNull(
            ThermalWifiFrame.usW(
                "Rede8",
                ThermalWifiSecurity.WepShared("curta"),
                ThermalWifiMode.STATION,
            ),
        )
        assertNull(ThermalWifiFrame.usEscUsWifiOnly(ThermalWifiKeyType.WEP_64, "", "12345678"))
        assertNull(ThermalWifiFrame.usEscUsWifiOnly(ThermalWifiKeyType.WEP_64, "Rede8", "curta"))
        assertNull(
            ThermalWifiFrame.usEscUsAll(
                emptyList(), listOf(192, 168, 1, 1), listOf(192, 168, 1, 1),
                ThermalWifiKeyType.WEP_64, "Rede8", "12345678",
            ),
        )
        assertNull(
            ThermalWifiFrame.usEscUsAll(
                listOf(192, 168, 1, 50), listOf(192, 168, 1, 1), listOf(192, 168, 1, 1),
                ThermalWifiKeyType.WEP_64, "A".repeat(33), "12345678",
            ),
        )
    }

    @Test
    fun `o tamanho anunciado pelo validador e o tamanho que sai, quadro a quadro`() {
        // Se o validador anunciar um número e o construtor emitir outro, a tela de confirmação
        // mostra um quadro e a impressora recebe outro — e é justamente a contagem que a pessoa lê
        // antes de mandar.
        corpusDeQuadros().forEach { (nome, par) ->
            assertEquals(nome, par.first, par.second.size)
        }
    }

    // --- nenhum opcode proibido -------------------------------------------------------------------

    @Test
    fun `nenhum quadro emitido comeca por um opcode proibido`() {
        // A lista das duas famílias, junta: `1F 6D` grava MAC, `1F 69` põe IP fixo, `1F 62 44 00`
        // desliga DHCP, `1F 25` mexe em máscara/gateway, `1F 4E` não existe na tabela US, `03` é o
        // canal de atualização de firmware que apaga flash; do lado GoldenSky, `B8` troca o modo
        // USB, `BF` mexe nos DIP switches, `33` e `91` são de outro protocolo e outra porta.
        val proibidos =
            listOf(
                bytes(0x1f, 0x6d), bytes(0x1f, 0x69), bytes(0x1f, 0x62, 0x44, 0x00), bytes(0x1f, 0x25),
                bytes(0x1f, 0x4e), bytes(0x03),
                bytes(0x1f, 0x1b, 0x1f, 0xb8), bytes(0x1f, 0x1b, 0x1f, 0xbf),
                bytes(0x1f, 0x1b, 0x1f, 0x33), bytes(0x1f, 0x1b, 0x1f, 0x91),
            )
        corpusDeQuadros().forEach { (nome, par) ->
            proibidos.forEach { proibido ->
                assertFalse("$nome começou por opcode proibido", par.second.startsWith(proibido))
            }
        }
    }

    @Test
    fun `o cabecalho e o opcode sao constantes em todo quadro emitido`() {
        // É esta a garantia estrutural: os bytes de comando não vêm de parâmetro nenhum. Não há
        // `opcode`, `subcommand` nem `raw` na superfície, então nenhuma entrada — nem hostil —
        // alcança a posição de comando.
        corpusDeQuadros().forEach { (nome, par) ->
            val quadro = par.second
            if (quadro.startsWith(bytes(0x1f, 0x77))) return@forEach
            assertTrue(nome, quadro.startsWith(bytes(0x1f, 0x1b, 0x1f)))
            assertTrue(
                "$nome trocou o opcode da família",
                quadro[3] == 0xb3.toByte() || quadro[3] == 0xb4.toByte(),
            )
        }
    }

    @Test
    fun `o comprimento declarado bate com o campo que o segue em todo quadro 1F 77`() {
        // **Este é o teste do acidente de 21/08.** Lá o `LL` dizia 8 e o SSID digitado tinha 7: o
        // handler engoliu o byte seguinte como oitava letra, o quadro inteiro andou uma casa, o
        // `1F` do envio seguinte virou chave e o `77` virou byte de modo — e gravou assim mesmo. Um
        // byte a menos não vira erro, vira frame válido errado. Aqui o comprimento e o campo saem
        // da mesma contagem, e o teste confere os dois separadamente.
        ThermalWifiFrameParityVectors.US_W.forEach { vector ->
            val quadro = ThermalWifiFrame.usW(vector.ssid, vector.security, vector.mode)
            assertNotNull(vector.name, quadro)
            val ssidBytes = vector.ssid.toByteArray(Charsets.US_ASCII)
            assertEquals(vector.name, ssidBytes.size, quadro!![2].toInt() and 0xff)
            assertArrayEquals(vector.name, ssidBytes, quadro.copyOfRange(3, 3 + ssidBytes.size))
            // Nenhum byte de campo variável desce abaixo de 0x20, então nem SSID nem senha podem
            // ser lidos como comando se o quadro andar por qualquer motivo.
            assertTrue(vector.name, ssidBytes.all { (it.toInt() and 0xff) in 0x20..0x7e })

            val apos = 3 + ssidBytes.size
            val senha = senhaDe(vector.security)
            if (senha == null) {
                assertArrayEquals(vector.name, bytes(0, 0, 0), quadro.copyOfRange(apos, apos + 3))
                assertEquals(vector.name, apos + 4, quadro.size)
            } else {
                val senhaBytes = senha.toByteArray(Charsets.US_ASCII)
                assertEquals(vector.name, vector.security.auth.byte, quadro[apos].toInt() and 0xff)
                assertEquals(vector.name, vector.security.cipher.byte, quadro[apos + 1].toInt() and 0xff)
                assertEquals(vector.name, senhaBytes.size, quadro[apos + 2].toInt() and 0xff)
                assertArrayEquals(
                    vector.name,
                    senhaBytes,
                    quadro.copyOfRange(apos + 3, apos + 3 + senhaBytes.size),
                )
                assertEquals(vector.name, apos + 4 + senhaBytes.size, quadro.size)
                assertTrue(vector.name, senhaBytes.all { (it.toInt() and 0xff) in 0x20..0x7e })
            }
            assertEquals(vector.name, vector.mode.byte, quadro.last().toInt() and 0xff)
        }
    }

    @Test
    fun `o quadro da GoldenSky tem exatamente os dois terminadores e mais nenhum`() {
        // O `NUL` é o único separador desta família: um zero a mais fecharia um campo cedo e um a
        // menos deixaria o parser esperando, que foi o que travou a bancada em 22/08. Contados
        // **depois** do `KT`, porque antes dele o `B4` carrega octetos que podem valer zero.
        corpusDeQuadros().forEach { (nome, par) ->
            val quadro = par.second
            if (quadro.startsWith(bytes(0x1f, 0x77))) return@forEach
            val inicioDoTexto = if (quadro.startsWith(bytes(0x1f, 0x1b, 0x1f, 0xb4))) 17 else 5
            assertEquals(
                nome,
                2,
                quadro.copyOfRange(inicioDoTexto, quadro.size).count { it == 0.toByte() },
            )
            assertEquals(nome, 0.toByte(), quadro.last())
        }
    }

    // --- o segredo não vaza -----------------------------------------------------------------------

    @Test
    fun `a descricao da seguranca nao ecoa a senha`() {
        // AGENTS.md, Segurança: a chave nunca aparece em log, erro ou `toString()`. Sem a redação
        // na classe base, o `toString` sintetizado da `data class` imprimiria a senha inteira em
        // qualquer interpolação — é o mesmo motivo do `[REDACTED]` de `RawHexCommand`.
        val seguranca = ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "senha12345")
        listOf(
            seguranca.toString(),
            "$seguranca",
            listOf(seguranca).toString(),
        ).forEach { texto ->
            assertFalse(texto, texto.contains("senha12345"))
            assertTrue(texto, texto.contains("[REDACTED]"))
        }
    }

    @Test
    fun `nenhuma frase de recusa ecoa o valor recusado`() {
        val entradas = listOf("RedeSecretaDoBruno", "senha12345", "MinhaRede")
        ThermalWifiFrameParityVectors.REJECTIONS.forEach { rejection ->
            entradas.forEach { entrada ->
                assertFalse(rejection.message, rejection.message.contains(entrada))
            }
        }
    }

    // --- corpus de varredura ----------------------------------------------------------------------

    private fun senhaDe(security: ThermalWifiSecurity): String? =
        when (security) {
            ThermalWifiSecurity.Open -> null
            is ThermalWifiSecurity.WepOpen -> security.password
            is ThermalWifiSecurity.WepShared -> security.password
            is ThermalWifiSecurity.WpaPsk -> security.password
            is ThermalWifiSecurity.Wpa2Psk -> security.password
        }

    /**
     * Todo quadro que a camada consegue emitir a partir de entradas válidas, as hostis inclusive,
     * com o tamanho que o validador declarou para cada um.
     *
     * As entradas hostis existem para provar o que a estrutura promete: um SSID que é literalmente
     * o texto de um comando proibido continua sendo dado, porque nunca chega a uma posição de
     * comando.
     */
    private fun corpusDeQuadros(): List<Pair<String, Pair<Int, ByteArray>>> {
        val quadros = mutableListOf<Pair<String, Pair<Int, ByteArray>>>()

        fun registrar(
            nome: String,
            validacao: ThermalWifiValidation,
            quadro: ByteArray?,
        ) {
            val declarado = validacao.byteCount ?: return
            assertNotNull(nome, quadro)
            quadros += nome to (declarado to quadro!!)
        }

        ThermalWifiFrameParityVectors.US_W.forEach { vector ->
            registrar(
                vector.name,
                ThermalWifiFrame.validate(vector.ssid, vector.security),
                ThermalWifiFrame.usW(vector.ssid, vector.security, vector.mode),
            )
        }
        ThermalWifiFrameParityVectors.US_ESC_US_WIFI_ONLY.forEach { vector ->
            registrar(
                vector.name,
                ThermalWifiFrame.validate(vector.keyType, vector.ssid, vector.password),
                ThermalWifiFrame.usEscUsWifiOnly(vector.keyType, vector.ssid, vector.password),
            )
        }
        ThermalWifiFrameParityVectors.US_ESC_US_ALL.forEach { vector ->
            registrar(
                vector.name,
                ThermalWifiFrame.validate(
                    vector.ip, vector.netmask, vector.gateway,
                    vector.keyType, vector.ssid, vector.password,
                ),
                ThermalWifiFrame.usEscUsAll(
                    vector.ip, vector.netmask, vector.gateway,
                    vector.keyType, vector.ssid, vector.password,
                ),
            )
        }

        // Nomes de rede que imitam comando — as letras dos opcodes proibidos, e o caractere mais
        // alto e o mais baixo do ASCII aceito. Os endereços do `B4` valem 31 e 27 de propósito:
        // `1F 1B` é o começo do cabeçalho da GoldenSky, e como octeto é um endereço legítimo.
        val hostis = listOf("wm%iNb", "~ }|", "B8BFm33", " AA~")
        hostis.forEach { hostil ->
            ThermalWifiMode.entries.forEach { modo ->
                val seguranca = ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.NONE_TKIP, "m~iNb%DD")
                registrar(
                    "usW hostil $modo",
                    ThermalWifiFrame.validate(hostil, seguranca),
                    ThermalWifiFrame.usW(hostil, seguranca, modo),
                )
            }
            ThermalWifiKeyType.entries.forEach { keyType ->
                val senha = if (keyType.requiresPassword) "m~iNb%DD" else ""
                registrar(
                    "B3 hostil $keyType",
                    ThermalWifiFrame.validate(keyType, hostil, senha),
                    ThermalWifiFrame.usEscUsWifiOnly(keyType, hostil, senha),
                )
                registrar(
                    "B4 hostil $keyType",
                    ThermalWifiFrame.validate(
                        listOf(31, 27, 31, 179), listOf(255, 255, 255, 0), listOf(31, 27, 31, 1),
                        keyType, hostil, senha,
                    ),
                    ThermalWifiFrame.usEscUsAll(
                        listOf(31, 27, 31, 179), listOf(255, 255, 255, 0), listOf(31, 27, 31, 1),
                        keyType, hostil, senha,
                    ),
                )
            }
        }

        // O corpus só vale se ele de fato produziu quadros: uma entrada hostil recusada em silêncio
        // faria toda a varredura passar por vazio.
        assertTrue(
            "corpus pequeno demais: ${quadros.size}",
            quadros.size > hostis.size * ThermalWifiKeyType.entries.size,
        )
        return quadros
    }

    private fun ByteArray.startsWith(prefix: ByteArray): Boolean =
        size >= prefix.size && copyOfRange(0, prefix.size).contentEquals(prefix)

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
}

/**
 * Os vetores fixos da paridade Android–iOS.
 *
 * **Estes literais são idênticos aos de `ThermalWifiFrameTests.swift`.** Quem alterar um altera o
 * outro no mesmo commit, ou as duas suítes discordam — que é exatamente o que se quer que aconteça
 * quando as duas gramáticas divergirem.
 *
 * De onde cada bloco veio, e nenhum deles é a saída desta implementação:
 * - a família `1F 77` saiu de `docs/quadro-wifi.py`, o gerador de referência escrito antes desta
 *   camada a partir do desmonte do emissor do fabricante. O ramo `OPEN,WEP-A,` (`AA=0`/`EE≠0`) é o
 *   único que o gerador **não** cobre — ele colapsa todo `OPEN` em `00 00 00` —, então esse vetor
 *   foi montado direto da gramática e da tabela dos sete ramos;
 * - a família `1F 1B 1F` saiu dos exemplos já em hexadecimal de
 *   `docs/goldensky-configuracao-wifi.md`, o `B3` de 26 bytes e o `B4` de 38.
 */
internal object ThermalWifiFrameParityVectors {
    internal class UsWVector(
        val name: String,
        val ssid: String,
        val security: ThermalWifiSecurity,
        val mode: ThermalWifiMode,
        frame: List<Int>,
    ) {
        val frame: ByteArray = ByteArray(frame.size) { frame[it].toByte() }
    }

    val US_W =
        listOf(
            // O quadro de 15 bytes que gravou de verdade em 21/08/2026, com o cupom `Mode: STA`
            // como oráculo. É também a prova do próprio gerador de referência, que o reproduz.
            UsWVector(
                "Bematech aberta AP", "Bematech", ThermalWifiSecurity.Open, ThermalWifiMode.ACCESS_POINT,
                listOf(0x1f, 0x77, 0x08, 0x42, 0x65, 0x6d, 0x61, 0x74, 0x65, 0x63, 0x68, 0x00, 0x00, 0x00, 0x01),
            ),
            UsWVector(
                "Bematech aberta STA", "Bematech", ThermalWifiSecurity.Open, ThermalWifiMode.STATION,
                listOf(0x1f, 0x77, 0x08, 0x42, 0x65, 0x6d, 0x61, 0x74, 0x65, 0x63, 0x68, 0x00, 0x00, 0x00, 0x00),
            ),
            UsWVector(
                "MinhaRede WPA2-PSK AES STA", "MinhaRede",
                ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "senha12345"),
                ThermalWifiMode.STATION,
                listOf(
                    0x1f, 0x77, 0x09, 0x4d, 0x69, 0x6e, 0x68, 0x61, 0x52, 0x65, 0x64, 0x65, 0x03, 0x01,
                    0x0a, 0x73, 0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00,
                ),
            ),
            UsWVector(
                "MinhaRede WPA-PSK TKIP AP", "MinhaRede",
                ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.NONE_TKIP, "senha12345"),
                ThermalWifiMode.ACCESS_POINT,
                listOf(
                    0x1f, 0x77, 0x09, 0x4d, 0x69, 0x6e, 0x68, 0x61, 0x52, 0x65, 0x64, 0x65, 0x02, 0x00,
                    0x0a, 0x73, 0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x01,
                ),
            ),
            UsWVector(
                "Rede8 WPA2-PSK TKIP STA", "Rede8",
                ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.NONE_TKIP, "12345678"),
                ThermalWifiMode.STATION,
                listOf(
                    0x1f, 0x77, 0x05, 0x52, 0x65, 0x64, 0x65, 0x38, 0x03, 0x00, 0x08, 0x31, 0x32, 0x33,
                    0x34, 0x35, 0x36, 0x37, 0x38, 0x00,
                ),
            ),
            UsWVector(
                "Rede8 WPA-PSK AES STA", "Rede8",
                ThermalWifiSecurity.WpaPsk(ThermalWifiCipher.WEP_AES, "12345678"),
                ThermalWifiMode.STATION,
                listOf(
                    0x1f, 0x77, 0x05, 0x52, 0x65, 0x64, 0x65, 0x38, 0x02, 0x01, 0x08, 0x31, 0x32, 0x33,
                    0x34, 0x35, 0x36, 0x37, 0x38, 0x00,
                ),
            ),
            // `SHARED,WEP-A,`: o firmware ignora o `EE` neste ramo, e o quadro sai com `0` fixo.
            UsWVector(
                "Rede8 SHARED STA", "Rede8", ThermalWifiSecurity.WepShared("12345678"),
                ThermalWifiMode.STATION,
                listOf(
                    0x1f, 0x77, 0x05, 0x52, 0x65, 0x64, 0x65, 0x38, 0x01, 0x00, 0x08, 0x31, 0x32, 0x33,
                    0x34, 0x35, 0x36, 0x37, 0x38, 0x00,
                ),
            ),
            // `OPEN,WEP-A,`: o ramo `AA=0`/`EE≠0`, que o gerador de referência não cobre.
            UsWVector(
                "Rede8 OPEN WEP-A STA", "Rede8", ThermalWifiSecurity.WepOpen("12345678"),
                ThermalWifiMode.STATION,
                listOf(
                    0x1f, 0x77, 0x05, 0x52, 0x65, 0x64, 0x65, 0x38, 0x00, 0x01, 0x08, 0x31, 0x32, 0x33,
                    0x34, 0x35, 0x36, 0x37, 0x38, 0x00,
                ),
            ),
            // Os pisos das duas faixas: SSID de 1 byte e senha de 8.
            UsWVector(
                "piso das faixas, AP", "R",
                ThermalWifiSecurity.Wpa2Psk(ThermalWifiCipher.WEP_AES, "aaaaaaaa"),
                ThermalWifiMode.ACCESS_POINT,
                listOf(
                    0x1f, 0x77, 0x01, 0x52, 0x03, 0x01, 0x08, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61,
                    0x61, 0x01,
                ),
            ),
        )

    internal class UsEscUsWifiOnlyVector(
        val name: String,
        val keyType: ThermalWifiKeyType,
        val ssid: String,
        val password: String,
        frame: List<Int>,
    ) {
        val frame: ByteArray = ByteArray(frame.size) { frame[it].toByte() }
    }

    val US_ESC_US_WIFI_ONLY =
        listOf(
            // O exemplo trabalhado do documento, 26 bytes.
            UsEscUsWifiOnlyVector(
                "B3 MinhaRede WPA2 AES", ThermalWifiKeyType.WPA2_AES_PSK, "MinhaRede", "senha12345",
                listOf(
                    0x1f, 0x1b, 0x1f, 0xb3, 0x06, 0x4d, 0x69, 0x6e, 0x68, 0x61, 0x52, 0x65, 0x64, 0x65,
                    0x00, 0x73, 0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00,
                ),
            ),
            // Rede aberta: `KT=0` e o campo de senha reduzido ao seu terminador.
            UsEscUsWifiOnlyVector(
                "B3 Printer aberta", ThermalWifiKeyType.OPEN, "Printer", "",
                listOf(0x1f, 0x1b, 0x1f, 0xb3, 0x00, 0x50, 0x72, 0x69, 0x6e, 0x74, 0x65, 0x72, 0x00, 0x00),
            ),
            // O SSID do quadro de bancada de 22/08, agora com os dois NUL que faltavam lá.
            UsEscUsWifiOnlyVector(
                "B3 do degrau 2, terminado", ThermalWifiKeyType.WPA2_AES_PSK, "ZZZZZZZZ", "senha12345",
                listOf(
                    0x1f, 0x1b, 0x1f, 0xb3, 0x06, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x00,
                    0x73, 0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00,
                ),
            ),
        )

    internal class UsEscUsAllVector(
        val name: String,
        val ip: List<Int>,
        val netmask: List<Int>,
        val gateway: List<Int>,
        val keyType: ThermalWifiKeyType,
        val ssid: String,
        val password: String,
        frame: List<Int>,
    ) {
        val frame: ByteArray = ByteArray(frame.size) { frame[it].toByte() }
    }

    val US_ESC_US_ALL =
        listOf(
            // O exemplo trabalhado do documento, 38 bytes, com os octetos em ordem natural `a.b.c.d`.
            UsEscUsAllVector(
                "B4 192.168.1.50 WPA2 AES",
                listOf(192, 168, 1, 50), listOf(255, 255, 255, 0), listOf(192, 168, 1, 1),
                ThermalWifiKeyType.WPA2_AES_PSK, "MinhaRede", "senha12345",
                listOf(
                    0x1f, 0x1b, 0x1f, 0xb4, 0xc0, 0xa8, 0x01, 0x32, 0xff, 0xff, 0xff, 0x00, 0xc0, 0xa8,
                    0x01, 0x01, 0x06, 0x4d, 0x69, 0x6e, 0x68, 0x61, 0x52, 0x65, 0x64, 0x65, 0x00, 0x73,
                    0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00,
                ),
            ),
            // Os dois extremos do octeto, 0 e 255, e o topo da faixa de `KT`.
            UsEscUsAllVector(
                "B4 octetos extremos",
                listOf(0, 0, 0, 0), listOf(255, 255, 255, 255), listOf(10, 0, 0, 1),
                ThermalWifiKeyType.WPA_WPA2_MIXED_MODE, "Rede8", "12345678",
                listOf(
                    0x1f, 0x1b, 0x1f, 0xb4, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x0a, 0x00,
                    0x00, 0x01, 0x09, 0x52, 0x65, 0x64, 0x65, 0x38, 0x00, 0x31, 0x32, 0x33, 0x34, 0x35,
                    0x36, 0x37, 0x38, 0x00,
                ),
            ),
        )

    /** O prefixo exato do quadro que a bancada mandou em 22/08/2026 — e que nunca fechou. */
    val GOLDENSKY_BENCH_PREFIX: ByteArray =
        bytes(0x1f, 0x1b, 0x1f, 0xb3, 0x06, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a)

    /** Toda recusa que a camada sabe produzir, na ordem em que as frases são fixadas abaixo. */
    val REJECTIONS: List<ThermalWifiRejection> =
        listOf(
            ThermalWifiRejection.SsidEmpty,
            ThermalWifiRejection.SsidTooLong(32),
            ThermalWifiRejection.SsidNotAscii,
            ThermalWifiRejection.PasswordLength(8, 63),
            ThermalWifiRejection.PasswordNotAscii,
            ThermalWifiRejection.PasswordOnOpenNetwork,
            ThermalWifiRejection.AddressOctets(ThermalWifiAddressField.IP),
            ThermalWifiRejection.AddressOctets(ThermalWifiAddressField.NETMASK),
            ThermalWifiRejection.AddressOctets(ThermalWifiAddressField.GATEWAY),
        )

    /** Paridade inclui texto de erro: a frase que sai no Android é a mesma que sai no iOS. */
    val REJECTION_MESSAGES =
        listOf(
            "Informe o nome da rede.",
            "O nome da rede aceita no máximo 32 caracteres.",
            "O nome da rede aceita apenas letras e números sem acento.",
            "A senha da rede precisa de 8 a 63 caracteres.",
            "A senha da rede aceita apenas letras e números sem acento.",
            "Rede aberta não leva senha.",
            "O endereço IP precisa de quatro números de 0 a 255.",
            "A máscara precisa de quatro números de 0 a 255.",
            "O gateway precisa de quatro números de 0 a 255.",
        )

    private fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }
}
