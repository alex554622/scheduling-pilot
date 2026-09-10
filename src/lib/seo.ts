// Head metadata for the public marketing pages.
//
// TanStack merges `meta` from every matched route and de-duplicates on `name` /
// `property`, with the deepest route winning. So __root.tsx carries the sitewide
// defaults and a page overrides them just by returning its own entry. `links`
// are NOT de-duplicated, which is why the canonical tag is emitted per page here
// and never at the root — two <link rel="canonical"> tags would cancel out.

export const SITE_URL = "https://schedulingpilot.com";
export const SITE_NAME = "Scheduling Pilot";

// The logo doubles as the share image. It is a wide lockup rather than a
// purpose-made 1200x630 card, so replacing it with a real OG image is worth
// doing before running a link-preview-heavy campaign.
export const OG_IMAGE = `${SITE_URL}/scheduling-pilot-logo.png`;

/** Absolute, canonical-host URL for a route path. */
export function absoluteUrl(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  // Keep the trailing slash on the root only; canonical URLs must be one exact
  // string per page or Google treats the variants as separate documents.
  return path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path.replace(/\/$/, "")}`;
}

interface SeoOptions {
  /** Full <title>. Unique per page. */
  title: string;
  /** Meta description. Unique per page, roughly 140-165 characters. */
  description: string;
  /** Route path, e.g. "/" or "/time-clock". Drives canonical and og:url. */
  path: string;
  image?: string;
}

/**
 * Head config for a public, indexable page: title, description, canonical,
 * robots, Open Graph and Twitter card.
 */
export function seo({ title, description, path, image = OG_IMAGE }: SeoOptions) {
  const url = absoluteUrl(path);
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { name: "robots", content: "index, follow" },

      { property: "og:type", content: "website" },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: image },
      { property: "og:image:alt", content: `${SITE_NAME} employee scheduling software` },
      { property: "og:locale", content: "en_US" },

      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
      { name: "twitter:image:alt", content: `${SITE_NAME} employee scheduling software` },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}

/**
 * Head config for a page that must stay out of the index — the signed-in
 * application, and the auth screens that front it.
 *
 * This is a crawling hint, never a security control: the pages behind it are
 * protected by authentication and row-level security, exactly as before.
 *
 * `follow` keeps a public-but-not-useful page (login, join) passing link equity
 * back to the marketing pages; private application routes get nofollow too.
 */
export function noindexSeo(title: string, { follow = false }: { follow?: boolean } = {}) {
  return {
    meta: [
      { title },
      { name: "robots", content: follow ? "noindex, follow" : "noindex, nofollow" },
      // Belt and braces for crawlers that read the Google-specific directive.
      { name: "googlebot", content: follow ? "noindex, follow" : "noindex, nofollow" },
    ],
  };
}
