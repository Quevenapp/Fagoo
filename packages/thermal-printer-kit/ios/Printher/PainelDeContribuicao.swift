import SwiftUI
import ThermalPrinterKit

#if os(iOS)
import UIKit
#endif

/**
 O gesto, na tela: um botão e as três coisas que a pessoa precisa saber antes de tocar nele.

 **Ele só existe para quem tem perfil exportável.** A decisão não é um `if` desta `View`: é
 ``ExportacaoDeContribuicao/preparar(perfil:versaoDoSistema:versaoDoApp:)``, que devolve
 ``PreparoDaContribuicao/naoOferecido(_:)`` e faz o painel inteiro não desenhar nada.

 ## Por que o gesto mora no módulo, e não no slot do hospedeiro

 ``PrinterProfileActionsSlot`` existe e é o ponto neutro para o app hospedeiro acrescentar ações a
 um perfil medido. O gesto **não** foi para lá, por três razões medidas:

 1. **O slot está vazio em produção.** Nenhum hospedeiro injeta ação nenhuma hoje, e o repositório
    do app publicado não é editável por este lote. Pôr o gesto no slot deixaria o buraco exatamente
    do tamanho em que ele está — e fechá-lo é a razão de este arquivo existir.
 2. **O slot é para o que é exclusivo de um app.** É o que a prova dele diz, com todas as letras:
    o engine não escolhe ação por conta própria "assim QRFesta e Vinki recebem o mesmo fluxo de
    configuração sem ganhar recursos exclusivos de outro app". Contribuir é o oposto disso: o
    leitor do outro lado é o mesmo Printher de mesa para todo hospedeiro. Pelo próprio critério do
    slot, este gesto não é dele.
 3. **O slot recebe só o perfil.** Não recebe tema nem as versões do aparelho. Cada hospedeiro
    teria de remontar o pacote e reescrever estas frases — dois hospedeiros, duas versões do que
    "não vai junto", e a que envelhecesse mandaria um pacote cuja recusa ninguém sabe nomear.

 O Android decidiu igual, e a assimetria de plataforma não muda a resposta: lá não há slot neutro
 no meio do caminho, aqui há, e mesmo assim o argumento que decide é o mesmo — quem sabe montar o
 pacote é quem sabe o que a medição mediu.

 O painel fica **logo antes** do slot na tela final, na mesma ordem do Android: a ação do kit vem
 primeiro, a do hospedeiro depois, e o botão que encerra por último.

 ## As três frases, e por que elas são estas

 1. **O que sai** — a medição, não a impressora.
 2. **O que não sai** — endereço nenhum. É a garantia que faz a contribuição ser aceitável, e ela
    tem prova em `ContribuicaoSemEnderecoSurfaceTests`, não a palavra desta frase.
 3. **O que não vai junto** — a lista, dita para quem manda. Ver
    ``PacoteDeContribuicao/frasesDoQueNaoVaiJunto``.

 Nenhuma frase nomeia o aparelho de destino. O módulo não sabe — e não pode saber — se do outro
 lado há um computador, outro celular ou nada; é a mesma regra que ``PrinterHomologationLocalOnlyCopy``
 já sustenta para as frases de permanência.
 */
@available(iOS 15.0, macOS 12.0, *)
struct ContribuicaoDaMedicaoPanel: View {
    let perfil: MeasuredProfile
    let theme: ThermalPrinterTheme
    var versoes: VersoesDoAparelho = .doAparelho

    @State private var alvo: ArquivoParaExportar?
    @State private var falhouAoPreparar = false

    var body: some View {
        if case let .pronto(pacote) = ExportacaoDeContribuicao.preparar(
            perfil: perfil,
            versaoDoSistema: versoes.sistema,
            versaoDoApp: versoes.app
        ) {
            conteudo(pacote)
        }
    }

