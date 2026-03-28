const express = require("express");
const admin = require("firebase-admin");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { v2: cloudinary } = require("cloudinary");

const app = express();
app.use(express.json());

const upload = multer({
  dest: "tmp/",
  limits: { fileSize: 15 * 1024 * 1024 },
});

let firebaseReady = false;
let cloudinaryReady = false;

/* 🔥 FIREBASE */
try {
  const raw = JSON.parse(process.env.FIREBASE_KEY);

  admin.initializeApp({
    credential: admin.credential.cert({
      ...raw,
      private_key: raw.private_key.replace(/\\n/g, "\n"),
    }),
  });

  firebaseReady = true;
  console.log("🔥 Firebase OK");
} catch (e) {
  console.error("❌ Firebase erro:", e.message);
}

/* ☁️ CLOUDINARY */
try {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  cloudinaryReady = true;
  console.log("☁️ Cloudinary OK");
} catch (e) {
  console.error("❌ Cloudinary erro:", e.message);
}

/* 🩺 HEALTH */
app.get("/health", (_, res) => {
  res.json({ firebaseReady, cloudinaryReady });
});

/* 🔔 PUSH */
app.post("/send", async (req, res) => {
  try {
    const { token, title, body, data } = req.body;

    const msg = {
      token,
      notification: {
        title: title || "Novo áudio 🎤",
        body: body || "Tem algo novo",
      },
      data: Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, String(v)])
      ),
    };

    const r = await admin.messaging().send(msg);
    res.json({ ok: true, r });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* 🎤 UPLOAD */
app.post("/upload-audio", upload.single("audio"), async (req, res) => {
  let tempFile = null;

  try {
    if (!req.file) {
      return res.status(400).json({ erro: "Sem arquivo" });
    }

    tempFile = req.file.path;

    const result = await cloudinary.uploader.upload(tempFile, {
      resource_type: "auto",
      folder: "studio_audio",
      public_id: "current_audio",
      overwrite: true,
      invalidate: true,
      format: "mp3",
      audio_codec: "mp3",
      quality: "auto",
    });

    const finalUrl = result.secure_url + "?v=" + Date.now();

    return res.json({
      ok: true,
      audioUrl: finalUrl,
    });
  } catch (e) {
    console.error("❌ upload erro:", e.message);
    res.status(500).json({ erro: e.message });
  } finally {
    if (tempFile) fs.unlink(tempFile, () => {});
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 server rodando")
);
