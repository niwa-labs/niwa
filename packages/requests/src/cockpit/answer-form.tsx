import { readFields, SchemaFields, useAction, useViewer, type FormSchema } from "@niwa-labs/cockpit-sdk";
import { Button, cn } from "@niwa-labs/ui-kit";
import { useState } from "react";

import { answerAction, overrideAction, type OpenRequest, type Option } from "./actions.ts";
import { answerOf, EMPTY, type Built, type Filled } from "./answers.ts";

function OptionButton({ option, selected, onPick }: { option: Option; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        "flex min-w-0 flex-col items-start rounded-md border px-3 py-2 text-left text-sm wrap-anywhere hover:bg-accent",
        selected && "border-ring bg-accent",
      )}
    >
      <span className="font-medium">{option.label}</span>
      {option.description !== undefined && <span className="text-xs text-muted-foreground">{option.description}</span>}
    </button>
  );
}

export function AnswerForm({ request, onSent }: { request: OpenRequest; onSent: () => void }) {
  const question = request.input;
  const viewer = useViewer();
  const overriding = viewer.owner && request.to.kind !== "owner" && request.answerPolicy !== "owner-only";
  const answer = useAction(answerAction);
  const override = useAction(overrideAction);
  const send = overriding ? override : answer;
  const allowed = viewer.can(overriding ? overrideAction : answerAction);
  const [filled, setFilled] = useState<Filled>(EMPTY);
  const [problem, setProblem] = useState<string>();

  const submit = (built: Built): void => {
    if ("problem" in built) return setProblem(built.problem);
    setProblem(undefined);
    send.mutate({ id: request.id, answer: built.answer }, { onSettled: onSent });
  };
  const options = "options" in question ? question.options : [];
  const toggle = (id: string): void => setFilled((now) => {
    const picked = now.picked.includes(id)
      ? now.picked.filter((one) => one !== id)
      : question.kind === "multi" ? [...now.picked, id] : [id];
    return { ...now, picked };
  });
  const refused = overriding
    ? override.data?.answered === false ? "Не удалось ответить за адресата." : undefined
    : answer.data?.accepted === false
      ? answer.data.reason === "expired" ? "Срок ответа истёк." : "Запрос уже закрыт."
      : undefined;
  const typed = question.kind === "text" || ("allowOther" in question && question.allowOther === true);
  const schema: FormSchema | undefined = question.kind === "form" ? question.schema : undefined;
  if (!allowed) return <p className="text-sm text-muted-foreground">Ответ доступен адресату запроса.</p>;

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const value = schema === undefined
            ? filled
            : { ...filled, form: readFields(schema, new FormData(event.currentTarget)) };
          submit(answerOf(question, value));
        } catch (error) {
          setProblem(error instanceof Error ? error.message : "Проверьте заполненные поля.");
        }
      }}
    >
      {options.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Варианты ответа">
          {options.map((option) => (
            <OptionButton key={option.id} option={option} selected={filled.picked.includes(option.id)} onPick={() => toggle(option.id)} />
          ))}
        </div>
      )}
      {schema !== undefined && <SchemaFields schema={schema} />}
      {typed && (
        <label className="flex flex-col gap-1 text-sm">
          {question.kind === "text" ? "Ваш ответ" : "Свой вариант"}
          <textarea
            rows={2}
            value={filled.text}
            onChange={(event) => setFilled((now) => ({ ...now, text: event.target.value }))}
            className="w-full min-w-0 rounded-md border bg-background px-3 py-2"
          />
        </label>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={send.isPending}>
          {send.isPending ? "Отправляю…" : overriding ? "Ответить за адресата" : "Ответить"}
        </Button>
        {(problem !== undefined || refused !== undefined || send.isError) && (
          <span role="alert" className="min-w-0 text-sm text-destructive wrap-anywhere">
            {problem ?? refused ?? "Не удалось отправить ответ."}
          </span>
        )}
      </div>
    </form>
  );
}
