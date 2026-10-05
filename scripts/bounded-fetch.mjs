import { ExaError, classifyError, httpError } from "./errors.mjs";

export const MAX_SESSION_RESPONSE_BYTES = 8 * 1024 * 1024;
const OFFICIAL_EXA_URL = "https://mcp.exa.ai/mcp";

export function createBoundedExaFetch(onFailure, fetchImpl = globalThis.fetch) {
  const abortController = new AbortController();
  const readers = new Set();
  let consumed = 0;
  let failure;

  function stop(error) {
    if (!failure) {
      failure = error;
      abortController.abort(error);
      for (const reader of readers) void reader.cancel(error).catch(() => {});
      onFailure(error);
    }
    return failure;
  }
  function overLimit() {
    return stop(new ExaError("INPUT_LIMIT"));
  }
  const boundedFetch = async (input, init = {}) => {
    if (failure) throw failure;
    abortController.signal.throwIfAborted();
    const target = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (target !== OFFICIAL_EXA_URL || [...headers.keys()].some((name) =>
      ["authorization", "proxy-authorization", "cookie", "x-api-key"].includes(name))) {
      throw stop(new ExaError("CONFIG_ERROR"));
    }
    const signal = AbortSignal.any([abortController.signal, ...(init.signal ? [init.signal] : [])]);
    let response;
    try {
      response = await fetchImpl(input, {
        ...init,
        signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      if (failure || signal.aborted) throw failure ?? signal.reason;
      throw stop(classifyError(error, "NETWORK_ERROR"));
    }
    if (response.redirected || (response.url && response.url !== OFFICIAL_EXA_URL)) {
      void response.body?.cancel().catch(() => {});
      throw stop(new ExaError("PROTOCOL_ERROR"));
    }
    if (failure || signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw failure ?? signal.reason;
    }
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_SESSION_RESPONSE_BYTES - consumed) {
      void response.body?.cancel().catch(() => {});
      throw overLimit();
    }
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const ignoredStatus = response.status === 405 && ["GET", "DELETE"].includes(method.toUpperCase());
    const httpFailure = !response.ok && !ignoredStatus;
    if (!response.body) {
      if (httpFailure) throw stop(httpError(response.status, response.headers.get("retry-after")));
      return response;
    }

    // Fetch exposes decompressed bytes; count them before any SDK buffering or decoding.
    const reader = response.body.getReader();
    readers.add(reader);
    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (failure) throw failure;
          const { done, value } = await reader.read();
          if (failure) throw failure;
          if (done) {
            readers.delete(reader);
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!(value instanceof Uint8Array)) throw stop(new ExaError("PROTOCOL_ERROR"));
          if (value.byteLength > MAX_SESSION_RESPONSE_BYTES - consumed) throw overLimit();
          consumed += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          readers.delete(reader);
          void reader.cancel(error).catch(() => {});
          controller.error(failure ?? (signal.aborted ? error : stop(classifyError(error, "NETWORK_ERROR"))));
        }
      },
      async cancel(reason) {
        readers.delete(reader);
        await reader.cancel(reason).catch(() => {});
      },
    }, { highWaterMark: 0 });
    const boundedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    if (httpFailure) {
      // Count and discard errors without decoding or retaining the remote body.
      for await (const chunk of boundedResponse.body) void chunk;
      throw stop(httpError(response.status, response.headers.get("retry-after")));
    }
    return boundedResponse;
  };
  return {
    fetch: boundedFetch,
    get failure() { return failure; },
    assertHealthy() { if (failure) throw failure; },
    close() {
      abortController.abort();
      for (const reader of readers) void reader.cancel().catch(() => {});
      readers.clear();
    },
  };
}
