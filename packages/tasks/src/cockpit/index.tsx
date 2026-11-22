/** The cockpit module of the tasks plugin: the list of tasks and the page of one. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { TaskPage, TasksPage } from "./pages.tsx";

export default definePlugin({
  id: "tasks",
  setup(ctx) {
    ctx.pages.add({
      path: "/tasks",
      title: "Tasks",
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
      title: "Task",
      commands: ({ params }) => [
        { action: "task.report", label: "Добавить отчёт", preset: { task: params.taskId } },
        { action: "task.finish", label: "Завершить задачу", preset: { task: params.taskId } },
      ],
      component: TaskPage,
    });
    ctx.entities.register("task", { label: "Task", prefix: "task", href: (id) => `/tasks/${encodeURIComponent(id)}` });
  },
});
