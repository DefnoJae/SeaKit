type JikanAnimeResponse = {
  data?: {
    score?: number | null;
  };
};

type MyDubListEnglish = {
  dubbed?: number[];
  partial?: number[];
};

type ScoreCacheEntry = {
  score: number;
  fetchedAt: number;
};

function init() {
  $ui.register((ctx) => {
    const K_SHOW_MAL = "seakit.showMal";
    const K_SHOW_DUB = "seakit.showDub";
    const K_SCORE_CACHE = "seakit.malScoreCache";
    const MAL_DATA_ATTR = "data-seakit-mal";
    const DUB_DATA_ATTR = "data-seakit-dub";
    const JIKAN_BASE = "https://api.jikan.moe/v4/anime";
    const DUB_DATA_URL =
      "https://raw.githubusercontent.com/Joelis57/MyDubList/main/dubs/confidence/normal/dubbed_english.json";
    const SCORE_TTL = 24 * 60 * 60 * 1000;

    const showMal = ctx.state<boolean>($storage.get<boolean>(K_SHOW_MAL) ?? true);
    const showDub = ctx.state<boolean>($storage.get<boolean>(K_SHOW_DUB) ?? true);

    let dubData: MyDubListEnglish | null = null;
    let lastJikanRequestAt = 0;

    async function sleep(ms: number) {
      await new Promise<void>((resolve) => ctx.setTimeout(resolve, ms));
    }

    async function getDubData(): Promise<MyDubListEnglish | null> {
      if (dubData) return dubData;
      try {
        const res = await fetch(DUB_DATA_URL);
        if (!res.ok) {
          console.log(`[SeaKit] MyDubList request failed: HTTP ${res.status}`);
          return null;
        }
        dubData = res.json<MyDubListEnglish>();
        return dubData;
      } catch (err) {
        console.log("[SeaKit] Failed to fetch MyDubList:", err);
        return null;
      }
    }

    async function getMalScore(malId: number): Promise<number | null> {
      const cache =
        $storage.get<Record<string, ScoreCacheEntry>>(K_SCORE_CACHE) ?? {};
      const cached = cache[String(malId)];
      if (cached && Date.now() - cached.fetchedAt < SCORE_TTL) {
        return cached.score;
      }

      try {
        const sinceLast = Date.now() - lastJikanRequestAt;
        if (sinceLast < 450) await sleep(450 - sinceLast);

        lastJikanRequestAt = Date.now();
        const res = await fetch(`${JIKAN_BASE}/${malId}`);

        if (!res.ok) {
          console.log(
            `[SeaKit] Jikan request failed for MAL ${malId}: HTTP ${res.status}`,
          );
          return null;
        }

        const json = res.json<JikanAnimeResponse>();
        const score = json?.data?.score ?? null;
        if (score == null) return null;

        cache[String(malId)] = { score, fetchedAt: Date.now() };
        $storage.set(K_SCORE_CACHE, cache);
        return score;
      } catch (err) {
        console.log(`[SeaKit] Failed to fetch MAL score for ${malId}:`, err);
        return null;
      }
    }

    function micSvg(color: string) {
      return `
        <svg viewBox="0 0 24 24" width="25" height="25" fill="none"
             stroke="${color}" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3"></rect>
          <path d="M5 10a7 7 0 0 0 14 0"></path>
          <path d="M12 17v5"></path>
          <path d="M8 22h8"></path>
        </svg>`;
    }

    async function clearSeaKit(container: $ui.DOMElement) {
      const oldMal = await container.query(`[${MAL_DATA_ATTR}]`);
      oldMal.forEach((el) => el.remove());
      const oldDub = await container.query(`[${DUB_DATA_ATTR}]`);
      oldDub.forEach((el) => el.remove());
    }

    async function getContainer(attempt = 0): Promise<$ui.DOMElement | null> {
      const container = await ctx.dom.queryOne(
        "[data-anime-meta-section-buttons-container]",
        { withInnerHTML: true, identifyChildren: true },
      );
      if (container) return container;
      if (attempt >= 5) return null;
      await sleep(250 + attempt * 200);
      return getContainer(attempt + 1);
    }

    async function renderAnime(id: number) {
      if (!id || id >= 2 ** 31) return;

      const entry = await ctx.anime.getAnimeEntry(id);
      const media = entry?.media;
      if (!media?.idMal) {
        console.log(`[SeaKit] AniList ${id} has no MAL ID`);
        return;
      }

      const container = await getContainer();
      if (!container) {
        console.log("[SeaKit] Anime action container was not ready");
        return;
      }

      await clearSeaKit(container);

      const anchor = await container.queryOne("a");
      if (!anchor) {
        console.log("[SeaKit] AniList action button was not found");
        return;
      }

      let malItem: $ui.DOMElement | null = null;
      let dubItem: $ui.DOMElement | null = null;

      if (showMal.get()) {
        const score = await getMalScore(media.idMal);
        if (score != null) {
          const item = await ctx.dom.createElement("a");
          item.setAttribute(MAL_DATA_ATTR, "true");
          item.setAttribute("href", `https://myanimelist.net/anime/${media.idMal}`);
          item.setAttribute("target", "_blank");
          item.setAttribute("title", `MyAnimeList score: ${score.toFixed(2)}`);
          item.setStyle("display", "inline-flex");
          item.setStyle("align-items", "center");
          item.setStyle("gap", "0.35rem");
          item.setStyle("text-decoration", "none");

          const badge = await ctx.dom.createElement("span");
          badge.setInnerHTML("MAL");
          badge.setStyle("display", "inline-flex");
          badge.setStyle("align-items", "center");
          badge.setStyle("justify-content", "center");
          badge.setStyle("background", "#2e51a2");
          badge.setStyle("color", "#fff");
          badge.setStyle("font-weight", "800");
          badge.setStyle("font-size", "0.66rem");
          badge.setStyle("line-height", "1");
          badge.setStyle("padding", "0.28rem 0.3rem");
          badge.setStyle("border-radius", "0.2rem");

          const value = await ctx.dom.createElement("span");
          value.setInnerHTML(score.toFixed(2));
          value.setStyle("font-weight", "700");
          value.setStyle("font-size", "0.95rem");

          item.append(badge);
          item.append(value);
          malItem = item;
        }
      }

      if (showDub.get()) {
        const data = await getDubData();
        if (data) {
          const malId = media.idMal;
          const isDubbed = (data.dubbed ?? []).includes(malId);
          const isPartial = (data.partial ?? []).includes(malId);

          console.log(
            `[SeaKit] Dub lookup MAL ${malId}: dubbed=${isDubbed} partial=${isPartial}`,
          );

          if (isDubbed || isPartial) {
            const dub = await ctx.dom.createElement("span");
            dub.setAttribute(DUB_DATA_ATTR, "true");
            dub.setAttribute(
              "title",
              isPartial
                ? "English dub available (partial)"
                : "English dub available",
            );
            dub.setStyle("display", "inline-flex");
            dub.setStyle("align-items", "center");
            dub.setStyle("justify-content", "center");
            dub.setStyle("padding", "0.2rem");
            dub.setInnerHTML(micSvg(isPartial ? "#a3e635" : "#22c55e"));
            dubItem = dub;
          }
        }
      }

      // Insert both items relative to Seanime's native AniList button.
      // Avoid chaining .after() from a newly-created injected element.
      if (dubItem) anchor.after(dubItem);
      if (malItem) anchor.after(malItem);
    }

    ctx.screen.onNavigate(async ({ pathname, searchParams }) => {
      if (pathname !== "/entry") return;
      const id = Number(searchParams.id);
      try {
        await renderAnime(id);
      } catch (err) {
        console.log("[SeaKit] Render error:", err);
      }
    });

    ctx.registerEventHandler("seakit-toggle-mal", () => {
      const value = !showMal.get();
      showMal.set(value);
      $storage.set(K_SHOW_MAL, value);
      ctx.screen.loadCurrent();
    });

    ctx.registerEventHandler("seakit-toggle-dub", () => {
      const value = !showDub.get();
      showDub.set(value);
      $storage.set(K_SHOW_DUB, value);
      ctx.screen.loadCurrent();
    });

    const tray = ctx.newTray({ withContent: true });
    tray.render(() =>
      tray.stack(
        [
          tray.text("SeaKit", {
            style: { fontSize: "1.05rem", fontWeight: "700" },
          }),
          tray.text("Anime detail enhancements", {
            style: { fontSize: "0.78rem", opacity: "0.65" },
          }),
          tray.switch("MAL rating", {
            value: showMal.get(),
            onChange: "seakit-toggle-mal",
            side: "left",
          }),
          tray.switch("Dub status", {
            value: showDub.get(),
            onChange: "seakit-toggle-dub",
            side: "left",
          }),
          tray.text("Dub data © MyDubList · CC BY 4.0", {
            style: { fontSize: "0.7rem", opacity: "0.5" },
          }),
        ],
        { gap: 3 },
      ),
    );
  });
}
