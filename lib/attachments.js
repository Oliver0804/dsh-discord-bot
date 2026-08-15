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

/** Characters that would end the attribute early and forge a tag boundary. */
const ATTRIBUTE_BREAK = /["<>]/g

/**
 * A filename safe to interpolate into the wrapper's `name` attribute.
 *
 * The file's *contents* are untrusted text no matter what — that is inherent to
 * reading a file into a prompt, and not fixable by escaping. The attribute is
 * different: a name carrying a quote could close it and forge a boundary the
 * model reads as structure. Stripped rather than entity-encoded, because the
 * wrapper is prompt scaffolding, not markup anything parses.
 *
 * @param {string} name - the attachment's filename.
 * @returns {string} the name with attribute-breaking characters removed.
 */
function attributeSafe(name) {
  return name.replace(ATTRIBUTE_BREAK, '')
}

/**
 * Read at most `MAX_BYTES` off a response, and hang up once there.
 *
 * The declared size is a hint, and `text()` would honour the body over the
 * hint — so the cap is applied to the stream, and the download is cancelled at
 * the ceiling rather than drained and then sliced. Falls back to the buffered
 * read when a response exposes no stream, which keeps this working against
 * anything that fetches without one.
 *
 * @param {object} response - a fetch response.
 * @returns {Promise<string>} the decoded text, capped.
 */
async function readCapped(response) {
  const body = response.body
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    return (await response.text()).slice(0, MAX_BYTES)
  }

  const reader = body.getReader()
  const chunks = []
  let size = 0
  try {
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    // Whether we stopped at the cap or the file ended, nothing more is wanted.
    await reader.cancel().catch(() => {})
  }

  const capped = new Uint8Array(Math.min(size, MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= capped.length) break
    const take = Math.min(chunk.byteLength, capped.length - offset)
    capped.set(chunk.subarray(0, take), offset)
    offset += take
  }
  // A multi-byte character split by the cut decodes to a replacement char,
  // which is the right trade for a hard byte ceiling.
  return new TextDecoder().decode(capped)
}

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
      const text = await readCapped(response)
      blocks.push({ type: 'text', text: `<attachment name="${attributeSafe(name)}">\n${text}\n</attachment>` })
      read.push(name)
    } catch {
      skipped.push(name)
    }
  }

  for (const attachment of attachments.slice(MAX_FILES)) skipped.push(String(attachment.name ?? 'file'))

  return { blocks, read, skipped }
}
