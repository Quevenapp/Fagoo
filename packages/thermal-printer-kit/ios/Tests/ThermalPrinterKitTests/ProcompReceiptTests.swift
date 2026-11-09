import Foundation
import XCTest
@testable import ThermalPrinterKit

/**
 O texto e o fecho do dialeto Procomp — os dois caminhos do cupom que não são raster.

 **Por que eles existem neste lote.** O escopo pedia o envelope de raster; parar aí deixaria em pé
 uma armadilha nova: um `ReceiptLayout` com dialeto Procomp cujo `text` emitisse `GS !` e `ESC a` e
 cujo `finish` emitisse `GS V` — três comandos `GS`/`ESC a` numa firmware que não tem nenhum dos
 dois, e que trava com eles. Um dialeto pela metade é pior que nenhum, porque parece pronto.

 **Cada sequência afirmada aqui foi vista impressa na bancada em 23 e 26/08/2026** e está escrita em
 `ProcompEscP.swift` com a data. **Nada deste arquivo saiu em papel por este lote**: o que ele mede
 são os bytes que o kit monta, contra o espelho Kotlin (`ProcompEscP.kt`, `ProcompReceipt.kt`).
 */
final class ProcompReceiptTests: XCTestCase {

    // MARK: - Os comandos medidos

    /**
     Os atributos, um a um, e o reset que **não** é `ESC @`.

     `ESC @` não é comando desta firmware: ele sai como um `@` impresso no papel. `reset()` desliga
     cada atributo pelo comando que desliga aquele atributo, todos vistos agindo em papel.
     */
    func testOsComandosDeAtributoSaoOsMedidos() {
        XCTAssertEqual([UInt8](ProcompEscP.emphasisOn()), [0x1B, 0x45])
        XCTAssertEqual([UInt8](ProcompEscP.emphasisOff()), [0x1B, 0x46])
        XCTAssertEqual([UInt8](ProcompEscP.expandedOn()), [0x1B, 0x0E])
        XCTAssertEqual([UInt8](ProcompEscP.expandedOff()), [0x1B, 0x14])
        XCTAssertEqual([UInt8](ProcompEscP.condensedOn()), [0x1B, 0x0F])
        XCTAssertEqual([UInt8](ProcompEscP.condensedOff()), [0x1B, 0x12])
        XCTAssertEqual([UInt8](ProcompEscP.doubleHeight(true)), [0x1B, 0x5D, 0x01])
        XCTAssertEqual([UInt8](ProcompEscP.doubleHeight(false)), [0x1B, 0x5D, 0x00])
        XCTAssertEqual(
            [UInt8](ProcompEscP.reset()),
            [0x1B, 0x46, 0x1B, 0x14, 0x1B, 0x12, 0x1B, 0x5D, 0x00]
        )
        XCTAssertFalse([UInt8](ProcompEscP.reset()).contains(0x40), "não existe `ESC @` aqui")
    }

    /// Os dois cortes medidos, e o avanço que é `LF` e não `ESC d`.
    func testOCorteEOAvancoSaoOsMedidos() {
        XCTAssertEqual([UInt8](ProcompEscP.cut(.escW)), [0x1B, 0x77])
        XCTAssertEqual([UInt8](ProcompEscP.cut(.escUS)), [0x1B, 0x1F])
        XCTAssertEqual([UInt8](ProcompEscP.feed(lines: 3) ?? Data()), [0x0A, 0x0A, 0x0A])
        XCTAssertEqual(ProcompEscP.feed(lines: 0), Data())
        XCTAssertNil(ProcompEscP.feed(lines: -1))
        XCTAssertNil(ProcompEscP.feed(lines: 65), "fora da faixa medida é recusa, não tira truncada")
    }

    // MARK: - A tabela alta

