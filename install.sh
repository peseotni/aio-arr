#!/usr/bin/env bash
# =============================================================================
#  AIO Arr installer
#  - finds your running Radarr / Sonarr / Lidarr / Prowlarr / Jellyfin / download
#    clients, reads their API keys, mirrors their data folders
#  - optionally puts AIO Arr on a subdomain (Caddy with automatic HTTPS, or Traefik)
#  - writes .env + docker-compose.override.yml and starts the container
#
#  Usage:   ./install.sh                 (interactive)
#           AIO_YES=1 ./install.sh       (accept all defaults, no questions)
# =============================================================================
set -Eeuo pipefail

REPO_URL="https://github.com/peseotni/aio-arr"
DEFAULT_IMAGE="ghcr.io/peseotni/aio-arr:latest"

# ----------------------------------------------------------------------------- ui
if [ -t 1 ]; then
  B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=''; R=''; G=''; Y=''; C=''; N=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
trap 'die "installer stopped at line $LINENO"' ERR

[ "${BASH_VERSINFO[0]:-0}" -ge 4 ] || die "bash 4 or newer is required (on macOS: brew install bash)"

YES="${AIO_YES:-0}"
TTY=/dev/tty
[ -r "$TTY" ] || YES=1

ask() { # ask "Question" "default" -> answer
  local q="$1" def="${2:-}" a=''
  if [ "$YES" = "1" ]; then printf '%s' "$def"; return; fi
  if [ -n "$def" ]; then read -r -p "  $q [$def]: " a <"$TTY" || true; else read -r -p "  $q: " a <"$TTY" || true; fi
  printf '%s' "${a:-$def}"
}
ask_secret() {
  local q="$1" def="${2:-}" a=''
  if [ "$YES" = "1" ]; then printf '%s' "$def"; return; fi
  read -r -s -p "  $q${def:+ [keep current]}: " a <"$TTY" || true; echo >&2
  printf '%s' "${a:-$def}"
}
ask_yn() { # ask_yn "Question" y|n
  local a
  a=$(ask "$1 (y/n)" "$2")
  [[ "$a" =~ ^[Yy] ]]
}
rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "${1:-20}" || true; }

# ----------------------------------------------------------------------------- prerequisites
step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "Docker is not installed (https://docs.docker.com/engine/install/)"
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then DOCKER="sudo docker"
  else die "Cannot talk to Docker. Run as root, with sudo, or add your user to the 'docker' group."; fi
fi
$DOCKER compose version >/dev/null 2>&1 || die "The Docker Compose plugin (docker compose) is required"
ok "Docker $($DOCKER version --format '{{.Server.Version}}' 2>/dev/null) with $($DOCKER compose version --short 2>/dev/null)"

# ----------------------------------------------------------------------------- files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/Dockerfile" ]; then
  DIR="$SCRIPT_DIR"
else
  DIR="${AIO_DIR:-$HOME/aio-arr}"
  step "Downloading AIO Arr to $DIR"
  if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only || warn "could not update $DIR"
  elif command -v git >/dev/null 2>&1; then git clone --depth 1 "$REPO_URL.git" "$DIR"
  else
    mkdir -p "$DIR" && curl -fsSL "$REPO_URL/archive/HEAD.tar.gz" | tar -xz -C "$DIR" --strip-components=1
  fi
fi
cd "$DIR"
ok "Using $DIR"
[ -f .env ] && { cp .env ".env.backup.$(date +%Y%m%d%H%M%S)"; warn "Existing .env backed up"; }

# ----------------------------------------------------------------------------- discovery helpers
CONTAINERS=$($DOCKER ps --format '{{.Names}}\t{{.Image}}')

