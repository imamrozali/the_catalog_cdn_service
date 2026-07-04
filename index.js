
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
import Busboy from "busboy";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const PORT = Number(process.env.PORT || 4001);

const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, "uploads")
);

const TEMP_DIR = path.join(os.tmpdir(), "cdn-temp");

const CDN_PREFIX = process.env.CDN_PREFIX || "/cdn";

const CDN_API_KEY = process.env.CDN_API_KEY;

const MAX_FILE_SIZE = Number(
  process.env.MAX_FILE_SIZE || 10 * 1024 * 1024
);

const MAX_FILES = 10;

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
};

const ALLOWED_MIME = new Set(Object.keys(MIME_EXT));

// ======================
// Logger
// ======================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, msg, ...args) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (level === "error" || level === "warn") {
    console.error(prefix, msg, ...args);
  } else {
    console.log(prefix, msg, ...args);
  }
}

const logger = {
  debug: (msg, ...args) => log("debug", msg, ...args),
  info: (msg, ...args) => log("info", msg, ...args),
  warn: (msg, ...args) => log("warn", msg, ...args),
  error: (msg, ...args) => log("error", msg, ...args),
};

logger.info("Starting CDN service", { port: PORT, uploadDir: UPLOAD_DIR, logLevel: process.env.LOG_LEVEL || "info" });

// ======================
// Trust Proxy
// ======================

app.set("trust proxy", true);

app.disable("x-powered-by");

// ======================
// Middleware
// ======================

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
    contentSecurityPolicy: false,
  })
);

app.use(
  cors({
    origin: [
      "https://reevantstore.com",
      "https://www.reevantstore.com",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST", "DELETE"],
    maxAge: 86400,
  })
);

app.use(express.json({ limit: "1mb" }));

// ======================
// Ensure Directory (synchronous mkdir to avoid top-level await)
// ======================

import { mkdirSync } from "fs";

mkdirSync(UPLOAD_DIR, { recursive: true });

mkdirSync(TEMP_DIR, { recursive: true });

// ======================
// Simple Rate Limit
// ======================

const requests = new Map();

const WINDOW = 60_000;

const LIMIT = 30;

function rateLimit(req, res, next) {
  const ip =
    req.ip ||
    req.headers["x-forwarded-for"] ||
    "unknown";

  const now = Date.now();

  let data = requests.get(ip);

  if (!data || now - data.start > WINDOW) {
    data = {
      start: now,
      count: 0,
    };
  }

  data.count++;

  requests.set(ip, data);

  if (data.count > LIMIT) {
    return res.status(429).json({
      error: "Too many requests",
    });
  }

  next();
}

// Cleanup
setInterval(() => {
  const now = Date.now();

  for (const [ip, data] of requests) {
    if (now - data.start > WINDOW * 2) {
      requests.delete(ip);
    }
  }
}, 60_000);

// ======================
// Auth
// ======================

function authenticate(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  const token = auth.slice(7);

  if (token !== CDN_API_KEY) {
    return res.status(401).json({
      error: "Invalid API key",
    });
  }

  next();
}

// ======================
// Health
// ======================

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// ======================
// Upload
// ======================

app.post(
  "/upload",
  authenticate,
  rateLimit,
  async (req, res) => {
    const contentType =
      req.headers["content-type"] || "";

    if (!contentType.includes("multipart/form-data")) {
      return res.status(400).json({
        error: "multipart/form-data required",
      });
    }

    const bb = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_FILE_SIZE,
        files: MAX_FILES,
      },
    });

    const uploaded = [];

    let hasError = false;

    const jobs = [];

    bb.on("file", (_name, file, info) => {
      if (hasError) {
        file.resume();
        return;
      }

      if (!ALLOWED_MIME.has(info.mimeType)) {
        hasError = true;

        file.resume();

        return res.status(400).json({
          error: `Unsupported file: ${info.mimeType}`,
        });
      }

      const tempName = crypto.randomUUID();

      const tempPath = path.join(
        TEMP_DIR,
        `${tempName}.tmp`
      );

      const tempWrite = createWriteStream(tempPath);

      file.pipe(tempWrite);

      const job = new Promise((resolve) => {
        tempWrite.on("finish", async () => {
          try {
            const ext = MIME_EXT[info.mimeType] || ".bin";
            const filename = `${crypto.randomUUID()}${ext}`;
            const outputPath = path.join(UPLOAD_DIR, filename);

            await fs.rename(tempPath, outputPath);

            uploaded.push(`${CDN_PREFIX}/${filename}`);
            resolve();
          } catch (err) {
            logger.error("File save failed:", err.message, { tempPath });
            await fs.unlink(tempPath).catch(() => {});
            resolve();
          }
        });
      });

      jobs.push(job);
    });

    bb.on("filesLimit", () => {
      hasError = true;

      return res.status(400).json({
        error: `Maximum ${MAX_FILES} files`,
      });
    });

    bb.on("finish", async () => {
      if (hasError || res.headersSent) return;

      await Promise.all(jobs);

      if (!uploaded.length) {
        return res.status(400).json({
          error: "No uploaded files",
        });
      }

      return res.json({ urls: uploaded });
    });

    bb.on("error", (err) => {
      logger.error("Busboy error:", err.message);

      if (!res.headersSent) {
        return res.status(500).json({
          error: "Upload failed",
        });
      }
    });

    req.pipe(bb);
  }
);

// ======================
// Delete
// ======================

app.post(
  "/delete",
  authenticate,
  rateLimit,
  async (req, res) => {
    try {
      const { urls } = req.body;

      if (!Array.isArray(urls)) {
        return res.status(400).json({
          error: "urls array required",
        });
      }

      const results = [];

      for (const url of urls) {
        const filename = path.basename(url);

        // Prevent path traversal
        if (!filename || filename.includes("..")) {
          results.push({ file: url, deleted: false, reason: "invalid" });
          continue;
        }

        const filePath = path.join(UPLOAD_DIR, filename);

        if (!filePath.startsWith(UPLOAD_DIR)) {
          results.push({ file: url, deleted: false, reason: "invalid" });
          continue;
        }

        try {
          await fs.unlink(filePath);
          results.push({ file: url, deleted: true });
        } catch (err) {
          results.push({
            file: url,
            deleted: false,
            reason: err.code === "ENOENT" ? "not_found" : "error",
          });
        }
      }

      res.json({ results });
    } catch (err) {
      logger.error("Delete endpoint error:", err.message);
      res.status(500).json({ error: "Delete failed" });
    }
  }
);

// ======================
// Root & Favicon
// ======================

app.get("/", (_req, res) => {
  res.json({ service: "Reevant Store CDN", status: "running" });
});

app.get("/favicon.ico", (_req, res) => res.status(204).end());

// ======================
// Static CDN
// ======================

app.use(
  CDN_PREFIX,
  express.static(UPLOAD_DIR, {
    immutable: true,
    maxAge: "365d",
    etag: true,
    index: false,
    dotfiles: "deny",
  })
);

// ======================
// 404
// ======================

app.use((_req, res) => {
  res.status(404).json({
    error: "Not found",
  });
});

// ======================
// Error
// ======================

app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err?.message || err, { stack: err?.stack });

  res.status(500).json({
    error: "Internal server error",
  });
});

// ======================
// Start
// ======================

app.listen(PORT, () => {
  logger.info(`CDN server listening on port ${PORT}`);
});

