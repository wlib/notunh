/** @jsxImportSource bruh/browser */

// Search, then which hall, day, and meal, and the filters for diets and allergens

import { r, watch } from "bruh/reactive"
import type { BruhChild } from "bruh/browser"
import { MEALS, type Filters } from "../menus.mts"
import { index, dates, hall, date, meals, menu, preferredMeal, query, isSearching, filters, toggleFilter } from "../state.mts"
import { Day } from "../../shell/intl.tsx"
import { DayName, mealName } from "./common.tsx"
import { HallHours, OpenDot } from "./Hours.tsx"

const servedMeals = MEALS.filter(meal =>
  Object.values(index.days).some(days => Object.values(days).some(day => day.meals.includes(meal)))
)

const Segmented = <T extends string,>({ label, options, selected, choose, disabled }: {
  label: string,
  options: { value: T, label: BruhChild }[],
  selected: () => T,
  choose: (value: T) => void,
  disabled?: (value: T) => boolean
}) =>
  <div class="segmented" role="group" aria-label={label}>
    {options.map(option =>
      <button
        type="button"
        aria-pressed={r(() => selected() === option.value ? "true" : "false")}
        disabled={r(() => disabled?.(option.value) ?? false)}
        onclick={() => choose(option.value)}
      >
        {option.label}
      </button>
    )}
  </div>

const SearchInput = () => {
  const input: HTMLInputElement =
    <input
      type="search"
      placeholder="Search for a food or ingredient"
      aria-label="Search for a food or ingredient"
      enterkeyhint="search"
      autocomplete="off"
      oninput={() => query.value = input.value}
    />
  watch([query], () => {
    if (input.value !== query.value)
      input.value = query.value
  })
  return input
}

const Days = () =>
  <div class="days" role="group" aria-label="Day">
    {dates.map(day =>
      <button
        type="button"
        aria-pressed={r(() => date.value === day ? "true" : "false")}
        onclick={() => date.value = day}
      >
        <span><DayName date={day} /></span>
        <span class="muted"><Day date={day} month="short" day="numeric" /></span>
      </button>
    )}
  </div>

const FilterChips = ({ kind, items }: { kind: keyof Filters, items: string[] }) =>
  <div class="chips">
    {items.map(item =>
      <button
        type="button"
        class="chip"
        aria-pressed={r(() => filters.value[kind].has(item) ? "true" : "false")}
        onclick={() => toggleFilter(kind, item)}
      >
        {item}
      </button>
    )}
  </div>

const FiltersPanel = () => {
  const count = r(() => filters.value.diets.size + filters.value.avoid.size)
  return (
    <details class="filters">
      <summary>
        Diets and allergens{r(() => count.value ? ` · ${count.value} on` : "")}
      </summary>
      <p class="eyebrow">Only show</p>
      <FilterChips kind="diets" items={index.diets} />
      <p class="eyebrow">Hide anything with</p>
      <FilterChips kind="avoid" items={index.contains} />
    </details>
  )
}

export const Controls = () =>
  <div class="controls">
    <SearchInput />
    {r(() => !isSearching.value &&
      <>
        <Segmented
          label="Dining hall"
          options={index.halls.map(({ id, name }) => ({ value: id, label: <><OpenDot id={id} />{name}</> }))}
          selected={() => hall.value}
          choose={value => hall.value = value}
        />
        <HallHours />
        <Days />
        <Segmented
          label="Meal"
          options={servedMeals.map(meal => ({ value: meal, label: mealName(meal) }))}
          selected={() => menu.value?.meal ?? preferredMeal.value}
          choose={value => preferredMeal.value = value}
          disabled={value => !meals.value.includes(value)}
        />
      </>
    )}
    <FiltersPanel />
  </div>
