/** @jsxImportSource bruh/browser */

// A building's profile on its place's page (Pages.tsx), from the profiles the build makes of the judged records
// (src/places/profiles.mts): under Directions, its photos as a strip that opens a viewer over everything, crediting
// and licensing each as its license asks, then its verdict, rating and scores; below what's on there, what it is and
// its facts, each citing its sources; and at the page's foot, who took the photos. Photos are the licensors' own,
// never cached by the service worker, so offline each tile says what it shows instead

import { type Photo, type Profile, DIMENSIONS, rankText, thumbOf } from "../../places/profiles.mts"

/** A photo, or where it can't load, as offline, what it shows */
const Shot = ({ photo, src, eager = false }: { photo: Photo, src: string, eager?: boolean }) => {
  const img: HTMLImageElement =
    <img src={src} alt={photo.caption} loading={eager ? "eager" : "lazy"} decoding="async" onerror={() => img.hidden = true} />
  return <>{img}<span class="shot-alt" aria-hidden="true">{photo.caption}</span></>
}

/** Who took a photo and its license, each linking to its page, as the license asks */
const Credit = ({ photo }: { photo: Photo }) =>
  <>
    <a href={photo.page} target="_blank" rel="noopener">{photo.credit}</a>
    {", "}
    {photo.licenseUrl ? <a href={photo.licenseUrl} target="_blank" rel="noopener">{photo.license}</a> : photo.license}
  </>

/**
 * The photos as a strip, each opening a viewer over the whole screen at it, which swipes through them all, each with
 * its caption, credit and license, till Close or Escape
 */
export const Photos = ({ name, photos }: { name: string, photos: readonly Photo[] }) => {
  const slides = photos.map(photo =>
    <li>
      <figure>
        <div class="shot"><Shot photo={photo} src={photo.url} /></div>
        <figcaption>
          {photo.caption}{photo.year !== undefined && `, ${photo.year}`}
          <small><Credit photo={photo} /></small>
        </figcaption>
      </figure>
    </li> as HTMLLIElement
  )
  const strip: HTMLUListElement = <ul>{slides}</ul>
  // Close comes first, so it's what the dialog focuses as it opens, rather than a credit's link in the first slide
  const viewer: HTMLDialogElement =
    <dialog class="viewer" aria-label={`Photos of ${name}`}>
      <button type="button" class="viewer-close" aria-label="Close" onclick={() => viewer.close()}><span class="icon icon-close" /></button>
      {strip}
    </dialog>
  const open = (i: number) => {
    viewer.showModal()
    // Scrolled a frame later, as WebKit snaps a scroller just shown back to its start
    requestAnimationFrame(() => strip.scrollLeft = slides[i].offsetLeft)
  }
  return (
    <>
      <ul class="photo-strip" aria-label="Photos">
        {photos.map((photo, i) =>
          <li><button type="button" class="shot" onclick={() => open(i)}><Shot photo={photo} src={thumbOf(photo.url)} eager={i === 0} /></button></li>
        )}
      </ul>
      {viewer}
    </>
  )
}

/** Who took the photos, each named once, linking to their first photo's page, as a page's foot says */
export const PhotoCredits = ({ photos }: { photos: readonly Photo[] }) =>
  <p class="view-foot muted credits">
    Photos: {photos
      .filter(({ credit }, i) => photos.findIndex(photo => photo.credit === credit) === i)
      .map(({ credit, page }, i) => <>{i > 0 && ", "}<a href={page} target="_blank" rel="noopener">{credit}</a></>)}
  </p>

/**
 * The verdict, then the rating in a line, its overall of ten and rank, over the six scores it's the weighted mean of.
 * Numbers as text, not Intl elements, which fill in a tick later and would reflow the page under a scroll restored
 */
export const Rating = ({ profile, ranked }: { profile: Profile, ranked: number }) =>
  <>
    {profile.verdict && <p class="verdict">{profile.verdict}</p>}
    {profile.rating && <>
      <p class="rating"><strong>{profile.rating.overall}</strong> of 10 · {rankText(profile, ranked)}</p>
      <dl class="scores">{DIMENSIONS.map(dimension => <div><dt>{dimension}</dt><dd>{profile.rating![dimension]}</dd></div>)}</dl>
    </>}
  </>

/**
 * What a building is for, its style and who designed it, a line each, and its facts, each followed by the sources it
 * cites, by their publishers
 */
export const About = ({ profile }: { profile: Profile }) => {
  const what = [profile.use, profile.style, profile.architect && `Designed by ${profile.architect}`].filter(Boolean)
  return (what.length > 0 || profile.facts.length > 0) &&
    <>
      <h3 class="eyebrow">About</h3>
      {what.map(line => <p class="view-facts">{line}</p>)}
      {profile.facts.length > 0 &&
        <ul class="facts">
          {profile.facts.map(({ text, src }) =>
            <li>
              {text}
              {src.map((id, i) => {
                const source = profile.sources[id]
                return <>{i ? ", " : " "}<a class="cite" href={source.url} target="_blank" rel="noopener" title={source.title}>{source.publisher ?? source.title}</a></>
              })}
            </li>
          )}
        </ul>}
    </>
}
