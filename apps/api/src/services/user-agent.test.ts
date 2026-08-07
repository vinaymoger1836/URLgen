import { describe, expect, it } from "vitest";

import { parseUserAgent, referrerHost } from "./user-agent.js";

/** Real strings, copied from real traffic — a synthesised UA proves nothing. */
const AGENTS = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  operaWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  chromeAndroidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  chromeAndroidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  samsungPhone:
    "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ie11: "Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  facebookBot: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  slackBot: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  whatsapp: "WhatsApp/2.23.20.0 A",
  curl: "curl/8.7.1",
  python: "python-requests/2.32.3",
} as const;

describe("parseUserAgent — browsers", () => {
  it.each([
    ["chromeWindows", "Chrome"],
    ["edgeWindows", "Edge"],
    ["operaWindows", "Opera"],
    ["firefoxWindows", "Firefox"],
    ["safariMac", "Safari"],
    ["chromeMac", "Chrome"],
    ["safariIphone", "Safari"],
    ["chromeIphone", "Chrome"],
    ["chromeAndroidPhone", "Chrome"],
    ["samsungPhone", "Samsung Internet"],
    ["firefoxLinux", "Firefox"],
    ["ie11", "Internet Explorer"],
  ] as const)("reads %s as %s", (key, expected) => {
    expect(parseUserAgent(AGENTS[key]).browser).toBe(expected);
  });

  it("does not let Chrome's Safari token win over Chrome", () => {
    /* Every Chromium UA ends in "Safari/537.36". Getting this wrong is the classic
       way a dashboard reports a Safari majority that does not exist. */
    expect(AGENTS.chromeWindows).toContain("Safari/");
    expect(parseUserAgent(AGENTS.chromeWindows).browser).toBe("Chrome");
  });

  it("does not let Edge's Chrome token win over Edge", () => {
    expect(AGENTS.edgeWindows).toContain("Chrome/");
    expect(parseUserAgent(AGENTS.edgeWindows).browser).toBe("Edge");
  });

  it("does not let Opera's Chrome token win over Opera", () => {
    expect(parseUserAgent(AGENTS.operaWindows).browser).toBe("Opera");
  });

  it("reads an iOS Chrome as Chrome even though the engine is WebKit", () => {
    /* Apple requires WebKit on iOS, so Chrome there is Safari's engine with a
       CriOS token. Reporting it as Safari would be defensible and is not what a
       "which browser did they use?" chart is asking. */
    expect(parseUserAgent(AGENTS.chromeIphone).browser).toBe("Chrome");
  });
});

describe("parseUserAgent — operating systems", () => {
  it.each([
    ["chromeWindows", "Windows"],
    ["safariMac", "macOS"],
    ["safariIphone", "iOS"],
    ["safariIpad", "iOS"],
    ["chromeAndroidPhone", "Android"],
    ["firefoxLinux", "Ubuntu"],
    ["chromeOs", "Chrome OS"],
    ["ie11", "Windows"],
  ] as const)("reads %s as %s", (key, expected) => {
    expect(parseUserAgent(AGENTS[key]).os).toBe(expected);
  });

  it("does not read an iPhone as macOS", () => {
    /* An iOS UA literally contains "like Mac OS X". */
    expect(AGENTS.safariIphone).toContain("Mac OS X");
    expect(parseUserAgent(AGENTS.safariIphone).os).toBe("iOS");
  });

  it("does not read Android as Linux", () => {
    expect(AGENTS.chromeAndroidPhone).toContain("Linux");
    expect(parseUserAgent(AGENTS.chromeAndroidPhone).os).toBe("Android");
  });

  it("does not read Chrome OS as Linux", () => {
    expect(AGENTS.chromeOs).toContain("X11");
    expect(parseUserAgent(AGENTS.chromeOs).os).toBe("Chrome OS");
  });
});

describe("parseUserAgent — device types", () => {
  it.each([
    ["chromeWindows", "desktop"],
    ["safariMac", "desktop"],
    ["firefoxLinux", "desktop"],
    ["chromeOs", "desktop"],
    ["safariIphone", "mobile"],
    ["chromeAndroidPhone", "mobile"],
    ["samsungPhone", "mobile"],
    ["safariIpad", "tablet"],
    ["chromeAndroidTablet", "tablet"],
  ] as const)("classifies %s as %s", (key, expected) => {
    expect(parseUserAgent(AGENTS[key]).deviceType).toBe(expected);
  });

  it("splits Android phone from Android tablet on the Mobile token", () => {
    /* The only signal Android gives: a phone carries "Mobile", a tablet omits it.
       Both strings are otherwise near-identical. */
    expect(AGENTS.chromeAndroidPhone).toContain("Mobile");
    expect(AGENTS.chromeAndroidTablet).not.toContain("Mobile");
    expect(parseUserAgent(AGENTS.chromeAndroidPhone).deviceType).toBe("mobile");
    expect(parseUserAgent(AGENTS.chromeAndroidTablet).deviceType).toBe("tablet");
  });
});

describe("parseUserAgent — automated clients", () => {
  it.each([
    "googlebot",
    "bingbot",
    "facebookBot",
    "slackBot",
    "whatsapp",
    "curl",
    "python",
  ] as const)("classifies %s as a bot", (key) => {
    expect(parseUserAgent(AGENTS[key]).deviceType).toBe("bot");
  });

  it("does not attribute a browser or OS to a bot", () => {
    /* Googlebot's UA says "Mozilla/5.0". Recording "Chrome / Linux" for it would
       invent humans that never existed. */
    expect(parseUserAgent(AGENTS.googlebot)).toEqual({
      deviceType: "bot",
      browser: "unknown",
      os: "unknown",
    });
  });

  it("classifies a bot before it classifies a device", () => {
    const headless =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36";
    expect(parseUserAgent(headless).deviceType).toBe("bot");
  });
});

describe("parseUserAgent — unclassifiable input", () => {
  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("returns all-unknown for %s", (_label, value) => {
    expect(parseUserAgent(value)).toEqual({
      deviceType: "unknown",
      browser: "unknown",
      os: "unknown",
    });
  });

  it("says unknown rather than guessing desktop for a string it cannot place", () => {
    /* A wrong bucket is a chart that lies; an unknown bucket is a chart that
       admits what it does not know. */
    expect(parseUserAgent("SomeInternalClient/4.2").deviceType).toBe("unknown");
  });

  it("survives a hostile string without hanging", () => {
    const hostile = `${"a".repeat(400)}(((((((((${"Mobile".repeat(10)}`;
    const started = Date.now();

    expect(() => parseUserAgent(hostile)).not.toThrow();

    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("referrerHost", () => {
  it("keeps only the host", () => {
    expect(referrerHost("https://news.ycombinator.com/item?id=42")).toBe("news.ycombinator.com");
  });

  it("drops the path and query, which is where the sensitive part lives", () => {
    /* A referrer routinely leaks search terms and session identifiers. Storing the
       whole URL would make someone else's data our problem to protect. */
    const host = referrerHost("https://mail.example.com/inbox?token=abc123&q=salary+review");
    expect(host).toBe("mail.example.com");
    expect(host).not.toContain("token");
    expect(host).not.toContain("salary");
  });

  it("lowercases the host so one referrer is one series", () => {
    expect(referrerHost("https://Twitter.COM/someone")).toBe("twitter.com");
  });

  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["a relative path", "/dashboard"],
    ["junk", "not a url at all"],
  ])("returns empty (direct) for %s", (_label, value) => {
    expect(referrerHost(value)).toBe("");
  });
});
