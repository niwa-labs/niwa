// The timers plugin with its service made to fail: the wrapper hands the service a context whose
// `emit` fails for the types a test names, and everything else is the real host and the real journal.

import type { RecordType } from "@niwa-labs/core";
import type { Plugin, PluginApi } from "@niwa-labs/plugin";

/** `inner` with the writes of its service made to fail: `failures` says how many writes of a type fail first. */
export function failing(inner: Plugin, failures: Record<string, number>): Plugin {
  return {
    ...inner,
    setup(api: PluginApi) {
      inner.setup({
        ...api,
        service: (start) =>
          api.service((ctx) =>
            start({
              ...ctx,
              emit: async <T>(type: RecordType<T>, data: T, opts?: Parameters<typeof ctx.emit>[2]) => {
                const left = failures[type.name] ?? 0;
                if (left > 0) {
                  failures[type.name] = left - 1;
                  throw new Error("the write failed");
                }
                return ctx.emit(type, data, opts);
              },
            }),
          ),
      });
    },
  };
}