find_container() { # find_container regex -> first matching container name
  printf '%s\n' "$CONTAINERS" | awk -F'\t' -v pat="$1" 'tolower($1) ~ pat || tolower($2) ~ pat { print $1; exit }'
}
c_networks() { $DOCKER inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$1" 2>/dev/null; }
c_netmode()  { $DOCKER inspect -f '{{.HostConfig.NetworkMode}}' "$1" 2>/dev/null; }
c_env()      { $DOCKER inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n "s/^$2=//p" | head -n1; }
c_cat()      { $DOCKER exec "$1" cat "$2" 2>/dev/null || true; }
c_published() { # host port published for container port
  $DOCKER port "$1" "$2/tcp" 2>/dev/null | head -n1 | sed 's/.*://'
}
xml_value() { sed -n "s:.*<$1>\(.*\)</$1>.*:\1:p" | head -n1; }

HOST_IP=$( (hostname -I 2>/dev/null || true) | awk '{print $1}')
[ -n "$HOST_IP" ] || HOST_IP=$( (ip route get 1.1.1.1 2>/dev/null || true) | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1)
[ -n "$HOST_IP" ] || HOST_IP="localhost"

declare -A URL KEY USERN PASS PUB
declare -a NETWORKS=()
add_network() {
  local n
  for n in $1; do
    case "$n" in host|none|bridge|"") continue ;; esac
    [[ " ${NETWORKS[*]:-} " == *" $n "* ]] || NETWORKS+=("$n")
  done
}

# resolve service -> URL reachable from the aio-arr container
service_url() { # service_url container port [urlbase]
  local c="$1" port="$2" base="${3:-}" mode host
  mode=$(c_netmode "$c")
  host="$c"
  if [[ "$mode" == container:* ]]; then
    # running inside another container's network (e.g. qBittorrent behind gluetun)
    host=$($DOCKER inspect -f '{{.Name}}' "${mode#container:}" 2>/dev/null | sed 's:^/::')
  elif [ "$mode" = "host" ] || [[ " $(c_networks "$c") " == *" bridge "* && -z "$(c_networks "$c" | tr ' ' '\n' | grep -vx bridge || true)" ]]; then
    host="host.docker.internal"
    port=$(c_published "$c" "$port" || true); port="${port:-$2}"
  fi
  printf 'http://%s:%s%s' "$host" "$port" "$base"
}

# remember the docker networks of a detected container (runs in the main shell, not in $(...))
use_container() {
  local c="$1" mode
  mode=$(c_netmode "$c")
  if [[ "$mode" == container:* ]]; then
    c=$($DOCKER inspect -f '{{.Name}}' "${mode#container:}" 2>/dev/null | sed 's:^/::')
  fi
  add_network "$(c_networks "$c")"
}

public_url() { # public_url container port -> http://LAN-IP:published-port
  local p
  p=$(c_published "$1" "$2" || true)
  [ -n "$p" ] && printf 'http://%s:%s' "$HOST_IP" "$p"
}

detect_arr() { # detect_arr id pattern port
  local id="$1" pat="$2" port="$3" c cfg key base
  c=$(find_container "$pat")
  [ -n "$c" ] || return 0
  use_container "$c"
  cfg=$(c_cat "$c" /config/config.xml)
  key=$(printf '%s' "$cfg" | xml_value ApiKey)
  base=$(printf '%s' "$cfg" | xml_value UrlBase)
  port=$(printf '%s' "$cfg" | xml_value Port || true); port="${port:-$3}"
  URL[$id]=$(service_url "$c" "$port" "$base")
  KEY[$id]="$key"
  PUB[$id]=$(public_url "$c" "$port" || true)
  if [ -n "$key" ]; then ok "$id: ${URL[$id]} (API key found)"; else warn "$id: ${URL[$id]} (API key not found - add it later in Settings)"; fi
}

# ----------------------------------------------------------------------------- detect services
step "Looking for your media stack"
detect_arr radarr 'radarr' 7878
detect_arr sonarr 'sonarr' 8989
detect_arr lidarr 'lidarr' 8686
detect_arr readarr 'readarr' 8787
detect_arr prowlarr 'prowlarr' 9696

c=$(find_container 'bazarr')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  URL[bazarr]=$(service_url "$c" 6767)
  KEY[bazarr]=$(c_cat "$c" /config/config/config.yaml | awk '/^auth:/{f=1} f && /apikey:/{print $2; exit}' | tr -d "'\"")
  PUB[bazarr]=$(public_url "$c" 6767 || true)
  ok "bazarr: ${URL[bazarr]}"
fi

c=$(find_container 'jellyfin')
[ -n "$c" ] && use_container "$c"
JF_CONTAINER="$c"
if [ -n "$c" ]; then
  URL[jellyfin]=$(service_url "$c" 8096)
  PUB[jellyfin]=$(public_url "$c" 8096 || true)
  ok "jellyfin: ${URL[jellyfin]}"
