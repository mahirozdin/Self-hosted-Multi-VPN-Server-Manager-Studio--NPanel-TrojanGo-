# VPN Backend Migration — Go-Live Guide

What was built (Faz 0–6, all backend-verified) and the manual steps to ship it.
The legacy Laravel backend stays untouched for old app versions; this guide
brings up the NEW backend + NEW app version.

## 1. Backend deploy (MySQL)

1. Create a MySQL 8 database (utf8mb4).
2. Fill `.env` (see `.env.example`):
   - `DB_DIALECT=mysql`, `DB_HOST/PORT/USER/PASSWORD/NAME`
   - `DB_ENCRYPTION_KEY` = `openssl rand -hex 32` — **back this up; losing it makes server/admin/user passwords unrecoverable.**
   - `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`
   - `TRUST_PROXY_HOPS` = hops in front of Node (Cloudflare→Node = 1, Cloudflare→nginx→Node = 2). Never `true`.
   - `MOBILE_ATTESTATION_MODE=development` for first bring-up; flip to `strict` after attestation is wired (step 4).
3. `npm install` → `npm run migrate` (creates all tables; idempotent) → `npm start`.
   - On boot, pending migrations auto-run. `npm run migrate:status` lists pending.
4. Put it behind Cloudflare. For trustworthy court-order IPs, restrict the origin
   firewall to Cloudflare IP ranges so `CF-Connecting-IP` can't be spoofed.

## 2. Admin panel: create the app + catalog

1. Open the panel, log in (`ADMIN_PASSWORD`).
2. **Apps** → create an app (name, slug, iOS bundle id, Apple Team ID, Android package).
   Copy the shown **X-App-Key** and **HMAC secret** (secret shown once).
3. Add servers (existing **Add** / **Install** flow). Each server must carry the real
   **IP** and **domain** — the IP becomes the iOS entry IP, the domain the SNI.
4. Sync default users (or paste working trojan configs), then drag users into the
   **Free/Premium** slots to create catalog items (set them **active**).
5. **Apps → Catalog**: tick which catalog items this app exposes.
   `GET /v1/configs` only returns items ticked here.
6. **Countries**: type the ISO code → the flag URL (flagcdn) auto-fills.

## 3. Flutter app: point at the new backend

In `lib/utils/my_helper.dart`:
- `useNewBackend = true` (set `false` to instantly roll back to Laravel)
- `npanelBaseUrl = "https://YOUR_MANAGER_DOMAIN/api/"` (trailing `/api/`)
- `npanelAppKey = "<X-App-Key from step 2>"`
- (production) fill `npanelCertSha256Pins` with `SHA-256(DER)` of the leaf cert.

`flutter pub get` already resolves the added `crypto` + `flutter_secure_storage`.

## 4. Native attestation (for MOBILE_ATTESTATION_MODE=strict)

**iOS (App Attest):**
- In Xcode, add `ios/Runner/Attestation/AppAttestBridge.swift` to the **Runner target**
  (new Swift files are not auto-included in the pbxproj).
- `Runner.entitlements` already has `com.apple.developer.devicecheck.appattest-environment`
  = `production`. For dev testing set it to `development` AND set the app's
  `apple_attest_env=development` in the admin panel (they must match).
- Enable the App Attest capability on the App ID in the Apple Developer portal.

**Android (Play Integrity):**
- `build.gradle` + `AttestationPlugin.kt` + `MainActivity.kt` are wired.
- In Google Play Console enable the Integrity API for the app; link a Google Cloud
  project. Put that project's service-account JSON in
  `GOOGLE_APPLICATION_CREDENTIALS_DIR/<file>.json` and set the app's
  `play_integrity_sa_ref=<file>.json` + `google_cloud_project_number` in the panel.

Until the above is configured, keep `MOBILE_ATTESTATION_MODE=development` so the app
works (mock attestation). Flip to `strict` once verified on real devices.

## 5. QA matrix (on device — cannot be run in CI)

Highest risk = **iOS entry IP**. Verify first.
- [ ] iOS free: connect → `TrojanLeafConfig` builds `Proxy = trojan, <entryIp>, <port>, sni=<domain>` → CONNECTED; 600s free expiry + dialog.
- [ ] iOS premium: premium server gated when not subscribed; connects when subscribed (RevenueCat unaffected by backend).
- [ ] Android free/premium: `parseFromURL(udp)` → CONNECTED.
- [ ] `connection.host` (entryIp) is present and ≠ `sni` in `/v1/configs`.
- [ ] Session start on connect + stop on disconnect; admin **Logs** shows real IP, duration, device_id (+ firebase_uid if logged in).
- [ ] Country grouping + flags render (flag URLs).
- [ ] 401 → refresh → retry; refresh fail → re-attest.
- [ ] Roll back: set `useNewBackend=false`, rebuild → app uses Laravel again.

## 6. Known limitations / follow-ups

- **NPanel remote user-sync is a stub** (`npanelClient.syncUser` → `encrypted_protocol_adapter_missing`): the backend does NOT create the trojan user on the node. Trojan passwords served in configs must already exist on the node (create via the NPanel panel, or paste working configs). Closing this needs the NPanel binary protocol — separate work.
- **Rate-limit + nonce store are in-memory / single-DB** — run a single backend instance until moved to Redis for horizontal scale.
- **ATS not tightened** on iOS (app still makes cleartext calls e.g. ip-api.com). Tighten `NSAllowsArbitraryLoads` + finalize cert pinning as a production hardening step, tested on device.
- **min_supported_version** is stored per app but not yet enforced client-side; add an update-gate dialog when you want the 1-year force-update.
- **Connection-log retention**: add a purge job per your legal/GDPR policy (sweeper only closes orphaned sessions, it does not delete).
