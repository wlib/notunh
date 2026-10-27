// Instructors' addresses as they ship: never as an address. The course API gives them in the clear, and UNH shows
// them on its own pages, so there's nothing to keep secret, only something to keep out of a scraper's regex over our
// static HTML and JSON. An address is hidden at build time (scripts/map/courses.mts) and revealed on the device at
// the moment a person taps it, into a mailto: the page never holds. Two addresses hide to two different strings and
// reveal(hide(x)) is x; the hidden form has no "@", no "." and no "edu", so nothing that matches an address

/** The characters an address may use, as the alphabet the shift runs over */
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.@_-+'"
const SHIFT    = 17

const shifted = (text: string, by: number) =>
  [...text].map(char => {
    const i = ALPHABET.indexOf(char)
    return i < 0 ? char : ALPHABET[(i + by + ALPHABET.length) % ALPHABET.length]
  }).join("")

/** An address as it ships: shifted over the alphabet, then reversed */
export const hide = (email: string) =>
  [...shifted(email, SHIFT)].reverse().join("")

/** The address a hidden string is */
export const reveal = (hidden: string) =>
  shifted([...hidden].reverse().join(""), -SHIFT)

/** The mailto: of a hidden address, made only as it's tapped */
export const mailto = (hidden: string) =>
  `mailto:${reveal(hidden)}`

/** What an address looks like to a scanner, which nothing shipped may */
export const LOOKS_LIKE_EMAIL = /[\w.+'-]+@[\w-]+(\.[\w-]+)+/
