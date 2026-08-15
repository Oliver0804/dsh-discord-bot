/**
 * What a session cost, and whether right now is the expensive half of the day.
 *
 * DeepSeek bills prompt tokens in two tiers — cache hit and cache miss — at a
 * 1:30 ratio, and output at no discount at all. Since 2026-08-17 00:00 Beijing
 * time the whole table also has a peak and an off-peak column, and off-peak is
 * exactly half of peak in every bucket. That last fact is what makes an honest
 * estimate cheap: one computation yields both ends of the range.
 *
 * The range is the point. A session's token counts are a running total with no
 * time buckets in them, so a log that spans both halves of the day cannot be
 * priced to a single number — and pricing it at whatever period the reader
 * happens to be looking in would be wrong twice over, once for the span and
 * once for the delay. `estimate` reports the floor and the ceiling instead, and
 * the true figure is somewhere inside.
 *
 * Two things this deliberately does not do. It does not price a model it does
 * not know: an unrecognised id yields no estimate rather than a plausible wrong
 * one, so a future `deepseek-v5-pro` cannot be silently billed at v4 rates. And
 * it holds only the current table — sessions that ran before 2026-08-17 were
 * billed at the old flat prices, and this will over- or under-state them.
 */

/**
 * Off-peak rates in RMB per million tokens, keyed by provider then model id.
 * Peak is exactly double, which is why only one column is stored.
 *
 * Taken from DeepSeek's peak/off-peak pricing announcement, in effect from
 * 2026-08-17 00:00 Beijing time.
 */
const RATES = {
  'deepseek-official': {
    'deepseek-v4-flash': { hit: 0.05, miss: 1.5, output: 4.5 },
    'deepseek-v4-pro': { hit: 0.15, miss: 4.5, output: 13.5 },
  },
}

/** Hour-of-day boundaries, Beijing time, where the rate changes. */
const BOUNDARIES = [9, 12, 14, 18]

/** Anything below this rounds to zero at two decimals; say so rather than lie. */
const SUB_CENT = 0.01

/**
 * The hour in Beijing, derived from UTC rather than from the host clock — the
 * bot may well run somewhere that is not UTC+8, and the price does not care
 * where the server is.
 * @param {Date} date - the instant to read.
 * @returns {number} hour of day, 0–23, in UTC+8.
 */
function beijingHour(date) {
  return (date.getUTCHours() + 8) % 24
}

/**
 * Whether an instant falls in DeepSeek's peak window: 09:00–12:00 and
 * 14:00–18:00 Beijing time, each half-open at the top.
 * @param {Date} [date] - the instant to test; defaults to now.
 * @returns {boolean} true during peak pricing.
 */
export function isPeak(date = new Date()) {
  const hour = beijingHour(date)
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * The pricing period an instant sits in, and when it ends.
 * @param {Date} [date] - the instant to read; defaults to now.
 * @returns {{peak: boolean, until: string}} the period and its next boundary,
 *   as `HH:00` in Beijing time.
 */
export function currentPeriod(date = new Date()) {
  const hour = beijingHour(date)
  const next = BOUNDARIES.find((boundary) => boundary > hour) ?? BOUNDARIES[0]
  return { peak: isPeak(date), until: `${String(next).padStart(2, '0')}:00` }
}

/**
 * Price a session's token buckets, in RMB.
 *
 * The cache-write bucket is billed as a miss. DeepSeek never reports one — its
 * wire protocol has only hit and miss, which is why the published table has
 * three columns and not four — so this is zero in practice; it is folded in so
 * that a provider which does report writes cannot be silently under-counted.
 *
 * @param {object} buckets - raw counts from `readSessionStats`.
 * @param {object | undefined} selection - `{provider, model}` the session ran on.
 * @returns {{low: number, high: number} | undefined} the off-peak and peak ends
 *   of the estimate, or undefined when the model has no published price here.
 */
export function estimate(buckets, selection) {
  const rate = RATES[selection?.provider]?.[selection?.model]
  if (rate === undefined) return undefined

  const hit = buckets?.cacheReadTokens ?? 0
  const miss = (buckets?.uncachedInputTokens ?? 0) + (buckets?.cacheWriteTokens ?? 0)
  const output = buckets?.outputTokens ?? 0
  if (hit + miss + output === 0) return undefined

  const low = (hit * rate.hit + miss * rate.miss + output * rate.output) / 1_000_000
  return { low, high: low * 2 }
}

/**
 * Render an estimate as the amount half of a money string — no currency mark,
 * which belongs to the phrasing around it.
 * @param {{low: number, high: number}} cost - from `estimate`.
 * @returns {string} e.g. `2.95–5.91`, or `<0.01` for a session too small to price.
 */
export function formatAmount(cost) {
  if (cost.high < SUB_CENT) return `<${SUB_CENT.toFixed(2)}`
  return `${cost.low.toFixed(2)}–${cost.high.toFixed(2)}`
}
