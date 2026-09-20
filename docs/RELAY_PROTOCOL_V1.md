# Masinloc Emergency Relay Protocol v1

Status: engineering foundation. Not yet a claim of live phone-to-phone delivery.

## Objective

Allow a Masinloc emergency report to survive loss of internet/data service and, when the native mobile app supports it, move through nearby participating devices until one device can deliver it to the existing emergency-response backend.

The resident-facing safety rule does not change:

- **Saved Offline** means the report exists only on a device or relay queue.
- **Relayed** means another participating device may be carrying the encrypted packet.
- **Received** means the emergency-response server has accepted the report.
- **Acknowledged** means an authorized responder/operator has seen it.

Only the backend may establish **Received**. No peer device is allowed to upgrade an incident to received.

## Architecture

1. The existing PWA creates and stores the report in IndexedDB.
2. Normal HTTPS delivery remains the first choice whenever usable connectivity exists.
3. If a trusted native relay transport is available, `emergency/relay.js` offers the report to the native layer.
4. The native layer encrypts the payload before persistent relay storage or radio transmission.
5. Nearby participating devices may carry the opaque encrypted packet subject to TTL, hop limit, deduplication, storage quotas, and abuse controls.
6. A device that regains backend connectivity uploads the packet to the emergency-response intake.
7. Server receipt is returned through the normal backend status path. Peer receipt alone is not authoritative.

## v1 envelope

```json
{
  "protocol_version": "masinloc-relay/1",
  "packet_id": "uuid",
  "kind": "emergency_report",
  "created_at": "ISO-8601",
  "expires_at": "ISO-8601",
  "hop_limit": 8,
  "client_report_id": "uuid",
  "destination": {
    "service": "masinloc-emergency-response",
    "agency": "pnp|mdrrmo"
  },
  "payload": "sensitive report object handed only to the local trusted native bridge"
}
```

The JavaScript bridge hands the native shell a plaintext in-process object because the PWA is the source of the report. The native shell MUST encrypt it before it is written to the native relay queue or transmitted to peers.

## Mandatory native security properties

A production relay transport must satisfy all of these before it can be enabled:

- End-to-end encryption to a backend-controlled emergency intake key. Intermediate relay phones must not be able to read incident text, identity, contact details, or location.
- Authenticated encryption. Modified packets must be rejected.
- Backend-signed delivery receipts before a local report can be considered server-received.
- Packet deduplication by `packet_id` and `client_report_id`.
- TTL enforcement and hop-count enforcement.
- Strict packet-size limits.
- No peer enumeration of a resident's report history.
- No unencrypted logs containing report payloads, report secrets, phone numbers, or coordinates.
- Rate limiting and abuse resistance so the relay cannot be used as a general anonymous broadcast network.
- Battery-aware discovery and forwarding.
- Immediate purge of native relay copies after authoritative delivery or expiry, subject to incident/audit retention rules on the backend.
- Version negotiation. Unknown protocol versions must fail closed.
- A remote kill switch so relay transport can be disabled without disabling ordinary emergency reporting.

## Native bridge contract

Android host:

```text
window.MasinlocRelayNative.enqueuePacket(jsonString)
window.MasinlocRelayNative.markDelivered(clientReportId)
```

iOS WKWebView host:

```text
window.webkit.messageHandlers.masinlocRelay.postMessage({
  action: "enqueue",
  packet: envelope
})
```

Delivery cleanup:

```text
window.webkit.messageHandlers.masinlocRelay.postMessage({
  action: "delivered",
  client_report_id: "..."
})
```

The host may reject a packet. A rejected or unavailable relay leaves the existing IndexedDB offline queue untouched.

## Transport roadmap

The native app should expose a common `RelayTransport` interface so individual transports can be added without changing emergency-report semantics.

Initial adapters:

- nearby-device discovery
- encrypted peer-to-peer transfer
- store-and-forward queue
- internet/backend uplink when any carrier/Wi-Fi path becomes available

A telco-sponsored or zero-rated uplink can later become another adapter. It is not required for the first native mesh prototype.

## Failure behavior

The system must fail toward truth, not reassurance.

If no native relay exists, the UI remains **Saved Offline · Not Yet Received**.

If a native relay accepts the packet, the UI may say that a relay copy is queued, but must still say **Not Yet Received**.

If peers disappear, radios are disabled, the battery dies, or no device ever reaches the backend, the report may never arrive. The app must continue to show that uncertainty.

## Test gates before production

1. Unit tests for envelope validation, TTL, hop count, deduplication, and purge.
2. Adversarial tests for replay, packet mutation, malicious peers, queue flooding, forged receipts, and stale packet resurrection.
3. Two-device offline transfer test.
4. Three-plus-device store-and-forward test.
5. Loss-of-power and app-restart recovery.
6. Backend idempotency test with duplicate uploads from multiple relays.
7. Privacy inspection proving peers cannot read payloads.
8. Field test in low-connectivity Masinloc scenarios.
9. Human-factors test verifying residents understand the difference between queued, relayed, received, and acknowledged.

Until those gates pass, the feature is engineering-preview only.
