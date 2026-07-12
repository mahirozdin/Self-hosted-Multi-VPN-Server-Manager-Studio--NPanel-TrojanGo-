# 🚀 YENİ PANEL YAYINA ALMA REHBERİ — aaPanel + Otomatik Deploy (CI/CD)

> Bu senin **deploy check-list'in**. Sunucun **aaPanel kurulu** ve **MySQL zaten yüklü** varsayılıyor. Baştan sona, sırayla, her kutucuğu (`[ ]`) tamamlayarak ilerle.
>
> **Kurulunca kazanacakların:**
> 1. Backend + admin paneli aaPanel sunucunda PM2 ile çalışacak.
> 2. **Sadece `git tag` atıp push'layınca otomatik deploy** olacak (GitHub Actions → sunucuna SSH → günceller).
> 3. Admin paneli root'ta görünmeyecek; **gizli bir path** ile gireceksin (örn `vpnhub.bubiapps.com/gizli-anahtarin`).
>
> **Kod tarafındaki her şey hazır** (ölçek/güvenlik düzeltmeleri + gizli-path mekanizması + CI/CD workflow). Senin işin aşağıdaki kurulum adımları.
>
> İki repo: **Panel (backend):** `NPanel-TrojanGo-Manager-Studio` · **Uygulama (mobil):** `VPN-ARGENTINA-FLUTTER--`

---

## ✅ Kod tarafında halledilenler (bilgi — yapman gerekmez)
- Ölçek/dayanıklılık: audit non-blocking, tenant cache, DB havuzu env'e bağlı, çökme koruması.
- Toplu 429 engellendi (carrier-NAT toleranslı rate-limit + `Retry-After`).
- DB temizlik index'leri (migration `0011`); migration boot'ta değil, deploy'da çalışır.
- Uygulama: kalıcı cihaz kimliği, saat kayması düzeltmesi, boş-liste "Yeniden dene" ekranı, toleranslı parse, `tempmail.monster` kesildi, premium cold-start koruması, ödüllü reklam günlük sınırı.
- **`app_key` build sırasında veriliyor** (`--dart-define`).
- **Gizli admin-panel path** mekanizması (`ADMIN_PANEL_PATH`).
- **GitHub Actions CI/CD** workflow'u (`.github/workflows/deploy.yml`) hazır.

**Lansman sonrasına ertelenenler:** premium backend doğrulaması (RevenueCat webhook), firebase_uid doğrulama (Firebase Admin), yatay ölçek (Redis+cluster) — Bölüm 15.

---

## 📋 0. ÖN HAZIRLIK

