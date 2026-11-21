/** The cockpit module of the sessions plugin: the list of sessions and the transcript of one. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { SessionPage, SessionsPage } from "./pages.tsx";

export default definePlugin({
  id: "sessions",
  setup(ctx) {
    ctx.pages.add({ path: "/sessions", title: "Sessions", nav: { order: 20 }, component: SessionsPage });
    ctx.pages.add({ path: "/sessions/$sessionId", title: "Session", component: SessionPage });
    ctx.entities.register("session", { label: "Session", prefix: "s", href: (id) => `/sessions/${encodeURIComponent(id)}` });
  },
});
