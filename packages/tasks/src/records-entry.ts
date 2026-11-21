/**
 * The records entry of the tasks module: what another plugin may import from it. The records, the
 * typed references of the actions, and the pure functions that fold the state of a task from the
 * journal; no factory and nothing that runs. The actions import the records, so this file sits
 * above both and neither imports it.
 */

export {
  TASK_TYPES,
  TaskContract,
  TaskCreated,
  TaskDone,
  TaskId,
  TaskKind,
  TaskOutcome,
  TaskUpdated,
} from "./records.ts";
export {
  CreateInput,
  FailInput,
  FinishInput,
  OutcomeOutput,
  ReportInput,
  TaskEntity,
  TaskStatus,
  taskAssigned,
  taskCreate,
  taskFail,
  taskFinish,
  taskGet,
  taskList,
  taskReport,
  taskResult,
} from "./actions.ts";
export { TaskRefusal, fold, sameAddress, stateOf } from "./owner.ts";
export type { TaskState } from "./owner.ts";
