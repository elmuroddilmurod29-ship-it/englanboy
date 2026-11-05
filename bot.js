const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const { GoogleGenAI } = require('@google/genai');
const serviceAccount = require('./englanboy-firebase-adminsdk-fbsvc-9d2b8dcc97.json');

// Kutilmagan global xatoliklarni ushlab qolish (jarayon qulab tushmasligi uchun)
process.on('uncaughtException', (err) => {
  console.error('Kutilmagan xatolik (uncaughtException):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Kutilmagan rad etilish (unhandledRejection):', reason);
});

// 1. Google Gemini AI SDK ulanishi
const ai = new GoogleGenAI({ apiKey: 'AQ.Ab8RN6LmFwbHxMnN3quDyLN79cDAHwO3VH3-8RDUhxSuXx8ggA' });

// Gemini tizim yo'riqnomasi (System Instruction)
const GEMINI_SYSTEM_INSTRUCTION = 
`Siz bolalar uchun ingliz tili o'rgatuvchi 'EnglanBoy' (sayt: https://englanboy.netlify.app) platformasining aqlli yordamchisisiz. 
Sayt imkoniyatlari: Bolalar uchun interaktiv so'z o'yinlari, lug'at kartalari, testlar, tanga (coin) yig'ish, darajalar va Pro obuna orqali yopiq darslarni ochish.
Pro tariflar: 1 oylik — 100 000 so'm, 5 oylik — 400 000 so'm, 18 oylik — 1 000 000 so'm. To'lov qilingach chek botga yuboriladi va admin tasdiqlaydi.
Vazifangiz: Foydalanuvchilarga sayt, darslar, hisobni ulash va Pro obuna bo'yicha samimiy, o'zbek tilida, tushunarli va qisqa javob berish. Agar masala murakkab yoki texnik muammo bo'lsa, adminga murojaat qilishni taklif qiling.`;

// 2. Firebase ulanishini o'rnatamiz
const certCredential = (admin.credential && admin.credential.cert)
  ? admin.credential.cert(serviceAccount)
  : (admin.cert ? admin.cert(serviceAccount) : serviceAccount);

if (!admin.apps || !admin.apps.length) {
  admin.initializeApp({
    credential: certCredential,
    databaseURL: 'https://englanboy-default-rtdb.firebaseio.com'
  });
}

// Realtime Database
const rtdb = (typeof admin.database === 'function')
  ? admin.database()
  : require('firebase-admin/database').getDatabase();

// Cloud Firestore (Saytdagi asosiy foydalanuvchilar bazasi)
const firestore = (typeof admin.firestore === 'function')
  ? admin.firestore()
  : require('firebase-admin/firestore').getFirestore();

// 3. Telegram Bot sozlamalari
const BotClass = TelegramBot.default || TelegramBot.Bot || TelegramBot;

const token = '9155064024:AAFClFUTQEHJULIs7BChokJjAnXuO1bPUfA';
const ADMIN_CHAT_ID = '8405700972';

// Botni polling rejimida ishga tushiramiz
const bot = new BotClass(token, { polling: true });

// Foydalanuvchilar holatini saqlash (FSM - Finite State Machine)
const userStates = new Map();

// Pro versiya tariflari
const PLANS = {
  plan_1: {
    title: '1 oylik — 100 000 so‘m',
    price: '100 000 so‘m',
    period: '1 oy'
  },
  plan_5: {
    title: '5 oylik — 400 000 so‘m',
    price: '400 000 so‘m',
    period: '5 oy'
  },
  plan_18: {
    title: '18 oylik — 1 000 000 so‘m',
    price: '1 000 000 so‘m',
    period: '18 oy'
  }
};

// Telefon raqamlarni tozalash (faqat raqamlarni qoldirish)
function cleanPhone(p) {
  return String(p || '').replace(/\D/g, ''); // faqat raqamlarni qoldiradi
}

// Telefonning asosiy 9 xonali qismini ajratib olish (masalan, 998946188538 => 946188538)
function getBasePhone(p) {
  const d = cleanPhone(p);
  return d.length >= 9 ? d.slice(-9) : d;
}

