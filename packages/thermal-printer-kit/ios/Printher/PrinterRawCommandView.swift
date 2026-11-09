import Foundation
import SwiftUI
import ThermalPrinterKit

/// Envio de comando ESC/POS cru, com dois gestos conscientes: preparar e confirmar.
///
/// Nasceu no app de bancada e subiu porque tem dois públicos, não um: nós, medindo hardware que
/// compramos, e o usuário travado com um modelo que nunca teremos. É daqui que sai relato
/// aproveitável — "mandei `1d5600` e não cortou" diz o que "não imprime" não diz.
///
/// O aviso de risco vem do core e não é reescrito aqui: comando cru grava configuração não
/// volátil, e uma tela que resumisse isso viraria um botão destrutivo silencioso.
@available(iOS 15.0, macOS 12.0, *)
@MainActor
public struct PrinterRawCommandView: View {
    @ObservedObject var printer: ThermalPrinterConfiguration
    @StateObject private var model: RawCommandModel

    public init(printer: ThermalPrinterConfiguration) {
        self.printer = printer
        _model = StateObject(wrappedValue: RawCommandModel(printer: printer))
    }

    public var body: some View {
        // Uma leitura por desenho: a consulta desce ao store e, na rede, ao `getifaddrs`, e o
        // `body` reavalia a cada tecla digitada no editor.
        let podeEnviar = printer.canSendEphemeralCommand
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Label(rawCommandRiskWarning, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.orange)
                    .fixedSize(horizontal: false, vertical: true)

                Text(targetNotice(podeEnviar: podeEnviar))
                    .font(.footnote)
                    .foregroundColor(.secondary)

                TextEditor(text: $model.hexText)
                    .font(.body.monospaced())
                    .frame(minHeight: 130)
                    .padding(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.35)))
                    .accessibilityIdentifier("printer.diagnostics.raw.hex")

                Text("Até 256 bytes hexadecimais. Espaços e quebras de linha são aceitos.")
                    .font(.caption)
                    .foregroundColor(.secondary)

                Button("Revisar risco e enviar") {
                    // O valor de `podeEnviar` é de um desenho atrás; esta leitura é a mais
                    // recente, e o gesto seguinte é destrutivo.
                    model.prepare(hasTarget: printer.canSendEphemeralCommand)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isSending || model.hexText.isEmpty || !podeEnviar)
                .accessibilityIdentifier("printer.diagnostics.raw.prepare")

                if model.isSending {
                    ProgressView("Aguardando callback real do transporte")
                }
                if let message = model.message {
                    Text(message)
                        .font(.footnote)
                        .foregroundColor(model.failed ? .red : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                usbNotice
            }
            .padding(20)
        }
        .alert("Confirmar envio cru", isPresented: $model.showsConfirmation) {
            Button("Cancelar", role: .cancel) { model.cancel() }
            Button("Entendo o risco e quero enviar", role: .destructive) { model.confirm() }
        } message: {
            Text(model.confirmation?.warning ?? rawCommandRiskWarning)
        }
        .onDisappear { model.cancel() }
    }

    /**
     Por onde o comando vai sair — ou o que exatamente falta para ele sair.

     São quatro respostas, e não duas, porque a queda para a impressora instalada criou casos que a
     frase antiga ("Nenhuma candidata em memória. Use Configuração ou Scan de rede…") passou a
     descrever errado: ela mandava procurar candidata quem já tinha impressora instalada e pronta.
     O Android diz a segunda metade desde sempre — "Teste uma candidata **ou restaure uma
     impressora**".

     A quarta existe pela regra do AGENTS.md de não maquiar um motivo com o outro: impressora
     instalada que não responde agora — desligada, longe, ou noutra Wi-Fi, que é o que
     `adoptedProbeSender` recusa — não é o mesmo que nunca ter havido impressora, e uma frase só
     para os dois manda a pessoa procurar no lugar errado.
     */
    private func targetNotice(podeEnviar: Bool) -> String {
        if printer.hasEphemeralProbeTarget {
            return "Uma candidata está retida somente em memória."
        }
        if podeEnviar {
            return "Sem candidata em memória: o comando sai pela impressora instalada e pronta."
        }
        if printer.coordinator.adoptedPrinters.isEmpty {
            return "Nenhuma candidata em memória e nenhuma impressora instalada. Use Configuração ou Scan de rede antes do envio."
        }
        return "A impressora instalada não está alcançável agora. Ligue ela e deixe perto do celular — na rede, na mesma Wi-Fi — ou teste uma candidata em Configuração."
    }

    private var usbNotice: some View {
        Text("USB host não existe no iOS; o comando sai pela candidata Wi-Fi ou Bluetooth LE retida em memória e, sem ela, pela impressora instalada no transporte ativo.")
            .font(.footnote)
            .foregroundColor(.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

@available(iOS 15.0, macOS 12.0, *)
@MainActor
private final class RawCommandModel: ObservableObject {
    @Published var hexText = ""
    @Published var showsConfirmation = false
    @Published private(set) var confirmation: RawCommandConfirmation?
    @Published private(set) var message: String?
    @Published private(set) var isSending = false
    @Published private(set) var failed = false

    private let controller: RawCommandController

    init(printer: ThermalPrinterConfiguration) {
        controller = RawCommandController(sender: ConfigurationRawCommandSender(printer: printer))
    }

    func prepare(hasTarget: Bool) {
        guard hasTarget else {
            failed = true
            message = "Nenhuma impressora alcançável agora: nem candidata em memória, nem instalada e pronta."
            return
        }
        do {
            confirmation = try controller.prepare(hexText)
            // O texto deixa a View assim que o buffer efêmero foi criado; ele nunca vai para disco.
            hexText = ""
            message = nil
            failed = false
            showsConfirmation = true
        } catch {
            failed = true
            message = error.localizedDescription
        }
    }

    func confirm() {
        showsConfirmation = false
        isSending = true
        controller.confirm { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                self.isSending = false
                self.confirmation = nil
                switch result {
                case .success:
                    self.failed = false
                    self.message = "Comando concluído; o mesmo buffer foi zerado após o callback."
                case .failure:
                    self.failed = true
                    self.message = "O comando não foi concluído. Nada foi repetido automaticamente."
                }
            }
        }
    }

    func cancel() {
        controller.cancel()
        confirmation = nil
        showsConfirmation = false
    }
}

private final class ConfigurationRawCommandSender: RawCommandSending {
    private weak var printer: ThermalPrinterConfiguration?

    init(printer: ThermalPrinterConfiguration) { self.printer = printer }

    func send(_ buffer: NSMutableData, completion: @escaping (Result<Void, Error>) -> Void) {
        Task { @MainActor [weak self] in
            guard let printer = self?.printer else {
                completion(.failure(ConfigurationRawCommandError.noTarget))
                return
            }
            _ = printer.sendEphemeralCommand(buffer as Data, fallingBackToAdopted: true) { result in
                switch result {
                case .success: completion(.success(()))
                case .failure: completion(.failure(ConfigurationRawCommandError.notDelivered))
                }
            }
        }
    }
}

private enum ConfigurationRawCommandError: Error {
    case noTarget
    case notDelivered
}