fi

c=$(find_container 'navidrome')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then URL[navidrome]=$(service_url "$c" 4533); PUB[navidrome]=$(public_url "$c" 4533 || true); ok "navidrome: ${URL[navidrome]}"; fi

c=$(find_container 'audiobookshelf')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  p=80; [ -n "$(c_env "$c" PORT)" ] && p=$(c_env "$c" PORT)
  URL[audiobookshelf]=$(service_url "$c" "$p"); PUB[audiobookshelf]=$(public_url "$c" "$p" || true); ok "audiobookshelf: ${URL[audiobookshelf]}"
fi

c=$(find_container '^plex$|(^|/)plex(:|$)|pms-docker')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  URL[plex]=$(service_url "$c" 32400)
  # the server's own sign-in token
  KEY[plex]=$(c_cat "$c" "/config/Library/Application Support/Plex Media Server/Preferences.xml" | sed -n 's/.*PlexOnlineToken="\([^"]*\)".*/\1/p' | head -n1)
  # links open the Plex web app on app.plex.tv (works at home and away) unless you set your own address later
  if [ -n "${KEY[plex]}" ]; then ok "plex: ${URL[plex]} (token found)"; else warn "plex: ${URL[plex]} (token not found - add it later in Settings)"; fi
fi

c=$(find_container '^emby$|(^|/)emby(server)?(:|$)')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  URL[emby]=$(service_url "$c" 8096); PUB[emby]=$(public_url "$c" 8096 || true)
  warn "emby: ${URL[emby]} (create its API key later: Settings > Emby > 'Create API key')"
fi

c=$(find_container 'komga')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  p=$(c_env "$c" SERVER_PORT); p="${p:-25600}"
  URL[komga]=$(service_url "$c" "$p"); PUB[komga]=$(public_url "$c" "$p" || true)
  warn "komga: ${URL[komga]} (add an API key or your login later in Settings)"
fi

c=$(find_container 'kavita')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  URL[kavita]=$(service_url "$c" 5000); PUB[kavita]=$(public_url "$c" 5000 || true)
  warn "kavita: ${URL[kavita]} (add your API key later in Settings)"
fi

c=$(find_container 'jellyseerr|overseerr')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  URL[jellyseerr]=$(service_url "$c" 5055); PUB[jellyseerr]=$(public_url "$c" 5055 || true)
  # settings.json: the first "apiKey" inside the "main" block (official image: /app/config, linuxserver: /config)
  KEY[jellyseerr]=$( { c_cat "$c" /app/config/settings.json; c_cat "$c" /config/settings.json; } | awk '/"main"[[:space:]]*:/ {f=1} f && /"apiKey"/ { sub(/.*"apiKey"[[:space:]]*:[[:space:]]*"/, ""); sub(/".*/, ""); print; exit }')
  if [ -n "${KEY[jellyseerr]}" ]; then ok "jellyseerr: ${URL[jellyseerr]} (API key found)"; else warn "jellyseerr: ${URL[jellyseerr]} (API key not found - add it later in Settings)"; fi
fi

c=$(find_container 'qbittorrent')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  p=$(c_env "$c" WEBUI_PORT); p="${p:-8080}"
  URL[qbittorrent]=$(service_url "$c" "$p"); USERN[qbittorrent]="admin"; ok "qbittorrent: ${URL[qbittorrent]}"
fi
c=$(find_container 'transmission')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then URL[transmission]=$(service_url "$c" 9091); USERN[transmission]=$(c_env "$c" USER); PASS[transmission]=$(c_env "$c" PASS); ok "transmission: ${URL[transmission]}"; fi
c=$(find_container 'deluge')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then URL[deluge]=$(service_url "$c" 8112); PASS[deluge]="deluge"; ok "deluge: ${URL[deluge]}"; fi
c=$(find_container 'sabnzbd')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  URL[sabnzbd]=$(service_url "$c" 8080)
  KEY[sabnzbd]=$(c_cat "$c" /config/sabnzbd.ini | sed -n 's/^api_key *= *//p' | head -n1)
  ok "sabnzbd: ${URL[sabnzbd]}"
