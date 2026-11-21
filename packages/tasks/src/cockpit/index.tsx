/** The cockpit module of the tasks plugin: the list of tasks and the page of one. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { TaskPage, TasksPage } from "./pages.tsx";

export default definePlugin({
  id: "tasks",
  setup(ctx) {
    ctx.pages.add({ path: "/tasks", title: "Tasks", nav: { order: 40 }, component: TasksPage });
    ctx.pages.add({ path: "/tasks/$taskId", title: "Task", component: TaskPage });
    ctx.entities.register("task", { label: "Task", prefix: "task", href: (id) => `/tasks/${encodeURIComponent(id)}` });
  },
});
