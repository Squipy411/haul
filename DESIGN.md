# Haul design

The dashboard is a tool you open, pick something, and leave. It should look like a well-made media app, not a template. These are the rules the current design (v4) follows, and why.

## Sheet

Dealt with [Taste Skill](https://github.com/Leonxlnx/taste-skill)'s app sheet **true-black-flat** (seed 869944636) and kept as dealt:

- **Ground** `#000`, cards `#111` with no border and no shadow, nested panels `#2a2a2a`.
- **Radii** 20 for cards, 10 for nested panels, 8 for thumbnails. Every control is a pill.
- **Shell** is a ruled T-frame: a 220px sidebar and a 64px top bar on the same black, separated by 1px rules.
- **Primary control** is an inverted white pill. There is at most one per view (Download season, Find a title, Save changes).
- **Type** is Inter Variable only, at 11/12/13/14/16/20px. Numbers use tabular figures.

## The one colour

Transfer blue `#4cb3f0` is the only hue. It marks things that are moving: download progress, live speeds, episodes on their way in the season map, and "Looking for a torrent" while Haul is checking. It never goes on buttons, tabs, navigation or headings. Green and red appear only in status pills (ready now, failed).

## Signature

The **season map** on a show page: one cell per episode. Solid white means it's in your library, blue means it's on its way, an outline means not downloaded, and a dashed outline means not out yet. You can see what a season needs before reading a table.

## Words

- Labels say what happens: "Download season 3", "Only take the 4 episodes I don't have", "Ready now" and "Fetch first", not "Cached" and "Uncached".
- No exclamation marks and no "Oops". Errors say what went wrong and what to do.
- Release names are shown as they are, because people recognise them. Tags like 4K, DTS-HD MA and Dolby Vision are set apart the way a disc case prints them.

## Components

Built on [Radix](https://www.radix-ui.com) primitives (dialog, switch, checkbox, tabs, select, dropdown menu, tooltip), [Sonner](https://sonner.emilkowal.ski) toasts, the [cmdk](https://cmdk.paco.me) palette (⌘K or /) and [NumberFlow](https://number-flow.barvian.me) for figures that change. All are styled by hand in `web/src/styles.css`. No component library theme is used.

## Checks

`.taste-skill` is not committed. Before a release, run Taste Skill's `lint.mjs --app web/src` (0 fail) and `inspect.mjs` against Home, a show, Upcoming and Settings at 1440px and 390px (0 fail, no horizontal scroll). Lines that break a rule on purpose carry a `taste-skill-ignore` comment with the reason.

## Decision log

| Version | Change | Why |
| --- | --- | --- |
| v1 | Purple gradient hero, glass cards | First pass; read as generic AI output |
| v2 | Serif headings, mono labels, orange accent | Still decorative rather than useful |
| v3 | Dealt a Taste Skill sheet; Radix, Sonner, cmdk | Replace guesswork with a fixed system |
| v4 | True black, one data hue, season map, home shows new episodes and live transfers | The page should answer "what's new and what's moving" first |
| 1.2 | Upcoming page, Follow, phone notifications, largest-first release sort | Get told when a torrent is out, not when an episode airs |
| 1.3 | Version chips on Follow (quality, source, HDR); selected chip is outlined, not inverted | Wait for exactly a 4K WEB-DL; several chips can be on at once, so they can't use the one-per-view white pill |
| 1.4 | Disk meter in the sidebar foot (neutral grey, warning colour under 20 GB), Coming up card on Home, idle card on Downloads, fading poster shelves | Show what matters when nothing is running; the accent stays reserved for live transfers |
| 1.5 | Full-screen player outside the shell: black, white played bar, grey buffered bar, controls on a neutral scrim that hide after 3 s; landscape stills with a white progress line for Continue watching; Play is the one white button on a title | A streaming page should get out of the way of the picture; the accent stays for transfers |
| 1.6 | Watch-first: full-bleed hero with the title's logo on Home (rotating) and on title pages; Play is the white button, Download is a tab; episodes as a watch list with stills, progress lines and a white Watched check; Shows and Movies in the nav, management behind a divider (More on phones) | The site should feel like somewhere to watch, with downloading as the option rather than the point |
| 1.12 | "Who's watching?" as its own quiet screen of coloured initials (no photos to manage); the current profile is a small avatar at the end of the top bar; More like this at the foot of a title; History as plain rows with a still, the episode and how long ago | Profiles should feel like a streaming site's without asking anyone for a picture |
| 1.11 | My list (a plus that becomes a tick, white-outlined like every secondary action), Trailer in a full-screen window over a near-black scrim, a white tick on watched episodes, other versions in the player's side drawer like episodes; Shows and Movies load more as you scroll | The things people reach for on any streaming site, in the places they look for them |
| 1.10 | Sign-in and security in one Settings section that says how you're connected (home network, or the internet over HTTPS) and what to do next; two-step setup is three numbered steps around one QR code; the sign-in page adds a code box only when two-step is on | Opening Haul to the internet should feel as safe as it is, and the safe choice should be the obvious next step |
| 1.9 | A broken or stalled stream restarts itself at the same spot before any message shows; wrong-key and nothing-found messages say what to do next; form fields in a row line up at the top | A stranger's first run and a Wi-Fi blip shouldn't need a button or a guess |
| 1.8 | Back lands where you were (scroll position, genre, Load more pages, tab); a title page opens on the artwork of the card you pressed; pictures fade in as they load; the tab names what's on screen. Player: a tap shows the controls instead of pausing, a double tap skips with a "10 seconds" bubble that adds up, the knob follows your finger, and one settings menu holds speed (a row at the top), audio and subtitles | Smoothness is mostly not losing your place, and a phone player should behave like the phone's own |
| 1.7 | New mark: a box whose lid opens onto a play button (lid in transfer blue, box white, play black) on a black tile; the wordmark reads "Haul" over "TorBox player" | Haul is a player for TorBox first; the mark says box and play without borrowing TorBox's own logo |
