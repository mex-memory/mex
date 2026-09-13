/** Shared contact delivery for the embedded Hub forms and terminal completion. */
export const WEB3FORMS_ACCESS_KEY = "20549db8-9c62-4da9-920a-f70a08c8ee44";
export const WEB3FORMS_SUBMIT_URL = "https://api.web3forms.com/submit";
export const CONTACT_SUBMIT_ERROR = "Could not send your details. Try again when you are online.";

export async function submitContactPayload(
  payload: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!payload.access_key?.trim() || signal?.aborted) return { ok: false, message: CONTACT_SUBMIT_ERROR };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<false>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(false), { once: true });
      timer = setTimeout(abort, 15_000);
    });
    const accepted = await Promise.race([
      (async () => {
        const response = await fetchImpl(WEB3FORMS_SUBMIT_URL, {
          method: "POST", redirect: "error",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload), signal: controller.signal,
        });
        // Bound the actual response body, including chunked responses.
        let body: unknown;
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let bytes = 0;
          let text = "";
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 8192) { await reader.cancel(); return false; }
              text += decoder.decode(chunk.value, { stream: true });
            }
            body = JSON.parse(text + decoder.decode());
          } finally { reader.releaseLock(); }
        } else {
          body = await response.json();
        }
        return response.ok && typeof body === "object" && body !== null
          && "success" in body && body.success === true;
      })(), expired,
    ]);
    return accepted ? { ok: true } : { ok: false, message: CONTACT_SUBMIT_ERROR };
  } catch {
    return { ok: false, message: CONTACT_SUBMIT_ERROR };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
