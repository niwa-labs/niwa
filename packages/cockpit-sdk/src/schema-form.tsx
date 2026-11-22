import { useRef, useState } from "react";

/** The JSON Schema fields the form uses to choose controls. */
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

const TYPE_LABELS = {
  string: "Строка",
  number: "Число",
  integer: "Целое число",
  boolean: "Да или нет",
  null: "Пустое значение",
  object: "Объект",
  array: "Список",
} as const;
type ValueType = keyof typeof TYPE_LABELS;

const VALUE_TYPES: readonly ValueType[] = ["string", "number", "boolean", "null", "object", "array"];
const ROOT = "[]";
const propName = (name: string, key: string) => name + ":property:" + JSON.stringify(key);
const variantName = (name: string, index: number) => name + ":option:" + index;
const rowName = (name: string, id: string) => name + ":item:" + id;

function extraFields(schema: FormSchema) {
  return schema.additionalProperties !== false && (schema.properties === undefined || schema.additionalProperties !== undefined);
}

function typeOf(value: unknown): ValueType | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return isValueType(type) ? type : undefined;
}

function isValueType(value: string): value is ValueType {
  return Object.hasOwn(TYPE_LABELS, value);
}

function schemaType(schema: FormSchema): ValueType | undefined {
  if (typeof schema.type === "string" && isValueType(schema.type)) return schema.type;
  if (Array.isArray(schema.type)) return undefined;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return undefined;
}

function options(schema: FormSchema) {
  return schema.oneOf ?? schema.anyOf;
}

function equals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equals(item, right[index]));
  }
  if (typeOf(left) !== "object" || typeOf(right) !== "object") return false;
  const first = entries(left);
  const second = right as Record<string, unknown>;
  return first.length === Object.keys(second).length &&
    first.every(([key, value]) => Object.hasOwn(second, key) && equals(value, second[key]));
}

function entries(value: unknown): [string, unknown][] {
  return typeOf(value) === "object" ? Object.entries(value as Record<string, unknown>) : [];
}

function valueLabel(value: unknown): string {
  if (value === null) return TYPE_LABELS.null;
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (value === "") return "Пустая строка";
  if (typeof value === "object") return Array.isArray(value) ? TYPE_LABELS.array : TYPE_LABELS.object;
  return String(value);
}

function variantLabel(schema: FormSchema, index: number) {
  const tag = schema.const !== undefined ? schema.const : schema.properties?.kind?.const ?? schema.properties?.type?.const;
  const type = schemaType(schema);
  return schema.title ?? (tag !== undefined ? valueLabel(tag) : type ? TYPE_LABELS[type] : "Вариант " + (index + 1));
}

function variantScore(schema: FormSchema, value: unknown): number {
  if (schema.const !== undefined) return equals(schema.const, value) ? 3 : 0;
  if (schema.enum) return schema.enum.some((choice) => equals(choice, value)) ? 3 : 0;
  const variants = options(schema);
  if (variants?.length) return Math.max(...variants.map((variant) => variantScore(variant, value)));
  if (value === undefined) return 0;
  const type = typeOf(value);
  const expected = schemaType(schema);
  if (type === "object" && expected === "object" && schema.properties) {
    const properties = new Map(entries(value));
    if (schema.required?.some((key) =>
      !properties.has(key) && schema.properties?.[key]?.default === undefined && schema.properties?.[key]?.const === undefined
    )) return 0;
    const fields = Object.entries(schema.properties);
    const tags = fields.filter(([, child]) => child.const !== undefined);
    if (tags.length) return tags.every(([key, child]) => equals(child.const, properties.get(key))) ? 3 : 0;
    return fields.some(([key]) => properties.has(key)) ? 2 : 1;
  }
  if (Array.isArray(schema.type)) return schema.type.some((option) => option === type || (option === "integer" && Number.isInteger(value))) ? 1 : 0;
  return expected === type || (expected === "integer" && Number.isInteger(value)) ? 1 : 0;
}

function variantIndex(schemas: FormSchema[], value: unknown): number {
  const scores = schemas.map((schema) => variantScore(schema, value));
  return scores.indexOf(Math.max(...scores));
}

type FieldProps = { schema: FormSchema; name: string; title: string; initial?: unknown; optional?: boolean };

function Field({ schema, name, title, initial, optional }: FieldProps) {
  const value = initial === undefined ? schema.default : initial;
  const label = schema.title || title;
  const [present, setPresent] = useState(value !== undefined);
  const control = <FieldValue schema={schema} name={name} title={optional ? "" : label} initial={value} />;
  if (!optional) return control;
  return (
    <fieldset>
      <legend>{label || "Значение"}</legend>
      <label className="schema-form-toggle">
        <span>
          <input
            type="checkbox"
            checked={present}
            aria-label={"Задать: " + label}
            onChange={(event) => setPresent(event.currentTarget.checked)}
          />
          {" "}Задать
        </span>
      </label>
      <input type="hidden" name={name + ":present"} value={present ? "1" : "0"} />
      <div hidden={!present}>
        <fieldset disabled={!present}>{control}</fieldset>
      </div>
    </fieldset>
  );
}

