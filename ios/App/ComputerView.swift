// A bot's computer, live.
//
// The harness already screenshots a working bot every few seconds and pushes
// the frame to any client that asked for it. Preview stays cheap; an explicitly
// enabled phone can also take the same short, exclusive control lease as the
// desktop app and open the provider's interactive viewer.
//
// Frames are expensive (hundreds of kilobytes of base64 each), so they are
// off unless this view is on screen. `watchScreen` reopens the stream asking
// for them and `stopWatchingScreen` reopens it asking not to; both resume
// from the cursor, so the reconnect costs nothing but a round trip.
import SwiftUI
import CompanionCore
// Unconditional for the same reason as ChatView: `UIImage` is used below
// without a guard, so a conditional import would only change which error a
// non-UIKit build fails with.
import UIKit

struct ComputerView: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmingDesktop = false
    @State private var openingDesktop = false
    @State private var desktopURL: URL?
    @State private var desktopAccess: Session.CloudDesktopAccess?
    @State private var desktopError: String?
    @State private var heartbeatTask: Task<Void, Never>?
    @State private var viewActive = false
    @State private var desktopOwnerId = "phone-\(UUID().uuidString)"

    private var frame: ScreenFrame? { session.state.screens[bot.id] }

    /// The bot as the stream last described it — `busy` is what tells us
    /// whether more frames are coming or this is the last one.
    private var current: Bot { session.state.bot(bot.id) ?? bot }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let image = frame.flatMap(\.data).flatMap(UIImage.init(data:)) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    // The desktop is wider than the phone, so it lands as a
                    // letterbox. Pinch-to-zoom would be the obvious next
                    // thing; scaledToFit is the honest starting point.
                    .accessibilityLabel("\(current.name)'s computer")
            } else {
                waiting
            }
        }
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // Busy is the difference between "the picture is a moment old"
                // and "the picture is however it was left" — worth saying,
                // because a still frame looks identical either way.
                Text(current.busy == true ? "Preview" : "Idle")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(current.busy == true ? Color.green : Color.secondary)
            }
        }
        .safeAreaInset(edge: .bottom) {
            // A VPS-backed bot is "cloud" too, but the server refuses to mint
            // an interactive desktop for it — no button beats a dead one. An
            // older harness never sends cloudBackend, so nil keeps the button.
            if current.computer == "vm" || (current.computer == "cloud" && current.cloudBackend != "vps") {
                VStack(spacing: 8) {
                    if let desktopError {
                        Text(desktopError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }
                    Button {
                        confirmingDesktop = true
                    } label: {
                        if openingDesktop {
                            ProgressView()
                                .tint(.white)
                                .frame(maxWidth: .infinity)
                        } else {
                            Label(
                                current.computer == "vm" ? "Open live Local VM" : "Open live cloud desktop",
                                systemImage: "display"
                            )
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(openingDesktop)
                    Text("Interactive desktop session. Closing hands control back and closes this app-owned stream.")
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial)
            }
        }
        .alert(current.computer == "vm" ? "Open live Local VM?" : "Open live cloud desktop?", isPresented: $confirmingDesktop) {
            Button("Cancel", role: .cancel) {}
            Button("Open desktop") { Task { await openDesktop() } }
        } message: {
            Text(
                current.computer == "vm"
                    ? "This gives this phone full control of this bot's Local VM on your OpenMaus server. The viewer is tied to this phone, bot, VM generation, and short control lease."
                    : "This gives this phone full control of the cloud computer, including anything signed in inside it. A provider link intentionally copied elsewhere can remain valid until ascii.dev expires it, normally within 10 minutes."
            )
        }
        .sheet(
            isPresented: Binding(
                get: { desktopURL != nil },
                set: { if !$0 { desktopURL = nil } }
            ),
            onDismiss: { Task { await closeDesktop() } }
        ) {
            if let desktopURL {
                NavigationStack {
                    CloudDesktopBrowser(url: desktopURL)
                        .ignoresSafeArea(edges: .bottom)
                        .navigationTitle(current.computer == "vm" ? "Live Local VM" : "Live cloud desktop")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { self.desktopURL = nil }
                            }
                        }
                }
            }
        }
        .onAppear {
            viewActive = true
            session.watchScreen(of: bot.id)
        }
        .onDisappear {
            viewActive = false
            session.stopWatchingScreen(of: bot.id)
            Task { await closeDesktop() }
        }
        .onChange(of: scenePhase) { _, phase in
            // iOS may suspend networking immediately in the background. Close
            // and release while there is still execution time instead of
            // retaining an interactive browser with no heartbeat.
            if phase != .active { Task { await closeDesktop() } }
        }
        .onChange(of: session.state.computerControl[current.id]?.held) { _, held in
            guard held == false, let expectedAccess = desktopAccess else { return }
            // Stream events carry no lease token and can cross a later L2 take
            // response. Validate the exact current proof before closing it.
            Task { await reconcileReportedLeaseLoss(expectedAccess) }
        }
        .onChange(of: session.status) { _, status in
            guard status != .live, desktopAccess != nil else { return }
            desktopError = "Phone control ended because the computer connection closed."
            Task { await closeDesktop() }
        }
    }

    private var waiting: some View {
        VStack(spacing: 12) {
            ProgressView().tint(.white)
            Text(current.busy == true ? "Waiting for a frame…" : "Nothing to show yet")
                .font(.system(size: 15))
                .foregroundStyle(Color.white.opacity(0.7))
            // An idle bot is not being screenshotted at all, so this would
            // otherwise be an indefinite spinner with no explanation.
            if current.busy != true {
                Text("This bot's computer is only captured while it is working.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.white.opacity(0.45))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
        }
    }

    @MainActor
    private func openDesktop() async {
        openingDesktop = true
        desktopError = nil
        defer { openingDesktop = false }
        do {
            let access = try await session.cloudDesktop(for: current, ownerId: desktopOwnerId)
            guard viewActive, scenePhase == .active else {
                await session.releaseCloudDesktop(
                    botId: current.id,
                    ownerId: access.ownerId,
                    leaseToken: access.leaseToken
                )
                return
            }
            desktopAccess = access
            desktopURL = access.url
            startHeartbeat(access)
        } catch {
            desktopError = error.localizedDescription
        }
    }

    @MainActor
    private func startHeartbeat(_ access: Session.CloudDesktopAccess) {
        heartbeatTask?.cancel()
        heartbeatTask = Task {
            func uptimeMs() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000_000 }
            var watchdog = CloudDesktopLeaseWatchdog(
                proofUptimeMs: uptimeMs(),
                serverLeaseTtlMs: access.leaseTtlMs
            )
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if Task.isCancelled { return }
                guard desktopAccess?.leaseToken == access.leaseToken else { return }
                if watchdog.isExpired(nowUptimeMs: uptimeMs()) {
                    await closeDesktop(
                        expectedAccess: access,
                        failureMessage: "Phone control ended because its safety heartbeat expired."
                    )
                    return
                }
                let probe = await session.probeCloudDesktopLease(
                    botId: current.id,
                    ownerId: access.ownerId,
                    leaseToken: access.leaseToken
                )
                guard cloudDesktopLeaseIsCurrent(
                    desktopAccess?.leaseIdentity,
                    expected: access.leaseIdentity
                ) else { return }
                switch probe {
                case let .held(leaseTtlMs):
                    watchdog.renew(
                        proofUptimeMs: uptimeMs(),
                        serverLeaseTtlMs: leaseTtlMs ?? access.leaseTtlMs
                    )
                    continue
                case .retry:
                    if watchdog.isExpired(nowUptimeMs: uptimeMs()) {
                        await closeDesktop(
                            expectedAccess: access,
                            failureMessage: "Phone control ended because the server could not renew it safely."
                        )
                        return
                    }
                    continue
                case let .invalid(message):
                    await closeDesktop(
                        expectedAccess: access,
                        failureMessage: "Phone control ended: \(message)"
                    )
                    return
                }
            }
        }
    }

    @MainActor
    private func reconcileReportedLeaseLoss(_ expectedAccess: Session.CloudDesktopAccess) async {
        let probe = await session.probeCloudDesktopLease(
            botId: current.id,
            ownerId: expectedAccess.ownerId,
            leaseToken: expectedAccess.leaseToken
        )
        guard cloudDesktopLeaseIsCurrent(
            desktopAccess?.leaseIdentity,
            expected: expectedAccess.leaseIdentity
        ) else { return }
        if case let .invalid(message) = probe {
            await closeDesktop(
                expectedAccess: expectedAccess,
                failureMessage: "Phone control was handed back or revoked: \(message)"
            )
        }
    }

    @MainActor
    private func closeDesktop(
        expectedAccess: Session.CloudDesktopAccess? = nil,
        failureMessage: String? = nil
    ) async {
        // A heartbeat for L1 can finish after this view has already released
        // L1 and opened L2. Check before touching any current UI/task state;
        // stale L1 must not cancel, close, or release its successor.
        if let expectedAccess {
            guard cloudDesktopLeaseIsCurrent(
                desktopAccess?.leaseIdentity,
                expected: expectedAccess.leaseIdentity
            ) else { return }
        }
        if let failureMessage { desktopError = failureMessage }
        heartbeatTask?.cancel()
        heartbeatTask = nil
        desktopURL = nil
        guard let access = desktopAccess else { return }
        // Clear first: sheet dismissal, scene changes, and view teardown can
        // arrive together. Only the first caller owns the release request.
        desktopAccess = nil
        await session.releaseCloudDesktop(
            botId: current.id,
            ownerId: access.ownerId,
            leaseToken: access.leaseToken
        )
    }
}
