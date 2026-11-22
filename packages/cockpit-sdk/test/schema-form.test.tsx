import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SchemaFields, readFields, type FormSchema } from "../src/schema-form.tsx";

let root: Root | undefined;
let form: HTMLFormElement | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:4000/" });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  form?.parentElement?.remove();
  root = undefined;
  form = undefined;
});

afterAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  await GlobalRegistrator.unregister();
});

async function render(schema: FormSchema, initial?: unknown, optional?: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<form><SchemaFields schema={schema} initial={initial} optional={optional} /></form>));
  form = host.querySelector("form")!;
  return form;
}

function group(scope: HTMLElement, title: string): HTMLFieldSetElement {
  const label = [...scope.querySelectorAll("legend")].find((element) => element.textContent === title);
  return label!.parentElement as HTMLFieldSetElement;
}

async function click(scope: HTMLElement, name: string) {
  const button = [...scope.querySelectorAll("button")].find((element) =>
    (element.getAttribute("aria-label") ?? element.textContent) === name);
  expect(button?.type).toBe("button");
  await act(async () => button!.click());
}

async function choose(scope: HTMLElement, value: string) {
  const select = scope.querySelector("select")!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("keeps typed nested presets, empty values, and absent optional fields", async () => {
  const schema: FormSchema = {
    type: "object",
    properties: {
      settings: {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "integer" },
          enabled: { type: "boolean" },
          note: { type: "string" },
          result: { type: ["object", "null"], properties: { name: { type: "string" } } },
          ignored: { const: "value" },
        },
        required: ["name", "count", "enabled", "result"],
      },
      missing: { type: "array", items: { type: "boolean" } },
      list: { type: "array", items: { type: "string" } },
      preset: { type: "boolean", default: false },
    },
    required: ["settings"],
  };
  const initial = { settings: { name: "", count: 0, enabled: false, note: "", result: null }, list: [] };
  const form = await render(schema, initial);
  expect(form.querySelector("textarea")).toBeNull();
  expect(readFields(schema, new FormData(form))).toEqual({ ...initial, preset: false });

  const toggle = form.querySelector<HTMLInputElement>('[aria-label="Задать: note"]')!;
  await act(async () => toggle.click());
  expect(readFields(schema, new FormData(form))).toEqual({
    settings: { name: "", count: 0, enabled: false, result: null },
    list: [],
    preset: false,
  });
  await act(async () => toggle.click());
  expect(readFields(schema, new FormData(form))).toEqual({ ...initial, preset: false });
});

test("creates and removes object properties and ordered array values through controls", async () => {
  const schema: FormSchema = { title: "Аргументы", type: ["object", "array", "string", "number", "boolean", "null"] };
  const form = await render(schema, undefined, true);
  expect(readFields(schema, new FormData(form))).toBeUndefined();
  const toggle = form.querySelector<HTMLInputElement>('[aria-label="Задать: Аргументы"]')!;
  await act(async () => toggle.click());
  expect(readFields(schema, new FormData(form))).toEqual({});

  await click(form, "Добавить поле");
  const field = group(form, "Поле 1");
  field.querySelector<HTMLInputElement>("input:not([type=hidden])")!.value = "items";
  await choose(field, "array");
  await click(field, "Добавить элемент");
  const first = group(field, "Элемент 1");
  first.querySelector<HTMLTextAreaElement>("textarea")!.value = "123";
  await click(field, "Добавить элемент");
  const second = group(field, "Элемент 2");
  await choose(second, "number");
  second.querySelector<HTMLInputElement>('input[type="number"]')!.value = "123";
  expect(readFields(schema, new FormData(form))).toEqual({ items: ["123", 123] });

  await click(field, "Удалить элемент 1");
  expect(readFields(schema, new FormData(form))).toEqual({ items: [123] });
  await click(form, "Удалить поле 1");
  expect(readFields(schema, new FormData(form))).toEqual({});
});

test("recovers the selected nested variant and retains arbitrary presets", async () => {
  const schema: FormSchema = {
    title: "Режим",
    oneOf: [
      { type: "string" },
      { title: "Режим с полями", anyOf: [
        { type: "boolean" },
        { type: "object", properties: { kind: { const: "custom" }, payload: {} }, required: ["kind", "payload"] },
      ] },
    ],
  };
  const preset = { kind: "custom", payload: [{ active: false }, null, 5, "one\ntwo"] };
  const form = await render(schema, preset);
  expect(readFields(schema, new FormData(form))).toEqual(preset);
  await choose(form, "0");
  expect(readFields(schema, new FormData(form))).toBe("");
});

test("picks the object variant that owns the preset fields", async () => {
  const schema: FormSchema = { anyOf: [
    { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
    { type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"] },
  ] };
  const form = await render(schema, { flag: false });
  expect(readFields(schema, new FormData(form))).toEqual({ flag: false });
});

test("rejects repeated names and invalid numbers before submission", async () => {
  const schema: FormSchema = { title: "Параметры", type: "object", additionalProperties: { type: "integer" } };
  const form = await render(schema, { a: 1 });
  await click(form, "Добавить поле");
  const field = group(form, "Поле 2");
  const [name, value] = field.querySelectorAll<HTMLInputElement>("input:not([type=hidden])");
  name!.value = "a";
  value!.value = "2";
  expect(() => readFields(schema, new FormData(form))).toThrow("Имя поля «a» повторяется");
  name!.value = "b";
  value!.value = "2.5";
  expect(() => readFields(schema, new FormData(form))).toThrow("Проверьте значение в поле «b»");
});