// Ikki telefon raqamini har qanday formatda solishtirish
function phonesMatch(phone1, phone2) {
  const c1 = cleanPhone(phone1);
  const c2 = cleanPhone(phone2);
  if (!c1 || !c2) return false;
  if (c1 === c2) return true;
  return getBasePhone(c1) === getBasePhone(c2);
}

// Asosiy menyu klaviaturasi (Reply Keyboard)
const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '👤 Profil' }, { text: '⭐ Pro versiya' }],
      [{ text: '📝 Ro‘yxatdan o‘tish' }, { text: '🆘 Yordam' }]
    ],
    resize_keyboard: true
  }
};

// Bekor qilish klaviaturasi
const cancelKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '❌ Bekor qilish' }]
    ],
    resize_keyboard: true
  }
};

// AI Yordamchi klaviaturasi (Chiqish uchun Asosiy menyu tugmasi)
const aiChatKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '🔙 Asosiy menyu' }]
    ],
    resize_keyboard: true
  }
};

// Telefon raqam so'rash klaviaturasi
const phoneKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '📞 Raqamni yuborish', request_contact: true }],
      [{ text: '❌ Bekor qilish' }]
    ],
    resize_keyboard: true
  }
};

// /start komandasi
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userStates.delete(chatId);

  const welcomeText = 
`👋 Assalomu alaykum, <b>${msg.from.first_name || 'foydalanuvchi'}</b>!

Bolalar uchun interaktiv ingliz tili o‘quv platformasining rasmiy botiga xush kelibsiz! 🇬🇧✨

Quyidagi menyudan kerakli bo‘limni tanlang:`;

  bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'HTML',
    ...mainMenuKeyboard
  });
});

// Callback Query (Inline tugmalar bosilganda)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  try {
    // 1) Pro tarif tanlanganda (plan_1, plan_5, plan_18)
    if (PLANS[data]) {
      const selectedPlan = PLANS[data];
      userStates.set(chatId, {
        step: 'PRO_WAIT_NICK',
        data: {
          planKey: data,
          plan: selectedPlan
        }
      });

      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        `Tanlangan tarif: <b>${selectedPlan.title}</b>\n\n` +
        `Iltimos, bolalar uchun ingliz tili saytidagi nikingizni (foydalanuvchi nomingizni) kiriting:`,
        {
          parse_mode: 'HTML',
          ...cancelKeyboard
        }
      );
      return;
    }

    // 2) Admin tasdiqlashi yoki rad etishi
    if (data.startsWith('admin_approve_') || data.startsWith('admin_reject_')) {
      const isApprove = data.startsWith('admin_approve_');
      const parts = data.split('_'); // ['admin', 'approve'/'reject', targetUserId, planKey]
      const targetUserId = parts[2];
      const planKey = parts[3];
      const planInfo = PLANS[planKey] ? PLANS[planKey].title : 'Pro versiya';

      await bot.answerCallbackQuery(query.id);

      if (isApprove) {
        let userUpdated = false;

        // A) Firestore'da telegramId == targetUserId bo'yicha foydalanuvchini yangilash
        try {
          const firestoreUsers = await firestore.collection('users').get();
          for (const doc of firestoreUsers.docs) {
            const val = doc.data();
            if (val && String(val.telegramId) === String(targetUserId)) {
              await firestore.collection('users').doc(doc.id).update({
                isPro: true,
                isPremium: true,
                proPlan: planInfo,
                proActivatedAt: Date.now()
              });
              userUpdated = true;
              console.log(`[Admin Tasdiqlash] Firestore'dagi foydalanuvchi (${doc.id}) Pro ga o'tkazildi.`);
            }
          }
        } catch (fErr) {
          console.error('[Admin Tasdiqlash] Firestore xatoligi:', fErr.message);
        }

        // B) Realtime Database'da ham telegramId == targetUserId bo'yicha yangilash
        try {
          const rtdbSnap = await rtdb.ref('users').once('value');
          if (rtdbSnap.exists()) {
            const updates = {};
            rtdbSnap.forEach((child) => {
              const val = child.val();
              if (val && String(val.telegramId) === String(targetUserId)) {
                updates[`users/${child.key}/isPro`] = true;
                updates[`users/${child.key}/proPlan`] = planInfo;
                updates[`users/${child.key}/proActivatedAt`] = Date.now();
                userUpdated = true;
              }
            });
            if (Object.keys(updates).length > 0) {
              await rtdb.ref().update(updates);
              console.log(`[Admin Tasdiqlash] Realtime Database Pro ga yangilandi.`);
            }
          }
        } catch (rErr) {
          console.error('[Admin Tasdiqlash] RTDB xatoligi:', rErr.message);
        }

        // Foydalanuvchiga muvaffaqiyat xabari yuborish
        await bot.sendMessage(
          targetUserId,
          `🎉 To‘lovingiz tasdiqlandi! Sizga ${planInfo} Pro versiya taqdim etildi.`,
          mainMenuKeyboard
        );

        // Admin xabarini yangilash
        const dbNote = userUpdated ? ' (Sayt hisobi yangilandi ✅)' : ' (Sayt hisobi topilmadi ⚠️)';
        const updatedCaption = (query.message.caption || '') + `\n\n✅ <b>HOLAT: QABUL QILINDI${dbNote}</b>`;
        await bot.editMessageCaption(updatedCaption, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        });
      } else {
        // Foydalanuvchiga rad etilganlik xabari
        await bot.sendMessage(
          targetUserId,
          `❌ <b>To‘lov rad etildi</b>\n\n` +
          `Afsuski, siz yuborgan to‘lov cheki admin tomonidan rad etildi.\n` +
          `To‘lov yetib kelmagan yoki noto‘g‘ri chek yuborilgan bo‘lishi mumkin.\n\n` +
          `Savollaringiz bo‘lsa, "🆘 Yordam" bo‘limi orqali murojaat qilishingiz mumkin.`,
          {
            parse_mode: 'HTML',
            ...mainMenuKeyboard
          }
        );

        // Admin xabarini yangilash
        const updatedCaption = (query.message.caption || '') + '\n\n❌ <b>HOLAT: RAD ETILDI</b>';
        await bot.editMessageCaption(updatedCaption, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        });
      }
    }
  } catch (error) {
    console.error('Callback query xatoligi:', error.message);
  }
});

