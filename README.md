# SeaKit

SeaKit is a Seanime plugin that adds optional metadata to anime detail pages without duplicating information Seanime already shows.

## v0.1.0

- **MAL rating** — a blue MAL badge with the current MyAnimeList score beside it.
- **Dub status** — a green microphone icon when an English dub is available.
- **Independent tray toggles** — turn MAL rating or dub status on/off separately.
- **Auto open dub** — optionally select dub when the online streaming controls appear.

## Auto open dub

### v0.1.13 fix

Removed a screen-state/navigation feedback loop that repeatedly rendered badges
and fetched dub data, eventually crashing the plugin runtime. Auto dub now checks
for streaming controls once per second while enabled on an anime page, without
a DOM mutation observer. Repeated navigation snapshots share a single badge
render, concurrent dub lookups share one request, and MAL appears without waiting
for the dub dataset.

Open the SeaKit tray and enable **Auto open dub**. The setting is saved across
restarts and defaults to off. It is independent of the Dub status badge and
does not use MyDubList to decide which stream to select.

SeaKit activates Seanime's existing **Switch to dub** button once per mounted
streaming control and anime, including online streaming on the anime entry
page. An already selected dub is left alone, and you can switch back to subs
without SeaKit repeatedly switching you back. Turning the setting off stops
future automatic selections; it does not change the stream currently playing.
Dub availability and behavior when no dub exists are handled by Seanime and
the selected provider.

Compatibility: this uses Seanime's DOM insertion API and a local image load
handler because the plugin API has no direct click or dub preference command.
It relies on the English **Switch to dub / Switch to subs** labels. A client
that blocks inline event handlers will require a native Seanime API instead.
Watch party playback should use the host's selection; disable this option
before joining a watch party.

SeaKit reads the MAL ID already exposed by Seanime's AniList media object. MAL scores are retrieved through Jikan.

Dub data © MyDubList — https://mydublist.com — CC BY 4.0.
