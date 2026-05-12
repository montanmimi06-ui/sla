const express = require("express");
const admin = require("firebase-admin");
const multer = require("multer");
const fs = require("fs");
const { v2: cloudinary } = require("cloudinary");

const app = express();

app.use(express.json({ limit: "1mb" }));

fs.mkdirSync("tmp", { recursive: true });

const upload = multer({
  dest: "tmp/",
  limits: { fileSize: 15 * 1024 * 1024 },
});

let firebaseReady = false;
let cloudinaryReady = false;
let db = null;

try {
  const raw = JSON.parse(process.env.FIREBASE_KEY);

  admin.initializeApp({
    credential: admin.credential.cert({
      ...raw,
      private_key: raw.private_key.replace(/\\n/g, "\n"),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });

  db = admin.database();
  firebaseReady = true;

  console.log("🔥 Firebase OK");
} catch (e) {
  console.error("❌ Firebase erro:", e.message);
}

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

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    firebaseReady,
    cloudinaryReady,
  });
});

function requireFirebase(res) {
  if (!firebaseReady || !db) {
    res.status(500).json({
      erro: "Firebase não inicializado.",
    });
    return false;
  }

  return true;
}

async function verifyAuth(req, res, next) {
  try {
    if (!requireFirebase(res)) return;

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        erro: "Token ausente.",
      });
    }

    const idToken = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.uid = decoded.uid;
    next();
  } catch (e) {
    return res.status(401).json({
      erro: "Token inválido.",
    });
  }
}

function verifyAdminSecret(req, res, next) {
  const secret = req.headers["x-admin-secret"];

  if (!process.env.ADMIN_UPDATE_SECRET) {
    return res.status(500).json({
      erro: "ADMIN_UPDATE_SECRET não configurado no servidor.",
    });
  }

  if (secret !== process.env.ADMIN_UPDATE_SECRET) {
    return res.status(403).json({
      erro: "Acesso administrativo negado.",
    });
  }

  next();
}

function randomPairId() {
  return `pair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function randomLetterId() {
  return `letter_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateInviteCode(size = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";

  for (let i = 0; i < size; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

async function createUniqueInviteCode() {
  while (true) {
    const code = generateInviteCode(6);
    const snap = await db.ref(`pairInvites/${code}`).get();

    if (!snap.exists()) return code;
  }
}

async function getUserRecord(uid) {
  const snap = await db.ref(`users/${uid}`).get();

  if (!snap.exists()) return null;

  return snap.val();
}

async function getPairRecord(pairId) {
  const snap = await db.ref(`pairs/${pairId}`).get();

  if (!snap.exists()) return null;

  return snap.val();
}

function buildMergedUser(existingUser = {}, patch = {}, now = Date.now()) {
  return {
    ...existingUser,
    ...patch,
    createdAt: existingUser.createdAt ?? now,
    lastSeen: now,
    status: "active",
  };
}

function safeString(value, max = 1000) {
  return String(value || "").trim().slice(0, max);
}

async function sendPushToToken({
  token,
  title,
  body,
  data = {},
  channelId = "spotlove_alerts",
}) {
  if (!token) return null;

  const cleanData = Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)])
  );

  const msg = {
    token,
    notification: {
      title,
      body,
    },
    data: cleanData,
    android: {
      priority: "high",
      notification: {
        channelId,
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
        sound: "default",
      },
    },
  };

  return admin.messaging().send(msg);
}

async function resolveIdentity(uid) {
  const user = await getUserRecord(uid);

  if (!user || !user.pairId || !user.role || !user.boundDeviceId) {
    throw new Error("Usuário sem identidade vinculada.");
  }

  return user;
}

function resolvePartnerUid(user, pair) {
  if (!user || !pair?.members) return null;

  return user.role === "A" ? pair.members.B : pair.members.A;
}