function FieldValue({ schema, name, title, initial }: FieldProps) {
  const variants = options(schema);
  if (schema.const !== undefined) return null;
  if (variants?.length) return <VariantField schema={schema} variants={variants} name={name} title={title} initial={initial} />;
  if (schema.enum) return <ChoiceField values={schema.enum} description={schema.description} name={name} title={title} initial={initial} />;
  const type = schemaType(schema);
  if (type && !schema.$ref && !schema.allOf) {
    return <TypedField schema={schema} type={type} name={name} title={title} initial={initial} />;
  }
  return <DynamicField schema={schema} name={name} title={title} initial={initial} />;
}

function VariantField({ name, title, initial, variants, schema }: FieldProps & { variants: FormSchema[] }) {
  const initialIndex = variantIndex(variants, initial);
  const [selected, setSelected] = useState(initialIndex);
  return (
    <fieldset>
      {title && <legend>{title}</legend>}
      <label>
        Вариант
        <select name={name + ":variant"} title={schema.description} value={selected} onChange={(event) => setSelected(Number(event.currentTarget.value))}>
          {variants.map((variant, index) => <option key={index} value={index}>{variantLabel(variant, index)}</option>)}
        </select>
      </label>
      <Field
        key={selected}
        schema={variants[selected]!}
        name={variantName(name, selected)}
        title=""
        initial={selected === initialIndex ? initial : undefined}
      />
    </fieldset>
  );
}

function DynamicField({ schema, name, title, initial }: FieldProps) {
  const allowed = Array.isArray(schema.type) ? schema.type.filter(isValueType) : VALUE_TYPES;
  const types = allowed.length ? allowed : VALUE_TYPES;
  const initialType = typeOf(initial);
  const compatible = types.find((type) => type === initialType || (type === "integer" && Number.isInteger(initial)));
  const [selected, setSelected] = useState<ValueType>(compatible ?? types[0]!);
  return (
    <fieldset>
      {title && <legend>{title}</legend>}
      <label>
        Тип значения
        <select
          name={name + ":type"}
          title={schema.description}
          value={selected}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (isValueType(value)) setSelected(value);
          }}
        >
          {types.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
        </select>
      </label>
      <TypedField key={selected} schema={schema} name={name} title="" type={selected} initial={selected === compatible ? initial : undefined} multiline />
    </fieldset>
  );
}

function ChoiceField({ title, name, values, initial, description }: {
  title: string;
  name: string;
  values: unknown[];
  initial: unknown;
  description?: string;
}) {
  const index = values.findIndex((value) => equals(value, initial));
  return (
    <label>
      {title || "Значение"}
      <select name={name} title={description} required defaultValue={index < 0 ? "" : String(index)}>
        <option value="">Выберите значение</option>
        {values.map((value, index) => <option key={index} value={index}>{valueLabel(value)}</option>)}
      </select>
    </label>
  );
}

function TypedField({ type, schema, name, title, initial, multiline }: FieldProps & { type: ValueType; multiline?: boolean }) {
  if (type === "object" || type === "array") {
    return <CollectionField schema={schema} name={name} title={title} initial={initial} type={type} />;
  }
  if (type === "null") return null;
  if (type === "boolean") return <ChoiceField title={title} name={name} description={schema.description} values={[true, false]} initial={initial} />;
  if (type === "string") {
    const text = typeof initial === "string" ? initial : "";
    const props = {
      name,
      title: schema.description,
      minLength: schema.minLength,
      maxLength: schema.maxLength,
      required: !!schema.minLength,
      defaultValue: text,
    };
    return (
      <label>
        {title || "Значение"}
        {multiline || /[\r\n]/.test(text) ? <textarea {...props} rows={2} /> : <input {...props} />}
      </label>
    );
  }
  return (
    <label>
      {title || "Значение"}
      <input
        name={name}
        title={schema.description}
        type="number"
        step={type === "integer" ? "1" : "any"}
        min={schema.minimum}
        max={schema.maximum}
        required
        defaultValue={typeof initial === "number" ? String(initial) : ""}
      />
    </label>
  );
}

function extraSchema(schema: FormSchema): FormSchema {
  return schema.additionalProperties && typeof schema.additionalProperties === "object"
    ? schema.additionalProperties as FormSchema : {};
}

