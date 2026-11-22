/** Open requests and paused work waiting for a decision. */

import { EntityLink, useAction, useCall, useViewer } from "@niwa-labs/cockpit-sdk";
import { Badge, Button, DataValue, fieldLabel, PageSection } from "@niwa-labs/ui-kit";
import { useQueryClient } from "@tanstack/react-query";

import { AnswerForm } from "./answer-form.tsx";
import { openAction, resolveAction, type OpenPaused, type OpenRequest, type Question } from "./actions.ts";
import { addressText, subjectLines } from "./answers.ts";
import { RequestHistory } from "./history.tsx";

const QUESTION_LABELS: Record<Question["kind"], string> = {
  choice: "Выбор варианта",
  multi: "Выбор нескольких вариантов",
  confirm: "Подтверждение",
  text: "Вопрос",
  form: "Форма",
  permission: "Разрешение",
};

const CHOICES: Record<string, string> = {
  retry: "Повторить", cancel: "Отменить", skip: "Пропустить",
};

function RequestCard({ request, onSent }: { request: OpenRequest; onSent: () => void }) {
  return (
    <article data-slot="request" data-kind={request.input.kind} className="min-w-0 flex flex-col gap-3 py-2">
      <header className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{QUESTION_LABELS[request.input.kind]}</Badge>
          <EntityLink entity={{ kind: "request", id: request.id }} label="Карточка запроса" />
        </div>
        <h3 className="mt-2 text-base font-semibold wrap-anywhere">{request.input.title}</h3>
        <ul className="mt-1 flex min-w-0 flex-wrap gap-2 text-sm text-muted-foreground">
          {request.from && <li className="min-w-0 wrap-anywhere">Отправитель · {addressText(request.from)}</li>}
          <li className="min-w-0 wrap-anywhere">Адресат · {addressText(request.to)}</li>
          {request.deadline !== undefined && <li>Ответ до <DataValue field="at" value={request.deadline} /></li>}
        </ul>
      </header>
      {request.input.detail && <p className="whitespace-pre-wrap wrap-anywhere">{request.input.detail}</p>}
      {request.input.kind === "permission" && (
        <dl data-slot="subject" className="nw-fields">
          {subjectLines(request.input.subject).map(({ label, value }) => (
            <div key={label}><dt>{fieldLabel(label)}</dt><dd><DataValue field={label} value={value} /></dd></div>
          ))}
        </dl>
      )}
      <AnswerForm request={request} onSent={onSent} />
    </article>
  );
}

function PausedCard({ paused, onSent }: { paused: OpenPaused; onSent: () => void }) {
  const resolve = useAction(resolveAction);
  const viewer = useViewer();
  return (
    <article data-slot="paused" className="min-w-0 flex flex-col gap-3 py-2">
      <h3 className="text-base font-semibold">Действие приостановлено</h3>
      {paused.reason && <p className="text-sm wrap-anywhere">{paused.reason}</p>}
      {viewer.can(resolveAction) && (
        <div className="flex flex-wrap gap-2">
          {paused.choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant={choice === "cancel" ? "outline" : "default"}
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ invocation: paused.invocation, choice }, { onSettled: onSent })}
            >
              {CHOICES[choice] ?? choice}
            </Button>
          ))}
        </div>
      )}
      {resolve.isError && <p role="alert" className="text-sm text-destructive">Не удалось применить решение.</p>}
    </article>
  );
}

export function RequestsTile() { return <RequestsPage home />; }

export function RequestsPage({ home = false }: { home?: boolean } = {}) {
  const queryClient = useQueryClient();
  const open = useCall(openAction, {}, { refreshOn: { types: ["request.*", "niwa.invocation.state"] } });
  const reread = (): void => void queryClient.invalidateQueries({ queryKey: ["niwa", "call"] });
  const questions = open.data?.requests.filter((entry): entry is OpenRequest =>
    "input" in entry && (!home || entry.to.kind === "owner"),
  ) ?? [];
  const paused = open.data?.requests.filter((entry): entry is OpenPaused => "invocation" in entry) ?? [];
  if (home && open.data && questions.length + paused.length === 0) return null;
  return (
    <>
      <PageSection title="Ждут ответа">
        {open.isPending ? <p role="status">Загружаю запросы…</p> : open.isError ? (
          <p role="alert">Не удалось загрузить запросы.</p>
        ) : questions.length === 0 && (!home || paused.length === 0) ? (
          <p>Запросов без ответа нет.</p>
        ) : (
          <div data-slot="requests" className="divide-y">
            {questions.map((request) => <RequestCard key={request.id} request={request} onSent={reread} />)}
            {home && paused.map((entry) => <PausedCard key={entry.invocation} paused={entry} onSent={reread} />)}
          </div>
        )}
      </PageSection>
      {!home && paused.length > 0 && (
        <PageSection title="Ждут решения">
          <div className="divide-y">
            {paused.map((entry) => <PausedCard key={entry.invocation} paused={entry} onSent={reread} />)}
          </div>
        </PageSection>
      )}
      {!home && <RequestHistory />}
    </>
  );
}