function validateLetterPayload({ type, style, intensity, text }) {
  const allowedTypes = ["saudade", "promessa", "boa_noite", "surpresa"];

  const allowedStyles = [
    "rose_letter",
    "purple_night",
    "blue_envelope",
    "secret_glow",
  ];

  const allowedIntensities = ["suave", "profunda", "secreta"];

  const cleanText = safeString(text, 800);

  if (!cleanText) {
    return {
      ok: false,
      erro: "Texto da carta obrigatório.",
    };
  }

  if (cleanText.length > 800) {
    return {
      ok: false,
      erro: "A carta deve ter no máximo 800 caracteres.",
    };
  }

  return {
    ok: true,
    type: allowedTypes.includes(type) ? type : "saudade",
    style: allowedStyles.includes(style) ? style : "rose_letter",
    intensity: allowedIntensities.includes(intensity) ? intensity : "suave",
    text: cleanText,
  };
}

function letterPushTitle(type) {
  switch (type) {
    case "promessa":
      return "Uma promessa apareceu";
    case "boa_noite":
      return "Uma carta de boa noite chegou";
    case "surpresa":
      return "Tem uma surpresa no espaço de vocês";
    case "saudade":
    default:
      return "Uma carta de saudade chegou";
  }
}

function letterPushBody(intensity) {
  switch (intensity) {
    case "profunda":
      return "Ela veio com algo que precisava chegar.";
    case "secreta":
      return "Só o seu lado pode abrir.";
    case "suave":
    default:
      return "O espaço de vocês acendeu.";
  }
}

/**
 * ADMIN — PUBLICAR NOVA VERSÃO DO APP
 */
app.post("/admin/app-version", verifyAdminSecret, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const {
      latestVersion,
      minRequiredVersion,
      updateUrl,
      title,
      message,
      forceUpdate,
    } = req.body || {};

    if (!latestVersion || typeof latestVersion !== "string") {
      return res.status(400).json({
        erro: "latestVersion obrigatório.",
      });
    }

    if (!updateUrl || typeof updateUrl !== "string") {
      return res.status(400).json({
        erro: "updateUrl obrigatório.",
      });
    }

    const payload = {
      latestVersion: latestVersion.trim(),
      minRequiredVersion:
        typeof minRequiredVersion === "string" && minRequiredVersion.trim()
          ? minRequiredVersion.trim()
          : "1.0.0",
      updateUrl: updateUrl.trim(),
      title:
        typeof title === "string" && title.trim()
          ? title.trim()
          : "Nova versão disponível 💗",
      message:
        typeof message === "string" && message.trim()
          ? message.trim()
          : "Tem uma atualização nova do SpotLove disponível.",
      forceUpdate: forceUpdate === true,
      updatedAt: new Date().toISOString(),
    };

    await db.ref("appConfig/android").update(payload);

    return res.json({
      ok: true,
      appConfig: payload,
    });
  } catch (e) {
    console.error("❌ admin/app-version:", e.message);

    return res.status(500).json({
      erro: e.message,
    });
  }
});

/**
 * CRIAR VÍNCULO
 */
app.post("/pair/create", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { deviceId } = req.body || {};

    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({
        erro: "deviceId obrigatório.",
      });
    }

    const existingUser = await getUserRecord(uid);

    if (
      existingUser?.pairId &&
      existingUser?.role &&
      existingUser?.boundDeviceId
    ) {
      if (existingUser.boundDeviceId !== deviceId) {
        return res.status(409).json({
          erro: "Esta conta já está vinculada a outro aparelho.",
        });
      }

      const pair = await getPairRecord(existingUser.pairId);

      return res.json({
        ok: true,
        reused: true,
        pairId: existingUser.pairId,
        role: existingUser.role,
        inviteCode: pair?.inviteCode || null,
      });
    }

    const pairId = randomPairId();
    const inviteCode = await createUniqueInviteCode();
    const now = Date.now();

    const mergedUser = buildMergedUser(
      existingUser,
      {
        pairId,
        role: "A",
        boundDeviceId: deviceId,
      },
      now
    );

    const updates = {};

    updates[`users/${uid}`] = mergedUser;

    updates[`pairs/${pairId}`] = {
      createdAt: now,
      status: "active",
      inviteCode,
      members: {
        A: uid,
      },
    };

    updates[`pairInvites/${inviteCode}`] = {
      pairId,
      createdBy: uid,
      roleForCreator: "A",
      status: "pending",
      createdAt: now,
    };

    await db.ref().update(updates);

    return res.json({
      ok: true,
      pairId,
      role: "A",
      inviteCode,
    });
  } catch (e) {
    console.error("❌ pair/create:", e.message);

    return res.status(500).json({
      erro: e.message,
    });
  }
});