    /**
     Os acentos que saíram em papel, na posição em que saíram.

     `ç`=`C6`, `ã`=`C4`, `ê`=`C9`, `á`=`C2`, `õ`=`D3` vieram das tiras M2 e M3 de 23/08/2026. ASCII
     imprimível e `LF` passam intactos; o que a tabela não tem dobra para ASCII antes de virar `?`,
     porque "acao" é legível e "a?ao" não é.
     */
    func testATabelaAbicompCodificaOsAcentosMedidos() {
        XCTAssertEqual(
            [UInt8](ProcompEscP.encode("ção", table: .abicomp)),
            [0xC6, 0xC4, 0x6F]
        )
        XCTAssertEqual(
            [UInt8](ProcompEscP.encode("Café ê á õ\n", table: .abicomp)),
            [0x43, 0x61, 0x66, 0xC8, 0x20, 0xC9, 0x20, 0xC2, 0x20, 0xD3, 0x0A]
        )
        // A CP850 desta firmware não tem `Œ`; a ABICOMP tem, em `B5`. A dobra só age onde falta.
        XCTAssertEqual([UInt8](ProcompEscP.encode("Œ", table: .abicomp)), [0xB5])
        XCTAssertEqual([UInt8](ProcompEscP.encode("ß", table: .cp850)), [0x73, 0x73])
        // Sem lugar na tabela e sem dobra: `?`, e nunca um byte aleatório.
        XCTAssertEqual([UInt8](ProcompEscP.encode("→", table: .abicomp)), [0x3F])
    }

    /**
     O alinhamento desta impressora é preenchimento, porque não existe `ESC a`.

     Texto que não cabe volta inteiro e sem recuo: cortar silenciosamente um recibo é pior que uma
     linha torta.
     */
    func testOAlinhamentoEPreenchimento() {
        XCTAssertEqual(ProcompEscP.padded("AB", columns: 8, alignment: .left), "AB")
        XCTAssertEqual(ProcompEscP.padded("AB", columns: 8, alignment: .center), "   AB")
        XCTAssertEqual(ProcompEscP.padded("AB", columns: 8, alignment: .right), "      AB")
        XCTAssertEqual(ProcompEscP.padded("ABCDEFGH", columns: 8, alignment: .center), "ABCDEFGH")
        XCTAssertEqual(ProcompEscP.padded("ABCDEFGHI", columns: 8, alignment: .right), "ABCDEFGHI")
    }

    // MARK: - O bloco de texto

    /// O bloco mínimo: só o preenchimento e o texto, sem comando nenhum em volta.
    func testUmBlocoSimplesEPreenchimentoMaisTexto() {
        let bytes = procompText("AB", alignment: 1, bold: false, size: .normal, columns: 8)

        XCTAssertEqual([UInt8](bytes), [0x20, 0x20, 0x20, 0x41, 0x42])
    }

    /**
     **O bloco fecha o que abriu**, e em ordem inversa.

     Nesta firmware não há `ESC @` para zerar tudo de uma vez: o que ligou precisa desligar, senão o
     cupom seguinte sai em corpo dobrado sem ter pedido.
     */
    func testOBlocoFechaOQueAbriu() {
        let bytes = [UInt8](
            procompText(
                "AB",
                alignment: 0,
                bold: true,
                size: ThermalTextSize(widthMultiplier: 2, heightMultiplier: 2) ?? .normal,
                columns: 8
            )
        )

        XCTAssertEqual(
            bytes,
            [0x1B, 0x45] + [0x1B, 0x0E] + [0x1B, 0x5D, 0x01]
                + [0x41, 0x42]
                + [0x1B, 0x5D, 0x00] + [0x1B, 0x14] + [0x1B, 0x46]
        )
    }

    /**
     Texto expandido conta em colunas do dobro, porque cada caractere ocupa duas.

     Em 48 colunas com corpo expandido cabem 24, e centralizar "AB" recua 11 e não 23. Foi assim que
     "PASTELÃO DE CARNE" saiu do laboratório partido no papel, no caminho ESC/POS, por a conta ter
     sido feita com a largura simples.
     */
    func testTextoExpandidoContaEmColunasDoDobro() {
        let bytes = [UInt8](
            procompText(
                "AB",
                alignment: 1,
                bold: false,
                size: ThermalTextSize(widthMultiplier: 2, heightMultiplier: 1) ?? .normal,
                columns: 48
            )
        )

        let espacos = bytes.drop(while: { $0 != 0x20 }).prefix(while: { $0 == 0x20 }).count
        XCTAssertEqual(espacos, 11, "24 colunas efetivas: (24 - 2) / 2")
    }

