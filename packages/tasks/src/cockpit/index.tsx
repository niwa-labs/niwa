/** The cockpit module of the tasks plugin: the list of tasks and the page of one. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { TaskPage, TasksPage } from "./pages.tsx";

export default definePlugin({
  id: "tasks",
  setup(ctx) {
    ctx.pages.add({
      path: "/tasks",
      title: "Задачи",
      commandHeading: true,
      nav: { order: 40 },
      commands: [
        {
          action: "task.create",
          label: "Создать задачу",
          preset: { askedBy: { kind: "owner" }, reportTo: { kind: "owner" } },
        },
      ],
      component: TasksPage,
    });
    ctx.pages.add({
      path: "/tasks/$taskId",
      panel: true,
      title: "Задача",
      component: TaskPage,
    });
    ctx.entities.register("task", { label: "Задача", prefix: "task", href: (id) => `/tasks/${encodeURIComponent(id)}` });
  },
});
