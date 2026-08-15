/**
 * Small shared helpers with no dependency on the harness's own packages.
 *
 * This module exists so one shape — turning a thrown value into a loggable
 * description — has a single home instead of a `instanceof Error` ternary
 * re-typed at every catch site. Nothing here imports from the rest of the
 * package, so any module may use it without a cycle.
 */

/**
 * Describe a thrown value for a log line.
 * @param {unknown} error - a thrown value.
 * @returns {string} the error message when it is an Error, else its string form.
 */
export function described(error) {
  return error instanceof Error ? error.message : String(error)
}