    /**
     **Linha vazia não recebe preenchimento**, e isso não é economia de bytes.

     Medido em papel na IM453H em 24/08/2026: um bloco centrado de `"\nCupom de exemplo\n"` terminava
     com 24 espaços soltos, e a linha seguinte começava na coluna 24, estourava a largura e partia
     "Item ... Valor" em duas. O defeito parecia largura errada do perfil, e não era — a régua de
     colunas confirmou 48.
     */
    func testLinhaVaziaNaoRecebePreenchimento() {
        let bytes = [UInt8](procompText("\nAB\n", alignment: 1, bold: false, size: .normal, columns: 8))

        XCTAssertEqual(bytes, [0x0A, 0x20, 0x20, 0x20, 0x41, 0x42, 0x0A])
        XCTAssertEqual(bytes.last, 0x0A, "o bloco não pode terminar em espaço solto")
    }

    // MARK: - O fecho

    /**
     O fecho do cupom é o `ESC w` medido, com o avanço do perfil na frente.

     `ESC w` e `ESC US` cortaram os dois, e os dois cortaram **parcial** — a guilhotina desta unidade
     está configurada "Somente Parcial". O `ESC w` é o escolhido por ser o corte simples; o `ESC US`
     embute avanço próprio, que brigaria com o avanço do perfil.
     */
    func testOFechoDoCupomProcomp() {
        XCTAssertEqual(
            [UInt8](procompFinish(hasCutter: true, cutFeedLines: 4, tearFeedLines: 4)),
            [0x0A, 0x0A, 0x0A, 0x0A, 0x1B, 0x77]
        )
        XCTAssertEqual(
            [UInt8](procompFinish(hasCutter: true, cutFeedLines: 0, tearFeedLines: 4)),
            [0x1B, 0x77],
            "avanço 0 é medida desta unidade: o `ESC w` alimenta sozinho"
        )
        XCTAssertEqual(
            [UInt8](procompFinish(hasCutter: false, cutFeedLines: 0, tearFeedLines: 4)),
            [0x0A, 0x0A, 0x0A, 0x0A],
            "sem guilhotina o corte é serrilha, e o papel só avança"
        )
    }

    /**
     O fecho que o layout emite é o mesmo `procompFinish`, com os números do perfil.

     Se este papel sair cortado, o cupom de amanhã sai cortado pelos mesmos bytes — não há segundo
     caminho. É a prova espelho de `HomologacaoProcompTest` do lado Kotlin.
     */
    func testOLayoutProcompFechaPeloMesmoCorte() {
        let comGuilhotina = ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: true,
            codePage: nil,
            cutProtocol: .gsV1,
            cutFeedLines: 4,
            printableDots: 576,
            dialect: .procompEscP
        )

        XCTAssertEqual([UInt8](comGuilhotina.finish()), [0x0A, 0x0A, 0x0A, 0x0A, 0x1B, 0x77])
        XCTAssertFalse(
            comGuilhotina.finish().contains(0x1D),
            "o `GS_V_1` do perfil é o lugar do corte no formato comum, não uma medição: "
                + "nenhum byte `GS` pode chegar a esta impressora"
        )
    }

    /// E o dialeto ESC/POS continua fechando como sempre fechou: o mutante desta suíte.
    func testOLayoutEscPosContinuaFechandoNoGsV() {
        let epson = ReceiptLayout(
            columns: 48,
            qrWidthDots: 320,
            hasCutter: true,
            codePage: nil,
            cutProtocol: .gsV1,
            cutFeedLines: 4,
            printableDots: 576
        )

        XCTAssertTrue(epson.finish().contains(0x1D))
    }

    /// O texto do layout também atravessa o dialeto, e não só as funções soltas deste arquivo.
    func testOTextoDoLayoutAtravessaODialeto() {
        let layout = ReceiptLayout(
            columns: 8,
            qrWidthDots: 320,
            hasCutter: false,
            codePage: nil,
            printableDots: 576,
            dialect: .procompEscP
        )

        XCTAssertEqual([UInt8](layout.text("AB", alignment: 1)), [0x20, 0x20, 0x20, 0x41, 0x42])
        // O byte cru do `GS !` é desempacotado no par de multiplicadores, que é o que este dialeto
        // sabe expressar: `0x11` é dobro na largura e na altura.
        XCTAssertEqual(
            [UInt8](layout.text("AB", alignment: 0, bold: false, size: 0x11)),
            [0x1B, 0x0E, 0x1B, 0x5D, 0x01, 0x41, 0x42, 0x1B, 0x5D, 0x00, 0x1B, 0x14]
        )
    }
}
