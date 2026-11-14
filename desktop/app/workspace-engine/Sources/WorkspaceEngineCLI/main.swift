// workspace-engine: Hive's virtual workspace engine (see CLI.swift for its commands).
import Foundation
import WorkspaceEngine

exit(CLI.main(Array(CommandLine.arguments.dropFirst())))
