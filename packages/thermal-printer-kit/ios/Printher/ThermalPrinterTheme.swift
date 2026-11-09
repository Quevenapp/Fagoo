import SwiftUI

/// Paleta pequena e neutra: o consumidor pode aplicar sua marca sem o kit conhecer seu design system.
public struct ThermalPrinterTheme {
    public let usesPrintherLayout: Bool
    public let printerImageNames: [String: String]
    public let printerDisplayNames: [String: String]
    public let primary: Color
    public let primarySurface: Color
    public let background: Color
    public let surface: Color
    public let text: Color
    public let secondaryText: Color
    public let success: Color
    public let warning: Color
    public let danger: Color

    public init(
        usesPrintherLayout: Bool = false,
        printerImageNames: [String: String] = [:],
        printerDisplayNames: [String: String] = [:],
        primary: Color,
        primarySurface: Color,
        background: Color,
        surface: Color,
        text: Color,
        secondaryText: Color,
        success: Color,
        warning: Color,
        danger: Color
    ) {
        self.usesPrintherLayout = usesPrintherLayout
        self.printerImageNames = printerImageNames
        self.printerDisplayNames = printerDisplayNames
        self.primary = primary
        self.primarySurface = primarySurface
        self.background = background
        self.surface = surface
        self.text = text
        self.secondaryText = secondaryText
        self.success = success
        self.warning = warning
        self.danger = danger
    }

    public static let neutral = ThermalPrinterTheme(
        primary: Color(red: 0.18, green: 0.24, blue: 0.30),
        primarySurface: Color(red: 0.91, green: 0.93, blue: 0.95),
        background: Color(red: 0.97, green: 0.97, blue: 0.96),
        surface: .white,
        text: Color(red: 0.10, green: 0.11, blue: 0.12),
        secondaryText: Color(red: 0.34, green: 0.36, blue: 0.38),
        success: Color(red: 0.12, green: 0.45, blue: 0.26),
        warning: Color(red: 0.73, green: 0.43, blue: 0.06),
        danger: Color(red: 0.68, green: 0.15, blue: 0.15)
    )

    public static let printher = ThermalPrinterTheme(
        usesPrintherLayout: true,
        primary: Color(red: 0.05, green: 0.43, blue: 0.93),
        primarySurface: Color(red: 0.91, green: 0.95, blue: 1.0),
        background: Color(red: 0.985, green: 0.985, blue: 0.985),
        surface: .white,
        text: Color(red: 0.06, green: 0.06, blue: 0.06),
        secondaryText: Color(red: 0.43, green: 0.43, blue: 0.45),
        success: Color(red: 0.07, green: 0.45, blue: 0.18),
        warning: Color(red: 0.73, green: 0.43, blue: 0.06),
        danger: Color(red: 0.68, green: 0.15, blue: 0.15)
    )

    public func withPrinterImages(
        _ names: [String: String],
        displayNames: [String: String] = [:]
    ) -> ThermalPrinterTheme {
        ThermalPrinterTheme(
            usesPrintherLayout: usesPrintherLayout,
            printerImageNames: names,
            printerDisplayNames: displayNames,
            primary: primary,
            primarySurface: primarySurface,
            background: background,
            surface: surface,
            text: text,
            secondaryText: secondaryText,
            success: success,
            warning: warning,
            danger: danger
        )
    }
}

/**
 O recuo de barra de status que o hospedeiro pode não ter dado.

 Estas superfícies são **páginas inteiras**, e o app hospedeiro pode apresentá-las sem barra de
 navegação: o Printher põe a aba "Impressoras" dentro de um `NavigationView` com
 `navigationBarHidden(true)`, e o topo seguro chega zerado ali. Medido lado a lado no iPhone 7 e no
 A07 em 20/08: o título "Vamos testar sua impressora" nascia por cima do relógio e da bateria,
 enquanto no Android a mesma tela começava abaixo das barras.

 É o mesmo conserto que o `systemBarsPadding` deu ao Diagnóstico do Android em 19/08, e pela mesma
 razão — página que o hospedeiro desenha ponta a ponta paga o próprio recuo —, com o cuidado que
 aquele commit também teve: **o recuo nunca sai duas vezes**. Onde o hospedeiro dá o topo seguro
 (o app de bancada, que mantém a barra; o sheet, que já começa abaixo do relógio), o que se soma
 aqui é zero.
 */
enum PrinterScreenInset {
    /// A barra de status clássica, que é a que sobra sem entalhe. Em aparelho com entalhe o topo
    /// seguro nunca chega zerado, então este número não é usado lá.
    static let statusBar: CGFloat = 20

    /// O que falta para o conteúdo começar abaixo da barra de status.
    static func topShortfall(reported: CGFloat) -> CGFloat {
        reported > 0 ? 0 : statusBar
    }
}

@available(iOS 15.0, macOS 12.0, *)
private struct PrinterStatusBarInset: ViewModifier {
    func body(content: Content) -> some View {
        GeometryReader { proxy in
            content
                .padding(.top, PrinterScreenInset.topShortfall(reported: proxy.safeAreaInsets.top))
        }
    }
}

@available(iOS 15.0, macOS 12.0, *)
extension View {
    /// Aplica o recuo da barra de status na raiz de uma página do kit. Ver ``PrinterScreenInset``.
    func printerStatusBarInset() -> some View {
        modifier(PrinterStatusBarInset())
    }
}
