/**
 * The header of a script, read from its text without running it: the declaration
 * `export default workflow({ ... }, fn)` and the literals written in it. The part of the check that needs no
 * knowledge of the host: `on` is read here (`scriptOn`); the rest of what a script declares is read by the script
 * checker of the workflow package with the same helpers. `typescript` is loaded only when a script is read.
 */

import type * as Ts from "typescript";
import { z } from "zod";

/** The script as it is: its path, and the text that was read. */
export interface ScriptSource {
  file: string;
  text: string;
}

/** The record a script starts on: its type, and the fields the data of the record must hold. */
export const Subscription = z.object({
  type: z.string().min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
});
export type Subscription = z.infer<typeof Subscription>;

/** The place of a node in the file, as the checker reports it. */
export function placeOf(ts: typeof Ts, source: Ts.SourceFile, node: Ts.Node): { line: number; column: number } {
  const at = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: at.line + 1, column: at.character + 1 };
}

/** The expression without the `as`, `satisfies` and parentheses around it. */
export function bare(ts: typeof Ts, expression: Ts.Expression): Ts.Expression {
  let inner = expression;
  while (ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** The declaration of a script: the first argument of `export default workflow(...)`, when the text is that. */
export type Declaration = { object: Ts.ObjectLiteralExpression } | { opaque: { line: number; column: number } } | undefined;

export function declarationOf(ts: typeof Ts, source: Ts.SourceFile): Declaration {
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals === true) continue;
    const call = bare(ts, statement.expression);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "workflow") continue;
    const first = call.arguments[0] === undefined ? undefined : bare(ts, call.arguments[0]);
    return first !== undefined && ts.isObjectLiteralExpression(first) ? { object: first } : { opaque: placeOf(ts, source, call) };
  }
  return undefined;
}

/** The value of one key of the declaration of a script, read from the text; absent when there is none. */
export function declarationField(ts: typeof Ts, source: Ts.SourceFile, field: string): Ts.Expression | undefined {
  const declaration = declarationOf(ts, source);
  if (declaration === undefined || !("object" in declaration)) return undefined;
  for (const property of declaration.object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
    if (key === field) return property.initializer;
  }
  return undefined;
}

/** A value written as a literal in the text: text, a number, a boolean, null, a list or an object of them. */
export function literalOf(ts: typeof Ts, node: Ts.Expression): { value: unknown } | undefined {
  const expression = bare(ts, node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return { value: expression.text };
  if (ts.isNumericLiteral(expression)) return { value: Number(expression.text) };
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) {
    return { value: -Number(expression.operand.text) };
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  if (ts.isArrayLiteralExpression(expression)) {
    const items: unknown[] = [];
    for (const element of expression.elements) {
      const item = literalOf(ts, element);
      if (item === undefined) return undefined;
      items.push(item.value);
    }
    return { value: items };
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const fields: Record<string, unknown> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return undefined;
      const item = literalOf(ts, property.initializer);
      if (item === undefined) return undefined;
      fields[property.name.text] = item.value;
    }
    return { value: fields };
  }
  return undefined;
}

/** What `on` holds: the subscriptions, or the place and the reason where it is not a list of them. */
export type On = { subscriptions: Array<Subscription & { line: number; column: number }> } | { bad: { line: number; column: number; message: string } };

/**
 * `on` of a parsed script: the records that start it, each a type or a type with a filter.
 *
 * Absent when the script declares none. The filter is read from the text as a literal, never by
 * running the script.
 */
export function onOf(ts: typeof Ts, source: Ts.SourceFile): On | undefined {
  const field = declarationField(ts, source, "on");
  if (field === undefined) return undefined;
  const list = bare(ts, field);
  const shape = "on must be a list of record types, or of { type, filter } with the filter written as a literal";
  if (!ts.isArrayLiteralExpression(list)) return { bad: { ...placeOf(ts, source, list), message: shape } };
  const subscriptions: Array<Subscription & { line: number; column: number }> = [];
  for (const element of list.elements) {
    const where = placeOf(ts, source, element);
    const item = bare(ts, element);
    if (ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item)) {
      subscriptions.push({ type: item.text, ...where });
      continue;
    }
    const written = ts.isObjectLiteralExpression(item) ? literalOf(ts, item)?.value : undefined;
    const parsed = Subscription.strict().safeParse(written);
    if (!parsed.success) return { bad: { ...where, message: shape } };
    subscriptions.push({ ...parsed.data, ...where });
  }
  return { subscriptions };
}

/** `on` of a script, read from the text without running it; absent when the script has none. */
export async function scriptOn(source: ScriptSource): Promise<On | undefined> {
  const ts = (await import("typescript")).default;
  return onOf(ts, ts.createSourceFile(source.file, source.text, ts.ScriptTarget.ESNext, true));
}
