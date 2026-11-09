import SwiftUI
import ThermalPrinterKit

/// Procura impressora na Wi-Fi privada da vez.
///
/// Subiu do app de bancada pela mesma razão que o comando cru: diagnóstico serve tanto a quem tem
/// a impressora na mesa quanto a quem está do outro lado do país com um modelo que não temos.
///
/// O endereço encontrado vive só em memória. IP e porta em disco foi divergência de segurança
/// corrigida na extração do kit — o store guarda `profileId` e mais nada — e não volta por aqui.
@available(iOS 15.0, macOS 12.0, *)
@MainActor
public struct PrinterNetworkScanView: View {
    @ObservedObject var printer: ThermalPrinterConfiguration
    @State private var testedCandidate: LocalWifiPrinterCandidate?
    @State private var notice: String?

    public init(printer: ThermalPrinterConfiguration) {
        self.printer = printer
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Procura TCP na rede Wi-Fi privada atual. IP e porta existem somente em memória e não entram em log.")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    testedCandidate = nil
                    notice = nil
                    printer.discardEphemeralProbeTarget()
                    printer.localWifi.search()
                } label: {
                    Label("Iniciar scan de rede", systemImage: "magnifyingglass")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .disabled(printer.localWifi.state.isBusy)
                .accessibilityIdentifier("printer.diagnostics.network.scan")

                Text(printer.localWifi.state.message)
                    .font(.footnote)
                    .foregroundColor(.secondary)

                ForEach(printer.localWifi.candidates) { candidate in
                    Button {
                        testedCandidate = candidate
                        notice = nil
                        printer.test(candidate, profile: BundledPrinterProfiles.elginI9Full2)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(candidate.label).font(.headline)
                            Text(candidate.ipAddress).font(.caption.monospaced())
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                    }
                    .buttonStyle(.bordered)
                    .disabled(printer.localWifi.state.isBusy)
                    .accessibilityIdentifier("printer.diagnostics.network.candidate.\(candidate.id)")
                }

                if let notice {
                    Text(notice)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                usbNotice
            }
            .padding(20)
        }
        .alert(
            "Como saiu o comprovante de teste?",
            isPresented: Binding(
                get: { testedCandidate != nil && printer.localWifi.state == .awaitingConfirmation },
                set: { _ in }
            )
        ) {
            Button("Saiu certo") {
                _ = printer.handleInitialReceipt(.printedCorrectly)
                testedCandidate = nil
                notice = "Impressora adotada; o endpoint efêmero foi descartado."
            }
            Button("Saiu com problema") {
                _ = printer.handleInitialReceipt(.printedWithProblem)
                testedCandidate = nil
                notice = "Candidata retida em memória para Homologação ou Comando cru."
            }
            Button("Não saiu", role: .destructive) {
                _ = printer.handleInitialReceipt(.notPrinted)
                testedCandidate = nil
                notice = "Candidata descartada."
            }
        } message: {
            Text("A resposta é humana; fechar esta pergunta não confirma nem descarta o papel.")
        }
    }

    private var usbNotice: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("USB host não existe no iOS", systemImage: "cable.connector.slash")
                .font(.headline)
            Text(
                "O iPhone não oferece USB host genérico para estas impressoras. Use Wi-Fi ou " +
                    "Bluetooth LE; acessórios USB exigiriam hardware e certificação MFi."
            )
            .font(.footnote)
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(Color.orange.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityIdentifier("printer.diagnostics.usb.unavailable")
    }
}