fi
c=$(find_container 'nzbget')
[ -n "$c" ] && use_container "$c"
if [ -n "$c" ]; then
  conf=$(c_cat "$c" /config/nzbget.conf)
  URL[nzbget]=$(service_url "$c" 6789)
  USERN[nzbget]=$(printf '%s' "$conf" | sed -n 's/^ControlUsername=//p' | head -n1)
  PASS[nzbget]=$(printf '%s' "$conf" | sed -n 's/^ControlPassword=//p' | head -n1)
  ok "nzbget: ${URL[nzbget]}"
fi

[ "${#URL[@]}" -gt 0 ] || warn "No *arr containers found. That's OK - you can add everything in the web UI later."

# ----------------------------------------------------------------------------- folders
step "Folders"
# mirror the data mounts of the *arr apps / download clients so every path they report also exists in AIO Arr
declare -A MOUNTS
for name in $(printf '%s\n' "$CONTAINERS" | awk -F'\t' 'tolower($1) ~ /radarr|sonarr|lidarr|readarr|qbittorrent|transmission|deluge|sabnzbd|nzbget/ {print $1}'); do
  while IFS='|' read -r src dst; do
    [ -n "$dst" ] || continue
    case "$dst" in /config|/config/*|/app*|/etc/*|/var/run/*|/run/*|/dev/*|/tmp*) continue ;; esac
    if [ -z "${MOUNTS[$dst]:-}" ]; then MOUNTS[$dst]="$src"
    elif [ "${MOUNTS[$dst]}" != "$src" ]; then warn "$name mounts $src at $dst, another container mounts ${MOUNTS[$dst]} there - using the first"; fi
  done < <($DOCKER inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}|{{.Destination}}{{println}}{{end}}{{end}}' "$name" 2>/dev/null)
done
if [ "${#MOUNTS[@]}" -eq 0 ]; then
  d=$(ask "Host folder that contains your downloads and media" "/data")
  MOUNTS[/data]="$d"
fi
for dst in "${!MOUNTS[@]}"; do ok "${MOUNTS[$dst]} -> $dst"; done

guess_dir() { # find a folder named like $1 under the mounted destinations, as seen by the lidarr/radarr container
  local want="$1" c
  for c in $(find_container lidarr) $(find_container radarr) $(find_container qbittorrent); do
    [ -n "$c" ] || continue
    $DOCKER exec "$c" sh -c "for b in $(printf '%s ' "${!MOUNTS[@]}"); do for d in \"\$b/$want\" \"\$b/media/$want\" \"\$b/library/$want\"; do [ -d \"\$d\" ] && { echo \"\$d\"; exit 0; }; done; done" 2>/dev/null && return 0
  done
  return 0
}
MUSIC_GUESS=$(guess_dir music | head -n1)
BOOKS_GUESS=$(guess_dir audiobooks | head -n1)
EBOOKS_GUESS=$( { guess_dir books; guess_dir ebooks; } | head -n1)
COMICS_GUESS=$(guess_dir comics | head -n1)
first_mount=$(printf '%s\n' "${!MOUNTS[@]}" | sort | head -n1)
info "Things you download from your indexers are put into these library folders (paths inside the container)."
MUSIC_PATH=$(ask "Music library folder" "${MUSIC_GUESS:-$first_mount/media/music}")
AUDIOBOOKS_PATH=$(ask "Audiobook library folder" "${BOOKS_GUESS:-$first_mount/media/audiobooks}")
EBOOKS_PATH=$(ask "Book (ebook) library folder" "${EBOOKS_GUESS:-$first_mount/media/books}")
COMICS_PATH=$(ask "Comics library folder" "${COMICS_GUESS:-$first_mount/media/comics}")

# ----------------------------------------------------------------------------- credentials that cannot be read
step "Logins"
if [ -n "${URL[qbittorrent]:-}" ]; then
  PASS[qbittorrent]=$(ask_secret "qBittorrent WebUI password (leave empty if auth is bypassed for your network)" "${QBITTORRENT_PASSWORD:-}")
fi
if [ -n "${URL[deluge]:-}" ] && [ "$YES" != "1" ]; then
  PASS[deluge]=$(ask_secret "Deluge WebUI password" "deluge")
fi
if [ -n "${URL[navidrome]:-}" ]; then
  USERN[navidrome]=$(ask "Navidrome username" "${NAVIDROME_USERNAME:-}")
  [ -n "${USERN[navidrome]}" ] && PASS[navidrome]=$(ask_secret "Navidrome password" "${NAVIDROME_PASSWORD:-}")
fi

if [ -n "$JF_CONTAINER" ]; then
  KEY[jellyfin]="${JELLYFIN_API_KEY:-}"
  if [ -z "${KEY[jellyfin]}" ] && [ "$YES" != "1" ] && ask_yn "Create a Jellyfin API key now? (needs a Jellyfin admin login, used once)" y; then
    ju=$(ask "Jellyfin admin username" "")
    jp=$(ask_secret "Jellyfin admin password" "")
    hdr='MediaBrowser Client="AIO Arr Installer", Device="install.sh", DeviceId="aio-arr-install", Version="1.0"'
    body=$(printf '{"Username":"%s","Pw":"%s"}' "$(printf '%s' "$ju" | sed 's/["\\]/\\&/g')" "$(printf '%s' "$jp" | sed 's/["\\]/\\&/g')")
    token=$($DOCKER exec "$JF_CONTAINER" curl -fsS -X POST "http://localhost:8096/Users/AuthenticateByName" -H "Content-Type: application/json" -H "Authorization: $hdr" -d "$body" 2>/dev/null | sed -n 's/.*"AccessToken":"\([^"]*\)".*/\1/p' || true)
    if [ -n "$token" ]; then
      $DOCKER exec "$JF_CONTAINER" curl -fsS -X POST "http://localhost:8096/Auth/Keys?app=AIO%20Arr" -H "Authorization: $hdr, Token=\"$token\"" >/dev/null 2>&1 || true
      KEY[jellyfin]=$($DOCKER exec "$JF_CONTAINER" curl -fsS "http://localhost:8096/Auth/Keys" -H "Authorization: $hdr, Token=\"$token\"" 2>/dev/null | tr '{' '\n' | grep '"AppName":"AIO Arr"' | tail -n1 | sed -n 's/.*"AccessToken":"\([^"]*\)".*/\1/p' || true)
    fi
    if [ -n "${KEY[jellyfin]}" ]; then ok "Jellyfin API key created"; else warn "Could not create the key automatically - use Settings > Jellyfin > 'Create API key' in the web UI"; fi
  fi
