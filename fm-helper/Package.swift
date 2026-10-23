// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "tabwright-fm",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(name: "tabwright-fm", path: "Sources/tabwright-fm")
    ]
)
