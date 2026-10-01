/** @jsxImportSource bruh/browser */

// A food in a menu or search results, opening to its ingredients and nutrition

import { bruhChildrenToNodes, type BruhChild } from "bruh/browser"
import uFuzzy from "@leeoniya/ufuzzy"
import { NUTRIENTS, type Food } from "../menus.mts"
import { nameOf, partsOf, type Ingredient } from "../ingredients.mts"
import type { Match } from "../search.mts"
import { data, focusedFood } from "../state.mts"
import { Count, List, Quantity } from "../../shell/intl.tsx"

/** Text with uFuzzy's matched ranges marked */
const marked = (text: string, ranges?: number[]) =>
  ranges
    ? uFuzzy.highlight<BruhChild[], BruhChild>(
        text,
        ranges,
        (part, isMatched) => isMatched ? <mark>{part}</mark> : part,
        [],
        (parts, part) => [...parts, part]
      )
    : text

const DIET_BADGES: Record<string, string> = { Vegan: "VG", Vegetarian: "V", Halal: "H" }

/** Vegan already says vegetarian */
const shownDiets = (food: Food) =>
  food.diets.filter(diet => diet !== "Vegetarian" || !food.diets.includes("Vegan"))

// Clauses like "Contains 2% or less of" lead into what follows, rather than being made of it
const isLeadIn = (name: string) => /^contains?\b|\bof( the following( \p{L}+)?)?$/iu.test(name)

/** An ingredient and what it's made of, inline as on a label */
const IngredientText = ({ ingredient, found }: { ingredient: Ingredient, found: Match["ingredients"] }): BruhChild => {
  const name = nameOf(ingredient)
  const parts = partsOf(ingredient)
  const items = parts.map(part => <IngredientText ingredient={part} found={found} />)
  return [
    marked(name, found.get(name)),
    parts.length > 0 && (
      isLeadIn(name)
        ? [": ", <List type="unit" items={items} />]
        : [" (", <List type="unit" items={items} />, ")"]
    )
  ]
}

const FoodDetails = ({ food, found }: { food: Food, found: Match["ingredients"] }) => {
  const nutrients = NUTRIENTS.filter(({ key }) => food.nutrition[key] !== undefined)
  return (
    <>
      {food.description && <p>{food.description}</p>}
      {(food.serving || food.stars) &&
        <p class="muted">
          {food.serving && <>Serving: {food.serving}</>}
          {food.serving && food.stars && " · "}
          {food.stars && <>Guiding Stars {"★".repeat(food.stars)}</>}
        </p>
      }
      {food.contains.length > 0 &&
        <p><strong>Contains</strong> <List items={food.contains} /></p>
      }
      {food.ingredients &&
        <>
          <p><strong>Ingredients</strong></p>
          <ul class="ingredients">
            {food.ingredients.map(ingredient => <li><IngredientText ingredient={ingredient} found={found} /></li>)}
          </ul>
        </>
      }
      {nutrients.length > 0 &&
        <dl class="nutrition">
          {nutrients.map(({ key, label, unit }) =>
            <div>
              <dt>{label}</dt>
              <dd>{unit ? <Quantity value={food.nutrition[key]!} unit={unit} digits={1} /> : <Count value={food.nutrition[key]!} />}</dd>
            </div>
          )}
        </dl>
      }
    </>
  )
}

export const FoodItem = ({ index, match, children }: { index: number, match?: Match, children?: BruhChild }) => {
  const food = data.foods[index]
  const found = match?.ingredients ?? new Map()
  // Details are only built once opened, since most never are
  const body = <div class="food-details" /> as HTMLElement
  const details: HTMLDetailsElement =
    <details
      class="food"
      ontoggle={() => {
        if (details.open && !body.hasChildNodes())
          body.replaceChildren(...bruhChildrenToNodes([<FoodDetails food={food} found={found} />]))
      }}
    >
      <summary>
        <span class="food-name">{marked(food.name, match?.name)}</span>
        <span class="food-tags">
          {shownDiets(food).map(diet => <abbr class="diet" title={diet}>{DIET_BADGES[diet] ?? diet}</abbr>)}
          {/* Zero is what placeholders like "Salad Bar" list, not a measurement */}
          {food.nutrition.calories ? <span class="muted"><Count value={food.nutrition.calories} /> cal</span> : undefined}
        </span>
        {!match?.name && found.size > 0 &&
          <span class="food-excerpt muted">
            In <List items={[...found].slice(0, 3).map(([name, ranges]) => marked(name, ranges))} />
          </span>
        }
        {children}
      </summary>
      {body}
    </details>

  if (!match && focusedFood.peek() === index) {
    focusedFood.value = undefined
    details.open = true
    requestAnimationFrame(() => details.scrollIntoView({ block: "center" }))
  }
  return <li>{details}</li>
}
