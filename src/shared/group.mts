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

/** A map's value at a key, made and kept there the first time it's asked for */
export const getOrCreate = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
  let value = map.get(key)
  if (value === undefined)
    map.set(key, value = make())
  return value
}