/**
 * ENTRAR NO VÍNCULO
 */
app.post("/pair/join", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { deviceId, code } = req.body || {};

    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({
        erro: "deviceId obrigatório.",
      });
    }

    const normalizedCode = String(code || "").trim().toUpperCase();

    if (!normalizedCode) {
      return res.status(400).json({
        erro: "Código obrigatório.",
      });
    }

    const existingUser = await getUserRecord(uid);

    if (
      existingUser?.pairId &&
      existingUser?.role &&
      existingUser?.boundDeviceId
    ) {
      if (existingUser.boundDeviceId !== deviceId) {
        return res.status(409).json({
          erro: "Esta conta já está vinculada a outro aparelho.",
        });
      }

      return res.status(409).json({
        erro: "Este usuário já está vinculado a um par.",
      });
    }

    const inviteSnap = await db.ref(`pairInvites/${normalizedCode}`).get();

    if (!inviteSnap.exists()) {
      return res.status(404).json({
        erro: "Código não encontrado.",
      });
    }

    const invite = inviteSnap.val();

    if (invite.status !== "pending") {
      return res.status(409).json({
        erro: "Esse código não está mais disponível.",
      });
    }

    const pairId = invite.pairId;
    const pair = await getPairRecord(pairId);

    if (!pair || !pair.members || !pair.members.A) {
      return res.status(400).json({
        erro: "Vínculo inválido.",
      });
    }

    if (pair.members.B) {
      return res.status(409).json({
        erro: "Esse vínculo já está completo.",
      });
    }

    if (pair.members.A === uid) {
      return res.status(409).json({
        erro: "Você não pode entrar no próprio código.",
      });
    }

    const now = Date.now();

    const mergedUser = buildMergedUser(
      existingUser,
      {
        pairId,
        role: "B",
        boundDeviceId: deviceId,
      },
      now
    );

    const updates = {};

    updates[`users/${uid}`] = mergedUser;
    updates[`pairs/${pairId}/members/B`] = uid;
    updates[`pairInvites/${normalizedCode}/status`] = "used";
    updates[`pairInvites/${normalizedCode}/usedBy`] = uid;
    updates[`pairInvites/${normalizedCode}/usedAt`] = now;

    await db.ref().update(updates);

    return res.json({
      ok: true,
      pairId,
      role: "B",
      inviteCode: normalizedCode,
    });
  } catch (e) {
    console.error("❌ pair/join:", e.message);

    return res.status(500).json({
      erro: e.message,
    });
  }
});

/**
 * SAUDADE
 */
