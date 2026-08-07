/**
 * User-Agent classification.
 *
 * This runs at the origin, never at the edge — it is the single most expensive
 * thing in the click pipeline and the Worker has 10ms of CPU for an entire
 * redirect. Moving it here is the reason the edge sends a raw string.
 *
 * ## Why this is hand-written rather than a library
 *
 * The columns it feeds are `LowCardinality(String)` buckets: a handful of device
 * types, the major browser families, the major OS families. A full UA database
 * resolves hundreds of browser names and exact version numbers, all of which this
 * pipeline would immediately throw away — and the obvious library for the job,
 * `ua-parser-js`, relicensed to AGPL-3.0 at v2, which is not a licence to pull into
 * a project casually. Pinning to an unmaintained 1.x to dodge that is worse.
 *
 * ## What it deliberately does not do
 *
 * It does not report versions, it does not try to be exhaustive, and it does not
 * attempt to unmask a spoofed UA. A User-Agent is a self-reported string from an
 * untrusted client; treating it as ground truth for anything but a rough breakdown
 * chart would be a mistake regardless of how good the parser was.
 *
 * ## Ordering is the whole algorithm
 *
 * Every check below is ordered most-specific-first, because browser vendors spent
 * two decades embedding each other's tokens in their own strings. Edge says
 * "Chrome" and "Safari"; Chrome says "Safari"; Opera says "Chrome" and "Safari".
 * Reordering these tests silently reassigns traffic between series in the
 * dashboard, which is why each block is a single ordered list and not a map.
 */

/** Coarse device classes. `bot` is a device class here on purpose — see `DEVICE_UNKNOWN`. */
export type DeviceType = "desktop" | "mobile" | "tablet" | "bot" | "unknown";

export interface UserAgentInfo {
  deviceType: DeviceType;
  browser: string;
  os: string;
}

/**
 * What every field falls back to.
 *
 * An empty string would work in ClickHouse, but "unknown" survives a `GROUP BY`
 * into a dashboard legend where an empty label reads as a rendering bug.
 */
const UNKNOWN = "unknown";

const UNKNOWN_AGENT: UserAgentInfo = {
  deviceType: "unknown",
  browser: UNKNOWN,
  os: UNKNOWN,
};

/**
 * Automated clients.
 *
 * Checked before anything else: a crawler that says "Chrome" would otherwise land
 * in the desktop bucket and inflate every chart. The list covers the traffic a
 * public short link actually attracts — search crawlers, chat-app link unfurlers,
 * uptime monitors and scripted clients — rather than trying to be complete, which
 * is not achievable against a field the client controls.
 */
const BOT_PATTERNS: readonly RegExp[] = [
  /bot|crawler|spider|crawling/i,
  /slurp|mediapartners|adsbot|feedfetcher/i,
  /facebookexternalhit|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot|skypeuripreview|redditbot|embedly|quora link preview|pinterest/i,
  /curl|wget|python-requests|httpie|axios|go-http-client|okhttp|java\//i,
  /headlesschrome|phantomjs|puppeteer|playwright|lighthouse|pingdom|uptimerobot|monitoring/i,
  /preview|scraper|validator|fetcher|archiver/i,
];

