/**
 * Files dropped into a channel, as context for the prompt they came with.
 *
 * The terminal has `@file` completion for this; Discord has drag-and-drop, and
 * a phone has a share sheet. The shape is the harness's own: the typed text
 * stays the first content block — it is what the transcript shows and what the
 * person actually said — and each readable attachment appends one more block
 * after it.
 *
 * Three limits, all deliberate. Only the message's own Discord CDN attachments
 * are fetched, never a URL from the text: following a link someone pasted would
 * turn a chat message into a fetch-anything primitive. Only textual types are
 * read, because a binary decoded as UTF-8 is noise that costs tokens. And the
 * per-file and per-message ceilings keep one screenshot-sized paste from
 * filling a context window.
 */

/** Attachments read from one message. */
const MAX_FILES = 5
/** Per-file ceiling. Prompts are text; anything larger belongs in the repo. */
const MAX_BYTES = 100_000

/** Content types worth decoding as text. */
const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|toml|x-sh))/i
/** Extensions Discord serves as `application/octet-stream` but that are text. */
const TEXTUAL_NAMES = /\.(md|markdown|txt|log|json|ya?ml|toml|ini|cfg|conf|csv|tsv|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|html?|css|scss|patch|diff|env|gitignore|dockerfile)$/i

/**
 * Whether one attachment is worth decoding as text.
 * @param {object} attachment - a discord.js attachment.
 * @returns {boolean} true when it should be read.
 */
function textual(attachment) {
  const type = String(attachment.contentType ?? '')
  if (TEXTUAL.test(type)) return true
  return TEXTUAL_NAMES.test(String(attachment.name ?? ''))
}

/**
 * Read a message's attachments into prompt content blocks.
 *
 * Never throws: an unreachable CDN or an oversized file costs that attachment,
 * not the prompt it arrived with. What was skipped is reported so the reply can
 * say so rather than leaving someone to wonder whether the file was read.
 *
 * @param {object} message - the Discord message.
 * @returns {Promise<{blocks: object[], read: string[], skipped: string[]}>} the
 *   content blocks to append, and what happened to each file.
 */
export async function readAttachments(message) {
  const attachments = [...(message.attachments?.values?.() ?? [])]
  const blocks = []
  const read = []
  const skipped = []

  for (const attachment of attachments.slice(0, MAX_FILES)) {
    const name = String(attachment.name ?? 'file')

    if (!textual(attachment) || attachment.size > MAX_BYTES) {
      skipped.push(name)
      continue
    }

    try {
      const response = await fetch(attachment.url)
      if (!response.ok) {
        skipped.push(name)
        continue
      }

      // Trust the declared size only as a hint; the body is what counts.
      const text = (await response.text()).slice(0, MAX_BYTES)
      blocks.push({ type: 'text', text: `<attachment name="${name}">\n${text}\n</attachment>` })
      read.push(name)
    } catch {
      skipped.push(name)
    }
  }

  for (const attachment of attachments.slice(MAX_FILES)) skipped.push(String(attachment.name ?? 'file'))

  return { blocks, read, skipped }
}
