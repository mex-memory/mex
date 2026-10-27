/** Keep graph and agent lifetimes coupled, and preserve the graph's actionable failure. */
export async function populateDuringGraph<T>(input: {
  signal?: AbortSignal;
  build: (signal: AbortSignal) => Promise<void>;
  populate: (ready: Promise<void>, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  let graphFailure: unknown;
  const ready = Promise.resolve().then(() => input.build(controller.signal)).catch((error: unknown) => {
    graphFailure = error;
    controller.abort();
    throw error;
  });
  // Population observes the same rejection through its apply gate; observe it immediately too.
  void ready.catch(() => undefined);
  try {
    const result = await input.populate(ready, controller.signal);
    await ready;
    return result;
  } catch (error) {
    const cause = graphFailure ?? error;
    controller.abort();
    await ready.catch(() => undefined);
    throw cause;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}
