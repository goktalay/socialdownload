# Social Download — teknik föy

Sosyal medya platformlarındaki **herkese açık** bağlantılardan video ve ses indiren Windows masaüstü uygulaması. Bağlantı
analiz edilir, indirmeden önce çözünürlük / kapsayıcı ya da yalnız ses seçilir; oynatma listeleri öğe öğe kuyruğa alınır.
Mastertool ailesinin **Araçlar** grubundandır; Mastertool hesabıyla girişsiz kullanılamaz.

- Tanıtım: https://mastertool.download/araclar/social-download
- İndirme: Hesabım (mastertool.download) ve Master Tool
- Uygulama kodu: `sd` · Kaynak: github.com/goktalay/socialdownload

> **Yalnızca indirme hakkınız olan içerikleri indirin; telif hakları ve platform kullanım koşulları kullanıcının
> sorumluluğundadır.** Bu uyarı ilk açılışta onaylanmadan analiz yapılmaz ve pencerenin üst şeridinde sürekli görünür.

## Gereksinimler

| | |
| --- | --- |
| İşletim sistemi | Windows 10 / 11 (64 bit) |
| Yönetici izni | Gerekmez (kurulumda "yalnız bu kullanıcı" seçeneği vardır) |
| Hesap | Mastertool hesabı (ücretsiz); tek girişle ailenin diğer uygulamaları da açılır |
| Ağ | İnternet (indirmeler doğrudan bu bilgisayardan platformlara; hesap yalnız giriş/lisans/senkron) |
| Disk | ~420 MB (uygulama + motor) + indirilen dosyalar |

Kurulum: `Social-Download-Setup-<sürüm>.exe` → `Program Files\Mastertool\Social Download` (Başlat: **Master Tool › Social Download**).
Taşınabilir: `Social-Download-Portable-<sürüm>.exe` (ayarlar `%APPDATA%\social-download` altında).

## Teknoloji

- **Electron 33**, yalıtılmış ve sandbox'lı pencereler (`contextIsolation`, `nodeIntegration: false`, `sandbox: true`, CSP
  `default-src 'self'`; küçük resimler ana süreçte indirilip `data:` adresi olarak verilir). Paketleme electron-builder NSIS
  (kurulum + portable), ortak `build/installer.nsh`.
