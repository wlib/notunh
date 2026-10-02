/** @jsxImportSource bruh/browser */

// A meal's menu by station, or every upcoming food matching a search

import { r } from "bruh/reactive"
import { passes, type FoodSummary } from "../menus.mts"
import { today, hall, dayMeals, menu, query, filters, searchable, hasFailed, goToFood, hallName } from "../state.mts"
import { Count, Plural } from "../../shell/intl.tsx"
import { FoodItem } from "./Food.tsx"
import { DayName, mealName } from "./common.tsx"

const MAX_RESULTS = 60
/** Meals listed under a search result */
const MAX_SERVINGS = 6

const Failed = () =>
  <p class="empty muted">Couldn't load the menus. Check your connection and reload the page.</p>

export const MenuView = () =>
  r(() => {
    if (hasFailed.value)
      return <Failed />
    if (!dayMeals.value)
      return <p class="empty muted">Loading the menu…</p>

    const current = menu.value
    if (!current)
      return <p class="empty muted">{hallName(hall.value)} hasn't posted a menu for that day yet.</p>

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
            <Plural value={hidden} one="1 item hidden by your filters" other={<><Count value={hidden} /> items hidden by your filters</>} />
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
      .map(match => ({ match, food: foods[match.food], servings: foods[match.food].servings.filter(serving => serving.date >= today) }))
      .filter(({ food, servings }) => servings.length && passes(food, filters.value))

    if (!found.length)
      return <p class="empty muted">Nothing on the upcoming menus matches “{query.value.trim()}”.</p>

    return (
      <>
        <p class="muted footnote">
          {found.length > MAX_RESULTS
            ? <>First <Count value={MAX_RESULTS} /> of <Count value={found.length} /> foods</>
            : <Plural value={found.length} one="1 food" other={<><Count value={found.length} /> foods</>} />
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
                    }}
                  >
                    <DayName date={serving.date} /> · {hallName(serving.hall).split(" ")[0]} · {mealName(serving.meal)}
                  </button>
                )}
              </span>
            </FoodItem>
          )}
        </ul>
      </>
    )
  })
