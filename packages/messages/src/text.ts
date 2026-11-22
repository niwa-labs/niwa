/** Task notifications can carry structured results as serialized text. */
export function resultValue(text: string): Record<string, unknown> | unknown[] | undefined {
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[") return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown> | unknown[];
  } catch {
    return undefined;
  }
}
