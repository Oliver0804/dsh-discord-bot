import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'

/** Discord's hard ceiling on channels inside one category. */
const CATEGORY_CAPACITY = 50
/** Discord's channel-topic length limit. */
const TOPIC_LIMIT = 1024

/**
 * The anchor written into every managed channel's topic. The workspace id —
 * not the channel name — is the mapping: a user renaming a channel, or two
 * workspaces sharing a display title, must not break or cross the wiring.
 * @param {string} workspaceId - the workspace this channel represents.
 * @returns {string} the topic marker.
 */
function marker(workspaceId) {
  return `[dsh:${workspaceId}]`
}

/**
 * Read the workspace id back out of a channel topic.
 * @param {string | null | undefined} topic - the channel topic.
 * @returns {string | undefined} the workspace id, when this is a managed channel.
 */
export function workspaceIdFromTopic(topic) {
  const match = /^\[dsh:([^\]]+)\]/.exec(topic ?? '')
  return match === null ? undefined : match[1]
}

/**
 * Turn a workspace title into a legal Discord channel name. Discord lowercases
 * and substitutes on its own, but doing it here keeps the name we compare
 * against equal to the name Discord stores, so reconcile does not rename on
 * every pass.
 * @param {string} title - the workspace display title.
 * @returns {string} a channel-safe name.
 */
export function channelSlug(title) {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
  return slug.length === 0 ? 'workspace' : slug
}

/**
 * Build the topic line: the anchor, the directory, and a hint at what the
 * channel is for.
 * @param {import('./workspaces.js').WorkspaceView} workspace - the workspace.
 * @returns {string} the channel topic.
 */
function topicFor(workspace) {
  return `${marker(workspace.id)} ${workspace.path} — /dsh sessions · trace · subagents`.slice(0, TOPIC_LIMIT)
}

/**
 * Who may see the workspace channels: the configured allowlist, or the guild
 * owner alone when it is empty. Same rule as command authorization, so what a
 * person can read and what they can ask never diverge.
 * @param {import('discord.js').Guild} guild - the bound guild.
 * @param {object} config - the validated plugin config.
 * @returns {string[]} Discord user ids granted visibility.
 */
function viewers(guild, config) {
  return config.allowedUserIds.length > 0 ? config.allowedUserIds : [guild.ownerId]
}

/**
 * The permission overwrites that make the category private.
 *
 * The bot needs an explicit grant of its own: denying `@everyone` also denies
 * the bot, and a bot that cannot see the channel it just created cannot answer
 * in it.
 *
 * @param {import('discord.js').Guild} guild - the bound guild.
 * @param {object} config - the validated plugin config.
 * @param {import('discord.js').GuildMember} me - the bot's own guild member.
 * @returns {object[]} the overwrite set.
 */
function privateOverwrites(guild, config, me) {
  // Discord refuses an overwrite that grants or denies a permission the caller
  // does not itself hold, and reports the refusal as a bare "Missing Access"
  // that names nothing. Filtering to what the bot actually has means a narrower
  // invite costs only the bits it omitted — the channels still become private —
  // instead of failing the whole call and leaving them world-readable.
  const held = (...bits) => bits.filter((bit) => me.permissions.has(bit))

  // `type` is required, not decorative: without it discord.js resolves each id
  // against its cache, and an allowlisted member the bot has never seen is not
  // in that cache — the whole call then fails with "not a cached User or Role".
  return [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: held(PermissionFlagsBits.ViewChannel),
    },
    {
      id: me.id,
      type: OverwriteType.Member,
      allow: held(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ),
    },
    ...viewers(guild, config).map((id) => ({
      id,
      type: OverwriteType.Member,
      allow: held(
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ),
    })),
  ]
}

