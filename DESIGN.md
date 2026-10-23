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