app.post("/send-miss", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { pairId, location } = req.body || {};

    if (!pairId) {
      return res.status(400).json({
        erro: "pairId obrigatório.",
      });
    }

    const user = await resolveIdentity(uid);

    if (user.pairId !== pairId) {
      return res.status(403).json({
        erro: "Acesso negado a esse vínculo.",
      });
    }

    const pair = await getPairRecord(pairId);

    if (!pair?.members) {
      return res.status(400).json({
        erro: "Vínculo inválido.",
      });
    }

    const partnerUid = resolvePartnerUid(user, pair);

    if (!partnerUid) {
      return res.status(409).json({
        erro: "A outra pessoa ainda não entrou no vínculo.",
      });
    }

    const partner = await getUserRecord(partnerUid);

    let safeLocation = null;

    if (user.role === "B" && location && typeof location === "object") {
      const lat = Number(location.latitude);
      const lng = Number(location.longitude);
      const accuracy =
        location.accuracy != null ? Number(location.accuracy) : null;

      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        safeLocation = {
          latitude: lat,
          longitude: lng,
          accuracy: Number.isFinite(accuracy) ? accuracy : null,
        };
      }
    }

    const payload = {
      type: "miss",
      pairId,
      senderId: uid,
      senderRole: user.role,
      time: new Date().toISOString(),
      hasLocation: !!safeLocation,
      location: safeLocation,
    };

    await db.ref(`pairs/${pairId}/connection/lastMiss`).set(payload);

    if (!partner?.fcmToken) {
      return res.status(409).json({
        erro: "A outra pessoa ainda não registrou notificações neste aparelho.",
      });
    }

    const pushId = await sendPushToToken({
      token: partner.fcmToken,
      title: "Sinto saudades 💗",
      body:
        user.role === "B" && safeLocation
          ? "A saudade chegou com localização."
          : "Alguém apertou o botão da saudade.",
      channelId: "spotlove_alerts",
      data: {
        type: payload.type,
        pairId: payload.pairId,
        senderId: payload.senderId,
        senderRole: payload.senderRole,
        time: payload.time,
        hasLocation: payload.hasLocation ? "true" : "false",
        latitude:
          safeLocation && safeLocation.latitude != null
            ? String(safeLocation.latitude)
            : "",
        longitude:
          safeLocation && safeLocation.longitude != null
            ? String(safeLocation.longitude)
            : "",
        accuracy:
          safeLocation && safeLocation.accuracy != null
            ? String(safeLocation.accuracy)
            : "",
      },
    });

    return res.json({
      ok: true,
      hasLocation: !!safeLocation,
      pushId,
    });
  } catch (e) {
    console.error("❌ send-miss:", e.message);

    return res.status(500).json({
      erro: e.message,
    });
  }
});

/**
 * CARTA VIVA
 */
app.post("/send-letter", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { pairId, type, style, intensity, text } = req.body || {};

    if (!pairId || typeof pairId !== "string") {
      return res.status(400).json({
        erro: "pairId obrigatório.",
      });
    }

    const validation = validateLetterPayload({
      type,
      style,
      intensity,
      text,
    });

    if (!validation.ok) {
      return res.status(400).json({
        erro: validation.erro,
      });
    }

    const user = await resolveIdentity(uid);

    if (user.pairId !== pairId) {
      return res.status(403).json({
        erro: "Acesso negado a esse vínculo.",
      });
    }

    const pair = await getPairRecord(pairId);

    if (!pair?.members) {
      return res.status(400).json({
        erro: "Vínculo inválido.",
      });
    }

    const partnerUid = resolvePartnerUid(user, pair);

    if (!partnerUid) {
      return res.status(409).json({
        erro: "A outra pessoa ainda não entrou no vínculo.",
      });
    }

    const partner = await getUserRecord(partnerUid);

    const nowIso = new Date().toISOString();

    const letterPayload = {
      id: randomLetterId(),
      type: validation.type,
      style: validation.style,
      intensity: validation.intensity,
      text: validation.text,
      pairId,
      senderId: uid,
      senderRole: user.role,
      createdAt: nowIso,
      openedByPartner: false,
      openedAt: null,
      openedBy: null,
    };

    await db.ref(`pairs/${pairId}/letters/current`).set(letterPayload);

    let pushId = null;

    if (partner?.fcmToken) {
      pushId = await sendPushToToken({
        token: partner.fcmToken,
        title: letterPushTitle(validation.type),
        body: letterPushBody(validation.intensity),
        channelId: "spotlove_alerts",
        data: {
          type: "letter",
          pairId,
          senderId: uid,
          senderRole: user.role,
          letterId: letterPayload.id,
          letterType: validation.type,
          style: validation.style,
          intensity: validation.intensity,
          time: nowIso,
        },
      });
    }

    return res.json({
      ok: true,
      letter: letterPayload,
      pushId,
    });
  } catch (e) {
    console.error("❌ send-letter:", e.message);

    return res.status(500).json({
      erro: e.message,
    });
  }
});

/**
 * ABRIR CARTA
 */
