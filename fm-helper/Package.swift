// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "claude-bridge-fm",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(name: "claude-bridge-fm", path: "Sources/claude-bridge-fm")
    ]
)
