# 🚀 YENİ PANEL YAYINA ALMA REHBERİ (Adım Adım)

> Bu dosya senin **deploy check-list'in**. Baştan sona, sırayla, her kutucuğu (`[ ]`) tamamlayarak ilerle. Bir adımı atlamadan gittiğinde panel + uygulama sorunsuz canlıya çıkar ve gerçek kullanıcıyla test edebilirsin.
>
> **Not:** Bu rehber yalnızca **senin elle yapman gereken** işleri içerir. Koddaki tüm hata/dayanıklılık/ölçek düzeltmeleri **zaten yapıldı** (aşağıdaki "Kod tarafında halledilenler" listesine bak — o işler için hiçbir şey yapmana gerek yok).
>
> İki repo:
> - **Panel (backend):** `NPanel-TrojanGo-Manager-Studio`
> - **Uygulama (mobil):** `VPN-ARGENTINA-FLUTTER--`

---

## ✅ Kod tarafında halledilenler (senin yapmana gerek YOK — sadece bilgi)

Bunlar kod düzeltmesiyle tamamlandı; deploy ederken otomatik devrede olacaklar:

- **Ölçek/dayanıklılık:** audit log yazımı artık isteği yavaşlatmıyor; tenant (app) sorgusu cache'lendi; DB bağlantı havuzu ayara bağlandı (`DB_POOL_MAX`); beklenmedik hatalarda tek process çökmüyor (unhandledRejection/uncaughtException yakalanıyor).
- **Toplu 429 engellendi:** rate-limit artık carrier-NAT'a toleranslı (aynı IP arkasındaki yüzlerce gerçek kullanıcı 429 yemez); kötüye kullanım hâlâ per-device sınırla korunuyor; 429 yanıtına `Retry-After` eklendi.
- **Veritabanı:** yüksek hacimli tablolara (nonce/audit) temizlik index'leri eklendi (migration `0011`); migration'lar artık boot'ta otomatik çalışmıyor (aşağıda `npm run migrate` adımı var).
- **Uygulama:** cihaz kimliği artık kalıcı ve benzersiz (eski "aynı cihaz gibi görünme" hatası giderildi); saat kayması kalıcı hale getirildi (yanlış saatli cihaz kilitlenmiyor); sunucu listesi boş gelince artık sonsuz dönen tekerlek yerine **"Yeniden dene"** ekranı çıkıyor; bozuk bir sunucu satırı tüm listeyi çökertmiyor; eski `tempmail.monster` bağımlılığı kesildi; oturum açma yarışları tekilleştirildi; premium kullanıcı açılışta yanlışlıkla reklam/limit görmüyor; ödüllü reklam bölgelerinde bedava süreye günlük sınır kondu.
- **`app_key` artık build sırasında veriliyor** (aşağıda `--dart-define` adımı). Kaynağı elle düzenlemene gerek yok.

**Lansman sonrasına ertelenenler (senin kararınla):** premium sunucuların backend'de doğrulanması (RevenueCat webhook), `firebase_uid` doğrulama (Firebase Admin), yatay ölçek (Redis+cluster). Bunlar **13. bölümdeki roadmap'te**. Lansmanı bloklamazlar.

---

## 📋 0. ÖN HAZIRLIK

**0.1 — Gerekli hesaplar (hepsinin hazır olduğundan emin ol):**
- [ ] Sunucu (VPS/dedicated) — güçlü bir Linux sunucu (aşağıda spec var)
- [ ] Alan adı: `vpnhub.bubiapps.com` sana ait ve DNS'ini yönetebiliyorsun
- [ ] **Cloudflare** hesabı (ücretsiz plan yeterli)
- [ ] **Google Cloud** hesabı (Play Integrity için)
- [ ] **Google Play Console** hesabı (uygulama yayınlanmış/yayınlanacak)
- [ ] **Apple Developer** hesabı (App Store + App Attest için)
- [ ] **RevenueCat** hesabı (abonelikler)
- [ ] **Firebase** projesi (uygulama zaten kullanıyor)
- [ ] **AdMob** hesabı (reklamlar — zaten kurulu)

