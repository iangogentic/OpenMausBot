import XCTest
@testable import CompanionCore

private actor DeferredLeaseGate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func open() {
        opened = true
        let pending = waiters
        waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }
}

private actor CloudDesktopLeaseSlot {
    private(set) var current: CloudDesktopLeaseIdentity?

    init(_ current: CloudDesktopLeaseIdentity?) {
        self.current = current
    }

    func replace(with successor: CloudDesktopLeaseIdentity) {
        current = successor
    }

    func clear(ifCurrent expected: CloudDesktopLeaseIdentity) -> Bool {
        guard cloudDesktopLeaseIsCurrent(current, expected: expected) else { return false }
        current = nil
        return true
    }
}

final class CloudDesktopLeaseTests: XCTestCase {
    func testRetryDoesNotExtendViewerBeyondSafetyDeadline() {
        var watchdog = CloudDesktopLeaseWatchdog(proofUptimeMs: 1_000, serverLeaseTtlMs: 15_000)
        XCTAssertFalse(watchdog.isExpired(nowUptimeMs: 10_999))
        XCTAssertTrue(watchdog.isExpired(nowUptimeMs: 11_000))

        // Retry outcomes never call renew, so they cannot move the deadline.
        XCTAssertTrue(watchdog.isExpired(nowUptimeMs: 20_000))
        watchdog.renew(proofUptimeMs: 20_000, serverLeaseTtlMs: 15_000)
        XCTAssertFalse(watchdog.isExpired(nowUptimeMs: 29_999))
        XCTAssertTrue(watchdog.isExpired(nowUptimeMs: 30_000))
    }

    func testServerCannotInflatePhoneViewerSafetyWindow() {
        let watchdog = CloudDesktopLeaseWatchdog(proofUptimeMs: 0, serverLeaseTtlMs: 600_000)
        XCTAssertEqual(watchdog.safetyWindowMs, 10_000)
    }

    func testDelayedFalseEventForL1CannotClearInstalledL2() async {
        let oldLease = CloudDesktopLeaseIdentity(ownerId: "phone-owner", leaseToken: "lease-L1")
        let successor = CloudDesktopLeaseIdentity(ownerId: "phone-owner", leaseToken: "lease-L2")
        let slot = CloudDesktopLeaseSlot(oldLease)
        let gate = DeferredLeaseGate()

        let delayedFalseContinuation = Task {
            await gate.wait()
            return await slot.clear(ifCurrent: oldLease)
        }

        await slot.replace(with: successor)
        await gate.open()

        let staleLeaseWasCleared = await delayedFalseContinuation.value
        let current = await slot.current
        XCTAssertFalse(staleLeaseWasCleared)
        XCTAssertEqual(current, successor)
    }

    func testExactLeaseCanStillBeCleared() async {
        let lease = CloudDesktopLeaseIdentity(ownerId: "phone-owner", leaseToken: "lease-L1")
        let slot = CloudDesktopLeaseSlot(lease)

        let cleared = await slot.clear(ifCurrent: lease)
        let current = await slot.current
        XCTAssertTrue(cleared)
        XCTAssertNil(current)
    }
}
