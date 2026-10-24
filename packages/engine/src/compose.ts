import type { Context, Middleware } from "./types.ts";

export function compose(stack: Middleware[]): (ctx: Context) => Promise<void> {
  return (ctx) => {
    let last = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= last) throw new Error("next() called multiple times");
      last = i;
      const fn = stack[i];
      if (!fn) return;
      await fn(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}
