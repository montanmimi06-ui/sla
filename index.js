const express = require("express");
const admin = require("firebase-admin");
const multer = require("multer");
const fs = require("fs");
const { v2: cloudinary } = require("cloudinary");

const app = express();

app.use(express.json({ limit: "2mb" }));

fs.mkdirSync("tmp", { recursive: true });

const audioUpload = multer({
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
 * ADMIN — PUBLICAR VERSÃO DO APP
 * O APK fica no GitHub Releases.
 * O Firebase guarda apenas a versão e o link.
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
      provider,
      githubReleaseUrl,
      githubTag,
      assetName,
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
      forceUpdate: forceUpdate === true || forceUpdate === "true",
      provider: provider || "github",
      githubReleaseUrl: githubReleaseUrl || null,
      githubTag: githubTag || null,
      assetName: assetName || null,
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
 * Cloudinary permanece aqui apenas se você ainda usa o Studio para áudio.
 * O APK NÃO usa Cloudinary.
 */
app.post(
  "/upload-audio",
  verifyAuth,
  audioUpload.single("audio"),
  async (req, res) => {
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
  }
);

function randomBobisseId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanBobisseText(value, max = 900) {
  return String(value || '').trim().slice(0, max);
}

function safeBobisseType(value, allowed, fallback = 'text') {
  return allowed.includes(value) ? value : fallback;
}

function randomDelayMs(minHours, maxHours) {
  const min = minHours * 60 * 60 * 1000;
  const max = maxHours * 60 * 60 * 1000;
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function assertPairAccess(uid, pairId) {
  if (!pairId || typeof pairId !== 'string') {
    const err = new Error('pairId obrigatório.');
    err.status = 400;
    throw err;
  }

  const user = await resolveIdentity(uid);
  if (user.pairId !== pairId) {
    const err = new Error('Acesso negado a esse vínculo.');
    err.status = 403;
    throw err;
  }

  const pair = await getPairRecord(pairId);
  if (!pair?.members) {
    const err = new Error('Vínculo inválido.');
    err.status = 400;
    throw err;
  }

  const partnerUid = resolvePartnerUid(user, pair);
  if (!partnerUid) {
    const err = new Error('A outra pessoa ainda não entrou no vínculo.');
    err.status = 409;
    throw err;
  }

  return { user, pair, partnerUid, partner: await getUserRecord(partnerUid) };
}

async function bumpRain(pairId, stat, points = 1) {
  const ref = db.ref(`pairs/${pairId}/rain`);
  const now = Date.now();

  await ref.transaction((current) => {
    const rain = current && typeof current === 'object' ? current : {};
    const stats = rain.stats && typeof rain.stats === 'object' ? rain.stats : {};

    rain.points = Number(rain.points || 0) + points;
    rain.lastDropAt = now;
    stats[stat] = Number(stats[stat] || 0) + 1;
    rain.stats = stats;

    return rain;
  });
}

async function pushToPartner(partner, title, body, data) {
  if (!partner?.fcmToken) return null;
  return sendPushToToken({
    token: partner.fcmToken,
    title,
    body,
    channelId: 'spotlove_alerts',
    data,
  });
}

/**
 * ❤️ PERGUNTAS — CRIAR
 * body: { pairId, title, questions: [string] }
 */
app.post('/bobisses/asks/create', verifyAuth, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const uid = req.uid;
    const { pairId, title, questions } = req.body || {};
    const { partnerUid, partner } = await assertPairAccess(uid, pairId);

    const cleanQuestions = Array.isArray(questions)
      ? questions.map((q) => cleanBobisseText(q, 120)).filter(Boolean).slice(0, 15)
      : [];

    if (cleanQuestions.length < 1) {
      return res.status(400).json({ erro: 'Crie pelo menos uma pergunta.' });
    }

    const now = Date.now();
    const payload = {
      creatorUid: uid,
      targetUid: partnerUid,
      title: cleanBobisseText(title, 48) || 'Perguntas do Be',
      createdAt: now,
      answered: false,
      questions: cleanQuestions.map((text) => ({ text, answer: null })),
    };

    await db.ref(`pairs/${pairId}/asks/current`).set(payload);

    const pushId = await pushToPartner(
      partner,
      '❤️ Be deixou perguntas para você.',
      'Deslize para responder quando quiser.',
      { type: 'bobisses_asks', pairId, createdAt: now }
    );

    return res.json({ ok: true, ask: payload, pushId });
  } catch (e) {
    console.error('❌ bobisses/asks/create:', e.message);
    return res.status(e.status || 500).json({ erro: e.message });
  }
});

/**
 * ❤️ PERGUNTAS — RESPONDER
 * body: { pairId, answers: [boolean] }
 */
app.post('/bobisses/asks/answer', verifyAuth, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const uid = req.uid;
    const { pairId, answers } = req.body || {};
    await assertPairAccess(uid, pairId);

    const snap = await db.ref(`pairs/${pairId}/asks/current`).get();
    if (!snap.exists()) {
      return res.status(404).json({ erro: 'Nenhuma pergunta ativa encontrada.' });
    }

    const ask = snap.val();
    if (ask.targetUid !== uid) {
      return res.status(403).json({ erro: 'Essas perguntas foram deixadas para a outra pessoa.' });
    }

    if (!Array.isArray(answers) || answers.length !== ask.questions.length) {
      return res.status(400).json({ erro: 'Respostas incompletas.' });
    }

    const now = Date.now();
    const answeredAsk = {
      ...ask,
      answered: true,
      answeredAt: now,
      questions: ask.questions.map((q, i) => ({
        ...q,
        answer: answers[i] === true,
      })),
    };

    const historyRef = db.ref(`pairs/${pairId}/asks/history`).push();
    const updates = {};
    updates[`pairs/${pairId}/asks/history/${historyRef.key}`] = answeredAsk;
    updates[`pairs/${pairId}/asks/current`] = null;
    await db.ref().update(updates);
    await bumpRain(pairId, 'asks', 2);

    const creator = await getUserRecord(ask.creatorUid);
    const pushId = await pushToPartner(
      creator,
      '❤️ Mô respondeu suas perguntas.',
      'O resultado está esperando por você.',
      { type: 'bobisses_asks_answered', pairId, historyId: historyRef.key, answeredAt: now }
    );

    return res.json({ ok: true, historyId: historyRef.key, pushId });
  } catch (e) {
    console.error('❌ bobisses/asks/answer:', e.message);
    return res.status(e.status || 500).json({ erro: e.message });
  }
});

