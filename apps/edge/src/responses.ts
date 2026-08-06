/**
 * Every response the Worker can emit.
 *
 * Centralized so the hot path never hand-assembles headers, and so the status
 * chosen for each outcome is visible in one place rather than scattered across
 * branches.
 */

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/**
 * Sends the visitor onward.
 *
 * **302, not 301, deliberately.** A 301 is permanent and browsers cache it
 * indefinitely — often ignoring `Cache-Control` entirely. That would break two
 * things this project depends on: editing a link's target would never reach
 * anyone who had already followed it, and every repeat click would be served from
 * the browser's own cache, so it would never reach the edge and never be counted.
 * The SEO argument for 301 does not apply — a shortener is a hop, not a canonical
 * home for content.
 *
 * `no-store` extends the same reasoning to intermediary caches.
 */
export function redirectTo(targetUrl: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: targetUrl,
      "cache-control": "private, no-store",
      ...SECURITY_HEADERS,
    },
  });
}

export type ErrorPageKind = "not-found" | "expired" | "disabled" | "unavailable";

interface PageSpec {
  status: number;
  title: string;
  message: string;
  /** Seconds a shared cache may hold this page. 0 means do not cache. */
  maxAge: number;
}

/*
 * `expired` and `disabled` are both 410 Gone: the slug was real and is not coming
 * back at this URL. A visitor cannot tell the two apart from the status alone,
 * which is intended — "this link was disabled for abuse" is not a fact worth
 * confirming to whoever is probing.
 */
const PAGES: Readonly<Record<ErrorPageKind, PageSpec>> = {
  "not-found": {
    status: 404,
    title: "Link not found",
    message: "This short link does not exist. Check the address and try again.",
    maxAge: 0,
  },
  expired: {
    status: 410,
    title: "Link expired",
    message: "This short link has expired and no longer forwards anywhere.",
    maxAge: 60,
  },
  disabled: {
    status: 410,
    title: "Link unavailable",
    message: "This short link is no longer available.",
    maxAge: 60,
  },
  unavailable: {
    status: 503,
    title: "Temporarily unavailable",
    message: "We could not look up this link right now. Please try again shortly.",
    maxAge: 0,
  },
};

/**
 * A branded terminal page. Never a redirect — an unresolvable slug that redirected
 * anywhere would be an open-redirect surface and a lie about what happened.
 */
export function errorPage(kind: ErrorPageKind): Response {
  const spec = PAGES[kind];
  return new Response(renderPage(spec), {
    status: spec.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": spec.maxAge > 0 ? `public, max-age=${spec.maxAge}` : "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

/** Sent when the request method cannot produce a redirect. */
export function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { allow: "GET, HEAD", "cache-control": "no-store", ...SECURITY_HEADERS },
  });
}

/**
 * Renders the page inline.
 *
 * No stylesheet, font or image reference: an external asset would mean another
 * round trip on a page that exists to say "there is nothing here", and the Worker
 * has no origin to serve one from.
 */
function renderPage(spec: PageSpec): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${spec.title}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e9ef;
font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:32rem;padding:2rem;text-align:center}
h1{margin:0 0 .5rem;font-size:1.5rem;letter-spacing:-.01em}
p{margin:0;color:#9aa4b2}
.brand{margin-top:2rem;font-size:.8125rem;letter-spacing:.08em;text-transform:uppercase;color:#5b6675}
@media(prefers-color-scheme:light){
body{background:#fff;color:#11151c}p{color:#5b6675}.brand{color:#8b95a4}}
</style>
</head>
<body>
<main>
<h1>${spec.title}</h1>
<p>${spec.message}</p>
<p class="brand">URLGen</p>
</main>
</body>
</html>
`;
}
