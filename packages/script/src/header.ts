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

/** What the declaration of a script says about one of its keys, read in the order the members are written. */
export interface DeclaredField {
  /** The value of the last key written under that name, when there is one. */
  value?: Ts.Expression;
  /**
   * What may decide the key where the text does not, written after the last key of that name: a spread, a key
   * computed at run time, or a getter, setter or method that is, or may be, under that name. The node is where the
   * declaration takes it from.
   */
  unknown?: Ts.Node;
}

/** The name a member is written under, when the text says it. */
function keyOf(ts: typeof Ts, name: Ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const written = bare(ts, name.expression);
    return ts.isStringLiteral(written) || ts.isNoSubstitutionTemplateLiteral(written) ? written.text : undefined;
  }
  return undefined;
}

/**
 * One key of the declaration of a script, read from the text. The last key of the name wins, as it does when the
 * object is built; a spread, a computed key or an accessor or method that may be under that name, written after it,
 * may replace it, so the text does not settle the value then. A later key of that name written as a property
 * settles it again.
 */
export function declaredField(ts: typeof Ts, source: Ts.SourceFile, field: string): DeclaredField | undefined {
  const declaration = declarationOf(ts, source);
  if (declaration === undefined || !("object" in declaration)) return undefined;
  const declared: DeclaredField = {};
  for (const property of declaration.object.properties) {
    if (ts.isSpreadAssignment(property)) {
      declared.unknown = property.expression;
    } else if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === field) {
        declared.value = property.name;
        delete declared.unknown;
      }
    } else if (ts.isPropertyAssignment(property)) {
      const key = keyOf(ts, property.name);
      if (key === field) {
        declared.value = property.initializer;
        delete declared.unknown;
      } else if (key === undefined && ts.isComputedPropertyName(property.name)) {
        declared.unknown = property.name.expression;
      } else if (key === "__proto__" && !ts.isComputedPropertyName(property.name) && declared.value === undefined) {
        // `__proto__: x` sets the prototype, which may hold the key: an own key written before it still wins.
        declared.unknown = property.initializer;
      }
    } else if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
      // A member that is not a plain value replaces the key of its name, and a computed one may be any name.
      const key = keyOf(ts, property.name);
      if (key === field || (key === undefined && ts.isComputedPropertyName(property.name))) declared.unknown = property.name;
    }
  }
  return declared.value === undefined && declared.unknown === undefined ? undefined : declared;
}

/** What the declaration of a script says of one key: the value written, or that the text does not settle it. Absent: no such key. */
export type DeclarationField = { value: Ts.Expression } | { unsettled: Ts.Node };

/**
 * One key of the declaration of a script, read from the text, in three results: absent (`undefined`), a value the
 * text settles, or a key the text does not settle (a later spread, computed key, accessor or method may decide it).
 * What may replace a key is never given as its value: a reader that takes the value as it reads it would take a
 * spread of a literal for the list the script wrote.
 */
export function declarationField(ts: typeof Ts, source: Ts.SourceFile, field: string): DeclarationField | undefined {
  const declared = declaredField(ts, source, field);
  if (declared === undefined) return undefined;
  return declared.unknown !== undefined ? { unsettled: declared.unknown } : declared.value === undefined ? undefined : { value: declared.value };
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

/** What the error of a type named in `on` by an expression says. */
const AS_TEXT = 'the header is read as text: name the type as text, as in on: ["task.done"]; a type imported by reference is for wait and read.records';

/** Whether an entry of `on` names its type by an expression, a reference, rather than as text. */
function namedInCode(ts: typeof Ts, item: Ts.Expression): boolean {
  const reference = (node: Ts.Expression): boolean => {
    const inner = bare(ts, node);
    return ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner);
  };
  if (!ts.isObjectLiteralExpression(item)) return reference(item);
  return item.properties.some(
    (property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "type" && reference(property.initializer),
  );
}

/**
 * `on` of a parsed script: the records that start it, each a type or a type with a filter.
 *
 * Absent when the script declares none. The filter is read from the text as a literal, never by
 * running the script.
 */
export function onOf(ts: typeof Ts, source: Ts.SourceFile): On | undefined {
  const declared = declaredField(ts, source, "on");
  if (declared === undefined) return undefined;
  const shape = "on must be a list of record types, or of { type, filter } with the filter written as a literal";
  // Something the text does not settle may decide `on`: report that, never a trigger the script may not have.
  if (declared.unknown !== undefined) {
    return { bad: { ...placeOf(ts, source, declared.unknown), message: "on is not settled by the declaration: a spread or a computed key may decide it. " + shape } };
  }
  const list = bare(ts, declared.value as Ts.Expression);
  if (!ts.isArrayLiteralExpression(list)) return { bad: { ...placeOf(ts, source, list), message: shape } };
  const subscriptions: Array<Subscription & { line: number; column: number }> = [];
  for (const element of list.elements) {
    const where = placeOf(ts, source, element);
    const item = bare(ts, element);
    const written = ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item)
      ? { type: item.text }
      : ts.isObjectLiteralExpression(item) ? literalOf(ts, item)?.value : undefined;
    // A bare type and an object are held to the same schema, so an empty type is refused in both.
    const parsed = Subscription.strict().safeParse(written);
    if (!parsed.success) return { bad: { ...where, message: namedInCode(ts, item) ? `${shape}. ${AS_TEXT}` : shape } };
    subscriptions.push({ ...parsed.data, ...where });
  }
  return { subscriptions };
}

/** `on` of a script, read from the text without running it; absent when the script has none. */
export async function scriptOn(source: ScriptSource): Promise<On | undefined> {
  const ts = (await import("typescript")).default;
  return onOf(ts, ts.createSourceFile(source.file, source.text, ts.ScriptTarget.ESNext, true));
}
