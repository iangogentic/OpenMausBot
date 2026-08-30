# OpenMaus managed Security Key proxy

This MV3 extension uses Chrome 115+'s privileged `chrome.webAuthenticationProxy` API. It does not patch `navigator.credentials`. It stays detached unless the exact native host completes a nonce-bound health handshake, and it detaches in the same JavaScript turn when that broker disappears or violates the bounded protocol.

## Managed identity

The checked-in `manifest.json` contains a public development key so unpacked and policy-installed builds have the stable development extension ID:

`iaopmdekcnajdahgiacemakfgdlihime`

That public key is an explicit placeholder for a locally controlled production signing key. Before distribution, replace it with the public key derived from the organization-owned private key, calculate the resulting Chrome extension ID, and replace the single exact origin in `native-host/com.openmausbot.security_key_proxy.json`. Never broaden `allowed_origins` and never commit the private key.

Replace the native-host manifest's `path` placeholder with the absolute path to the locally managed broker executable, then install the manifest using Chrome's documented per-platform native-messaging registry/location. The broker must use Chrome native-messaging framing: a four-byte little-endian message length followed by UTF-8 JSON. It must reject frames over 256 KiB before allocating or parsing their body.

`native-host/framing.js` provides a dependency-free incremental decoder and encoder with that pre-allocation bound. The broker can import it, feed `stdin` chunks to `NativeMessageDecoder`, and write `encodeNativeMessage(message)` bytes to `stdout`. Treat any decoder exception as terminal and do not print diagnostics to `stdout`.

The extension should be force-installed by enterprise policy. Chrome permits `webAuthenticationProxy` only on MV3 Chrome 115+ and allows only one attached proxy. A broker that is not ready does not intercept ordinary local WebAuthn.

## Native helper protocol

All messages have `protocolVersion: "1"`, exact fields, and a 256 KiB encoded ceiling. Credential request/response JSON has a separate 128 KiB ceiling. The broker must never log whole messages, WebAuthn option JSON, credential JSON, challenges, credential IDs, PINs, or attestation data.

1. Extension sends `extension.hello` with its exact extension ID and a fresh nonce.
2. Healthy broker returns `broker.ready` with that nonce, a fresh session ID, a 10-second heartbeat interval, and exactly `create`, `get`, `isUvpaa`, and `cancel` capabilities.
3. Only after `broker.ready` does the extension call `webAuthenticationProxy.attach()`.
4. `extension.request` carries create/get JSON or an `isUvpaa` request. The broker returns one matching `broker.result`, `broker.error`, or `broker.uvpaa`.
5. Chrome cancellation is forwarded as `extension.cancel`; no completion is attempted after Chrome cancels.
6. Both sides heartbeat every 10 seconds. Missing broker liveness for 30 seconds, a malformed/stale frame, native-port loss, or `broker.detach` fails outstanding ceremonies and immediately detaches the proxy.

Run the isolated contract tests with:

```sh
node --test browser-extension/security-key-proxy/test/*.test.js
```