/**
 * 🛏️ TRAVESSEIRO — DEIXAR ALGO
 * body: { pairId, type: text|image|sticker|audio, content }
 */
app.post('/bobisses/pillow/create', verifyAuth, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const uid = req.uid;
    const { pairId, type, content } = req.body || {};
    const { partnerUid } = await assertPairAccess(uid, pairId);

    const clean = cleanBobisseText(content, 900);
    if (!clean) return res.status(400).json({ erro: 'Conteúdo obrigatório.' });

    const now = Date.now();
    const payload = {
      senderUid: uid,
      receiverUid: partnerUid,
      type: safeBobisseType(type, ['text', 'image', 'sticker', 'audio']),
      content: clean,
      createdAt: now,
      opened: false,
      notified: false,
      notifyAfter: now + randomDelayMs(1, 8),
    };

    await db.ref(`pairs/${pairId}/pillow`).set(payload);
    return res.json({ ok: true, pillow: { ...payload, content: undefined } });
  } catch (e) {
    console.error('❌ bobisses/pillow/create:', e.message);
    return res.status(e.status || 500).json({ erro: e.message });
  }
});

/**
 * 🛏️ TRAVESSEIRO — ABRIR E SUMIR
 * body: { pairId }
 */
app.post('/bobisses/pillow/open', verifyAuth, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const uid = req.uid;
    const { pairId } = req.body || {};
    await assertPairAccess(uid, pairId);

    const ref = db.ref(`pairs/${pairId}/pillow`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ erro: 'Nada encontrado.' });

    const item = snap.val();
    if (item.senderUid === uid) {
      return res.status(403).json({ erro: 'Quem deixou não consegue rever.' });
    }
    if (item.receiverUid !== uid) {
      return res.status(403).json({ erro: 'Esse item não foi deixado para você.' });
    }

    await ref.remove();
    await bumpRain(pairId, 'pillow', 1);

    return res.json({ ok: true, item });
  } catch (e) {
    console.error('❌ bobisses/pillow/open:', e.message);
    return res.status(e.status || 500).json({ erro: e.message });
  }
});

/**
 * 🛏️ TRAVESSEIRO — NOTIFICAÇÃO NÃO INSTANTÂNEA
 */
app.post('/bobisses/pillow/dispatch', verifyAdminSecret, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const now = Date.now();
    const pairsSnap = await db.ref('pairs').get();
    const sent = [];

    if (!pairsSnap.exists()) return res.json({ ok: true, sent });

    const pairs = pairsSnap.val();
    for (const [pairId, pair] of Object.entries(pairs)) {
      const pillow = pair?.pillow;
      if (!pillow || pillow.opened || pillow.notified) continue;
      if (Number(pillow.notifyAfter || 0) > now) continue;

      const receiver = await getUserRecord(pillow.receiverUid);
      const pushId = await pushToPartner(
        receiver,
        '🛏️ Há algo debaixo do travesseiro.',
        'Talvez valha levantar com cuidado.',
        { type: 'bobisses_pillow', pairId }
      );

      await db.ref(`pairs/${pairId}/pillow`).update({
        notified: true,
        notifiedAt: now,
      });

      sent.push({ pairId, pushId });
    }

    return res.json({ ok: true, sent });
  } catch (e) {
    console.error('❌ bobisses/pillow/dispatch:', e.message);
    return res.status(500).json({ erro: e.message });
  }
});

