import XCTest
@testable import ThermalPrinterKit

/**
 Os dois quadros de configuração Wi-Fi, campo a campo e byte a byte.

 **O bloco de paridade é o que mais importa aqui.** Os vetores de `ThermalWifiFrameParityVectors`
 são literais idênticos, caractere a caractere, aos de
 `android/src/test/java/br/com/thermalprinterkit/ThermalWifiFrameTest.kt`. Não são a saída da
 implementação gravada de volta: os da família `1F 77` saíram do gerador de referência
 `docs/quadro-wifi.py`, escrito antes desta camada e a partir do desmonte do emissor do fabricante —
 e o gerador se prova sozinho, porque reproduz exatamente o quadro de 15 bytes que saiu em papel em
 21/08/2026. Os da família `1F 1B 1F` saíram dos exemplos trabalhados de
 `docs/goldensky-configuracao-wifi.md`, que traz os dois quadros já em hexadecimal.

 O que estes testes **não** provam, e a assimetria é real: que a GoldenSky grava. Da família
 `1F 1B 1F` a bancada só provou, em 22/08/2026, que o cabeçalho de quatro bytes é honrado na TCP
 9100 e que o layout do `B3` está certo — com um quadro deliberadamente **não terminado**, que não
 gravou nada. Da família `1F 77` há escrita confirmada em papel, nos dois sentidos do modo.
 */
final class ThermalWifiFrameTests: XCTestCase {
    // MARK: - paridade entre plataformas

    func testTodoQuadroDaFamiliaUsWSaiByteAByteIgualAoDoAndroid() {
        for vector in ThermalWifiFrameParityVectors.usW {
            XCTAssertEqual(
                ThermalWifiFrame.usW(ssid: vector.ssid, security: vector.security, mode: vector.mode),
                Data(vector.frame),
                vector.name
            )
        }
    }

    func testTodoQuadroSoDeWifiDaFamiliaUsEscUsSaiByteAByteIgualAoDoAndroid() {
        for vector in ThermalWifiFrameParityVectors.usEscUsWifiOnly {
            XCTAssertEqual(
                ThermalWifiFrame.usEscUsWifiOnly(
                    keyType: vector.keyType,
                    ssid: vector.ssid,
                    password: vector.password
                ),
                Data(vector.frame),
                vector.name
            )
        }
    }

    func testTodoQuadroCompletoDaFamiliaUsEscUsSaiByteAByteIgualAoDoAndroid() {
        for vector in ThermalWifiFrameParityVectors.usEscUsAll {
            XCTAssertEqual(
                ThermalWifiFrame.usEscUsAll(
                    ip: vector.ip,
                    netmask: vector.netmask,
                    gateway: vector.gateway,
                    keyType: vector.keyType,
                    ssid: vector.ssid,
                    password: vector.password
                ),
                Data(vector.frame),
                vector.name
            )
        }
    }

    func testOsRawValueDosEnumsSaoOsMesmosDasDuasPlataformas() {
        XCTAssertEqual(ThermalWifiProtocol.allCases.map(\.rawValue), ["US_W", "US_ESC_US"])
        XCTAssertEqual(ThermalWifiAuth.allCases.map(\.rawValue), ["OPEN", "SHARED", "WPA_PSK", "WPA2_PSK"])
        XCTAssertEqual(ThermalWifiCipher.allCases.map(\.rawValue), ["NONE_TKIP", "WEP_AES"])
        XCTAssertEqual(ThermalWifiMode.allCases.map(\.rawValue), ["ACCESS_POINT", "STATION"])
        XCTAssertEqual(
            ThermalWifiKeyType.allCases.map(\.rawValue),
            [
                "OPEN", "WEP_64", "WEP_128", "WPA_AES_PSK", "WPA_TKIP_PSK", "WPA_TKIP_AES_PSK",
                "WPA2_AES_PSK", "WPA2_TKIP", "WPA2_TKIP_AES_PSK", "WPA_WPA2_MIXED_MODE",
            ]
        )
        XCTAssertEqual(ThermalWifiAddressField.allCases.map(\.rawValue), ["IP", "NETMASK", "GATEWAY"])
    }

