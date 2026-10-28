// The site's pages as search engines and link previews see them: its one origin and name, and each page's title,
// description and name, read by every page's head (Head.tsx), its structured data (structured.mts), the social images,
// the sitemap (scripts/search.mts), and IndexNow (scripts/indexnow.mts), so they can't disagree

export { SITE } from "../shared/site.mts"

export const NAME = "notunh"

/** IndexNow's key (scripts/indexnow.mts), public by design: served at /<key>.txt to show the site is ours to submit */
export const INDEXNOW_KEY = "e83e399a2da2bed37da4f7df04e60177"

export const AUTHOR = { name: "Daniel Ethridge", url: "https://github.com/wlib" }

export const REPO = "https://github.com/wlib/notunh"

/** What else people call the site, which Google may take its name from, and which keeps "notunh" from being corrected */
export const ALTERNATE_NAMES = ["not UNH", "notUNH", "notunh.app"]

export type Page = {
  /** Worded as people search for what the page does, and naming the app */
  title:       string,
  /** At most about 155 characters, as search results show; also each page's shell says it */
  description: string,
  /** What the page's social image says beside the wordmark, in two or three words */
  label:       string,
  /** What the social image shows besides its words, for those who can't see it */
  shows:       string,
  /** Its name in the trail to a page under it, as a link in the home page's own words */
  name:        string
}

export const PAGES = {
  "/": {
    title:       "notunh: UNH map, bus tracker, events, dining menus & laundry",
    description: "An unofficial UNH app: live Wildcat Transit buses, the campus map, today's events, classes, parking, Holloway and Philbrook menus, and a free washer.",
    label:       "Map, menus, laundry",
    shows:       "A map of central UNH around Thompson Hall with a Gables Connector bus on Main Street, beside phones showing a laundry room's machines and Philbrook's lunch. Marked unofficial.",
    name:        "notunh"
  },
  "/map/": {
    title:       "UNH Bus Tracker & Campus Map: Live Wildcat Transit · notunh",
    description: "Every Wildcat Transit bus live, UNH events today, directions by bus or on foot, where a class or professor is next, and where to park.",
    label:       "Buses & directions",
    shows:       "A 3D map looking down Main Street at UNH over Thompson Hall's lawn, with a Gables Connector bus between the Whittemore Center and Thompson Hall stops. Marked unofficial.",
    name:        "Map"
  },
  "/dining/": {
    title:       "UNH Dining Menus Today: Holloway & Philbrook · notunh",
    description: "What's for breakfast, lunch, and dinner at Holloway and Philbrook all week, with each hall's hours and filters for your diet and allergies.",
    label:       "Dining menus",
    shows:       "Phones over a map of campus: Holloway Commons' lunch with a dish opened to its ingredients and nutrition, and Philbrook Hall's menu beside it. Marked unofficial.",
    name:        "Dining"
  },
  "/laundry/": {
    title:       "UNH Laundry: Free Washers & Dryers by Hall · notunh",
    description: "See which washers and dryers are free in your UNH residence hall before you carry the basket down, and how long until the rest are done.",
    label:       "Laundry",
    shows:       "Phones over a map of campus: which of a residence hall's washers and dryers are free and how long the rest have left, and the list of rooms behind. Marked unofficial.",
    name:        "Laundry"
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

/**
 * JSON for inside a <script>, where only a "<" could end it early or open a comment. Escaped here as JSON's \u003c,
 * since bruh's own escape for scripts, \x3C, is JavaScript but not JSON
 */
export const scriptJson = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c")