fi

# recommendations: TMDB (free key) unless Jellyseerr / Overseerr was found
TMDB_API_KEY="${TMDB_API_KEY:-}"
if [ -z "$TMDB_API_KEY" ] && [ -z "${URL[jellyseerr]:-}" ] && [ "$YES" != "1" ]; then
  TMDB_API_KEY=$(ask "TMDB API key for personal recommendations (free at themoviedb.org, empty = skip)" "")
fi

# one-click app updates need the Docker socket - that is a lot of power, so only when asked for
DOCKER_SOCKET="${AIO_DOCKER_SOCKET:-}"
if [ -z "$DOCKER_SOCKET" ] && [ "$YES" != "1" ]; then
  info "AIO Arr can update your apps (and itself) with one click. For that it needs the Docker socket,"
  info "which gives it full control over Docker on this machine - as powerful as root."
  if ask_yn "Enable one-click updates?" n; then DOCKER_SOCKET=1; else DOCKER_SOCKET=0; fi
fi

ADMIN_USERNAME=$(ask "AIO Arr admin username" "${ADMIN_USERNAME:-admin}")
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASSWORD" ]; then
  if [ "$YES" = "1" ]; then ADMIN_PASSWORD=$(rand 20); GENERATED_PW=1
  else
    while :; do
      ADMIN_PASSWORD=$(ask_secret "AIO Arr admin password (min. 8 characters, empty = generate one)" "")
      [ -z "$ADMIN_PASSWORD" ] && { ADMIN_PASSWORD=$(rand 20); GENERATED_PW=1; break; }
      [ "${#ADMIN_PASSWORD}" -ge 8 ] && break
      warn "Too short"
    done
  fi
fi