/**
 * The overwrites a newly created channel is born with.
 *
 * Discord copies the parent category's permissions only when the create call
 * names none of its own — so a bot that sets nothing inherits a locked category
 * and ends up unable to see the channel it just made, and a bot that sets only
 * its own grant silently *replaces* that inheritance and publishes the channel
 * to the whole server. Neither is acceptable, so this copies the category's
 * overwrites verbatim and adds one exception for the bot.
 *
 * @param {import('discord.js').Guild} guild - the bound guild.
 * @param {object} config - the validated plugin config.
 * @param {import('discord.js').GuildMember} me - the bot's own guild member.
 * @param {import('discord.js').CategoryChannel} category - the parent category.
 * @param {boolean} isPrivate - whether this bot manages the category's privacy.
 * @returns {object[] | undefined} overwrites for the create call.
 */
function birthOverwrites(guild, config, me) {
  if (!config.privateChannels) return undefined

  // Always the bot's own recipe, even under a category it does not manage.
  //
  // Copying the category's overwrites verbatim is the obvious idea and it does
  // not work: an admin role's overwrite carries permission bits the bot does
  // not hold, and Discord refuses to let anyone grant what they lack — the
  // create fails with a bare "Missing Permissions". This set is built through
  // `held()`, so it only ever contains bits the bot actually has. Admin roles
  // keep their access regardless, because Administrator bypasses overwrites.
  return privateOverwrites(guild, config, me)
}

/**
 * Find the configured category, creating it when permitted.
 * @param {import('discord.js').Guild} guild - the bound guild.
 * @param {object} config - the validated plugin config.
 * @param {import('discord.js').GuildMember} me - the bot's own guild member.
 * @returns {Promise<import('discord.js').CategoryChannel | undefined>} the category.
 */
async function resolveCategory(guild, config, me) {
  const channels = await guild.channels.fetch()
  const existing = channels.find((channel) => channel?.type === ChannelType.GuildCategory && channel.name === config.categoryName)
  if (existing !== undefined && existing !== null) return existing
  if (!config.manageChannels) return undefined

  return guild.channels.create({
    name: config.categoryName,
    type: ChannelType.GuildCategory,
    permissionOverwrites: config.privateChannels ? privateOverwrites(guild, config, me) : undefined,
  })
}

/**
 * Whether the category already hides itself from `@everyone`, no matter who
 * arranged that. Read from the channel listing, which the guild-wide endpoint
 * serves even for a category the bot may not open individually.
 * @param {import('discord.js').Guild} guild - the bound guild.
 * @param {import('discord.js').CategoryChannel} category - the workspace category.
 * @returns {boolean} true when `@everyone` is denied ViewChannel.
 */
export function deniesEveryone(guild, category) {
  const overwrite = category.permissionOverwrites?.cache?.get(guild.roles.everyone.id)
  return overwrite !== undefined && overwrite.deny.has(PermissionFlagsBits.ViewChannel)
}

/**
 * Make the category private and keep it that way.
 *
 * Applied on every reconcile, not only at creation: a category that already
 * existed — or one created before this setting was turned on — is exactly the
 * case where session content is currently readable by the whole server, so
 * fixing only the create path would leave the actual problem in place.
 *
 * @param {import('discord.js').Guild} guild - the bound guild.
 * @param {import('discord.js').CategoryChannel} category - the workspace category.
 * @param {object} config - the validated plugin config.
 * @param {import('discord.js').GuildMember} me - the bot's own guild member.
 * @param {object} logger - the plugin logger.
 * @returns {Promise<'enforced' | 'external' | 'open'>} how the category is protected:
 *   written by this bot, already restricted by someone else, or not at all.
 */
