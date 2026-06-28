import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".onnx": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function resolveFile(rootDir, pathname) {
  const root = path.resolve(rootDir);
  const decodedPath = decodeURIComponent(pathname || "/");
  const relativePath = decodedPath.replace(/^\/+/, "");
  let candidate = path.resolve(root, relativePath || ".");

  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  let stat = await fs.stat(candidate).catch(() => null);
  if (stat?.isDirectory()) {
    candidate = path.join(candidate, "index.html");
    stat = await fs.stat(candidate).catch(() => null);
  }

  if (!stat && (decodedPath === "/" || !relativePath)) {
    candidate = path.join(root, "index.html");
    stat = await fs.stat(candidate).catch(() => null);
  }

  return stat ? candidate : null;
}

export async function startStaticServer(rootDir, port, host = "127.0.0.1") {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad request");
        return;
      }

      const { pathname } = new URL(req.url, `http://${host}`);
      const filePath = await resolveFile(rootDir, pathname === "/" ? "/index.html" : pathname);

      if (!filePath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const body = await fs.readFile(filePath);
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": contentTypeFor(filePath),
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "Static server error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return server;
}

export async function stopStaticServer(server) {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve) => {
    server.close(resolve);
  });
}