**0.2 — Kodun güncel olduğunu doğrula:**
- [ ] Panel repo'sunda son kod çekili (`git pull`), `RELEASE_NEW_PANEL.md` (bu dosya) mevcut.
- [ ] Uygulama repo'sunda son kod çekili.
- [ ] Panelde: `npm install` çalıştırıldı.
- [ ] Uygulamada: `flutter pub get` çalıştırıldı.

---

## 🖥️ 1. SUNUCU & VERİTABANI

**1.1 — Sunucu seç (dikey ölçek — 1M kullanıcı tek güçlü sunucuda):**
- [ ] En az **8 vCPU / 16 GB RAM** (ideal: 16 vCPU / 32 GB) bir Linux (Ubuntu 22.04+) sunucu.
- [ ] Node.js 18+ kurulu (`node -v` ile kontrol et).
- [ ] Bir process yöneticisi kur: **PM2** öneriyorum (çökerse otomatik yeniden başlatır):
      ```
      sudo npm install -g pm2
      ```

**1.2 — MySQL kur ve ayarla:**
- [ ] MySQL 8 kur (`sudo apt install mysql-server`).
- [ ] Bir veritabanı + kullanıcı oluştur:
      ```sql
      CREATE DATABASE npanel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE USER 'npanel'@'localhost' IDENTIFIED BY 'BURAYA-GÜÇLÜ-BİR-ŞİFRE';
      GRANT ALL PRIVILEGES ON npanel.* TO 'npanel'@'localhost';
      FLUSH PRIVILEGES;
      ```
- [ ] MySQL bağlantı limitini yükselt. `/etc/mysql/mysql.conf.d/mysqld.cnf` içine ekle:
      ```
      [mysqld]
      max_connections = 500
      ```
      Sonra: `sudo systemctl restart mysql`.
      > **Kural:** MySQL `max_connections`, panelin `DB_POOL_MAX` değerinden yüksek olmalı. `DB_POOL_MAX=100` → `max_connections=500` gibi rahat bir pay bırak.

**1.3 — `.env` dosyasını oluştur (panelin kalbi — her satır önemli):**
- [ ] Panel klasöründe `.env.example`'ı kopyala: `cp .env.example .env`
- [ ] Şimdi `.env`'i aç ve aşağıdaki değerleri **tek tek** doldur:

**Veritabanı:**
```
DB_DIALECT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=npanel
DB_PASSWORD=1.2'de-belirledigin-sifre
DB_NAME=npanel
DB_POOL_MAX=100
```

**🔐 Şifreleme anahtarı (ÇOK ÖNEMLİ — bir kere üret, yedekle, ASLA değiştirme):**
- [ ] Terminalde çalıştır: `openssl rand -hex 32`
- [ ] Çıkan 64 karakterlik değeri kopyala:
      ```
      DB_ENCRYPTION_KEY=buraya-cikan-64-karakterlik-deger
      ```
- [ ] ⚠️ Bu anahtarı **güvenli bir yere yedekle** (şifre yöneticisi). Kaybedersen veya değiştirirsen, panele kayıtlı tüm sunucu SSH şifreleri + gizli anahtarlar **geri dönülmez şekilde okunamaz hale gelir**.

**🔐 Admin şifresi (panele giriş):**
- [ ] Güçlü bir admin şifresi belirle, sonra bcrypt hash'ini üret:
      ```
      node -e "console.log(require('bcryptjs').hashSync('SENIN-GUCLU-ADMIN-SIFREN', 12))"
      ```
- [ ] Çıkan hash'i yaz (düz şifreyi DEĞİL hash'i):
      ```
      ADMIN_PASSWORD_HASH=cikan-bcrypt-hash
      ```
