/** @jsxImportSource bruh/browser */

import { today, tomorrow } from "../state.mts"
import { Day, relativeDay } from "../../shell/intl.tsx"

/** "Today", "Tomorrow", or the weekday */
export const DayName = ({ date }: { date: string }) =>
  date === today    ? relativeDay(0) :
  date === tomorrow ? relativeDay(1) :
                      <Day date={date} weekday="short" />

export const mealName = (meal: string) =>
  meal[0].toUpperCase() + meal.slice(1)