    func testOsBytesDeCadaVocabularioSaoOsMesmosDasDuasPlataformas() {
        XCTAssertEqual(ThermalWifiAuth.allCases.map(\.byte), [0, 1, 2, 3])
        XCTAssertEqual(ThermalWifiCipher.allCases.map(\.byte), [0, 1])
        // `1` é AP e `0` é cliente, na ordem em que os casos são declarados. O firmware compara com
        // 1 (`0xb35c`) e manda todo o resto para o ramo STA.
        XCTAssertEqual(ThermalWifiMode.allCases.map(\.byte), [1, 0])
        // Dez valores contíguos, e nenhum deles é `0xFF` — o `CB_ERR` truncado que o handler da
        // GoldenSky não valida.
        XCTAssertEqual(ThermalWifiKeyType.allCases.map(\.byte), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        XCTAssertFalse(ThermalWifiKeyType.allCases.map(\.byte).contains(0xff))
        XCTAssertEqual(
            ThermalWifiKeyType.allCases.map(\.requiresPassword),
            [false, true, true, true, true, true, true, true, true, true]
        )
    }

    func testOsSeteRamosDoParAuthCipherSaoOsMesmosDasDuasPlataformas() {
        // A tabela dos sete ramos desmontada em `0xb140`–`0xb1dc`: é ela que decide qual string vai
        // no `AT+WSKEY=`, e o cupom da impressora imprime essa string de volta. Os pares abaixo são
        // o oráculo em forma de bytes.
        let ramos: [(ThermalWifiSecurity, UInt8, UInt8)] = [
            (.open, 0, 0),
            (.wepOpen(password: "12345678"), 0, 1),
            (.wepShared(password: "12345678"), 1, 0),
            (.wpaPSK(cipher: .noneTKIP, password: "12345678"), 2, 0),
            (.wpaPSK(cipher: .wepAES, password: "12345678"), 2, 1),
            (.wpa2PSK(cipher: .noneTKIP, password: "12345678"), 3, 0),
            (.wpa2PSK(cipher: .wepAES, password: "12345678"), 3, 1),
        ]
        XCTAssertEqual(ramos.map { $0.0.auth.byte }, ramos.map(\.1))
        XCTAssertEqual(ramos.map { $0.0.cipher.byte }, ramos.map(\.2))
    }

    func testOsLimitesPublicadosSaoOsMesmosDasDuasPlataformas() {
        XCTAssertEqual(ThermalWifiFrame.ssidLengthRange, 1...32)
        XCTAssertEqual(ThermalWifiFrame.passwordLengthRange, 8...63)
        XCTAssertEqual(ThermalWifiFrame.printableASCIIMin, 0x20)
        XCTAssertEqual(ThermalWifiFrame.printableASCIIMax, 0x7e)
        XCTAssertEqual(ThermalWifiProtocol.usW.headerBytes, Data([0x1f, 0x77]))
        XCTAssertEqual(ThermalWifiProtocol.usEscUs.headerBytes, Data([0x1f, 0x1b, 0x1f]))
        XCTAssertEqual(ThermalWifiProtocol.allCases.map(\.label), ["1F 77", "1F 1B 1F"])
    }

    func testAsFrasesDeRecusaSaoAsMesmasDasDuasPlataformas() {
        XCTAssertEqual(
            ThermalWifiFrameParityVectors.rejections.map(\.message),
            ThermalWifiFrameParityVectors.rejectionMessages
        )
    }

    // MARK: - o quadro que saiu em papel

    func testOQuadroConfirmadoEmPapelSaiByteAByteComoOCupomMostrou() {
        // 21/08/2026, PP-10W nº 2, mandado de um iPhone por TCP 9100. Saiu o cupom `Mode: STA` /
        // `SSID: Bematech` / `PWD: OPEN,NONE`, e no boot seguinte a unidade subiu em modo cliente.
        // É o único quadro desta frente que já gravou de verdade.
        XCTAssertEqual(
            ThermalWifiFrame.usW(ssid: "Bematech", security: .open, mode: .accessPoint),
            Data([0x1f, 0x77, 0x08, 0x42, 0x65, 0x6d, 0x61, 0x74, 0x65, 0x63, 0x68, 0x00, 0x00, 0x00, 0x01])
        )
    }

    func testOQuadroDeBancadaDaGoldenSkyAgoraSaiTerminadoEmVezDeTravarOParser() throws {
        // 22/08/2026: `1F 1B 1F B3 06` + oito `Z`, **sem** os dois NUL, mandado do A07 para
        // `10.10.100.254:9100`. Saiu só o `A` que vinha antes — o parser engoliu o resto esperando
        // um terminador que nunca chegou, e nada foi gravado. Esta camada não sabe emitir aquele
        // quadro: o mesmo SSID e o mesmo `KT` saem daqui com prefixo idêntico e com os dois NUL no
        // lugar, que é toda a diferença entre exercitar o parser e travá-lo.
        let quadro = try XCTUnwrap(
            ThermalWifiFrame.usEscUsWifiOnly(keyType: .wpa2AESPSK, ssid: "ZZZZZZZZ", password: "senha12345")
        )
        XCTAssertTrue(quadro.starts(with: ThermalWifiFrameParityVectors.bancadaGoldenSkyPrefixo))
        XCTAssertEqual(quadro.last, 0x00)
        XCTAssertEqual(quadro[ThermalWifiFrameParityVectors.bancadaGoldenSkyPrefixo.count], 0x00)
    }

    // MARK: - rede aberta

    func testRedeAbertaColapsaOsTresBytesDoMeioEmVezDeLevarSenha() throws {
        // O ramo `AA=0`/`EE=0` retorna em `0xb1c2` e descarta a chave, então uma senha aqui seria
        // segredo no fio sem efeito nenhum. Na API isso é impossível de escrever: o caso `.open`
        // não tem onde guardar uma — não há teste possível para o que não compila, e é essa a
        // diferença entre um par solto de `AA`/`EE` e este enum.
        let quadro = try XCTUnwrap(ThermalWifiFrame.usW(ssid: "Bematech", security: .open, mode: .station))
        XCTAssertEqual(quadro.count, 15)
        XCTAssertEqual(Array(quadro[11...13]), [0x00, 0x00, 0x00])
        XCTAssertEqual(ThermalWifiFrame.validate(ssid: "Bematech", security: .open).byteCount, 15)
    }

    func testRedeAbertaDaGoldenSkyRecusaSenhaEmVezDeMandaLaNoFio() {
        // Aqui não há colapso: o `B3` emite `<SENHA>00` sempre, então uma senha numa rede de
        // `KT=0` iria mesmo para o fio, em claro.
        XCTAssertEqual(
            ThermalWifiFrame.validate(keyType: .open, ssid: "Printer", password: "senha12345").rejection,
            .passwordOnOpenNetwork
        )
        XCTAssertNil(ThermalWifiFrame.usEscUsWifiOnly(keyType: .open, ssid: "Printer", password: "senha12345"))
        // Sem senha ela sai, e o campo vazio é só o seu NUL terminador.
        XCTAssertEqual(
            ThermalWifiFrame.usEscUsWifiOnly(keyType: .open, ssid: "Printer", password: ""),
            Data([0x1f, 0x1b, 0x1f, 0xb3, 0x00, 0x50, 0x72, 0x69, 0x6e, 0x74, 0x65, 0x72, 0x00, 0x00])
        )
    }

    func testOsDoisSentidosDoModoSaemComOByteQueOFirmwareLe() throws {
        // O mapeamento já foi invertido uma vez num documento, a partir de um envio corrompido, e a
        // "correção" tirou uma impressora da rede. Os dois sentidos ficam presos por literal.
        let ap = try XCTUnwrap(ThermalWifiFrame.usW(ssid: "Bematech", security: .open, mode: .accessPoint))
        let sta = try XCTUnwrap(ThermalWifiFrame.usW(ssid: "Bematech", security: .open, mode: .station))
        XCTAssertEqual(ap.last, 0x01)
        XCTAssertEqual(sta.last, 0x00)
        XCTAssertEqual(ap.dropLast(), sta.dropLast())
    }

    // MARK: - limites de cada campo, nas duas pontas

    func testOSsidAceitaOsExtremosDaFaixaERecusaOsVizinhos() {
        let seguranca = ThermalWifiSecurity.wpa2PSK(cipher: .wepAES, password: "senha12345")
        XCTAssertNotNil(ThermalWifiFrame.usW(ssid: "R", security: seguranca, mode: .station))
        XCTAssertNotNil(ThermalWifiFrame.usW(ssid: String(repeating: "A", count: 32), security: seguranca, mode: .station))
        XCTAssertEqual(ThermalWifiFrame.validate(ssid: "", security: seguranca).rejection, .ssidEmpty)
        XCTAssertEqual(
            ThermalWifiFrame.validate(ssid: String(repeating: "A", count: 33), security: seguranca).rejection,
            .ssidTooLong(max: 32)
        )
        // O firmware aceitaria 33 (`1 ≤ L1 ≤ 33`, vaddr `0x83bc`); quem para em 32 é o padrão Wi-Fi,
        // e vale a interseção. O byte `LL` é o comprimento, então o teto aparece no quadro.
        let cheio = ThermalWifiFrame.usW(
            ssid: String(repeating: "A", count: 32),
            security: .wpa2PSK(cipher: .wepAES, password: String(repeating: "b", count: 63)),
            mode: .station
        )
        // `1F 77`, `LL`, 32 bytes de SSID, `AA`, `EE`, `KK`, 63 bytes de senha e `MM`.
        XCTAssertEqual(cheio?.count, 102)
        XCTAssertEqual(cheio?[2], 32)
        XCTAssertEqual(cheio?[37], 63)
    }

    func testASenhaAceitaOsExtremosDaFaixaERecusaOsVizinhos() {
        // A interseção medida: o emissor do fabricante recusa `< 8` ou `> 0x40` (VA `0x436561`) e o
        // firmware recusa `≥ 0x40` (vaddr `0x83f4`).
        for tamanho in [8, 63] {
            let senha = String(repeating: "a", count: tamanho)
            XCTAssertNotNil(
                ThermalWifiFrame.usW(ssid: "Rede8", security: .wpa2PSK(cipher: .wepAES, password: senha), mode: .station),
                "senha de \(tamanho)"
            )
            XCTAssertNotNil(
                ThermalWifiFrame.usEscUsWifiOnly(keyType: .wpa2AESPSK, ssid: "Rede8", password: senha),
                "senha de \(tamanho)"
            )
        }
        for tamanho in [0, 7, 64] {
            let senha = String(repeating: "a", count: tamanho)
            XCTAssertEqual(
                ThermalWifiFrame.validate(ssid: "Rede8", security: .wpa2PSK(cipher: .wepAES, password: senha)).rejection,
                .passwordLength(min: 8, max: 63),
                "senha de \(tamanho)"
            )
            XCTAssertEqual(
                ThermalWifiFrame.validate(keyType: .wpa2AESPSK, ssid: "Rede8", password: senha).rejection,
                .passwordLength(min: 8, max: 63),
                "senha de \(tamanho)"
            )
        }
        // O piso de 8 é do emissor, não do padrão: uma chave WEP-40 de cinco caracteres é recusada
        // aqui de propósito, porque nenhuma medição desta bancada conseguiu enviar uma.
        XCTAssertNil(ThermalWifiFrame.usW(ssid: "Rede8", security: .wepOpen(password: "12345"), mode: .station))
    }

    func testAcentoERecusadoEmVezDeSerTransliterado() {
        // A GoldenSky converte por `CP_THREAD_ACP`, que depende da locale de quem enviou; a Rongta
        // conta `strlen` em bytes. Transliterar mudaria o nome da rede em silêncio, e um SSID de
        // quatro letras com acento já ocupa cinco bytes.
        XCTAssertEqual(
            ThermalWifiFrame.validate(ssid: "Café", security: .open).rejection,
            .ssidNotASCII
        )
        XCTAssertEqual(
            ThermalWifiFrame.validate(
                ssid: "Rede8",
                security: .wpa2PSK(cipher: .wepAES, password: "senhaçã12")
            ).rejection,
            .passwordNotASCII
        )
        XCTAssertNil(ThermalWifiFrame.usEscUsWifiOnly(keyType: .wpa2AESPSK, ssid: "Café", password: "senha12345"))
    }

    func testNulNoMeioDoCampoERecusadoEmVezDeTruncarOQuadro() {
        // Na família `1F 1B 1F` o NUL é o terminador: um zero no meio do SSID fecharia o campo cedo
        // e a senha viraria continuação de outro. Na Rongta o firmware aborta em `0x83d8` se o
        // primeiro byte do SSID for zero. Quem barra os dois é o piso de 0x20 do ASCII imprimível.
        XCTAssertEqual(ThermalWifiFrame.validate(ssid: "Re\u{0}de", security: .open).rejection, .ssidNotASCII)
        XCTAssertEqual(
            ThermalWifiFrame.validate(keyType: .wpa2AESPSK, ssid: "Rede8", password: "senha\u{0}123").rejection,
            .passwordNotASCII
        )
        XCTAssertNil(ThermalWifiFrame.usW(ssid: "\u{0}Rede", security: .open, mode: .station))
    }

    func testOsOctetosDoB4RecusamForaDaFaixaEDizemQualCampoEstaErrado() {
        // O `B4` reescreve IP, máscara e gateway **sempre**; não existe "não mexa neste campo". Na
        // ferramenta original o retorno de `UpdateData` é ignorado e octeto em branco virava zero em
        // silêncio — aqui vira recusa, e a recusa nomeia o campo para a pessoa consertar o certo.
        let ok = [192, 168, 1, 50]
        XCTAssertEqual(
            ThermalWifiFrame.validate(
                ip: [192, 168, 1, 256], netmask: ok, gateway: ok,
                keyType: .wpa2AESPSK, ssid: "Rede8", password: "12345678"
            ).rejection,
            .addressOctets(field: .ip)
        )
        XCTAssertEqual(
            ThermalWifiFrame.validate(
                ip: ok, netmask: [255, 255, 255], gateway: ok,
                keyType: .wpa2AESPSK, ssid: "Rede8", password: "12345678"
            ).rejection,
            .addressOctets(field: .netmask)
        )
        XCTAssertEqual(
            ThermalWifiFrame.validate(
                ip: ok, netmask: ok, gateway: [192, 168, 1, -1],
                keyType: .wpa2AESPSK, ssid: "Rede8", password: "12345678"
            ).rejection,
            .addressOctets(field: .gateway)
        )
        XCTAssertNil(
            ThermalWifiFrame.usEscUsAll(
                ip: [192, 168, 1, 50, 7], netmask: ok, gateway: ok,
                keyType: .wpa2AESPSK, ssid: "Rede8", password: "12345678"
            )
        )
    }

    func testOB4AceitaOsOctetosExtremosEOsPoeEmOrdemNatural() throws {
        // 0 e 255 são endereços que ninguém quer, mas a camada valida faixa de octeto, não sentido
        // de rede: quem decide se o endereço serve é quem está com a foto do autoteste na mão. O que
        // não pode acontecer é `256` chegar ao fio como `0` por truncamento — por isso os parâmetros
        // são `Int` e a validação vem antes da conversão.
        let quadro = try XCTUnwrap(
            ThermalWifiFrame.usEscUsAll(
                ip: [0, 0, 0, 0], netmask: [255, 255, 255, 255], gateway: [10, 0, 0, 1],
                keyType: .wpaWPA2MixedMode, ssid: "Rede8", password: "12345678"
            )
        )
        // Ordem natural `a.b.c.d`, provada por dois caminhos independentes no binário do fabricante:
        // o `IPM_GETADDRESS` do DDX e o default `192.168.123.100` do próprio executável.
        XCTAssertEqual(Array(quadro[4..<16]), [0, 0, 0, 0, 255, 255, 255, 255, 10, 0, 0, 1])
    }

    // MARK: - entrada inválida nunca vira byte

    func testEntradaRecusadaNaoProduzByteNenhumNasTresFuncoes() {
        // Na Rongta os campos variáveis são lidos com timeout `−1` (vaddr `0x83a6`): quadro
        // incompleto trava o parser até chegarem bytes que nunca virão. Meio quadro é pior que
        // quadro nenhum, então recusa devolve `nil` e não um prefixo.
        XCTAssertNil(ThermalWifiFrame.usW(ssid: "", security: .open, mode: .station))
        XCTAssertNil(ThermalWifiFrame.usW(ssid: "Rede8", security: .wepShared(password: "curta"), mode: .station))
        XCTAssertNil(ThermalWifiFrame.usEscUsWifiOnly(keyType: .wep64, ssid: "", password: "12345678"))
        XCTAssertNil(ThermalWifiFrame.usEscUsWifiOnly(keyType: .wep64, ssid: "Rede8", password: "curta"))
        XCTAssertNil(
            ThermalWifiFrame.usEscUsAll(
                ip: [], netmask: [192, 168, 1, 1], gateway: [192, 168, 1, 1],
                keyType: .wep64, ssid: "Rede8", password: "12345678"
            )
        )
        XCTAssertNil(
            ThermalWifiFrame.usEscUsAll(
                ip: [192, 168, 1, 50], netmask: [192, 168, 1, 1], gateway: [192, 168, 1, 1],
                keyType: .wep64, ssid: String(repeating: "A", count: 33), password: "12345678"
            )
        )
    }

    // MARK: - nenhum opcode proibido

    func testNenhumQuadroEmitidoComecaPorUmOpcodeProibido() {
        // A lista das duas famílias, junta: `1F 6D` grava MAC, `1F 69` põe IP fixo, `1F 62 44 00`
        // desliga DHCP, `1F 25` mexe em máscara/gateway, `1F 4E` não existe na tabela US, `03` é o
        // canal de atualização de firmware que apaga flash; do lado GoldenSky, `B8` troca o modo
        // USB, `BF` mexe nos DIP switches, `33` e `91` são de outro protocolo e outra porta.
        let proibidos: [[UInt8]] = [
            [0x1f, 0x6d], [0x1f, 0x69], [0x1f, 0x62, 0x44, 0x00], [0x1f, 0x25], [0x1f, 0x4e], [0x03],
            [0x1f, 0x1b, 0x1f, 0xb8], [0x1f, 0x1b, 0x1f, 0xbf],
            [0x1f, 0x1b, 0x1f, 0x33], [0x1f, 0x1b, 0x1f, 0x91],
        ]
        for (nome, _, quadro) in Self.corpusDeQuadros() {
            for proibido in proibidos {
                XCTAssertFalse(quadro.starts(with: proibido), "\(nome) começou por opcode proibido")
            }
        }
    }

    func testOCabecalhoEOOpcodeSaoConstantesEmTodoQuadroEmitido() {
        // É esta a garantia estrutural: os bytes de comando não vêm de parâmetro nenhum. Não há
        // `opcode:`, `subcommand:` nem `raw:` na superfície, então nenhuma entrada — nem hostil —
        // alcança a posição de comando.
        for (nome, _, quadro) in Self.corpusDeQuadros() {
            if quadro.starts(with: [0x1f, 0x77]) { continue }
            XCTAssertTrue(quadro.starts(with: [0x1f, 0x1b, 0x1f]), nome)
            XCTAssertTrue([0xb3, 0xb4].contains(quadro[3]), "\(nome) trocou o opcode da família")
        }
    }

    func testOComprimentoDeclaradoBateComOCampoQueOSegueEmTodoQuadroUsW() throws {
        // **Este é o teste do acidente de 21/08.** Lá o `LL` dizia 8 e o SSID digitado tinha 7: o
        // handler engoliu o byte seguinte como oitava letra, o quadro inteiro andou uma casa, o
        // `1F` do envio seguinte virou chave e o `77` virou byte de modo — e gravou assim mesmo. Um
        // byte a menos não vira erro, vira frame válido errado. Aqui o comprimento e o campo saem
        // da mesma contagem, e o teste confere os dois separadamente.
        for vector in ThermalWifiFrameParityVectors.usW {
            let quadro = try XCTUnwrap(
                ThermalWifiFrame.usW(ssid: vector.ssid, security: vector.security, mode: vector.mode),
                vector.name
            )
            let ssidBytes = Array(vector.ssid.utf8)
            XCTAssertEqual(Int(quadro[2]), ssidBytes.count, vector.name)
            XCTAssertEqual(Array(quadro[3..<(3 + ssidBytes.count)]), ssidBytes, vector.name)
            // Nenhum byte de campo variável desce abaixo de 0x20, então nem SSID nem senha podem
            // ser lidos como comando se o quadro andar por qualquer motivo.
            XCTAssertTrue(ssidBytes.allSatisfy { (0x20...0x7e).contains($0) }, vector.name)

            let apos = 3 + ssidBytes.count
            if let senha = vector.security.password {
                let senhaBytes = Array(senha.utf8)
                XCTAssertEqual(quadro[apos], vector.security.auth.byte, vector.name)
                XCTAssertEqual(quadro[apos + 1], vector.security.cipher.byte, vector.name)
                XCTAssertEqual(Int(quadro[apos + 2]), senhaBytes.count, vector.name)
                XCTAssertEqual(Array(quadro[(apos + 3)..<(apos + 3 + senhaBytes.count)]), senhaBytes, vector.name)
                XCTAssertEqual(quadro.count, apos + 4 + senhaBytes.count, vector.name)
                XCTAssertTrue(senhaBytes.allSatisfy { (0x20...0x7e).contains($0) }, vector.name)
            } else {
                XCTAssertEqual(Array(quadro[apos..<(apos + 3)]), [0, 0, 0], vector.name)
                XCTAssertEqual(quadro.count, apos + 4, vector.name)
            }
            XCTAssertEqual(quadro.last, vector.mode.byte, vector.name)
        }
    }

    func testOQuadroDaGoldenSkyTemExatamenteOsDoisTerminadoresEMaisNenhum() {
        // O `NUL` é o único separador desta família: um zero a mais fecharia um campo cedo e um a
        // menos deixaria o parser esperando, que foi o que travou a bancada em 22/08. Contados
        // **depois** do `KT`, porque antes dele o `B4` carrega octetos que podem valer zero.
        for (nome, _, quadro) in Self.corpusDeQuadros() where !quadro.starts(with: [0x1f, 0x77]) {
            let inicioDoTexto = quadro.starts(with: [0x1f, 0x1b, 0x1f, 0xb4]) ? 17 : 5
            XCTAssertEqual(quadro[inicioDoTexto...].filter { $0 == 0 }.count, 2, nome)
            XCTAssertEqual(quadro.last, 0, nome)
        }
    }

    // MARK: - o segredo não vaza

    func testADescricaoDaSegurancaNaoEcoaASenha() {
        // AGENTS.md, Segurança: a chave nunca aparece em log, erro, `toString()` ou `description`.
        // Sem esta conformidade a descrição sintetizada do enum imprimiria a senha inteira em
        // qualquer interpolação — é o mesmo motivo do `[REDACTED]` de `RawHexCommand`.
        let seguranca = ThermalWifiSecurity.wpa2PSK(cipher: .wepAES, password: "senha12345")
        for texto in ["\(seguranca)", String(describing: seguranca), String(reflecting: seguranca)] {
            XCTAssertFalse(texto.contains("senha12345"))
            XCTAssertTrue(texto.contains("[REDACTED]"))
        }
    }

    func testNenhumaFraseDeRecusaEcoaOValorRecusado() {
        let entradas = ["RedeSecretaDoBruno", "senha12345", "MinhaRede"]
        for rejection in ThermalWifiFrameParityVectors.rejections {
            for entrada in entradas {
                XCTAssertFalse(rejection.message.contains(entrada), rejection.message)
            }
        }
    }

    // MARK: - corpus de varredura

    /// Todo quadro que a camada consegue emitir a partir de entradas válidas, inclusive as hostis.
    ///
    /// As entradas hostis existem para provar o que a estrutura promete: um SSID que é literalmente
    /// o texto de um comando proibido continua sendo dado, porque nunca chega a uma posição de
    /// comando.
    /// Nome, tamanho anunciado pelo validador e quadro emitido — os três, para o espelho do teste
    /// `o tamanho anunciado pelo validador e o tamanho que sai` de `ThermalWifiFrameTest.kt`.
    func testOTamanhoAnunciadoPeloValidadorEOTamanhoQueSai() {
        // Se o validador anunciar um número e o construtor emitir outro, a tela de confirmação
        // mostra um quadro e a impressora recebe outro — e é justamente a contagem que a pessoa lê
        // antes de mandar. Espelho de `o tamanho anunciado pelo validador e o tamanho que sai`,
        // em `ThermalWifiFrameTest.kt`.
        for (nome, anunciado, quadro) in Self.corpusDeQuadros() {
            XCTAssertEqual(anunciado, quadro.count, nome)
        }
    }

    private static func corpusDeQuadros() -> [(String, Int, Data)] {
        var quadros: [(String, Int, Data)] = []
        for vector in ThermalWifiFrameParityVectors.usW {
            if case .accepted(let anunciado) = ThermalWifiFrame.validate(
                ssid: vector.ssid, security: vector.security
            ), let quadro = ThermalWifiFrame.usW(ssid: vector.ssid, security: vector.security, mode: vector.mode) {
                quadros.append((vector.name, anunciado, quadro))
            }
        }
        for vector in ThermalWifiFrameParityVectors.usEscUsWifiOnly {
            if case .accepted(let anunciado) = ThermalWifiFrame.validate(
                keyType: vector.keyType, ssid: vector.ssid, password: vector.password
            ), let quadro = ThermalWifiFrame.usEscUsWifiOnly(
                keyType: vector.keyType, ssid: vector.ssid, password: vector.password
            ) {
                quadros.append((vector.name, anunciado, quadro))
            }
        }
        for vector in ThermalWifiFrameParityVectors.usEscUsAll {
            if case .accepted(let anunciado) = ThermalWifiFrame.validate(
                ip: vector.ip, netmask: vector.netmask, gateway: vector.gateway,
                keyType: vector.keyType, ssid: vector.ssid, password: vector.password
            ), let quadro = ThermalWifiFrame.usEscUsAll(
                ip: vector.ip, netmask: vector.netmask, gateway: vector.gateway,
                keyType: vector.keyType, ssid: vector.ssid, password: vector.password
            ) {
                quadros.append((vector.name, anunciado, quadro))
            }
        }
        // Nomes de rede que imitam comando — as letras dos opcodes proibidos, e o caractere mais
        // alto e o mais baixo do ASCII aceito. Os endereços do `B4` valem 31 e 27 de propósito:
        // `1F 1B` é o começo do cabeçalho da GoldenSky, e como octeto é um endereço legítimo.
        let hostis = ["wm%iNb", "~ }|", "B8BFm33", String(UnicodeScalar(0x20)) + "AA~"]
        for hostil in hostis {
            for modo in ThermalWifiMode.allCases {
                let seguranca = ThermalWifiSecurity.wpaPSK(cipher: .noneTKIP, password: "m~iNb%DD")
                if case .accepted(let anunciado) = ThermalWifiFrame.validate(
                    ssid: hostil, security: seguranca
                ), let quadro = ThermalWifiFrame.usW(ssid: hostil, security: seguranca, mode: modo) {
                    quadros.append(("usW hostil \(modo.rawValue)", anunciado, quadro))
                }
            }
            for keyType in ThermalWifiKeyType.allCases {
                let senha = keyType.requiresPassword ? "m~iNb%DD" : ""
                if case .accepted(let anunciado) = ThermalWifiFrame.validate(
                    keyType: keyType, ssid: hostil, password: senha
                ), let quadro = ThermalWifiFrame.usEscUsWifiOnly(
                    keyType: keyType, ssid: hostil, password: senha
                ) {
                    quadros.append(("B3 hostil \(keyType.rawValue)", anunciado, quadro))
                }
                if case .accepted(let anunciado) = ThermalWifiFrame.validate(
                    ip: [31, 27, 31, 179], netmask: [255, 255, 255, 0], gateway: [31, 27, 31, 1],
                    keyType: keyType, ssid: hostil, password: senha
                ), let quadro = ThermalWifiFrame.usEscUsAll(
                    ip: [31, 27, 31, 179], netmask: [255, 255, 255, 0], gateway: [31, 27, 31, 1],
                    keyType: keyType, ssid: hostil, password: senha
                ) {
                    quadros.append(("B4 hostil \(keyType.rawValue)", anunciado, quadro))
                }
            }
        }
        // O corpus só vale se ele de fato produziu quadros: uma entrada hostil recusada em silêncio
        // faria toda a varredura passar por vazio.
        XCTAssertGreaterThan(quadros.count, hostis.count * ThermalWifiKeyType.allCases.count)
        return quadros
    }
}

/**
 Os vetores fixos da paridade Android–iOS.

 **Estes literais são idênticos aos de `ThermalWifiFrameTest.kt`.** Quem alterar um altera o outro no
 mesmo commit, ou as duas suítes discordam — que é exatamente o que se quer que aconteça quando as
 duas gramáticas divergirem.

 De onde cada bloco veio, e nenhum deles é a saída desta implementação:
 - a família `1F 77` saiu de `docs/quadro-wifi.py`, o gerador de referência escrito antes desta
   camada a partir do desmonte do emissor do fabricante. O ramo `OPEN,WEP-A,` (`AA=0`/`EE≠0`) é o
   único que o gerador **não** cobre — ele colapsa todo `OPEN` em `00 00 00` —, então esse vetor foi
   montado direto da gramática e da tabela dos sete ramos;
 - a família `1F 1B 1F` saiu dos exemplos já em hexadecimal de `docs/goldensky-configuracao-wifi.md`,
   o `B3` de 26 bytes e o `B4` de 38.
 */
enum ThermalWifiFrameParityVectors {
    struct UsWVector {
        let name: String
        let ssid: String
        let security: ThermalWifiSecurity
        let mode: ThermalWifiMode
        let frame: [UInt8]

