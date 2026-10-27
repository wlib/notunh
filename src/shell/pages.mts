// The site's pages as search engines and link previews see them: each one's title, description, and structured data,
// read by every page's head (Head.tsx), the social images, the sitemap (scripts/search.mts), and IndexNow
// (scripts/indexnow.mts), so they can't disagree

import type { Person, Thing, WebApplication, WebSite, WithContext } from "schema-dts"

/** The one canonical origin, which every page's links for search engines and previews name */
export const SITE = "https://notunh.app"

export const NAME = "notunh"

/** IndexNow's key (scripts/indexnow.mts), public by design: served at /<key>.txt to show the site is ours to submit */
export const INDEXNOW_KEY = "e83e399a2da2bed37da4f7df04e60177"

export const AUTHOR = { name: "Daniel Ethridge", url: "https://github.com/wlib" }

export type Page = {
  title:       string,
  /** At most about 155 characters, as search results show; also each page's shell says it */
  description: string,
  /** What the page's social image says beside the wordmark, in two or three words */
  label:       string,
  /** What the social image shows besides its words, for those who can't see it */
  shows:       string,
  /** Its kind among Google's software app categories */
  category:    string
}

export const PAGES = {
  "/": {
    title:       "notunh: UNH buses, classes, parking, events, dining, and laundry",
    description: "An unofficial UNH app for getting around, finding a class or a professor, parking, today's events, what's on at Holloway and Philbrook, and a free washer.",
    label:       "Map, menus, laundry",
    shows:       "A map of central UNH around Thompson Hall with a Gables Connector bus on Main Street, beside phones showing a laundry room's machines and Philbrook's lunch. Marked unofficial.",
    category:    "LifestyleApplication"
  },
  "/map/": {
    title:       "UNH Campus Map: Buses, Classes & Parking · notunh",
    description: "Every Wildcat Transit bus live, directions by bus or on foot, where a class or professor is next, where to park, and what's on today.",
    label:       "Buses & directions",
    shows:       "A 3D map looking down Main Street at UNH over Thompson Hall's lawn, with a Gables Connector bus between the Whittemore Center and Thompson Hall stops. Marked unofficial.",
    category:    "TravelApplication"
  },
  "/dining/": {
    title:       "UNH Dining Menus: Holloway & Philbrook · notunh",
    description: "What's for breakfast, lunch, and dinner at Holloway and Philbrook all week, with each hall's hours and filters for your diet and allergies.",
    label:       "Dining menus",
    shows:       "Phones over a map of campus: Holloway Commons' lunch with a dish opened to its ingredients and nutrition, and Philbrook Hall's menu beside it. Marked unofficial.",
    category:    "LifestyleApplication"
  },
  "/laundry/": {
    title:       "UNH Laundry: Free Washers & Dryers · notunh",
    description: "See which washers and dryers are free in your UNH residence hall before you carry the basket down, and how long until the rest are done.",
    label:       "Laundry",
    shows:       "Phones over a map of campus: which of a residence hall's washers and dryers are free and how long the rest have left, and the list of rooms behind. Marked unofficial.",
    category:    "UtilitiesApplication"
  }
} as const satisfies Record<string, Page>

export type Path = keyof typeof PAGES

export const PATHS = Object.keys(PAGES) as Path[]

/**
 * A page's social image (scripts/social.mts), served beside the site rather than under the page, where a laundry
 * room's path would reach the Worker
 */
export const imageOf = (path: Path) =>
  `/social/${path === "/" ? "home" : path.slice(1, -1)}.png`

export const IMAGE = { width: 1200, height: 630 }

const author: Person = { "@type": "Person", ...AUTHOR, sameAs: AUTHOR.url }

/**
 * A page's structured data: each is a free web app, and the home page also names the site, which Google takes its
 * site name from. No ratings, so no rich result, but nothing made up either
 */
export const structuredDataOf = (path: Path): WithContext<Thing>[] => {
  const { title, description, category } = PAGES[path]
  const app: WithContext<WebApplication> = {
    "@context":          "https://schema.org",
    "@type":             "WebApplication",
    name:                path === "/" ? NAME : title,
    description,
    url:                 SITE + path,
    image:               SITE + imageOf(path),
    applicationCategory: category,
    operatingSystem:     "Any",
    browserRequirements: "Requires JavaScript",
    isAccessibleForFree: true,
    offers:              { "@type": "Offer", price: 0, priceCurrency: "USD" },
    author
  }
  const site: WithContext<WebSite> = {
    "@context":    "https://schema.org",
    "@type":       "WebSite",
    name:          NAME,
    alternateName: ["not unh", "notUNH"],
    url:           SITE + "/"
  }
  return path === "/" ? [site, app] : [app]
}

/**
 * JSON for inside a <script>, where only a "<" could end it early or open a comment. Escaped here as JSON's \u003c,
 * since bruh's own escape for scripts, \x3C, is JavaScript but not JSON
 */
export const scriptJson = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c")