- [ ] `.env`'de `ADMIN_PASSWORD=` satırını **boş bırak** (hash varken düz şifre gerekmez).

**🔐 Admin oturum anahtarı:**
- [ ] Tekrar `openssl rand -hex 32` çalıştır, ayrı bir değer üret:
      ```
      ADMIN_SESSION_SECRET=buraya-ayri-bir-64-karakterlik-deger
      ```

**Diğerleri (şimdilik böyle bırak, ilgili bölümlerde değişecek):**
```
PORT=3210
AUTO_MIGRATE=            (BOŞ bırak — migration'ı elle çalıştıracağız, adım 4)
MOBILE_ATTESTATION_MODE=development   (adım 6'da strict yapacağız)
CF_ENFORCE=false                      (adım 3'te true yapacağız)
TRUST_PROXY_HOPS=1
ADMIN_ORIGIN=                         (panel same-origin çalışır; boş kalabilir)
RATE_LIMIT_DEVICE_MAX=90
RATE_LIMIT_IP_MAX=3000
```

**E-posta alarmları (opsiyonel ama önerilir — sunucu çökerse haber alırsın):**
- [ ] SMTP bilgilerini doldur (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_TO`). Boş bırakırsan alarmlar sadece panelde görünür.

---

## ☁️ 2. CLOUDFLARE (client IP güvenliği için ZORUNLU)

> Neden: Cloudflare olmadan, kötü niyetli biri sahte IP göndererek rate-limit'i ve ban'ları atlatabilir, yasal bağlantı kayıtları bozulur. Cloudflare + `CF_ENFORCE=true` bunu kapatır.

**2.1 — Alan adını Cloudflare'e ekle:**
- [ ] Cloudflare'e giriş yap → **Add a site** → `bubiapps.com` yaz → Free plan seç.
- [ ] Cloudflare sana 2 tane **nameserver** verir. Alan adını aldığın yerin (domain registrar) panelinde, nameserver'ları bunlarla değiştir.
- [ ] Cloudflare'de "Active" olana kadar bekle (birkaç dakika–birkaç saat).

**2.2 — DNS kaydı ekle (turuncu bulut açık):**
- [ ] Cloudflare → **DNS** → **Add record**:
      - Type: `A`
      - Name: `vpnhub`
      - IPv4 address: **sunucunun IP adresi**
      - Proxy status: **Proxied (turuncu bulut AÇIK)** ← bu kritik
- [ ] Kaydet.

**2.3 — SSL ayarı:**
- [ ] Cloudflare → **SSL/TLS** → Overview → modu **Full** (veya Full (strict)) yap.
- [ ] Sunucuda panele bir TLS sertifikası kur (Let's Encrypt / Cloudflare Origin Certificate). Panel düz HTTP dinler; TLS'i Cloudflare + reverse proxy (nginx) halleder. Nginx'i `vpnhub.bubiapps.com` → `127.0.0.1:3210`'a yönlendir.

**2.4 — `.env`'de Cloudflare'i aç:**
- [ ] `.env` içinde:
      ```
      CF_ENFORCE=true
      TRUST_PROXY_HOPS=1
      ```
      > `TRUST_PROXY_HOPS`: Cloudflare → nginx → Node ise `2`, Cloudflare → Node doğrudan ise `1`. Kurulumuna göre ayarla.

---

## 🗄️ 3. VERİTABANI ŞEMASINI KUR (migration)

- [ ] Panel klasöründe, `.env` hazırken çalıştır:
      ```
      npm run migrate
      ```
- [ ] "applied 11 migrations" görmelisin.
- [ ] Doğrula: `npm run migrate:status` → hiç "pending" kalmamalı.
      > Not: Kod artık boot'ta otomatik migrate etmiyor. Gelecekte yeni bir migration eklenirse, deploy'da bu komutu tekrar çalıştır.

---

## 🔑 4. PANELDE UYGULAMA (App) OLUŞTUR → `app_key` AL

> Bu `app_key`, uygulamanın panele "ben bu uygulamayım" demesini sağlar. Uygulama build'ine gömülecek. **Bu olmadan uygulama hiç çalışmaz.**

**4.1 — Paneli başlat (geçici, App oluşturmak için):**
- [ ] `pm2 start src/server.js --name npanel` (veya geçici `npm start`).
- [ ] `https://vpnhub.bubiapps.com` adresine git, admin şifrenle (1.3'te belirlediğin) giriş yap.

**4.2 — App oluştur:**
- [ ] Panelde **Apps / Uygulamalar** sekmesine git → **Yeni uygulama** oluştur.
      - Name: `VPN Argentina` (istediğin isim)
      - Slug: `vpn-argentina`
      - iOS bundle id: `proxify.argentina.vpn`
      - Apple team id: (Apple Developer hesabındaki Team ID — adım 6.3'te bulacaksın; şimdilik boş bırakıp sonra düzenleyebilirsin)
      - Android package name: (uygulamanın paket adı — Play Console'dan; adım 6'da)
- [ ] Kaydet. Panel sana **iki değer** gösterir (yalnızca bir kez!):
      - **`app_key`** (örn. `app_a1b2c3...`) → **KOPYALA, SAKLA** (adım 9'da build'e gömeceğiz)
      - **`hmac_secret`** → sakla (yedek olarak; normalde tekrar gerekmez)

---

## 🛡️ 5. ATTESTATION KURULUMU (en detaylı bölüm — dikkatli yap)

> Neden: `development` modda herkes sahte token'la panele bağlanabilir (güvenlik kapalı). `strict` modda sadece gerçek, sahte olmayan cihazlar bağlanır. **Ama** `strict`'e geçmeden önce aşağıdakilerin TAMAMI hazır olmalı, yoksa gerçek kullanıcılar da bağlanamaz.

### 5.A — Android: Google Play Integrity (tıkla-tıkla)

**5.A.1 — Play Integrity API'yi aç:**
- [ ] [Google Cloud Console](https://console.cloud.google.com)'a gir.
- [ ] Üstteki proje seçiciden, **uygulamanın Firebase/Google projesini** seç (yenisini oluşturma — mevcut olanı kullan).
- [ ] Sol üst menü (☰) → **APIs & Services** → **Library**.
- [ ] Arama kutusuna `Play Integrity API` yaz → çıkan sonuca tıkla → **Enable** butonuna bas.

**5.A.2 — Service Account (servis hesabı) oluştur:**
- [ ] Sol menü (☰) → **IAM & Admin** → **Service Accounts**.
- [ ] Üstte **+ CREATE SERVICE ACCOUNT**.
      - Service account name: `play-integrity-checker`
      - **CREATE AND CONTINUE**.
- [ ] "Grant this service account access" adımında rol olarak: **Service Account User** ekle (veya boş bırakıp CONTINUE — Play Integrity decode için özel rol gerekmez, sadece kimlik doğrulama).
- [ ] **DONE**.

**5.A.3 — Service Account anahtarını (JSON) indir:**
- [ ] Oluşturduğun service account'a tıkla → üstte **KEYS** sekmesi.
- [ ] **ADD KEY** → **Create new key** → tür: **JSON** → **CREATE**.
- [ ] Bir `.json` dosyası bilgisayarına iner. **Bu dosyayı güvenle sakla** (gizli anahtar!).

**5.A.4 — JSON'ı sunucuya koy:**
- [ ] Sunucuda bir klasör oluştur, örn: `/opt/npanel-secrets/`.
- [ ] İndirdiğin JSON dosyasını oraya kopyala, örn: `/opt/npanel-secrets/play-integrity.json`.
- [ ] `.env`'e ekle:
      ```
      GOOGLE_APPLICATION_CREDENTIALS_DIR=/opt/npanel-secrets
      ```
- [ ] Panelde App kaydını düzenle → **`play_integrity_sa_ref`** alanına dosya adını yaz: `play-integrity.json`.

**5.A.5 — Play Console'da bağla + KOTA ARTIŞI (1M için kritik):**
- [ ] [Google Play Console](https://play.google.com/console) → uygulamanı seç → sol menü **Release → App integrity** (Uygulama bütünlüğü).
- [ ] Play Integrity API'nin bu Google Cloud projesine bağlı olduğunu doğrula.
- [ ] ⚠️ **KOTA ARTIŞI:** Play Integrity Classic API'nin varsayılan kotası **günde ~10.000 istek**. 1M kullanıcı bunu ilk saatte aşar → herkes bağlanamaz. Google Cloud Console → **APIs & Services → Play Integrity API → Quotas** → mevcut kotayı gör → **EDIT QUOTAS / Request quota increase** ile günlük kotayı beklediğin kullanıcı sayısına göre yükseltme talebi gönder (1M aktif için milyonlar mertebesinde iste). Onay birkaç gün sürebilir — **bunu erken yap.**

### 5.B — iOS: Apple App Attest

- [ ] App Attest sunucu tarafında ekstra gizli anahtar gerektirmez (yerel doğrulama). Sadece App kaydında şu ikisi doğru olmalı:
      - **`ios_bundle_id`** = `proxify.argentina.vpn`
      - **`apple_team_id`** = Apple Developer hesabının Team ID'si.
- [ ] Team ID'yi bulmak için: [Apple Developer](https://developer.apple.com/account) → **Membership** → "Team ID" (10 karakterlik kod).
- [ ] Panelde App kaydını düzenle, bu iki alanı doldur. `apple_attest_env` = `production`.

### 5.C — Strict moda geç ve TEST ET

- [ ] Yukarıdaki 5.A ve 5.B'nin **tamamı** bittiğinde, `.env`'de:
      ```
      MOBILE_ATTESTATION_MODE=strict
      ```
- [ ] Paneli yeniden başlat: `pm2 restart npanel`.
- [ ] ⚠️ **Gerçek bir cihazda test et** (emülatör/simülatör App Attest/Play Integrity'de çalışmaz):
      - Gerçek bir Android telefonda uygulamayı aç → sunucu listesi geliyor mu? (Play Integrity çalışıyor)
      - Gerçek bir iPhone'da aç → sunucu listesi geliyor mu? (App Attest çalışıyor)
      - Gelmiyorsa: `.env`'i geçici `development` yapıp panel loglarına bak (`pm2 logs npanel`), attestation hata mesajını gör, config'i düzelt, tekrar strict yap.

---

## 💳 6. REVENUECAT (abonelikler — yanlışsa gelir sıfır)

- [ ] [RevenueCat Dashboard](https://app.revenuecat.com)'a gir.
- [ ] **Entitlements** → tam olarak **`premium`** adında bir entitlement olmalı (harfi harfine, küçük harf). Yoksa oluştur.
      > Uygulama `entitlements.active['premium']` diye kontrol ediyor — isim farklıysa ödeyen kullanıcı "premium değil" görünür (reklam görür, kilitli kalır).
- [ ] **Offerings** → tam olarak **`default`** adında bir offering olmalı, içinde Weekly / Monthly / Yearly paketlerin ekli.
      > İsim `default` değilse paywall "planlar yok" der, hiç satın alma olmaz.
- [ ] Bir **test satın alımı** yap (sandbox) → premium'un aktifleştiğini, reklamların kalktığını doğrula.
- [ ] Bölgesel fiyatları (ARS / LATAM) kontrol et.

---

## 🔥 7. FIREBASE

- [ ] [Firebase Console](https://console.firebase.google.com) → projeni seç → **Authentication** → **Sign-in method**.
- [ ] **Anonymous** sağlayıcısını **Enable** yap.
      > Bu olmadan anonim satın alma / premium'un uid'ye bağlanması zayıflar, kullanıcılar sürekli "Restore" yapmak zorunda kalır.
- [ ] (Uygulama zaten Firebase kullanıyor; başka Firebase ayarı gerekmez.)

---

## 📱 8. UYGULAMAYI BUILD ET & YAYINLA

**8.1 — `app_key`'i build'e göm (B1 blocker — kritik):**
- [ ] Uygulama klasöründe build alırken `--dart-define` ile adım 4.2'deki `app_key`'i geç:
      **Android:**
      ```
      flutter build appbundle --release --dart-define=NPANEL_APP_KEY=app_senin-gercek-keyin
      ```
      **iOS:**
      ```
      flutter build ipa --release --dart-define=NPANEL_APP_KEY=app_senin-gercek-keyin
      ```
- [ ] ⚠️ **Doğrula:** build'i test cihazına kur, uygulamayı aç → sunucu listesi geliyorsa `app_key` doğru gömülmüş demektir. (Placeholder kalırsa liste boş gelir + "Yeniden dene" ekranı çıkar.)

**8.2 — Diğer değerleri doğrula:**
- [ ] **iOS App Store ID:** `lib/utils/my_helper.dart` içindeki `iosAppStoreId` gerçek App Store numaran mı? (Force-update yönlendirmesi bunu kullanır.) Yanlışsa düzelt.
      > Not: yorum satırında `appillon.argentina.vpn` yazıyor ama uygulamanın bundle'ı `proxify.argentina.vpn` — App Store ID'nin **çalışan bundle'a** ait olduğundan emin ol.
- [ ] **Force-update sürümü:** Panelde App kaydında `min_supported_version` alanını **boş** ya da `2.2.2` bırak. İleride zorunlu güncelleme yapacaksan, **yeni sürüm mağazada yayında olduktan sonra** bu değeri yükselt (yanlış/yüksek değer tüm kullanıcıları kilitler).
- [ ] **Android targetSdk:** `android/app/build.gradle`'daki `targetSdkVersion`'ın Play Console'un kabul ettiği bir sürüm olduğunu doğrula (build + yükleme sırasında hata almamak için).

**8.3 — Mağazaya yükle:**
- [ ] Android App Bundle'ı Play Console'a, IPA'yı App Store Connect'e yükle.
- [ ] **Henüz %100'e yayınlama** — bir sonraki adımda kademeli açacağız.

---

## 🐤 9. KADEMELİ LANSMAN (canary — güvenli açılış)

> Backend'i canlıya al ama uygulamayı herkese birden açma. Sorun çıkarsa küçük bir kitleyi etkiler.

- [ ] Panel canlı ve stabil: `pm2 status` → `npanel` online. `pm2 logs npanel` → hata akmıyor.
- [ ] Play Console'da **Staged rollout** ile başlat: **%1** → izle → **%5** → **%20** → **%50** → **%100**.
- [ ] App Store'da benzer şekilde **Phased Release** aç.
- [ ] Her kademede en az birkaç saat bekle ve **10. bölümdeki metrikleri** izle. Anormallik görürsen rollout'u durdur.

---

## 🧪 10. CANLI TEST SENARYOLARI (yayından hemen sonra bizzat dene)

Farklı koşullarda gerçek cihazlarla test et:

- [ ] **İlk açılış (temiz kurulum):** Uygulamayı yeni kur → sunucu listesi geliyor mu? Bir free sunucuya bağlan → çalışıyor mu?
- [ ] **Farklı saat dilimi / bozuk saat:** Test cihazının saatini elle 10 dakika ileri/geri al → uygulama yine bağlanabiliyor mu? (Saat kayması düzeltmesi.)
- [ ] **İnternetsiz açılış:** Uçak modunda aç → sonsuz tekerlek yerine **"Yeniden dene"** ekranı çıkıyor mu? İnterneti açıp "Yeniden dene"ye bas → liste geliyor mu?
- [ ] **Premium satın alma:** Bir hesapla premium satın al → reklamlar kalkıyor, premium sunucular açılıyor, süre limiti kalkıyor mu?
- [ ] **Premium geri yükleme:** Uygulamayı sil + tekrar kur → "Satın Alımları Geri Yükle" ile premium geri geliyor mu?
- [ ] **Ödüllü reklam:** Free kullanıcı olarak süre bitince ödüllü reklam izle → süre yenileniyor mu? Günde çok kez tekrarla → makul sayıdan sonra paywall'a yönlendiriyor mu? (Günlük sınır.)
- [ ] **Android + iOS ayrı ayrı:** İki platformda da yukarıdakileri dene.
- [ ] **Farklı ülke/operatör:** Mümkünse farklı bir ülkeden/operatörden (veya VPN'le farklı çıkış) test et — carrier-NAT'ta 429 yememeli.

---

## 📊 11. İZLEME & GERİ ALMA (ilk 48 saat kritik)

**İzlenecekler (panel logları + sunucu):**
- [ ] `pm2 logs npanel` — hata/uyarı akışı, `[unhandledRejection]`/`[uncaughtException]` var mı.
- [ ] **403 oranı yükselişi** → `app_key` yanlış gömülmüş olabilir (adım 8.1).
- [ ] **401 oranı yükselişi** → attestation veya saat sorunu (adım 5).
- [ ] **429 oranı yükselişi** → NAT rate-limit tavanı düşük kalmış olabilir; `.env`'de `RATE_LIMIT_IP_MAX`'i yükselt + `pm2 restart`.
- [ ] **DB timeout** hataları → `DB_POOL_MAX`'i ve MySQL `max_connections`'ı yükselt.
- [ ] RevenueCat funnel (Firebase DebugView): satın alma akıyor mu.

**Geri alma (bir şey ters giderse):**
- [ ] Play Console / App Store'da staged rollout'u **durdur/geri çek**.
- [ ] Panelde sorunluysa: `pm2 restart npanel` veya önceki koda `git checkout` + restart.
- [ ] Attestation herkesi kilitliyorsa: acil olarak `.env`'de `MOBILE_ATTESTATION_MODE=development` + restart (güvenlik geçici düşer ama kullanıcılar bağlanır), sonra 5. bölümü düzelt.

---

## 🔭 12. LANSMAN SONRASI ROADMAP (şimdi değil — ertelendi)

Bu üçü lansmanı bloklamaz; sistem bunlarsız da güvenli ve çalışır durumda. Trafiği oturduktan sonra ayrı projeler olarak ele al:

1. **Premium sunucu backend doğrulaması (H4):** Şu an premium kilidi uygulama tarafında. Teknik bir kullanıcı premium sunucu bilgisini çekebilir. Gerçek çözüm: **RevenueCat webhook** endpoint'i kurup, satın almayı sunucu tarafında doğrulayıp `is_premium`'u güvenilir kaynaktan set etmek, sonra `/v1/configs`'i buna göre filtrelemek.
2. **firebase_uid doğrulama (H10):** Şu an `firebase_uid` client'tan doğrulanmadan alınıyor (ban/atıf buna dayanıyor). Çözüm: backend'e **Firebase Admin SDK** ekleyip ID token'ı doğrulamak.
3. **Yatay ölçek (Redis + cluster):** Tek sunucu yetmezse: birden fazla Node instance + rate-limit/ban/login sayaçlarını **Redis**'e taşımak. (Şu an in-memory oldukları için çoklu instance'ta bozulurlar.)

---

### 🎯 Özet
Kod tarafındaki tüm hata/ölçek düzeltmeleri hazır. Senin işin: **sunucu + MySQL kur (1) → Cloudflare (2) → migrate (3) → App oluştur & app_key al (4) → attestation kur (5) → RevenueCat (6) → Firebase (7) → app_key ile build & yükle (8) → canary rollout (9) → canlı test (10) → izle (11).** Bu sırayı takip et, hiçbir adımı atlama; sonunda sorunsuz canlı bir sistemin olur.