async function enforceCategoryPrivacy(guild, category, config, me, logger) {
  if (!config.privateChannels) return deniesEveryone(guild, category) ? 'external' : 'open'

  /**
   * Report the truth when the bot cannot write overwrites. A category an admin
   * already locked down *is* private; calling that "not private" would send an
   * operator chasing an exposure that does not exist — and the inverse mistake
   * would be worse still, so both paths read the live overwrite rather than
   * inferring from whether our own write succeeded.
   * @param {string} why - the reason the write was not possible.
   * @returns {'external' | 'open'} the observed state.
   */
  const fallback = (why) => {
    if (deniesEveryone(guild, category)) {
      logger.info('dsh-discord-bot: "%s" is private, but set outside this bot (%s) — the bot cannot maintain it', config.categoryName, why)
      return 'external'
    }
    logger.warn('dsh-discord-bot: cannot restrict "%s" (%s); channels stay readable by everyone', config.categoryName, why)
    return 'open'
  }

  // Writing permission overwrites needs Manage Roles ("Manage Permissions" on
  // a channel) — Manage Channels alone only covers name, topic, and position.
  // Discord reports the difference as a bare "Missing Access", so the check is
  // here to turn that into an instruction the operator can act on.
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return fallback('the bot lacks Manage Roles; re-invite it with permissions=268487696')
  }

  try {
    await category.permissionOverwrites.set(privateOverwrites(guild, config, me))
    return 'enforced'
  } catch (error) {
    // The usual cause is a category already made private without granting the
    // bot an exception: it is then locked out of the very channel tree it owns.
    return fallback(`${error instanceof Error ? error.message : error} — add the bot to the category's permissions and allow View Channel`)
  }
}

/**
 * Sync one channel's permissions with its category.
 *
 * `permissionsLocked` is already true for a channel that matches its parent, so
 * a steady-state reconcile makes no API call; only a channel that drifted — or
 * one created while the category was still public — is rewritten.
 *
 * @param {import('discord.js').GuildChannel} channel - a managed channel.
 * @param {boolean} isPrivate - whether the category is private.
 * @param {boolean} canManage - whether the bot may edit channels.
 * @param {object} logger - the plugin logger.
 * @returns {Promise<void>} resolution once the channel matches its parent.
 */
async function inheritPrivacy(channel, isPrivate, canManage, logger) {
  if (!isPrivate || !canManage) return
  if (channel.permissionsLocked === true) return

  try {
    await channel.lockPermissions()
  } catch (error) {
    logger.warn('dsh-discord-bot: could not lock #%s to its category: %s', channel.name, error instanceof Error ? error.message : error)
  }
}

/**
 * Bring the Discord side in line with the harness: one text channel per
 * workspace, inside one category.
 *
 * Reconcile never deletes. A workspace that disappears from the harness leaves
 * its channel — and its message history — in place, because a channel this bot
 * created still belongs to the humans reading it. Unmapped leftovers are
 * reported instead.
 *
 * @param {object} args - reconcile inputs.
 * @param {import('discord.js').Client} args.client - the logged-in Discord client.
 * @param {object} args.config - the validated plugin config.
 * @param {import('./workspaces.js').WorkspaceView[]} args.workspaces - current workspaces.
 * @param {object} args.logger - the plugin logger.
 * @returns {Promise<{mapping: Map<string, string>, created: string[], orphans: string[], skipped: string[]}>}
 *   channel id to workspace id, plus what changed and what could not be done.
 */
