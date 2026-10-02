// You on the map: a dot carried along at your speed between fixes and eased into each new one, as the buses
// are, with how sure the fix is around it and which way you're going. On a bus you're shown as the bus. The
// locate button keeps the map following you until it's moved by hand

import { watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, IControl, Map as MapLibre } from "maplibre-gl"
import { MIN_SPEED, reckon, type Fix } from "./fixes.mts"
import { location, locationProblem, currentLocation } from "./location.mts"
import { coveredPadding, metersPerPixel, type Coordinates } from "./geometry.mts"

const BLEND_MS    = 1000   // to ease from where the dot was drawn to where a new fix puts it
const FRAME_MS    = 50     // ~20 fps, unless the map is following, which moves with every frame
const STALE_MS    = 60_000 // an older fix is shown faded, as you may have moved since
const FOLLOW_ZOOM = 16

// The page's accent, light, which reads on the map either way
const COLOR = "#1a469d"

const headingIcon = () => {
  const size = 48
  const center = size / 2
  const canvas = new OffscreenCanvas(size * 2, size * 2)
  const context = canvas.getContext("2d")!
  context.scale(2, 2)
  // A soft wedge ahead of the dot, pointing north before rotation
  const gradient = context.createRadialGradient(center, center, 4, center, center, center)
  gradient.addColorStop(0, `${COLOR}aa`)
  gradient.addColorStop(1, `${COLOR}00`)
  context.beginPath()
  context.moveTo(center, center)
  context.arc(center, center, center, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5)
  context.closePath()
  context.fillStyle = gradient
  context.fill()
  return { width: size * 2, height: size * 2, data: new Uint8Array(context.getImageData(0, 0, size * 2, size * 2).data.buffer) }
}

export const showYou = (
  map: MapLibre,
  panel: HTMLElement,
  /** The bus you're on, which you're drawn as instead */
  riding: Reactive<string | undefined>,
  busPosition: (id: string) => Coordinates | undefined
) => {
  let fix: Fix | undefined
  /** How far the drawn dot was from a new fix, eased away */
  let correction: Coordinates = [0, 0]
  let correctedAt = 0

  const drawn = (now: number): Coordinates | undefined => {
    if (!fix)
      return
    const remaining = Math.max(0, 1 - (now - correctedAt) / BLEND_MS)
    const [lon, lat] = reckon(fix, Date.now())
    return [lon + correction[0] * remaining, lat + correction[1] * remaining]
  }

  watch(() => {
    const next = location.value
    if (!next)
      return
    const now = performance.now()
    const was = drawn(now)
    fix = next
    const is = drawn(now)!
    correction = was ? [was[0] - is[0], was[1] - is[1]] : [0, 0]
    correctedAt = now
  })

  let isFollowing = false
  // Touching the map lets go of following straight away, as following moves the map every frame, which would
  // otherwise cancel a drag before maplibre counted it as one
  for (const type of ["pointerdown", "wheel", "keydown"])
    map.getCanvasContainer().addEventListener(type, () => setFollowing(false), { capture: true, passive: true })

  /** Where you are right now, as the bus if you're on one */
  const here = (now: number) => {
    const bus = riding.peek()
    return (bus && busPosition(bus)) || drawn(now)
  }

  const follow = (now: number, isFirst = false) => {
    const point = here(now)
    if (!point)
      return
    const padding = coveredPadding(map.getContainer().getBoundingClientRect(), panel.getBoundingClientRect())
    if (isFirst)
      map.easeTo({ center: point, zoom: Math.max(map.getZoom(), FOLLOW_ZOOM), padding })
    else if (!map.isMoving())
      map.jumpTo({ center: point, padding })
  }

  let lastFrame = 0
  let wasShown = false
  const render = (now: number) => {
    requestAnimationFrame(render)
    if (!isFollowing && now - lastFrame < FRAME_MS)
      return
    lastFrame = now

    const point = drawn(now)
    const isOnBus = riding.peek() !== undefined && busPosition(riding.peek()!) !== undefined
    const features: GeoJSON.Feature[] = !fix || !point || isOnBus ? [] : [{
      type: "Feature",
      properties: {
        radius: fix.accuracy / metersPerPixel(fix.lat, 0),
        opacity: Date.now() - fix.at > STALE_MS ? 0.4 : 1,
        ...fix.heading !== undefined && (fix.speed ?? 0) >= MIN_SPEED ? { heading: fix.heading } : {}
      },
      geometry: { type: "Point", coordinates: point }
    }]
    if (features.length || wasShown)
      map.getSource<GeoJSONSource>("you")!.setData({ type: "FeatureCollection", features })
    wasShown = features.length > 0
    if (isFollowing)
      follow(now)
  }
  /** Draws you over everything else, once the map's style has loaded and its other layers are in */
  const draw = () => {
    map.addImage("you-heading", headingIcon(), { pixelRatio: 2 })
    map.addSource("you", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
    map.addLayer({
      id: "you-accuracy",
      type: "circle",
      source: "you",
      paint: {
        "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 0, ["get", "radius"], 22, ["*", ["get", "radius"], 2 ** 22]],
        "circle-color": COLOR,
        "circle-opacity": 0.12,
        "circle-pitch-alignment": "map"
      }
    })
    map.addLayer({
      id: "you-heading",
      type: "symbol",
      source: "you",
      filter: ["has", "heading"],
      layout: {
        "icon-image": "you-heading",
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    })
    map.addLayer({
      id: "you",
      type: "circle",
      source: "you",
      paint: {
        "circle-radius": 7,
        "circle-color": COLOR,
        "circle-stroke-color": "white",
        "circle-stroke-width": 2.5,
        "circle-opacity": ["get", "opacity"],
        "circle-stroke-opacity": ["get", "opacity"]
      }
    })
    requestAnimationFrame(render)
  }

  const button = document.createElement("button")
  button.type = "button"
  button.className = "maplibregl-ctrl-geolocate"
  button.title = "Follow your location"
  button.setAttribute("aria-label", "Follow your location")
  button.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>'

  // maplibre's own looks for its location button: finding you, following you, showing you, or failed
  let isWaiting = false
  let hasFailed = false
  const paint = () => {
    const states = {
      waiting:    isWaiting,
      active:     isFollowing && !hasFailed,
      background: !isFollowing && !isWaiting && !hasFailed && location.peek() !== undefined,
      "active-error": hasFailed
    }
    for (const [state, isOn] of Object.entries(states))
      button.classList.toggle(`maplibregl-ctrl-geolocate-${state}`, isOn)
    button.setAttribute("aria-pressed", String(isFollowing))
  }
  watch([location], paint)

  const setFollowing = (value: boolean) => {
    isFollowing = value
    paint()
  }

  button.addEventListener("click", async () => {
    if (isFollowing)
      return setFollowing(false)
    locationProblem.value = undefined
    isWaiting = true
    hasFailed = false
    paint()
    try {
      await currentLocation({ fresh: Infinity })
      isFollowing = true
      follow(performance.now(), true)
    }
    catch (problem) {
      hasFailed = true
      locationProblem.value = problem as string
    }
    isWaiting = false
    paint()
  })

  const control: IControl = {
    onAdd: () => {
      const container = document.createElement("div")
      container.className = "maplibregl-ctrl maplibregl-ctrl-group"
      container.append(button)
      return container
    },
    onRemove: () => {}
  }
  map.addControl(control, "top-right")
  return draw
}
