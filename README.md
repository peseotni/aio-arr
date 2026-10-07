<p align="center">
  <img src="web/public/favicon.svg" width="72" alt="AIO Arr logo" />
</p>

<h1 align="center">AIO Arr</h1>

<p align="center">
  <b>One login. One page. Your whole media stack.</b><br/>
  Search, download, watch and listen - Radarr, Sonarr, Lidarr, Prowlarr, Jellyfin, Navidrome, Audiobookshelf and your download clients, all from a single web app.
</p>

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="AIO Arr dashboard" width="900" />
</p>

---

## Why

Running an *arr stack means a dozen browser tabs and a dozen logins. AIO Arr sits on top of the apps you already have and gives you **one** place to:

- 🔎 **Search everything at once** - movies (Radarr), TV (Sonarr), music (Lidarr), books (Readarr) **and every indexer** (Prowlarr) for anything else: apps, games, ebooks, audiobooks…
- ⬇️ **Download with one click** - sensible defaults (quality profile, root folder, monitoring) are picked for you; advanced options and a manual release picker are one click away.
- ▶️ **Watch in Jellyfin with one click** - every movie, show and album that is in Jellyfin gets a *Watch / Listen* button that opens it directly on its Jellyfin page.
- 🎧 **Audio goes straight to your listening app** - music grabbed from your indexers is placed in your music library and Navidrome/Jellyfin are told to rescan; audiobooks go to Audiobookshelf. A *Listen* button appears when it's ready.
- 💾 **Everything else downloads to your PC** - apps, ebooks, games and other files show up under *Files* with a download link (folders are zipped on the fly, downloads can be resumed).
- 🔐 **One login** - AIO Arr talks to every service with its API key; you only sign in once (local accounts, your Jellyfin account, or your SSO).

<table>
  <tr>
    <td><img src="docs/screenshots/search.png" alt="Unified search" /></td>
    <td><img src="docs/screenshots/detail.png" alt="Movie details with Watch in Jellyfin" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/downloads.png" alt="Downloads across all clients" /></td>
    <td><img src="docs/screenshots/calendar.png" alt="Release calendar" /></td>
  </tr>
</table>

### Everything on one page

| | |
|---|---|
| **Home dashboard** | Continue watching & recently added (Jellyfin), active downloads with live speeds, what's airing this week, trending/recommended movies, service health and disk space |
| **Unified search** (`Ctrl/⌘ K`) | Movies, shows, artists, albums, books and raw indexer results side by side, with library / download / Jellyfin status on every result |
| **Libraries** | Movies, TV, music and books with filters (available / wanted / downloading / unmonitored), sorting, grid & list views |
| **Details** | Seasons & episodes (search or pick a release per season / episode, monitor toggles), albums, files & quality, links to IMDb/TMDB and the *arr app |
| **Downloads** | qBittorrent, Transmission, Deluge, SABnzbd and NZBGet in one list - each item shows what movie/episode it is, import problems reported by the *arr apps, pause/resume/remove, *blocklist & find another*, turtle (alt-speed) mode, and *Watch* once imported |
| **Calendar** | Agenda and month views of upcoming episodes, movie releases and albums |
| **Wanted** | Missing episodes / movies / albums with one-click search or *search all* |
| **Files** | Browse completed downloads, download files or whole folders (ZIP) to this device, move a folder into your music / audiobook library |
| **System** | Health of every service, disk space, indexer status, recent activity, and one-click maintenance (RSS sync, search all missing, Jellyfin rescan, indexer sync) |
| **Settings** | Auto-detect services and API keys, test each connection, choose defaults, manage users |

Also: responsive (works great on a phone, installable as a home-screen app), dark & light themes, multiple users with *admin* / *user* roles.

<p align="center">
  <img src="docs/screenshots/settings.png" alt="Settings with auto-detect and connection tests" width="640" />
  &nbsp;
  <img src="docs/screenshots/mobile.png" alt="AIO Arr on a phone" width="200" />
</p>

---

## Install (5 minutes)

You need a Linux machine (or NAS) with **Docker** and the **Docker Compose plugin**, where your *arr apps already run in Docker.

### Option A - the installer (recommended)

```bash
git clone https://github.com/peseotni/aio-arr.git
cd aio-arr
./install.sh
```

The installer:

1. finds your running Radarr, Sonarr, Lidarr, Readarr, Prowlarr, Bazarr, Jellyfin, Navidrome, Audiobookshelf, qBittorrent, Transmission, Deluge, SABnzbd and NZBGet containers,
2. reads their **API keys** automatically and works out the right internal addresses (including qBittorrent behind gluetun),
3. mounts the **same data folders** your apps use, so every path matches,
4. can create a **Jellyfin API key** for you (asks for a Jellyfin admin login once),
5. asks for your **subdomain** and sets up HTTPS (built-in Caddy) or hooks into your existing Traefik / Nginx Proxy Manager / SWAG,
6. creates your admin login and starts AIO Arr.

