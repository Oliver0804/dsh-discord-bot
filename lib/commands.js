import { SlashCommandBuilder } from 'discord.js'

import { commandText } from './i18n.js'

/**
 * One root command with subcommands, rather than a dozen top-level verbs.
 * `/trace` and `/status` are names other bots claim; `/dsh …` cannot collide,
 * and it keeps every capability discoverable from one place in the picker.
 *
 * Descriptions carry Discord's own localizations, so each person reads the
 * picker in their client language. That is separate from the `language` setting,
 * which governs replies: a reply is one message in a shared channel, while the
 * picker is rendered privately for whoever opened it.
 *
 * A `session` option is always optional and always autocompleted: the ids are
 * uuids, so requiring one typed by hand would make the bot unusable on a phone
 * — which is the whole point of reaching the harness from Discord.
 */

/**
 * Apply an English description and its localizations to a builder.
 * @param {object} builder - any discord.js builder with description setters.
 * @param {string} key - a `cmd.*` or `opt.*` key.
 * @returns {object} the same builder.
 */
function describe(builder, key) {
  const { value, localizations } = commandText(key)
  return builder.setDescription(value).setDescriptionLocalizations(localizations)
}

const session = (option) => describe(option.setName('session'), 'opt.session')
  .setAutocomplete(true)
  .setRequired(false)

const limit = (option, key) => describe(option.setName('limit'), key)
  .setMinValue(1)
  .setMaxValue(200)
  .setRequired(false)

/** The command definition sent to Discord at login. */
export const commands = [
  describe(new SlashCommandBuilder().setName('dsh'), 'cmd.root')
    .addSubcommand((sub) => describe(sub.setName('help'), 'cmd.help'))
    .addSubcommand((sub) => describe(sub.setName('sessions'), 'cmd.sessions')
      .addIntegerOption((option) => limit(option, 'opt.limitSessions')))
    .addSubcommand((sub) => describe(sub.setName('trace'), 'cmd.trace')
      .addStringOption(session)
      .addIntegerOption((option) => limit(option, 'opt.limitTrace'))
      .addBooleanOption((option) => describe(option.setName('everything'), 'opt.everything').setRequired(false)))
    .addSubcommand((sub) => describe(sub.setName('timeline'), 'cmd.timeline')
      .addStringOption(session)
      .addIntegerOption((option) => limit(option, 'opt.limitEvents')))
    .addSubcommand((sub) => describe(sub.setName('subagents'), 'cmd.subagents')
      .addStringOption(session)
      .addBooleanOption((option) => describe(option.setName('deep'), 'opt.deep').setRequired(false)))
    .addSubcommand((sub) => describe(sub.setName('lineage'), 'cmd.lineage')
      .addStringOption(session))
    .addSubcommand((sub) => describe(sub.setName('run'), 'cmd.run')
      .addStringOption((option) => describe(option.setName('prompt'), 'opt.prompt')
        .setRequired(true)
        .setMaxLength(1800)))
    .addSubcommand((sub) => describe(sub.setName('model'), 'cmd.model')
      .addStringOption((option) => describe(option.setName('to'), 'opt.to')
        .setAutocomplete(true)
        .setRequired(false)))
    .addSubcommand((sub) => describe(sub.setName('workspace'), 'cmd.workspace')
      .addStringOption((option) => describe(option.setName('path'), 'opt.path')
        .setAutocomplete(true)
        .setRequired(true)))
    .addSubcommand((sub) => describe(sub.setName('status'), 'cmd.status'))
    .addSubcommand((sub) => describe(sub.setName('sync'), 'cmd.sync')),
].map((builder) => builder.toJSON())

/**
 * Publish the command set to the bound guild. Guild-scoped registration takes
 * effect immediately, where a global one propagates for up to an hour — wrong
 * for something an operator installs and expects to use.
 * @param {import('discord.js').Client} client - the logged-in client.
 * @param {string} guildId - the bound guild.
 * @returns {Promise<void>} resolution once the set is published.
 */
export async function publishCommands(client, guildId) {
  const guild = await client.guilds.fetch(guildId)
  await guild.commands.set(commands)
}
