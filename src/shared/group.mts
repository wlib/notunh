// Map.groupBy, which Safari only has from 17.4

/** Items by a key of each, in order */
export const groupBy = <T, K>(items: Iterable<T>, keyOf: (item: T) => K) => {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group)
      group.push(item)
    else
      groups.set(key, [item])
  }
  return groups
}
