const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  console.log("🔑 private_key:", process.env.FIREBASE_KEY.slice(0, 100));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("🔥 Firebase inicializado");
} catch (e) {
  console.error("❌ ERRO FIREBASE:", e);
}

app.post("/send", async (req, res) => {
  const { token, data } = req.body;

  console.log("📩 RECEBIDO:", token);

  try {
    const response = await admin.messaging().send({
      token: token,
      notification: {
        title: "Nova notificação 💌",
        body: "Você recebeu algo",
      },
      data: data || {},
    });

    console.log("✅ SUCESSO:", response);
    res.send("Enviado!");
  } catch (err) {
    console.error("❌ ERRO AO ENVIAR:", err);
    res.status(500).send("Erro ao enviar");
  }
});

app.listen(3000, () => {
  console.log("🚀 Servidor rodando");
});
