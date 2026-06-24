# Mobile API (/v1) — Contract

Multi-tenant, attested, HMAC-signed mobile API. Every request carries the tenant
key; data calls additionally carry a signed-request header set. This is the
contract the new app version implements.

Base URL: `https://YOUR_MANAGER_DOMAIN/api`

## Common headers

| Header | When | Value |
|---|---|---|
| `X-App-Key` | every `/v1/*` request | the app's public tenant key (baked per build) |
| `Authorization` | signed requests | `Bearer <accessToken>` |
| `X-Device-Id` | signed requests | device id |
| `X-Timestamp` | signed requests | epoch ms (±2 min skew allowed) |
| `X-Nonce` | signed requests | fresh random per request (one-time) |
| `X-Body-SHA256` | signed requests | hex SHA-256 of the exact JSON body (`{}` if empty) |
| `X-Signature` | signed requests | see signing below |

Unknown/disabled `X-App-Key` → `403`. Missing it → `400`.

## Auth handshake

### 1. `POST /v1/auth/challenge`
Body: `{ "platform": "ios"|"android", "deviceId": "...", "appVersion": "2.0.0" }`
Response: `{ "challenge": "<nonce>", "expiresIn": 300, "attestationMode": "strict" }`

### 2. `POST /v1/auth/token`
Body (iOS): `{ "platform":"ios","deviceId":"...","challenge":"<nonce>","firebaseUid":"<optional>","attestation": { "keyId":"<base64>", "attestationObject":"<base64 CBOR>" } }`
Body (Android): `{ "platform":"android","deviceId":"...","challenge":"<nonce>","firebaseUid":"<optional>","attestationToken":"<Play Integrity token>" }`

- iOS App Attest: attest with `clientDataHash = SHA256(utf8(challenge))`.
- Android Play Integrity (Classic): request token with `nonce = challenge`.
- `development` mode accepts any `attestationToken` ≥ 12 chars (local testing only).

Response: `{ "accessToken","refreshToken","sessionSecret","tokenType":"NPanel-HMAC-SHA256","expiresIn":900,"refreshExpiresIn":2592000 }`
Store `sessionSecret` + `refreshToken` in the secure enclave/keystore.

### 3. `POST /v1/auth/refresh`
Body: `{ "deviceId":"...","refreshToken":"..." }` → same shape as token (rotates all three; old refresh single-use).

## Signing (every data request)

```
stringToSign = METHOD + "\n" + PATH(no query) + "\n" + X-Timestamp + "\n" + X-Nonce + "\n" + X-Body-SHA256
X-Signature  = HMAC_SHA256( key = SHA256(sessionSecret), stringToSign )   // hex
X-Body-SHA256 = SHA256( JSON.stringify(body ?? {}) )                       // hex
```

## Data endpoints (signed)

### `GET /v1/configs[?type=free|premium]`
Returns only configs exposed to this tenant.
```json
{ "configs": [ {
  "id": 12, "displayName": "Argentina Free", "type": "free", "sortOrder": 0,
  "country": { "name": "Argentina", "code": "AR", "flag": "https://flagcdn.com/w80/ar.png" },
  "connection": {
    "uri": "trojan://<pw>@aris1.tempmail.monster:443?security=tls&type=ws&path=%2Ffetch#FREE1",
    "host": "130.94.106.181",
    "port": 443, "sni": "aris1.tempmail.monster", "transport": "ws", "path": "/fetch"
  }
} ] }
```
- **iOS**: connect with `config = connection.uri`, `ip = connection.host` (entry IP, differs from sni).
- **Android**: parse `connection.uri` directly.

### `GET /v1/countries`
`{ "countries": [ { "name":"Argentina","code":"AR","flag":"https://flagcdn.com/w80/ar.png" } ] }`
(only countries with an active config exposed to this app).

## Connection logging (signed)

### `POST /v1/sessions/start`
Body: `{ "configId": 12, "platform":"ios", "appVersion":"2.0.0", "firebaseUid":"<optional>" }`
Response: `{ "logId":"<opaque>", "startedAt":"<iso>" }`
Server records the real client IP (CF-Connecting-IP), entry IP, device, firebase_uid.

### `POST /v1/sessions/stop`
Body: `{ "logId":"<opaque>" }` → `{ "ok":true, "durationSeconds": 3540 }` (server-computed, idempotent).

## Notes
- Premium gating is client-side (RevenueCat); backend returns all exposed configs tagged free/premium.
- Rate limit: 90 req/min per (real IP + device). In-memory — single instance until moved to Redis.
- Admin assigns which configs/countries each app exposes (`POST /apps/:id/catalog`).
