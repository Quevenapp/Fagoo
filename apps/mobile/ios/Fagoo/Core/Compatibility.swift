import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// The iPhone 7 runs iOS 15. Keep equivalent controls on that system while
/// using the current navigation and presentation APIs on newer devices.
struct AppNavigationStack<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        if #available(iOS 16, *) { NavigationStack { content() } }
        else { NavigationView { content() }.navigationViewStyle(.stack) }
    }
}

struct AppLabeledContent: View {
    let title: String
    let value: String
    init(_ title: String, value: String) { self.title = title; self.value = value }
    var body: some View {
        HStack { Text(title); Spacer(); Text(value).foregroundStyle(.secondary).multilineTextAlignment(.trailing) }
    }
}

struct AppShareLink<Label: View>: View {
    let item: URL
    @ViewBuilder var label: () -> Label
    @State private var showing = false
    var body: some View {
        Button { showing = true } label: { label() }
            .sheet(isPresented: $showing) { ActivitySheet(item: item) }
    }
}

private struct ActivitySheet: UIViewControllerRepresentable {
    let item: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [item], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct AppMultilineField: View {
    let placeholder: String
    @Binding var text: String
    let lines: ClosedRange<Int>
    init(_ placeholder: String, text: Binding<String>, lines: ClosedRange<Int>) {
        self.placeholder = placeholder; self._text = text; self.lines = lines
    }
    var body: some View {
        if #available(iOS 16, *) {
            TextField(placeholder, text: $text, axis: .vertical).lineLimit(lines)
        } else {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $text).frame(minHeight: CGFloat(lines.lowerBound) * 22 + 12, maxHeight: CGFloat(lines.upperBound) * 22 + 12)
                if text.isEmpty { Text(placeholder).foregroundStyle(.secondary).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
            }.accessibilityLabel(placeholder)
        }
    }
}

extension View {
    @ViewBuilder func appNavigationPicker() -> some View {
        if #available(iOS 16, *) { pickerStyle(.navigationLink) }
        else { pickerStyle(.menu) }
    }
    @ViewBuilder func appNavigationDestination<Destination: View>(isPresented: Binding<Bool>, @ViewBuilder destination: @escaping () -> Destination) -> some View {
        if #available(iOS 16, *) { navigationDestination(isPresented: isPresented, destination: destination) }
        else { background(NavigationLink(destination: destination(), isActive: isPresented) { EmptyView() }.hidden()) }
    }
    @ViewBuilder func appSheetDetents() -> some View {
        if #available(iOS 16, *) { presentationDetents([.medium, .large]) }
        else { self }
    }
    @ViewBuilder func appScrollDismissesKeyboard() -> some View {
        if #available(iOS 16, *) { scrollDismissesKeyboard(.interactively) }
        else { self }
    }
    @ViewBuilder func appDarkNavigationBar() -> some View {
        if #available(iOS 16, *) { toolbarBackground(.visible, for: .navigationBar).toolbarColorScheme(.dark, for: .navigationBar) }
        else { self }
    }
}

/// PHPicker preserves multiple photo/video selection on iOS 15 without broad
/// photo-library access. Files are loaded only after the user selects them.
struct PhotoLibraryPicker: UIViewControllerRepresentable {
    let limit: Int
    var selected: ([PHPickerResult]) -> Void
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = max(1, limit)
        configuration.filter = .any(of: [.images, .videos])
        let controller = PHPickerViewController(configuration: configuration)
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(selected) }
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let selected: ([PHPickerResult]) -> Void
        init(_ selected: @escaping ([PHPickerResult]) -> Void) { self.selected = selected }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) { selected(results) }
    }
}
