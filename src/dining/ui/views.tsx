/** @jsxImportSource bruh/browser */

// A meal's menu by station, or every upcoming food matching a search

import { r } from "bruh/reactive"
import { passes, type FoodSummary } from "../menus.mts"
import { spansOn } from "../hours.mts"
import { index, hall, day, dayMeals, menu, query, filters, searchable, hasFailed, goToFood, hallName } from "../state.mts"
import { today } from "../../shell/lifecycle.mts"
import { Count, Counted } from "../../shell/intl.tsx"
import { FoodItem } from "./Food.tsx"
import { DayName, mealName } from "./common.tsx"
import { capture } from "../../shell/usage.tsx"

const MAX_RESULTS = 60
/** Meals listed under a search result */
const MAX_SERVINGS = 6

const Failed = () =>
  <p class="empty muted">Couldn't load the menus yet. Trying again…</p>

export const MenuView = () =>
  r(() => {
    if (hasFailed.value)
      return <Failed />
    if (!dayMeals.value)
      return <p class="empty muted">Loading the menu…</p>

    const current = menu.value
    const hours = index.value.hours[hall.value]
    if (!current)
      return (
        <p class="empty muted">
          {hours && !spansOn(hours, day.value).length
            ? `${hallName(hall.value)} is closed that day.`
            : `${hallName(hall.value)} hasn't posted a menu for that day yet.`
          }
        </p>
      )

    const stations = current.stations
      .map(station => ({ ...station, foods: station.foods.filter(food => passes(food, filters.value)) }))
      .filter(station => station.foods.length)
    const count = (list: { foods: FoodSummary[] }[]) => list.reduce((total, station) => total + station.foods.length, 0)
    const hidden = count(current.stations) - count(stations)

    return (
      <>
        {stations.length
          ? <div class="stations">
              {stations.map(station =>
                <section class="station">
                  <h2 class="eyebrow">{station.name}</h2>
                  <ul>
                    {station.foods.map(food => <FoodItem food={food} />)}
                  </ul>
                </section>
              )}
            </div>
          : <p class="empty muted">Nothing at this meal fits your filters.</p>
        }
        {hidden > 0 &&
          <p class="muted footnote">
            <Counted value={hidden} one="item hidden by your filters" other="items hidden by your filters" />
          </p>
        }
      </>
    )
  })

export const SearchView = () =>
  r(() => {
    if (hasFailed.value)
      return <Failed />
    if (!searchable.value)
      return <p class="empty muted">Loading every upcoming menu to search…</p>

    const { foods, search } = searchable.value
    const found = search(query.value)
      .map(match => ({ match, food: foods[match.food], servings: foods[match.food].servings.filter(serving => serving.day >= today.value) }))
      .filter(({ food, servings }) => servings.length && passes(food, filters.value))

    if (!found.length)
      return <p class="empty muted">Nothing on the upcoming menus matches “{query.value.trim()}”.</p>

    return (
      <>
        <p class="muted footnote">
          {found.length > MAX_RESULTS
            ? <>First <Count value={MAX_RESULTS} /> of <Count value={found.length} /> foods</>
            : <Counted value={found.length} one="food" other="foods" />
          }
        </p>
        <ul class="results">
          {found.slice(0, MAX_RESULTS).map(({ match, food, servings }) =>
            <FoodItem food={food} match={match}>
              <span class="servings">
                {servings.slice(0, MAX_SERVINGS).map(serving =>
                  <button
                    type="button"
                    class="chip"
                    onclick={event => {
                      // Go to the menu rather than opening the food
                      event.preventDefault()
                      goToFood(food.file, serving)
                      capture("dining_result_opened")
                    }}
                  >
                    <DayName of={serving.day} /> · {hallName(serving.hall).split(" ")[0]} · {mealName(serving.meal)}
                  </button>
                )}
              </span>
            </FoodItem>
          )}
        </ul>
      </>
    )
  })