export async function reconcile({ client, config, workspaces, logger }) {
  /** @type {Map<string, string>} */
  const mapping = new Map()
  const created = []
  const orphans = []
  const skipped = []
  const invisible = []

  const guild = await client.guilds.fetch(config.guildId)

  // Force both fetches past discord.js's cache. A permission granted after the
  // bot connected — re-inviting it with a wider scope, or an admin editing its
  // role — is invisible to the cached member and its cached roles, so a bot
  // that had just been given Manage Roles would keep reporting the channels as
  // unrestricted until someone restarted the harness.
  await guild.roles.fetch(undefined, { force: true })
  const me = await guild.members.fetchMe({ force: true })
  const canManage = me.permissions.has(PermissionFlagsBits.ManageChannels)
  if (config.manageChannels && !canManage) {
    logger.warn('the bot lacks Manage Channels in guild %s; existing channels still answer commands', config.guildId)
  }

  const category = await resolveCategory(guild, config, me)
  if (category === undefined) {
    logger.warn('dsh-discord-bot: category "%s" does not exist and channel management is off', config.categoryName)
    return { mapping, created, orphans, skipped, invisible, privacy: 'open' }
  }

  const privacy = canManage ? await enforceCategoryPrivacy(guild, category, config, me, logger) : 'open'
  // Only overwrites this bot wrote can be propagated to children; an
  // externally-locked category rejects the sync just as it rejected the write.
  const isPrivate = privacy === 'enforced'

  // Existing managed channels, keyed by the workspace their topic claims.
  const channels = await guild.channels.fetch()
  /** @type {Map<string, import('discord.js').TextChannel>} */
  const byWorkspace = new Map()
  for (const channel of channels.values()) {
    if (channel === null || channel.type !== ChannelType.GuildText) continue
    if (channel.parentId !== category.id) continue
    const workspaceId = workspaceIdFromTopic(channel.topic)
    if (workspaceId === undefined) continue
    byWorkspace.set(workspaceId, channel)
  }

  let occupancy = [...channels.values()].filter((channel) => channel?.parentId === category.id).length

  for (const workspace of workspaces) {
    const wanted = channelSlug(workspace.title)
    const existing = byWorkspace.get(workspace.id)

    if (existing !== undefined) {
      mapping.set(existing.id, workspace.id)
      byWorkspace.delete(workspace.id)

      // Keep the channel readable when a workspace is renamed or moved, but
      // only when we are allowed to touch it.
      if (canManage && config.manageChannels) {
        const topic = topicFor(workspace)
        try {
          if (existing.name !== wanted) await existing.setName(wanted)
          if (existing.topic !== topic) await existing.setTopic(topic)
        } catch (error) {
          logger.warn('dsh-discord-bot: could not update channel #%s: %s', existing.name, error instanceof Error ? error.message : error)
        }
      }
      // A channel the bot cannot see is one it cannot receive messages in:
      // interactions still work (they carry their own token), but chat mode is
      // dead there and nothing the bot does can fix it — editing a channel
      // requires being able to see it. Name them so the operator can grant it.
      if (existing.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel) !== true) {
        invisible.push(existing.name)
      }

      await inheritPrivacy(existing, isPrivate, canManage, logger)
      continue
    }

    if (!config.manageChannels || !canManage) {
      skipped.push(workspace.title)
      continue
    }
    if (occupancy >= CATEGORY_CAPACITY) {
      skipped.push(workspace.title)
      continue
    }

    try {
      const channel = await guild.channels.create({
        name: wanted,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: topicFor(workspace),
        // Born with the category's privacy already applied — and with the bot
        // able to see it, which is what lets chat mode work in a channel the
        // bot created under a category someone else locked down.
        permissionOverwrites: birthOverwrites(guild, config, me),
      })
      mapping.set(channel.id, workspace.id)
      created.push(channel.name)
      occupancy += 1
    } catch (error) {
      logger.warn('could not create a channel for workspace "%s": %s', workspace.title, error instanceof Error ? error.message : error)
      skipped.push(workspace.title)
    }
  }

  // Whatever is left claimed a workspace that no longer exists. Its history is
  // still session content, so it is secured like any other managed channel.
  for (const [workspaceId, channel] of byWorkspace) {
    orphans.push(channel.name)
    mapping.set(channel.id, workspaceId)
    await inheritPrivacy(channel, isPrivate, canManage, logger)
  }

  if (occupancy >= CATEGORY_CAPACITY && skipped.length > 0) {
    logger.warn('dsh-discord-bot: category "%s" is at Discord\'s %d-channel limit; %d workspace(s) unmapped', config.categoryName, CATEGORY_CAPACITY, skipped.length)
  }

  if (config.privateChannels && privacy === 'open' && !canManage) {
    logger.warn('dsh-discord-bot: channels are NOT private — the bot needs Manage Channels to restrict them')
  }

  if (invisible.length > 0) {
    logger.warn('dsh-discord-bot: cannot see %s — chat mode is off there until the bot is granted View Channel on each', invisible.map((name) => `#${name}`).join(', '))
  }

  return { mapping, created, orphans, skipped, invisible, privacy }
}
