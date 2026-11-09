// swift-tools-version: 5.9
// Biblioteca móvel integrada ao FAGOO. NOTICE registra origem e autorização.
import PackageDescription
let package = Package(
    name: "ThermalPrinterKit",
    platforms: [.iOS(.v15), .macOS(.v10_15)],
    products: [.library(name: "ThermalPrinterKit", targets: ["ThermalPrinterKit"]), .library(name: "Printher", targets: ["Printher"])],
    targets: [.target(name: "ThermalPrinterKit"), .target(name: "Printher", dependencies: ["ThermalPrinterKit"], path: "Printher"), .testTarget(name: "ThermalPrinterKitTests", dependencies: ["ThermalPrinterKit"])]
)