# ----------------------------------------------------------------------------- subdomain / proxy
step "Access & subdomain"
PROXY_DETECTED=""
[ -n "$(find_container 'traefik')" ] && PROXY_DETECTED="traefik"
[ -z "$PROXY_DETECTED" ] && [ -n "$(find_container 'nginx-proxy-manager|jc21/nginx-proxy')" ] && PROXY_DETECTED="npm"
[ -z "$PROXY_DETECTED" ] && [ -n "$(find_container 'swag')" ] && PROXY_DETECTED="swag"
[ -z "$PROXY_DETECTED" ] && [ -n "$(find_container 'caddy')" ] && PROXY_DETECTED="other"
[ -n "$PROXY_DETECTED" ] && info "Detected an existing reverse proxy: ${B}$PROXY_DETECTED${N}"

AIO_DOMAIN=$(ask "Subdomain for AIO Arr, e.g. arr.example.com (empty = local network only)" "${AIO_DOMAIN:-}")
PROXY="none"
if [ -n "$AIO_DOMAIN" ]; then
  info "How should ${AIO_DOMAIN} reach AIO Arr?"
  info "  1) caddy   - built-in Caddy with automatic HTTPS (needs ports 80/443 + DNS pointing here)"
  info "  2) traefik - use my existing Traefik"
  info "  3) npm     - Nginx Proxy Manager (I'll tell you what to enter)"
  info "  4) swag    - linuxserver SWAG (a proxy config file is provided)"
  info "  5) other   - another proxy / Cloudflare Tunnel (I'll print the target)"
  def="${PROXY_DETECTED:-caddy}"
  PROXY=$(ask "Choose" "$def")
  case "$PROXY" in 1) PROXY=caddy;; 2) PROXY=traefik;; 3) PROXY=npm;; 4) PROXY=swag;; 5) PROXY=other;; esac
fi

COMPOSE_FILES="docker-compose.yml:docker-compose.override.yml"
TRAEFIK_NETWORK=""; TRAEFIK_ENTRYPOINT=""; TRAEFIK_CERTRESOLVER=""
case "$PROXY" in
  caddy) COMPOSE_FILES="$COMPOSE_FILES:deploy/caddy/docker-compose.caddy.yml" ;;
  traefik)
    tc=$(find_container 'traefik')
    tnet=$( [ -n "$tc" ] && c_networks "$tc" | tr ' ' '\n' | grep -vx bridge | head -n1 || true)
    TRAEFIK_NETWORK=$(ask "Docker network Traefik uses" "${tnet:-proxy}")
    TRAEFIK_ENTRYPOINT=$(ask "Traefik HTTPS entrypoint name" "websecure")
    TRAEFIK_CERTRESOLVER=$(ask "Traefik certificate resolver name" "letsencrypt")
    COMPOSE_FILES="$COMPOSE_FILES:deploy/traefik/docker-compose.traefik.yml" ;;
  npm|swag|other)
    pc=$(find_container 'nginx-proxy-manager|jc21/nginx-proxy|swag|caddy|nginx' || true)
    [ -n "$pc" ] && add_network "$(c_networks "$pc")" ;;
esac
AIO_PORT=$(ask "Port for direct access on your network" "${AIO_PORT:-8080}")

# public URL for the "Watch in Jellyfin" buttons
JF_PUBLIC_DEFAULT="${PUB[jellyfin]:-}"
if [ -n "$AIO_DOMAIN" ] && [ -n "${URL[jellyfin]:-}" ]; then JF_PUBLIC_DEFAULT="https://jellyfin.${AIO_DOMAIN#*.}"; fi
if [ -n "${URL[jellyfin]:-}" ]; then
  PUB[jellyfin]=$(ask "Address you use to open Jellyfin in your browser" "$JF_PUBLIC_DEFAULT")
fi

# ----------------------------------------------------------------------------- user / time zone
PUID_DEFAULT="$(id -u)"; PGID_DEFAULT="$(id -g)"
ref=$(find_container 'radarr|sonarr|qbittorrent')
if [ -n "$ref" ] && [ -n "$(c_env "$ref" PUID)" ]; then PUID_DEFAULT=$(c_env "$ref" PUID); PGID_DEFAULT=$(c_env "$ref" PGID); fi
[ "$PUID_DEFAULT" = "0" ] && PUID_DEFAULT=1000 && PGID_DEFAULT=1000
TZ_DEFAULT=$(cat /etc/timezone 2>/dev/null || (timedatectl show -p Timezone --value 2>/dev/null) || echo "Etc/UTC")
[ -n "$ref" ] && [ -n "$(c_env "$ref" TZ)" ] && TZ_DEFAULT=$(c_env "$ref" TZ)

