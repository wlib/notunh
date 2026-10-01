/** @jsxImportSource bruh/browser */

// A meal's menu by station, or every upcoming food matching a search

import { r } from "bruh/reactive"
import { passes } from "../menus.mts"
import { data, today, hall, menu, query, filters, search, servings, goToFood, hallName } from "../state.mts"
import { Count, Plural } from "../../shell/intl.tsx"
import { FoodItem } from "./Food.tsx"
import { DayName, mealName } from "./common.tsx"

const MAX_RESULTS = 60
/** Meals listed under a search result */
const MAX_SERVINGS = 6

export const MenuView = () =>
  r(() => {
    const current = menu.value
    if (!current)
      return <p class="empty muted">{hallName(hall.value)} hasn't posted a menu for that day yet.</p>

    const stations = current.stations
      .map(station => ({ ...station, foods: station.foods.filter(food => passes(data.foods[food], filters.value)) }))
      .filter(station => station.foods.length)
    const count = (list: { foods: number[] }[]) => list.reduce((total, station) => total + station.foods.length, 0)
    const hidden = count(current.stations) - count(stations)

    return (
      <>
        {stations.length
          ? <div class="stations">
              {stations.map(station =>
                <section class="station">
                  <h2 class="eyebrow">{station.name}</h2>
                  <ul>
                    {station.foods.map(food => <FoodItem index={food} />)}
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
    const found = search(query.value).filter(({ food }) =>
      servings.get(food)?.some(menu => menu.date >= today) &&
      passes(data.foods[food], filters.value)
    )

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
          {found.slice(0, MAX_RESULTS).map(match =>
            <FoodItem index={match.food} match={match}>
              <span class="servings">
                {servings.get(match.food)!.filter(menu => menu.date >= today).slice(0, MAX_SERVINGS).map(menu =>
                  <button
                    type="button"
                    class="chip"
                    onclick={event => {
                      // Go to the menu rather than opening the food
                      event.preventDefault()
                      goToFood(match.food, menu)
                    }}
                  >
                    <DayName date={menu.date} /> · {hallName(menu.hall).split(" ")[0]} · {mealName(menu.meal)}
                  </button>
                )}
              </span>
            </FoodItem>
          )}
        </ul>
      </>
    )
  })
