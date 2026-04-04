const express = require("express");
const admin = require("firebase-admin");
const multer = require("multer");
const fs = require("fs");
const { v2: cloudinary } = require("cloudinary");

const app = express();
app.use(express.json());

const upload = multer({
  dest: "tmp/",
  limits: { fileSize: 15 * 1024 * 1024 },
});

let firebaseReady = false;
let cloudinaryReady = false;

try {
  const raw = JSON.parse(process.env.FIREBASE_KEY);

  admin.initializeApp({
    credential: admin.credential.cert({
      ...raw,
      private_key: raw.private_key.replace(/\\n/g, "\n"),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });

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

const db = admin.database();

app.get("/health", (_, res) => {
  res.json({ firebaseReady, cloudinaryReady });
});

async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ erro: "Token ausente." });
    }

    const idToken = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.uid = decoded.uid;
    next();
  } catch (e) {
    return res.status(401).json({ erro: "Token inválido." });
  }
}

function randomPairId() {
  return `pair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

app.post("/pair/create", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { deviceId } = req.body || {};

    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({ erro: "deviceId obrigatório." });
    }

    const existingUser = await getUserRecord(uid);

    if (existingUser?.pairId && existingUser?.role && existingUser?.boundDeviceId) {
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
    return res.status(500).json({ erro: e.message });
  }
});

app.post("/pair/join", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { deviceId, code } = req.body || {};

    if (!deviceId || typeof deviceId !== "string") {
      return res.status(400).json({ erro: "deviceId obrigatório." });
    }

    const normalizedCode = String(code || "").trim().toUpperCase();
    if (!normalizedCode) {
      return res.status(400).json({ erro: "Código obrigatório." });
    }

    const existingUser = await getUserRecord(uid);

    if (existingUser?.pairId && existingUser?.role && existingUser?.boundDeviceId) {
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
      return res.status(404).json({ erro: "Código não encontrado." });
    }

    const invite = inviteSnap.val();

    if (invite.status !== "pending") {
      return res.status(409).json({ erro: "Esse código não está mais disponível." });
    }

    const pairId = invite.pairId;
    const pair = await getPairRecord(pairId);

    if (!pair || !pair.members || !pair.members.A) {
      return res.status(400).json({ erro: "Vínculo inválido." });
    }

    if (pair.members.B) {
      return res.status(409).json({ erro: "Esse vínculo já está completo." });
    }

    if (pair.members.A === uid) {
      return res.status(409).json({ erro: "Você não pode entrar no próprio código." });
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
    return res.status(500).json({ erro: e.message });
  }
});

app.post("/send-miss", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { pairId, location } = req.body || {};

    if (!pairId) {
      return res.status(400).json({ erro: "pairId obrigatório." });
    }

    const user = await resolveIdentity(uid);
    if (user.pairId !== pairId) {
      return res.status(403).json({ erro: "Acesso negado a esse vínculo." });
    }

    const pair = await getPairRecord(pairId);
    if (!pair?.members) {
      return res.status(400).json({ erro: "Vínculo inválido." });
    }

    const partnerUid = user.role === "A" ? pair.members.B : pair.members.A;
    if (!partnerUid) {
      return res.status(409).json({ erro: "A outra pessoa ainda não entrou no vínculo." });
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
    return res.status(500).json({ erro: e.message });
  }
});

app.post("/send", async (req, res) => {
  try {
    const { token, title, body, data } = req.body || {};

    const r = await sendPushToToken({
      token,
      title: title || "Novo áudio 🎤",
      body: body || "Tem algo novo",
      channelId: "spotlove_alerts",
      data: data || {},
    });

    res.json({ ok: true, r });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post("/upload-audio", verifyAuth, upload.single("audio"), async (req, res) => {
  let tempFile = null;

  try {
    const uid = req.uid;
    const { pairId } = req.body || {};

    if (!req.file) {
      return res.status(400).json({ erro: "Sem arquivo." });
    }

    if (!pairId) {
      return res.status(400).json({ erro: "pairId obrigatório." });
    }

    tempFile = req.file.path;

    const user = await resolveIdentity(uid);
    if (user.pairId !== pairId) {
      return res.status(403).json({ erro: "Acesso negado a esse vínculo." });
    }

    const pair = await getPairRecord(pairId);
    if (!pair?.members) {
      return res.status(400).json({ erro: "Vínculo inválido." });
    }

    const partnerUid = user.role === "A" ? pair.members.B : pair.members.A;
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
    res.status(500).json({ erro: e.message });
  } finally {
    if (tempFile) fs.unlink(tempFile, () => {});
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 server rodando");
});
