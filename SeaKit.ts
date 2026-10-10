type JikanAnimeResponse = {
  data?: {
    score?: number | null;
  };
};

type ScoreCacheEntry = {
  score: number;
  fetchedAt: number;
  source: "mal" | "jikan";
};

type DubIndex = {
  dubbed: Record<string, boolean>;
  partial: Record<string, boolean>;
};

function init() {
  $ui.register((ctx) => {
    const K_SHOW_MAL = "seakit.showMal";
    const K_SHOW_DUB = "seakit.showDub";
    const K_AUTO_DUB = "seakit.autoDub";
    const AUTO_DUB_BRIDGE_ATTR = "data-seakit-auto-dub-bridge";
    const K_SCORE_CACHE = "seakit.malScoreCache.v2";
    const MAL_DATA_ATTR = "data-seakit-mal";
    const DUB_DATA_ATTR = "data-seakit-dub";
    const JIKAN_BASE = "https://api.jikan.moe/v4/anime";
    const MAL_BASE = "https://myanimelist.net/anime";
    const DUB_DATA_URL =
      "https://raw.githubusercontent.com/Joelis57/MyDubList/refs/heads/main/dubs/confidence/normal/dubbed_english.json";
    const MAL_SCORE_TTL = 30 * 60 * 1000;
    const JIKAN_SCORE_TTL = 5 * 60 * 1000;
    const JIKAN_GAP_MS = 750;

    const showMal = ctx.state<boolean>($storage.get<boolean>(K_SHOW_MAL) ?? true);
    const showDub = ctx.state<boolean>($storage.get<boolean>(K_SHOW_DUB) ?? true);
    const autoDub = ctx.state<boolean>($storage.get<boolean>(K_AUTO_DUB) ?? false);

    // One attempt per mounted streaming control and anime. Episode changes and
    // manual switches must not force the user's selection back to dub.
    let autoDubControls: Record<string, boolean> = {};
    let autoDubGeneration = 0;
    // screen.state() creates a subscription AND requests a navigation event.
    // Never create it inside a DOM callback: that feeds navigation back into
    // rendering. Use the event snapshot instead.
    let currentScreen = { pathname: "", searchParams: {} as Record<string, string> };
    let autoDubChecking = false;
    let cancelAutoDubTimer: (() => void) | null = null;

    async function applyAutoDub(buttons: $ui.DOMElement[]) {
      const screen = currentScreen;
      if (!autoDub.get() || !["/entry", "/onlinestream"].includes(screen.pathname)) return;
      const mediaId = Number(screen.searchParams.id);
      if (!Number.isSafeInteger(mediaId) || mediaId <= 0) return;

      const controls = buttons.filter((button) =>
        /Switch to (dub|subs)/.test(button.innerHTML ?? ""),
      );
      // Observer callbacks contain changed buttons, not a full DOM snapshot.
      // Keep handled controls when an unrelated button changes.
      if (!controls.length) return;

      const generation = autoDubGeneration;
      for (const button of controls) {
        const key = `${mediaId}:${button.id}`;
        if (autoDubControls[key]) continue;
        autoDubControls[key] = true;
        const label = (await button.getText()).trim();
        if (label !== "Switch to dub") continue;
        if ("disabled" in button.attributes) {
          delete autoDubControls[key];
          continue;
        }

        // Seanime exposes DOM insertion, but no DOM click method. A local image
        // load handler bridges to the existing React button; no remote resource,
        // React internals, or direct Seanime preference writes are needed.
        const bridge = await ctx.dom.createElement("span");
        if (!autoDub.get() || generation !== autoDubGeneration) {
          bridge.remove();
          return;
        }
        bridge.setAttribute(AUTO_DUB_BRIDGE_ATTR, "true");
        bridge.setAttribute("aria-hidden", "true");
        bridge.setStyle("display", "none");
        button.append(bridge);
        // Recheck the live label and media before clicking, since navigation or
        // a manual switch can happen while the DOM request is in flight.
        bridge.setInnerHTML(`<img alt="" onload="
          const bridge = this.parentElement;
          const button = bridge.closest('button');
          const mediaId = Number(new URLSearchParams(location.search).get('id'));
          if (bridge.isConnected &amp;&amp; button &amp;&amp; !button.disabled
              &amp;&amp; mediaId === ${mediaId}
              &amp;&amp; ['/entry', '/onlinestream'].includes(location.pathname)
              &amp;&amp; button.textContent.trim() === 'Switch to dub') {
            button.click();
          }
          bridge.remove();
        " src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">`);
      }
    }

    // Avoid observing every button mutation (including our own insertions).
    // One sequential query runs while enabled on an anime/streaming page.
    async function refreshAutoDub() {
      if (autoDubChecking) return;
      if (cancelAutoDubTimer) cancelAutoDubTimer();
      cancelAutoDubTimer = null;
      if (!autoDub.get() || !["/entry", "/onlinestream"].includes(currentScreen.pathname)) return;
      autoDubChecking = true;
      try {
        const buttons = await ctx.dom.query("button", { withInnerHTML: true });
        await applyAutoDub(buttons);
      } catch (err) {
        console.log("[SeaKit] Auto dub error:", err);
      } finally {
        autoDubChecking = false;
        if (autoDub.get() && ["/entry", "/onlinestream"].includes(currentScreen.pathname)) {
          cancelAutoDubTimer = ctx.setTimeout(() => { refreshAutoDub(); }, 1000);
        }
      }
    }
    ctx.dom.onReady(() => { refreshAutoDub(); });
    ctx.dom.onMainTabReady(() => { refreshAutoDub(); });

    let dubIndex: DubIndex | null = null;
    let dubIndexRequest: Promise<DubIndex | null> | null = null;
    let lastJikanRequestAt = 0;
    let scoreQueue: Promise<void> = Promise.resolve();

    async function sleep(ms: number) {
      await new Promise<void>((resolve) => ctx.setTimeout(resolve, ms));
    }

    async function withScoreSlot<T>(fn: () => Promise<T>): Promise<T> {
      const previous = scoreQueue;
      let release = () => {};
      scoreQueue = new Promise<void>((resolve) => {
        release = resolve;
      });

      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    }

    function makeIdIndex(values: unknown): Record<string, boolean> {
      const out: Record<string, boolean> = {};
      if (!Array.isArray(values)) return out;

      for (const value of values) {
        const id = Number(value);
        if (Number.isFinite(id) && id > 0) {
          out[String(id)] = true;
        }
      }
      return out;
    }

    async function getDubIndex(): Promise<DubIndex | null> {
      if (dubIndex) return dubIndex;
      if (dubIndexRequest) return dubIndexRequest;
      dubIndexRequest = fetchDubIndex();
      try {
        return await dubIndexRequest;
      } finally {
        dubIndexRequest = null;
      }
    }

    async function fetchDubIndex(): Promise<DubIndex | null> {

      try {
        const res = await fetch(DUB_DATA_URL);
        if (!res.ok) {
          console.log(`[SeaKit] MyDubList request failed: HTTP ${res.status}`);
          return null;
        }

        const parsed = JSON.parse(res.text()) as any;
        const dubbedValues = Array.isArray(parsed) ? parsed : parsed?.dubbed;
        const partialValues = Array.isArray(parsed) ? [] : parsed?.partial;

        dubIndex = {
          dubbed: makeIdIndex(dubbedValues),
          partial: makeIdIndex(partialValues),
        };

        console.log(
          `[SeaKit] MyDubList loaded: dubbed=${Object.keys(dubIndex.dubbed).length} partial=${Object.keys(dubIndex.partial).length}`,
        );

        return dubIndex;
      } catch (err) {
        console.log("[SeaKit] Failed to fetch/parse MyDubList:", err);
        return null;
      }
    }

    async function fetchJikanScore(
      malId: number,
      path: string,
      attempt: number,
    ): Promise<number | null> {
      const sinceLast = Date.now() - lastJikanRequestAt;
      if (sinceLast < JIKAN_GAP_MS) {
        await sleep(JIKAN_GAP_MS - sinceLast);
      }

      lastJikanRequestAt = Date.now();
      const res = await fetch(`${JIKAN_BASE}/${malId}${path}`);

      if (!res.ok) {
        console.log(
          `[SeaKit] Jikan attempt ${attempt} failed for MAL ${malId}: HTTP ${res.status}`,
        );
        return null;
      }

      const json = JSON.parse(res.text()) as JikanAnimeResponse;
      const score = json?.data?.score ?? null;

      if (score != null) {
        console.log(`[SeaKit] MAL score ${score} from Jikan for ${malId}`);
      }

      return score;
    }

    function extractMalScore(html: string): number | null {
      const patterns = [
        /itemprop=["']ratingValue["'][^>]*content=["']([0-9.]+)["']/i,
        /itemprop=["']ratingValue["'][^>]*>([0-9.]+)</i,
        /["']ratingValue["']\s*:\s*["']?([0-9.]+)["']?/i,
        /class=["'][^"']*score-label[^"']*["'][^>]*>([0-9.]+)</i,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (!match) continue;

        const score = Number(match[1]);
        if (Number.isFinite(score) && score > 0 && score <= 10) {
          return score;
        }
      }

      return null;
    }

    async function fetchMalPageScore(malId: number): Promise<number | null> {
      try {
        const res = await fetch(`${MAL_BASE}/${malId}`);

        if (!res.ok) {
          console.log(
            `[SeaKit] MyAnimeList page request failed for ${malId}: HTTP ${res.status}`,
          );
          return null;
        }

        const score = extractMalScore(res.text());

        if (score != null) {
          console.log(
            `[SeaKit] MAL score ${score} from MyAnimeList page for ${malId}`,
          );
          return score;
        }

        console.log(
          `[SeaKit] MyAnimeList page returned no score for ${malId}`,
        );
        return null;
      } catch (err) {
        console.log(
          `[SeaKit] MyAnimeList page request errored for ${malId}:`,
          err,
        );
        return null;
      }
    }

    function scoreCacheTtl(entry: ScoreCacheEntry): number {
      return entry.source === "mal" ? MAL_SCORE_TTL : JIKAN_SCORE_TTL;
    }

    function isFreshScore(entry: ScoreCacheEntry | undefined): boolean {
      return !!entry && Date.now() - entry.fetchedAt < scoreCacheTtl(entry);
    }

    async function getMalScore(malId: number): Promise<number | null> {
      const cache =
        $storage.get<Record<string, ScoreCacheEntry>>(K_SCORE_CACHE) ?? {};
      const cached = cache[String(malId)];

      if (isFreshScore(cached)) {
        return cached.score;
      }

      return withScoreSlot(async () => {
        const freshCache =
          $storage.get<Record<string, ScoreCacheEntry>>(K_SCORE_CACHE) ?? {};
        const freshCached = freshCache[String(malId)];

        if (isFreshScore(freshCached)) {
          return freshCached.score;
        }

        // MAL's own page is the source of truth for the number shown on MAL.
        // Jikan can occasionally lag behind MAL's live score, so only use it
        // when the direct MAL page is unavailable.
        let score: number | null = await fetchMalPageScore(malId);
        let source: "mal" | "jikan" = "mal";

        if (score == null) {
          source = "jikan";
          try {
            score = await fetchJikanScore(malId, "", 1);
          } catch (err) {
            console.log(`[SeaKit] Jikan attempt 1 errored for MAL ${malId}:`, err);
          }
        }

        if (score == null) {
          await sleep(900);
          try {
            score = await fetchJikanScore(malId, "/full", 2);
          } catch (err) {
            console.log(`[SeaKit] Jikan fallback errored for MAL ${malId}:`, err);
          }
        }

        if (score != null) {
          freshCache[String(malId)] = {
            score,
            fetchedAt: Date.now(),
            source,
          };
          $storage.set(K_SCORE_CACHE, freshCache);
          console.log(
            `[SeaKit] Cached MAL score ${score} for ${malId} from ${source}`,
          );
          return score;
        }

        if (freshCached) {
          console.log(
            `[SeaKit] Using stale cached MAL score for ${malId} after source failures`,
          );
          return freshCached.score;
        }

        console.log(
          `[SeaKit] MAL score unavailable for ${malId} after MAL + Jikan fallbacks`,
        );
        return null;
      });
    }

    function micSvg(isPartial: boolean) {
      const stroke = isPartial ? "#86efac" : "#22c55e";
      const accent = isPartial ? "#bbf7d0" : "#4ade80";

      return `
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id="seakitMicGradient"
              x1="12"
              y1="3"
              x2="12"
              y2="21"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0%" stop-color="${accent}" />
              <stop offset="100%" stop-color="${stroke}" />
            </linearGradient>
          </defs>

          <rect
            x="9"
            y="3"
            width="6"
            height="10"
            rx="3"
            stroke="url(#seakitMicGradient)"
            stroke-width="2"
          />

          <path
            d="M6.5 10.5C6.5 13.5376 8.96243 16 12 16C15.0376 16 17.5 13.5376 17.5 10.5"
            stroke="url(#seakitMicGradient)"
            stroke-width="2"
            stroke-linecap="round"
          />

          <path
            d="M12 16V19"
            stroke="${stroke}"
            stroke-width="2"
            stroke-linecap="round"
          />

          <path
            d="M9.5 21H14.5"
            stroke="${stroke}"
            stroke-width="2"
            stroke-linecap="round"
          />

          <path
            d="M10.5 5.3C10.9 4.8 11.5 4.5 12.2 4.5"
            stroke="${accent}"
            stroke-width="1.4"
            stroke-linecap="round"
          />
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
      const isCurrent = () => currentScreen.pathname === "/entry"
        && Number(currentScreen.searchParams.id) === id;

      const entry = await ctx.anime.getAnimeEntry(id);
      const media = entry?.media;
      if (!isCurrent()) return;

      if (!media?.idMal) {
        console.log(`[SeaKit] AniList ${id} has no MAL ID`);
        return;
      }

      const container = await getContainer();
      if (!isCurrent()) return;
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

      // Show MAL as soon as it is ready; a slow dub-data request must not hide it.
      if (!isCurrent()) {
        if (malItem) malItem.remove();
        return;
      }
      if (malItem) anchor.after(malItem);

      if (showDub.get()) {
        const index = await getDubIndex();

        if (index) {
          const key = String(media.idMal);
          const isPartial = !!index.partial[key];
          const isDubbed = !!index.dubbed[key];

          console.log(
            `[SeaKit] Dub lookup MAL ${media.idMal}: dubbed=${isDubbed} partial=${isPartial}`,
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
            const pillBorder = isPartial
              ? "rgba(187, 247, 208, 0.58)"
              : "rgba(74, 222, 128, 0.62)";
            const pillBackground = isPartial
              ? "rgba(134, 239, 172, 0.10)"
              : "rgba(34, 197, 94, 0.10)";
            const pillGlow = isPartial
              ? "rgba(187, 247, 208, 0.12)"
              : "rgba(74, 222, 128, 0.14)";

            dub.setStyle("display", "inline-flex");
            dub.setStyle("align-items", "center");
            dub.setStyle("justify-content", "center");
            dub.setStyle("min-width", "30px");
            dub.setStyle("height", "22px");
            dub.setStyle("padding", "0 0.42rem");
            dub.setStyle("margin-left", "0.1rem");
            dub.setStyle("border", `1px solid ${pillBorder}`);
            dub.setStyle("border-radius", "9999px");
            dub.setStyle("background", pillBackground);
            dub.setStyle("box-shadow", `inset 0 0 0 1px ${pillGlow}`);
            dub.setStyle("box-sizing", "border-box");
            dub.setStyle("transform", "translateY(1px)");
            dub.setInnerHTML(micSvg(isPartial));
            dubItem = dub;
          }
        }
      }

      if (!isCurrent()) {
        if (dubItem) dubItem.remove();
        return;
      }
      if (dubItem) anchor.after(dubItem);
    }

    let renderQueue: Promise<void> = Promise.resolve();
    let lastRenderKey = "";
    let badgeRevision = 0;

    ctx.screen.onNavigate(({ pathname, searchParams }) => {
      currentScreen = { pathname, searchParams };
      refreshAutoDub();
      if (pathname !== "/entry") {
        lastRenderKey = "";
        return;
      }

      const id = Number(searchParams.id);
      const key = `${id}:${badgeRevision}`;
      if (key === lastRenderKey) return;
      lastRenderKey = key;
      renderQueue = renderQueue.then(async () => {
        if (currentScreen.pathname !== "/entry" || Number(currentScreen.searchParams.id) !== id) return;
        try {
          await renderAnime(id);
        } catch (err) {
          if (lastRenderKey === key) lastRenderKey = "";
          console.log("[SeaKit] Render error:", err);
        }
      });
    });

    ctx.registerEventHandler("seakit-toggle-mal", () => {
      const value = !showMal.get();
      showMal.set(value);
      $storage.set(K_SHOW_MAL, value);
      badgeRevision++;
      ctx.screen.loadCurrent();
    });

    ctx.registerEventHandler("seakit-toggle-dub", () => {
      const value = !showDub.get();
      showDub.set(value);
      $storage.set(K_SHOW_DUB, value);
      badgeRevision++;
      ctx.screen.loadCurrent();
    });

    ctx.registerEventHandler("seakit-toggle-auto-dub", async () => {
      const value = !autoDub.get();
      autoDub.set(value);
      $storage.set(K_AUTO_DUB, value);
      autoDubGeneration++;
      autoDubControls = {};
      if (cancelAutoDubTimer) cancelAutoDubTimer();
      cancelAutoDubTimer = null;
      const bridges = await ctx.dom.query(`[${AUTO_DUB_BRIDGE_ATTR}]`);
      bridges.forEach((bridge) => bridge.remove());
      if (value) refreshAutoDub();
    });

    // Request the initial screen once, after the navigation handler is ready.
    ctx.screen.loadCurrent();

    const tray = ctx.newTray({
      withContent: true,
      tooltipText: "SeaKit",
      iconUrl: "https://raw.githubusercontent.com/DefnoJae/SeaKit/d78f7da7053ed9d64fe903efd6fb43f5b27917de/icon.png",
    });

    tray.render(() =>
      tray.stack(
        [
          tray.text("SeaKit", {
            style: { fontSize: "1.05rem", fontWeight: "700" },
          }),
          tray.text("Anime details and streaming", {
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
          tray.switch("Auto open dub", {
            value: autoDub.get(),
            onChange: "seakit-toggle-auto-dub",
            side: "left",
          }),
          tray.text("Prefer dub when online streaming opens. You can still switch to subs.", {
            style: { fontSize: "0.7rem", opacity: "0.65" },
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
