import { useState } from "react";
import { DataValue, recordObject } from "./data-value.tsx";

const types: Record<string, string> = {
  object: "Группа",
  string: "Текст",
  array: "Список",
  integer: "Целое",
  number: "Число",
  boolean: "Да / нет",
  null: "Пустое значение",
};
const typeName = (s: Record<string, unknown>) =>
  Array.isArray(s.type)
    ? s.type.map((v) => types[String(v)] ?? String(v)).join(" / ")
    : (types[String(s.type)] ??
      (s.properties ? "Группа" : s.enum ? "Выбор" : s.anyOf || s.oneOf ? "Варианты" : "Значение"));
function reference(ref: string, root: unknown) {
  if (!ref.startsWith("#/")) return;
  let v = root;
  for (const k of ref.slice(2).split("/")) v = recordObject(v)?.[k.replace(/~1/g, "/").replace(/~0/g, "~")];
  return v;
}
const limits: Record<string, string> = {
  minLength: "Мин. символов",
  maxLength: "Макс. символов",
  minimum: "Минимум",
  maximum: "Максимум",
  exclusiveMinimum: "Больше",
  exclusiveMaximum: "Меньше",
  minItems: "Мин. элементов",
  maxItems: "Макс. элементов",
  format: "Формат",
  pattern: "Шаблон",
  multipleOf: "Кратно",
};
function Fields({ schema, root, seen, level = 0 }: { schema: unknown; root: unknown; seen: string[]; level?: number }) {
  const [expanded, setExpanded] = useState(level < 2);
  if (typeof schema === "boolean") return <p>{schema ? "Допускается любое значение" : "Значение запрещено"}</p>;
  const s = recordObject(schema);
  if (!s) return null;
  if (typeof s.$ref === "string") {
    const dest = reference(s.$ref, root);
    return dest !== undefined && !seen.includes(s.$ref) ? (
      <Fields schema={dest} root={root} seen={[...seen, s.$ref]} level={level} />
    ) : (
      <small>Ссылка на тип · {s.$ref.split("/").at(-1)}</small>
    );
  }
  const props = Object.entries(recordObject(s.properties) ?? {}),
    required = Array.isArray(s.required) ? s.required : [];
  const variants = s.oneOf ?? s.anyOf ?? s.allOf;
  return (
    <div className="nw-schema">
      {typeof s.description === "string" && <p>{s.description}</p>}
      {props.length > 0 && (
        <>
          {level >= 2 && (
            <button type="button" className="nw-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              Поля группы · {props.length}
            </button>
          )}
          {expanded && (
            <ul>
              {props.map(([name, child]) => (
                <li key={name}>
                  <div className="nw-field-heading">
                    <strong>{name}</strong>
                    <span className="nw-tag" data-tone="blue">
                      {typeName(recordObject(child) ?? {})}
                    </span>
                    {required.includes(name) && <small>Обязательно</small>}
                  </div>
                  <Fields schema={child} root={root} seen={seen} level={level + 1} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {s.items !== undefined && (
        <div className="nw-schema-child">
          <b>Элементы · {typeName(recordObject(s.items) ?? {})}</b>
          <Fields schema={s.items} root={root} seen={seen} level={level + 1} />
        </div>
      )}
      {Array.isArray(variants) && (
        <div className="nw-schema-child">
          <b>{s.allOf ? "Все условия" : "Допустимые варианты"}</b>
          {variants.map((v, i) => (
            <div key={i}>
              <span className="nw-tag">{typeName(recordObject(v) ?? {})}</span>
              <Fields schema={v} root={root} seen={seen} level={level + 1} />
            </div>
          ))}
        </div>
      )}
      {s.enum !== undefined && (
        <div className="nw-field-rule">
          На выбор <DataValue value={s.enum} />
        </div>
      )}
      {Object.hasOwn(s, "const") && (
        <div className="nw-field-rule">
          Значение <DataValue value={s.const} />
        </div>
      )}
      {Object.hasOwn(s, "default") && (
        <div className="nw-field-rule">
          По умолчанию <DataValue value={s.default} />
        </div>
      )}
      {Object.keys(limits)
        .filter((k) => s[k] !== undefined)
        .map((k) => (
          <span className="nw-field-rule" key={k}>
            {limits[k]} <b>{String(s[k])}</b>
          </span>
        ))}
      {s.additionalProperties === false && props.length > 0 && (
        <small className="nw-quiet">Только перечисленные поля</small>
      )}
      {recordObject(s.additionalProperties) && (
        <div className="nw-schema-child">
          <b>Дополнительные поля</b>
          <Fields schema={s.additionalProperties} root={root} seen={seen} level={level + 1} />
        </div>
      )}
    </div>
  );
}
export function SchemaView({ schema }: { schema: unknown }) {
  const s = recordObject(schema);
  return (
    <div data-slot="schema-view">
      {!s?.properties && (
        <span className="nw-tag" data-tone="blue">
          {typeName(s ?? {})}
        </span>
      )}
      <Fields schema={schema} root={schema} seen={[]} />
    </div>
  );
}
