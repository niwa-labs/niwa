import { useState } from "react";

/** The subset rendered as named controls. Other JSON Schemas use an editable JSON value. */
export type FormSchema = {
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, FormSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: FormSchema;
  additionalProperties?: unknown;
  anyOf?: FormSchema[];
  oneOf?: FormSchema[];
  allOf?: FormSchema[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

function choices(s: FormSchema) {
  return s.oneOf ?? s.anyOf;
}
function fixedObject(s: FormSchema) {
  return (
    s.type === "object" &&
    s.properties &&
    Object.keys(s.properties).length > 0 &&
    !s.$ref &&
    !s.allOf &&
    !choices(s) &&
    (s.additionalProperties === undefined || s.additionalProperties === false)
  );
}
function choiceTitle(s: FormSchema) {
  const tag = s.properties?.kind?.const ?? s.properties?.type?.const;
  return String(s.title ?? s.const ?? tag ?? s.type ?? "JSON");
}
const keyOf = (path: string[]) => JSON.stringify(path);

function Field({
  schema: s,
  path,
  required,
  initial,
  depth,
}: {
  schema: FormSchema;
  path: string[];
  required: boolean;
  initial?: unknown;
  depth: number;
}) {
  const variants = choices(s);
  const [picked, pick] = useState(() => {
    if (!variants || initial === undefined) return "";
    const i = variants.findIndex(
      (v) =>
        v.const === initial ||
        (typeof initial === "object" &&
          initial !== null &&
          v.properties?.kind?.const !== undefined &&
          v.properties.kind.const === Reflect.get(initial, "kind")) ||
        (typeof initial === v.type && v.type !== "object"),
    );
    return i < 0 ? "" : String(i);
  });
  const title = s.title || path.at(-1) || "Значение";
  const name = keyOf(path);
  const value = initial ?? s.default;
  const props = { name, required, title: s.description };
  if (s.type === "object" && s.properties && !Object.keys(s.properties).length && !s.additionalProperties) return null;
  if (s.const !== undefined) return <input type="hidden" name={name} value={JSON.stringify(s.const)} />;
  if (variants && depth < 3) {
    const index = picked || (required ? "0" : "");
    return (
      <fieldset>
        <label>
          {title}
          <select
            aria-label={title}
            name={name + ":variant"}
            value={index}
            required={required}
            onChange={(e) => pick(e.target.value)}
          >
            {!required && <option value="">Не задано</option>}
            {variants.map((v, i) => (
              <option key={i} value={i}>
                {choiceTitle(v)}
              </option>
            ))}
          </select>
        </label>
        {index !== "" && (
          <Field
            key={index}
            schema={variants[Number(index)]!}
            path={path}
            initial={initial}
            required
            depth={depth + 1}
          />
        )}
      </fieldset>
    );
  }
  if (fixedObject(s) && depth < 3 && (required || value !== undefined)) {
    const object = value && typeof value === "object" ? value : {};
    return (
      <fieldset>
        {path.length > 0 && <legend>{title}</legend>}
        {Object.entries(s.properties!).map(([k, child]) => (
          <Field
            key={k}
            schema={child}
            path={[...path, k]}
            required={!!s.required?.includes(k)}
            initial={Reflect.get(object, k)}
            depth={depth + 1}
          />
        ))}
      </fieldset>
    );
  }
  let control;
  if (s.enum || s.type === "boolean") {
    control = (
      <select {...props} defaultValue={value === undefined ? "" : JSON.stringify(value)}>
        <option value="">Выберите значение</option>
        {(s.enum ?? [true, false]).map((v) => (
          <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  } else if (s.type === "number" || s.type === "integer") {
    control = (
      <input
        {...props}
        type="number"
        step={s.type === "integer" ? "1" : "any"}
        min={s.minimum}
        max={s.maximum}
        defaultValue={value === undefined ? "" : String(value)}
      />
    );
  } else if (s.type === "string" && !s.$ref) {
    control = (
      <input
        {...props}
        minLength={s.minLength}
        maxLength={s.maxLength}
        defaultValue={value === undefined ? "" : String(value)}
      />
    );
  } else {
    control = (
      <textarea
        {...props}
        rows={3}
        placeholder={s.type === "array" ? "[]" : "JSON"}
        defaultValue={value === undefined ? "" : JSON.stringify(value, null, 2)}
      />
    );
  }
  return (
    <label>
      {title}
      {required ? " *" : ""}
      {control}
    </label>
  );
}

export function SchemaFields({ schema, initial }: { schema: FormSchema; initial?: unknown }) {
  return <Field schema={schema} path={[]} initial={initial} required depth={0} />;
}

export function readFields(schema: FormSchema, form: FormData, path: string[] = [], depth = 0): unknown {
  const name = keyOf(path);
  const variants = choices(schema);
  const variant = form.get(name + ":variant");
  if (variants && depth < 3 && variant !== null) {
    if (variant === "") return undefined;
    return readFields(variants[Number(variant)]!, form, path, depth + 1);
  }
  if (
    schema.type === "object" &&
    schema.properties &&
    !Object.keys(schema.properties).length &&
    !schema.additionalProperties
  )
    return {};
  if (schema.const !== undefined) return schema.const;
  if (fixedObject(schema) && !form.has(name) && depth < 3) {
    return Object.fromEntries(
      Object.entries(schema.properties!).flatMap(([k, v]) => {
        const field = readFields(v, form, [...path, k], depth + 1);
        return field === undefined ? [] : [[k, field]];
      }),
    );
  }
  const value = form.get(name);
  if (value === null || value === "") return undefined;
  if (schema.type === "string" && !schema.enum && !schema.$ref) return String(value);
  try {
    return JSON.parse(String(value));
  } catch {
    throw new Error("Проверьте JSON в поле «" + (path.at(-1) ?? "Значение") + "».");
  }
}
