import Foundation

/**
 O comprovante de teste, num lugar só.

 Os dois controladores imprimiam o mesmo papel a partir de duas cópias idênticas do mesmo código —
 e a configuração manual precisa dele com um layout que não é o de nenhum dos dois: o que a pessoa
 acabou de declarar, antes de existir instalação. Uma terceira cópia era a garantia de que uma
 linha nova entraria em duas delas e faltaria na outra, descoberto no papel.

 Ele é papel do hospedeiro como qualquer venda, e carrega a decoração dele. A tira de homologação
 não carrega: ela é instrumento de medida, e um raster no meio da régua desloca justamente o que
 ela mede. Ver ``ReceiptDecoration``.
 */
public enum PrinterTestReceipt {
    /**
     - Parameters:
       - nativeQrHonored: o que a sonda de código nativo mediu no perfil adotado, ou `nil` quando
         não há perfil medido por trás deste layout. Vem **do perfil**, e não do layout, porque
         depois de construído um layout rasterizado não distingue "é o padrão" de "foi o máximo que
         a medição permitiu" — e é justamente essa diferença que a linha relata.
       - nativeBarcodeHonored: o mesmo para o `GS k`. São dois comandos, e por isso são dois campos.
     */
    public static func bytes(
        layout: ReceiptLayout,
        nativeQrHonored: Bool? = nil,
        nativeBarcodeHonored: Bool? = nil
    ) -> Data {
        // **O prólogo é do dialeto do layout, e não `ESC @` fixo.** Todo o resto deste comprovante
        // já sai pelo layout, que fala Procomp desde 30/08/2026: o corpo saía traduzido e o prólogo
        // não. Medido em 23/08/2026 na IM453H — `ESC @` não é comando dela, e o `40h` foi impresso
        // como um `@` na frente das tiras. Nenhum dos três chamadores deste papel passa por
        // homologação: bastava um perfil Procomp adotado e alguém tocar em "imprimir teste".
        var data = EscPosDialectGate.prologue(for: layout.dialect)
        if let cabecalho = layout.decoration?.header(layout: layout) { data.append(cabecalho) }
        data.append(layout.text("COMPROVANTE DE TESTE\n", alignment: 1, bold: true))
        data.append(layout.text("\(layout.columns) colunas | \(layout.printableDots) dots\n", alignment: 0))
        // **As três linhas seguintes são do dialeto, e não do formato do perfil.** O prólogo já
        // era; estas ficaram para trás e diziam, num papel Procomp, três medições que ninguém fez:
        // `Página:` e `Codificação:` descrevem uma escolha de tabela que não existe nesta firmware
        // (não há `ESC t`; o texto sai em ABICOMP, tabela de fábrica, provada em papel em
        // 23/08/2026), e `Corte:` imprimia o nome do enum ESC/POS — `GS V 1` — numa impressora que
        // nunca recebe um byte `GS`, porque `procompFinish` emite `ESC w` sem consultar o campo.
        //
        // O argumento é o de ``ProcompHomologationProbes/profileLines(profile:identity:transport:)``,
        // escrito lá: "imprimir o nome do enum aqui faria alguém transcrever para um cadastro, um
        // mês depois, uma medição que nunca houve". Vale igual aqui — e mais, porque este papel é o
        // que qualquer pessoa alcança tocando em "imprimir teste", sem passar por homologação
        // nenhuma. As duas folhas passam a dizer a mesma coisa sobre a mesma impressora.
        data.append(layout.text(dialectLines(layout: layout), alignment: 0))
        // Este papel já lista capacidades, e a compensação vertical é uma delas — a que muda os
        // bytes do QR logo abaixo. Sai do layout, e não de um perfil, porque é o layout que decide
        // o raster deste comprovante; o Android lê do mesmo lugar.
        data.append(
            layout.text(
                PrinterProbePayloads.verticalRasterScaleLine(layout.verticalRasterScale),
                alignment: 0
            )
        )
        // As duas capacidades da sonda de código nativo saem aqui pelo mesmo argumento da linha
        // acima: é este o papel que a pessoa tem na mão quando decide se o ajuste de emissão vale.
        data.append(
            layout.text(PrinterProbePayloads.nativeQRLine(nativeQrHonored), alignment: 0)
        )
        data.append(
            layout.text(PrinterProbePayloads.nativeBarcodeLine(nativeBarcodeHonored), alignment: 0)
        )
        data.append(layout.text("Acentos: ação, opção, São João\n", alignment: 0))
        data.append(layout.text("Em: \(PrinterProbePayloads.localTimestamp())\n", alignment: 0))
        // O QR prova o caminho raster na largura medida: texto sai em qualquer firmware, faixa
        // `GS v 0` não. O Android já o imprimia no comprovante de teste.
        if let qr = layout.qrRaster(payload: PrinterProbePayloads.finalReceiptQR) {
            data.append(qr)
        }
        // Sem guilhotina: `finish` avança até a serrilha em vez de pedir corte.
        data.append(layout.finish())
        return data
    }

    /**
     Tabela e corte, ditos na língua do layout.

     No dialeto ESC/POS são as três linhas de sempre — página, codificação e o protocolo de corte
     escolhido —, porque lá as três descrevem escolhas que a impressora realmente faz. No Procomp
     são duas, e são as mesmas da certidão de homologação: a tabela é a de fábrica, e o corte é o
     comando que sai.

     **Sem prova de bancada, e é preciso dizer:** que `ESC w` corte numa IM453H foi medido em
     23/08/2026; que esta *frase* corresponda ao que sai continua sendo garantido só por leitura de
     código — `procompFinish` é o único fecho deste dialeto, e nenhum teste desta suíte tem papel.
     */
    static func dialectLines(layout: ReceiptLayout) -> String {
        switch layout.dialect {
        case .epsonCompatible:
            var linhas = "Página: \(layout.codePage?.label ?? "Nenhuma")\n"
            // O layout já resolve o modelo na construção — página presente vira byte único,
            // ausência vira dobra ASCII —, então aqui não há fallback nenhum a aplicar.
            linhas += "Codificação: \(layout.textEncoding.receiptLabel)\n"
            linhas += "Corte: \(layout.cutProtocol.label) | avanço \(layout.cutFeedLines)\n"
            return linhas
        case .procompEscP:
            var linhas = "Tabela: ABICOMP (fábrica)\n"
            linhas += layout.cutProtocol.hasCutter
                ? "Corte: ESC w (parcial) | avanço \(layout.cutFeedLines)\n"
                : "Corte: sem guilhotina\n"
            return linhas
        }
    }
}
