import Foundation
import AppKit
import CoreGraphics
import SpaceOKit

/// A self-contained end-to-end proof that needs no daemon.
///
/// This is the acceptance test a human can watch: it runs the full agent workflow against a real
/// app and reports both detected breaches and dimensions macOS does not safely expose. Anything
/// it prints as FAIL is a detected defect; PARTIAL means required coverage was unavailable.
enum Demo {

    static func run(appName: String, keep: Bool, capture: Bool = true, perDisplay: Int = 1) -> Never {
        Task {
            let code = await body(appName: appName, keep: keep, capture: capture, perDisplay: perDisplay)
            exit(code)
        }
        // The virtual display's descriptor is bound to the main queue; keep it turning.
        RunLoop.main.run()
        exit(2)
    }

    private static func body(appName: String, keep: Bool, capture: Bool, perDisplay: Int) async -> Int32 {
        // Results belong to this one demo invocation. Keeping them local prevents a second
        // invocation or task from sharing mutable process-wide counters.
        var passed = 0
        var failed = 0
        var partial = 0

        func check(_ label: String, _ condition: Bool, _ detail: String = "") {
            if condition {
                passed += 1
                print("  PASS  \(label)\(detail.isEmpty ? "" : "  — \(detail)")")
            } else {
                failed += 1
                print("  FAIL  \(label)\(detail.isEmpty ? "" : "  — \(detail)")")
            }
        }

        func checkIsolation(
            _ label: String,
            _ after: IsolationSnapshot,
            comparedTo before: IsolationSnapshot
        ) {
            let report = after.report(comparedTo: before)
            switch report.verdict {
            case .intact:
                check("\(label): intact", true)
            case .breached:
                check(
                    "\(label): breached",
                    false,
                    report.failures.joined(separator: "; ")
                )
            case .partial:
                partial += 1
                let unknown = report.checks
                    .filter { $0.required && $0.status == .unknown }
                    .map(\.dimension.rawValue)
                    .joined(separator: ", ")
                print(
                    "  PARTIAL  \(label) — no covered breach; "
                    + "unknown required checks: \(unknown)")
            }
        }

        print("SpaceO end-to-end demo\n")

        // ---- 0. capabilities -------------------------------------------------------------
        let capabilities = Capabilities()
        check("capabilities available", capabilities.canDrive)
        guard capabilities.canDrive else {
            print("\n" + capabilities.report)
            return 1
        }
        check("screen recording granted", capabilities.canCapture,
              capabilities.canCapture ? "" : "capture checks will be skipped")

        // Settled, so a still-quitting app from a previous run cannot poison the baseline.
        let userBefore = IsolationSnapshot.captureStable()
        print("\n  user state at start: \(userBefore)\n")

        // ---- 1. pool and tile ------------------------------------------------------------
        let pool = DisplayPool(sessionsPerDisplay: perDisplay)
        var neighbours: [AgentSession] = []
        let session: AgentSession
        do {
            session = AgentSession(id: "demo", slot: try pool.allocate())
        } catch {
            print("  FAIL  allocate a tile — \(error)")
            return 1
        }
        // One copy of session teardown, shared by the orderly path in step 9 and the defer
        // backstop that early FAIL returns land in — without it, a failed run leaves an
        // invisible TextEdit behind.
        var tornDown = false
        func destroySessions() {
            guard !tornDown else { return }
            tornDown = true
            session.destroy()
            for neighbour in neighbours { neighbour.destroy() }
        }
        defer {
            if !keep {
                destroySessions()
                pool.releaseAll()
            }
        }

        check("agent display created", session.stage.isValid,
              "display \(session.stage.displayID)")
        check("display has its own Space", session.stage.hasOwnSpace,
              "spaces \(session.stage.spaces.map(String.init).joined(separator: ","))")
        check("session got a tile", session.frame.width > 0,
              String(format: "tile %d/%d  %.0fx%.0f at (%.0f,%.0f)",
                     session.slot.index + 1, session.slot.capacity,
                     session.frame.width, session.frame.height,
                     session.frame.origin.x, session.frame.origin.y))

        // ---- 2. sharing ------------------------------------------------------------------
        // The point of tiling: more sessions must NOT mean more framebuffers.
        if perDisplay > 1 {
            let displaysBefore = pool.displayCount
            for index in 2...perDisplay {
                guard let slot = try? pool.allocate() else { break }
                neighbours.append(AgentSession(id: "demo-\(index)", slot: slot))
            }
            check("extra sessions reused the same display",
                  pool.displayCount == displaysBefore,
                  "\(pool.sessionCount) session(s) on \(pool.displayCount) display(s)")

            let allTiles = [session.frame] + neighbours.map(\.frame)
            var overlapping = false
            for i in allTiles.indices {
                for j in allTiles.indices where j > i {
                    if allTiles[i].intersects(allTiles[j]) { overlapping = true }
                }
            }
            check("tiles do not overlap", !overlapping,
                  allTiles.map { String(format: "(%.0f,%.0f %.0fx%.0f)",
                                        $0.origin.x, $0.origin.y, $0.width, $0.height) }
                          .joined(separator: " "))

            let oneMore = try? pool.allocate()
            check("a full display spills onto a new one", pool.displayCount == displaysBefore + 1,
                  "\(pool.displayCount) display(s) after over-filling")
            if let oneMore { pool.release(oneMore) }
            check("the spill display is retired when released", pool.displayCount == displaysBefore)
        }

        // ---- 3. launch -------------------------------------------------------------------
        guard let appURL = AppLauncher.resolve(appName) else {
            print("  FAIL  resolve app '\(appName)'")
            return 1
        }

        let scratch = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-demo.txt")
        try? "".write(to: scratch, atomically: true, encoding: .utf8)

        let launchBefore = IsolationSnapshot.captureStable()
        let app: LaunchedApp
        do {
            app = try await session.launch(app: appURL, opening: [scratch])
        } catch {
            print("  FAIL  launch \(appName) — \(error)")
            return 1
        }
        check("app launched", true, "\(app.name) pid \(app.pid)")
        // Settled, not instantaneous: a 200 ms flicker while an app starts is not a state
        // change, and any grab that did happen is reported separately below.
        let afterLaunch = IsolationSnapshot.captureStable()
        checkIsolation("launch isolation", afterLaunch, comparedTo: launchBefore)
        if let restored = session.lastLaunchRestoredFocus {
            print("        note: \(app.name) grabbed focus on startup; handed it back to \(restored)")
        }

        guard let window = session.primaryWindow else {
            print("  FAIL  app produced no window")
            return 1
        }
        check("window landed in this session's tile",
              WindowPlacement.isContained(window, in: session.frame),
              String(format: "window %u at (%.0f,%.0f)", window.windowID,
                     window.frame.origin.x, window.frame.origin.y))

        let windowSpaces = Set(WindowPlacement.spaces(of: window))
        let stageSpaces = Set(session.stage.spaces)
        check("window is on the agent display's Space, not the user's",
              !windowSpaces.isEmpty && windowSpaces.isSubset(of: stageSpaces),
              "window spaces \(windowSpaces.sorted()) vs display \(stageSpaces.sorted())")

        // ---- 4. drive it -----------------------------------------------------------------
        let marker = "spaceo-\(Int(Date().timeIntervalSince1970))"
        let typeBefore = IsolationSnapshot.captureStable()
        do {
            try InputRouter.prepareForInput(window)
            try InputRouter.type("SpaceO wrote this: \(marker)", to: window.pid)
        } catch {
            print("  FAIL  input — \(error)")
            return 1
        }

        var typed = ""
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            typed = AXTree.text(in: window) ?? ""
            if typed.contains(marker) { break }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        check("typed text reached the app", typed.contains(marker),
              typed.isEmpty ? "focused element had no value" : String(typed.prefix(80)))
        checkIsolation(
            "typing isolation",
            IsolationSnapshot.capture(),
            comparedTo: typeBefore
        )

        // ---- 5. accessibility addressing -------------------------------------------------
        do {
            let snapshot = try session.snapshotAX(window: window)
            check("accessibility tree is live", snapshot.actionableCount > 0,
                  "\(snapshot.actionableCount) actionable element(s)")
        } catch {
            check("accessibility tree is live", false, "\(error)")
        }

        // ---- 6. capture ------------------------------------------------------------------
        if capabilities.canCapture && capture {
            do {
                let shot = try await Capture.window(window)
                check("window screenshot is really rendered", Capture.looksRendered(shot.image),
                      String(format: "%dx%d entropy %.3f", shot.image.width, shot.image.height,
                             Capture.visualEntropy(shot.image)))
                let path = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-demo-window.png")
                try Capture.write(shot.image, to: path)
                print("        wrote \(path.path)")

                let tile = try await Capture.region(session.stage, session.frame)
                check("tile screenshot is really rendered", Capture.looksRendered(tile.image),
                      String(format: "%dx%d entropy %.3f", tile.image.width, tile.image.height,
                             Capture.visualEntropy(tile.image)))
                // Exactly one pixel per point, so a coordinate read off this image is a
                // coordinate `spaceo click` accepts. The old "1x or 2x" tolerance here was the
                // ambiguity that made vision-driven clicks land at half position.
                check("tile screenshot pixels equal click points",
                      abs(Double(tile.image.width) - Double(session.frame.width)) <= 2,
                      String(format: "%d px wide for a %.0f pt tile",
                             tile.image.width, session.frame.width))
                let tilePath = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-demo-tile.png")
                try Capture.write(tile.image, to: tilePath)
                print("        wrote \(tilePath.path)")
            } catch {
                check("capture", false, "\(error)")
            }
        }

        // ---- 7. containment --------------------------------------------------------------
        // Exercise the snapshot/restore logic without ever touching the user's real clipboard.
        // A crash between clear and restore would otherwise destroy their copied data.
        let testPasteboard = NSPasteboard(
            name: .init("spaceo.demo.\(UUID().uuidString)"))
        defer { testPasteboard.releaseGlobally() }
        testPasteboard.clearContents()
        testPasteboard.setString("user clipboard sentinel", forType: .string)
        let saved = PasteboardGuard.snapshot(from: testPasteboard)
        testPasteboard.clearContents()
        testPasteboard.setString("agent scribble", forType: .string)
        PasteboardGuard.restore(saved, to: testPasteboard)
        check("pasteboard guard restores the user's clipboard",
              testPasteboard.string(forType: .string) == "user clipboard sentinel")

        // ---- 8. audit --------------------------------------------------------------------
        let findings = session.audit()
        check("session audit is clean", findings.isEmpty, findings.joined(separator: "; "))

        // ---- 9. teardown -----------------------------------------------------------------
        if !keep {
            let displayID = session.stage.displayID
            destroySessions()
            pool.release(session.slot)
            for neighbour in neighbours {
                pool.release(neighbour.slot)
            }
            let remaining = Stage.activeDisplayIDs()
            check("agent display removed on teardown", !remaining.contains(displayID),
                  "\(remaining.count) display(s) remain: \(remaining.map(String.init).joined(separator: ","))")
            check("pool is empty", pool.displayCount == 0 && pool.sessionCount == 0)
            let settled = IsolationSnapshot.captureStable()
            checkIsolation("user-state restoration", settled, comparedTo: userBefore)
        } else {
            print("\n  --keep: session left running on display \(session.stage.displayID)")
        }

        print("\n  \(passed) passed, \(partial) partial, \(failed) failed")
        return failed == 0 ? 0 : 1
    }
}
