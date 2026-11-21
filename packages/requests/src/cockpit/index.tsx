/** The cockpit module of the requests plugin: the questions that wait, with the forms that answer them. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { RequestsPage } from "./page.tsx";

export default definePlugin({
  id: "requests",
  setup(ctx) {
    ctx.pages.add({ path: "/requests", title: "Requests", nav: { order: 30 }, component: RequestsPage });
    ctx.entities.register("request", { label: "Request", prefix: "req", href: () => "/requests" });
  },
});
