// VENDORED — 由业务仓 live-assistant-lite 的 src/platform/hostIdentityHttp.ts 原样复制，仅改写相对导入。
// 业务仓提交：见 docs/BRIDGE_INTEGRATION.md。上游/本仓许可：MIT（保留原版权声明）。
// 不要在这里单独改逻辑：改动请回到业务仓，再重新 vendor。
/** Embeddable authenticated transport; creates no listener, browser or platform session. */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHostIdentityRequest, type HostIdentityBoundary } from "./hostIdentity";

export function createHostIdentityHandler(host: HostIdentityBoundary, options: {
  token: string; allowedOrigins?: string[]; maxBodyBytes?: number; timeoutMs?: number;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  if (options.token.length < 32 || /[\r\n]/.test(options.token)) throw new Error("host_auth_token_invalid");
  const expected = Buffer.from(`Bearer ${options.token}`);
  const limit = options.maxBodyBytes ?? 16_384;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 65_536 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw new Error("host_transport_limits_invalid");
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!["/identity", "/reply", "/product/show", "/users/block", "/users/unblock"].includes(url.pathname)
      && !url.pathname.startsWith("/actions/") && !url.pathname.startsWith("/private/")) return false;
    const send = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const actual = Buffer.from(req.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      send(401, { error_code: "host_unauthorized" }); return true;
    }
    if (req.headers.origin !== undefined && !options.allowedOrigins?.includes(req.headers.origin)) {
      send(403, { error_code: "host_origin_denied" }); return true;
    }
    if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
      send(415, { error_code: "host_encoding_unsupported" }); return true;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    const timer = setTimeout(() => { controller.abort(); send(504, { error_code: "host_request_timeout" }); }, timeoutMs);
    const onAbort = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("host_request_cancelled")), { once: true }));
    const work = async () => {
      let body: unknown;
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) { send(415, { error_code: "host_json_required" }); return; }
        if (Number(req.headers["content-length"] ?? 0) > limit) { send(413, { error_code: "host_body_too_large" }); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          if (controller.signal.aborted) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > limit) { send(413, { error_code: "host_body_too_large" }); return; }
          chunks.push(bytes);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { send(400, { error_code: "host_json_invalid" }); return; }
      }
      if (controller.signal.aborted) return;
      const result = await handleHostIdentityRequest(host, req.method ?? "", url, body, controller.signal);
      if (!controller.signal.aborted) send(result?.status ?? 404, result?.body ?? { error_code: "host_route_not_found" });
    };
    try { await Promise.race([work(), onAbort]); }
    catch { if (!controller.signal.aborted) send(500, { error_code: "host_transport_failed" }); }
    finally { clearTimeout(timer); req.off("aborted", cancel); res.off("close", cancel); }
    return true;
  };
}
