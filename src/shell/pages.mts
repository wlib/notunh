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
  /** What the social image says in large type */
  heading:     string,
  /** Its kind among Google's software app categories */
  category:    string
}

export const PAGES = {
  "/": {
    title:       "notunh: UNH buses, dining menus, and laundry",
    description: "Live UNH bus map, Holloway and Philbrook menus, and which washers and dryers are free in every residence hall. A free, unofficial app for UNH students.",
    heading:     "UNH buses, dining menus, and laundry",
    category:    "LifestyleApplication"
  },
  "/map/": {
    title:       "UNH Bus Map & Live Wildcat Transit · notunh",
    description: "Live Wildcat Transit bus locations and arrival times at UNH, with directions around campus and Durham by bus or on foot.",
    heading:     "UNH bus map",
    category:    "TravelApplication"
  },
  "/dining/": {
    title:       "UNH Dining Menus: Holloway & Philbrook · notunh",
    description: "Every meal's menu at Holloway Commons and Philbrook Hall, UNH's dining halls, with hours, ingredients, allergens, diet filters, and nutrition.",
    heading:     "UNH dining menus",
    category:    "LifestyleApplication"
  },
  "/laundry/": {
    title:       "UNH Laundry: Free Washers & Dryers · notunh",
    description: "Which washers and dryers are free right now in every UNH residence hall laundry room, and when each room is usually busy.",
    heading:     "UNH laundry",
    category:    "UtilitiesApplication"
  }
} as const satisfies Record<string, Page>

export type Path = keyof typeof PAGES

export const PATHS = Object.keys(PAGES) as Path[]

/** A page's social image, served beside the site rather than under the page, where a laundry room's path would reach the Worker */
export const imageOf = (path: Path) =>
  `/social${path}card.png`

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
