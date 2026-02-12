import http from "node:http";
import { URL } from "node:url";
import { loadServerEnv } from "../env.js";
import { logger } from "../logger.js";

function readAll(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function main() {
  const env = loadServerEnv();
  const ingressPort = Number(process.env.XENA_INGRESS_PORT ?? "9876");
  const internalBaseUrl = process.env.XENA_INTERNAL_BASE_URL ?? `http://127.0.0.1:${env.XENA_HTTP_PORT}`;
  const target = new URL(internalBaseUrl);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, target: internalBaseUrl }));
        return;
      }

      const body = await readAll(req);
      const upstreamPath = req.url ?? "/";

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v == null) continue;
        if (Array.isArray(v)) headers[k] = v.join(",");
        else headers[k] = v;
      }
      headers["host"] = target.host;
      if (body.length > 0) headers["content-length"] = String(body.length);

      const upReq = http.request(
        {
          method: req.method,
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: upstreamPath,
          headers,
        },
        (upRes) => {
          const outHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v == null) continue;
            if (Array.isArray(v)) outHeaders[k] = v.join(",");
            else outHeaders[k] = String(v);
          }
          res.writeHead(upRes.statusCode ?? 502, outHeaders);
          upRes.pipe(res);
        },
      );

      upReq.on("error", (err) => {
        logger.error({ err }, "Ingress upstream error");
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad gateway" }));
      });

      if (body.length > 0) upReq.write(body);
      upReq.end();
    } catch (err) {
      logger.error({ err }, "Ingress request failed");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });

  server.listen(ingressPort, "0.0.0.0", () => {
    logger.info({ ingressPort, internalBaseUrl }, "Ingress proxy listening");
  });
}

main().catch((err) => {
  logger.error({ err }, "Ingress failed");
  process.exitCode = 1;
});