/**
 * 📻 RÁDIO — CRIAR TRANSMISSÃO
 * body: { pairId, type: text|audio, content }
 */
app.post('/bobisses/radio/create', verifyAuth, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const uid = req.uid;
    const { pairId, type, content } = req.body || {};
    const { partnerUid } = await assertPairAccess(uid, pairId);

    const clean = cleanBobisseText(content, 900);
    if (!clean) return res.status(400).json({ erro: 'Conteúdo obrigatório.' });

    const now = Date.now();
    const payload = {
      senderUid: uid,
      receiverUid: partnerUid,
      type: safeBobisseType(type, ['text', 'audio']),
      content: clean,
      createdAt: now,
      deliverAfter: now + randomDelayMs(6, 72),
      delivered: false,
      opened: false,
    };

    const ref = db.ref(`pairs/${pairId}/radio`).push();
    await ref.set(payload);

    return res.json({ ok: true, radioId: ref.key, deliverAfter: payload.deliverAfter });
  } catch (e) {
    console.error('❌ bobisses/radio/create:', e.message);
    return res.status(e.status || 500).json({ erro: e.message });
  }
});

/**
 * 📻 RÁDIO — ABRIR TRANSMISSÃO
 * body: { pairId, radioId }
 */
app.post('/bobisses/radio/open', verifyAuth, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const uid = req.uid;
    const { pairId, radioId } = req.body || {};
    await assertPairAccess(uid, pairId);

    if (!radioId) return res.status(400).json({ erro: 'radioId obrigatório.' });

    const ref = db.ref(`pairs/${pairId}/radio/${radioId}`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ erro: 'Transmissão não encontrada.' });

    const radio = snap.val();
    if (radio.receiverUid !== uid) {
      return res.status(403).json({ erro: 'Essa transmissão não foi recebida por você.' });
    }

    const now = Date.now();
    await ref.update({ opened: true, openedAt: now });
    await bumpRain(pairId, 'radio', 1);

    return res.json({ ok: true, openedAt: now });
  } catch (e) {
    console.error('❌ bobisses/radio/open:', e.message);
    return res.status(e.status || 500).json({ erro: e.message });
  }
});

/**
 * 📻 RÁDIO — DISPATCH SCHEDULER
 */
app.post('/bobisses/radio/dispatch', verifyAdminSecret, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const now = Date.now();
    const pairsSnap = await db.ref('pairs').get();
    const sent = [];

    if (!pairsSnap.exists()) return res.json({ ok: true, sent });

    const pairs = pairsSnap.val();
    for (const [pairId, pair] of Object.entries(pairs)) {
      const radio = pair?.radio;
      if (!radio || typeof radio !== 'object') continue;

      for (const [radioId, item] of Object.entries(radio)) {
        if (!item || item.delivered || Number(item.deliverAfter || 0) > now) continue;

        const receiver = await getUserRecord(item.receiverUid);
        const pushId = await pushToPartner(
          receiver,
          '📻 Uma transmissão foi recebida.',
          'A Rádio SpotLove encontrou uma frequência.',
          { type: 'bobisses_radio', pairId, radioId }
        );

        await db.ref(`pairs/${pairId}/radio/${radioId}`).update({
          delivered: true,
          deliveredAt: now,
          pushId: pushId || null,
        });

        sent.push({ pairId, radioId, pushId });
      }
    }

    return res.json({ ok: true, sent });
  } catch (e) {
    console.error('❌ bobisses/radio/dispatch:', e.message);
    return res.status(500).json({ erro: e.message });
  }
});

/**
 * ☔ CHUVA — INCREMENTO ADMINISTRATIVO/INTERNO
 * body: { pairId, stat, points }
 */
app.post('/bobisses/rain/drop', verifyAdminSecret, async (req, res) => {
  try {
    if (!requireFirebase(res)) return;

    const { pairId, stat, points } = req.body || {};
    const allowed = ['saudades', 'radio', 'pillow', 'asks', 'letters', 'studio'];
    if (!pairId || !allowed.includes(stat)) {
      return res.status(400).json({ erro: 'pairId/stat inválidos.' });
    }

    await bumpRain(pairId, stat, Math.max(1, Number(points || 1)));
    return res.json({ ok: true });
  } catch (e) {
    console.error('❌ bobisses/rain/drop:', e.message);
    return res.status(500).json({ erro: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 server rodando");
});
