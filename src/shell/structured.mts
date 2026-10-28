// Structured data, only of the kinds Google shows something for: the site's name and logo on the home page (WebSite,
// Organization), the trail to a page (BreadcrumbList), and an official event's when and where (Event), which makes
// it eligible for Google's events (https://developers.google.com/search/docs/appearance/structured-data/event).
// Nothing is said that isn't known: an event is described only at a place the map knows in Durham, its organizer only
// where its calendar says who that is, and never what it costs

import type { BreadcrumbList, Event as EventThing, Organization, Thing, WebSite, WithContext } from "schema-dts"
import { type Event, calendarOf } from "../social/event.mts"
import type { GazetteerPlace } from "../places/gazetteer.mts"
import { chapterNamed } from "../places/chapters.mts"
import { ADDRESS, isInDurham } from "../places/durham.mts"
import { isoOf } from "../shared/time.mts"
import { ALTERNATE_NAMES, AUTHOR, NAME, PAGES, type Path, REPO, SITE } from "./pages.mts"

const CONTEXT = "https://schema.org"

/** The site's logo, as Google shows it beside its name */
const LOGO = "/icon-512.png"

/** A step of the trail to a page: its name, and its address, which the page itself needn't give */
export type Crumb = { name: string, url?: string }

/** The trail to a page under one of the site's, by its own name and address, as breadcrumbs say it */
export const trailTo = (path: Path, name?: string, url?: string): Crumb[] => [
  { name: NAME, url: SITE + "/" },
  ...path === "/" ? [] : [{ name: PAGES[path].name, url: SITE + path }],
  ...name === undefined ? [] : [{ name, url }]
]

export const breadcrumbsOf = (trail: readonly Crumb[]): WithContext<BreadcrumbList> => ({
  "@context":      CONTEXT,
  "@type":         "BreadcrumbList",
  itemListElement: trail.map(({ name, url }, index) => ({ "@type": "ListItem", position: index + 1, name, ...url && { item: url } }))
})

/** The site, by the names people type for it, and who makes it, with its logo, which the home page says */
const SITE_DATA: [WithContext<WebSite>, WithContext<Organization>] = [
  { "@context": CONTEXT, "@type": "WebSite", name: NAME, alternateName: ALTERNATE_NAMES, url: SITE + "/" },
  { "@context": CONTEXT, "@type": "Organization", name: NAME, alternateName: ALTERNATE_NAMES, url: SITE + "/", logo: SITE + LOGO, sameAs: [REPO], founder: { "@type": "Person", ...AUTHOR, sameAs: AUTHOR.url } }
]

/** A built page's structured data: the home page names the site, which Google takes its name and logo from, and the rest their place under it */
export const structuredDataOf = (path: Path): WithContext<Thing>[] =>
  path === "/" ? SITE_DATA : [breadcrumbsOf(trailTo(path))]

/**
 * An official event's structured data, at its place, as its page and card are at their addresses, or none for one the
 * map doesn't place in Durham, or that someone made here, which is theirs and not for search
 */
export const eventDataOf = ({ event, place, url, image, description }: {
  event:       Event,
  place:       Pick<GazetteerPlace, "name" | "at"> | undefined,
  url:         string,
  image:       string,
  description: string
}): WithContext<EventThing> | undefined => {
  const organizer = calendarOf(event)?.organizer
  if (!place || event.source === "pin" || event.source === "course" || !isInDurham({ lon: place.at[0], lat: place.at[1] }))
    return
  const street = chapterNamed(place.name)?.house?.address
  return {
    "@context":          CONTEXT,
    "@type":             "Event",
    name:                event.title,
    startDate:           isoOf(event.start),
    ...event.end > event.start && { endDate: isoOf(event.end) },
    eventStatus:         "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location:            { "@type": "Place", name: place.name, address: { "@type": "PostalAddress", ...street && { streetAddress: street }, ...ADDRESS } },
    description,
    image:               [image],
    url,
    ...organizer && { organizer: { "@type": "Organization", ...organizer } }
  }
}