        init(
            _ name: String,
            _ ssid: String,
            _ security: ThermalWifiSecurity,
            _ mode: ThermalWifiMode,
            _ frame: [UInt8]
        ) {
            self.name = name
            self.ssid = ssid
            self.security = security
            self.mode = mode
            self.frame = frame
        }
    }

    static let usW: [UsWVector] = [
        // O quadro de 15 bytes que gravou de verdade em 21/08/2026, com o cupom `Mode: STA` como
        // oráculo. É também a prova do próprio gerador de referência, que o reproduz.
        UsWVector(
            "Bematech aberta AP", "Bematech", .open, .accessPoint,
            [0x1f, 0x77, 0x08, 0x42, 0x65, 0x6d, 0x61, 0x74, 0x65, 0x63, 0x68, 0x00, 0x00, 0x00, 0x01]
        ),
        UsWVector(
            "Bematech aberta STA", "Bematech", .open, .station,
            [0x1f, 0x77, 0x08, 0x42, 0x65, 0x6d, 0x61, 0x74, 0x65, 0x63, 0x68, 0x00, 0x00, 0x00, 0x00]
        ),
        UsWVector(
            "MinhaRede WPA2-PSK AES STA", "MinhaRede",
            .wpa2PSK(cipher: .wepAES, password: "senha12345"), .station,
            [
                0x1f, 0x77, 0x09, 0x4d, 0x69, 0x6e, 0x68, 0x61, 0x52, 0x65, 0x64, 0x65, 0x03, 0x01,
                0x0a, 0x73, 0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00,
            ]
        ),
        UsWVector(
            "MinhaRede WPA-PSK TKIP AP", "MinhaRede",
            .wpaPSK(cipher: .noneTKIP, password: "senha12345"), .accessPoint,
            [
                0x1f, 0x77, 0x09, 0x4d, 0x69, 0x6e, 0x68, 0x61, 0x52, 0x65, 0x64, 0x65, 0x02, 0x00,
                0x0a, 0x73, 0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x01,
            ]
        ),
        UsWVector(
            "Rede8 WPA2-PSK TKIP STA", "Rede8",
            .wpa2PSK(cipher: .noneTKIP, password: "12345678"), .station,
            [
                0x1f, 0x77, 0x05, 0x52, 0x65, 0x64, 0x65, 0x38, 0x03, 0x00, 0x08, 0x31, 0x32, 0x33,
                0x34, 0x35, 0x36, 0x37, 0x38, 0x00,
            ]
        ),
        UsWVector(
            "Rede8 WPA-PSK AES STA", "Rede8",
            .wpaPSK(cipher: .wepAES, password: "12345678"), .station,
            [
                0x1f, 0x77, 0x05, 0x52, 0x65, 0x64, 0x65, 0x38, 0x02, 0x01, 0x08, 0x31, 0x32, 0x33,
                0x34, 0x35, 0x36, 0x37, 0x38, 0x00,
            ]
        ),
        // `SHARED,WEP-A,`: o firmware ignora o `EE` neste ramo, e o quadro sai com `0` fixo.
        UsWVector(
            "Rede8 SHARED STA", "Rede8", .wepShared(password: "12345678"), .station,
            [
                0x1f, 0x77, 0x05, 0x52, 0x65, 0x64, 0x65, 0x38, 0x01, 0x00, 0x08, 0x31, 0x32, 0x33,
                0x34, 0x35, 0x36, 0x37, 0x38, 0x00,
            ]
        ),
        // `OPEN,WEP-A,`: o ramo `AA=0`/`EE≠0`, que o gerador de referência não cobre.
        UsWVector(
            "Rede8 OPEN WEP-A STA", "Rede8", .wepOpen(password: "12345678"), .station,
            [
                0x1f, 0x77, 0x05, 0x52, 0x65, 0x64, 0x65, 0x38, 0x00, 0x01, 0x08, 0x31, 0x32, 0x33,
                0x34, 0x35, 0x36, 0x37, 0x38, 0x00,
            ]
        ),
        // Os pisos das duas faixas: SSID de 1 byte e senha de 8.
        UsWVector(
            "piso das faixas, AP", "R",
            .wpa2PSK(cipher: .wepAES, password: "aaaaaaaa"), .accessPoint,
            [
                0x1f, 0x77, 0x01, 0x52, 0x03, 0x01, 0x08, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61,
                0x61, 0x01,
            ]
        ),
    ]