- **Motor**: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense) bağlantıyı çözer ve indirir; **FFmpeg** (LGPL-2.1+,
  BtbN `win64-lgpl-shared` derlemesi, DLL olarak) görüntü + ses birleştirme, ses dönüştürme ve meta veri yazma yapar. İkisi de
  `resources\engine\` altında uygulamayla gelir; derlemede `scripts/fetch-engine.js` resmi sürümlerden indirir ve
  `scripts/engine-manifest.json`'daki sabit SHA-256 ile doğrular (yt-dlp için ayrıca imzalı SHA2-256SUMS). Lisans metinleri ve
  FFmpeg kaynak bağlantısı `resources\engine\licenses\`.
- **8 dil**: Türkçe, English, Français, Deutsch, Español, العربية (sağdan sola), 中文, Русский. Tema: Gece / Gündüz / Sistem.
- **Hesap ve senkron** (mastertool.download, `/api/sd/*`): ayarlar (tema, dil, indirme tercihleri) ve isteğe bağlı indirme
  geçmişi (son 200: bağlantı, başlık, platform, biçim, tarih) uçtan uca şifreli (PBKDF2 → HKDF `sdl-enc-v1` → AES-256-GCM);
  sunucu içeriği okuyamaz. **İndirilen dosyalar, dosya yolları ve indirme klasörü hiçbir zaman gönderilmez.**
- **Ortak oturum (SSO)**: `Entry('Mastertool','sso')` + `%APPDATA%\Mastertool\sso-state.json`; goktalay/mastertool ile birebir.
- Sürüm denetimi: `GET /api/sd/releases/latest`; indirme Hesabım / Master Tool'dan.

## Nasıl çalışır

1. **Analiz** — Yapıştırılan metinden en çok 200 bağlantı ayıklanır (ilk 25'i analiz edilir); izleme parametreleri atılır,
   tekrarlar birleşir. DRM'li servisler, yerel ağ adresleri, kullanıcı adı/şifre içeren ve http(s) dışı bağlantılar motor
   çağrılmadan reddedilir. Motor `yt-dlp -J --flat-playlist` ile çağrılır: tekil içerikte başlık, yükleyen, süre, küçük
   resim ve tüm biçimler; listede öğe başlıkları (en çok 1000 öğe). Video + liste adreslerinde (`watch?v=…&list=…`) önce
   yalnız video açılır, "Tüm listeyi aç" ile liste.
2. **Biçim seçimi** — Kullanılabilir çözünürlükler kısa kenara göre (dikey 1080×1920 = 1080p) basamaklanır. İndirmede
   `-f "bv*+ba/b" -S res:<H>` kullanılır: yt-dlp en büyük ≤ H çözünürlüğü, yoksa en küçük > H olanı seçer — arayüzdeki
   "en yakın düşük" kuralıyla aynı; oynatma listesinde her öğe ayrı analiz edilmeden doğru basamak seçilir. MP4'te
   H.264 + M4A tercih edilir (`ext:mp4:m4a,vcodec:h264`), uyumsuz akışlar MKV'ye düşer. Yalnız seste `-x --audio-format
   mp3|m4a|opus --audio-quality 128K…320K|0`.
3. **Kuyruk** — Durum makinesi: Sırada → İndiriliyor → Tamamlandı / Hata; Duraklatıldı ↔ Sırada; İptal → (Yeniden dene).
   Eşzamanlı 1–4 indirme; iki başlatma arasında nazik bekleme (varsayılan 2 sn); isteğe bağlı hız sınırı (`--limit-rate`).
   Her indirmenin geçici klasörü ayrıdır (`%APPDATA%\social-download\partial\<id>`): duraklatılan indirme `.part` dosyasından
   sürer, iptal edilenin yarım dosyaları silinir. Kuyruk `queue.json`'a yazılır; kapanıp açılınca süren indirmeler sıraya
   (ya da ayara göre duraklatılmışa) döner. İlerleme `--progress-template` ile makine okunur satırlardan; görüntü ve ses
   parçaları tek yüzdede birleşir, birleştirme / dönüştürme aşaması ayrıca gösterilir.
4. **Hatalar** — yt-dlp çıktısı anlaşılır nedenlere çevrilir: özel, giriş gerekli, yalnız üyeler, yaş doğrulaması, robot
   denetimi, ülke kısıtı, canlı yayın, 429 hız sınırı, desteklenmeyen sayfa, kaldırılmış içerik, disk dolu, izin yok,
   ağ hatası, FFmpeg yok … Ayrıntı satırı kuyruk öğesinin sağ tık menüsünde.

## Motor güncellemesi

Siteler sık değiştiği için yt-dlp uygulama içinden güncellenebilir (Ayarlar › Motor › **Motoru güncelle**; günde bir
denetim isteğe bağlı, yalnız bildirim):

1. `api.github.com/repos/yt-dlp/yt-dlp/releases/latest` etiketi okunur (yalnız bu depo; etiket biçimi denetlenir).
2. `SHA2-256SUMS` ve `SHA2-256SUMS.sig` indirilir; imza uygulamaya gömülü **yt-dlp imza anahtarıyla** (RSA 4096, parmak izi
   `AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581`) doğrulanır. Doğrulayıcı `src/openpgp.js` (dış kütüphane yok).
3. `yt-dlp.exe` indirilir, SHA-256'sı imzalı listeyle karşılaştırılır, çalıştırılıp `--version` etiketle aynı mı denetlenir;
   ancak sonra `%APPDATA%\social-download\engine\` altına konur (bir önceki kopya saklanır). "Uygulamayla geleni kullan" ile
   geri dönülür. Süren indirme varken güncelleme yapılmaz. FFmpeg yalnız uygulama sürümüyle güncellenir.

## Gizlilik ve yerel veri

| Veri | Yer | Sunucuya gider mi |
| --- | --- | --- |
| İndirilen dosyalar | Seçilen indirme klasörü (varsayılan `İndirilenler\Social Download`) | Hayır |
| Kuyruk | `%APPDATA%\social-download\queue.json` | Hayır |
| Küçük resim önbelleği (30 gün) | `%APPDATA%\social-download\thumbs\` | Hayır |
| Ayarlar | `store.json` | Şifreli senkron (indirme klasörü, pano, tepsi, başlangıç hariç) |
| Geçmiş (son 200) | `store.json` | İsteğe bağlı şifreli senkron; kapatılınca hesaptaki kopya silinir |
| Pano | — | Hayır; algılama varsayılan kapalı, yalnız pencere öne gelince yerelde okunur |

Bağlantılar ve dosyalar Mastertool sunucularından geçmez; indirme doğrudan bu bilgisayardan platforma yapılır.

## Bilinen sınırlar (tasarım gereği)

- **Yalnız herkese açık içerik.** Giriş gerektiren, özel, yalnız üyelere / abonelere açık, yaş doğrulaması isteyen içerik
  indirilmez ve bunun için bir ayar yoktur.
- **DRM yok.** Netflix, Spotify, Disney+, Prime Video, Max, Apple TV/Music, Deezer, Tidal, Crunchyroll vb. analiz bile
  edilmez; motor DRM'li biçimleri kullanmaz (`--allow-unplayable-formats` yasaklı), DRM atlatma yoktur.
- **Çerez / şifre yok.** yt-dlp her çağrıda `--ignore-config --no-cookies --no-cookies-from-browser` ile çalışır; `--cookies`,
  `--cookies-from-browser`, `--username/--password`, `--netrc`, `--exec`, `--add-header` gibi seçenekler kodda yasaklıdır
  (`FORBIDDEN_ARGS`, her çağrıda denetlenir). Tarayıcı çerezleri otomatik ya da elle içe aktarılmaz.
- **Canlı yayın kaydı yok**; yayın bitince indirilebilir. Yerel ağ adresleri (`localhost`, `192.168.x` …) analiz edilmez.
- Tek seferde en çok 25 bağlantı analiz edilir; bir listeden en çok 1000 öğe listelenir; kuyrukta en çok 2000 öğe.
- Robot denetimi / 429 gibi platform kısıtları atlatılmaz; kullanıcıya açıklanır, nazik bekleme ve yeniden deneme önerilir.
- Hız sınırı indirme başınadır (eşzamanlı N indirmede toplam N katı).

## Kısayollar

| Tuş | İşlem |
| --- | --- |
| Ctrl+V | Panodaki bağlantıyı yapıştır ve analiz et |
| Enter | Bağlantı çubuğunda analiz et (Shift+Enter yeni satır) |
| Ctrl+Enter | Seçilenleri indir (kuyruğa al) |
| Del | Seçilenleri kuyruktan / geçmişten kaldır |
| Boşluk | Seçilenleri duraklat / sürdür |
| F5 | Hatalı indirmeyi yeniden dene |
| Ctrl+A · ↑ ↓ | Tümünü seç · listede gezin |
| Ctrl+O | İndirme klasörünü aç |
| Ctrl+L | Bağlantı çubuğuna git |
| Ctrl+1 / Ctrl+2 | Kuyruk / Geçmiş |
| Ctrl+, | Ayarlar |
| Esc | Analizi iptal et / seçimi kaldır |

## Sürüm yayını

`vX.Y.Z` etiketi → `.github/workflows/release.yml`: `npm ci` → `npm test` → `node scripts/fetch-engine.js win64` (motor
indirme + doğrulama) → `electron-builder --win` → GitHub Release → `scripts/upload-socialdownload.sh` ile
`POST /api/sd/releases/<sürüm>/setup|portable` (≤ 90 MB parçalar, `X-Release-Key`). Depo secret'ı
`SOCIALDOWNLOAD_RELEASE_KEY` (ya da `SD_RELEASE_KEY`); sunucu `.env`'inde `SOCIALDOWNLOAD_RELEASE_KEY`. Elle yeniden yükleme:
Actions › "mastertool.download'a yükle".
