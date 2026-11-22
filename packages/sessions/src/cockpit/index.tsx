/** The cockpit module of the sessions plugin: the list of sessions and the transcript of one. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { SessionPage, SessionsPage, SessionsTile } from "./pages.tsx";

export default definePlugin({
  id: "sessions",
  setup(ctx) {
    ctx.pages.add({
      path: "/sessions",
      title: "Sessions",
      nav: { order: 20 },
      commands: [{ action: "session.start", label: "Начать сессию" }],
      component: SessionsPage,
    });
    ctx.pages.add({
      path: "/sessions/$sessionId",
      title: "Session",
      commands: ({ params }) => [
        { action: "session.send", label: "Отправить сообщение", preset: { session: params.sessionId } },
        { action: "session.resume", label: "Продолжить сессию", preset: { session: params.sessionId } },
        { action: "session.interrupt", label: "Прервать ход", preset: { session: params.sessionId } },
      ],
      component: SessionPage,
    });
    if (ctx.viewer.can("session.list"))
      ctx.slots.register("home.main", { key: "sessions", order: 20, component: SessionsTile });
    ctx.entities.register("session", {
      label: "Session",
      prefix: "s",
      href: (id) => `/sessions/${encodeURIComponent(id)}`,
    });
  },
});