    struct UsEscUsWifiOnlyVector {
        let name: String
        let keyType: ThermalWifiKeyType
        let ssid: String
        let password: String
        let frame: [UInt8]

        init(_ name: String, _ keyType: ThermalWifiKeyType, _ ssid: String, _ password: String, _ frame: [UInt8]) {
            self.name = name
            self.keyType = keyType
            self.ssid = ssid
            self.password = password
            self.frame = frame
        }
    }

    static let usEscUsWifiOnly: [UsEscUsWifiOnlyVector] = [
        // O exemplo trabalhado do documento, 26 bytes.
        UsEscUsWifiOnlyVector(
            "B3 MinhaRede WPA2 AES", .wpa2AESPSK, "MinhaRede", "senha12345",
            [
                0x1f, 0x1b, 0x1f, 0xb3, 0x06, 0x4d, 0x69, 0x6e, 0x68, 0x61, 0x52, 0x65, 0x64, 0x65,
                0x00, 0x73, 0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00,
            ]
        ),
        // Rede aberta: `KT=0` e o campo de senha reduzido ao seu terminador.
        UsEscUsWifiOnlyVector(
            "B3 Printer aberta", .open, "Printer", "",
            [0x1f, 0x1b, 0x1f, 0xb3, 0x00, 0x50, 0x72, 0x69, 0x6e, 0x74, 0x65, 0x72, 0x00, 0x00]
        ),
        // O SSID do quadro de bancada de 22/08, agora com os dois NUL que faltavam lá.
        UsEscUsWifiOnlyVector(
            "B3 do degrau 2, terminado", .wpa2AESPSK, "ZZZZZZZZ", "senha12345",
            [
                0x1f, 0x1b, 0x1f, 0xb3, 0x06, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x00,
                0x73, 0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00,
            ]
        ),
    ]

