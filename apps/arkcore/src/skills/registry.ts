import type { Skill, SkillCommand, ReactionHandler, ButtonHandler, MessageHandler, SkillCronJob, SkillContext } from "./types.js";

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private ctx: SkillContext;

  constructor(ctx: SkillContext) {
    this.ctx = ctx;
  }

  register(skill: Skill): void {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill "${skill.id}" is already registered`);
    }
    this.skills.set(skill.id, skill);
    this.ctx.logger.info({ skillId: skill.id, tier: skill.tier }, "Skill registered");
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  async getEnabledForGuild(guildId: string): Promise<Skill[]> {
    const settings = await this.ctx.db.guildSettings.findUnique({
      where: { guildId },
    });
    const enabledIds = settings?.enabledSkills ?? ["digest", "favorites"];
    const guildTier = settings?.tier ?? "free";

    return enabledIds
      .map((id) => this.skills.get(id))
      .filter((s): s is Skill => s !== undefined)
      .filter((s) => this.canUseSkill(s, guildTier));
  }

  canUseSkill(skill: Skill, guildTier: string): boolean {
    if (skill.tier === "free") return true;
    return guildTier === "premium";
  }

  getAllCommands(): SkillCommand[] {
    return this.getAll().flatMap((s) => s.commands ?? []);
  }

  getAllReactionHandlers(): Array<{ skill: Skill; handler: ReactionHandler }> {
    return this.getAll().flatMap((s) =>
      (s.reactions ?? []).map((h) => ({ skill: s, handler: h }))
    );
  }

  getAllCronJobs(): Array<{ skill: Skill; job: SkillCronJob }> {
    return this.getAll().flatMap((s) =>
      (s.cron ?? []).map((j) => ({ skill: s, job: j }))
    );
  }

  getAllMessageHandlers(): Array<{ skill: Skill; handler: MessageHandler }> {
    return this.getAll().flatMap((s) =>
      (s.messages ?? []).map((h) => ({ skill: s, handler: h }))
    );
  }

  getAllButtonHandlers(): Array<{ skill: Skill; handler: ButtonHandler }> {
    return this.getAll().flatMap((s) =>
      (s.buttons ?? []).map((h) => ({ skill: s, handler: h }))
    );
  }

  /**
   * Invoke onBotReady lifecycle hook for all registered skills.
   * Called when the Discord client is ready.
   */
  async invokeOnBotReady(): Promise<void> {
    for (const skill of this.getAll()) {
      if (skill.onBotReady) {
        try {
          await skill.onBotReady(this.ctx);
          this.ctx.logger.debug({ skillId: skill.id }, "Skill onBotReady completed");
        } catch (error) {
          this.ctx.logger.error({ error, skillId: skill.id }, "Skill onBotReady failed");
        }
      }
    }
  }

  /**
   * Invoke onBotStop lifecycle hook for all registered skills.
   * Called during graceful shutdown.
   */
  async invokeOnBotStop(): Promise<void> {
    for (const skill of this.getAll()) {
      if (skill.onBotStop) {
        try {
          await skill.onBotStop(this.ctx);
          this.ctx.logger.debug({ skillId: skill.id }, "Skill onBotStop completed");
        } catch (error) {
          this.ctx.logger.error({ error, skillId: skill.id }, "Skill onBotStop failed");
        }
      }
    }
  }
}
