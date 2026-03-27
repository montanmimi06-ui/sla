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
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB
  },
});

let firebaseReady = false;
let cloudinaryReady = false;

/* ===========================
   🔥 FIREBASE INIT
=========================== */
try {
  if (!process.env.FIREBASE_KEY) {
    throw new Error("FIREBASE_KEY não definida no ambiente");
  }

  const raw = JSON.parse(process.env.FIREBASE_KEY);

  const serviceAccount = {
    ...raw,
    private_key: raw.private_key.replace(/\\n/g, "\n"),
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  firebaseReady = true;
  console.log("🔥 Firebase inicializado");
} catch (e) {
  console.error("❌ Firebase erro:", e.message);
}

/* ===========================
   ☁️ CLOUDINARY INIT
=========================== */
try {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    throw new Error("Credenciais Cloudinary ausentes");
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  cloudinaryReady = true;
  console.log("☁️ Cloudinary inicializada");
} catch (e) {
  console.error("❌ Cloudinary erro:", e.message);
}

/* ===========================
   🩺 HEALTH CHECK
=========================== */
app.get("/health", (req, res) => {
  res.json({
    server: "ok",
    firebaseReady,
    cloudinaryReady,
  });
});

/* ===========================
   🔔 PUSH NOTIFICATION
=========================== */
app.post("/send", async (req, res) => {
  try {
    if (!firebaseReady) {
      return res.status(500).json({ erro: "Firebase não inicializado" });
    }

    const { token, data, title, body } = req.body;

    if (!token) {
      return res.status(400).json({ erro: "Token ausente" });
    }

    const payload = {
      token,
      notification: {
        title: title || "Nova notificação 💌",
        body: body || "Você recebeu algo",
      },
      data: {},
    };

    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        payload.data[k] = String(v);
      }
    }

    const response = await admin.messaging().send(payload);

    return res.json({ ok: true, response });
  } catch (err) {
    console.error("❌ ERRO PUSH:", err.message);

    return res.status(500).json({
      erro: "Erro ao enviar",
      detalhes: err.message,
    });
  }
});

/* ===========================
   🎙️ UPLOAD AUDIO (STUDIO)
=========================== */
app.post("/upload-audio", upload.single("audio"), async (req, res) => {
  let tempFile = null;

  try {
    if (!cloudinaryReady) {
      return res.status(500).json({
        erro: "Cloudinary não inicializada",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        erro: "Arquivo não enviado",
      });
    }

    tempFile = req.file.path;

    console.log("🎙️ Arquivo recebido:", {
      name: req.file.originalname,
      size: req.file.size,
    });

    const ext =
      path.extname(req.file.originalname || "").replace(".", "") || "m4a";

    const result = await cloudinary.uploader.upload(tempFile, {
      resource_type: "video", // áudio entra como video
      folder: "studio_audio",
      public_id: "current_audio", // SEMPRE SOBRESCREVE
      overwrite: true,
      invalidate: true,
      format: ext,
    });

    console.log("☁️ Upload OK:", result.secure_url);

    return res.json({
      ok: true,
      audioUrl: result.secure_url,
      durationSec: result.duration || null,
      bytes: result.bytes,
      format: result.format,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error("❌ ERRO UPLOAD:", err.message);

    return res.status(500).json({
      erro: "Erro upload",
      detalhes: err.message,
    });
  } finally {
    if (tempFile) {
      fs.unlink(tempFile, () => {});
    }
  }
});

/* ===========================
   🚀 START SERVER
=========================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});
