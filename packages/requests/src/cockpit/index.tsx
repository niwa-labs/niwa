/** The cockpit module of the requests plugin: the questions that wait, with the forms that answer them. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { RequestDetail } from "./history.tsx";
import { RequestsPage, RequestsTile } from "./page.tsx";

export default definePlugin({
  id: "requests",
  setup(ctx) {
    ctx.pages.add({
      path: "/requests",
      title: "Запросы",
      commandHeading: true,
      nav: { order: 30 },
      commands: [{ action: "request.ask", label: "Задать вопрос", preset: { to: { kind: "owner" } } }],
      component: () => <RequestsPage />,
    });
    ctx.pages.add({ path: "/requests/$id", panel: true, title: "Запрос", component: RequestDetail });
    if (ctx.viewer.can("request.open"))
      ctx.slots.register("home.tile", { key: "questions", order: 10, component: RequestsTile });
    ctx.entities.register("request", {
      label: "Запрос",
      prefix: "req",
      href: (id) => "/requests/" + encodeURIComponent(id),
    });
  },
});
