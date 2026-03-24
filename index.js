const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

let firebaseReady = false;

try {
  if (!process.env.FIREBASE_KEY) {
    throw new Error("FIREBASE_KEY não definida no ambiente");
  }

  console.log("🔍 FIREBASE_KEY encontrada:", !!process.env.FIREBASE_KEY);
  console.log("🔍 Tamanho da FIREBASE_KEY:", process.env.FIREBASE_KEY.length);

  const raw = JSON.parse(process.env.FIREBASE_KEY);

  if (!raw.private_key) {
    throw new Error("private_key ausente dentro da FIREBASE_KEY");
  }

  const serviceAccount = {
    ...raw,
    private_key: raw.private_key.replace(/\\n/g, "\n"),
  };

  console.log("🔍 project_id:", serviceAccount.project_id);
  console.log("🔍 client_email:", serviceAccount.client_email);
  console.log(
    "🔍 private_key ok:",
    serviceAccount.private_key.startsWith("-----BEGIN PRIVATE KEY-----")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  firebaseReady = true;
  console.log("🔥 Firebase inicializado com sucesso");
} catch (e) {
  console.error("❌ ERRO AO INICIALIZAR FIREBASE:");
  console.error("mensagem:", e.message);
  console.error("stack:", e.stack);
}

app.get("/", (req, res) => {
  res.send("Servidor online");
});

app.get("/health", (req, res) => {
  res.status(firebaseReady ? 200 : 500).json({
    server: "ok",
    firebaseReady,
  });
});

app.post("/send", async (req, res) => {
  try {
    if (!firebaseReady) {
      return res.status(500).json({
        erro: "Firebase não inicializado",
      });
    }

    const { token, data, title, body } = req.body;

    console.log("📩 BODY RECEBIDO:", JSON.stringify(req.body, null, 2));

    if (!token) {
      return res.status(400).json({
        erro: "Token ausente",
      });
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
      for (const [key, value] of Object.entries(data)) {
        payload.data[key] = String(value);
      }
    }

    console.log("📨 Enviando para token:", token);

    const response = await admin.messaging().send(payload);

    console.log("✅ SUCESSO:", response);

    return res.status(200).json({
      ok: true,
      response,
    });
  } catch (err) {
    console.error("❌ ERRO AO ENVIAR:");
    console.error("message:", err.message);
    console.error("code:", err.code);
    console.error("stack:", err.stack);

    return res.status(500).json({
      erro: "Erro ao enviar",
      detalhes: err.message,
      code: err.code || null,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
