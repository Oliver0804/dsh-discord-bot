import { SlashCommandBuilder } from 'discord.js'

/**
 * One root command with subcommands, rather than five top-level verbs. `/trace`
 * and `/status` are names other bots claim; `/dsh …` cannot collide, and it
 * keeps every capability discoverable from one place in the Discord picker.
 *
 * A `session` option is always optional and always autocompleted: the ids are
 * uuids, so requiring one typed by hand would make the bot unusable on a phone
 * — which is the whole point of reaching the harness from Discord.
 */
const session = (option) => option
  .setName('session')
  .setDescription('Session to inspect; defaults to the newest in this workspace.')
  .setAutocomplete(true)
  .setRequired(false)

const limit = (option, description) => option
  .setName('limit')
  .setDescription(description)
  .setMinValue(1)
  .setMaxValue(200)
  .setRequired(false)

/** The command definition sent to Discord at login. */
export const commands = [
  new SlashCommandBuilder()
    .setName('dsh')
    .setDescription('Inspect this dsh harness from Discord.')
    .addSubcommand((sub) => sub
      .setName('sessions')
      .setDescription('List the sessions of this channel\'s workspace.')
      .addIntegerOption((option) => limit(option, 'How many sessions to list.')))
    .addSubcommand((sub) => sub
      .setName('trace')
      .setDescription('Read a session\'s trajectory — what was said and done.')
      .addStringOption(session)
      .addIntegerOption((option) => limit(option, 'How many trajectory entries to show.'))
      .addBooleanOption((option) => option
        .setName('everything')
        .setDescription('Include non-conversational entries too.')
        .setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('timeline')
      .setDescription('Read a session\'s raw event timeline and type histogram.')
      .addStringOption(session)
      .addIntegerOption((option) => limit(option, 'How many events to show.')))
    .addSubcommand((sub) => sub
      .setName('subagents')
      .setDescription('List a session\'s subagents and whether they are running.')
      .addStringOption(session)
      .addBooleanOption((option) => option
        .setName('deep')
        .setDescription('Walk the whole descendant tree, not just direct children.')
        .setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('lineage')
      .setDescription('Show a session\'s ancestors and descendant sessions.')
      .addStringOption(session))
    .addSubcommand((sub) => sub
      .setName('run')
      .setDescription('Send work to this workspace\'s agent and watch it happen.')
      .addStringOption((option) => option
        .setName('prompt')
        .setDescription('What you want the agent to do.')
        .setRequired(true)
        .setMaxLength(1800)))
    .addSubcommand((sub) => sub
      .setName('model')
      .setDescription('Show or switch the default model for new sessions.')
      .addStringOption((option) => option
        .setName('to')
        .setDescription('Model id, or provider/model. Omit to just show the current one.')
        .setAutocomplete(true)
        .setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('workspace')
      .setDescription('Register a directory as a workspace and give it a channel.')
      .addStringOption((option) => option
        .setName('path')
        .setDescription('Directory on the harness machine — start typing a name or a path.')
        .setAutocomplete(true)
        .setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('status')
      .setDescription('Harness overview: mounted services, sessions, mapped workspaces.'))
    .addSubcommand((sub) => sub
      .setName('sync')
      .setDescription('Re-sync the category and its workspace channels now.')),
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
