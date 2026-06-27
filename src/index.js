import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "4001", 10);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads"));
const CDN_PREFIX = process.env.CDN_PREFIX || "/cdn";
const CDN_API_KEY = process.env.CDN_API_KEY || "porto-cdn-dev-key";
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || "10485760", 10);
const MAX_FILES = 10;

const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

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

// --- Health check ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// --- Upload ---
app.post("/upload", authenticate, async (req, res) => {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return res.status(400).json({ error: "Expected multipart/form-data" });
    }

    const busboy = (await import("busboy")).default;
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES } });

    const type = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("type") || "products";

    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    const filePromises = [];
    let rejected = false;

    bb.on("file", (_fieldname, stream) => {
      if (rejected) return stream.resume();

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
            const filename = `${uuidv4()}.webp`;
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
  try {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "urls array is required" });
    }

    const results = [];
    for (const url of urls) {
      const prefix = CDN_PREFIX + "/";
      const filename = url.startsWith(prefix) ? url.slice(prefix.length) : url.split("/").pop();
      const filePath = path.join(UPLOAD_DIR, filename);

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
const staticOpts = { maxAge: "365d", immutable: true };
app.use(CDN_PREFIX, express.static(UPLOAD_DIR, staticOpts));
// backward compat untuk path /uploads/ lama
app.use("/uploads", express.static(UPLOAD_DIR, staticOpts));

app.listen(PORT, () => {
  console.log(`CDN server running on http://localhost:${PORT}`);
  console.log(`Upload directory: ${UPLOAD_DIR}`);
});