# ----------------------------------------------------------------------------- write files
step "Writing configuration"
if [ "${#NETWORKS[@]}" -eq 0 ]; then
  NETWORKS=("aio-arr")
  $DOCKER network inspect aio-arr >/dev/null 2>&1 || $DOCKER network create aio-arr >/dev/null
  warn "Your apps are not on a user-defined docker network; AIO Arr reaches them through host.docker.internal"
fi

envline() { # envline NAME value -> only when value non-empty, quoted the way docker compose reads .env files
  [ -n "${2:-}" ] || return 0
  case "$2" in
    *"'"*) # contains a single quote: double quotes, escape \ and ", and $ (compose interpolation) as $$
      printf '%s="%s"\n' "$1" "$(printf '%s' "$2" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/$$/g')" ;;
    *) printf "%s='%s'\n" "$1" "$2" ;; # single quotes are taken literally
  esac
}

umask 077
{
  echo "# Generated by install.sh on $(date). Edit freely - see .env.example for all options."
  envline COMPOSE_FILE "$COMPOSE_FILES"
  envline AIO_IMAGE "${AIO_IMAGE:-$DEFAULT_IMAGE}"
  envline PUID "$PUID_DEFAULT"
  envline PGID "$PGID_DEFAULT"
  envline TZ "$TZ_DEFAULT"
  envline AIO_PORT "$AIO_PORT"
  envline ARR_NETWORK "${NETWORKS[0]}"
  envline ADMIN_USERNAME "$ADMIN_USERNAME"
  envline ADMIN_PASSWORD "$ADMIN_PASSWORD"
  echo "SETTINGS_FROM_ENV=seed"
  envline AIO_DOMAIN "$AIO_DOMAIN"
  envline TRAEFIK_NETWORK "$TRAEFIK_NETWORK"
  envline TRAEFIK_ENTRYPOINT "$TRAEFIK_ENTRYPOINT"
  envline TRAEFIK_CERTRESOLVER "$TRAEFIK_CERTRESOLVER"
  envline MUSIC_PATH "$MUSIC_PATH"
  envline AUDIOBOOKS_PATH "$AUDIOBOOKS_PATH"
  envline EBOOKS_PATH "$EBOOKS_PATH"
  envline COMICS_PATH "$COMICS_PATH"
  envline TMDB_API_KEY "$TMDB_API_KEY"
  for id in radarr sonarr lidarr readarr prowlarr bazarr jellyfin plex emby navidrome audiobookshelf komga kavita jellyseerr qbittorrent transmission deluge sabnzbd nzbget; do
    [ -n "${URL[$id]:-}" ] || continue
    P=$(printf '%s' "$id" | tr '[:lower:]' '[:upper:]')
    envline "${P}_URL" "${URL[$id]}"
    envline "${P}_API_KEY" "${KEY[$id]:-}"
    envline "${P}_USERNAME" "${USERN[$id]:-}"
    envline "${P}_PASSWORD" "${PASS[$id]:-}"
    envline "${P}_PUBLIC_URL" "${PUB[$id]:-}"
  done
} > .env
umask 022
ok ".env written (only readable by you)"

{
  echo "# Generated by install.sh - mirrors the folders and networks of your media stack."
  echo "services:"
  echo "  aio-arr:"
  echo "    volumes:"
  for dst in $(printf '%s\n' "${!MOUNTS[@]}" | sort); do printf "      - \"%s:%s\"\n" "${MOUNTS[$dst]}" "$dst"; done
  # one-click updates (Settings > Updates)
  [ "${DOCKER_SOCKET:-0}" = "1" ] && echo "      - /var/run/docker.sock:/var/run/docker.sock"
  # the first network is already attached as "arr" (ARR_NETWORK) by docker-compose.yml
  if [ "${#NETWORKS[@]}" -gt 1 ]; then
    echo "    networks:"
    for n in "${NETWORKS[@]:1}"; do printf "      - %s\n" "$n"; done
    echo "networks:"
    for n in "${NETWORKS[@]:1}"; do printf "  %s:\n    name: %s\n    external: true\n" "$n" "$n"; done
  fi
} > docker-compose.override.yml
ok "docker-compose.override.yml written"