    @ViewBuilder
    private func conteudo(_ pacote: PacoteDeContribuicao) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ContribuicaoUIContract.titulo)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(theme.text)
            Text(ContribuicaoUIContract.corpo)
                .font(.footnote)
                .foregroundColor(theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            // Aqui havia o aviso do nome dobrado, e ele saiu junto com a dobra em 30/08/2026: o
            // nome vai no pacote como a pessoa o escreveu, então não há nada a avisar. Um aviso
            // sobre uma dobra que não acontece mais seria ruído, e ruído é o que faz a pessoa
            // parar de ler a lista logo abaixo — essa, sim, ainda tem o que dizer.
            Text(ContribuicaoUIContract.avisoDoQueNaoVaiJunto)
                .font(.footnote)
                .foregroundColor(theme.secondaryText)
            ForEach(pacote.frasesDoQueNaoVaiJunto, id: \.self) { frase in
                Text("• \(frase)")
                    .font(.footnote)
                    .foregroundColor(theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if falhouAoPreparar {
                Text(ContribuicaoUIContract.falhaAoPreparar)
                    .font(.footnote)
                    .foregroundColor(theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("printerSetup.contribution.failure")
            }
            Button(ContribuicaoUIContract.rotuloDoBotao) { exportar(pacote) }
                .buttonStyle(.bordered)
                .tint(theme.primary)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("printerSetup.contribution.save")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(theme.primarySurface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityIdentifier("printerSetup.contribution")
        .sheet(item: $alvo) { alvo in
            seletor(alvo)
        }
    }

    private func exportar(_ pacote: PacoteDeContribuicao) {
        do {
            alvo = ArquivoParaExportar(url: try ExportacaoDeContribuicao.arquivoTemporario(para: pacote))
            falhouAoPreparar = false
        } catch {
            // Não dá para gravar no temporário: o disco está cheio, ou o app está em estado que
            // não permite escrever. Não é motivo para derrubar a tela de quem acabou de homologar
            // — o perfil já está salvo, e o pacote se refaz com outro toque.
            falhouAoPreparar = true
        }
    }

    @ViewBuilder
    private func seletor(_ alvo: ArquivoParaExportar) -> some View {
        #if os(iOS)
        SeletorDeExportacao(arquivo: alvo.url) { self.alvo = nil }
        #else
        // O alvo macOS deste módulo existe só para a suíte lógica rodar em `swift test`; não há
        // hospedeiro de Mac que apresente esta tela.
        EmptyView()
        #endif
    }
}

/// O arquivo já gravado, esperando o diálogo. `Identifiable` porque é assim que `sheet(item:)`
/// distingue uma apresentação da seguinte.
private struct ArquivoParaExportar: Identifiable {
    let id = UUID()
    let url: URL
}

/**
 As frases do gesto, em constantes.

 Elas viram constante para poder ser fixadas por prova: SwiftUI em SwiftPM não renderiza para ser
 lido, e um literal solto dentro de um `body` não é alcançável por teste nenhum. É o mesmo motivo —
 e o mesmo molde — de ``PrinterHomologationUIContract``.
 */
enum ContribuicaoUIContract {
    /// "Medição" e não "impressora": o que sai é o que o papel mostrou. E "outro aparelho" e não
    /// "computador", porque quem sabe o que existe do outro lado não é este módulo.
    static let titulo = "Levar esta medição para outro aparelho"

    static let corpo =
        "Sai um arquivo com o que o papel mostrou: largura, colunas, acento, corte e avanço. " +
        "Não sai o endereço desta impressora, nem o cadastro deste aparelho."

    static let avisoDoQueNaoVaiJunto = "O que ninguém mediu, e por isso não vai junto:"

    static let rotuloDoBotao = "Salvar o arquivo da medição"

    /// O que a pessoa lê quando nem o arquivo temporário deu para gravar. Diz o que fazer, e não
    /// o que aconteceu por dentro.
    static let falhaAoPreparar = "Não deu para preparar o arquivo agora. Tente de novo."
}

#if os(iOS)
/**
 O diálogo do sistema — **ponto de injeção, porque diálogo de sistema não se prova nesta bancada.**

 ## Por que o seletor de exportação, e não a folha de compartilhamento

 Duas medições decidiram isto, e nenhuma é gosto:

 1. **O destino lê um arquivo do disco.** `ImportacaoDeContribuicao`, do lado de mesa, recebe um
    `Path` de um seletor de arquivo. O que precisa chegar lá é um arquivo com nome, e o seletor de
    exportação grava exatamente o `lastPathComponent` que recebeu — nome e extensão inclusos, sem
    depender de o tipo próprio estar registrado no aparelho de destino. É a contraparte exata do
    `ACTION_CREATE_DOCUMENT` que o Android escolheu, pela mesma razão.
 2. **A folha de compartilhamento entrega a quem quiser.** Mail, Mensagens e Notas aceitam o
    conteúdo sem o nome, e algumas atividades trocam a extensão pela do tipo que elas conhecem. Um
    pacote que chega como anexo sem extensão é um pacote que o leitor de mesa não abre.

 ## O que aqui não é medido

 Se todos os provedores de arquivo de terceiros preservam a extensão de um tipo próprio que eles
 não conhecem — **não foi medido**: exige aparelho e conta de nuvem, e este lote não encostou em
 aparelho. O que se garante daqui é que o arquivo entregue ao diálogo já tem o nome completo, e isso
 tem prova em ``ExportacaoDeContribuicao/arquivoTemporario(para:)``.

 Este tipo **não é compilado pela suíte de `swift test`**, que roda em macOS: ele está inteiro
 dentro de `#if os(iOS)`. Nada aqui é provado, e nada aqui decide.
 */
@available(iOS 15.0, *)
private struct SeletorDeExportacao: UIViewControllerRepresentable {
    let arquivo: URL
    let aoFechar: () -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let controlador = UIDocumentPickerViewController(forExporting: [arquivo], asCopy: true)
        controlador.delegate = context.coordinator
        return controlador
    }

    func updateUIViewController(_ controlador: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(aoFechar: aoFechar) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        private let aoFechar: () -> Void

        init(aoFechar: @escaping () -> Void) { self.aoFechar = aoFechar }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            aoFechar()
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            // Desistir de gravar não é erro: o perfil já está salvo, e o pacote se refaz com outro
            // toque.
            aoFechar()
        }
    }
}
#endif
