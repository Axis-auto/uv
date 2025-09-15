import express from "express";
import sgMail from "@sendgrid/mail";

const app = express();
const PORT = process.env.PORT || 3000;

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

app.get("/test-email", async (req, res) => {
  const msg = {
    to: "بريدك@مثال.com", // ضع بريدك أنت
    from: "your_verified_sender@example.com", // المرسل الذي وثقته في SendGrid
    subject: "اختبار إرسال بريد",
    text: "هذا بريد تجريبي من SendGrid",
  };

  try {
    await sgMail.send(msg);
    res.send("تم إرسال البريد بنجاح ✅");
  } catch (error) {
    console.error(error);
    res.status(500).send("فشل إرسال البريد ❌");
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
