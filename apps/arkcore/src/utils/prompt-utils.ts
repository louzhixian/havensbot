import { readFile } from "fs/promises";
import path from "path";

/**
 * Base directory for all prompt files
 */
export const PROMPT_DIR = path.resolve(process.cwd(), "prompts");

/**
 * Shared cache for parsed prompt sections
 */
export const PROMPT_CACHE = new Map<string, { system: string; user: string }>();

/**
 * Load and parse prompt file into system and user sections
 */
export const loadPromptSections = async (
  fileName: string
): Promise<{ system: string; user: string }> => {
  const cached = PROMPT_CACHE.get(fileName);
  if (cached) return cached;

  const filePath = path.join(PROMPT_DIR, fileName);
  const content = await readFile(filePath, "utf8");
  const systemToken = "## System";
  const userToken = "## User";
  const systemIndex = content.indexOf(systemToken);
  const userIndex = content.indexOf(userToken);

  if (systemIndex < 0 || userIndex < 0 || userIndex <= systemIndex) {
    throw new Error(`Prompt missing System/User sections: ${fileName}`);
  }

  const system = content
    .slice(systemIndex + systemToken.length, userIndex)
    .trim();
  const user = content.slice(userIndex + userToken.length).trim();
  const result = { system, user };
  PROMPT_CACHE.set(fileName, result);
  return result;
};

/**
 * Render template by replacing {{variables}} with values
 */
export const renderTemplate = (
  template: string,
  values: Record<string, string>
): string => {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
};
