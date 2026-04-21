import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, statSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import type { Server } from "node:http";

const FILE_SERVER_PORT = 9877;

const ALLOWED_ROOTS = ["/home/coder", "/tmp"];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

function getMimeType(filepath: string): string {
  const ext = extname(filepath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const requestedPath = decodeURIComponent(url.pathname);

  if (!requestedPath || requestedPath === "/") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Prepend / if not already absolute
  const absolutePath = requestedPath.startsWith("/")
    ? requestedPath
    : `/${requestedPath}`;

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(absolutePath);
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Validate resolved path is under an allowed root
  const allowed = ALLOWED_ROOTS.some((root) =>
    resolvedPath === root || resolvedPath.startsWith(`${root}/`),
  );
  if (!allowed) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (stat.isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const mimeType = getMimeType(resolvedPath);

  res.writeHead(200, {
    "Content-Type": mimeType,
    "Content-Length": stat.size,
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = createReadStream(resolvedPath);
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  });
}

export function startFileServer(): Server {
  const server = createServer(handleRequest);
  server.listen(FILE_SERVER_PORT, "0.0.0.0", () => {
    console.log(`[agent] file server listening on port ${String(FILE_SERVER_PORT)}`);
  });
  return server;
}