// Barcha xabarlarni qayta ishlash (Matn, Rasm, Kontakt)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  // Start komandasi alohida tutiladi
  if (text === '/start') return;

  // Asosiy menyuga qaytish yoki bekor qilish buyruqlari
  if (text === '🔙 Asosiy menyu' || text === '❌ Bekor qilish' || text === '/cancel') {
    userStates.delete(chatId);
    return bot.sendMessage(chatId, 'Asosiy menyuga qaytdingiz.', mainMenuKeyboard);
  }

  // 1. "👤 Profil" bo'limi
  if (text === '👤 Profil') {
    userStates.delete(chatId);
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';
    const fullName = `${firstName} ${lastName}`.trim() || 'Kiritilmagan';
    const username = msg.from.username ? `@${msg.from.username}` : 'Mavjud emas';
    const userId = msg.from.id;

    let profileText = 
`👤 <b>Foydalanuvchi Profili:</b>

📛 <b>Ism:</b> ${fullName}
🔗 <b>Username:</b> ${username}
🆔 <b>Telegram ID:</b> <code>${userId}</code>`;

    // Bazadan foydalanuvchining ulanganlik va Pro holatini tekshirish
    try {
      let linkedUser = null;

      // Firestore dan tekshirish
      const firestoreUsers = await firestore.collection('users').get();
      firestoreUsers.forEach((doc) => {
        const val = doc.data();
        if (val && String(val.telegramId) === String(userId)) {
          linkedUser = val;
        }
      });

      // Realtime DB dan tekshirish
      if (!linkedUser) {
        const rtdbSnap = await rtdb.ref('users').once('value');
        if (rtdbSnap.exists()) {
          rtdbSnap.forEach((child) => {
            const val = child.val();
            if (val && String(val.telegramId) === String(userId)) {
              linkedUser = val;
            }
          });
        }
      }

      if (linkedUser) {
        const isUserPro = linkedUser.isPro || linkedUser.isPremium;
        const proStatus = isUserPro 
          ? `⭐ Faol (${linkedUser.proPlan || 'Pro obuna'})` 
          : 'Oddiy (Pro faol emas)';
        const siteName = linkedUser.displayName || linkedUser.name || linkedUser.cleanPhone || 'Mavjud';
        profileText += `\n\n🌐 <b>Saytdagi hisob:</b> Ulangan (${siteName}) ✅\n⭐ <b>Obuna holati:</b> ${proStatus}`;
      } else {
        profileText += `\n\n🌐 <b>Saytdagi hisob:</b> Ulanmagan ❌\n<i>(Akkauntni ulash uchun "📝 Ro‘yxatdan o‘tish" bo‘limidan foydalaning)</i>`;
      }
    } catch (err) {
      console.error('Profil olishda xatolik:', err.message);
    }

    return bot.sendMessage(chatId, profileText, {
      parse_mode: 'HTML',
      ...mainMenuKeyboard
    });
  }

  // 2. "⭐ Pro versiya" bo'limi
  if (text === '⭐ Pro versiya') {
    userStates.delete(chatId);

    const proText = 
`⭐ <b>Pro versiya tariflari</b>

Bolalar uchun ingliz tili platformamizning barcha premium darslari, interaktiv mashqlar va testlaridan to‘liq foydalanish uchun o‘zingizga mos tarifni tanlang:`;

    const proInlineKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '1 oylik — 100 000 so‘m', callback_data: 'plan_1' }],
          [{ text: '5 oylik — 400 000 so‘m', callback_data: 'plan_5' }],
          [{ text: '18 oylik — 1 000 000 so‘m', callback_data: 'plan_18' }]
        ]
      }
    };

    return bot.sendMessage(chatId, proText, {
      parse_mode: 'HTML',
      ...proInlineKeyboard
    });
  }

  // 3. "📝 Ro‘yxatdan o‘tish" bo'limi
  if (text === '📝 Ro‘yxatdan o‘tish') {
    userStates.set(chatId, {
      step: 'REG_WAIT_PHONE',
      data: {}
    });

    return bot.sendMessage(
      chatId,
      '📝 Saytdagi hisobingizni ulash uchun <b>telefon raqamingizni</b> yozing yoki pastdagi "📞 Raqamni yuborish" tugmasini bosing:',
      {
        parse_mode: 'HTML',
        ...phoneKeyboard
      }
    );
  }

  // 4. "🆘 Yordam" bo'limi (Cheksiz Gemini AI muloqot rejimiga o'tish)
  if (text === '🆘 Yordam') {
    userStates.set(chatId, {
      step: 'ai_chat',
      data: {}
    });

    return bot.sendMessage(
      chatId,
      "Savolingizni yozing, sun'iy intellekt yordamchimiz sizga javob beradi. Chiqish uchun '🔙 Asosiy menyu' tugmasini bosing:",
      aiChatKeyboard
    );
  }

  // FSM — Bosqichma-bosqich jarayonlarni boshqarish
  const state = userStates.get(chatId);
  if (!state) return;

  try {
    // --- PRO VERSIYA BOSQICHLARI ---
    if (state.step === 'PRO_WAIT_NICK') {
      if (!text) {
        return bot.sendMessage(chatId, 'Iltimos, saytdagi nikingizni matn ko‘rinishida kiriting:', cancelKeyboard);
      }
      state.data.nick = text;
      state.step = 'PRO_WAIT_PHONE';

      return bot.sendMessage(
        chatId,
        '✅ Nik qabul qilindi!\n\nEndi bog‘lanish uchun <b>telefon raqamingizni</b> yuboring:',
        {
          parse_mode: 'HTML',
          ...phoneKeyboard
        }
      );
    }

    if (state.step === 'PRO_WAIT_PHONE') {
      let phoneNumber = '';
      if (msg.contact && msg.contact.phone_number) {
        phoneNumber = msg.contact.phone_number;
      } else if (text) {
        phoneNumber = text;
      } else {
        return bot.sendMessage(chatId, 'Iltimos, telefon raqamingizni kiriting yoki tugmani bosing:', phoneKeyboard);
      }

      state.data.phone = phoneNumber;
      state.step = 'PRO_WAIT_RECEIPT';

      const paymentInfo = 
`💳 <b>To‘lov ma’lumotlari:</b>

⭐ <b>Tanlangan tarif:</b> ${state.data.plan.title}
🌐 <b>Saytdagi nik:</b> ${state.data.nick}
📞 <b>Telefon:</b> ${state.data.phone}

<b>To‘lov uchun karta:</b>
💳 <code>8600 0000 0000 0000</code>
👤 Karta egasi: Bolalar Ingliz Tili MCHJ
💰 <b>Summa:</b> ${state.data.plan.price}

To‘lovni amalga oshirgach, iltimos, to‘lov chekining <b>RASMINI</b> (skrinshotini) shu yerga yuboring:`;

      return bot.sendMessage(chatId, paymentInfo, {
        parse_mode: 'HTML',
        ...cancelKeyboard
      });
    }

    if (state.step === 'PRO_WAIT_RECEIPT') {
      if (!msg.photo || msg.photo.length === 0) {
        return bot.sendMessage(
          chatId,
          '⚠️ Iltimos, to‘lov chekining <b>rasmini</b> (skrinshotini) yuboring:',
          {
            parse_mode: 'HTML',
            ...cancelKeyboard
          }
        );
      }

      // Eng sifatli rasmni olamiz
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      const firstName = msg.from.first_name || '';
      const lastName = msg.from.last_name || '';
      const fullName = `${firstName} ${lastName}`.trim() || 'Noma’lum';
      const username = msg.from.username ? `@${msg.from.username}` : 'Mavjud emas';

      const adminCaption = 
`🔔 <b>YANGI PRO OBUNA TO‘LOV CHEKI!</b>

👤 <b>Foydalanuvchi:</b> ${fullName}
🔗 <b>Username:</b> ${username}
🆔 <b>Telegram ID:</b> <code>${chatId}</code>

⭐ <b>Tarif:</b> ${state.data.plan.title}
🌐 <b>Saytdagi nik:</b> ${state.data.nick}
📞 <b>Telefon:</b> ${state.data.phone}`;

      const adminInlineKeyboard = {
        inline_keyboard: [
          [
            { text: '✅ Tasdiqlash', callback_data: `admin_approve_${chatId}_${state.data.planKey}` },
            { text: '❌ Rad etish', callback_data: `admin_reject_${chatId}_${state.data.planKey}` }
          ]
        ]
      };

      // Adminga chek rasmi va ma'lumotlarni yuborish
      await bot.sendPhoto(ADMIN_CHAT_ID, photoId, {
        caption: adminCaption,
        parse_mode: 'HTML',
        reply_markup: adminInlineKeyboard
      });

      // Foydalanuvchi holatini tozalash va xabar berish
      userStates.delete(chatId);
      return bot.sendMessage(
        chatId,
        '✅ <b>So‘rovingiz adminga yuborildi, kutilmoqda.</b>\n\nAdmin to‘lovni tekshirib tasdiqlashi bilan sizga xabar beriladi.',
        {
          parse_mode: 'HTML',
          ...mainMenuKeyboard
        }
      );
    }

    // --- RO‘YXATDAN O‘TISH (AKKAUNTNI ULASH) BOSQICHLARI ---
    if (state.step === 'REG_WAIT_PHONE') {
      let phoneNumber = '';
      if (msg.contact && msg.contact.phone_number) {
        phoneNumber = msg.contact.phone_number;
      } else if (text) {
        phoneNumber = text;
      } else {
        return bot.sendMessage(chatId, 'Iltimos, telefon raqamingizni yuboring:', phoneKeyboard);
      }

      state.data.phone = phoneNumber;
      state.step = 'REG_WAIT_PASSWORD';

      return bot.sendMessage(
        chatId,
        '✅ Telefon raqamingiz qabul qilindi.\n\nEndi saytdagi hisobingiz <b>parolini</b> kiriting:',
        {
          parse_mode: 'HTML',
          ...cancelKeyboard
        }
      );
    }

    if (state.step === 'REG_WAIT_PASSWORD') {
      if (!text) {
        return bot.sendMessage(chatId, 'Iltimos, parolingizni matn ko‘rinishida kiriting:', cancelKeyboard);
      }

      const inputPassword = text;
      const inputPhone = state.data.phone;
      const cleanedInputPhone = cleanPhone(inputPhone);
      userStates.delete(chatId);

      // Parolni yumshatib (case-insensitive va trim) solishtirish uchun tayyorlaymiz
      const normalizedInputPass = inputPassword.trim().toLowerCase();

      console.log('\n========================================');
      console.log('--- 📝 YANGI RO‘YXATDAN O‘TISH TEKSHIRUVI ---');
      console.log('👤 Telegram User:', msg.from.first_name, `(@${msg.from.username || 'yoq'}, ID: ${chatId})`);
      console.log('📞 Kiritilgan telefon:', inputPhone);
      console.log('🧹 Tozalangan ko‘rinishi (cleanPhone):', cleanedInputPhone);
      console.log('🔑 Kiritilgan parol:', inputPassword, `(Normalizatsiya: "${normalizedInputPass}")`);
      console.log('========================================');

      try {
        let matchedUser = null;
        let matchedSource = ''; // 'firestore' yoki 'rtdb'
        let matchedDocId = null;

        // A) Firestore'dan qidirish
        console.log('🔍 1. Firestore `users` kolleksiyasidan qidirilmoqda...');
        const firestoreSnapshot = await firestore.collection('users').get();
        console.log(`📊 Firestore'da jami foydalanuvchilar soni: ${firestoreSnapshot.size}`);

        for (const doc of firestoreSnapshot.docs) {
          const val = doc.data();
          if (!val) continue;

          const userPhone = val.phone || val.cleanPhone || val.phoneNumber || doc.id || '';
          const dbPass = (val.password || val.parol || '').toString();
          const normalizedDbPass = dbPass.trim().toLowerCase();

          const isPhoneMatch = phonesMatch(inputPhone, userPhone);
          // Case-insensitive va bo'shliqlarsiz solishtirish
          const isPassMatch = (normalizedInputPass === normalizedDbPass);

          console.log(`   -> [${doc.id}] Tel: "${userPhone}" (Mos: ${isPhoneMatch}) | Parol: "${dbPass}" (Mos: ${isPassMatch})`);

          if (isPhoneMatch && isPassMatch) {
            matchedUser = val;
            matchedDocId = doc.id;
            matchedSource = 'firestore';
            break;
          }
        }

        // B) Realtime Database'dan qidirish
        if (!matchedUser) {
          console.log('🔍 2. Realtime Database `users` tugunidan qidirilmoqda...');
          const rtdbSnapshot = await rtdb.ref('users').once('value');

          if (rtdbSnapshot.exists()) {
            rtdbSnapshot.forEach((child) => {
              const val = child.val();
              if (!val) return;

              const userPhone = val.phone || val.cleanPhone || val.phoneNumber || val.telefon || child.key || '';
              const dbPass = (val.password || val.parol || '').toString();
              const normalizedDbPass = dbPass.trim().toLowerCase();

              const isPhoneMatch = phonesMatch(inputPhone, userPhone);
              const isPassMatch = (normalizedInputPass === normalizedDbPass);

              console.log(`   -> [RTDB: ${child.key}] Tel: "${userPhone}" (Mos: ${isPhoneMatch}) | Parol: "${dbPass}" (Mos: ${isPassMatch})`);

              if (isPhoneMatch && isPassMatch && !matchedUser) {
                matchedUser = val;
                matchedDocId = child.key;
                matchedSource = 'rtdb';
              }
            });
          } else {
            console.log('   ⚠️ Realtime Database `users` tuguni bo‘sh.');
          }
        }

        // Natija tekshiruvi va yangilash
        if (matchedUser && matchedDocId) {
          console.log(`✅ MOS FOYDALANUVCHI TOPILDI! Manba: ${matchedSource}, ID: ${matchedDocId}`);

          if (matchedSource === 'firestore') {
            await firestore.collection('users').doc(matchedDocId).update({
              telegramId: chatId,
              telegramUsername: msg.from.username ? `@${msg.from.username}` : ''
            });
            console.log(`💾 Firestore'dagi [${matchedDocId}] hujjatiga telegramId: ${chatId} muvaffaqiyatli saqlandi.`);
          }

          if (matchedSource === 'rtdb') {
            await rtdb.ref(`users/${matchedDocId}`).update({
              telegramId: chatId,
              telegramUsername: msg.from.username ? `@${msg.from.username}` : ''
            });
            console.log(`💾 Realtime Database [users/${matchedDocId}] ga telegramId: ${chatId} muvaffaqiyatli saqlandi.`);
          }

          return bot.sendMessage(
            chatId,
            '✅ Akkauntingiz muvaffaqiyatli ulandi! Xush kelibsiz!',
            mainMenuKeyboard
          );
        } else {
          console.log('❌ MOS FOYDALANUVCHI TOPILMADI (Telefon yoki parol noto‘g‘ri).');
          return bot.sendMessage(
            chatId,
            '❌ Telefon raqami yoki parol noto‘g‘ri. Saytdan tekshirib qaytadan urinib ko‘ring.',
            mainMenuKeyboard
          );
        }
      } catch (err) {
        console.error('❌ Tekshirish jarayonida xatolik yuz berdi:', err.message);
        return bot.sendMessage(
          chatId,
          '⚠️ Tizimda xatolik yuz berdi. Iltimos, keyinroq qayta urinib ko‘ring.',
          mainMenuKeyboard
        );
      }
    }

    // --- 4. YORDAM BO‘LIMI: CHEKSIZ VA XATOSIZ GOOGLE GEMINI AI REJIMI ('ai_chat') ---
    if (state.step === 'ai_chat') {
      if (!text) {
        return bot.sendMessage(
          chatId,
          'Iltimos, savolingizni matn ko‘rinishida yozing:',
          aiChatKeyboard
        );
      }

      await bot.sendChatAction(chatId, 'typing');

      console.log('\n--- 🤖 GEMINI AI MULOQOT (ai_chat) ---');
      console.log('Foydalanuvchi ID:', chatId);
      console.log('Savol matni:', text);

      let aiResponseText = '';
      const modelsToTry = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];

      try {
        for (const modelName of modelsToTry) {
          try {
            const response = await ai.models.generateContent({
              model: modelName,
              contents: text,
              config: {
                systemInstruction: GEMINI_SYSTEM_INSTRUCTION
              }
            });

            if (response && response.text) {
              aiResponseText = response.text;
              console.log(`✅ Gemini AI javob berdi (Model: ${modelName})`);
              break;
            }
          } catch (modelErr) {
            console.warn(`[${modelName}] modeli xatosi:`, modelErr.message);
          }
        }

        if (!aiResponseText) {
          aiResponseText = "Kechirasiz, vaqtincha aloqa uzildi. Iltimos, qayta yozing.";
        }
      } catch (generalAiErr) {
        console.error('Gemini AI chaqiruvida xatolik:', generalAiErr.message);
        aiResponseText = "Kechirasiz, vaqtincha aloqa uzildi. Iltimos, qayta yozing.";
      }

      // DIQQAT: Holat (userStates) o'chirilmaydi! Foydalanuvchi '🔙 Asosiy menyu' bosmaguncha cheksiz savol bera oladi.
      return bot.sendMessage(chatId, aiResponseText, aiChatKeyboard);
    }
  } catch (error) {
    console.error('Xabarni qayta ishlashda umumiy xatolik:', error.message);
  }
});

// Polling xatoliklarini konsolda ko'rsatish
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

console.log('🤖 Bolalar ingliz tili boti (Firebase va uzluksiz Gemini AI bilan) muvaffaqiyatli ishga tushirildi...');
