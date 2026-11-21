/**
 * Hooks over the host: live projections of the record stream, and calls through TanStack
 * Query. A call can refresh itself when records it depends on arrive, so pages read state
 * once and let the stream tell them when to read again.
 */

import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";

import type { ActionRefLike } from "./host-client.ts";
import { matchRecord, type RecordMatch } from "./records.ts";
import type { Projection, StreamState } from "./record-stream.ts";
import { useCockpit } from "./runtime.tsx";

/**
 * The state of a projection over the live stream; re-renders when a matching record arrives.
 * Define the projection at module scope: its fold is cached by the projection object.
 */
export function useProjection<S>(projection: Projection<S>): S {
  const { records } = useCockpit();
  return useStore(records.store, () => records.project(projection));
}

/** Whether the stream is live, and the position it has reached. */
export function useStreamStatus(): Pick<StreamState, "status" | "seq" | "error"> {
  const { records } = useCockpit();
  const status = useStore(records.store, (s) => s.status);
  const seq = useStore(records.store, (s) => s.seq);
  const error = useStore(records.store, (s) => s.error);
  return { status, seq, error };
}

/** The query key of a call; invalidate it to read again. */
export function callKey(action: { readonly name: string } | string, input: unknown): readonly unknown[] {
  return ["niwa", "call", typeof action === "string" ? action : action.name, input];
}

export type UseCallOptions = {
  enabled?: boolean | undefined;
  /** Read again when a record matching this arrives on the live stream. */
  refreshOn?: RecordMatch | undefined;
  /** How long a result counts as fresh, in milliseconds. */
  staleTime?: number | undefined;
};

/** Call an action and keep its result, as a query. */
export function useCall<I, O, In = I>(
  action: ActionRefLike<I, O, In>,
  input: NoInfer<In>,
  options: UseCallOptions = {},
): UseQueryResult<O> {
  const { host, records } = useCockpit();
  const queryClient = useQueryClient();
  const queryKey = callKey(action, input);
  const keyText = JSON.stringify(queryKey);
  // The latest match, read when records arrive: a match written inline does not resubscribe.
  const refreshOn = useRef(options.refreshOn);
  // A matching record arrived while a read was in flight: read again once it settles.
  const missed = useRef(false);
  useEffect(() => {
    refreshOn.current = options.refreshOn;
  });
  const watching = options.refreshOn !== undefined;

  useEffect(() => {
    if (!watching) return;
    return records.store.subscribe((state, previous) => {
      const match = refreshOn.current;
      if (match === undefined || state.seq === previous.seq) return;
      for (let i = state.records.length - 1; i >= 0 && state.records[i]!.seq > previous.seq; i -= 1) {
        if (!matchRecord(match, state.records[i]!)) continue;
        // A read in flight is let finish rather than restarted, so a steady stream of records
        // cannot keep a slow call from ever answering; it is followed by one more read.
        if (queryClient.isFetching({ queryKey, exact: true }) > 0) missed.current = true;
        else void queryClient.invalidateQueries({ queryKey, exact: true });
        return;
      }
    });
    // The key is compared by value: a new object with the same input is the same query.
  }, [records, queryClient, watching, keyText]);

  const result = useQuery({
    queryKey,
    queryFn: ({ signal }) => host.call(action, input, { signal }),
    enabled: options.enabled,
    staleTime: options.staleTime,
  });

  useEffect(() => {
    if (result.isFetching || !missed.current) return;
    missed.current = false;
    void queryClient.invalidateQueries({ queryKey, exact: true });
  }, [result.isFetching, queryClient, keyText]);

  return result;
}

/** An action to call on demand, such as from a button. */
export function useAction<I, O, In = I>(action: ActionRefLike<I, O, In>): UseMutationResult<O, Error, In> {
  const { host } = useCockpit();
  return useMutation({ mutationFn: (input: In) => host.call(action, input) });
}
