const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.post("/send", async (req, res) => {
  const { token, data } = req.body;

  try {
    await admin.messaging().send({
      token: token,
      notification: {
        title: "Nova notificação 💌",
        body: "Você recebeu algo",
      },
      data: data || {},
    });

    res.send("Enviado!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao enviar");
  }
});

app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000");
});
