import { Toolkit, createToolkit } from "./toolkit.js";
import type { ToolkitConfig } from "./toolkit.js";

/**
 * @deprecated Renamed to {@link Toolkit} to avoid confusion with Agent Skills
 * (SKILL.md folders, see `loadAgentSkills`). Will be removed in 2.0.
 */
export const Skill = Toolkit;
/** @deprecated Use {@link Toolkit}. */
export type Skill = Toolkit;
/** @deprecated Use {@link ToolkitConfig}. */
export type SkillConfig = ToolkitConfig;

/** @deprecated Use {@link createToolkit}. Will be removed in 2.0. */
export function createSkill(config: ToolkitConfig): Toolkit {
  return createToolkit(config);
}