    struct UsEscUsAllVector {
        let name: String
        let ip: [Int]
        let netmask: [Int]
        let gateway: [Int]
        let keyType: ThermalWifiKeyType
        let ssid: String
        let password: String
        let frame: [UInt8]

        init(
            _ name: String, _ ip: [Int], _ netmask: [Int], _ gateway: [Int],
            _ keyType: ThermalWifiKeyType, _ ssid: String, _ password: String, _ frame: [UInt8]
        ) {
            self.name = name
            self.ip = ip
            self.netmask = netmask
            self.gateway = gateway
            self.keyType = keyType
            self.ssid = ssid
            self.password = password
            self.frame = frame
        }
    }

    static let usEscUsAll: [UsEscUsAllVector] = [
        // O exemplo trabalhado do documento, 38 bytes, com os octetos em ordem natural `a.b.c.d`.
        UsEscUsAllVector(
            "B4 192.168.1.50 WPA2 AES", [192, 168, 1, 50], [255, 255, 255, 0], [192, 168, 1, 1],
            .wpa2AESPSK, "MinhaRede", "senha12345",
            [
                0x1f, 0x1b, 0x1f, 0xb4, 0xc0, 0xa8, 0x01, 0x32, 0xff, 0xff, 0xff, 0x00, 0xc0, 0xa8,
                0x01, 0x01, 0x06, 0x4d, 0x69, 0x6e, 0x68, 0x61, 0x52, 0x65, 0x64, 0x65, 0x00, 0x73,
                0x65, 0x6e, 0x68, 0x61, 0x31, 0x32, 0x33, 0x34, 0x35, 0x00,
            ]
        ),
        // Os dois extremos do octeto, 0 e 255, e o topo da faixa de `KT`.
        UsEscUsAllVector(
            "B4 octetos extremos", [0, 0, 0, 0], [255, 255, 255, 255], [10, 0, 0, 1],
            .wpaWPA2MixedMode, "Rede8", "12345678",
            [
                0x1f, 0x1b, 0x1f, 0xb4, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x0a, 0x00,
                0x00, 0x01, 0x09, 0x52, 0x65, 0x64, 0x65, 0x38, 0x00, 0x31, 0x32, 0x33, 0x34, 0x35,
                0x36, 0x37, 0x38, 0x00,
            ]
        ),
    ]

