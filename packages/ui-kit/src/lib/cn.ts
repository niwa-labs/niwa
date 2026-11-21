import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets a later Tailwind utility win over an earlier one of the same kind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Merges `className` into `base` the way `cn` does, for a Base UI part that also takes a function
 * of its state: the function is kept, and its result is merged when the part renders.
 */
export function cnWith<State>(
  base: ClassValue,
  className: string | ((state: State) => string | undefined) | undefined,
): string | ((state: State) => string) {
  if (typeof className === "function") return (state) => cn(base, className(state));
  return cn(base, className);
}