Run it again any time to re-detect. `AIO_YES=1 ./install.sh` accepts all defaults without questions.

### Option B - docker compose by hand

```bash
git clone https://github.com/peseotni/aio-arr.git && cd aio-arr
cp .env.example .env      # set ADMIN_PASSWORD, ARR_NETWORK, DATA_DIR and your API keys
docker compose up -d
```

Then open `http://<server-ip>:8080`. Anything you leave out of `.env` can be filled in later under **Settings** (there is an *Auto-detect services* button).

The two things that matter:

- **`ARR_NETWORK`** - the Docker network your apps are on (`docker network ls`; for a compose stack it's usually `<folder>_default`). AIO Arr reaches them by container name, e.g. `http://radarr:7878`.
- **Volumes** - mount your downloads/media the **same way** your *arr apps and download client do. With the common single-folder layout ([TRaSH guides](https://trash-guides.info/File-and-Folder-Structure/)) that is just `DATA_DIR=/your/data` → `/data`. If your apps use different paths (e.g. `/downloads`, `/movies`) add the same mounts, or set `PATH_MAPPINGS`.

> No image on GHCR yet / prefer to build yourself? `docker compose build` builds it from source.

---

## Put it on a subdomain

AIO Arr is a normal web app on port **8080**. Pick whatever matches your setup - in all cases AIO Arr and the proxy must share a Docker network (or point the proxy at `http://<server-ip>:8080`).

<details open>
<summary><b>Built-in Caddy (automatic HTTPS)</b> - easiest if you don't run a reverse proxy yet</summary>

1. Create a DNS record `arr.example.com` → your public IP, forward ports **80** and **443** to the server.
2. In `.env`:
   ```env
   AIO_DOMAIN=arr.example.com
   COMPOSE_FILE=docker-compose.yml:deploy/caddy/docker-compose.caddy.yml
   ```
3. `docker compose up -d` - Caddy gets a Let's Encrypt certificate on the first visit.
</details>

<details>
<summary><b>Traefik</b></summary>

```env
AIO_DOMAIN=arr.example.com
TRAEFIK_NETWORK=proxy          # network your Traefik container is on
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERTRESOLVER=letsencrypt
COMPOSE_FILE=docker-compose.yml:deploy/traefik/docker-compose.traefik.yml
```
</details>

<details>
<summary><b>Nginx Proxy Manager</b></summary>

*Hosts → Proxy Hosts → Add*: domain `arr.example.com`, scheme `http`, forward host `aio-arr`, port `8080` (NPM must be on the same Docker network as AIO Arr - otherwise use the server IP). On the SSL tab request a Let's Encrypt certificate and enable *Force SSL*. Under *Advanced* add `proxy_read_timeout 300s;` so long release searches don't time out.
</details>

<details>
<summary><b>SWAG (linuxserver)</b></summary>

Copy [`deploy/swag/aio-arr.subdomain.conf`](deploy/swag/aio-arr.subdomain.conf) to SWAG's `/config/nginx/proxy-confs/`, add `arr` to SWAG's `SUBDOMAINS`, restart SWAG.
</details>

<details>
<summary><b>Plain nginx / existing Caddy</b></summary>

See [`deploy/nginx/aio-arr.conf`](deploy/nginx/aio-arr.conf) and [`deploy/caddy/Caddyfile`](deploy/caddy/Caddyfile).
</details>

<details>
<summary><b>Cloudflare Tunnel</b> (no port forwarding)</summary>

In Zero Trust → Networks → Tunnels → your tunnel → *Public hostname*: `arr.example.com` → service `http://aio-arr:8080` (cloudflared on the same Docker network). Note Cloudflare stops requests after 100 s, so very slow indexer searches may need a retry.
</details>

**Make "Watch in Jellyfin" open the right address:** set Jellyfin's *public URL* (Settings → Apps → Jellyfin, or `JELLYFIN_PUBLIC_URL`) to the address you use in the browser, e.g. `https://jellyfin.example.com`. The same applies to Navidrome / Audiobookshelf for the *Listen* buttons.

---

## How downloads end up in the right place

| You grab… | What happens | Where you find it |
|---|---|---|
| A **movie / show / album / book** from search | Added to Radarr / Sonarr / Lidarr / Readarr with your defaults and searched immediately | Imported into your library → **Watch / Listen in Jellyfin** buttons appear (AIO Arr tells Jellyfin about new imports right away) |
| **Music** from the indexer search | Sent to your torrent/usenet client as `aio-music`; when done it is **hard-linked** (torrents keep seeding, no extra space) or moved into your music folder; Navidrome and Jellyfin rescan | **Listen in Navidrome / Jellyfin** button |
| An **audiobook** from the indexer search | Same, into your audiobook folder as `Author/Title`; Audiobookshelf rescans | **Listen in Audiobookshelf** |
| **Anything else** (apps, games, ebooks, …) | Sent to your client as `aio-files` | **Files** → *Download to this device* (folders as ZIP) |

You can override the type when grabbing (*Download as… music / audiobook / file*), or move a finished download into your music / audiobook library from **Files** later.

---

## Configuration reference

Everything can be set in the web UI. Environment variables are handy for automation:

| Variable | Description |
|---|---|
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Creates/updates this admin account on start (also the way to reset a forgotten password) |
| `AUTH_MODE` | `local` (default), `proxy` (trust `Remote-User` from Authelia/Authentik; see `AUTH_PROXY_HEADER`, `AUTH_PROXY_ADMINS`) or `none` (no login - LAN only!) |
| `JELLYFIN_LOGIN` | `off` / `admins` / `all` - let Jellyfin accounts sign in |
| `SETTINGS_FROM_ENV` | `override` (default): env values win and are read-only in the UI. `seed`: env only initialises settings on first start |
| `<SERVICE>_URL`, `_API_KEY`, `_USERNAME`, `_PASSWORD`, `_PUBLIC_URL` | For `RADARR`, `SONARR`, `LIDARR`, `READARR`, `PROWLARR`, `BAZARR`, `JELLYFIN`, `NAVIDROME`, `AUDIOBOOKSHELF`, `QBITTORRENT`, `TRANSMISSION`, `DELUGE`, `SABNZBD`, `NZBGET` |
| `MUSIC_PATH`, `AUDIOBOOKS_PATH` | Library folders (inside the container) for downloaded music / audiobooks |
| `DOWNLOADS_PATHS` | Comma separated folders shown in *Files* (default: whatever your clients report) |
| `PATH_MAPPINGS` | `client-path:aio-path` pairs, e.g. `/downloads:/data/torrents` |
| `IMPORT_MODE` | `auto` (hard link torrents, move usenet), `hardlink`, `copy` or `move` |
| `TORRENT_CLIENT`, `USENET_CLIENT` | Which client gets indexer grabs (default: first connected) |
| `PUID`, `PGID`, `TZ`, `UMASK` | Same meaning as in linuxserver.io images |
| `SESSION_DAYS` | How long a sign-in lasts (default 30) |
| `TRUST_PROXY` | Which proxy addresses may set `X-Forwarded-*` (default: private networks) |

Data is stored in `/config` (`settings.json`, `users.json`, `grabs.json`, `session.key`) - back up that folder.

---

## Security

- Passwords are hashed with scrypt; sessions are signed, HTTP-only, `SameSite=Lax` cookies (`Secure` behind HTTPS).
- API keys and passwords never reach the browser (masked in Settings); indexer download links stay on the server.
- State-changing requests require a custom header and a matching `Origin`, blocking CSRF even from sibling subdomains.
- Login attempts are rate limited; only reverse proxies on private networks are trusted for `X-Forwarded-*`.
- The *Files* browser only serves your download and library folders (symlinks resolved, `..` rejected).
- The container drops root and runs as `PUID:PGID`.
- Put it behind HTTPS (see above) before exposing it to the internet. Admins can change settings and delete; *users* can search, download, watch and listen.

---

## Troubleshooting

- **A service shows "host not found"** - AIO Arr isn't on the same Docker network. Check `ARR_NETWORK` (`docker network ls`, `docker inspect radarr`).
- **SABnzbd "hostname verification failed"** - handled automatically (AIO Arr retries via the container IP). You can also add `aio-arr`/`sabnzbd` to SABnzbd's *host_whitelist*.
- **Downloaded music isn't imported** - the folder isn't visible inside AIO Arr. Mount the downloads folder like your download client does, or add a path mapping. *Settings → Paths* shows whether the music folder exists and is writable.
- **No "Watch" button** - the item must be in a Jellyfin library and Jellyfin must have scanned it. Folder names like `Movie (2010) [tmdbid-12345]` (TRaSH naming) make matching instant.
- **Forgot the password** - set `ADMIN_PASSWORD` in `.env` and `docker compose up -d`.
- Logs: `docker logs aio-arr` (set `LOG_LEVEL=debug` for more).

---

## Development

```bash
npm run install:all
npm run dev:server          # API on :8080 (configure via env vars or the UI)
npm run dev:web             # UI on :5173 with hot reload, proxies /api to :8080
npm test && npm run typecheck
```

- `server/` - Node.js 22 + TypeScript + Fastify. Integrations live in `server/src/services`, the "glue" (search, downloads, post-processing, files) in `server/src/domain`.
- `web/` - React 19 + Vite + Tailwind CSS 4 + TanStack Query.
- `install.sh` - the installer; `deploy/` - reverse proxy examples.

CI (`.github/workflows/ci.yml`) type-checks, tests and builds everything; `docker-publish.yml` publishes multi-arch images (amd64/arm64) to `ghcr.io/peseotni/aio-arr` from `main` and `v*` tags.
