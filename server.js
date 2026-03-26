const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');

const app = express();

// LINE config
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new line.Client(lineConfig);

// Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Firebase Admin
const firebaseApp = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore(firebaseApp);

// Middleware
app.use('/webhook', line.middleware(lineConfig));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('Expense Bot Server is running! 🚀');
});

// LINE Webhook
app.post('/webhook', async (req, res) => {
  res.status(200).end();

  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
});

async function handleEvent(event) {
  // Only handle messages
  if (event.type !== 'message') return;

  const userId = event.source.userId;
  const replyToken = event.replyToken;

  try {
    // Image message (slip)
    if (event.message.type === 'image') {
      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: '📄 กำลังอ่านสลิป รอแป๊บนึงนะครับ...',
      });

      // Get image from LINE
      const imageBuffer = await getLineImage(event.message.id);

      // Read slip with Gemini
      const slipData = await readSlipWithGemini(imageBuffer);

      if (slipData) {
        // Save to Firestore
        await saveToFirestore(slipData, userId);

        // Reply success
        await lineClient.pushMessage(userId, {
          type: 'text',
          text: `✅ บันทึกสำเร็จ!\n\n📋 รายการ: ${slipData.item}\n💸 จำนวน: ฿${slipData.amount.toLocaleString()}\n📅 เดือน: ${getMonthName(slipData.month)} ${slipData.year}\n\nบันทึกลง Firebase แล้วครับ 🎉`,
        });
      } else {
        await lineClient.pushMessage(userId, {
          type: 'text',
          text: '❌ อ่านสลิปไม่ได้ครับ กรุณาส่งรูปสลิปที่ชัดเจนขึ้น',
        });
      }
    }

    // Text message
    else if (event.message.type === 'text') {
      const text = event.message.text.toLowerCase();

      if (text.includes('สรุป') || text.includes('ยอด')) {
        const summary = await getMonthlySummary(userId);
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: summary,
        });
      } else {
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: '💡 ส่งรูปสลิปโอนเงินมาได้เลยครับ จะบันทึกให้อัตโนมัติ!\n\nหรือพิมพ์ "สรุป" เพื่อดูยอดเดือนนี้',
        });
      }
    }
  } catch (error) {
    console.error('Error handling event:', error);
    try {
      await lineClient.pushMessage(userId, {
        type: 'text',
        text: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งครับ',
      });
    } catch (e) {
      console.error('Error sending error message:', e);
    }
  }
}

async function getLineImage(messageId) {
  const response = await axios({
    method: 'get',
    url: `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.data);
}

async function readSlipWithGemini(imageBuffer) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg',
      },
    };

    const prompt = `นี่คือสลิปโอนเงิน กรุณาอ่านข้อมูลและตอบเป็น JSON เท่านั้น ไม่ต้องมีคำอธิบายเพิ่มเติม:
{
  "item": "รายละเอียดการโอน เช่น ชื่อผู้รับ หรือ หมายเหตุ",
  "amount": จำนวนเงิน (ตัวเลขเท่านั้น ไม่มี comma หรือ ฿),
  "year": ปี ค.ศ. (เช่น 2026),
  "month": เดือน (1-12)
}

ถ้าอ่านไม่ได้หรือไม่ใช่สลิป ตอบว่า null`;

    const result = await model.generateContent([prompt, imagePart]);
    const text = result.response.text().trim();

    // Parse JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      // Validate
      if (data.item && data.amount && data.year && data.month) {
        return data;
      }
    }
    return null;
  } catch (error) {
    console.error('Gemini error:', error);
    return null;
  }
}

async function saveToFirestore(slipData, userId) {
  await db.collection('transactions').add({
    item: slipData.item,
    outcome: parseFloat(slipData.amount),
    income: 0,
    year: parseInt(slipData.year),
    month: parseInt(slipData.month),
    source: 'line_slip',
    lineUserId: userId,
    createdAt: new Date().toISOString(),
  });
}

async function getMonthlySummary(userId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const snapshot = await db
    .collection('transactions')
    .where('year', '==', year)
    .where('month', '==', month)
    .get();

  let totalIncome = 0;
  let totalOutcome = 0;

  snapshot.forEach((doc) => {
    const data = doc.data();
    totalIncome += data.income || 0;
    totalOutcome += data.outcome || 0;
  });

  const balance = totalIncome - totalOutcome;

  return `📊 สรุปเดือน ${getMonthName(month)} ${year}\n\n💰 รายรับ: ฿${totalIncome.toLocaleString()}\n💸 รายจ่าย: ฿${totalOutcome.toLocaleString()}\n${balance >= 0 ? '✅' : '⚠️'} คงเหลือ: ฿${balance.toLocaleString()}`;
}

function getMonthName(month) {
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  return months[month - 1];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
