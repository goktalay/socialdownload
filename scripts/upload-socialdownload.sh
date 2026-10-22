#!/usr/bin/env bash
# Exe'leri mastertool.download'a yükler (uygulama kodu "sd").
# Kullanım: upload-socialdownload.sh <sürüm> <setup.exe> [notlar] [portable.exe]
# Anahtar SOCIALDOWNLOAD_RELEASE_KEY ortam değişkeninden okunur; tanımlı değilse uyarı verip çıkar.
#
# Kurulum: POST /api/sd/releases/<sürüm>/setup  (Social-Download-Setup-<sürüm>.exe), ≤ 90 MB parçalar halinde.
# Portable: POST /api/sd/releases/<sürüm>/portable (Social-Download-Portable-<sürüm>.exe), parçalı. İsteğe bağlıdır: uç henüz
#          yoksa (404) ya da yükleme başarısızsa uyarı verilir, yayın başarısız sayılmaz.
# Sunucunun önündeki Cloudflare tek istekte 100 MB üstünü reddeder (413); parçalama bunun için.
set -euo pipefail

VERSION="$1"
SETUP="$2"
NOTES="${3:-}"
PORTABLE="${4:-}"
[ -n "$NOTES" ] || NOTES="Social Download $VERSION"
API="${SOCIALDOWNLOAD_API:-https://mastertool.download}/api/sd/releases"
PART_BYTES="${SOCIALDOWNLOAD_PART_BYTES:-90000000}"     # test için küçültülebilir

if [ -z "${SOCIALDOWNLOAD_RELEASE_KEY:-}" ]; then
  echo "::warning::SOCIALDOWNLOAD_RELEASE_KEY tanımlı değil; mastertool.download'a yükleme atlandı."
  exit 0
fi

post() { # post <url> <curl -F argümanları...>  → HTTP kodu; gövde response.json'a
  local url="$1"; shift
  curl -sS -o response.json -w '%{http_code}' -X POST "$url" -H "X-Release-Key: $SOCIALDOWNLOAD_RELEASE_KEY" "$@"
}

# Dosyayı ≤ PART_BYTES parçalar halinde sırayla gönderir; son HTTP kodunu yazdırır
post_parts() { # post_parts <url> <dosya> <dosya adı> [ek -F argümanları...]
  local url="$1" file="$2" name="$3"; shift 3
  # Göreli geçici klasör: Windows'taki curl, Git Bash'in /tmp yollarını okuyamaz
  local dir; dir=$(mktemp -d ./.sd-parts.XXXXXX)
  split -b "$PART_BYTES" -d -a 3 "$file" "$dir/part."
  local parts=( "$dir"/part.* ) total=${#parts[@]} i=0 code=""
  for p in "${parts[@]}"; do
    code=$(post "$url" -F "file=@$p;filename=$name" -F "part=$i" -F "parts=$total" -F "filename=$name" "$@")
    echo "  parça $((i + 1))/$total → HTTP $code $(cat response.json)" >&2
    case "$code" in 200|201) ;; *) break ;; esac
    i=$((i + 1))
  done
  rm -rf "$dir"
  echo "$code"
}

# --- Kurulum ------------------------------------------------------------------
SIZE=$(stat -c %s "$SETUP")
echo "Kurulum: $SETUP ($SIZE bayt), sürüm $VERSION"
HTTP=$(post_parts "$API/$VERSION/setup" "$SETUP" "$(basename "$SETUP")" -F "notes=$NOTES")
case "$HTTP" in
  200|201) echo "mastertool.download: kurulum $VERSION yüklendi." ;;
  409) echo "::notice::mastertool.download'da $VERSION kurulumu zaten var (409); atlandı." ;;
  *) echo "::error::Kurulum yüklemesi başarısız (HTTP $HTTP)."; exit 1 ;;
esac

# --- Portable (isteğe bağlı) ----------------------------------------------------
if [ -n "$PORTABLE" ] && [ -f "$PORTABLE" ]; then
  echo "Portable: $PORTABLE ($(stat -c %s "$PORTABLE") bayt)"
  HTTP=$(post_parts "$API/$VERSION/portable" "$PORTABLE" "$(basename "$PORTABLE")") || HTTP=000
  case "$HTTP" in
    200|201) echo "mastertool.download: portable $VERSION yüklendi." ;;
    409) echo "::notice::mastertool.download'da $VERSION portable zaten var (409); atlandı." ;;
    404) echo "::warning::Portable yükleme ucu yok ya da sürüm bulunamadı (404); portable atlandı." ;;
    *) echo "::warning::Portable yüklemesi başarısız (HTTP $HTTP); kurulum yüklendiği için yayın sürüyor." ;;
  esac
fi