**0.1 — Hesaplar (hazır olsun):** Cloudflare · Google Cloud · Google Play Console · Apple Developer · RevenueCat · Firebase · AdMob (zaten kurulu) · **GitHub** (repo'ların burada).

**0.2 — Sunucuya SSH erişimin olsun:**
- [ ] aaPanel sunucunun IP'si, SSH kullanıcısı (genelde `root`) ve SSH portu (aaPanel çoğu zaman **22** kullanır) elinde.
- [ ] Bilgisayarından SSH ile bağlanabildiğini doğrula: `ssh root@SUNUCU_IP`

**0.3 — Sunucuda `git` kurulu mu:**
- [ ] SSH ile bağlan, `git --version` çalıştır. Yoksa: `apt install git -y` (Ubuntu) veya `yum install git -y` (CentOS).

---

## 🟢 1. aaPanel: NODE.JS + PM2 KUR

**1.1 — aaPanel'e giriş yap:** Tarayıcıdan aaPanel adresine gir (örn `http://SUNUCU_IP:7800` — kurulumda sana verilen port + güvenlik yolu).

**1.2 — Node.js kur:**
- [ ] Sol menü **App Store** (Uygulama Mağazası) → arama kutusuna `Node` yaz.
- [ ] **"PM2 Manager"** (Node.js proje yöneticisi) uygulamasını bul → **Install**.
- [ ] PM2 Manager açıldığında, içinden bir **Node.js sürümü** kur: **18 veya 20 (LTS)** seç → Install. (`node -v` ile SSH'ta doğrulayabilirsin; en az 18 olmalı.)

**1.3 — Derleme araçları (sqlite3 için — kısa ama önemli):**
- [ ] Backend'in bağımlılıkları arasında native derleme gerektiren bir paket var. Sunucuda derleme araçları kurulu olsun:
      - Ubuntu/Debian: `apt install -y build-essential python3`
      - CentOS/AlmaLinux: `yum groupinstall -y "Development Tools" && yum install -y python3`
      > Bu olmadan `npm ci` bazı paketleri derleyemeyip hata verebilir.

---

## 🗄️ 2. aaPanel: VERİTABANI OLUŞTUR (MySQL zaten kurulu)

> MySQL kurulu olduğu için **kurmayacaksın**, sadece bu proje için bir veritabanı + kullanıcı açacaksın.

- [ ] aaPanel sol menü → **Databases** (Veritabanları) → **Add Database**.
      - Database name: `npanel`
      - Username: `npanel`
      - Password: **güçlü bir şifre belirle** (aaPanel üretebilir; kopyala/sakla — birazdan `.env`'e yazacağız)
      - Access permission: `localhost` (aynı sunucudan erişim)
- [ ] **Submit**.
- [ ] (Opsiyonel ama önerilir) MySQL bağlantı limiti: aaPanel → Databases → sağ üst **Settings/Performance** veya SSH ile `/etc/my.cnf` (ya da aaPanel'in `my.cnf`'i) içinde `max_connections`'ı yükselt (örn `500`). Kural: MySQL `max_connections` > panelin `DB_POOL_MAX` (100) olmalı. Değiştirirsen MySQL'i aaPanel'den **Restart** et.

---

## 📥 3. REPO'YU SUNUCUYA KLONLA + `.env` OLUŞTUR

> Bu adımı **bir kez** yapıyorsun. Bundan sonrası (güncellemeler) CI/CD ile otomatik olacak.

**3.1 — Repo'yu klonla:**
- [ ] SSH ile bağlan. Bir dizin seç (örn aaPanel web kökü altında):
      ```
      cd /www/wwwroot
      git clone https://github.com/mahirozdin/Self-hosted-Multi-VPN-Server-Manager-Studio--NPanel-TrojanGo-.git vpnhub-backend
      cd vpnhub-backend
      ```
- [ ] Bu **tam yolu not al** (`/www/wwwroot/vpnhub-backend`) — CI/CD secret'ında (`DEPLOY_PATH`) ve PM2'de kullanacağız.

**3.2 — `.env` dosyasını oluştur (panelin kalbi — sunucuda kalır, git'e girmez):**
- [ ] `cp .env.example .env` sonra `nano .env` ile aç ve doldur:

**Veritabanı (adım 2'deki değerler):**
```
DB_DIALECT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=npanel
DB_PASSWORD=adim-2de-belirledigin-sifre
DB_NAME=npanel
DB_POOL_MAX=100
```

**🔐 Şifreleme anahtarı (bir kere üret, YEDEKLE, ASLA değiştirme):**
- [ ] SSH'ta çalıştır: `openssl rand -hex 32` → çıkan 64 karakteri yaz:
      ```
      DB_ENCRYPTION_KEY=cikan-64-karakterlik-deger
      ```
      ⚠️ Bunu şifre yöneticine yedekle. Değişirse tüm kayıtlı SSH şifreleri + gizli anahtarlar okunamaz olur.

**🔐 Admin şifresi (panele giriş):**
- [ ] Hash üret (repo klasöründe): `node -e "console.log(require('bcryptjs').hashSync('GUCLU-ADMIN-SIFREN', 12))"`
      ```
      ADMIN_PASSWORD_HASH=cikan-bcrypt-hash
      ```
- [ ] `ADMIN_PASSWORD=` satırını **boş** bırak.

**🔐 Admin oturum anahtarı:**
- [ ] Tekrar `openssl rand -hex 32` → ayrı bir değer:
      ```
      ADMIN_SESSION_SECRET=ayri-bir-64-karakterlik-deger
      ```

**🕵️ GİZLİ ADMIN PANEL YOLU (senin istediğin özellik):**
- [ ] Uzun, tahmin edilemez bir yol belirle (harf+rakam, örn `k7m2x9p4qz`), `.env`'e yaz:
      ```
      ADMIN_PANEL_PATH=k7m2x9p4qz
      ```
      > Bundan sonra panele **sadece** `https://vpnhub.bubiapps.com/k7m2x9p4qz` adresinden girilir. Bu adres seni login ekranına atar (ve tarayıcına gizli bir çerez koyar). Root (`vpnhub.bubiapps.com`) ve rastgele yollar **404** döner — kimse paneli kaba taramayla bulamaz. Bu, admin şifresinin **üstüne** ekstra bir gizlilik katmanıdır.
      > İleride değiştirmek istersen bu değeri değiştir + paneli restart et; eski adres artık çalışmaz.

**Diğerleri:**
```
PORT=3210
AUTO_MIGRATE=            (BOŞ — migration'ı deploy adımı çalıştırır)
MOBILE_ATTESTATION_MODE=development   (Bölüm 9'da strict yapacağız)
CF_ENFORCE=false                      (Bölüm 7'de true yapacağız)
TRUST_PROXY_HOPS=2                    (Cloudflare → aaPanel/nginx → Node = 2 hop)
ADMIN_ORIGIN=
RATE_LIMIT_DEVICE_MAX=90
RATE_LIMIT_IP_MAX=3000
```
> `TRUST_PROXY_HOPS=2`: aaPanel bir nginx reverse proxy kurar, üstünde Cloudflare var → **2** hop. (Cloudflare doğrudan Node'a bağlanıyorsa `1` yap.)

**E-posta alarmları (opsiyonel):** `SMTP_*` + `ALERT_EMAIL_TO` doldur.

- [ ] Kaydet (nano'da `Ctrl+O`, `Enter`, `Ctrl+X`).

---

## ⚙️ 4. İLK KURULUM (elle — bir kez)

Repo klasöründe (`/www/wwwroot/vpnhub-backend`), sırayla:
- [ ] `npm ci --omit=dev` (bağımlılıklar)
- [ ] `npm run migrate` → **"applied 11 migrations"** görmelisin.
- [ ] `npm run migrate:status` → "pending" kalmamalı.
- [ ] Paneli PM2 ile başlat:
      ```
      pm2 start src/server.js --name npanel
      pm2 save
      pm2 startup    (çıkan komutu kopyalayıp çalıştır — sunucu yeniden başlarsa panel otomatik açılır)
      ```
- [ ] `pm2 status` → `npanel` **online** olmalı. `pm2 logs npanel` → hata akmamalı, "Server running on ... 3210" görmelisin.
      > Not: PM2 Manager'ı aaPanel arayüzünden de görebilirsin (App Store → PM2 Manager); ama komut satırı en nettir.

---

## 🌐 5. aaPanel: WEBSITE + REVERSE PROXY + SSL

> Panel `127.0.0.1:3210`'da çalışıyor. Dışarıya `vpnhub.bubiapps.com` üzerinden açacağız.

**5.1 — Website ekle:**
- [ ] aaPanel → **Website** → **Add site**.
      - Domain: `vpnhub.bubiapps.com`
      - PHP version: **Pure static / No PHP** (bu bir Node uygulaması, PHP gerekmez)
- [ ] Submit.

**5.2 — Reverse Proxy ekle:**
- [ ] Oluşturduğun sitenin satırında **Settings** → **Reverse Proxy** (Ters Proxy) → **Add reverse proxy**.
      - Proxy name: `npanel`
      - Target URL: `http://127.0.0.1:3210`
      - Send domain: `$host` (varsayılan bırak)
- [ ] Submit.
      > aaPanel bu proxy'yi kurarken `X-Forwarded-For` / `X-Forwarded-Proto` başlıklarını iletir (panelin gerçek IP + HTTPS algısı için gerekli). Varsayılan aaPanel proxy şablonu bunu yapar.

**5.3 — WebSocket'i aç (terminal özelliği için):**
- [ ] Reverse Proxy ayarında **"Enable WebSocket"** / WebSocket desteği açık olsun (aaPanel'de bir onay kutusu ya da proxy config'inde `Upgrade`/`Connection` başlıkları). Panelin sunucu-terminali bunu kullanır.

**5.4 — SSL:**
- [ ] Site → **SSL** sekmesi. İki seçenek:
      - **A) Cloudflare Origin Certificate (önerilir, Cloudflare kullanıyoruz):** Cloudflare → SSL/TLS → Origin Server → Create Certificate → çıkan sertifika + private key'i aaPanel SSL sekmesinde **"Other Certificate"** olarak yapıştır.
      - **B) Let's Encrypt:** aaPanel SSL → Let's Encrypt → domain'i seç → Apply. (Cloudflare proxy açıkken DNS doğrulaması gerekebilir.)
- [ ] SSL kurulunca **"Force HTTPS"** aç.

---

## ☁️ 6. CLOUDFLARE (client IP güvenliği için ZORUNLU)

> Cloudflare olmadan kötü niyetli biri sahte IP göndererek rate-limit/ban atlatabilir, yasal kayıtlar bozulur.

**6.1 — Domain'i Cloudflare'e ekle:** Cloudflare → **Add a site** → `bubiapps.com` → Free plan. Verdiği 2 nameserver'ı domain registrar'ında ayarla; "Active" olmasını bekle.

**6.2 — DNS kaydı:** Cloudflare → **DNS** → **Add record**:
- Type: `A` · Name: `vpnhub` · IPv4: **sunucunun IP'si** · Proxy: **Proxied (turuncu bulut AÇIK)**.

**6.3 — SSL modu:** Cloudflare → **SSL/TLS** → **Full** (veya Full (strict), origin cert kullandıysan strict).

**6.4 — `.env`'de Cloudflare'i aç:**
- [ ] `nano .env`:
      ```
      CF_ENFORCE=true
      TRUST_PROXY_HOPS=2
      ```
- [ ] `pm2 restart npanel` ile uygula.

---

## 🤖 7. OTOMATİK DEPLOY (CI/CD) — tag atınca sunucuya deploy

> Amaç: `git tag v1.0.1 && git push origin v1.0.1` yazınca, GitHub sunucuna SSH ile bağlanıp kodu çekecek, migration çalıştıracak, paneli yeniden başlatacak. Admin paneli de aynı repoda olduğu için otomatik güncellenecek. Workflow dosyası (`.github/workflows/deploy.yml`) **repoda hazır** — sadece bağlantı bilgilerini (secret) girmen gerek.

**7.1 — Sunucuda deploy için SSH anahtarı oluştur:**
- [ ] SSH ile sunucuya bağlan, bir anahtar çifti üret (parolasız — CI otomatik kullanacak):
      ```
      ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""
      ```
- [ ] Public anahtarı yetkili anahtarlara ekle (GitHub'ın bu anahtarla girebilmesi için):
      ```
      cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
      chmod 600 ~/.ssh/authorized_keys
      ```
- [ ] Private anahtarı **ekrana bas ve kopyala** (birazdan GitHub secret'ına yapıştıracağız):
      ```
      cat ~/.ssh/github_deploy
      ```
      > `-----BEGIN ...` satırından `-----END ...` satırına kadar TAMAMINI kopyala.

**7.2 — GitHub'a secret'ları ekle:**
- [ ] Tarayıcıda backend repo'suna git → **Settings** → sol menü **Secrets and variables** → **Actions** → **New repository secret**. Şu **5 secret'ı tek tek** ekle:

| Secret adı | Değeri |
|---|---|
| `DEPLOY_HOST` | Sunucunun IP adresi (örn `5.9.1.2.3`) |
| `DEPLOY_USER` | SSH kullanıcısı (genelde `root`) |
| `DEPLOY_PORT` | SSH portu (aaPanel'de genelde `22`) |
| `DEPLOY_SSH_KEY` | 7.1'de kopyaladığın **private** anahtarın tamamı |
| `DEPLOY_PATH` | Repo'yu klonladığın yol: `/www/wwwroot/vpnhub-backend` |

- [ ] Her birini **Add secret** ile kaydet.

**7.3 — İlk otomatik deploy'u dene:**
- [ ] Bilgisayarından backend repo'sunda:
      ```
      git tag v1.0.1
      git push origin v1.0.1
      ```
- [ ] GitHub repo → **Actions** sekmesine git → "Deploy backend + admin panel" iş akışının çalıştığını ve **yeşil ✓** olduğunu gör.
- [ ] Sunucuda `pm2 logs npanel` ile yeni sürümün ayağa kalktığını doğrula.
      > Bundan sonra **her deploy** böyle: kod değişikliğini push'la, sonra yeni bir tag at (`v1.0.2`, `v1.0.3`...) ve push'la. Gerisi otomatik.

**7.4 — (Bir defalık) workflow'un çalışması için:**
- [ ] Bu workflow dosyası (`.github/workflows/deploy.yml`) repoda mevcut. Eğer henüz push'lanmadıysa, önce onu içeren commit'i `main`'e push'la, sonra tag at.

> **Sorun giderme:** Actions kırmızıysa, adımın loguna tıkla. Sık nedenler: yanlış `DEPLOY_PATH`, SSH anahtarı eksik/yanlış kopyalanmış, sunucuda `git`/`npm`/`pm2` PATH'te değil (aaPanel Node.js'i özel yola kurar — gerekirse workflow'daki komutların önüne tam yol ekleriz, bana söyle).

---

## 🔑 8. PANELE GİR (gizli path ile) + APP OLUŞTUR → `app_key`

**8.1 — Panele gir:**
- [ ] Tarayıcıdan **gizli adresine** git: `https://vpnhub.bubiapps.com/k7m2x9p4qz` (adım 3.2'deki `ADMIN_PANEL_PATH`).
      > Seni login ekranına atar. `https://vpnhub.bubiapps.com` (düz) denersen **404** görürsün — bu normal ve istediğin davranış.
- [ ] Admin şifrenle (adım 3.2) giriş yap.

**8.2 — App oluştur:**
- [ ] **Apps / Uygulamalar** → **Yeni uygulama**:
      - Name: `VPN Argentina` · Slug: `vpn-argentina`
      - iOS bundle id: `proxify.argentina.vpn`
      - Apple team id / Android package name: (Bölüm 9'da doldurabilirsin)
- [ ] Kaydet → panel **bir kez** gösterir:
      - **`app_key`** (örn `app_a1b2c3...`) → **KOPYALA, SAKLA** (Bölüm 11'de build'e girecek)
      - **`hmac_secret`** → sakla.

---

## 🛡️ 9. ATTESTATION (gerçek cihaz doğrulaması)

> `development` modda herkes sahte token'la bağlanabilir. `strict` modda sadece gerçek cihazlar. **Strict'e geçmeden önce aşağıdakilerin TAMAMI hazır olmalı.**

### 9.A — Android: Google Play Integrity (tıkla-tıkla)

**9.A.1 — API'yi aç:** [Google Cloud Console](https://console.cloud.google.com) → üstten **uygulamanın Firebase/Google projesini** seç → ☰ **APIs & Services → Library** → `Play Integrity API` ara → **Enable**.

**9.A.2 — Service Account oluştur:** ☰ **IAM & Admin → Service Accounts** → **+ CREATE SERVICE ACCOUNT** → name: `play-integrity-checker` → **CREATE AND CONTINUE** → rol: **Service Account User** (veya boş) → **DONE**.

**9.A.3 — JSON anahtar indir:** Oluşturduğun hesaba tıkla → **KEYS** → **ADD KEY → Create new key → JSON → CREATE**. Bilgisayarına bir `.json` iner (gizli!).

**9.A.4 — JSON'ı sunucuya koy:**
- [ ] Sunucuda klasör: `mkdir -p /opt/npanel-secrets`
- [ ] JSON'ı oraya kopyala (örn `scp` ile): `/opt/npanel-secrets/play-integrity.json`
- [ ] `.env`'e ekle: `GOOGLE_APPLICATION_CREDENTIALS_DIR=/opt/npanel-secrets`
- [ ] Panelde App kaydını düzenle → **`play_integrity_sa_ref`** = `play-integrity.json`.
      > ⚠️ Bu JSON `.env` gibi git'e girmez; deploy onu **etkilemez**, sunucuda kalır.

**9.A.5 — Play Console + KOTA (1M için kritik):** [Play Console](https://play.google.com/console) → uygulaman → **Release → App integrity** → Play Integrity'nin bu Google Cloud projesine bağlı olduğunu doğrula. **Kota:** Google Cloud → APIs & Services → **Play Integrity API → Quotas** → varsayılan **~10.000/gün**; 1M kullanıcı için **yükseltme talebi** gönder (erken yap, onay günler sürebilir).

### 9.B — iOS: Apple App Attest
- [ ] Panelde App kaydında: **`ios_bundle_id`** = `proxify.argentina.vpn`, **`apple_team_id`** = Apple Team ID'n ([developer.apple.com](https://developer.apple.com/account) → Membership → Team ID), `apple_attest_env` = `production`. (Ekstra sunucu sırrı gerekmez.)

### 9.C — Strict'e geç + TEST ET
- [ ] Hepsi hazırsa `.env`: `MOBILE_ATTESTATION_MODE=strict` → `pm2 restart npanel`.
- [ ] **Gerçek cihazda** test et (emülatör olmaz): gerçek Android + gerçek iPhone'da uygulamayı aç → sunucu listesi geliyor mu? Gelmiyorsa geçici `development`'a al, `pm2 logs npanel` ile hatayı gör, düzelt, tekrar strict.

---

## 💳 10. REVENUECAT + 🔥 FIREBASE

**RevenueCat:** [Dashboard](https://app.revenuecat.com) → **Entitlement** tam olarak **`premium`** (küçük harf) olmalı; **Offering** tam olarak **`default`** olmalı (içinde Weekly/Monthly/Yearly). Yanlışsa: ödeyen tanınmaz veya paywall boş. Sandbox test satın alımı yap.

**Firebase:** [Console](https://console.firebase.google.com) → projen → **Authentication → Sign-in method → Anonymous → Enable**.

---

## 📱 11. UYGULAMAYI BUILD ET & YAYINLA

**11.1 — `app_key`'i build'e göm:**
```
# Android
flutter build appbundle --release --dart-define=NPANEL_APP_KEY=app_senin-gercek-keyin
# iOS
flutter build ipa --release --dart-define=NPANEL_APP_KEY=app_senin-gercek-keyin
```
- [ ] Doğrula: build'i cihaza kur, aç → sunucu listesi geliyorsa `app_key` doğru.

**11.2 — Kontroller:**
- [ ] `iosAppStoreId` (`lib/utils/my_helper.dart`) gerçek App Store numaran mı (çalışan bundle `proxify.argentina.vpn`).
- [ ] Panelde App kaydında `min_supported_version` = boş veya `2.2.2` (yanlış/yüksek değer tüm kullanıcıları kilitler; yeni sürüm mağazada yayında olduktan sonra yükselt).
- [ ] `android/app/build.gradle` `targetSdkVersion` Play Console'un kabul ettiği bir sürüm.

**11.3 — Mağazaya yükle** (Play Console + App Store Connect). **Henüz %100 yayınlama.**

---

## 🐤 12. KADEMELİ LANSMAN (canary)
- [ ] Panel stabil: `pm2 status` online, `pm2 logs npanel` temiz.
- [ ] Play Console **Staged rollout**: %1 → %5 → %20 → %50 → %100 (her kademede birkaç saat izle).
- [ ] App Store **Phased Release** aç.

---

## 🧪 13. CANLI TEST SENARYOLARI (gerçek cihazlarla)
- [ ] İlk açılış (temiz kurulum) → liste geliyor, free sunucu bağlanıyor mu?
- [ ] Saati 10 dk ileri/geri al → yine bağlanabiliyor mu? (saat kayması düzeltmesi)
- [ ] Uçak modunda aç → "Yeniden dene" ekranı (sonsuz tekerlek değil) → net açıp retry → liste geliyor mu?
- [ ] Premium satın al → reklam kalkıyor, premium sunucular açılıyor, limit kalkıyor mu?
- [ ] Uygulamayı sil+kur → "Satın Alımları Geri Yükle" ile premium dönüyor mu?
- [ ] Ödüllü reklam ile süre yenileme → çok tekrarla → makul sayıdan sonra paywall (günlük sınır) mı?
- [ ] Android + iOS ayrı ayrı; farklı ülke/operatör (carrier-NAT'ta 429 yememeli).
- [ ] **Gizli path:** `vpnhub.bubiapps.com` (düz) → 404; `vpnhub.bubiapps.com/GIZLI_PATH` → login. ✓

---

## 📊 14. İZLEME & GERİ ALMA (ilk 48 saat)
**İzle:** `pm2 logs npanel` (unhandledRejection/uncaughtException var mı) · 403 artışı → `app_key` yanlış · 401 artışı → attestation/saat · 429 artışı → `.env` `RATE_LIMIT_IP_MAX` yükselt + restart · DB timeout → `DB_POOL_MAX` + MySQL `max_connections` yükselt · RevenueCat funnel (Firebase DebugView).

**Geri alma (CI/CD ile kolay):**
- [ ] Sorun çıkarsa, **önceki sağlam tag'i tekrar deploy et:** bilgisayarından `git push origin <eski-tag>` yerine, sunucuda hızlıca: `cd /www/wwwroot/vpnhub-backend && git checkout <onceki-tag> && npm ci --omit=dev && npm run migrate && pm2 restart npanel`. (Veya yeni bir düzeltme tag'i atıp otomatik deploy et.)
- [ ] Play Console / App Store rollout'u durdur/geri çek.
- [ ] Attestation herkesi kilitliyorsa acil: `.env` `MOBILE_ATTESTATION_MODE=development` + `pm2 restart npanel`, sonra Bölüm 9'u düzelt.

---

## 🔭 15. LANSMAN SONRASI ROADMAP (ertelendi — lansmanı bloklamaz)
1. **Premium backend doğrulaması (H4):** RevenueCat webhook ile satın almayı sunucuda doğrulayıp `is_premium`'u güvenilir set etmek, `/v1/configs`'i buna göre filtrelemek.
2. **firebase_uid doğrulama (H10):** backend'e Firebase Admin SDK ekleyip ID token doğrulamak.
3. **Yatay ölçek (Redis + cluster):** birden çok Node instance + rate-limit/ban/login sayaçlarını Redis'e taşımak.

---

### 🎯 Özet
**Kurulum sırası:** Node+PM2 (1) → DB oluştur (2) → repo klonla + `.env` [gizli path dahil] (3) → ilk kurulum & PM2 (4) → reverse proxy + SSL (5) → Cloudflare (6) → **CI/CD secret'ları (7)** → gizli path'ten gir & app_key al (8) → attestation (9) → RevenueCat+Firebase (10) → app_key ile build & yükle (11) → canary (12) → canlı test (13) → izle (14).

Bir kez kurduktan sonra günlük hayat basit: **kod push'la → `git tag vX.Y.Z && git push origin vX.Y.Z` → otomatik deploy.** Panele hep gizli path'inden girersin.
