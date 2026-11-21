/** The questions that wait for an answer, each with the form that answers it. */

import { EntityLink, useAction, useCall } from "@niwa-labs/cockpit-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, cn } from "@niwa-labs/ui-kit";

import { answerAction, openAction, resolveAction, type OpenPaused, type OpenRequest, type Option } from "./actions.ts";
import { addressText, answerOf, EMPTY, otherAnswer, type Built, type Filled } from "./answers.ts";

function OptionButton({ option, selected, onPick }: { option: Option; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        "flex min-w-0 flex-col items-start rounded-md border px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
        selected && "border-ring bg-accent",
      )}
    >
      <span className="font-medium">{option.label}</span>
      {option.description === undefined ? null : <span className="text-xs text-muted-foreground">{option.description}</span>}
    </button>
  );
}

/** The form of one question: options to pick, a text, or a JSON value, and the button that sends the answer. */
function AnswerForm({ request, onSent }: { request: OpenRequest; onSent: () => void }) {
  const question = request.input;
  const send = useAction(answerAction);
  const [filled, setFilled] = useState<Filled>(EMPTY);
  const [problem, setProblem] = useState<string | undefined>();

  const submit = (built: Built): void => {
    if ("problem" in built) return setProblem(built.problem);
    setProblem(undefined);
    send.mutate({ id: request.id, answer: built.answer }, { onSettled: onSent });
  };
  const options = "options" in question ? question.options : [];
  const single = question.kind === "choice" || question.kind === "confirm" || question.kind === "permission";
  const toggle = (id: string): void =>
    setFilled((now) => ({ ...now, picked: now.picked.includes(id) ? now.picked.filter((one) => one !== id) : question.kind === "multi" ? [...now.picked, id] : [id] }));
  const refused = send.data !== undefined && !send.data.accepted ? `The answer was not taken: the request was ${send.data.reason ?? "over"}.` : undefined;
  const typed = question.kind === "text" || question.kind === "form" || ("allowOther" in question && question.allowOther === true);

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit(single && filled.picked.length === 0 && filled.text !== "" ? otherAnswer(filled.text) : answerOf(question, filled));
      }}
    >
      {options.length === 0 ? null : (
        <div className="flex flex-wrap gap-2" role={single ? "radiogroup" : "group"}>
          {options.map((option) => (
            <OptionButton key={option.id} option={option} selected={filled.picked.includes(option.id)} onPick={() => toggle(option.id)} />
          ))}
        </div>
      )}
      {typed ? (
        <textarea
          aria-label={question.kind === "form" ? "The value as JSON" : "Your answer"}
          rows={question.kind === "form" ? 6 : 2}
          value={filled.text}
          onChange={(event) => setFilled((now) => ({ ...now, text: event.target.value }))}
          placeholder={question.kind === "form" ? "{ }" : "Write an answer"}
          className={cn("w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm", question.kind === "form" && "font-mono")}
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-3">
        <Button type="submit" size="sm" disabled={send.isPending}>
          {send.isPending ? "Sending…" : "Answer"}
        </Button>
        {problem === undefined && refused === undefined && !send.isError ? null : (
          <span role="alert" className="min-w-0 truncate text-xs text-destructive">
            {problem ?? refused ?? send.error?.message}
          </span>
        )}
      </div>
    </form>
  );
}

function RequestCard({ request, onSent }: { request: OpenRequest; onSent: () => void }) {
  return (
    <article data-slot="request" data-kind={request.input.kind} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="min-w-0 text-sm font-semibold">{request.input.title}</h3>
        <Badge variant="secondary">{request.question}</Badge>
        <EntityLink entity={{ kind: "request", id: request.id }} short />
        <span className="ml-auto text-xs text-muted-foreground">
          {request.from === undefined ? "" : `from ${addressText(request.from)} `}to {addressText(request.to)}
        </span>
      </header>
      {request.input.detail === undefined ? null : <p className="whitespace-pre-wrap text-sm text-muted-foreground">{request.input.detail}</p>}
      <AnswerForm request={request} onSent={onSent} />
    </article>
  );
}

/** A run or an invocation that stopped and waits for a choice. */
function PausedCard({ paused, onSent }: { paused: OpenPaused; onSent: () => void }) {
  const resolve = useAction(resolveAction);
  return (
    <article data-slot="paused" className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
      <h3 className="text-sm font-semibold">Paused for a decision</h3>
      <p className="text-sm text-muted-foreground">{paused.reason ?? "The work stopped and waits for a choice."}</p>
      <div className="flex flex-wrap gap-2">
        {paused.choices.map((choice) => (
          <Button
            key={choice}
            size="sm"
            variant={choice === "cancel" ? "outline" : "default"}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ invocation: paused.invocation, choice }, { onSettled: onSent })}
          >
            {choice}
          </Button>
        ))}
      </div>
      {resolve.isError ? <p role="alert" className="text-xs text-destructive">{resolve.error.message}</p> : null}
    </article>
  );
}

export function RequestsPage() {
  const queryClient = useQueryClient();
  const open = useCall(openAction, {}, { refreshOn: { types: ["request.*", "niwa.invocation.state"] } });
  const reread = (): void => void queryClient.invalidateQueries({ queryKey: ["niwa", "call"] });
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Requests</h2>
      {open.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : open.isError ? (
        <p role="alert" className="text-sm text-destructive">The requests could not be read: {open.error.message}</p>
      ) : open.data.requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing waits for an answer.</p>
      ) : (
        <div data-slot="requests" className="flex min-w-0 flex-col gap-3">
          {open.data.requests.map((entry) =>
            "kind" in entry && entry.kind === "paused" ? (
              <PausedCard key={entry.invocation} paused={entry} onSent={reread} />
            ) : (
              <RequestCard key={(entry as OpenRequest).id} request={entry as OpenRequest} onSent={reread} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
