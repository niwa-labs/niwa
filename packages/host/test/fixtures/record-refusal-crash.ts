import {z} from "zod";
import {action, record, RecordRefused} from "@niwa-labs/core";
import {createNiwa} from "@niwa-labs/host";
import {plugin} from "@niwa-labs/plugin";
import {counter, gate} from "@niwa-labs/testing";

export const Start = record("claim.start", z.object({mode: z.enum(["escaped", "claim", "handled"])}), {open: true});
export const Wake = record("claim.wake", z.object({}), {open: true});
export const Caught = record("claim.caught", z.object({audit: z.string()}));
export const Done = record("claim.done", z.object({}));
const Held = record("claim.held", z.object({}), {guard: {
  group: "claim", key: () => "one", initial: () => null, fold: () => null,
  admit: () => ({code: "held", reason: "already held"}),
}});

if (import.meta.main) {
  const home = process.argv[2]!;
  const host = createNiwa({home});
  host.use(plugin("claim", api => {
    api.declare(Start, Wake, Caught, Done, Held);
    const actions = (["escaped", "claim", "handled"] as const).map(mode => {
      const act = action(`claim.${mode}`, {
        description: "Attempt a guarded write", recovery: "do-not-repeat", effect: "write",
        input: z.object({}), output: z.null(),
        ...(mode === "claim" ? {terminalClaim: Held.name} : {}),
        async run(_, ctx) {
          counter(home, "calls").hit();
          try { await ctx.emit(Held, {}); }
          catch (error) {
            if (mode !== "escaped") await gate(home, "after-refusal").wait();
            if (mode !== "handled") throw error;
          }
          return null;
        },
      });
      api.action(act);
      return act;
    });
    api.on(Start, async ({mode}, step) => {
      try { await step(actions.find(act => act.name === `claim.${mode}`)!, {}, {key: "call"}); }
      catch (error) {
        if (!(error instanceof RecordRefused)) throw error;
        await step.emit(Caught, {audit: error.audit.id});
      }
      await step.wait(Wake);
      await step.emit(Done, {});
    });
  }));
  await host.serve();
}
