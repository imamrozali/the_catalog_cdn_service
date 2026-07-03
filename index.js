import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import crypto from "crypto";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "4001", 10);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "uploads"));
const CDN_PREFIX = process.env.CDN_PREFIX || "/cdn";
const CDN_API_KEY = process.env.CDN_API_KEY;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || "10485760", 10);
const MAX_FILES = 10;
// Rate limiter (in-memory)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 30;

function rateLimit(req) {
  const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetIn: RATE_LIMIT_WINDOW - (now - entry.windowStart) };
  }
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

// Periodic cleanup of rate limit map
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 60_000);

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));
app.use(cors({
  origin: ["https://reevantstore.com", "http://localhost:3000"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));
app.use(express.json({ limit: "1mb" }));

// Ensure upload directory exists on startup
await fs.mkdir(UPLOAD_DIR, { recursive: true });

// --- Auth middleware ---
function authenticate(req, res, next) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth.slice(7);
  if (!token || token !== CDN_API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
}

// --- Validate filename (prevent path traversal) ---
function validateFilename(name) {
  if (!name || typeof name !== "string") return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return false;
  return true;
}

// --- Health check (no auth, no rate limit) ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// --- Upload ---
app.post("/upload", authenticate, async (req, res) => {
  const rl = rateLimit(req);
  if (!rl.allowed) {
    return res.status(429).json({
      error: "Too many requests",
      retryAfter: Math.ceil(rl.resetIn / 1000),
    });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return res.status(400).json({ error: "Expected multipart/form-data" });
    }

    const busboy = (await import("busboy")).default;
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES } });

    const type = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("type") || "products";

    const filePromises = [];
    let rejected = false;

    bb.on("file", (_fieldname, stream, info) => {
      if (rejected) return stream.resume();

      // Validate MIME type
      const allowed = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];
      if (!allowed.includes(info.mimeType)) {
        rejected = true;
        stream.resume();
        if (!res.headersSent) {
          res.status(400).json({ error: `Unsupported file type: ${info.mimeType}` });
        }
        return;
      }

      const p = new Promise((resolve) => {
        const chunks = [];
        let totalSize = 0;

        stream.on("data", (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_FILE_SIZE) {
            rejected = true;
            stream.resume();
            if (!res.headersSent) {
              res.status(400).json({ error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` });
            }
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });

        stream.on("end", async () => {
          if (rejected) { resolve(null); return; }
          try {
            const filename = `${crypto.randomUUID()}.webp`;
            const buffer = Buffer.concat(chunks);

            const img = sharp(buffer).rotate();
            if (type === "payment") {
              img.resize(1200, 1600, { fit: "inside", withoutEnlargement: true });
            } else {
              img.resize(800, 800, { fit: "inside", withoutEnlargement: true });
            }
            const outputBuffer = await img.webp({ quality: 80 }).toBuffer();

            const filePath = path.join(UPLOAD_DIR, filename);
            await fs.writeFile(filePath, outputBuffer);
            resolve(`${CDN_PREFIX}/${filename}`);
          } catch (err) {
            console.error("Process file error:", err);
            resolve(null);
          }
        });
      });

      filePromises.push(p);
    });

    bb.on("filesLimit", () => {
      rejected = true;
      if (!res.headersSent) {
        res.status(400).json({ error: `Maximum ${MAX_FILES} files allowed` });
      }
    });

    bb.on("finish", async () => {
      if (res.headersSent) return;
      const urls = (await Promise.all(filePromises)).filter(Boolean);
      if (urls.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }
      res.json({ urls });
    });

    req.pipe(bb);
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// --- Delete files ---
app.post("/delete", authenticate, async (req, res) => {
  const rl = rateLimit(req);
  if (!rl.allowed) {
    return res.status(429).json({
      error: "Too many requests",
      retryAfter: Math.ceil(rl.resetIn / 1000),
    });
  }

  try {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "urls array is required" });
    }

    if (urls.length > 50) {
      return res.status(400).json({ error: "Maximum 50 files per request" });
    }

    const results = [];
    for (const url of urls) {
      const prefix = CDN_PREFIX + "/";
      const filename = url.startsWith(prefix) ? url.slice(prefix.length) : url.split("/").pop();

      if (!validateFilename(filename)) {
        results.push({ url, deleted: false, reason: "invalid_filename" });
        continue;
      }

      const filePath = path.join(UPLOAD_DIR, filename);

      // Ensure file is within upload directory (path traversal protection)
      if (!filePath.startsWith(UPLOAD_DIR)) {
        results.push({ url, deleted: false, reason: "invalid_path" });
        continue;
      }

      try {
        await fs.unlink(filePath);
        results.push({ url, deleted: true });
      } catch (err) {
        if (err.code === "ENOENT") {
          results.push({ url, deleted: false, reason: "not_found" });
        } else {
          results.push({ url, deleted: false, reason: err.message });
        }
      }
    }

    res.json({ results });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Delete failed" });
  }
});

// --- Serve static files ---
const staticOpts = {
  maxAge: "365d",
  immutable: true,
  dotfiles: "deny",
  index: false,
};
app.use(CDN_PREFIX, express.static(UPLOAD_DIR, staticOpts));
app.use("/uploads", express.static(UPLOAD_DIR, staticOpts));

// --- 404 handler ---
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`CDN server running on http://localhost:${PORT}`);
  console.log(`Upload directory: ${UPLOAD_DIR}`);
  console.log(`CORS: ${JSON.stringify(["https://reevantstore.com", "http://localhost:3000"])}`);
});
