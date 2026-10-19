// The standard normal distribution, which the bus models measure most of what's uncertain by

/** Its density */
export const density = (z: number) =>
  Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI)

/** Its cumulative distribution, to 1.5e-7 (Abramowitz and Stegun 7.1.26) */
export const cdf = (z: number) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z / 2)
  return z >= 0 ? 1 - erfc / 2 : erfc / 2
}

/** Its quantile, to within 5e-4 (Abramowitz and Stegun 26.2.23) */
export const probit = (p: number): number => {
  if (p === 0.5)
    return 0
  if (p > 0.5)
    return -probit(1 - p)
  const t = Math.sqrt(-2 * Math.log(p))
  return -(t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t))
}

/**
 * How much longer than some seconds something log-normally long, with a mean log and a spread, lasts on average,
 * once it's lasted them: far into its tail, where the ratio of the two tails loses its precision, as that tends to
 */
export const meanResidual = (mu: number, sigma: number, elapsed: number) => {
  if (elapsed <= 0)
    return Math.exp(mu + sigma * sigma / 2)
  const z = (Math.log(elapsed) - mu) / sigma
  return z > 3 ? elapsed * sigma / z : Math.exp(mu + sigma * sigma / 2) * cdf(sigma - z) / cdf(-z) - elapsed
}
