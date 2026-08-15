/**
 * Reading services that live inside an agent's preset realm.
 *
 * A preset composes its session's world behind an `isolate` realm, and the
 * shipped presets use it: `standard/agent.cordis.yml` isolates `compaction`,
 * `planMode` and the skill filesystem. Those services are invisible from the
 * root context — `ctx.get('compaction')` is `undefined` no matter how many
 * sessions are running one — because the realm exists precisely so two presets
 * can publish the same name without colliding.
 *
 * `agentPresets.serviceFor(agent, name)` is the harness's answer for a caller
 * that holds the agent but arrives from outside its composition, which its own
 * documentation describes as "every browser RPC". This bot is another such
 * caller: a Discord command is about a session but does not run inside it.
 *
 * Host-plane services still answer through `ctx.get`, so this resolves the
 * scoped instance first and falls back — a profile with no roster at all
 * behaves exactly as it did before presets existed.
 */

/**
 * Resolve one service for a specific agent, looking inside its preset realm
 * before the host plane.
 *
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object | undefined} agent - the agent whose composition to look inside.
 * @param {string} name - the service name.
 * @returns {object | undefined} the service, or undefined when nothing supplies it.
 */
export function serviceForAgent(ctx, agent, name) {
  const presets = ctx.get('agentPresets')

  if (agent !== undefined && typeof presets?.serviceFor === 'function') {
    try {
      const scoped = presets.serviceFor(agent, name)
      if (scoped !== undefined) return scoped
    } catch {
      // A roster that refuses the lookup — an agent it did not compose, a
      // name it does not carry — is not a reason to fail the caller; the
      // host plane may still have it.
    }
  }

  return ctx.get(name)
}

/**
 * The prompt-assembly context for one agent.
 *
 * Equivalent to the harness's own `assembleContextFor`, reimplemented from its
 * two fields so this package keeps importing nothing from `@deepseek-ai/*` —
 * see `config.js` for why. Setting `scope` alongside `agent` is what makes an
 * assembly include the agent-scoped prompt sections and tools; omitting it
 * silently returns the host's contributions alone, which would report the
 * wrong tool catalog rather than fail.
 *
 * @param {object} agent - the agent the assembly is for.
 * @returns {object} the context to pass to `systemPrompt.assemble()`.
 */
export function assembleContextFor(agent) {
  return { agent, scope: agent }
}
