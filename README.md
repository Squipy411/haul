# Haul

<img src="web/public/icon.png" width="56" align="right" alt="" />

A self-hosted downloader for films and series that runs everything through [TorBox](https://torbox.app). Pick a title, choose a season pack or let Haul assemble the whole season episode by episode, and the files arrive on your machine, named the way Plex, Jellyfin and Nuvio expect. It also serves your library to Nuvio and Stremio as an addon.

It replaces a Sonarr + Radarr + Seerr + download-client stack for people who just want to choose what to download. Nothing is torrented on your own machine: TorBox fetches the torrent, Haul pulls the finished files over HTTPS.

You need a TorBox account and either Docker or a Windows PC.

![Home](docs/screenshots/discover.jpg)

## What you can do

- **Browse and search** films and series (catalog from Cinemeta, no API key).
- **Download a whole season.** Haul uses one season pack when a good one exists, otherwise it picks the best single-episode torrent for every episode. Episodes you already have and episodes that haven't aired are skipped. You see the plan before it starts.
- **Compare season packs** by resolution, source, HDR, codec, audio, size and seeders, and whether TorBox already has them cached. Largest files are listed first (switch to best match or most seeders if you like). From a multi-season pack, only the season you asked for is downloaded.
- **Pick single episodes**, or tick several and download just those.
- **Films** get the same release table, best match first.
- **Follow a show or a film** and get a phone notification the moment a torrent for the next episode is out, not just when it airs. Optionally let Haul download it right away.
- **Wait for one exact version.** Following a film that isn't on digital yet? Tell Haul you only want, say, a 4K WEB-DL. It ignores cams, rips and everything else, and grabs the first 4K WEB-DL the moment one appears.
- **See what's coming** on the Upcoming page: new episodes of everything you follow or own, from last week to six weeks ahead, with whether a torrent is out yet.
- **Track progress** through TorBox → your machine → library, with pause, retry and cancel.
- **Watch in Nuvio or Stremio**: your library appears as catalogs, and anything you own gets a "Haul" stream played straight from disk with seeking. Folders you had before Haul are picked up too.

| Season packs | Series page |
| --- | --- |
| ![Season packs](docs/screenshots/packs.jpg) | ![Series](docs/screenshots/show.jpg) |
| **Library and Nuvio addon** | **Upcoming** |
| ![Library](docs/screenshots/library.jpg) | ![Upcoming](docs/screenshots/upcoming.jpg) |

Files are saved like this, reusing show and season folders that already exist:

```
TV Shows/Breaking Bad (2008)/Season 01/Breaking Bad (2008) - S01E04 - Cancer Man - 1080p.mkv
Movies/Dune Part Two (2024)/Dune Part Two (2024) - 2160p.mkv
```

## Install

### Windows

Download **Haul-Setup.exe** from [Releases](https://github.com/Squipy411/haul/releases/latest) and run it. Windows SmartScreen may warn that the app is unrecognised because it isn't code-signed; choose *More info → Run anyway*.

<img src="docs/screenshots/windows-setup.jpg" width="420" align="right" alt="Windows app first run" />

On first launch, choose:

- **This PC**: Haul runs inside the app and downloads to your Videos folder. It is private to the PC unless you tick the box that lets Nuvio on your TV or phone reach it.
- **A Haul server**: connect to Haul running in Docker elsewhere on your network.

Change it later from the menu: *Haul → Change where Haul runs…*. There's also a portable `.exe` that needs no install.

<br clear="right" />

### Docker

```bash
docker run -d --name haul --restart unless-stopped -p 60700:60700 \
  -e PUID=1000 -e PGID=1000 \
  -v ./haul-data:/data -v /path/to/media:/media \
  ghcr.io/squipy411/haul:latest
```

Or use [docker-compose.yml](docker-compose.yml). Then open `http://<server-ip>:60700`, create a password and paste your TorBox API key.

- `/media` is your media folder; Haul writes to `Movies/` and `TV Shows/` inside it (changeable in Settings).
- `PUID`/`PGID` make new files belong to your user (run `id` on the host to find them). Leave them out to run as root.
- Images are built for amd64 and arm64.

| Variable | Default | |
| --- | --- | --- |
| `PUID`, `PGID` | – | Run as this user and group |
| `TORBOX_API_KEY` | – | Pre-fill the key instead of entering it in setup |
| `PUBLIC_URL` | – | Address Nuvio should use for streams, e.g. a domain behind a proxy |
| `MOVIES_DIR`, `TV_DIR`, `INCOMPLETE_DIR` | under `/media` | Starting folder settings |
| `HAUL_AUTH` | – | `none` turns off Haul's login. Only behind a proxy that does its own login. |
| `HAUL_UPDATE_CHECK` | `true` | `false` stops the daily check for new releases |

### ZimaOS / CasaOS

In the ZimaOS terminal, as root (`sudo -i`):

```bash
curl -fsSL https://raw.githubusercontent.com/Squipy411/haul/main/deploy/zimaos/install.sh | sh
```

It builds the image, adds Haul to the dashboard and starts it on port 60700, with media in `/DATA/Media`. Run the same command to update.

### Updating

Haul shows **UPDATE x.y.z** in the top bar when a new release is out, and the Windows app offers the download.

- Docker: `docker pull ghcr.io/squipy411/haul:latest` and recreate the container (`docker compose pull && docker compose up -d`).
- ZimaOS: run the install command again.
- Windows: install the new `Haul-Setup.exe` over the old one.

Settings, the queue and the library index live in `/data` (Docker) or `%APPDATA%\Haul` (Windows) and survive updates.

## Phone notifications

Haul sends notifications through [ntfy](https://ntfy.sh), a free push service with apps for iPhone and Android. You don't need an account.

1. Install ntfy on your phone.
2. In Haul, open Settings → Notifications, turn on **Send notifications** and save.
3. In the ntfy app tap **+** and subscribe to the topic Haul shows (or scan its QR code), then press **Send a test notification**.

Then open any show or film and choose **Follow**. Haul checks your sources every 5 minutes on the day an episode comes out, every 30 minutes for the rest of the week and every few hours after that, and notifies you the first time a usable torrent turns up (camera copies don't count). Tapping the notification opens the title in Haul.

With **Download automatically** on, Haul starts the download as soon as a version in your preferred resolution appears. If only a lower resolution is out, it tells you and waits up to 12 hours for a better one before taking the best available.

To hold out for one particular version, choose **Which versions** when you follow: any mix of quality (4K, 1080p, 720p), source (WEB-DL, WEBRip, BluRay, Remux) and HDR (Dolby Vision, HDR10, none). Everything else is ignored, and with **Grab the first match** on, the first matching torrent is downloaded the moment it shows up. Films are checked every 20 minutes once they're out. Haul also skips trailers and prologues, uploads that say they're a different film with the same name, and telesyncs labelled as WEB-DL. You can change the versions later from the title page or Upcoming → Following.

The topic is a long random name. On ntfy.sh anyone who knows it can read your notifications, so treat it like a password, or point Haul at your own ntfy server (with an access token if it needs sign-in). You can also add a Discord webhook. Notifications are off until you turn them on, so a fresh install never sends anything.

## Nuvio and Stremio

Library → **Copy URL**, then in Nuvio: Settings → Addons → install from URL (in Stremio, use *Open in Stremio*). The URL contains a private token; if it leaks, make a new one in Settings → Nuvio addon. If Nuvio reaches Haul through a different address than your browser does (Tailscale, a domain), set it under *Public address* so stream links use it.

## Security

- Server installs require a password, created during setup. Until then, only the setup page answers.
- Sessions last 30 days and end on every device when the password changes. Repeated wrong passwords are slowed down.
- Every change request carries a header that other websites cannot send, so a malicious page can't act through your signed-in browser.
- The TorBox key stays on the server. The dashboard only ever sees its last four characters.
- The Nuvio addon and its stream links use separate secrets: a private addon URL, and per-file links that are signed and expire after 48 hours.
- The Windows app keeps "This PC" mode on `127.0.0.1` unless you choose to share it. Its window signs itself in; other devices need a password you set in Settings.
- Haul serves plain HTTP. To use it from outside your home network, put it behind a VPN such as Tailscale or an HTTPS reverse proxy rather than forwarding the port.

Found a problem? Open an issue, or for anything sensitive, contact the maintainer privately through GitHub.

## Sources

Torrentio is on by default. TorBox's own search is used when it answers, and you can add any Stremio addon that returns torrents (Comet or MediaFusion without debrid, for example). Results are merged, de-duplicated and checked against the TorBox cache in one request.

## Development

```bash
npm install
npm run dev        # API on :60700, dashboard with hot reload on :5173
npm test
npm run build      # dist/server.mjs and dist/web
npm run desktop    # Windows app from source
npm run dist:win   # Windows installer (on Windows; dist:win:mac on a Mac)
```

The server is one bundled file with no runtime dependencies (Node 22+). State lives in small JSON files in the data folder.

| Path | |
| --- | --- |
| `server/search.ts` | Gathers torrents, checks the TorBox cache, ranks releases, plans whole seasons |
| `server/jobs.ts` | The queue: TorBox → disk → library |
| `server/organize.ts` | Picks the right files out of a torrent and names them |
| `server/library.ts`, `server/addon.ts` | Library scanner and the Nuvio/Stremio addon |
| `server/follows.ts`, `server/notify.ts` | Follows, the torrent watcher, the schedule, and ntfy/Discord delivery |
| `server/auth.ts` | Sign-in, sessions, setup lock |
| `web/src` | Dashboard (React) |
| `desktop` | Windows app (Electron) |

## Credits

Byte-range streaming and the addon design come from [Personal Media Addon](https://github.com/Squipy411/personal-media-addon) (MIT). Catalog data from Cinemeta. Not affiliated with TorBox, Nuvio or Stremio. Download only what you have the right to.