    /// O prefixo exato do quadro que a bancada mandou em 22/08/2026 — e que nunca fechou.
    static let bancadaGoldenSkyPrefixo: [UInt8] = [
        0x1f, 0x1b, 0x1f, 0xb3, 0x06, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a,
    ]

    /// Toda recusa que a camada sabe produzir, na ordem em que as frases são fixadas abaixo.
    static let rejections: [ThermalWifiRejection] = [
        .ssidEmpty,
        .ssidTooLong(max: 32),
        .ssidNotASCII,
        .passwordLength(min: 8, max: 63),
        .passwordNotASCII,
        .passwordOnOpenNetwork,
        .addressOctets(field: .ip),
        .addressOctets(field: .netmask),
        .addressOctets(field: .gateway),
    ]

    /// Paridade inclui texto de erro: a frase que sai no iOS é a mesma que sai no Android.
    static let rejectionMessages = [
        "Informe o nome da rede.",
        "O nome da rede aceita no máximo 32 caracteres.",
        "O nome da rede aceita apenas letras e números sem acento.",
        "A senha da rede precisa de 8 a 63 caracteres.",
        "A senha da rede aceita apenas letras e números sem acento.",
        "Rede aberta não leva senha.",
        "O endereço IP precisa de quatro números de 0 a 255.",
        "A máscara precisa de quatro números de 0 a 255.",
        "O gateway precisa de quatro números de 0 a 255.",
    ]
}