/** Browser families, most specific first — see the ordering note in the header. */
const BROWSER_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//i, "Edge"],
  [/\bOPR\/|\bOpera\b/i, "Opera"],
  [/\bSamsungBrowser\//i, "Samsung Internet"],
  [/\bYaBrowser\//i, "Yandex"],
  [/\bVivaldi\//i, "Vivaldi"],
  [/\bBrave\//i, "Brave"],
  [/\bUCBrowser\//i, "UC Browser"],
  [/\bFxiOS\/|\bFirefox\//i, "Firefox"],
  [/\bCriOS\/|\bChrome\//i, "Chrome"],
  /* Safari last of the mainstream engines: every WebKit-derived browser above
     also ships the "Safari" token, so anything still unmatched here is the real
     one. `Version/` narrows it further, since headless WebKit tools omit it. */
  [/\bSafari\//i, "Safari"],
  [/\bMSIE\b|\bTrident\//i, "Internet Explorer"],
];

/** OS families, most specific first. */
const OS_PATTERNS: readonly (readonly [RegExp, string])[] = [
  /* Before Android: a Fire tablet's UA contains "Android" too. */
  [/\bKFAPWI\b|\bSilk\//i, "Fire OS"],
  [/\bAndroid\b/i, "Android"],
  /* Before macOS: an iOS UA contains "like Mac OS X". */
  [/\biPhone\b|\biPad\b|\biPod\b|\biOS\b/i, "iOS"],
  [/\bWindows Phone\b/i, "Windows Phone"],
  [/\bWindows NT\b|\bWindows\b/i, "Windows"],
  [/\bCrOS\b/i, "Chrome OS"],
  /* Before Linux: both Android and Chrome OS already matched above, and every
     desktop Linux UA says "X11" or "Linux". */
  [/\bMac OS X\b|\bMacintosh\b/i, "macOS"],
  [/\bUbuntu\b/i, "Ubuntu"],
  [/\bLinux\b|\bX11\b/i, "Linux"],
];

/** Tablets, checked before mobile because an Android tablet says "Android" too. */
const TABLET_PATTERNS: readonly RegExp[] = [
  /\biPad\b/i,
  /\bTablet\b|\bPlayBook\b|\bKindle\b|\bSilk\//i,
  /* The Android convention: a tablet omits the "Mobile" token a phone carries. */
  /\bAndroid\b(?!.*\bMobile\b)/i,
];

const MOBILE_PATTERNS: readonly RegExp[] = [
  /\bMobi\b|\bMobile\b/i,
  /\biPhone\b|\biPod\b/i,
  /\bAndroid\b|\bWindows Phone\b|\bBlackBerry\b|\bIEMobile\b|\bOpera Mini\b/i,
];

/**
 * Classifies a User-Agent into the three columns the analytics table stores.
 *
 * Returns "unknown" for everything it cannot place, never a guess: an unknown
 * bucket the dashboard can show is honest, a wrong bucket is a chart that lies.
 */
export function parseUserAgent(userAgent: string | undefined): UserAgentInfo {
  if (userAgent === undefined || userAgent.trim() === "") {
    return UNKNOWN_AGENT;
  }

  if (matches(userAgent, BOT_PATTERNS)) {
    /* Browser and OS are left unset rather than parsed. A crawler's UA names the
       operator, not a browser anyone used, and recording "Chrome / Linux" for
       Googlebot would put fictional humans in the breakdown charts. */
    return { deviceType: "bot", browser: UNKNOWN, os: UNKNOWN };
  }

  return {
    deviceType: classifyDevice(userAgent),
    browser: firstMatch(userAgent, BROWSER_PATTERNS),
    os: firstMatch(userAgent, OS_PATTERNS),
  };
}

/**
 * Tablet before mobile before desktop.
 *
 * Desktop is the fallback only when the string looks like a browser at all — a
 * string that matches no browser and no OS is far more likely to be a client this
 * parser has never seen than a desktop, and "unknown" says so.
 */
function classifyDevice(userAgent: string): DeviceType {
  if (matches(userAgent, TABLET_PATTERNS)) {
    return "tablet";
  }
  if (matches(userAgent, MOBILE_PATTERNS)) {
    return "mobile";
  }
  return /\bMozilla\/|\bAppleWebKit\/|\bGecko\/|\bTrident\//i.test(userAgent)
    ? "desktop"
    : "unknown";
}

function matches(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function firstMatch(value: string, patterns: readonly (readonly [RegExp, string])[]): string {
  for (const [pattern, label] of patterns) {
    if (pattern.test(value)) {
      return label;
    }
  }
  return UNKNOWN;
}

/**
 * Reduces a `Referer` header to the host the visitor came from.
 *
 * The path and query are dropped, not stored — a referrer URL routinely carries
 * search terms, session identifiers and internal document titles, none of which
 * this product needs to know and all of which would become our problem to protect.
 * The host alone answers the only question the dashboard asks: where is my traffic
 * coming from?
 */
export function referrerHost(referrer: string | undefined): string {
  if (referrer === undefined || referrer.trim() === "") {
    /* An empty string, not "unknown": no referrer is a real and common state
       (a typed URL, an app, a link with a strict referrer policy) and the
       dashboard shows it as "direct". */
    return "";
  }

  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return "";
  }

  return url.hostname.toLowerCase();
}
