import Foundation
import XCTest
@testable import CompanionCore

private final class CloudDesktopRequestStub: URLProtocol {
    static var responses: [(Int, Data)] = []
    static var requests: [URLRequest] = []
    static var requestBodies: [Data?] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        Self.requestBodies.append(Self.readBody(from: request))
        let next = Self.responses.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: next.0,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: next.1)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class CloudDesktopClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        CloudDesktopRequestStub.responses = []
        CloudDesktopRequestStub.requests = []
        CloudDesktopRequestStub.requestBodies = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CloudDesktopRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Test", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testTakeJoinHeartbeatAndReleaseCarryTheExactLease() async throws {
        CloudDesktopRequestStub.responses = [
            (200, Data(#"{"held":true,"helpReason":null,"leaseExpiresAtMs":1234,"leaseToken":"lease_exact"}"#.utf8)),
            (200, Data(#"{"joinUrl":"https://desktop.ascii.dev/session/fresh"}"#.utf8)),
            (200, Data(#"{"held":true,"helpReason":null,"leaseExpiresAtMs":5678}"#.utf8)),
            (200, Data(#"{"held":false,"helpReason":null,"leaseExpiresAtMs":null}"#.utf8)),
        ]

        let owner = "phone-12345678"
        let control = try await client.takeCloudDesktopControl(botId: "bot-1", ownerId: owner)
        let token = try XCTUnwrap(control.leaseToken)
        _ = try await client.cloudDesktop(botId: "bot-1", ownerId: owner, leaseToken: token)
        _ = try await client.heartbeatCloudDesktopControl(botId: "bot-1", ownerId: owner, leaseToken: token)
        try await client.releaseCloudDesktopControl(botId: "bot-1", ownerId: owner, leaseToken: token)

        XCTAssertEqual(CloudDesktopRequestStub.requests.map { $0.url?.path }, [
            "/api/bots/bot-1/computer/control",
            "/api/bots/bot-1/computer/join",
            "/api/bots/bot-1/computer/control",
            "/api/bots/bot-1/computer/control",
        ])
        let bodies = try CloudDesktopRequestStub.requestBodies.map { body -> [String: String] in
            let data = try XCTUnwrap(body)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        }
        XCTAssertEqual(bodies[0], ["action": "take", "ownerId": owner, "surface": "cloud"])
        XCTAssertEqual(bodies[1], ["ownerId": owner, "leaseToken": token])
        XCTAssertEqual(bodies[2], ["action": "heartbeat", "ownerId": owner, "leaseToken": token])
        XCTAssertEqual(bodies[3], ["action": "release", "ownerId": owner, "leaseToken": token])
    }

    func testTakeFailsClosedWhenNoLeaseProofIsReturned() async {
        CloudDesktopRequestStub.responses = [
            (200, Data(#"{"held":true,"helpReason":null}"#.utf8)),
        ]
        do {
            _ = try await client.takeCloudDesktopControl(botId: "bot-1", ownerId: "phone-12345678")
            XCTFail("expected missing lease proof to fail")
        } catch APIError.transport {
            // Expected.
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testLocalVMTakeAndJoinUseTheNarrowSurfaceAndViewerRoute() async throws {
        let generation = String(repeating: "g", count: 16)
        let viewerToken = String(repeating: "t", count: 43)
        let prefix = "/api/bots/bot-1/phone-local-computer/viewer/\(generation)/\(viewerToken)"
        let joinURL = "\(prefix)/vnc.html#autoconnect=true&resize=scale&password=pw&path=\(prefix.dropFirst())/websockify"
        CloudDesktopRequestStub.responses = [
            (200, Data(#"{"held":true,"leaseToken":"lease_vm","leaseTtlMs":15000}"#.utf8)),
            (200, try JSONSerialization.data(withJSONObject: [
                "joinUrl": joinURL,
                "viewerKind": "local-vm",
            ])),
        ]

        let control = try await client.takeCloudDesktopControl(
            botId: "bot-1",
            ownerId: "phone-owner",
            surface: "vm"
        )
        _ = try await client.cloudDesktop(
            botId: "bot-1",
            ownerId: "phone-owner",
            leaseToken: try XCTUnwrap(control.leaseToken),
            surface: "vm"
        )

        XCTAssertEqual(CloudDesktopRequestStub.requests.map { $0.url?.path }, [
            "/api/bots/bot-1/computer/control",
            "/api/bots/bot-1/local-computer/join",
        ])
        let take = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try XCTUnwrap(CloudDesktopRequestStub.requestBodies[0]))
                as? [String: String]
        )
        XCTAssertEqual(take["surface"], "vm")
    }
}
