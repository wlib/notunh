/** @jsxImportSource bruh/browser */

import { today } from "../../shell/lifecycle.mts"
import { addDays, type Day as CalendarDay } from "../../shared/time.mts"
import { Day, relativeDay } from "../../shell/intl.tsx"

/** "Today", "Tomorrow", or the weekday */
export const DayName = ({ of }: { of: CalendarDay }) =>
  of === today.value             ? relativeDay(0) :
  of === addDays(today.value, 1) ? relativeDay(1) :
                                   <Day of={of} weekday="short" />

export const mealName = (meal: string) =>
  meal[0].toUpperCase() + meal.slice(1)
