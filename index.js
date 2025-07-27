require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error("Bot tokeni .env faylida topilmadi!");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// --- Sozlamalar ---
const WINDOW_SIZE_MINUTES = 20; // Qidiriladigan zona hajmi (daqiqa)
const TOP_ZONES_TO_SHOW = 3;    // Foydalanuvchiga ko'rsatiladigan eng yaxshi zonalar soni

// Foydalanuvchining holati va ma'lumotlarini saqlash uchun
const userSessions = {};

// Klaviatura tugmalari
const mainMenuKeyboard = {
    keyboard: [[{ text: '📊 Ma'lumot Kiritish' }]],
    resize_keyboard: true,
};

const dataEntryKeyboard = {
    keyboard: [[{ text: '🚫 Bekor Qilish' }]],
    resize_keyboard: true,
};

console.log("Yakuniy versiya (/tahlil buyrug'i bilan) ishga tushdi...");

// /start buyrug'i
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    delete userSessions[chatId];
    bot.sendMessage(chatId, "Assalomu alaykum! Men Avtomatik Zona Qidiruvchi Botiman. Tahlilni boshlash uchun quyidagi tugmani bosing:", { reply_markup: mainMenuKeyboard });
});

// /tahlil buyrug'i analizni boshlash uchun
bot.onText(/\/tahlil/, (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions[chatId];

    if (session && session.state === 'accumulating_data' && session.data && session.data.trim() !== '') {
        bot.sendMessage(chatId, "⏳ Ma'lumotlar qabul qilindi. Tahlil qilmoqdaman...", { reply_markup: { remove_keyboard: true } });
        
        try {
            const spikes = parseSpikeData(session.data);
            if (spikes.length < 10) throw new Error("Tahlil uchun ma'lumotlar juda kam.");

            const report = findAndAnalyzeBestZones(spikes);
            bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });

        } catch (error) {
            bot.sendMessage(chatId, `❗️ Tahlil vaqtida xatolik: ${error.message}`);
        } finally {
            delete userSessions[chatId];
            bot.sendMessage(chatId, "Yangi tahlilni boshlash uchun quyidagi tugmani bosing:", { reply_markup: mainMenuKeyboard });
        }
    } else {
        bot.sendMessage(chatId, "Tahlil qilish uchun avval '📊 Ma'lumot Kiritish' tugmasini bosing va spayklar ro'yxatini yuboring.");
    }
});


// Boshqa barcha matnli xabarlarni boshqarish
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Agar xabar /start yoki /tahlil buyrug'i bo'lsa, bu yerda ishlov berilmaydi
    if (text.startsWith('/')) return;

    const session = userSessions[chatId] || {};

    // Tugma bosishlarini boshqarish
    if (text === '📊 Ma'lumot Kiritish') {
        session.state = 'accumulating_data';
        session.data = ''; // Oldingi ma'lumotlarni tozalash
        userSessions[chatId] = session;
        bot.sendMessage(chatId, "✅ Jarayon boshlandi.\nEndi spayklar ro'yxatini bir yoki bir nechta xabarda yuborishingiz mumkin.\n\nBarcha ma'lumotlarni yuborib bo'lgach, `/tahlil` buyrug'ini yozing.", { reply_markup: dataEntryKeyboard });
        return;
    }
    
    if (text === '🚫 Bekor Qilish') {
        delete userSessions[chatId];
        bot.sendMessage(chatId, "Jarayon bekor qilindi.", { reply_markup: mainMenuKeyboard });
        return;
    }

    // Agar ma'lumot yig'ish holatida bo'lsa, xabarni qo'shish
    if (session.state === 'accumulating_data') {
        session.data += text + '\n';
        userSessions[chatId] = session;
    }
});


// --- Yordamchi Funksiyalar (o'zgarishsiz qoladi) ---

function parseSpikeData(rawData) {
    const spikes = [];
    const signalBlocks = rawData.split('Atharizz Signal Spike 📣').filter(block => block.trim() !== "");
    for (const block of signalBlocks) {
        const timeMatch = block.match(/Time\s*:\s*(\d{4}\.\d{2}\.\d{2}\s\d{2}:\d{2})/);
        if (timeMatch) {
            const dateTimeString = timeMatch[1].replace(' ', 'T').replace(/\./g, '-');
            spikes.push({ timestamp: new Date(dateTimeString) });
        }
    }
    return spikes;
}

function findAndAnalyzeBestZones(spikes) {
    const minutesInDay = 24 * 60;
    const minuteCounts = Array(minutesInDay).fill(0);
    for (const spike of spikes) {
        const minuteOfDay = spike.timestamp.getHours() * 60 + spike.timestamp.getMinutes();
        minuteCounts[minuteOfDay]++;
    }

    const windowScores = [];
    let currentWindowSum = 0;
    for (let i = 0; i < WINDOW_SIZE_MINUTES; i++) {
        currentWindowSum += minuteCounts[i];
    }
    windowScores.push({ score: currentWindowSum, startMinute: 0 });

    for (let i = 1; i <= minutesInDay - WINDOW_SIZE_MINUTES; i++) {
        currentWindowSum = currentWindowSum - minuteCounts[i - 1] + minuteCounts[i + WINDOW_SIZE_MINUTES - 1];
        windowScores.push({ score: currentWindowSum, startMinute: i });
    }

    windowScores.sort((a, b) => b.score - a.score);

    const topZones = [];
    for (const zone of windowScores) {
        if (topZones.length >= TOP_ZONES_TO_SHOW) break;
        const isOverlapping = topZones.some(existingZone => Math.abs(existingZone.startMinute - zone.startMinute) < WINDOW_SIZE_MINUTES);
        if (!isOverlapping && zone.score > 0) {
            topZones.push(zone);
        }
    }

    if (topZones.length === 0) return "Tahlil natijasida barqaror zona topilmadi.";

    const formatTime = (minuteOfDay) => {
        const hour = Math.floor(minuteOfDay / 60);
        const minute = minuteOfDay % 60;
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    };

    const medals = ['🥇 Oltin Zona', '🥈 Kumush Zona', '🥉 Bronza Zona'];
    let report = `*🤖 HAFTALIK TAHLIL: ENG SAMARALI ZONALAR TOPILDI! 🤖*\n\n`;
    report += `Tahlil qilingan *${spikes.length} ta* spike asosida, hafta davomida eng ko'p natija bergan *${WINDOW_SIZE_MINUTES} daqiqalik* vaqt zonalari:\n\n`;

    for (let i = 0; i < topZones.length; i++) {
        const zone = topZones[i];
        const startTime = formatTime(zone.startMinute);
        const endTime = formatTime(zone.startMinute + WINDOW_SIZE_MINUTES);
        report += `*${medals[i]}: \`${startTime} - ${endTime}\` (Server vaqti)*\n`;
        report += `   • *Statistika:* Bu vaqt oralig'i hafta davomida jami *${zone.score} ta* spike bergan.\n`;
        report += `   • *Bugungi Kun Uchun Qo'llanma:* Bugun ushbu vaqtda *maksimal darajada hushyor bo'ling*. Zona ichida birinchi spike sodir bo'lgach, keyingisi qisqa vaqt ichida (\`5-10 daqiqa\`) sodir bo'lish ehtimoli statistik jihatdan yuqori.\n\n`;
    }

    report += `_❗️ Eslatma: Bu tahlil faqat o'tmishdagi ma'lumotlarga asoslangan. Har bir savdodan oldin risk-menejment qoidalariga (minimal lot, Stop-Loss) qat'iy rioya qiling!_`;
    
    return report;
}