app.post("/open-letter", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { pairId, letterId } = req.body || {};

    if (!pairId || typeof pairId !== "string") {
      return res.status(400).json({
        erro: "pairId obrigatório.",
      });
    }

    const user = await resolveIdentity(uid);

    if (user.pairId !== pairId) {
      return res.status(403).json({
        erro: "Acesso negado a esse vínculo.",
      });
    }

    const pair = await getPairRecord(pairId);

    if (!pair?.members) {
      return res.status(400).json({
        erro: "Vínculo inválido.",
      });
    }

    const letterSnap = await db.ref(`pairs/${pairId}/letters/current`).get();

    if (!letterSnap.exists()) {
      return res.status(404).json({
        erro: "Nenhuma carta ativa encontrada.",
      });
    }

    const letter = letterSnap.val();

    if (letterId && letter.id !== letterId) {
      return res.status(409).json({
        erro: "Essa carta não é mais a carta atual.",
      });
    }

    if (letter.senderId === uid) {
      return res.status(403).json({
        erro: "O remetente não pode abrir a própria carta como parceiro.",
      });
    }

    const nowIso = new Date().toISOString();

    await db.ref(`pairs/${pairId}/letters/current`).update({
      openedByPartner: true,
      openedAt: nowIso,
      openedBy: uid,
    });

    return res.json({
      ok: true,
      openedAt: nowIso,
    });
  } catch (e) {
    console.error("❌ open-letter:", e.message);

    return res.status(500).json({
      erro: e.message,
    });
  }
});

/**
 * PUSH MANUAL DE TESTE
 */
app.post("/send", verifyAuth, async (req, res) => {
  try {
    const { token, title, body, data } = req.body || {};

    const r = await sendPushToToken({
      token,
      title: title || "Novo aviso 💗",
      body: body || "Tem algo novo",
      channelId: "spotlove_alerts",
      data: data || {},
    });

    return res.json({
      ok: true,
      r,
    });
  } catch (e) {
    return res.status(500).json({
      erro: e.message,
    });
  }
});

/**
 * UPLOAD DO ÁUDIO DO STUDIO
 */
app.post("/upload-audio", verifyAuth, upload.single("audio"), async (req, res) => {
  let tempFile = null;

  try {
    if (!cloudinaryReady) {
      return res.status(500).json({
        erro: "Cloudinary não inicializado.",
      });
    }

    const uid = req.uid;
    const { pairId } = req.body || {};

    if (!req.file) {
      return res.status(400).json({
        erro: "Sem arquivo.",
      });
    }

    if (!pairId) {
      return res.status(400).json({
        erro: "pairId obrigatório.",
      });
    }

    tempFile = req.file.path;

    const user = await resolveIdentity(uid);

    if (user.pairId !== pairId) {
      return res.status(403).json({
        erro: "Acesso negado a esse vínculo.",
      });
    }

    const pair = await getPairRecord(pairId);

    if (!pair?.members) {
      return res.status(400).json({
        erro: "Vínculo inválido.",
      });
    }

    const partnerUid = resolvePartnerUid(user, pair);
    const partner = partnerUid ? await getUserRecord(partnerUid) : null;

    const result = await cloudinary.uploader.upload(tempFile, {
      resource_type: "auto",
      folder: `studio_audio/${pairId}`,
      public_id: "current_audio",
      overwrite: true,
      invalidate: true,
      format: "mp3",
      audio_codec: "mp3",
      quality: "auto",
    });

    const finalUrl = result.secure_url + "?v=" + Date.now();
    const nowIso = new Date().toISOString();

    await db.ref(`pairs/${pairId}/studio/current`).set({
      url: finalUrl,
      senderId: uid,
      senderRole: user.role,
      time: nowIso,
    });

    await db.ref(`pairs/${pairId}/studio/recording`).remove();

    if (partner?.fcmToken) {
      await sendPushToToken({
        token: partner.fcmToken,
        title: "Novo áudio 🎤",
        body: "Tem algo novo no estúdio.",
        channelId: "spotlove_alerts",
        data: {
          type: "studio_audio",
          pairId,
          senderId: uid,
          senderRole: user.role,
          time: nowIso,
          url: finalUrl,
        },
      });
    }

    return res.json({
      ok: true,
      audioUrl: finalUrl,
    });
  } catch (e) {
    console.error("❌ upload erro:", e.message);

    return res.status(500).json({
      erro: e.message,
    });
  } finally {
    if (tempFile) {
      fs.unlink(tempFile, () => {});
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 server rodando");
});
