export const DEFAULT_MODEL = "cohere/north-mini-code:free";

export function currentModel(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}