function CollectionField({ type, schema, name, title, initial }: FieldProps & { type: "object" | "array" }) {
  const object = type === "object";
  const properties = object ? schema.properties : undefined;
  const extras = entries(initial).filter(([key]) => !Object.hasOwn(properties ?? {}, key));
  const more = !object || extraFields(schema) || (schema.additionalProperties !== false && extras.length > 0);
  const [rows, setRows] = useState(() => {
    if (object) {
      return more
        ? extras.map(([key, value], id) => ({ id, key, value }))
        : [];
    }
    return Array.isArray(initial) ? initial.map((value: unknown, id) => ({ id, key: "", value })) : [];
  });
  const next = useRef(rows.length);
  const propertiesByName = new Map(entries(initial));
  const item = object ? extraSchema(schema) : schema.items ?? {};
  return (
    <fieldset>
      {title && (name !== ROOT || schema.title) && <legend>{title}</legend>}
      {schema.description && <p>{schema.description}</p>}
      {Object.entries(properties ?? {}).map(([key, child]) => (
        <Field
          key={key}
          schema={child}
          name={propName(name, key)}
          title={key}
          initial={propertiesByName.get(key)}
          optional={!schema.required?.includes(key)}
        />
      ))}
      {rows.map(({ id, key, value }, index) => {
        const row = rowName(name, String(id));
        const label = (object ? "Поле " : "Элемент ") + (index + 1);
        return (
          <fieldset key={id} className="schema-form-entry">
            <legend>{label}</legend>
            <input type="hidden" name={name + ":row"} value={id} />
            {object && (
              <label>
                Имя поля
                <input name={row + ":key"} required={key !== "" || value === undefined} defaultValue={key} />
              </label>
            )}
            <Field schema={item} name={row} title="" initial={value} />
            <button
              type="button"
              aria-label={object ? "Удалить поле " + (index + 1) : "Удалить элемент " + (index + 1)}
              onClick={() => setRows((current) => current.filter((one) => one.id !== id))}
            >
              Удалить
            </button>
          </fieldset>
        );
      })}
      {more && (
        <button type="button" onClick={() => {
          const id = next.current++;
          setRows((current) => [...current, { id, key: "", value: undefined }]);
        }}>
          {object ? "Добавить поле" : "Добавить элемент"}
        </button>
      )}
    </fieldset>
  );
}

export function SchemaFields({ schema, initial, optional }: { schema: FormSchema; initial?: unknown; optional?: boolean }) {
  return <Field schema={schema} name={ROOT} title="Значение" initial={initial} optional={optional} />;
}

function invalid(title: string) {
  return new Error("Проверьте значение в поле «" + title + "».");
}

function readIndex(form: FormData, name: string, title: string, count: number): number {
  const raw = form.get(name);
  const index = typeof raw === "string" && raw !== "" ? Number(raw) : -1;
  if (!Number.isInteger(index) || index < 0 || index >= count) throw invalid(title);
  return index;
}

function readField(schema: FormSchema, form: FormData, name: string, title: string): unknown {
  if (form.get(name + ":present") === "0") return undefined;
  const label = schema.title || title;
  if (schema.const !== undefined) return schema.const;
  const variants = options(schema);
  if (variants?.length) {
    const index = readIndex(form, name + ":variant", label, variants.length);
    return readField(variants[index]!, form, variantName(name, index), label);
  }
  if (schema.enum) return schema.enum[readIndex(form, name, label, schema.enum.length)];
  const type = form.get(name + ":type") ?? schemaType(schema);
  if (typeof type !== "string" || !isValueType(type)) throw invalid(label);
  if (type === "null") return null;
  if (type === "boolean") return readIndex(form, name, label, 2) === 0;
  if (type === "array") {
    return form.getAll(name + ":row").map((id, index) =>
      readField(schema.items ?? {}, form, rowName(name, String(id)), label + " · " + (index + 1)));
  }
  if (type === "object") {
    const properties = schema.properties ?? {};
    const values = new Map<string, unknown>();
    for (const [key, child] of Object.entries(properties)) {
      const value = readField(child, form, propName(name, key), key);
      if (value !== undefined) values.set(key, value);
    }
    if (schema.additionalProperties !== false) {
      for (const id of form.getAll(name + ":row")) {
        const row = rowName(name, String(id));
        const key = form.get(row + ":key");
        if (typeof key !== "string") throw invalid(label);
        if (values.has(key) || Object.hasOwn(properties, key)) {
          throw new Error("Имя поля «" + key + "» повторяется в «" + label + "».");
        }
        values.set(key, readField(extraSchema(schema), form, row, key || "Значение"));
      }
    }
    return Object.fromEntries(values);
  }
  const raw = form.get(name);
  if (typeof raw !== "string") throw invalid(label);
  if (type === "string") {
    if (raw.length < (schema.minLength ?? 0) || raw.length > (schema.maxLength ?? Infinity)) throw invalid(label);
    return raw;
  }
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value)) ||
      value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw invalid(label);
  return value;
}

export function readFields(schema: FormSchema, form: FormData, path: string[] = [], _depth = 0): unknown {
  return readField(schema, form, path.reduce(propName, ROOT), path.at(-1) ?? "Значение");
}