# the default /data mount from docker-compose.yml is replaced by the mirrored ones
if [ -z "${MOUNTS[/data]:-}" ]; then
  first_src=$(printf '%s\n' "${MOUNTS[@]}" | head -n1)
  printf "DATA_DIR='%s'\n" "$first_src" >> .env
else
  printf "DATA_DIR='%s'\n" "${MOUNTS[/data]}" >> .env
fi
mkdir -p config

# ----------------------------------------------------------------------------- start
step "Starting AIO Arr"
IMAGE="${AIO_IMAGE:-$DEFAULT_IMAGE}"
PULLED=0
if [ -z "${AIO_BUILD:-}" ] && $DOCKER compose pull aio-arr >/dev/null 2>&1; then
  ok "Pulled $IMAGE"; PULLED=1
elif [ -z "${AIO_BUILD:-}" ] && $DOCKER image inspect "$IMAGE" >/dev/null 2>&1; then
  ok "Using the local image $IMAGE"
else
  info "Building the image locally (takes a minute or two the first time)…"
  $DOCKER compose build aio-arr
fi
$DOCKER compose up -d
for _ in $(seq 1 30); do
  st=$($DOCKER inspect -f '{{.State.Health.Status}}' aio-arr 2>/dev/null || echo starting)
  [ "$st" = "healthy" ] && break
  sleep 2
done
[ "${st:-}" = "healthy" ] && ok "AIO Arr is running" || warn "AIO Arr did not report healthy yet - check: docker logs aio-arr"

# ----------------------------------------------------------------------------- summary
step "Done!"
info "Open on your network:   ${B}http://${HOST_IP}:${AIO_PORT}${N}"
[ -n "$AIO_DOMAIN" ] && info "Subdomain:              ${B}https://${AIO_DOMAIN}${N}"
info "Sign in as:             ${B}${ADMIN_USERNAME}${N}"
[ "${GENERATED_PW:-0}" = "1" ] && info "Generated password:     ${B}${ADMIN_PASSWORD}${N}   (change it under your account menu)"
case "$PROXY" in
  caddy) info ""; info "Make sure the DNS record ${AIO_DOMAIN} points to this server and ports 80/443 are forwarded."
         info "Caddy requests the HTTPS certificate automatically on first visit." ;;
  traefik) info ""; info "Traefik routes ${AIO_DOMAIN} to AIO Arr (network: ${TRAEFIK_NETWORK})." ;;
  npm) info ""; info "In Nginx Proxy Manager add a Proxy Host:"
       info "  Domain: ${AIO_DOMAIN}   Scheme: http   Forward host: aio-arr   Port: 8080"
       info "  SSL: request a Let's Encrypt certificate, enable Force SSL and HTTP/2." ;;
  swag) info ""; info "Copy deploy/swag/aio-arr.subdomain.conf to SWAG's /config/nginx/proxy-confs/ and restart SWAG." ;;
  other) info ""; info "Point ${AIO_DOMAIN} at http://aio-arr:8080 (same docker network) or http://${HOST_IP}:${AIO_PORT}."
         info "Cloudflare Tunnel: add a public hostname ${AIO_DOMAIN} -> http://aio-arr:8080." ;;
esac
info ""
info "Everything detected is pre-filled - review it any time under Settings."
[ "${DOCKER_SOCKET:-0}" = "1" ] && info "One-click updates of your apps: Settings > Updates."
# a locally built image can't be pulled - update the source and rebuild instead
if [ "$PULLED" = "1" ]; then
  info "Update later with:  cd $DIR && $DOCKER compose pull && $DOCKER compose up -d"
elif [ -d "$DIR/.git" ]; then
  info "Update later with:  cd $DIR && git pull && $DOCKER compose up -d --build"
else
  info "Update later with:  cd $DIR && curl -fsSL $REPO_URL/archive/HEAD.tar.gz | tar -xz --strip-components=1 && $DOCKER compose up -d --build"
fi
