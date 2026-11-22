import { expect, test } from "bun:test";

import { Message } from "../src/envelope.ts";
import { describeMessage } from "../src/records.ts";
import { resultValue } from "../src/text.ts";

test("a result preview uses the outcome instead of truncated JSON", () => {
  const text = '{"checks":48,"outcome":"Проверено без ошибок"}';
  const result = Message.parse({
    id: "msg-123456",
    from: { kind: "agent", id: "fixture" },
    to: { kind: "owner" },
    body: { type: "result", text },
  });
  expect(describeMessage(result)).toBe("result: Проверено без ошибок");
  expect(resultValue(text)).toEqual({ checks: 48, outcome: "Проверено без ошибок" });
  expect(describeMessage({ ...result, body: { type: "result", text: '{"checks":48}' } })).toBe("result:");
  expect(resultValue('[{"checks":48}]')).toEqual([{ checks: 48 }]);
  const plain = "{notes} Keep the original prose.";
  expect(resultValue(plain)).toBeUndefined();
  expect(describeMessage({ ...result, body: { type: "result", text: plain } })).toBe("result: " + plain);
});
