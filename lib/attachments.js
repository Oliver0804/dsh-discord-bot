/**
 * Files dropped into a channel, as context for the prompt they came with.
 *
 * The terminal has `@file` completion for this; Discord has drag-and-drop, and
 * a phone has a share sheet. The shape is the harness's own: the typed text
 * stays the first content block — it is what the transcript shows and what the
 * person actually said — and each readable attachment appends one more block
 * after it.
 *
 * Two kinds of file, two paths. Text files decode into `<attachment>` text
 * blocks. Images instead ride the harness's durable attachment seam
 * (`ctx.attachments`): the bytes are handed to the composed store, which
 * validates and commits them durably, and the prompt carries an `{type:
 * 'image'}` block referencing the stored copy — never inline base64, and the
 * exact path the web UI's composer takes. A profile with no composed store
 * still gets text files, and skips images rather than pretending otherwise.
 *
 * Limits, all deliberate. Only the message's own Discord CDN attachments are
 * fetched, never a URL from the text: following a link someone pasted would
 * turn a chat message into a fetch-anything primitive. Only known-textual
 * types are decoded as text, because a binary decoded as UTF-8 is noise that
 * costs tokens. Images are bounded by the store's declared per-image budget,
 * enforced twice — against Discord's declared size before fetching, and
 * against the streamed body before admitting. And the per-file and
 * per-message ceilings keep one screenshot-sized paste from filling a context
 * window.
 */

/** Attachments read from one message. */
const MAX_FILES = 5
/** Per-file ceiling for text. Prompts are text; anything larger belongs in the repo. */
const MAX_BYTES = 100_000

/** Content types worth decoding as text. */
const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|toml|x-sh))/i
/** Extensions Discord serves as `application/octet-stream` but that are text. */
const TEXTUAL_NAMES = /\.(md|markdown|txt|log|json|ya?ml|toml|ini|cfg|conf|csv|tsv|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|html?|css|scss|patch|diff|env|gitignore|dockerfile)$/i

/** Raster formats the harness's attachment path accepts in version one. */
const IMAGE_MEDIA = /^image\/(png|jpeg|webp|gif)$/i
/**
 * Fallback per-image ceiling when no composed store declares one. Matches the
 * local attachment backend's default single-image budget.
 */
const DEFAULT_IMAGE_BYTES = 20 * 1024 * 1024

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
 * The composed durable image store, or `undefined` when this profile has none.
 *
 * The harness's own packages reach it as `ctx.get('attachments')`; this plugin
 * imports nothing from them, so the lookup is defensive — a profile without
 * the attachment backend degrades to text-only rather than failing the prompt.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @returns {object | undefined} the attachment store when composed.
 */
export function attachmentStore(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get('attachments') ?? undefined
    } catch {
      // An unresolvable service name reads as "no store here".
    }
  }
  return ctx.attachments ?? undefined
}

/**
 * The per-image byte budget this deployment enforces before admission.
 * @param {object | undefined} store - the composed attachment store, if any.
 * @returns {number} encoded bytes accepted for one image download.
 */
function imageCap(store) {
  const limit = Number(store?.imageLimits?.maxImageBytes)
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_IMAGE_BYTES
}

/**
 * Read at most `cap` bytes off a response as an image candidate.
 *
 * The same discipline as {@link readCapped}: the declared size is only a hint,
 * so the ceiling is applied to the stream and the download is cancelled once
 * it runs over. An over-budget body returns `undefined` rather than truncated
 * bytes — a cut raster would fail admission anyway, and submitting half a file
 * invites decoding garbage.
 *
 * @param {object} response - a fetch response.
 * @param {number} cap - maximum accepted byte length.
 * @returns {Promise<Uint8Array | undefined>} the image bytes, or `undefined`
 *   when the body exceeded the cap.
 */
async function readImageBytes(response, cap) {
  const body = response.body
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    const all = new Uint8Array(await response.arrayBuffer())
    return all.byteLength > cap ? undefined : all
  }

  const reader = body.getReader()
  const chunks = []
  let size = 0
  try {
    while (size <= cap) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    // Whether we stopped at the cap or the file ended, nothing more is wanted.
    await reader.cancel().catch(() => {})
  }

  if (size > cap) return undefined

  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

/**
 * Read a message's attachments into prompt content blocks.
 *
 * Never throws: an unreachable CDN, an oversized file, or a refused image
 * batch costs that attachment, not the prompt it arrived with. What was
 * skipped is reported so the reply can say so rather than leaving someone to
 * wonder whether the file was read.
 *
 * Text files become `<attachment>` blocks in message order. Images are
 * downloaded first and admitted as one batch afterwards — the store validates
 * and commits atomically, so a refused batch costs every image in the message
 * and none of them publishes a durable copy. The image blocks follow the text
 * ones; within each kind the order is the message's own.
 *
 * @param {object} message - the Discord message.
 * @param {object} [options]
 * @param {object | undefined} [options.store] - the harness's composed
 *   attachment store; images are only read when one is present.
 * @returns {Promise<{blocks: object[], read: string[], skipped: string[]}>} the
 *   content blocks to append, and what happened to each file.
 */
export async function readAttachments(message, { store } = {}) {
  const attachments = [...(message.attachments?.values?.() ?? [])]
  const blocks = []
  const read = []
  const skipped = []
  /** Downloaded image bytes awaiting one batch admission. */
  const images = []

  for (const attachment of attachments.slice(0, MAX_FILES)) {
    const name = String(attachment.name ?? 'file')
    const mediaType = String(attachment.contentType ?? '').toLowerCase()

    if (IMAGE_MEDIA.test(mediaType)) {
      // The store owns admission policy; without one there is nowhere durable
      // for the bytes to live, so the image is skipped rather than inlined.
      const cap = imageCap(store)
      if (store === undefined || attachment.size > cap) {
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
        const data = await readImageBytes(response, cap)
        if (data === undefined) {
          skipped.push(name)
          continue
        }
        images.push({ name, mediaType, data })
      } catch {
        skipped.push(name)
      }
      continue
    }

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

  // One admission per message: the store validates and commits as a batch, and
  // a refused batch publishes nothing — every image shares its fate, while the
  // prompt they arrived with is untouched either way.
  if (images.length > 0) {
    try {
      const refs = await store.saveImages(images.map(({ name, mediaType, data }) => ({ data, mediaType, name })))
      refs.forEach((ref, index) => {
        const image = images[index]
        if (image === undefined) return
        blocks.push({ type: 'image', attachment: ref })
        read.push(image.name)
      })
    } catch {
      for (const { name } of images) skipped.push(name)
    }
  }

  for (const attachment of attachments.slice(MAX_FILES)) skipped.push(String(attachment.name ?? 'file'))

  return { blocks, read, skipped }
}
