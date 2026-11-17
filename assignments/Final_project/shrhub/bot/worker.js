// SHRhub: сервер бота и общая база для Cloudflare Workers.
// Переменные (Settings → Variables and Secrets):
//   BOT_TOKEN       токен от @BotFather (тип Secret)
//   WEBHOOK_SECRET  любая длинная случайная строка из букв и цифр (тип Secret)
//   APP_URL         адрес игры, например https://lively-moon-1a1c.shrhub.workers.dev
//   SUPPORT_CHAT_ID твой Telegram ID или id группы поддержки (необязательно)
// Привязки (Settings → Bindings):
//   DB              база Cloudflare D1 — общий профиль, прогнозы, чаты и кланы
//   PAYMENTS        KV для истории оплат (необязательно, D1 и так хранит оплаты)

const MONTH = 2592000; // 30 дней: единственный период подписки, который принимает Telegram
const PRODUCTS = {
  tier1: { title: 'SHRhub Mini', stars: 55, sub: true, tier: 1 },
  tier2: { title: 'SHRhub Plus', stars: 105, sub: true, tier: 2 },
  tier3: { title: 'SHRhub Pro', stars: 210, sub: true, tier: 3 },
  tier4: { title: 'SHRhub Max', stars: 370, sub: true, tier: 4 },
  tier5: { title: 'SHRhub Ultra', stars: 525, sub: true, tier: 5 },
  coin: { title: 'Отдельная монета', stars: 155, sub: true, coin: true },
  pass: { title: 'Клубный пропуск недели', stars: 99, pass: true },
  save: { title: 'Спасение серии', stars: 50, save: true },
  codes: { title: '+3 кода-приглашения', stars: 75, codes: true },
  badge: { title: 'Значок профиля', stars: 100, own: 'badge' },
  // Места в клане складываются с теми, что уже есть. Чем больше пачка,
  // тем дешевле место: кто зовёт тысячу человек, платит не в десять раз
  // больше того, кто зовёт сотню.
  cap100: { title: '+100 мест в клане', stars: 150, seats: 100 },
  cap500: { title: '+500 мест в клане', stars: 500, seats: 500 },
  cap1000: { title: '+1000 мест в клане', stars: 800, seats: 1000 },
  cap5000: { title: '+5000 мест в клане', stars: 2500, seats: 5000 },
  cap10000: { title: '+10000 мест в клане', stars: 4000, seats: 10000 },
  // Старая покупка: оставлена, чтобы прошлые оплаты не падали с ошибкой
  cap: { title: '+30 мест в клане', stars: 300, seats: 30 },
  emb: { title: 'Эмблема клана: своя картинка', stars: 150, own: 'emb' },
  banner: { title: 'Боевое знамя клана', stars: 150, own: 'banner' },
  frame: { title: 'Золотая рамка аватара', stars: 50, own: 'frame' },
  plat: { title: 'Тема «Платина»', stars: 100, own: 'plat' },
  emer: { title: 'Тема «Изумруд»', stars: 100, own: 'emer' },
  rbskin: { title: 'Облики робота', stars: 75, own: 'rbskin' },
  felt: { title: 'Чёрно-золотое сукно', stars: 100, own: 'felt' },
  shovel: { title: 'Золотая лопата', stars: 50, own: 'shovel' },
  gm: { title: 'Золотое сообщение', stars: 25, gm: true },
  // Голос в чате — одноразовая мелочь. Платят не за доступ к людям, а за то,
  // чтобы спамить стало дороже, чем оно того стоит: читать можно и без этого.
  chat: { title: 'Голос в чате, навсегда', stars: 1, chatOn: true },
  // Продвижение ролика: место в начале ленты на 7 дней
  boost: { title: 'Продвижение ролика, 7 дней', stars: 150, boost: true },
  // Место на виду. Это рекламное место, а не победа: в таблице оно подписано
  // «место оплачено» и стоит над настоящим рейтингом, не занимая первую строчку.
  spot: { title: 'Место на виду, 7 дней', stars: 250, spot: 'player' },
  cspot: { title: 'Место на виду для клана, 7 дней', stars: 400, spot: 'clan' },
};

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
// Проверка подписи Telegram: без неё любой мог бы выдать себя за другого игрока.
export async function verifyInitData(initData, token) {
  const p = new URLSearchParams(initData || '');
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac('WebAppData', token);
  if (hex(await hmac(secret, check)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}
// Комиссия клуба с подарка — в звёздах. 4 звезды это примерно пять центов
// того, что доходит до нас после магазина приложений. Владелец может менять.
const GIFT_FEE = 4;
async function giftFee(env) {
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='gift_fee'").first();
    const n = r && r.v ? Number(r.v) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : GIFT_FEE;
  } catch (e) { return GIFT_FEE; }
}
// Каталог подарков Telegram. Держим копию 10 минут: список меняется редко,
// а дёргать Telegram на каждый показ незачем.
async function giftList(env) {
  try {
    const c = await env.DB.prepare("SELECT v FROM settings WHERE k='gifts_cache'").first();
    if (c && c.v) {
      const o = JSON.parse(c.v);
      if (o && o.at && NOW() - o.at < 600000 && Array.isArray(o.list)) return o.list;
    }
  } catch (e) {}
  const r = await tg(env, 'getAvailableGifts', {});
  const raw = (r && r.ok && r.result && r.result.gifts) || [];
  const list = raw
    // Подарки «только для Premium» бот отправить не может — у ботов нет Premium
    .filter((g) => !g.is_premium && (g.remaining_count === undefined || g.remaining_count > 0))
    .map((g) => ({
      id: String(g.id), stars: g.star_count | 0,
      left: g.remaining_count === undefined ? null : g.remaining_count | 0,
      th: (g.sticker && g.sticker.thumbnail && g.sticker.thumbnail.file_id)
        || (g.sticker && g.sticker.thumb && g.sticker.thumb.file_id) || '',
    }))
    .sort((a, b) => a.stars - b.stars)
    .slice(0, 30);
  try {
    await env.DB.prepare(
      `INSERT INTO settings(k,v) VALUES('gifts_cache',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
      .bind(JSON.stringify({ at: NOW(), list })).run();
  } catch (e) {}
  return list;
}

const pairOf = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
// Ссылка на аватар, если он у человека есть. Номер версии в адресе — чтобы
// после смены картинки браузер взял новую, а не показывал старую из кэша.
const avLink = (origin, p) =>
  // Даже без своей картинки даём ссылку: сервер попробует взять фото из Telegram
  p && p.id ? `${origin}/av?uid=${p.id}&v=${(p.avimg || p.avurl || '').length}` : '';
// Картинку в приложении нельзя попросить с подписью Telegram в заголовке: тег
// <img> её не пошлёт. Поэтому на каждое вложение выдаём ссылку, подписанную для
// конкретного зрителя, — чужую подобрать нельзя, а токен бота никуда не уходит.
async function mediaSig(token, id, uid, kind) {
  return hex(await hmac(token, `${id}:${uid}:${kind}`)).slice(0, 24);
}
async function mediaUrl(env, origin, id, uid, kind) {
  return `${origin}/pmfile?id=${id}&u=${uid}&k=${kind}&s=${await mediaSig(env.BOT_TOKEN, id, uid, kind)}`;
}

// Письмо о новом сообщении: с кнопкой, которая открывает ту же переписку в
// приложении, и с пометкой, к какой ветке относится, чтобы ответ прямо из
// Telegram дошёл адресату.
// Подарок оплачен. Дальше бот отправляет его со своего баланса. Если на
// балансе не хватило или подарок разобрали — возвращаем звёзды целиком,
// вместе с комиссией: за несостоявшийся подарок брать с человека нечего.
async function sendPresent(env, msg, sp, parts) {
  const from = Number(parts[0]) || msg.from.id;
  const giftId = parts[2] || '';
  const to = Number(parts[3]) || 0;
  const stars = Number(parts[4]) || 0;
  const fee = Number(parts[5]) || 0;
  const chat = msg.chat.id;
  const db = await ensure(env);
  let row = null;
  if (db) {
    const ins = await env.DB.prepare(
      `INSERT INTO pgifts(uid,peer,gift,stars,fee,at,state) VALUES(?,?,?,?,?,?,'paid')`)
      .bind(from, to, giftId, stars, fee, NOW()).run();
    row = (ins.meta && ins.meta.last_row_id) || 0;
  }
  const fail = async (why) => {
    if (db && row) {
      await env.DB.prepare("UPDATE pgifts SET state='refund', note=? WHERE id=?")
        .bind(String(why).slice(0, 180), row).run();
    }
    let back = false;
    try {
      const r = await tg(env, 'refundStarPayment', {
        user_id: from, telegram_payment_charge_id: sp.telegram_payment_charge_id });
      back = !!(r && r.ok);
    } catch (e) {}
    await tg(env, 'sendMessage', { chat_id: chat, text: back
      ? `Подарок отправить не вышло: ${why}\n\nЗвёзды вернулись тебе полностью, вместе с комиссией клуба.`
      : `Подарок отправить не вышло: ${why}\n\nВернуть звёзды автоматически не получилось — напиши в поддержку, разберёмся вручную.` });
    await tellOwner(env, `⚠️ Подарок не ушёл (id ${from} → ${to}): ${why}. Возврат: ${back ? 'да' : 'НЕТ'}`);
  };
  // Проверяем баланс заранее: отправка без звёзд всё равно сорвётся
  try {
    const b = await tg(env, 'getMyStarBalance', {});
    const have = b && b.ok && b.result ? (b.result.amount | 0) : null;
    if (have !== null && have < stars) return await fail('у клуба не хватило звёзд на балансе');
  } catch (e) {}
  let note = '';
  if (db) {
    try {
      const n = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(`gnote:${from}:${to}`).first();
      note = n && n.v ? String(n.v).slice(0, 120) : '';
      await env.DB.prepare('DELETE FROM settings WHERE k=?').bind(`gnote:${from}:${to}`).run();
    } catch (e) {}
  }
  const me = db ? await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(from).first() : null;
  const who = (me && me.nick) || 'участник клуба';
  const text = `Подарок от ${who} из SHRhub${note ? `\n${note}` : ''}`.slice(0, 255);
  let r = null;
  try { r = await tg(env, 'sendGift', { user_id: to, gift_id: giftId, text }); } catch (e) {}
  if (!r || !r.ok) {
    const why = (r && r.description) || 'Telegram отказал';
    return await fail(/not enough stars/i.test(why) ? 'у клуба не хватило звёзд на балансе'
      : /GIFT_INVALID/i.test(why) ? 'этот подарок закончился' : why);
  }
  if (db && row) await env.DB.prepare("UPDATE pgifts SET state='sent' WHERE id=?").bind(row).run();
  await tg(env, 'sendMessage', { chat_id: chat,
    text: `🎁 Подарок отправлен. Он уже у получателя в профиле Telegram.` });
  await tellOwner(env, `🎁 Подарок: id ${from} → ${to}, ${stars} ⭐ + ${fee} ⭐ клубу`);
  if (db) {
    await pmPut(env, from, to, `🎁 ${who} отправил тебе подарок${note ? `: ${note}` : ''}`, who);
  }
}

// Имя бота нужно, чтобы собрать ссылку-приглашение. Спрашиваем у Telegram
// один раз в сутки: оно не меняется.
// Выключенные разделы. Читаем часто, поэтому коротко и без лишних запросов.
async function sectionsOff(env) {
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='sections'").first();
    const o = r && r.v ? JSON.parse(r.v) : [];
    return Array.isArray(o) ? o : [];
  } catch (e) { return []; }
}

async function botName(env) {
  try {
    const c = await env.DB.prepare("SELECT v FROM settings WHERE k='botname'").first();
    if (c && c.v) {
      const o = JSON.parse(c.v);
      if (o && o.at && NOW() - o.at < 86400000 && o.n) return o.n;
    }
  } catch (e) {}
  try {
    const r = await tg(env, 'getMe', {});
    const n = r && r.ok && r.result && r.result.username;
    if (!n) return '';
    await env.DB.prepare(
      "INSERT INTO settings(k,v) VALUES('botname',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .bind(JSON.stringify({ at: NOW(), n })).run();
    return n;
  } catch (e) { return ''; }
}

async function ownerNick(env) {
  const id = Number(env.OWNER_ID) || 0;
  if (!id) return '';
  try {
    const r = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(id).first();
    return (r && r.nick) || '';
  } catch (e) { return ''; }
}

async function pmNotify(env, to, fromId, fromName, text, media, origin) {
  const MED = { photo: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'],
    voice: ['sendVoice', 'voice'], audio: ['sendAudio', 'audio'], document: ['sendDocument', 'document'] };
  // Адрес сервера обязателен: без него приложение, открытое впервые, не знает,
  // куда стучаться, и переписки не увидит.
  const api = origin || env.API_URL || '';
  const app = env.APP_URL
    ? `${env.APP_URL}${env.APP_URL.includes('?') ? '&' : '?'}` +
      (api ? `api=${encodeURIComponent(api)}&` : '') + `pm=${fromId}`
    : '';
  const kb = app ? { inline_keyboard: [[{ text: '💬 Открыть переписку', web_app: { url: app } }]] } : undefined;
  // Переписка живёт в приложении, а не в боте. Бот только сообщает, что
  // написали, — без текста и без вложений: читать и отвечать идут в SHRhub.
  // Кто прямо сейчас в приложении, тому бот не пишет вовсе: он увидит
  // сообщение сразу, а лишний звонок от бота только раздражает.
  try {
    const p = await env.DB.prepare('SELECT seen FROM players WHERE id=?').bind(to).first();
    if (p && NOW() - (p.seen || 0) < 45000) return;
  } catch (e) {}
  const what = media && media.kind === 'photo' ? 'прислал(а) фото'
    : media && media.kind === 'video' ? 'прислал(а) видео'
    : media && (media.kind === 'voice' || media.kind === 'audio') ? 'прислал(а) голосовое'
    : 'написал(а) тебе';
  const cap = `✉️ ${fromName} ${what} в SHRhub`;
  let r = null;
  try {
    r = await tg(env, 'sendMessage', { chat_id: to, text: cap, reply_markup: kb });
  } catch (e) { return; }
  const mid = r && r.ok && r.result && r.result.message_id;
  if (!mid) return;
  try {
    await env.DB.prepare('INSERT OR REPLACE INTO pmlink(mid,uid,peer,at) VALUES(?,?,?,?)')
      .bind(mid, to, fromId, NOW()).run();
    if (Math.random() < 0.05)
      await env.DB.prepare('DELETE FROM pmlink WHERE at < ?').bind(NOW() - 30 * 86400000).run();
  } catch (e) {}
}
// Положить сообщение в ветку. Возвращает true, если получилось.
async function pmPut(env, from, to, text, fromName, origin) {
  await env.DB.prepare('INSERT INTO pm(pair,uid,peer,text,at,seen,kind) VALUES(?,?,?,?,?,0,?)')
    .bind(pairOf(from, to), from, to, text, NOW(), 'text').run();
  const peer = await env.DB.prepare('SELECT seen FROM players WHERE id=?').bind(to).first();
  if (!peer || !peer.seen || NOW() - peer.seen > 60000) {
    await pmNotify(env, to, from, fromName || 'Участник клуба', text, null, origin);
  }
  return true;
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const json = (data, status, cors) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...cors } });

// ---------- база ----------
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY, nick TEXT, av TEXT, lang INTEGER DEFAULT 0,
    tier INTEGER DEFAULT 0, tier_until INTEGER DEFAULT 0,
    extra TEXT DEFAULT '[]', owned TEXT DEFAULT '{}',
    saves INTEGER DEFAULT 0, codes INTEGER DEFAULT 0, gm INTEGER DEFAULT 0,
    pass_until INTEGER DEFAULT 0,
    pts INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, best INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0, wins INTEGER DEFAULT 0,
    clan INTEGER DEFAULT 0, state TEXT, seen INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS preds(
    uid INTEGER, sym TEXT, hour INTEGER, dir INTEGER, k REAL DEFAULT 0, at INTEGER,
    PRIMARY KEY(uid, sym, hour))`,
  `CREATE INDEX IF NOT EXISTS preds_hour ON preds(sym, hour)`,
  `CREATE TABLE IF NOT EXISTS msgs(
    id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, uid INTEGER,
    nick TEXT, av TEXT, text TEXT, gold INTEGER DEFAULT 0, at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS msgs_room ON msgs(room, id)`,
  `CREATE TABLE IF NOT EXISTS clans(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, emb TEXT,
    cap INTEGER DEFAULT 20, owner INTEGER, tr INTEGER DEFAULT 0, at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS pf(
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, sym TEXT, usd REAL, price REAL, at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS pf_uid ON pf(uid)`,
  `CREATE TABLE IF NOT EXISTS flags(uid INTEGER PRIMARY KEY, as_player INTEGER DEFAULT 0)`,
  // Полный доступ, выданный владельцем вручную: другу, активному игроку, победителю.
  // until = 0 выключено, until = -1 бессрочно, иначе срок в миллисекундах.
  // Напоминания. tz — сдвиг местного времени игрока от UTC в минутах (Киев зимой 120).
  // mh/eh — час утреннего и вечернего напоминания по его местному времени.
  // lastm/laste — день последней отправки, чтобы не писать дважды.
  `CREATE TABLE IF NOT EXISTS notif(
    uid INTEGER PRIMARY KEY, on_ INTEGER DEFAULT 0, tz INTEGER DEFAULT 0,
    mh INTEGER DEFAULT 12, eh INTEGER DEFAULT 20, lastm TEXT, laste TEXT)`,
  // Видимость в списке «кто сейчас в игре». hidden=1 — другие игроки не видят,
  // владелец платформы видит всегда: об этом прямо написано в самой игре.
  `CREATE TABLE IF NOT EXISTS prefs(uid INTEGER PRIMARY KEY, hidden INTEGER DEFAULT 0)`,
  // Оплаченное место на виду: кто, до какого числа, сколько заплатил
  `CREATE TABLE IF NOT EXISTS spots(
    kind TEXT, id INTEGER, until INTEGER, stars INTEGER, at INTEGER,
    PRIMARY KEY(kind, id))`,
  // Настройки клуба, которые меняет владелец: сейчас это скидка на звёзды
  `CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`,
  // Видео. Сами файлы лежат в Telegram, мы храним только file_id — пересылка по
  // нему не имеет ограничения по размеру, поэтому хранилище нам не нужно.
  `CREATE TABLE IF NOT EXISTS vids(
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, title TEXT,
    file_id TEXT, thumb TEXT, dur INTEGER, size INTEGER,
    at INTEGER, views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0,
    boost_until INTEGER DEFAULT 0, boost_stars INTEGER DEFAULT 0,
    flags INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0)`,
  // Кто что смотрел и лайкал: без этого просмотры накрутит любой, обновляя экран
  // Звонки. Сам голос и видео идут напрямую между телефонами и шифруются —
  // через нас проходят только служебные записки «кто кому звонит» и адреса
  // для соединения. Записей разговоров нет и быть не может.
  `CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, host INTEGER, video INTEGER,
    at INTEGER, ended INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS cmem(call TEXT, uid INTEGER, state TEXT, at INTEGER,
    seen INTEGER DEFAULT 0, msg INTEGER DEFAULT 0, cam INTEGER DEFAULT 1, PRIMARY KEY(call, uid))`,
  `CREATE INDEX IF NOT EXISTS cmem_uid ON cmem(uid, state)`,
  `CREATE TABLE IF NOT EXISTS csig(id INTEGER PRIMARY KEY AUTOINCREMENT, call TEXT,
    src INTEGER, dst INTEGER, kind TEXT, data TEXT, at INTEGER)`,
  // Отметки людей на фото и видео. shown — отмеченный сам решил показать
  // публикацию у себя на странице.
  // Реакции смайликом на сообщения: kind 'pm' — личные, 'msg' — общие чаты и кланы
  `CREATE TABLE IF NOT EXISTS reacts(kind TEXT, mid INTEGER, uid INTEGER, emo TEXT, at INTEGER,
    PRIMARY KEY(kind, mid, uid))`,
  `CREATE TABLE IF NOT EXISTS vtags(vid INTEGER, uid INTEGER, shown INTEGER DEFAULT 0, at INTEGER,
    PRIMARY KEY(vid, uid))`,
  // Голосования в клане и кто за что голосовал (один голос с человека)
  `CREATE TABLE IF NOT EXISTS cpolls(id INTEGER PRIMARY KEY AUTOINCREMENT, clan INTEGER, q TEXT,
    opts TEXT, by INTEGER, at INTEGER, closed INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS cvotes(poll INTEGER, uid INTEGER, opt INTEGER, PRIMARY KEY(poll, uid))`,
  // Кого создатель клана выгнал и не пускает обратно
  `CREATE TABLE IF NOT EXISTS cbans(clan INTEGER, uid INTEGER, at INTEGER, note TEXT, PRIMARY KEY(clan, uid))`,
  `CREATE TABLE IF NOT EXISTS vseen(vid INTEGER, uid INTEGER, liked INTEGER DEFAULT 0,
    PRIMARY KEY(vid, uid))`,
  // Подписки: односторонние, как в инстаграме. Взаимности не требуем — так проще
  // и никто никого не ждёт. Нужны, чтобы не потерять человека в общем списке.
  `CREATE TABLE IF NOT EXISTS follows(
    uid INTEGER, target INTEGER, at INTEGER, PRIMARY KEY(uid, target))`,
  // Личная переписка с владельцем хранится в базе, а не только улетает в Telegram:
  // человек может прочитать её утром прямо в приложении, и ничего не теряется.
  // dir: in — письмо человеку, out — его ответ.
  `CREATE TABLE IF NOT EXISTS dms(
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, dir TEXT, text TEXT, at INTEGER, seen INTEGER DEFAULT 0)`,
  // Обращения в поддержку хранятся здесь, а не только улетают в личку владельцу:
  // без истории нельзя ни разобраться в споре, ни обосновать блокировку.
  // Личная переписка между людьми. pair — пара собеседников в порядке возрастания
  // id, чтобы обе стороны видели одну и ту же ветку, а не две разные.
  `CREATE TABLE IF NOT EXISTS pm(
    id INTEGER PRIMARY KEY AUTOINCREMENT, pair TEXT, uid INTEGER, peer INTEGER,
    text TEXT, at INTEGER, seen INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS pm_pair ON pm(pair, id)`,
  `CREATE INDEX IF NOT EXISTS pm_new ON pm(peer, seen)`,
  // Предложения участников: что добавить в клуб. Голос — один с человека.
  `CREATE TABLE IF NOT EXISTS ideas(
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, text TEXT, at INTEGER,
    votes INTEGER DEFAULT 0, status TEXT DEFAULT '', note TEXT)`,
  `CREATE TABLE IF NOT EXISTS ivotes(iid INTEGER, uid INTEGER, PRIMARY KEY(iid, uid))`,
  // Скрытый у себя разговор. Храним время: если человек напишет снова,
  // ветка вернётся — удалением чата нельзя заставить кого-то замолчать.
  `CREATE TABLE IF NOT EXISTS pmhide(uid INTEGER, pair TEXT, at INTEGER, PRIMARY KEY(uid, pair))`,
  // Закреплённый чат: у каждого свой список, закреп не виден собеседнику
  `CREATE TABLE IF NOT EXISTS pmpin(uid INTEGER, pair TEXT, at INTEGER, PRIMARY KEY(uid, pair))`,
  // Подарки между участниками: кто, кому, что, сколько заплатил и сколько
  // из этого осталось клубу. Нужно, чтобы считать комиссию честно.
  // Заказы: человек описывает работу, владелец называет цену. Денег
  // приложение не трогает — только задача, цена и на каком она шаге.
  `CREATE TABLE IF NOT EXISTS orders(
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, title TEXT, text TEXT,
    budget TEXT, at INTEGER, upd INTEGER, state TEXT DEFAULT 'new',
    price TEXT, note TEXT, paid INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS orders_uid ON orders(uid, id)`,
  `CREATE TABLE IF NOT EXISTS pgifts(
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, peer INTEGER, gift TEXT,
    stars INTEGER, fee INTEGER, at INTEGER, state TEXT DEFAULT 'paid', note TEXT)`,
  // Какое письмо бота к какой ветке относится: нужно, чтобы ответ прямо из
  // Telegram попал тому, кому человек отвечает, а не в поддержку.
  `CREATE TABLE IF NOT EXISTS pmlink(mid INTEGER, uid INTEGER, peer INTEGER, at INTEGER,
    PRIMARY KEY(uid, mid))`,
  `CREATE TABLE IF NOT EXISTS tickets(
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, text TEXT, at INTEGER, done INTEGER DEFAULT 0)`,
  // Лента новостей. Храним только заголовок, источник и ссылку: текст статьи
  // чужой, копировать его нельзя. Заголовок со ссылкой — это сноска, а не перепечатка.
  `CREATE TABLE IF NOT EXISTS feed(
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, url TEXT UNIQUE, src TEXT, at INTEGER)`,
  // Лента событий для владельца: кто пришёл, кто что сделал. Сами суммы из
  // записей SHR сюда не попадают — это чужие деньги, а не статистика клуба.
  `CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, kind TEXT, note TEXT, at INTEGER)`,
  // Новости от владельца: показываем в игре один раз и шлём в утреннем письме
  `CREATE TABLE IF NOT EXISTS ann(
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, at INTEGER, sent INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS gifts(
    uid INTEGER PRIMARY KEY, until INTEGER DEFAULT 0, note TEXT, by INTEGER, at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS pays(
    charge TEXT PRIMARY KEY, uid INTEGER, product TEXT, arg TEXT, stars INTEGER, at INTEGER)`,
  // Приглашения. Код принадлежит тому, у кого он появился; uid заполняется,
  // когда по этому коду правда пришёл живой человек.
  `CREATE TABLE IF NOT EXISTS invites(
    code TEXT PRIMARY KEY, owner INTEGER, uid INTEGER DEFAULT 0, at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS invites_owner ON invites(owner)`,
];
let READY = false;
// Новые колонки к таблицам, которые уже созданы у работающих игроков.
// Если колонка есть — SQLite ругается, и это нормально: просто идём дальше.
const PATCH = [
  // Карточка участника. Телефон кладём только тот, что человек сам передал
  // через Telegram: набранный руками номер может быть чужим.
  `ALTER TABLE players ADD COLUMN realname TEXT`,
  `ALTER TABLE players ADD COLUMN phone TEXT`,
  `ALTER TABLE players ADD COLUMN bday TEXT`,
  `ALTER TABLE players ADD COLUMN city TEXT`,
  `ALTER TABLE players ADD COLUMN showphone INTEGER DEFAULT 0`,
  `ALTER TABLE players ADD COLUMN showbday INTEGER DEFAULT 1`,
  // Аватар человека: ссылка из Telegram и своя загруженная картинка.
  // Без этого в списках у всех одинаковая шляпа, и людей не отличить.
  `ALTER TABLE players ADD COLUMN avurl TEXT`,
  `ALTER TABLE players ADD COLUMN avimg TEXT`,
  `ALTER TABLE pm ADD COLUMN kind TEXT DEFAULT 'text'`,
  `ALTER TABLE pm ADD COLUMN file_id TEXT`,
  `ALTER TABLE pm ADD COLUMN thumb TEXT`,
  `ALTER TABLE pm ADD COLUMN dur INTEGER DEFAULT 0`,
  `ALTER TABLE pm ADD COLUMN size INTEGER DEFAULT 0`,
  'ALTER TABLE pf ADD COLUMN cur TEXT',
  'ALTER TABLE pf ADD COLUMN amt REAL',
  'ALTER TABLE pf ADD COLUMN rate REAL',
  "ALTER TABLE pf ADD COLUMN k TEXT DEFAULT 'b'",
  'ALTER TABLE players ADD COLUMN no INTEGER',
  'ALTER TABLE players ADD COLUMN rep INTEGER DEFAULT 0',
  'ALTER TABLE players ADD COLUMN repday TEXT',
  'ALTER TABLE players ADD COLUMN repn INTEGER DEFAULT 0',
  'ALTER TABLE players ADD COLUMN trial INTEGER DEFAULT 0',
  'ALTER TABLE players ADD COLUMN banned INTEGER DEFAULT 0',
  'ALTER TABLE players ADD COLUMN ban_note TEXT',
  'ALTER TABLE players ADD COLUMN chat_ok INTEGER DEFAULT 0',
  "ALTER TABLE pf ADD COLUMN m TEXT DEFAULT 'sp'",
  'ALTER TABLE pf ADD COLUMN note TEXT',
  // Картинка-эмблема клана и купленные места, которые ждут своего клана
  'ALTER TABLE clans ADD COLUMN embimg TEXT',
  'ALTER TABLE players ADD COLUMN capbuy INTEGER DEFAULT 0',
  // Когда сообщение исправили: показываем «изменено», чтобы собеседник знал,
  // что текст уже не тот, который он прочитал сначала
  'ALTER TABLE pm ADD COLUMN edited INTEGER DEFAULT 0',
  // Два отдельных переключателя приватности: hidden — «не показывать, что я в
  // сети», noseen — «не показывать, когда я был последний раз»
  'ALTER TABLE prefs ADD COLUMN noseen INTEGER DEFAULT 0',
  // Публикации в профиле: reel — ролик для ленты, video — видео в профиле,
  // photo — фото в профиле. Старые записи — ролики ленты.
  "ALTER TABLE vids ADD COLUMN kind TEXT DEFAULT 'reel'",
  // Кто может звонить: 0 — все, 1 — только те, на кого я подписан, 2 — никто
  'ALTER TABLE prefs ADD COLUMN callwho INTEGER DEFAULT 0',
  // Истории на сутки: until — когда исчезнет, ad — помечено «Реклама»,
  // media — фото это или видео, links — отметки ссылкой на Telegram (@имя)
  'ALTER TABLE vids ADD COLUMN until INTEGER DEFAULT 0',
  // Когда человек посмотрел историю: автор видит список, кто и когда
  'ALTER TABLE vseen ADD COLUMN at INTEGER DEFAULT 0',
  // Подписка теперь через заявку: ok=0 — ждёт подтверждения, ok=1 — принята.
  // Старые подписки остаются принятыми.
  'ALTER TABLE follows ADD COLUMN ok INTEGER DEFAULT 1',
  // Повторные «звонит» в чат бота, пока на звонок не ответили
  'ALTER TABLE cmem ADD COLUMN pings INTEGER DEFAULT 0',
  'ALTER TABLE cmem ADD COLUMN pingat INTEGER DEFAULT 0',
  'ALTER TABLE cmem ADD COLUMN extra TEXT',
  // Ник у каждого свой: nkey — ник без регистра и пробелов, по нему и сверяем
  'ALTER TABLE players ADD COLUMN nkey TEXT',
  'CREATE INDEX IF NOT EXISTS players_nkey ON players(nkey)',
  'ALTER TABLE vids ADD COLUMN ad INTEGER DEFAULT 0',
  'ALTER TABLE vids ADD COLUMN media TEXT',
  'ALTER TABLE vids ADD COLUMN links TEXT',
  // Клан: описание и закреплённое сообщение
  'ALTER TABLE clans ADD COLUMN descr TEXT',
  'ALTER TABLE clans ADD COLUMN pin INTEGER DEFAULT 0',
  // Год рождения — для статистики возрастов. Другим участникам не показывается
  'ALTER TABLE players ADD COLUMN byear INTEGER DEFAULT 0',
  // Когда человек впервые пришёл в клуб — по этому считается его номер
  'ALTER TABLE players ADD COLUMN joined INTEGER DEFAULT 0',
  // Телефон, вписанный руками: пока не подтверждён кодом из SMS
  'ALTER TABLE players ADD COLUMN phone_ok INTEGER DEFAULT 0',
];
// Коды человека записываем за ним. Чужой код перехватить нельзя: если он уже
// есть в таблице, INSERT OR IGNORE оставляет прежнего владельца.
async function keepCodes(env, uid, list) {
  if (!Array.isArray(list) || !list.length) return;
  const have = await env.DB.prepare('SELECT COUNT(*) n FROM invites WHERE owner=?').bind(uid).first();
  let room = 200 - ((have && have.n) | 0);
  if (room <= 0) return;
  for (const raw of list.slice(0, 40)) {
    if (room <= 0) break;
    const c = String(raw || '').toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(c)) continue;
    try {
      await env.DB.prepare('INSERT OR IGNORE INTO invites(code,owner,uid,at) VALUES(?,?,0,?)')
        .bind(c, uid, NOW()).run();
      room--;
    } catch (e) {}
  }
}
// Человек открыл приложение по ссылке-приглашению. Код засчитываем один раз:
// свой собственный не считается, занятый не перебивается.
async function useCode(env, uid, raw) {
  const c = String(raw || '').toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(c)) return;
  const mine = await env.DB.prepare('SELECT code FROM invites WHERE uid=?').bind(uid).first();
  if (mine) return; // по одному приглашению на человека
  const row = await env.DB.prepare('SELECT owner,uid FROM invites WHERE code=?').bind(c).first();
  if (!row || row.uid || row.owner === uid) return;
  await env.DB.prepare('UPDATE invites SET uid=?,at=? WHERE code=? AND uid=0')
    .bind(uid, NOW(), c).run();
}
// Кто пришёл по моим ссылкам
async function myFriends(env, uid) {
  const r = await env.DB.prepare(
    `SELECT i.at at, p.id id, p.nick nick, p.av av FROM invites i
     JOIN players p ON p.id=i.uid WHERE i.owner=? AND i.uid>0
     ORDER BY i.at DESC LIMIT 50`).bind(uid).all();
  return (r.results || []).map((x) => ({ id: x.id, n: x.nick || '', f: x.av || '', at: x.at || 0 }));
}
// Кто пригласил этого человека: показываем ему «Тебя пригласил …», чтобы
// он знал, кому написать первым.
async function invitedBy(env, uid) {
  const r = await env.DB.prepare(
    `SELECT p.id id, p.nick nick, p.av av, p.avimg avimg, p.avurl avurl FROM invites i
     JOIN players p ON p.id=i.owner WHERE i.uid=? LIMIT 1`).bind(uid).first();
  return r || null;
}
// Строка чата без самой картинки — только ссылка на неё
function chatRow(origin, x) {
  return { id: x.id, uid: x.uid, nick: x.nick, av: x.av, text: x.text, gold: x.gold, at: x.at,
    avu: avLink(origin, { id: x.uid, avimg: x.avimg, avurl: x.avurl }) };
}
// Время последнего визита глазами другого человека. Владелец видит всё.
// «Не показывать визит» — не видно никогда. «Не показывать, что в сети» —
// не видно свежий визит: «был минуту назад» и есть «сейчас в сети».
function seenFor(own, hidden, noseen, seen) {
  if (own) return seen || 0;
  if (noseen) return 0;
  if (hidden && NOW() - (seen || 0) < 300000) return 0;
  return seen || 0;
}
async function usedCodes(env, uid) {
  const r = await env.DB.prepare('SELECT code FROM invites WHERE owner=? AND uid>0').bind(uid).all();
  return (r.results || []).map((x) => x.code);
}

// ---------- отдача файлов из Telegram ----------
// Тип файла определяем по расширению сами. Telegram часто называет любое
// видео «application/octet-stream», а айфон такое играть отказывается —
// из-за этого ролики в ленте не открывались ни у кого.
const EXT_TYPE = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  oga: 'audio/ogg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };
function fileType(path, upstream, fallback) {
  const ext = String(path || '').split('?')[0].split('.').pop().toLowerCase();
  if (EXT_TYPE[ext]) return EXT_TYPE[ext];
  if (upstream && !/octet-stream/i.test(upstream)) return upstream;
  return fallback;
}
// Айфон запрашивает видео кусками и ждёт ответа 206 с точными границами.
// Если Telegram на кусок ответил целым файлом, вырезаем кусок сами.
async function tgServe(env, req, path, fallback, cache) {
  const range = req.headers.get('range');
  const src = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`;
  const r = await fetch(src, range ? { headers: { range } } : undefined);
  if (!r.ok && r.status !== 206) return new Response('not found', { status: 404 });
  const h = {
    'content-type': fileType(path, r.headers.get('content-type'), fallback),
    'cache-control': cache, 'access-control-allow-origin': '*', 'accept-ranges': 'bytes',
  };
  if (r.status === 206 || !range) {
    const len = r.headers.get('content-length'); if (len) h['content-length'] = len;
    const cr = r.headers.get('content-range'); if (cr) h['content-range'] = cr;
    return new Response(r.body, { status: r.status, headers: h });
  }
  const buf = await r.arrayBuffer();
  const total = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let a = m[1] === '' || m[1] == null ? NaN : Number(m[1]);
  let b = m[2] === '' || m[2] == null ? NaN : Number(m[2]);
  if (isNaN(a) && !isNaN(b)) { a = Math.max(0, total - b); b = total - 1; } // «последние N байт»
  if (isNaN(a)) a = 0;
  if (isNaN(b) || b >= total) b = total - 1;
  if (a > b || a >= total) {
    return new Response('', { status: 416, headers: Object.assign(h, { 'content-range': `bytes */${total}` }) });
  }
  h['content-range'] = `bytes ${a}-${b}/${total}`;
  h['content-length'] = String(b - a + 1);
  return new Response(buf.slice(a, b + 1), { status: 206, headers: h });
}
// ---------- своё хранилище файлов (Cloudflare R2) ----------
// Если в Cloudflare к воркеру привязано хранилище R2 с именем MEDIA, фото,
// видео и голосовые хранятся у нас, а не в Telegram. Тогда файлы не пропадут,
// даже если с ботом что-то случится, и нет лимита Telegram в 20 МБ на отдачу.
// В базе такой файл записан как «r2:<ключ>». Без MEDIA всё работает по-старому.
function isR2(fid) { return typeof fid === 'string' && fid.startsWith('r2:'); }
async function putMedia(env, buf, type, prefix) {
  const key = `${prefix}/${NOW().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: type } });
  return 'r2:' + key;
}
async function r2Serve(env, req, fid, fallback, cache) {
  const key = fid.slice(3);
  const range = req.headers.get('range');
  const obj = await env.MEDIA.get(key, range ? { range: req.headers } : undefined);
  if (!obj) return new Response('not found', { status: 404 });
  const h = { 'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || fallback,
    'cache-control': cache, 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
  if (range && obj.range) {
    const off = obj.range.offset || 0, len = obj.range.length != null ? obj.range.length : obj.size - off;
    h['content-range'] = `bytes ${off}-${off + len - 1}/${obj.size}`;
    h['content-length'] = String(len);
    return new Response(obj.body, { status: 206, headers: h });
  }
  h['content-length'] = String(obj.size);
  return new Response(obj.body, { status: 200, headers: h });
}
async function dropMedia(env, ...fids) {
  if (!env.MEDIA) return;
  for (const f of fids) if (isR2(f)) { try { await env.MEDIA.delete(f.slice(3)); } catch (e) {} }
}
// Адреса для соединения звонка. STUN бесплатный, но через часть мобильных
// сетей напрямую не пробиться — тогда нужен TURN-ретранслятор. Он включается,
// если в Cloudflare заданы TURN_KEY_ID и TURN_KEY_TOKEN; без них звонки тоже
// работают, но у некоторых операторов могут не соединиться.
let ICE = null, ICEAT = 0;
async function iceServers(env) {
  const base = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return base;
  if (ICE && NOW() - ICEAT < 3600000) return ICE;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 14400 }) });
    const j = await r.json();
    let s = j && j.iceServers;
    if (!s) return base;
    if (!Array.isArray(s)) s = [s];
    // Порт 53 браузеры блокируют — такие адреса только тормозят соединение
    s = s.map((x) => Object.assign({}, x, { urls: (Array.isArray(x.urls) ? x.urls : [x.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((x) => x.urls.length);
    if (!s.length) return base;
    ICE = s; ICEAT = NOW();
    return s;
  } catch (e) { return base; }
}
// Курсы стейблкоинов для бегущей строки. Берём у CoinGecko раз в 3 минуты
// на всех сразу: у каждого телефона в отдельности CoinGecko часто отказывает
// из-за лимита запросов. Если CoinGecko молчит — Binance и курсы валют.
let RATES = null, RATESAT = 0;
const STABLE = [['USDT', 'tether'], ['USDC', 'usd-coin'], ['DAI', 'dai'], ['FDUSD', 'first-digital-usd'],
  ['USDe', 'ethena-usde'], ['PYUSD', 'paypal-usd']];
const FIATV = ['usd', 'uah', 'eur', 'pln', 'try', 'kzt'];
async function getRates(env) {
  if (RATES && NOW() - RATESAT < 180000) return RATES;
  let out = null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${STABLE.map((x) => x[1]).join(',')}&vs_currencies=${FIATV.join(',')}`,
      { headers: { accept: 'application/json' }, cf: { cacheTtl: 120 } });
    if (r.ok) {
      const j = await r.json();
      const coins = {};
      STABLE.forEach(([sym, id]) => { if (j[id] && j[id].usd) coins[sym] = j[id]; });
      if (coins.USDT) out = { coins, src: 'CoinGecko', at: NOW() };
    }
  } catch (e) {}
  if (!out) {
    // Запасной путь: стейблы к USDT с Binance и курсы валют к доллару
    try {
      const [b, f] = await Promise.all([
        fetch('https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent('["USDCUSDT","FDUSDUSDT","EURUSDT"]')).then((x) => x.json()).catch(() => []),
        fetch('https://open.er-api.com/v6/latest/USD').then((x) => x.json()).catch(() => null),
      ]);
      const fx = f && f.rates;
      if (fx && fx.UAH) {
        const px = {}; (Array.isArray(b) ? b : []).forEach((x) => { px[x.symbol] = Number(x.price); });
        const row = (usd) => { const o = {}; FIATV.forEach((k) => { o[k] = usd * (k === 'usd' ? 1 : Number(fx[k.toUpperCase()]) || 0); }); return o; };
        const coins = { USDT: row(1) };
        if (px.USDCUSDT) coins.USDC = row(px.USDCUSDT);
        if (px.FDUSDUSDT) coins.FDUSD = row(px.FDUSDUSDT);
        out = { coins, src: px.USDCUSDT ? 'Binance, ExchangeRate-API' : 'ExchangeRate-API', at: NOW() };
      }
    } catch (e) {}
  }
  if (out) {
    RATES = out; RATESAT = NOW();
    try { await env.DB.prepare("INSERT INTO settings(k,v) VALUES('rates',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(out)).run(); } catch (e) {}
    return out;
  }
  // Сеть молчит — отдаём последнее, что было, с честным временем
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='rates'").first();
    if (r && r.v) return JSON.parse(r.v);
  } catch (e) {}
  return null;
}
// Реакции: у каждого человека на сообщении одна, повторное нажатие снимает
const REACTS = ['❤️', '👍', '😂', '😮', '😢', '🔥', '🙏', '👏', '💯', '🚀'];
async function reactsFor(env, kind, ids, me) {
  if (!ids.length) return {};
  const r = await env.DB.prepare(`SELECT mid, emo, uid FROM reacts WHERE kind=? AND mid IN (${ids.map(() => '?').join(',')})`)
    .bind(kind, ...ids).all();
  const out = {};
  (r.results || []).forEach((x) => {
    const a = out[x.mid] = out[x.mid] || [];
    let e = a.find((y) => y.e === x.emo);
    if (!e) { e = { e: x.emo, n: 0, me: false }; a.push(e); }
    e.n++; if (x.uid === me) e.me = true;
  });
  return out;
}
async function reactSet(env, kind, mid, uid, emo) {
  if (!REACTS.includes(emo)) return;
  const old = await env.DB.prepare('SELECT emo FROM reacts WHERE kind=? AND mid=? AND uid=?').bind(kind, mid, uid).first();
  if (old && old.emo === emo) await env.DB.prepare('DELETE FROM reacts WHERE kind=? AND mid=? AND uid=?').bind(kind, mid, uid).run();
  else await env.DB.prepare('INSERT INTO reacts(kind,mid,uid,emo,at) VALUES(?,?,?,?,?) ON CONFLICT(kind,mid,uid) DO UPDATE SET emo=excluded.emo, at=excluded.at')
    .bind(kind, mid, uid, emo, NOW()).run();
}
// Отметки на публикации: кто отмечен из клуба и какие @имена Telegram
async function tagsFor(env, ids) {
  if (!ids.length) return {};
  const r = await env.DB.prepare(`SELECT t.vid, t.uid, t.shown, p.nick FROM vtags t LEFT JOIN players p ON p.id=t.uid
    WHERE t.vid IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const out = {};
  (r.results || []).forEach((x) => { (out[x.vid] = out[x.vid] || []).push({ id: x.uid, nick: x.nick || '', shown: !!x.shown }); });
  return out;
}
function vidOut(url, v, user, liked, tags) {
  let links = [];
  try { links = JSON.parse(v.links || '[]'); } catch (e) {}
  const photo = v.kind === 'photo' || v.media === 'photo';
  return {
    id: v.id, uid: v.uid, nick: v.nick, av: v.av, title: v.title, kind: v.kind || 'reel', media: photo ? 'photo' : 'video',
    dur: v.dur, size: v.size, at: v.at, views: v.views, likes: v.likes,
    boost: v.boost_until > NOW(), until: v.boost_until | 0, paid: v.boost_stars | 0, ends: v.until | 0, ad: !!v.ad,
    hidden: !!v.hidden, flags: v.flags,
    thumb: v.thumb && !v.hidden ? `${url.origin}/vfile?id=${v.id}&kind=thumb` : '',
    src: !v.hidden && (isR2(v.file_id) || !(v.size > 19 * 1024 * 1024)) ? `${url.origin}/vfile?id=${v.id}&kind=video` : '',
    playable: isR2(v.file_id) || !(v.size > 19 * 1024 * 1024),
    me: v.uid === user.id, liked: !!(liked && liked[v.id]),
    tags: (tags && tags[v.id]) || [], links,
  };
}
async function tagNotify(env, to, fromName, vid, what, origin) {
  const app = env.APP_URL
    ? `${env.APP_URL}${env.APP_URL.includes('?') ? '&' : '?'}api=${encodeURIComponent(origin)}&tag=${vid}` : '';
  try {
    await tg(env, 'sendMessage', { chat_id: to, text: `📌 ${fromName} отметил(а) тебя ${what} в SHRhub. Можешь добавить это к себе на страницу.`,
      reply_markup: app ? { inline_keyboard: [[{ text: 'Посмотреть', web_app: { url: app } }]] } : undefined });
  } catch (e) {}
}
// Можно ли этому человеку звонить: он сам решает в настройках
async function callAllowed(env, target, from) {
  const p = await env.DB.prepare('SELECT COALESCE(callwho,0) w FROM prefs WHERE uid=?').bind(target).first();
  const w = p ? p.w : 0;
  if (w === 2) return false;
  if (w === 1) {
    const f = await env.DB.prepare('SELECT 1 x FROM follows WHERE uid=? AND target=? AND COALESCE(ok,1)=1').bind(target, from).first();
    return !!f;
  }
  if (w === 3) {
    // Звонить могут те, кто подписан на меня (и я подтвердил подписку)
    const f = await env.DB.prepare('SELECT 1 x FROM follows WHERE uid=? AND target=? AND COALESCE(ok,1)=1').bind(from, target).first();
    return !!f;
  }
  const b = await env.DB.prepare('SELECT COALESCE(banned,0) b FROM players WHERE id=?').bind(target).first();
  return !!b && !b.b;
}
// Бот сообщает о звонке: на телефоне звенит уведомление Telegram, кнопка
// «Ответить» открывает приложение сразу в звонке.
async function ringNotify(env, to, fromName, cid, video, origin) {
  const app = env.APP_URL
    ? `${env.APP_URL}${env.APP_URL.includes('?') ? '&' : '?'}api=${encodeURIComponent(origin)}&call=${cid}` : '';
  const kb = app ? { inline_keyboard: [[{ text: video ? '📹 Ответить' : '📞 Ответить', web_app: { url: app } }]] } : undefined;
  const text = `${video ? '📹 Видеозвонок' : '📞 Входящий звонок'} — ${fromName} звонит тебе в SHRhub. Нажми «Ответить».`;
  try {
    let r = await tg(env, 'sendMessage', { chat_id: to, text, reply_markup: kb });
    // Кнопка не прошла (например, адрес приложения не https) — всё равно
    // отправляем сообщение: главное, чтобы телефон зазвенел уведомлением
    if (!(r && r.ok) && kb) r = await tg(env, 'sendMessage', { chat_id: to, text });
    const mid = r && r.ok && r.result && r.result.message_id;
    if (mid) await env.DB.prepare('UPDATE cmem SET msg=?, pings=0, pingat=? WHERE call=? AND uid=?').bind(mid, NOW(), cid, to).run();
  } catch (e) {}
}
// Пока человек не ответил, напоминаем ещё дважды — каждые 12 секунд. Каждое
// сообщение — это звук уведомления на заблокированном телефоне: так вызов
// похож на звонок, а не на одно короткое «дзынь». После ответа лишнее удаляем.
async function ringAgain(env, cid, fromName, video) {
  const T = NOW();
  const r = await env.DB.prepare("SELECT uid, pings, pingat, extra FROM cmem WHERE call=? AND state='ring' AND at>? AND msg>0 AND pings<2 AND pingat<?")
    .bind(cid, T - CALL_RING, T - 12000).all();
  for (const m of (r.results || [])) {
    // Забираем право на повтор атомарно: опрашивают несколько телефонов сразу
    const claim = await env.DB.prepare('UPDATE cmem SET pings=pings+1, pingat=? WHERE call=? AND uid=? AND pingat=?').bind(T, cid, m.uid, m.pingat).run();
    if (!claim || !claim.meta || !claim.meta.changes) continue;
    try {
      const x = await tg(env, 'sendMessage', { chat_id: m.uid, text: `${video ? '📹' : '📞'} ${fromName} всё ещё звонит…` });
      const id = x && x.ok && x.result && x.result.message_id;
      if (id) {
        let ex = []; try { ex = JSON.parse(m.extra || '[]'); } catch (e) {}
        ex.push(id);
        await env.DB.prepare('UPDATE cmem SET extra=? WHERE call=? AND uid=?').bind(JSON.stringify(ex), cid, m.uid).run();
      }
    } catch (e) {}
  }
}
// Звонок закончился или на него ответили — кнопку «Ответить» убираем, чтобы
// в чате с ботом не висели мёртвые вызовы.
async function ringDone(env, cid, uid, text) {
  try {
    const m = await env.DB.prepare('SELECT msg, extra FROM cmem WHERE call=? AND uid=?').bind(cid, uid).first();
    if (!m || !m.msg) return;
    await env.DB.prepare("UPDATE cmem SET msg=0, extra='[]' WHERE call=? AND uid=?").bind(cid, uid).run();
    let ex = []; try { ex = JSON.parse(m.extra || '[]'); } catch (e) {}
    for (const id of ex) { try { await tg(env, 'deleteMessage', { chat_id: uid, message_id: id }); } catch (e) {} }
    await tg(env, 'editMessageText', { chat_id: uid, message_id: m.msg, text });
  } catch (e) {}
}
const CALL_LIVE = 25000, CALL_RING = 60000, CALL_MAX = 5;
async function callMembers(env, cid, origin) {
  const T = NOW();
  const r = await env.DB.prepare(`SELECT m.uid, m.state, m.at, m.seen, COALESCE(m.cam,1) cam, p.nick, p.av, p.avimg, p.avurl
    FROM cmem m LEFT JOIN players p ON p.id=m.uid WHERE m.call=?`).bind(cid).all();
  return (r.results || []).map((x) => ({
    id: x.uid, nick: x.nick || '', av: x.av || '🎩', cam: x.cam ? 1 : 0, avu: avLink(origin, { id: x.uid, avimg: x.avimg, avurl: x.avurl }),
    state: x.state === 'in' && x.seen > T - CALL_LIVE ? 'in'
      : x.state === 'ring' && x.at > T - CALL_RING ? 'ring' : x.state === 'no' ? 'no' : 'gone',
  }));
}
// Звонок живёт, пока в нём двое или кто-то ещё звонит. Иначе закрываем.
async function callTidy(env, cid, origin, hostName) {
  const c = await env.DB.prepare('SELECT * FROM calls WHERE id=?').bind(cid).first();
  if (!c || c.ended) return true;
  const mem = await callMembers(env, cid, origin);
  const inN = mem.filter((m) => m.state === 'in').length, ringN = mem.filter((m) => m.state === 'ring').length;
  if (inN >= 2 || (inN >= 1 && ringN >= 1)) return false;
  await env.DB.prepare('UPDATE calls SET ended=? WHERE id=?').bind(NOW(), cid).run();
  const host = hostName || ((await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(c.host).first()) || {}).nick || 'Участник клуба';
  const left = await env.DB.prepare("SELECT uid FROM cmem WHERE call=? AND msg>0").bind(cid).all();
  for (const x of (left.results || [])) await ringDone(env, cid, x.uid, `📞 Пропущенный звонок от ${host}`);
  return true;
}
async function ensure(env) {
  if (READY || !env.DB) return !!env.DB;
  // Таблицы создаём одной пачкой; если пачка споткнулась (например, на старой
  // базе), создаём по одной, чтобы одна ошибка не уронила весь сервер
  try { await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))); }
  catch (e) { for (const q of SCHEMA) { try { await env.DB.prepare(q).run(); } catch (e2) {} } }
  for (const q of PATCH) { try { await env.DB.prepare(q).run(); } catch (e) {} }
  READY = true;
  await movePm(env);
  // Ключи ников для старых участников — один раз
  try {
    const d = await env.DB.prepare("SELECT v FROM settings WHERE k='nkey_v1'").first();
    if (!d || !d.v) {
      const r = await env.DB.prepare('SELECT id, nick FROM players WHERE nkey IS NULL').all();
      for (const x of (r.results || [])) await env.DB.prepare('UPDATE players SET nkey=? WHERE id=?').bind(nickKey(x.nick), x.id).run();
      await env.DB.prepare("INSERT INTO settings(k,v) VALUES('nkey_v1','1') ON CONFLICT(k) DO UPDATE SET v='1'").run();
    }
  } catch (e) {}
  try {
    const done = await env.DB.prepare("SELECT v FROM settings WHERE k='renum_v1'").first();
    if (!done || !done.v) await renumber(env);
  } catch (e) {}
  return true;
}
// Старые письма владельца жили в отдельной таблице. Переписка теперь общая для
// всех, поэтому переносим их в неё один раз, чтобы ничего не пропало.
async function movePm(env) {
  try {
    const done = await env.DB.prepare("SELECT v FROM settings WHERE k='pm_moved'").first();
    if (done && done.v) return;
    const own = Number(env.OWNER_ID) || 0;
    if (own) {
      const r = await env.DB.prepare('SELECT uid, dir, text, at, seen FROM dms ORDER BY id').all();
      for (const x of (r.results || [])) {
        const from = x.dir === 'in' ? own : x.uid;
        const to = x.dir === 'in' ? x.uid : own;
        await env.DB.prepare('INSERT INTO pm(pair,uid,peer,text,at,seen) VALUES(?,?,?,?,?,?)')
          .bind(pairOf(own, x.uid), from, to, x.text, x.at, x.seen | 0).run();
      }
    }
    await env.DB.prepare("INSERT INTO settings(k,v) VALUES('pm_moved','1') ON CONFLICT(k) DO UPDATE SET v='1'").run();
  } catch (e) {}
}
const NOW = () => Date.now();
// Версия сервера: приложение сверяет её со своей и подсказывает владельцу,
// если на Cloudflare залит старый worker.js
const SRV_VER = 20261120;
// Пробный доступ новичку
const TRIAL_DAYS = 14, TRIAL_TIER = 5;
// Рейтинг клуба. Его даёт сервер и только за то, что он сам видит:
// прогноз отправлен, сообщение написано, запись в SHR сделана, человек зашёл.
// Потолок в сутки нужен, чтобы рейтинг нельзя было накрутить за вечер:
// без него выигрывает не тот, кто играет, а тот, кто быстрее жмёт.
const REP_DAY_CAP = 40;
const DAY = (ms) => new Date(ms || NOW()).toISOString().slice(0, 10);
async function logEvent(env, uid, kind, note) {
  try {
    await env.DB.prepare('INSERT INTO events(uid,kind,note,at) VALUES(?,?,?,?)')
      .bind(uid, kind, (note || '').slice(0, 48), NOW()).run();
    // Лента нужна свежая, старое только занимает место
    if (Math.random() < 0.02)
      await env.DB.prepare('DELETE FROM events WHERE at < ?').bind(NOW() - 30 * 86400000).run();
  } catch (e) {}
}
// Сообщение владельцу. Молча, без ответа: если он заблокировал бота, это не повод
// ронять запрос игрока.
async function tellOwner(env, text) {
  const owner = Number(env.OWNER_ID || env.SUPPORT_CHAT_ID || 0);
  if (!owner) return;
  try { await tg(env, 'sendMessage', { chat_id: owner, text }); } catch (e) {}
}
async function addRep(env, uid, n) {
  if (!(n > 0)) return;
  const day = DAY();
  const r = await env.DB.prepare('SELECT repday, repn FROM players WHERE id=?').bind(uid).first();
  if (!r) return;
  const used = r.repday === day ? (r.repn | 0) : 0;
  const give = Math.max(0, Math.min(n, REP_DAY_CAP - used));
  if (!give) return;
  await env.DB.prepare('UPDATE players SET rep=COALESCE(rep,0)+?, repday=?, repn=? WHERE id=?')
    .bind(give, day, used + give, uid).run();
}
// ---------- скидка ----------
// Скидка настоящая: обычная цена остаётся обычной ценой, по ней покупают, когда
// скидки нет. Зачёркивать можно только то, что человек действительно заплатил бы
// в другой день, иначе это не скидка, а нарисованная цифра.
async function getSale(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='sale'").first();
  if (!r) return null;
  let sale = null;
  try { sale = JSON.parse(r.v); } catch (e) { return null; }
  if (!sale || !(sale.pct > 0) || !(sale.until > NOW())) return null;
  return { pct: Math.min(80, sale.pct | 0), until: sale.until };
}
function salePrice(stars, sale) {
  if (!sale) return stars;
  return Math.max(1, Math.round(stars * (100 - sale.pct) / 100));
}
// Плата за голос в чате выключена по умолчанию: пока клуб маленький, цена входа
// отсекает живых новичков вернее, чем спамеров. Включается одной кнопкой, если
// в чаты начнут ломиться чужие.
async function chatPaid(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='chatpay'").first();
  return !!(r && r.v === '1');
}
async function lastAnn(env) {
  return await env.DB.prepare('SELECT id,text,at FROM ann ORDER BY id DESC LIMIT 1').first();
}
// Кто сейчас занимает оплаченное место
async function spotOf(env, kind) {
  const r = await env.DB.prepare('SELECT id, until FROM spots WHERE kind=? AND until>? ORDER BY until DESC LIMIT 1')
    .bind(kind, NOW()).first();
  return r || null;
}
async function asPlayer(env, uid) {
  const r = await env.DB.prepare('SELECT as_player FROM flags WHERE uid=?').bind(uid).first();
  return !!(r && r.as_player);
}
const isOwner = (env, user) => {
  const owner = Number(env.OWNER_ID || env.SUPPORT_CHAT_ID || 0);
  return !!owner && user.id === owner;
};
const HOUR = () => Math.floor(Date.now() / 3600000);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

// Номер в клубе выдаёт сервер и только один раз. Раньше игра брала случайное
// шестизначное число — у каждого свой, но смысла в нём не было никакого.
// Теперь это порядок вступления: основатель клуба первый, дальше по очереди.
async function clubNo(env, uid, owner) {
  if (owner) {
    await env.DB.prepare('UPDATE players SET no=1 WHERE id=?').bind(uid).run();
    return 1;
  }
  const r = await env.DB.prepare('SELECT COALESCE(MAX(no),1) m FROM players').first();
  const n = ((r && r.m) | 0) + 1;
  await env.DB.prepare('UPDATE players SET no=? WHERE id=?').bind(n, uid).run();
  return n;
}
// Номера по порядку прихода. Раньше номер выдавался в момент первого
// захода после обновления — то есть в порядке, в котором люди открыли новую
// версию, а не в котором пришли в клуб. Восстанавливаем, когда человек
// пришёл на самом деле: самый ранний след — запись о входе, начало пробного
// периода, первый прогноз, запись, сообщение или ролик. Владелец — номер 1.
async function renumber(env) {
  const BIG = 9e15;
  await env.DB.prepare(`UPDATE players SET joined = MIN(
  COALESCE((SELECT MIN(at) FROM events e WHERE e.uid=players.id AND e.kind='join'), ?),
  COALESCE(CASE WHEN COALESCE(trial,0)>0 THEN trial-? END, ?),
  COALESCE((SELECT MIN(at) FROM preds x WHERE x.uid=players.id), ?),
  COALESCE((SELECT MIN(at) FROM pf x WHERE x.uid=players.id), ?),
  COALESCE((SELECT MIN(at) FROM msgs x WHERE x.uid=players.id), ?),
  COALESCE((SELECT MIN(at) FROM pm x WHERE x.uid=players.id), ?),
  COALESCE((SELECT MIN(at) FROM vids x WHERE x.uid=players.id), ?))
WHERE COALESCE(joined,0)=0`)
    .bind(BIG, TRIAL_DAYS * 86400000, BIG, BIG, BIG, BIG, BIG, BIG).run();
  await env.DB.prepare('UPDATE players SET joined=COALESCE(NULLIF(seen,0),?) WHERE joined>=?').bind(NOW(), BIG).run();
  const own = Number(env.OWNER_ID) || 0;
  const r = await env.DB.prepare('SELECT id FROM players WHERE id<>? ORDER BY joined, id').bind(own).all();
  const st = [];
  if (own) st.push(env.DB.prepare('UPDATE players SET no=1 WHERE id=?').bind(own));
  (r.results || []).forEach((x, i) => st.push(env.DB.prepare('UPDATE players SET no=? WHERE id=?').bind(i + 2, x.id)));
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  await env.DB.prepare("INSERT INTO settings(k,v) VALUES('renum_v1','1') ON CONFLICT(k) DO UPDATE SET v='1'").run();
  return st.length;
}
// Ник сравниваем без учёта больших букв, пробелов и «ё»: «Саша», «саша»
// и «С а ш а» — один и тот же ник
function nickKey(n) { return String(n || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s_.\-]+/g, ''); }
async function nickFree(env, nick, id) {
  const k = nickKey(nick);
  if (!k) return false;
  const r = await env.DB.prepare('SELECT id FROM players WHERE nkey=? AND id<>? LIMIT 1').bind(k, id).first();
  return !r;
}
// Новичку даём имя из Telegram; если оно занято — с номером: «Саша 2»
async function uniqueNick(env, base, id) {
  base = clean(base, 16) || 'Участник';
  if (await nickFree(env, base, id)) return base;
  for (let i = 2; i < 200; i++) {
    const n = (base.slice(0, 16 - String(i).length - 1) + ' ' + i).trim();
    if (await nickFree(env, n, id)) return n;
  }
  return (base.slice(0, 9) + ' ' + String(id).slice(-6)).trim();
}
async function getPlayer(env, user) {
  const id = user.id;
  let row = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
  if (!row) {
    // Пробный доступ на две недели — один раз на Telegram ID. Ничего не списывается
    // и само не продлевается: через 14 дней человек просто возвращается на Free.
    const until = NOW() + TRIAL_DAYS * 86400000;
    const nick0 = await uniqueNick(env, user.first_name, id);
    await env.DB.prepare('INSERT INTO players(id,nick,seen,tier,tier_until,trial,joined,nkey) VALUES(?,?,?,?,?,?,?,?)')
      .bind(id, nick0, NOW(), TRIAL_TIER, until, until, NOW(), nickKey(nick0)).run();
    row = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
    const total = await env.DB.prepare('SELECT COUNT(*) n FROM players').first();
    await logEvent(env, id, 'join', clean(user.first_name, 16));
    await tellOwner(env, `👤 Новый человек в клубе: ${clean(user.first_name, 16) || 'без имени'}` +
      (user.username ? ` (@${user.username})` : '') + `\nВсего в клубе: ${total ? total.n : '?'}`);
  }
  const own = isOwner(env, user);
  if (!row.no || (own && row.no !== 1)) row.no = await clubNo(env, id, own);
  return row;
}
// Что сервер считает правдой: всё оплаченное. Остальной прогресс — на слово игроку.
// У владельца платформа открыта всегда — кроме случая, когда он сам включил режим
// «смотреть как обычный игрок», чтобы проверить, что видят остальные.
const ALL_SKINS = () => {
  const o = {};
  for (const k in PRODUCTS) if (PRODUCTS[k].own) o[PRODUCTS[k].own] = 1;
  return o;
};
// Доступ, открытый сразу всему клубу. Это одна строка в настройках: она
// работает одинаково и на десять человек, и на десять тысяч — перебирать
// игроков не нужно. 0 — выключено, -1 — бессрочно, иначе срок.
async function openAllUntil(env) {
  try {
    const r = await env.DB.prepare("SELECT v FROM settings WHERE k='openall'").first();
    const v = r ? Number(r.v) : 0;
    if (v === -1) return -1;
    return v > NOW() ? v : 0;
  } catch (e) { return 0; }
}
// Действует ли сейчас выданный владельцем доступ
async function giftOn(env, uid) {
  const g = await env.DB.prepare('SELECT until FROM gifts WHERE uid=?').bind(uid).first();
  if (!g) return false;
  return g.until === -1 || g.until > NOW();
}
function paid(row, full) {
  const now = NOW();
  if (full) return { tier: 5, tier_until: now + 31 * 86400000, extra: JSON.parse(row.extra || '[]'),
    owned: ALL_SKINS(), saves: 99, codes: 99, gmFree: 99, pass: true, owner: true };
  if (row.gift) return { tier: 5, tier_until: row.gift === -1 ? now + 3650 * 86400000 : row.gift,
    extra: JSON.parse(row.extra || '[]'), owned: ALL_SKINS(), saves: 99, codes: 99, gmFree: 99, pass: true, gift: true };
  const onTrial = (row.trial | 0) > now && row.tier_until > now;
  return {
    trial: onTrial ? row.trial : 0,
    tier: row.tier_until > now ? row.tier : 0,
    tier_until: row.tier_until,
    extra: JSON.parse(row.extra || '[]'),
    owned: JSON.parse(row.owned || '{}'),
    saves: row.saves | 0,
    codes: row.codes | 0,
    gmFree: row.gm | 0,
    pass: row.pass_until > now,
  };
}

// Комната звонка. Держит соединения участников и пересылает их записки друг
// другу: «вот моё предложение соединиться», «вот ответ», «я выключил камеру».
// Сам голос и видео сюда не попадают — они идут напрямую между телефонами.
export class CallRoom {
  constructor(state, env) { this.state = state; this.env = env; }
  peers() {
    const ids = new Set();
    for (const ws of this.state.getWebSockets()) { const a = ws.deserializeAttachment() || {}; if (a.uid) ids.add(a.uid); }
    return [...ids];
  }
  broadcast(obj, except) {
    const msg = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) { if (ws !== except) { try { ws.send(msg); } catch (e) {} } }
  }
  async fetch(req) {
    const url = new URL(req.url);
    const uid = Number(url.searchParams.get('uid')) || 0;
    if (!uid) return new Response('uid', { status: 400 });
    // Тот же человек переподключился — старое соединение закрываем
    for (const ws of this.state.getWebSockets(String(uid))) { try { ws.close(1000, 'replaced'); } catch (e) {} }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [String(uid)]);
    server.serializeAttachment({ uid });
    this.broadcast({ t: 'peers', ids: this.peers() });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    const me = (ws.deserializeAttachment() || {}).uid;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!me || !m) return;
    if (m.t === 'ping') { try { ws.send('{"t":"pong"}'); } catch (e) {} return; }
    if (!['offer', 'answer', 'cam', 'bye'].includes(m.kind)) return;
    if (String(m.data || '').length > 30000) return;
    const to = Number(m.to) || 0;
    for (const peer of this.state.getWebSockets(String(to))) {
      try { peer.send(JSON.stringify({ t: 'sig', src: me, kind: m.kind, data: m.data || '' })); } catch (e) {}
    }
  }
  async webSocketClose(ws) { try { ws.close(); } catch (e) {} this.broadcast({ t: 'peers', ids: this.peers() }, ws); }
  async webSocketError(ws) { this.broadcast({ t: 'peers', ids: this.peers() }, ws); }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Вход проверяется подписью Telegram в теле запроса, а не куками, поэтому
    // открыть сервер для любого адреса безопасно. Раньше пускали только адрес
    // из APP_URL — и если приложение лежало по другому адресу, не работало ничего.
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-init', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '86400' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    // Звонок через постоянное соединение (если подключён CALLROOM). Каждый звонок —
    // своя «комната» на серверах Cloudflare: телефоны держат с ней соединение и
    // обмениваются служебными записками мгновенно, без опроса базы. Так звонки
    // выдерживают десятки тысяч одновременных разговоров.
    if (url.pathname === '/callws') {
      if (!env.CALLROOM) return new Response('no rooms', { status: 501 });
      if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('ws only', { status: 426 });
      if (!await ensure(env)) return new Response('no db', { status: 503 });
      const who = await verifyInitData(url.searchParams.get('init') || '', env.BOT_TOKEN);
      if (!who) return new Response('auth', { status: 401 });
      const cid = clean(url.searchParams.get('id') || '', 24);
      const m = await env.DB.prepare(`SELECT m.state FROM cmem m JOIN calls c ON c.id=m.call WHERE m.call=? AND m.uid=? AND c.ended=0`).bind(cid, who.id).first();
      if (!m || m.state !== 'in') return new Response('not in call', { status: 403 });
      const room = env.CALLROOM.get(env.CALLROOM.idFromName(cid));
      const fwd = new URL(req.url); fwd.searchParams.delete('init'); fwd.searchParams.set('uid', String(who.id));
      return room.fetch(new Request(fwd.toString(), req));
    }
    const appUrl = `${env.APP_URL}${env.APP_URL.includes('?') ? '&' : '?'}api=${encodeURIComponent(url.origin)}`;

    // Курсы для бегущей строки: открытые данные, подпись не нужна
    if (url.pathname === '/rates') {
      if (env.DB) await ensure(env);
      const r = await getRates(env);
      return json(r || { error: 'none' }, r ? 200 : 503, Object.assign({}, cors, { 'cache-control': 'public, max-age=60' }));
    }

    // Общая часть для всех запросов из игры: разобрать тело и проверить подпись
    const API = ['/invoice', '/support', '/me', '/vote', '/sent', '/chat', '/clans', '/top', '/pf', '/stats', '/owner', '/notif', '/pref', '/online', '/feed', '/dm', '/profile', '/follow', '/vids', '/vid', '/pm', '/pms', '/ideas', '/find', '/gifts', '/orders', '/card', '/call', '/stories', '/tags', '/nick'];
    let body = null, user = null;
    if (req.method === 'POST' && API.includes(url.pathname)) {
      try { body = await req.json(); } catch (e) { return json({ error: 'bad request' }, 400, cors); }
      user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ error: 'auth' }, 401, cors);
    }

    // 0. Загрузка ролика прямо из приложения: человек нажимает плюсик, выбирает
    // файл, и мы передаём его Telegram. Байты идут сырым телом, без multipart:
    // разбирать multipart в воркере дороже, чем просто принять поток.
    if (req.method === 'POST' && url.pathname === '/vup') {
      if (!await ensure(env)) return json({ error: 'db' }, 503, cors);
      let init = '';
      try { init = decodeURIComponent(req.headers.get('x-init') || ''); } catch (e) {}
      const who = await verifyInitData(init, env.BOT_TOKEN);
      if (!who) return json({ error: 'auth' }, 401, cors);
      const row = await env.DB.prepare('SELECT COALESCE(banned,0) b FROM players WHERE id=?').bind(who.id).first();
      if (row && row.b) return json({ error: 'banned' }, 403, cors);
      // Бот умеет заливать файл до 50 МБ. Что крупнее — человек отправляет
      // в чат сам: оттуда ролик проходит любого размера.
      // Что выкладываем: ролик в ленту, видео или фото в профиль
      const k0 = url.searchParams.get('kind');
      const pkind = k0 === 'photo' ? 'photo' : k0 === 'video' ? 'video' : k0 === 'story' ? 'story' : 'reel';
      // История бывает фото или видео: это говорит параметр media
      const isPhoto = pkind === 'photo' || (pkind === 'story' && url.searchParams.get('media') === 'photo');
      const max = (isPhoto ? 10 : 40) * 1024 * 1024;
      const len = Number(req.headers.get('content-length') || 0);
      if (len > max) return json({ error: 'big', max: max }, 413, cors);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return json({ error: 'empty' }, 400, cors);
      if (buf.byteLength > max) return json({ error: 'big', max: max }, 413, cors);
      let title = '';
      try { title = clean(decodeURIComponent(url.searchParams.get('title') || ''), 80); } catch (e) {}
      const fd = new FormData();
      fd.append('chat_id', String(who.id));
      fd.append('disable_notification', 'true');
      const where = pkind === 'reel' ? 'Твой ролик в ленте SHRhub' : pkind === 'story' ? 'Твоя история в SHRhub — видна сутки' : 'Твоя публикация в профиле SHRhub';
      let fileId = '', thumb = '', dur = 0, size = buf.byteLength;
      const mime0 = String(url.searchParams.get('mime') || 'video/mp4');
      if (env.MEDIA) {
        // Своё хранилище: файл кладём к себе, Telegram не нужен
        if (isPhoto) { fileId = await putMedia(env, buf, 'image/jpeg', 'p'); thumb = fileId; }
        else {
          fileId = await putMedia(env, buf, /webm/i.test(mime0) ? 'video/webm' : 'video/mp4', 'v');
          dur = Number(url.searchParams.get('dur')) || 0;
          if (dur > (pkind === 'story' ? 65 : 85)) { await dropMedia(env, fileId); return json({ error: 'long' }, 400, cors); }
        }
      } else if (isPhoto) {
        fd.append('caption', `📷 ${title || 'Без подписи'}\n\n${where}`);
        fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'photo.jpg');
        const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd });
        const j = await r.json();
        const ph = (j && j.ok && j.result && j.result.photo) || [];
        if (!ph.length) return json({ error: 'tg', detail: (j && j.description) || '' }, 502, cors);
        // Самое крупное — для просмотра, среднее — для плитки в сетке
        const big = ph[ph.length - 1], mid = ph.find((p) => p.width >= 480) || big;
        fileId = big.file_id; thumb = mid.file_id; size = big.file_size || size;
      } else {
        fd.append('caption', `🎬 ${title || 'Без названия'}\n\n${where}`);
        // Сжатый на телефоне ролик бывает mp4 (айфон) или webm (часть андроидов)
        const mime = String(url.searchParams.get('mime') || 'video/mp4');
        const webm = /webm/i.test(mime);
        fd.append('video', new Blob([buf], { type: webm ? 'video/webm' : 'video/mp4' }), webm ? 'video.webm' : 'video.mp4');
        fd.append('supports_streaming', 'true');
        const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendVideo`, { method: 'POST', body: fd });
        const j = await r.json();
        const v = j && j.ok && j.result && (j.result.video || j.result.document);
        if (!v || !v.file_id) return json({ error: 'tg', detail: (j && j.description) || '' }, 502, cors);
        fileId = v.file_id;
        thumb = (v.thumbnail && v.thumbnail.file_id) || (v.thumb && v.thumb.file_id) || '';
        // Ролики до 1:20, как в Instagram. Приложение само обрезает длинные,
        // а сервер проверяет ещё раз: в обход приложения не пролезет.
        dur = Number(v.duration) || Number(url.searchParams.get('dur')) || 0;
        if (dur > (pkind === 'story' ? 65 : 85)) return json({ error: 'long' }, 400, cors);
        size = v.file_size || size;
      }
      // Отметки: люди из клуба (по id из поиска) и @имена Telegram
      const tagIds = [...new Set(String(url.searchParams.get('tags') || '').split(',').map(Number).filter((x) => x > 0 && x !== who.id))].slice(0, 10);
      const links = [...new Set(String(url.searchParams.get('links') || '').split(',')
        .map((x) => x.trim().replace(/^(https?:\/\/)?t\.me\//i, '').replace(/^@/, ''))
        .filter((x) => /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(x)))].slice(0, 5);
      const ad = pkind === 'story' && url.searchParams.get('ad') === '1' ? 1 : 0;
      const ins = await env.DB.prepare(
        `INSERT INTO vids(uid,title,file_id,thumb,dur,size,at,kind,media,until,ad,links) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(who.id, title || (isPhoto || pkind === 'story' ? '' : 'Без названия'), fileId, thumb, dur, size, NOW(), pkind,
          isPhoto ? 'photo' : 'video', pkind === 'story' ? NOW() + 86400000 : 0, ad, links.length ? JSON.stringify(links) : null).run();
      const newId = (ins.meta && ins.meta.last_row_id) || 0;
      if (newId && tagIds.length) {
        const me0 = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(who.id).first();
        for (const x of tagIds) {
          const ex = await env.DB.prepare('SELECT 1 x FROM players WHERE id=?').bind(x).first();
          if (!ex) continue;
          await env.DB.prepare('INSERT OR IGNORE INTO vtags(vid,uid,shown,at) VALUES(?,?,0,?)').bind(newId, x, NOW()).run();
          await tagNotify(env, x, (me0 && me0.nick) || 'Участник клуба', newId,
            pkind === 'story' ? 'в истории' : isPhoto ? 'на фото' : 'в видео', url.origin);
        }
      }
      await logEvent(env, who.id, 'vid', (title || '').slice(0, 40));
      await addRep(env, who.id, 2);
      if (pkind !== 'story') await tellOwner(env, `${pkind === 'photo' ? '📷 Новое фото в профиле' : pkind === 'video' ? '🎬 Новое видео в профиле' : '🎬 Новый ролик'}: «${title || 'без названия'}»\nАвтор: id ${who.id}`);
      return json({ ok: true, id: newId }, 200, cors);
    }

    // 0b. Фото или ролик в личную переписку. Файл приходит сырым телом, как и в
    // ленту: Telegram хранит его у себя, мы держим только file_id.
    // Обложка для видео из своего хранилища: телефон сам снимает кадр и
    // присылает его после загрузки ролика (Telegram обложку делал сам).
    if (req.method === 'POST' && url.pathname === '/vthumb') {
      if (!env.MEDIA) return json({ error: 'nomedia' }, 400, cors);
      if (!await ensure(env)) return json({ error: 'db' }, 503, cors);
      let init = '';
      try { init = decodeURIComponent(req.headers.get('x-init') || ''); } catch (e) {}
      const who = await verifyInitData(init, env.BOT_TOKEN);
      if (!who) return json({ error: 'auth' }, 401, cors);
      const id = Number(url.searchParams.get('id')) || 0;
      const v = await env.DB.prepare('SELECT uid, thumb FROM vids WHERE id=?').bind(id).first();
      if (!v || v.uid !== who.id) return json({ error: 'nope' }, 404, cors);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 2 * 1024 * 1024) return json({ error: 'big' }, 413, cors);
      const key = await putMedia(env, buf, 'image/jpeg', 't');
      await env.DB.prepare('UPDATE vids SET thumb=? WHERE id=?').bind(key, id).run();
      return json({ ok: true }, 200, cors);
    }

    if (req.method === 'POST' && url.pathname === '/pmup') {
      if (!await ensure(env)) return json({ error: 'db' }, 503, cors);
      let init = '';
      try { init = decodeURIComponent(req.headers.get('x-init') || ''); } catch (e) {}
      const who = await verifyInitData(init, env.BOT_TOKEN);
      if (!who) return json({ error: 'auth' }, 401, cors);
      const me = await getPlayer(env, who);
      if (me && me.banned) return json({ error: 'banned' }, 403, cors);
      const to = Number(url.searchParams.get('with')) || 0;
      if (!to || to === who.id) return json({ error: 'who' }, 400, cors);
      const peer = await env.DB.prepare('SELECT id, nick, seen FROM players WHERE id=?').bind(to).first();
      if (!peer) return json({ error: 'nope' }, 404, cors);
      const k0 = url.searchParams.get('kind');
      const kind = k0 === 'video' ? 'video' : k0 === 'voice' ? 'voice' : 'photo';
      const max = (kind === 'video' ? 40 : kind === 'voice' ? 20 : 10) * 1024 * 1024;
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return json({ error: 'empty' }, 400, cors);
      if (buf.byteLength > max) return json({ error: 'big' }, 413, cors);
      let cap = '';
      try { cap = clean(decodeURIComponent(url.searchParams.get('caption') || ''), 300); } catch (e) {}
      const from = (me && me.nick) || 'Участник клуба';
      // Файл грузим в чат отправителя: так у него остаётся своя копия, а у нас
      // появляется file_id, по которому ролик пересылается уже без загрузки.
      // Запись с телефона приходит в разном виде: iPhone отдаёт mp4, Android —
      // webm. Telegram принимает голосовое только в ogg, поэтому остальное
      // отправляем как аудиофайл: играть его мы всё равно будем сами.
      const mime = (url.searchParams.get('mime') || '').toLowerCase();
      let method = 'sendPhoto', field = 'photo', fname = 'photo.jpg', ftype = 'image/jpeg';
      if (kind === 'video') { method = 'sendVideo'; field = 'video'; fname = 'video.mp4'; ftype = 'video/mp4'; }
      else if (kind === 'voice') {
        if (mime.includes('ogg')) { method = 'sendVoice'; field = 'voice'; fname = 'voice.ogg'; ftype = 'audio/ogg'; }
        else if (mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a')) {
          method = 'sendAudio'; field = 'audio'; fname = 'voice.m4a'; ftype = 'audio/mp4';
        } else { method = 'sendDocument'; field = 'document'; fname = 'voice.webm'; ftype = mime || 'audio/webm'; }
      }
      let fid = '', thumb = '', dur = 0, size = buf.byteLength, res = null;
      if (env.MEDIA) {
        // Своё хранилище: голосовое, фото или видео кладём к себе как есть
        const typ = kind === 'photo' ? 'image/jpeg' : kind === 'video' ? (/webm/.test(mime) ? 'video/webm' : 'video/mp4')
          : (mime.split(';')[0] || 'audio/webm');
        fid = await putMedia(env, buf, typ, 'm');
        thumb = kind === 'photo' ? fid : '';
        dur = Number(url.searchParams.get('dur')) || 0;
      } else {
        const fd = new FormData();
        fd.append('chat_id', String(who.id));
        fd.append('disable_notification', 'true');
        if (cap) fd.append('caption', cap);
        fd.append(field, new Blob([buf], { type: ftype }), fname);
        const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
          { method: 'POST', body: fd });
        const j = await r.json();
        if (!j || !j.ok || !j.result) return json({ error: 'tg', detail: (j && j.description) || '' }, 502, cors);
        res = j.result;
      }
      if (res && kind === 'voice') {
        const v = res.voice || res.audio || res.document || {};
        fid = v.file_id || '';
        dur = v.duration || Number(url.searchParams.get('dur')) || 0;
        size = v.file_size || size;
      } else if (res && kind === 'video') {
        const v = res.video || res.document || {};
        fid = v.file_id || '';
        thumb = (v.thumbnail && v.thumbnail.file_id) || (v.thumb && v.thumb.file_id) || '';
        dur = v.duration || 0;
        size = v.file_size || size;
      } else if (res) {
        const ph = res.photo || [];
        const big = ph.length ? ph[ph.length - 1] : null;
        fid = big ? big.file_id : '';
        thumb = ph.length > 1 ? ph[0].file_id : fid;
        size = big && big.file_size ? big.file_size : size;
      }
      if (!fid) return json({ error: 'tg' }, 502, cors);
      const ins = await env.DB.prepare(
        `INSERT INTO pm(pair,uid,peer,text,at,seen,kind,file_id,thumb,dur,size) VALUES(?,?,?,?,?,0,?,?,?,?,?)`)
        .bind(pairOf(who.id, to), who.id, to, cap, NOW(), kind, fid, thumb, dur, size).run();
      await addRep(env, who.id, 1);
      // Нет человека в приложении — донесём файл в Telegram по тому же file_id
      if (!peer.seen || NOW() - peer.seen > 60000) {
        await pmNotify(env, to, who.id, from, cap || (kind === 'voice' ? '🎤 Голосовое' : kind === 'video' ? '🎬 Видео' : '📷 Фото'),
          isR2(fid) ? null : { kind, send: field, file_id: fid }, url.origin);
      }
      return json({ ok: true, id: (ins && ins.meta && ins.meta.last_row_id) || 0 }, 200, cors);
    }

    // 1. Счёт на оплату звёздами
    if (body && url.pathname === '/invoice') {
      const pr = PRODUCTS[body.product];
      if (!pr) return json({ error: 'product' }, 400, cors);
      const arg = clean(body.arg, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const sale = await getSale(env);
      const amount = salePrice(pr.stars, sale);
      const inv = { title: pr.title, description: `${pr.title}. Игровая покупка в SHRhub, денежной ценности не имеет.`, payload: `${user.id}:${body.product}:${arg}`, currency: 'XTR', prices: [{ label: pr.title, amount }] };
      if (pr.sub) inv.subscription_period = MONTH;
      const r = await tg(env, 'createInvoiceLink', inv);
      return r.ok ? json({ link: r.result }, 200, cors) : json({ error: r.description || 'telegram' }, 502, cors);
    }

    // 2. Поддержка
    if (body && url.pathname === '/support') {
      const text = clean(body.text, 1000);
      if (!text) return json({ error: 'empty' }, 400, cors);
      await env.DB.prepare('INSERT INTO tickets(uid,text,at,done) VALUES(?,?,?,0)')
        .bind(user.id, text, NOW()).run();
      await logEvent(env, user.id, 'help', text.slice(0, 40));
      // Обращение кладём в личную переписку с владельцем: дальше это обычный
      // разговор, а не письмо в пустоту. Владельцу приходит уведомление
      // с кнопкой, которая открывает ту же ветку.
      const own = Number(env.OWNER_ID) || 0;
      const me = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(user.id).first();
      const who = (me && me.nick) || clean(user.first_name, 32);
      if (own && own !== user.id) {
        await pmPut(env, user.id, own, `🎧 ${text}`, who, url.origin);
      }
      // Отдельный чат поддержки, если он заведён: туда уходит копия
      if (env.SUPPORT_CHAT_ID && String(env.SUPPORT_CHAT_ID) !== String(own)) {
        await tg(env, 'sendMessage', { chat_id: env.SUPPORT_CHAT_ID,
          text: `🎧 Поддержка\nОт: ${who} (id ${user.id})\n\n${text}` });
      }
      if (!own) await tellOwner(env, `🎧 Поддержка\nОт: ${who} (id ${user.id})\n\n${text}`);
      return json({ ok: true }, 200, cors);
    }

    if (body && !(await ensure(env))) return json({ error: 'nodb' }, 503, cors);

    // 3. Профиль: что куплено — слово сервера, остальной прогресс хранится как есть
    if (body && url.pathname === '/me') {
      const row = await getPlayer(env, user);
      // Приглашения: сначала запоминаем коды игрока, потом засчитываем тот,
      // по которому он сам пришёл.
      await keepCodes(env, user.id, body.codes);
      if (body.ref) await useCode(env, user.id, body.ref);
      let nickTaken = '';
      if (body.state) {
        const st = clean(JSON.stringify(body.state), 60000);
        // Чужой ник не берём: если такой уже есть, остаётся прежний
        let want = clean(body.state.nick, 16) || row.nick || clean(user.first_name, 16);
        if (nickKey(want) !== nickKey(row.nick) && !(await nickFree(env, want, user.id))) { nickTaken = want; want = row.nick; }
        await env.DB.prepare('UPDATE players SET nkey=? WHERE id=?').bind(nickKey(want), user.id).run();
        await env.DB.prepare(`UPDATE players SET nick=?,av=?,lang=?,pts=?,streak=?,best=?,total=?,wins=?,state=?,seen=? WHERE id=?`)
          .bind(want, clean(body.state.av, 8), body.state.lang | 0,
            body.state.pts | 0, body.state.streak | 0, body.state.best | 0, body.state.total | 0, body.state.wins | 0,
            st, NOW(), user.id).run();
        // Фото из Telegram — просто ссылка. Своя картинка приходит строкой
        // data:image, её держим отдельно и отдаём через /av, чтобы списки
        // не таскали килобайты картинок в каждом ответе.
        const au = typeof body.avurl === 'string' && body.avurl.startsWith('https://')
          ? body.avurl.slice(0, 400) : '';
        const ai = typeof body.avimg === 'string' && body.avimg.startsWith('data:image/')
          && body.avimg.length < 90000 ? body.avimg : null;
        if (au) await env.DB.prepare('UPDATE players SET avurl=? WHERE id=?').bind(au, user.id).run();
        if (body.avimg === '') await env.DB.prepare('UPDATE players SET avimg=NULL WHERE id=?').bind(user.id).run();
        else if (ai) await env.DB.prepare('UPDATE players SET avimg=? WHERE id=?').bind(ai, user.id).run();
      }
      // Первый заход за сутки — небольшая награда за то, что человек вернулся
      if (!row.repday || row.repday !== DAY()) await addRep(env, user.id, 3);
      const online = await env.DB.prepare('SELECT COUNT(*) n FROM players WHERE seen>?').bind(NOW() - 300000).first();
      const own = isOwner(env, user), ap = own ? await asPlayer(env, user.id) : false;
      if (!own || ap) { const g = await env.DB.prepare('SELECT until FROM gifts WHERE uid=?').bind(user.id).first();
        if (g && (g.until === -1 || g.until > NOW())) row.gift = g.until;
        // Доступ всему клубу: берём то, что длиннее — личный подарок или общий
        const oa = await openAllUntil(env);
        if (oa && !(row.gift === -1) && (oa === -1 || oa > (row.gift || 0))) row.gift = oa; }
      const nt = await env.DB.prepare('SELECT on_,mh,eh FROM notif WHERE uid=?').bind(user.id).first();
      const pf = await env.DB.prepare('SELECT hidden, COALESCE(noseen,0) noseen, COALESCE(callwho,0) callwho FROM prefs WHERE uid=?').bind(user.id).first();
      const sale = await getSale(env);
      const an = await lastAnn(env);
      const unread = await env.DB.prepare("SELECT COUNT(*) n FROM dms WHERE uid=? AND dir='in' AND seen=0").bind(user.id).first();
      const foll = await env.DB.prepare('SELECT COUNT(*) n FROM follows WHERE uid=? AND COALESCE(ok,1)=1').bind(user.id).first();
      const freq = await env.DB.prepare('SELECT COUNT(*) n FROM follows WHERE target=? AND COALESCE(ok,1)=0').bind(user.id).first();
      const pmn = await env.DB.prepare('SELECT COUNT(*) n FROM pm WHERE peer=? AND seen=0').bind(user.id).first();
      return json({ id: user.id, owner: own, asPlayer: ap, gift: !!row.gift, no: own ? (row.no || null) : null, paid: paid(row, own && !ap),
        notif: { on: !!(nt && nt.on_), mh: nt ? nt.mh : 12, eh: nt ? nt.eh : 20, asked: !!nt },
        hidden: !!(pf && pf.hidden), noseen: !!(pf && pf.noseen), callwho: pf ? pf.callwho : 0,
        ver: SRV_VER, media: !!env.MEDIA, nickTaken, nickNow: nickTaken ? row.nick : '', turn: !!(env.TURN_KEY_ID && env.TURN_KEY_TOKEN),
        banned: !!row.banned, banNote: row.ban_note || '', dmNew: unread ? unread.n : 0, pmNew: pmn ? pmn.n : 0, following: foll ? foll.n : 0, reqN: freq ? freq.n : 0,
        // Кому писать по заказам: id владельца и его имя в клубе
        ownerId: Number(env.OWNER_ID) || 0, ownerNick: await ownerNick(env),
        bot: await botName(env), off: await sectionsOff(env),
        chatOk: !!row.chat_ok || own || !(await chatPaid(env)),
        sale: sale, ann: an ? { id: an.id, text: an.text, at: an.at } : null,
        friends: await myFriends(env, user.id), used: await usedCodes(env, user.id),
        invitedBy: await (async () => { const b = await invitedBy(env, user.id);
          return b ? { id: b.id, nick: b.nick || '', av: b.av || '🎩', avu: avLink(url.origin, b) } : null; })(),
        state: body.state ? null : (row.state ? JSON.parse(row.state) : null), online: online ? online.n : 1 }, 200, cors);
    }

    // 3e. Личная переписка игрока с владельцем
    if (body && url.pathname === '/dm') {
      const row = await getPlayer(env, user);
      const text = clean(body.text, 600);
      if (text) {
        await env.DB.prepare('INSERT INTO dms(uid,dir,text,at,seen) VALUES(?,?,?,?,1)')
          .bind(user.id, 'out', text, NOW()).run();
        await tellOwner(env, `✉️ ${row.nick || user.id} (id ${user.id})\n\n${text}`);
      }
      // Открыл переписку — значит прочитал
      await env.DB.prepare("UPDATE dms SET seen=1 WHERE uid=? AND dir='in'").bind(user.id).run();
      const r = await env.DB.prepare('SELECT id,dir,text,at FROM dms WHERE uid=? ORDER BY id DESC LIMIT 50')
        .bind(user.id).all();
      return json({ list: (r.results || []).reverse() }, 200, cors);
    }

    // 3g. Истории на сутки: сверху — свои, потом тех, на кого подписан, потом остальные
    if (body && url.pathname === '/stories') {
      await getPlayer(env, user);
      const T = NOW();
      // Кто посмотрел историю — видит только её автор
      if (body.act === 'viewers') {
        const vid = Number(body.vid) || 0;
        const v = await env.DB.prepare('SELECT uid FROM vids WHERE id=?').bind(vid).first();
        if (!v || (v.uid !== user.id && !isOwner(env, user))) return json({ error: 'nope' }, 403, cors);
        const r = await env.DB.prepare(`SELECT s.uid, s.at, p.nick, p.av, p.avimg, p.avurl, COALESCE(f.hidden,0) hid
          FROM vseen s LEFT JOIN players p ON p.id=s.uid LEFT JOIN prefs f ON f.uid=s.uid
          WHERE s.vid=? AND s.uid<>? ORDER BY s.at DESC LIMIT 300`).bind(vid, v.uid).all();
        const rows = r.results || [];
        return json({ list: rows.filter((x) => !x.hid).map((x) => ({ id: x.uid, nick: x.nick || '', av: x.av || '🎩',
          avu: avLink(url.origin, { id: x.uid, avimg: x.avimg, avurl: x.avurl }), at: x.at || 0 })),
          hidden: rows.filter((x) => x.hid).length }, 200, cors);
      }
      const r = await env.DB.prepare(`SELECT v.*, p.nick, p.av, p.avimg, p.avurl FROM vids v LEFT JOIN players p ON p.id=v.uid
        WHERE v.kind='story' AND v.until>? AND (v.hidden=0 OR v.uid=?) AND COALESCE(p.banned,0)=0 ORDER BY v.id LIMIT 300`).bind(T, user.id).all();
      const rows = r.results || [];
      const seenR = await env.DB.prepare(`SELECT vid FROM vseen WHERE uid=? AND vid IN (SELECT id FROM vids WHERE kind='story' AND until>?)`).bind(user.id, T).all();
      const seen = {}; (seenR.results || []).forEach((x) => { seen[x.vid] = 1; });
      const fo = await env.DB.prepare('SELECT target FROM follows WHERE uid=? AND COALESCE(ok,1)=1').bind(user.id).all();
      const fol = {}; (fo.results || []).forEach((x) => { fol[x.target] = 1; });
      const tags = await tagsFor(env, rows.map((v) => v.id));
      const by = {};
      rows.forEach((v) => {
        const g = by[v.uid] || (by[v.uid] = { id: v.uid, nick: v.nick || '', av: v.av || '🎩', avu: avLink(url.origin, { id: v.uid, avimg: v.avimg, avurl: v.avurl }), items: [], last: 0 });
        const o = vidOut(url, v, user, null, tags); o.seen = !!seen[v.id];
        g.items.push(o); g.last = Math.max(g.last, v.at);
      });
      const list = Object.values(by).map((g) => Object.assign(g, { fresh: g.items.some((x) => !x.seen) }))
        .sort((a, b) => (b.id === user.id) - (a.id === user.id) || (b.fresh - a.fresh) || ((fol[b.id] | 0) - (fol[a.id] | 0)) || b.last - a.last)
        .slice(0, 60);
      return json({ list }, 200, cors);
    }

    // 3g2. Отметки: где меня отметили, показать у себя, убрать отметку, повторить историю у себя
    if (body && url.pathname === '/tags') {
      const me = await getPlayer(env, user);
      const act = clean(body.act || 'list', 10);
      const vid = Number(body.vid) || 0;
      if (act === 'show' || act === 'untag') {
        if (act === 'show') await env.DB.prepare('UPDATE vtags SET shown=? WHERE vid=? AND uid=?').bind(body.on ? 1 : 0, vid, user.id).run();
        else await env.DB.prepare('DELETE FROM vtags WHERE vid=? AND uid=?').bind(vid, user.id).run();
        return json({ ok: true }, 200, cors);
      }
      if (act === 'repost') {
        if (me && me.banned) return json({ error: 'banned' }, 403, cors);
        const t0 = await env.DB.prepare('SELECT 1 x FROM vtags WHERE vid=? AND uid=?').bind(vid, user.id).first();
        const v = await env.DB.prepare('SELECT v.*, p.nick FROM vids v LEFT JOIN players p ON p.id=v.uid WHERE v.id=? AND v.hidden=0').bind(vid).first();
        if (!t0 || !v) return json({ error: 'nope' }, 404, cors);
        await env.DB.prepare(`INSERT INTO vids(uid,title,file_id,thumb,dur,size,at,kind,media,until,ad) VALUES(?,?,?,?,?,?,?,'story',?,?,0)`)
          .bind(user.id, `с @${(v.nick || 'участник').slice(0, 20)}${v.title ? ': ' + v.title : ''}`.slice(0, 80), v.file_id, v.thumb, v.dur, v.size, NOW(),
            v.media || (v.kind === 'photo' ? 'photo' : 'video'), NOW() + 86400000).run();
        await env.DB.prepare('UPDATE vtags SET shown=1 WHERE vid=? AND uid=?').bind(vid, user.id).run();
        return json({ ok: true }, 200, cors);
      }
      // Список: свои отметки видит сам человек целиком, чужие — только те, что он показал
      const uid = Number(body.uid) || user.id;
      const mine = uid === user.id;
      const r = await env.DB.prepare(`SELECT v.*, p.nick, p.av, t.shown tshown FROM vtags t JOIN vids v ON v.id=t.vid LEFT JOIN players p ON p.id=v.uid
        WHERE t.uid=? AND v.hidden=0 AND (t.shown=1 OR ?=1) AND (COALESCE(v.kind,'reel')<>'story' OR v.until>?) ORDER BY v.id DESC LIMIT 60`)
        .bind(uid, mine ? 1 : 0, NOW()).all();
      const rows = r.results || [];
      const tags = await tagsFor(env, rows.map((v) => v.id));
      return json({ list: rows.map((v) => Object.assign(vidOut(url, v, user, null, tags), { shown: !!v.tshown })) }, 200, cors);
    }

    // 3h. Видео: лента и страница человека
    if (body && url.pathname === '/vids') {
      const own = isOwner(env, user);
      const who = Number(body.uid) || 0;
      const see = own ? 1 : 0;
      // Страница человека — все его публикации; общая лента — только ролики
      const sql = who
        ? `SELECT v.*, p.nick, p.av FROM vids v LEFT JOIN players p ON p.id=v.uid
            WHERE v.uid=? AND (v.hidden=0 OR ?=1 OR v.uid=?) AND COALESCE(v.kind,'reel')<>'story' ORDER BY v.id DESC LIMIT 90`
        : `SELECT v.*, p.nick, p.av FROM vids v LEFT JOIN players p ON p.id=v.uid
            WHERE (v.hidden=0 OR ?=1 OR v.uid=?) AND COALESCE(v.kind,'reel')='reel'
            ORDER BY (v.boost_until > ${NOW()}) DESC, v.id DESC LIMIT 40`;
      const r = who
        ? await env.DB.prepare(sql).bind(who, see, user.id).all()
        : await env.DB.prepare(sql).bind(see, user.id).all();
      const mine = await env.DB.prepare('SELECT vid, liked FROM vseen WHERE uid=?').bind(user.id).all();
      const liked = {};
      (mine.results || []).forEach((x) => { if (x.liked) liked[x.vid] = 1; });
      const rows = r.results || [];
      const tags = await tagsFor(env, rows.map((v) => v.id));
      const list = rows.map((v) => vidOut(url, v, user, liked, tags));
      return json({ list, owner: own }, 200, cors);
    }

    // 3i. Действия с роликом
    if (body && url.pathname === '/vid') {
      const vid = Number(body.id) || 0;
      if (!vid) return json({ error: 'id' }, 400, cors);
      const v = await env.DB.prepare('SELECT * FROM vids WHERE id=?').bind(vid).first();
      if (!v) return json({ error: 'nope' }, 404, cors);
      const act = clean(body.act, 12);
      if (act === 'sview') {
        // Просмотр истории: только считаем, в чат ничего не шлём
        // Своя история тоже отмечается просмотренной — кольцо гаснет и у автора,
        // но в счётчик и список зрителей автор не попадает
        const seen = await env.DB.prepare('SELECT 1 x FROM vseen WHERE vid=? AND uid=?').bind(vid, user.id).first();
        if (!seen) {
          await env.DB.prepare('INSERT OR IGNORE INTO vseen(vid,uid,liked,at) VALUES(?,?,0,?)').bind(vid, user.id, NOW()).run();
          if (v.uid !== user.id) await env.DB.prepare('UPDATE vids SET views=views+1 WHERE id=?').bind(vid).run();
        }
      } else if (act === 'view') {
        // Просмотр считаем один раз с человека, иначе его накрутит кто угодно
        const seen = await env.DB.prepare('SELECT 1 x FROM vseen WHERE vid=? AND uid=?').bind(vid, user.id).first();
        if (!seen) {
          await env.DB.prepare('INSERT OR IGNORE INTO vseen(vid,uid,liked) VALUES(?,?,0)').bind(vid, user.id).run();
          await env.DB.prepare('UPDATE vids SET views=views+1 WHERE id=?').bind(vid).run();
        }
        // Файл крупнее 20 МБ скачать боту нельзя, но переслать по file_id можно любой
        await tg(env, 'sendVideo', { chat_id: user.id, video: v.file_id,
          caption: `🎬 ${v.title || ''}\n\nИз ленты SHRhub` });
      } else if (act === 'like') {
        const row = await env.DB.prepare('SELECT liked FROM vseen WHERE vid=? AND uid=?').bind(vid, user.id).first();
        const now = row && row.liked ? 0 : 1;
        await env.DB.prepare('INSERT INTO vseen(vid,uid,liked) VALUES(?,?,?) ON CONFLICT(vid,uid) DO UPDATE SET liked=?')
          .bind(vid, user.id, now, now).run();
        await env.DB.prepare('UPDATE vids SET likes=MAX(0,likes+?) WHERE id=?').bind(now ? 1 : -1, vid).run();
      } else if (act === 'report') {
        await env.DB.prepare('UPDATE vids SET flags=flags+1 WHERE id=?').bind(vid).run();
        await tellOwner(env, `🚩 Жалоба на ролик #${vid} «${v.title || ''}»\nОт: id ${user.id}\nВсего жалоб: ${(v.flags | 0) + 1}`);
      } else if (act === 'del' && (v.uid === user.id || isOwner(env, user))) {
        await env.DB.prepare('DELETE FROM vids WHERE id=?').bind(vid).run();
        await env.DB.prepare('DELETE FROM vseen WHERE vid=?').bind(vid).run();
        // Файл удаляем, только если на него не ссылается чья-то история «с отметкой»
        const more = await env.DB.prepare('SELECT 1 x FROM vids WHERE file_id=?').bind(v.file_id).first();
        if (!more) await dropMedia(env, v.file_id, v.thumb);
      } else if (act === 'hide' && isOwner(env, user)) {
        await env.DB.prepare('UPDATE vids SET hidden=? WHERE id=?').bind(body.on ? 1 : 0, vid).run();
        if (body.on) { try { await tg(env, 'sendMessage', { chat_id: v.uid,
          text: `Твой ролик «${v.title || ''}» снят с ленты: он нарушает правила клуба (без наркотиков, оружия, насилия и чужого контента). Если считаешь это ошибкой — ответь на это сообщение.` }); } catch (e) {} }
      }
      return json({ ok: true }, 200, cors);
    }

    // 3f1. Карточка участника: имя, город, день рождения и кто это видит.
    // Телефон сюда не принимаем — его кладёт только сам Telegram.
    if (body && url.pathname === '/card') {
      const me = await getPlayer(env, user);
      if (body.save) {
        const rn = clean(body.realname, 40);
        const city = clean(body.city, 40);
        // Дата рождения в виде ММ-ДД, год — отдельно и по желанию. Год нужен
        // только для статистики возрастов: другим участникам он не виден.
        const bd = /^\d{2}-\d{2}$/.test(String(body.bday || '')) ? String(body.bday) : '';
        const yNow = new Date().getUTCFullYear();
        let by = Number(body.byear) || 0;
        if (by && (by < 1920 || by > yNow)) return json({ error: 'year' }, 400, cors);
        // Клуб — 18+. Год, по которому человеку меньше 18, не сохраняем.
        if (by && yNow - by < 18) return json({ error: 'age' }, 400, cors);
        const sp = ['no', 'own', 'club'].includes(body.showphone) ? body.showphone : 'no';
        await env.DB.prepare(
          `UPDATE players SET realname=?, city=?, bday=?, byear=?, showphone=?, showbday=? WHERE id=?`)
          .bind(rn, city, bd, by, sp === 'club' ? 2 : sp === 'own' ? 1 : 0,
            body.showbday ? 1 : 0, user.id).run();
      }
      // Телефон вписывается руками. Пока его не подтвердили кодом из SMS,
      // он помечен неподтверждённым — вписать можно и чужой номер, и другие
      // должны это понимать. Подтверждение по SMS подключим отдельно.
      if (body.save && body.phone !== undefined) {
        const raw = String(body.phone || '').replace(/[\s()\-]/g, '');
        if (raw === '') {
          await env.DB.prepare('UPDATE players SET phone=NULL, phone_ok=0, showphone=0 WHERE id=?').bind(user.id).run();
        } else {
          if (!/^\+?\d{7,15}$/.test(raw)) return json({ error: 'phone' }, 400, cors);
          const ph = raw.startsWith('+') ? raw : '+' + raw;
          const old = await env.DB.prepare('SELECT phone FROM players WHERE id=?').bind(user.id).first();
          if (!old || old.phone !== ph) {
            await env.DB.prepare('UPDATE players SET phone=?, phone_ok=0 WHERE id=?').bind(ph, user.id).run();
          }
        }
      }
      if (body.drop === 'phone') {
        await env.DB.prepare('UPDATE players SET phone=NULL, showphone=0 WHERE id=?').bind(user.id).run();
      }
      const r = await env.DB.prepare(
        `SELECT realname, city, bday, COALESCE(byear,0) byear, phone, COALESCE(phone_ok,0) pok,
                COALESCE(showphone,0) sp, COALESCE(showbday,1) sb
           FROM players WHERE id=?`).bind(user.id).first();
      return json({
        realname: (r && r.realname) || '', city: (r && r.city) || '', bday: (r && r.bday) || '',
        byear: (r && r.byear) || 0, phone: (r && r.phone) || '', phoneOk: !!(r && r.pok),
        showphone: r && r.sp === 2 ? 'club' : r && r.sp === 1 ? 'own' : 'no',
        showbday: !!(r && r.sb),
      }, 200, cors);
    }

    // 3f2. Заказы: заявка на работу и её путь от «новой» до «сдана»
    if (body && url.pathname === '/orders') {
      const me = await getPlayer(env, user);
      const own = isOwner(env, user);
      const act = String(body.act || '');
      const STATES = ['new', 'talk', 'work', 'done', 'no'];
      if (act === 'add') {
        if (me && me.banned) return json({ error: 'banned' }, 403, cors);
        const title = clean(body.title, 80);
        const text = clean(body.text, 1200);
        const budget = clean(body.budget, 40);
        if (!title || !text) return json({ error: 'empty' }, 400, cors);
        // Одна заявка в десять минут: заказ — не сообщение в чате
        const last = await env.DB.prepare('SELECT at FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1')
          .bind(user.id).first();
        if (last && NOW() - last.at < 600000) return json({ error: 'slow' }, 429, cors);
        await env.DB.prepare(
          `INSERT INTO orders(uid,title,text,budget,at,upd,state) VALUES(?,?,?,?,?,?,'new')`)
          .bind(user.id, title, text, budget, NOW(), NOW()).run();
        await logEvent(env, user.id, 'order', title.slice(0, 40));
        await tellOwner(env, `🧰 Заявка от ${(me && me.nick) || 'участника'} (id ${user.id})\n\n`
          + `${title}\n${budget ? `Бюджет: ${budget}\n` : ''}\n${text.slice(0, 600)}`);
      } else if (act === 'state' && own) {
        const id = Number(body.id) || 0;
        const st = STATES.includes(body.state) ? body.state : '';
        const price = clean(body.price, 40);
        const note = clean(body.note, 400);
        const o = await env.DB.prepare('SELECT uid, title, state FROM orders WHERE id=?').bind(id).first();
        if (o && st) {
          await env.DB.prepare('UPDATE orders SET state=?, price=?, note=?, upd=? WHERE id=?')
            .bind(st, price, note, NOW(), id).run();
          // Автору важно узнать об ответе там же, где он его ждёт
          const word = { talk: 'обсуждаем', work: 'в работе', done: 'сдан', no: 'отменён', new: 'новая' }[st];
          const line = `🧰 Заказ «${String(o.title).slice(0, 60)}» — ${word}.`
            + (price ? `\nЦена: ${price}` : '') + (note ? `\n${note}` : '');
          await pmPut(env, user.id, o.uid, line, 'SHRhub', url.origin);
        }
      } else if (act === 'paid' && own) {
        const id = Number(body.id) || 0;
        await env.DB.prepare('UPDATE orders SET paid=?, upd=? WHERE id=?')
          .bind(body.paid ? 1 : 0, NOW(), id).run();
      } else if (act === 'cancel') {
        const id = Number(body.id) || 0;
        const o = await env.DB.prepare('SELECT uid, state FROM orders WHERE id=?').bind(id).first();
        // Отменить свою заявку можно, пока к ней не приступили
        if (o && (own || (o.uid === user.id && (o.state === 'new' || o.state === 'talk')))) {
          await env.DB.prepare("UPDATE orders SET state='no', upd=? WHERE id=?").bind(NOW(), id).run();
        }
      }
      const r = own
        ? await env.DB.prepare(
            `SELECT o.*, p.nick, p.av, p.avimg, p.avurl FROM orders o LEFT JOIN players p ON p.id=o.uid
              ORDER BY (o.state='done' OR o.state='no') ASC, o.id DESC LIMIT 60`).all()
        : await env.DB.prepare(
            `SELECT o.*, p.nick, p.av, p.avimg, p.avurl FROM orders o LEFT JOIN players p ON p.id=o.uid
              WHERE o.uid=? ORDER BY o.id DESC LIMIT 40`).bind(user.id).all();
      const list = (r.results || []).map((o) => ({
        id: o.id, uid: o.uid, title: o.title, text: o.text, budget: o.budget || '',
        at: o.at, upd: o.upd, state: o.state || 'new', price: o.price || '', note: o.note || '',
        paid: !!o.paid, nick: o.nick || '—', av: o.av || '🎩',
        avu: avLink(url.origin, { id: o.uid, avimg: o.avimg, avurl: o.avurl }),
        mine: o.uid === user.id,
      }));
      return json({ list, owner: own }, 200, cors);
    }

    // 3g2. Подарки участникам: каталог Telegram плюс комиссия клуба
    if (body && url.pathname === '/gifts') {
      const me = await getPlayer(env, user);
      const fee = await giftFee(env);
      if (body.act === 'buy') {
        if (me && me.banned) return json({ error: 'banned' }, 403, cors);
        const to = Number(body.to) || 0;
        if (!to || to === user.id) return json({ error: 'who' }, 400, cors);
        const peer = await env.DB.prepare('SELECT id, nick FROM players WHERE id=?').bind(to).first();
        if (!peer) return json({ error: 'nope' }, 404, cors);
        const list = await giftList(env);
        const g = list.find((x) => x.id === String(body.id));
        if (!g) return json({ error: 'gone' }, 404, cors);
        const total = g.stars + fee;
        const note = clean(body.text, 120);
        const inv = {
          title: `Подарок для ${peer.nick || 'участника'}`,
          description: `Подарок Telegram за ${g.stars} ⭐ и ${fee} ⭐ клубу. Получатель не сможет обменять его на звёзды.`,
          payload: `${user.id}:gift:${g.id}:${to}:${g.stars}:${fee}`,
          currency: 'XTR',
          prices: [{ label: 'Подарок', amount: total }],
        };
        if (note) {
          try {
            await env.DB.prepare(
              `INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
              .bind(`gnote:${user.id}:${to}`, note).run();
          } catch (e) {}
        }
        const r = await tg(env, 'createInvoiceLink', inv);
        return r.ok ? json({ link: r.result, total, fee, stars: g.stars }, 200, cors)
          : json({ error: r.description || 'telegram' }, 502, cors);
      }
      const list = await giftList(env);
      const own = isOwner(env, user);
      let earned = null;
      if (own) {
        const e = await env.DB.prepare(
          "SELECT COUNT(*) n, COALESCE(SUM(fee),0) f FROM pgifts WHERE state='sent'").first();
        earned = { n: e ? e.n | 0 : 0, stars: e ? e.f | 0 : 0 };
      }
      const mine = await env.DB.prepare(
        `SELECT g.*, p.nick FROM pgifts g LEFT JOIN players p ON p.id=g.peer
          WHERE g.uid=? ORDER BY g.id DESC LIMIT 20`).bind(user.id).all();
      const got = await env.DB.prepare(
        `SELECT g.at, g.gift, g.stars, p.nick FROM pgifts g LEFT JOIN players p ON p.id=g.uid
          WHERE g.peer=? AND g.state='sent' ORDER BY g.id DESC LIMIT 20`).bind(user.id).all();
      return json({
        list: list.map((g) => ({ id: g.id, stars: g.stars, total: g.stars + fee, left: g.left,
          th: g.th ? `${url.origin}/gfile?id=${encodeURIComponent(g.id)}` : '' })),
        fee, owner: own, earned,
        sent: (mine.results || []).map((x) => ({ at: x.at, nick: x.nick || '—', stars: x.stars,
          fee: x.fee, state: x.state })),
        got: (got.results || []).map((x) => ({ at: x.at, nick: x.nick || '—', stars: x.stars })),
      }, 200, cors);
    }

    // 3h. Поиск участника по имени или номеру в клубе. Нужен, чтобы написать
    // человеку, с которым ещё не переписывался: листать весь список долго.
    if (body && url.pathname === '/find') {
      await getPlayer(env, user);
      const own = isOwner(env, user);
      const q = clean(body.q, 32).trim();
      if (q.length < 2) return json({ list: [] }, 200, cors);
      const num = own ? (Number(q) || 0) : -1; // по номеру ищет только владелец
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const r = await env.DB.prepare(
        `SELECT p.id, p.nick, p.av, p.seen, p.no, p.avimg, p.avurl, p.tier, p.tier_until,
                COALESCE(f.hidden,0) hidden, COALESCE(f.noseen,0) noseen
           FROM players p LEFT JOIN prefs f ON f.uid = p.id
          WHERE p.id <> ? AND COALESCE(p.banned,0) = 0
            AND (p.nick LIKE ? COLLATE NOCASE OR p.no = ?)
          ORDER BY p.seen DESC LIMIT 20`).bind(user.id, like, num).all();
      const list = (r.results || []).map((x) => ({
        id: x.id, nick: x.nick || '—', av: x.av || '🎩', no: own ? (x.no || 0) : 0,
        avu: avLink(url.origin, x),
        // Кто скрылся — остаётся в поиске, но время его визита не показываем
        seen: seenFor(own, x.hidden, x.noseen, x.seen),
        tier: x.tier_until > NOW() ? x.tier : 0,
      }));
      return json({ list }, 200, cors);
    }

    // 3i. Предложения: что люди хотят видеть в клубе
    if (body && url.pathname === '/ideas') {
      const me = await getPlayer(env, user);
      const own = isOwner(env, user);
      const act = String(body.act || '');
      if (act === 'add') {
        if (me && me.banned) return json({ error: 'banned' }, 403, cors);
        const text = clean(body.text, 400);
        if (!text) return json({ error: 'empty' }, 400, cors);
        // Одно предложение в час с человека: это не чат, спешить некуда
        const last = await env.DB.prepare('SELECT at FROM ideas WHERE uid=? ORDER BY id DESC LIMIT 1')
          .bind(user.id).first();
        if (last && NOW() - last.at < 3600000) return json({ error: 'slow' }, 429, cors);
        const ins = await env.DB.prepare('INSERT INTO ideas(uid,text,at,votes) VALUES(?,?,?,1)')
          .bind(user.id, text, NOW()).run();
        const iid = (ins.meta && ins.meta.last_row_id) || 0;
        // Автор голосует за своё сразу, иначе пришлось бы жать отдельно
        if (iid) await env.DB.prepare('INSERT OR IGNORE INTO ivotes(iid,uid) VALUES(?,?)').bind(iid, user.id).run();
        await addRep(env, user.id, 2);
        await tellOwner(env, `💡 Предложение от ${(me && me.nick) || 'участника'} (id ${user.id}):\n\n${text}`);
      } else if (act === 'vote') {
        const iid = Number(body.id) || 0;
        if (!iid) return json({ error: 'id' }, 400, cors);
        const had = await env.DB.prepare('SELECT 1 x FROM ivotes WHERE iid=? AND uid=?').bind(iid, user.id).first();
        if (had) {
          await env.DB.prepare('DELETE FROM ivotes WHERE iid=? AND uid=?').bind(iid, user.id).run();
          await env.DB.prepare('UPDATE ideas SET votes=MAX(0,votes-1) WHERE id=?').bind(iid).run();
        } else {
          await env.DB.prepare('INSERT INTO ivotes(iid,uid) VALUES(?,?)').bind(iid, user.id).run();
          await env.DB.prepare('UPDATE ideas SET votes=votes+1 WHERE id=?').bind(iid).run();
        }
      } else if (act === 'mark' && own) {
        // Статус ставит только владелец: людям важно видеть, что идею прочли
        const iid = Number(body.id) || 0;
        const st = ['', 'soon', 'done', 'no'].includes(body.status) ? body.status : '';
        const note = clean(body.note, 200);
        if (iid) {
          await env.DB.prepare('UPDATE ideas SET status=?, note=? WHERE id=?').bind(st, note, iid).run();
          const row = await env.DB.prepare('SELECT uid, text FROM ideas WHERE id=?').bind(iid).first();
          // Автору говорим, что с его идеей: ради этого её и писали
          if (row && row.uid !== user.id && st) {
            const word = st === 'done' ? 'сделано' : st === 'soon' ? 'взято в работу' : 'пока не будем';
            try {
              await tg(env, 'sendMessage', { chat_id: row.uid,
                text: `💡 Твоё предложение «${String(row.text).slice(0, 80)}» — ${word}.${note ? `\n\n${note}` : ''}` });
            } catch (e) {}
          }
        }
      } else if (act === 'del') {
        const iid = Number(body.id) || 0;
        const row = await env.DB.prepare('SELECT uid FROM ideas WHERE id=?').bind(iid).first();
        if (row && (own || row.uid === user.id)) {
          await env.DB.prepare('DELETE FROM ideas WHERE id=?').bind(iid).run();
          await env.DB.prepare('DELETE FROM ivotes WHERE iid=?').bind(iid).run();
        }
      }
      const r = await env.DB.prepare(
        `SELECT i.id, i.uid, i.text, i.at, i.votes, i.status, i.note, p.nick, p.av,
                p.avimg, p.avurl,
                (SELECT COUNT(*) FROM ivotes v WHERE v.iid=i.id AND v.uid=?) mine
           FROM ideas i LEFT JOIN players p ON p.id=i.uid
          ORDER BY (i.status='done') ASC, i.votes DESC, i.id DESC LIMIT 60`)
        .bind(user.id).all();
      const list = (r.results || []).map((x) => ({
        id: x.id, uid: x.uid, text: x.text, at: x.at, votes: x.votes | 0,
        status: x.status || '', note: x.note || '',
        nick: x.nick || '—', av: x.av || '🎩', avu: avLink(url.origin, { id: x.uid, avimg: x.avimg, avurl: x.avurl }),
        mine: !!x.mine, own: x.uid === user.id,
      }));
      return json({ list, owner: own }, 200, cors);
    }

    // 3j. Личная переписка: список разговоров
    if (body && url.pathname === '/pms') {
      await getPlayer(env, user);
      const r = await env.DB.prepare(
        `SELECT m.pair, m.uid, m.text, m.at, m.kind,
                CASE WHEN m.uid=? THEN m.peer ELSE m.uid END who,
                (SELECT COUNT(*) FROM pm x WHERE x.pair=m.pair AND x.peer=? AND x.seen=0) unread,
                CASE WHEN n.pair IS NULL THEN 0 ELSE 1 END pin
           FROM pm m
           JOIN (SELECT pair, MAX(id) mid FROM pm WHERE uid=? OR peer=? GROUP BY pair) g
             ON g.mid = m.id
           LEFT JOIN pmhide h ON h.pair = m.pair AND h.uid = ?
           LEFT JOIN pmpin n ON n.pair = m.pair AND n.uid = ?
          WHERE h.at IS NULL OR m.at > h.at
          ORDER BY pin DESC, m.id DESC LIMIT 40`)
        .bind(user.id, user.id, user.id, user.id, user.id, user.id).all();
      const rows = r.results || [];
      const out = [];
      for (const x of rows) {
        const p = await env.DB.prepare(
          'SELECT id, nick, av, seen, avimg, avurl FROM players WHERE id=?').bind(x.who).first();
        const hid = await env.DB.prepare(
          'SELECT COALESCE(hidden,0) h, COALESCE(noseen,0) ns FROM prefs WHERE uid=?').bind(x.who).first();
        out.push({
          id: x.who, nick: (p && p.nick) || '?', av: (p && p.av) || '🎩', avu: avLink(url.origin, p),
          seen: seenFor(false, hid && hid.h, hid && hid.ns, (p && p.seen) || 0),
          last: x.text, kind: x.kind || 'text', at: x.at, mine: x.uid === user.id, unread: x.unread | 0,
          pin: !!x.pin,
        });
      }
      return json({ list: out, n: out.reduce((a, x) => a + x.unread, 0) }, 200, cors);
    }

    // 3k. Личная переписка: одна ветка
    if (body && url.pathname === '/pm') {
      const me = await getPlayer(env, user);
      const who = Number(body.with) || 0;
      if (!who || who === user.id) return json({ error: 'who' }, 400, cors);
      const peer = await env.DB.prepare(
        'SELECT id, nick, av, seen, avimg, avurl, COALESCE(banned,0) b FROM players WHERE id=?').bind(who).first();
      if (!peer) return json({ error: 'nope' }, 404, cors);
      const pair = pairOf(user.id, who);
      // Закрепить разговор наверху своего списка
      if (body.pin !== undefined) {
        if (body.pin) {
          await env.DB.prepare(
            `INSERT INTO pmpin(uid,pair,at) VALUES(?,?,?)
             ON CONFLICT(uid,pair) DO UPDATE SET at=excluded.at`).bind(user.id, pair, NOW()).run();
        } else {
          await env.DB.prepare('DELETE FROM pmpin WHERE uid=? AND pair=?').bind(user.id, pair).run();
        }
        return json({ ok: true, pin: !!body.pin }, 200, cors);
      }
      // Удалить разговор: у себя — прячем, у обоих — стираем насовсем
      if (body.wipe) {
        if (body.wipe === 'both') {
          await env.DB.prepare('DELETE FROM pm WHERE pair=?').bind(pair).run();
          await env.DB.prepare('DELETE FROM pmhide WHERE pair=?').bind(pair).run();
          await env.DB.prepare('DELETE FROM pmpin WHERE pair=?').bind(pair).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO pmhide(uid,pair,at) VALUES(?,?,?)
             ON CONFLICT(uid,pair) DO UPDATE SET at=excluded.at`).bind(user.id, pair, NOW()).run();
          await env.DB.prepare('UPDATE pm SET seen=1 WHERE pair=? AND peer=?').bind(pair, user.id).run();
        }
        return json({ ok: true, wiped: body.wipe }, 200, cors);
      }
      if (body.react) {
        const mid = Number(body.react) || 0;
        const m = await env.DB.prepare('SELECT 1 x FROM pm WHERE id=? AND pair=?').bind(mid, pair).first();
        if (m) await reactSet(env, 'pm', mid, user.id, String(body.emo || ''));
      }
      // Удалить можно только своё сообщение — и у обоих сразу, как в телеграме
      if (body.del) {
        const mid = Number(body.del) || 0;
        const m = await env.DB.prepare('SELECT uid, file_id, thumb FROM pm WHERE id=? AND pair=?').bind(mid, pair).first();
        if (m && (m.uid === user.id || isOwner(env, user))) {
          await env.DB.prepare('DELETE FROM pm WHERE id=?').bind(mid).run();
          await dropMedia(env, m.file_id, m.thumb);
        }
      }
      // Исправить можно только своё текстовое сообщение и только в течение
      // двух суток — как в телеграме. Старую переписку переписывать задним
      // числом нельзя: собеседник уже на неё ответил.
      if (body.edit) {
        const mid = Number(body.edit) || 0;
        const nt = clean(body.etext, 600);
        const m = await env.DB.prepare('SELECT uid, kind, at FROM pm WHERE id=? AND pair=?').bind(mid, pair).first();
        if (!m || m.uid !== user.id) return json({ error: 'notyours' }, 403, cors);
        if ((m.kind || 'text') !== 'text') return json({ error: 'notext' }, 400, cors);
        if (NOW() - m.at > 48 * 3600000) return json({ error: 'old' }, 400, cors);
        if (!nt) return json({ error: 'empty' }, 400, cors);
        if (me && me.banned) return json({ error: 'banned' }, 403, cors);
        await env.DB.prepare('UPDATE pm SET text=?, edited=? WHERE id=?').bind(nt, NOW(), mid).run();
      }
      const text = clean(body.text, 600);
      if (text) {
        if (me && me.banned) return json({ error: 'banned' }, 403, cors);
        // Защита от шквала сообщений: больше 20 за минуту — это уже не разговор
        const spam = await env.DB.prepare(
          'SELECT COUNT(*) n FROM pm WHERE uid=? AND at>?').bind(user.id, NOW() - 60000).first();
        if (spam && spam.n >= 20) return json({ error: 'slow' }, 429, cors);
        await env.DB.prepare('INSERT INTO pm(pair,uid,peer,text,at,seen) VALUES(?,?,?,?,?,0)')
          .bind(pair, user.id, who, text, NOW()).run();
        await addRep(env, user.id, 1);
        // Если человека сейчас нет в приложении, пусть письмо дождётся его в Telegram
        // Приложение отмечается на сервере раз в 20 секунд. Значит, кто сейчас
        // в нём — молчим, он и так увидит сообщение в открытой ветке. Все
        // остальные получают письмо от бота, даже если вышли минуту назад.
        if (!peer.seen || NOW() - peer.seen > 60000) {
          await pmNotify(env, who, user.id, (me && me.nick) || 'Участник клуба', text, null, url.origin);
        }
      }
      // Входящие в этой ветке прочитаны
      await env.DB.prepare('UPDATE pm SET seen=1 WHERE pair=? AND peer=? AND seen=0')
        .bind(pair, user.id).run();
      const before = Number(body.before) || 0;
      const cols = 'id,uid,text,at,seen,kind,thumb,file_id,dur,size,edited';
      const r = before
        ? await env.DB.prepare(`SELECT ${cols} FROM pm WHERE pair=? AND id<? ORDER BY id DESC LIMIT 40`)
            .bind(pair, before).all()
        : await env.DB.prepare(`SELECT ${cols} FROM pm WHERE pair=? ORDER BY id DESC LIMIT 40`)
            .bind(pair).all();
      const raw = (r.results || []).reverse();
      const more = raw.length === 40;
      const list = [];
      const rx = await reactsFor(env, 'pm', raw.map((m) => m.id), user.id);
      for (const m of raw) {
        const o = { id: m.id, uid: m.uid, text: m.text, at: m.at, seen: m.seen | 0, kind: m.kind || 'text', ed: m.edited ? 1 : 0, re: rx[m.id] || [] };
        if (o.kind !== 'text' && m.file_id) {
          o.thumb = await mediaUrl(env, url.origin, m.id, user.id, 'thumb');
          o.dur = m.dur | 0;
          o.size = m.size | 0;
          // Ролик крупнее 20 МБ в приложении не играет: Telegram не отдаёт файл
          o.src = (o.kind === 'photo' || isR2(m.file_id) || (m.size > 0 && m.size <= 19 * 1024 * 1024))
            ? await mediaUrl(env, url.origin, m.id, user.id, 'full') : '';
        }
        list.push(o);
      }
      const hid = await env.DB.prepare('SELECT COALESCE(hidden,0) h, COALESCE(noseen,0) ns FROM prefs WHERE uid=?').bind(who).first();
      return json({ list, more, peer: { id: peer.id, nick: peer.nick, av: peer.av,
        avu: avLink(url.origin, peer), seen: seenFor(isOwner(env, user), hid && hid.h, hid && hid.ns, peer.seen) } }, 200, cors);
    }

    // 3g0. Ник: проверить, свободен ли, и занять его
    if (body && url.pathname === '/nick') {
      const row = await getPlayer(env, user);
      const nick = clean(String(body.nick || '').replace(/\s+/g, ' ').trim(), 16);
      if (nickKey(nick).length < 2) return json({ error: 'short' }, 400, cors);
      const mine = nickKey(nick) === nickKey(row.nick);
      const free = mine || await nickFree(env, nick, user.id);
      if (body.check) return json({ free, nick }, 200, cors);
      if (!free) return json({ error: 'taken' }, 409, cors);
      await env.DB.prepare('UPDATE players SET nick=?, nkey=? WHERE id=?').bind(nick, nickKey(nick), user.id).run();
      return json({ ok: true, nick }, 200, cors);
    }

    // 3g. Подписки
    if (body && url.pathname === '/follow') {
      await getPlayer(env, user);
      const target = Number(body.target) || 0;
      // Заявки ко мне: принять, отклонить, список
      if (body.act === 'accept' || body.act === 'decline') {
        const from = Number(body.uid) || 0;
        if (body.act === 'accept') {
          await env.DB.prepare('UPDATE follows SET ok=1 WHERE uid=? AND target=?').bind(from, user.id).run();
          const me0 = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(user.id).first();
          try { await tg(env, 'sendMessage', { chat_id: from, text: `✅ ${(me0 && me0.nick) || 'Участник клуба'} принял(а) твою заявку в SHRhub` }); } catch (e) {}
        } else await env.DB.prepare('DELETE FROM follows WHERE uid=? AND target=? AND COALESCE(ok,1)=0').bind(from, user.id).run();
      }
      if (body.act === 'reqs' || body.act === 'accept' || body.act === 'decline') {
        const r = await env.DB.prepare(`SELECT p.id, p.nick, p.av, p.avimg, p.avurl, w.at,
            EXISTS(SELECT 1 FROM follows b WHERE b.uid=? AND b.target=p.id) back
          FROM follows w JOIN players p ON p.id=w.uid WHERE w.target=? AND COALESCE(w.ok,1)=0 ORDER BY w.at DESC LIMIT 100`).bind(user.id, user.id).all();
        return json({ reqs: (r.results || []).map((x) => ({ id: x.id, nick: x.nick || '', av: x.av || '🎩',
          avu: avLink(url.origin, x), at: x.at, back: !!x.back })) }, 200, cors);
      }
      if (target && target !== user.id) {
        if (body.on) {
          // Подписка — это заявка: человек сам решает, принять её или нет
          const ex = await env.DB.prepare('SELECT ok FROM follows WHERE uid=? AND target=?').bind(user.id, target).first();
          if (!ex) {
            await env.DB.prepare('INSERT OR IGNORE INTO follows(uid,target,at,ok) VALUES(?,?,?,0)')
              .bind(user.id, target, NOW()).run();
            const me0 = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(user.id).first();
            const app = env.APP_URL ? `${env.APP_URL}${env.APP_URL.includes('?') ? '&' : '?'}api=${encodeURIComponent(url.origin)}&reqs=1` : '';
            try { await tg(env, 'sendMessage', { chat_id: target, text: `👋 ${(me0 && me0.nick) || 'Участник клуба'} хочет подписаться на тебя в SHRhub`,
              reply_markup: app ? { inline_keyboard: [[{ text: 'Посмотреть заявку', web_app: { url: app } }]] } : undefined }); } catch (e) {}
          }
        } else {
          await env.DB.prepare('DELETE FROM follows WHERE uid=? AND target=?').bind(user.id, target).run();
        }
      }
      // Список тех, за кем человек следит: это его записная книжка
      const r = await env.DB.prepare(
        `SELECT p.id, p.nick, p.av, p.pts, p.best, p.seen, p.tier, p.tier_until,
                COALESCE(f.hidden,0) hidden, COALESCE(f.noseen,0) noseen
           FROM follows w JOIN players p ON p.id = w.target
           LEFT JOIN prefs f ON f.uid = p.id
          WHERE w.uid = ? AND COALESCE(w.ok,1)=1 ORDER BY p.seen DESC LIMIT 100`).bind(user.id).all();
      const list = (r.results || []).map((x) => ({
        id: x.id, nick: x.nick, av: x.av, pts: x.pts, best: x.best,
        tier: x.tier_until > NOW() ? x.tier : 0,
        seen: seenFor(isOwner(env, user), x.hidden, x.noseen, x.seen),
      }));
      const rq = await env.DB.prepare('SELECT COUNT(*) n FROM follows WHERE target=? AND COALESCE(ok,1)=0').bind(user.id).first();
      return json({ list, n: list.length, reqN: rq ? rq.n : 0 }, 200, cors);
    }

    // 3f. Карточка игрока: то, что любой участник может о нём узнать
    if (body && url.pathname === '/profile') {
      const uid = Number(body.uid) || 0;
      if (!uid) return json({ error: 'uid' }, 400, cors);
      const own = isOwner(env, user);
      const p = await env.DB.prepare(
        `SELECT id,nick,av,no,pts,best,total,seen,tier,tier_until,COALESCE(rep,0) rep,
                avimg, avurl, realname, city, bday, phone,
                COALESCE(showphone,0) showphone, COALESCE(showbday,1) showbday, COALESCE(phone_ok,0) phone_ok,
                COALESCE(banned,0) banned, COALESCE(chat_ok,0) chat_ok, clan
           FROM players WHERE id=?`).bind(uid).first();
      if (!p) return json({ error: 'nope' }, 404, cors);
      const hid = await env.DB.prepare('SELECT hidden, COALESCE(noseen,0) noseen FROM prefs WHERE uid=?').bind(uid).first();
      const stars = own ? await env.DB.prepare('SELECT COALESCE(SUM(stars),0) s FROM pays WHERE uid=?').bind(uid).first() : null;
      const fo = await env.DB.prepare('SELECT COUNT(*) n FROM follows WHERE target=? AND COALESCE(ok,1)=1').bind(uid).first();
      const fi = await env.DB.prepare('SELECT COUNT(*) n FROM follows WHERE uid=? AND COALESCE(ok,1)=1').bind(uid).first();
      const mine = await env.DB.prepare('SELECT COALESCE(ok,1) ok FROM follows WHERE uid=? AND target=?').bind(user.id, uid).first();
      const theirs = await env.DB.prepare('SELECT COALESCE(ok,1) ok FROM follows WHERE uid=? AND target=?').bind(uid, user.id).first();
      const posts = await env.DB.prepare("SELECT COUNT(*) n FROM vids WHERE uid=? AND (hidden=0 OR ?=1) AND COALESCE(kind,'reel')<>'story'").bind(uid, uid === user.id || own ? 1 : 0).first();
      const story = await env.DB.prepare("SELECT COUNT(*) n FROM vids WHERE uid=? AND kind='story' AND until>? AND hidden=0").bind(uid, NOW()).first();
      const canCall = uid !== user.id && await callAllowed(env, uid, user.id);
      const out = {
        id: p.id, nick: p.nick, av: p.av, avu: avLink(url.origin, p), no: own ? p.no : 0, pts: p.pts, best: p.best, rep: p.rep,
        realname: p.realname || '', city: p.city || '',
        bday: p.showbday === 0 ? '' : (p.bday || ''),
        // Номер показываем ровно тем, кому человек разрешил
        phone: (p.showphone === 2 || (p.showphone === 1 && own)) ? (p.phone || '') : '',
        phoneOk: !!p.phone_ok,
        tier: p.tier_until > NOW() ? p.tier : 0,
        seen: seenFor(own, hid && hid.hidden, hid && hid.noseen, p.seen),
        clan: p.clan || null,
        followers: fo ? fo.n : 0, following: fi ? fi.n : 0, iFollow: !!(mine && mine.ok), iAsked: !!(mine && !mine.ok),
        theyAsk: !!(theirs && !theirs.ok), theyFollow: !!(theirs && theirs.ok),
        posts: posts ? posts.n : 0, canCall: !!canCall, story: story ? story.n : 0,
      };
      if (own) { out.banned = !!p.banned; out.chat_ok = !!p.chat_ok; out.stars = stars ? stars.s : 0; out.total = p.total; }
      return json({ player: out, owner: own }, 200, cors);
    }

    // 3z. Звонки: голосовые, видео и конференции до 5 человек. Сервер только
    // сводит телефоны друг с другом; разговор идёт напрямую и шифруется.
    if (body && url.pathname === '/call') {
      const me = await getPlayer(env, user);
      const T = NOW();
      const act = clean(body.act, 10);
      const cid = clean(body.id || '', 24);
      const myName = (me && me.nick) || 'Участник клуба';
      // Входящий: приложение спрашивает, не звонит ли кто
      if (act === 'ring') {
        const r = await env.DB.prepare(`SELECT c.id, c.host, c.video, p.nick, p.av, p.avimg, p.avurl
          FROM cmem m JOIN calls c ON c.id=m.call LEFT JOIN players p ON p.id=c.host
          WHERE m.uid=? AND m.state='ring' AND c.ended=0 AND m.at>? ORDER BY m.at DESC LIMIT 1`).bind(user.id, T - CALL_RING).first();
        return json({ call: r ? { id: r.id, video: !!r.video, host: { id: r.host, nick: r.nick || '', av: r.av || '🎩',
          avu: avLink(url.origin, { id: r.host, avimg: r.avimg, avurl: r.avurl }) } } : null }, 200, cors);
      }
      if (me && me.banned) return json({ error: 'banned' }, 403, cors);
      if (act === 'start') {
        const to = [...new Set((Array.isArray(body.to) ? body.to : [body.to]).map(Number))]
          .filter((x) => x && x !== user.id).slice(0, CALL_MAX - 1);
        if (!to.length) return json({ error: 'who' }, 400, cors);
        const many = await env.DB.prepare('SELECT COUNT(*) n FROM calls WHERE host=? AND at>?').bind(user.id, T - 3600000).first();
        if (many && many.n >= 30) return json({ error: 'slow' }, 429, cors);
        const ok = [];
        for (const x of to) if (await callAllowed(env, x, user.id)) ok.push(x);
        if (!ok.length) return json({ error: 'nocall' }, 403, cors);
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
        const video = body.video ? 1 : 0;
        await env.DB.prepare('INSERT INTO calls(id,host,video,at) VALUES(?,?,?,?)').bind(id, user.id, video, T).run();
        await env.DB.prepare("INSERT INTO cmem(call,uid,state,at,seen,cam) VALUES(?,?,'in',?,?,?)").bind(id, user.id, T, T, body.cam ? 1 : 0).run();
        for (const x of ok) {
          await env.DB.prepare("INSERT INTO cmem(call,uid,state,at,seen) VALUES(?,?,'ring',?,0)").bind(id, x, T).run();
          await ringNotify(env, x, myName, id, video, url.origin);
        }
        // Старые служебные записки чистим заодно, чтобы база не росла
        if (Math.random() < 0.1) {
          await env.DB.prepare('DELETE FROM csig WHERE at<?').bind(T - 3600000).run();
          await env.DB.prepare('DELETE FROM cmem WHERE call IN (SELECT id FROM calls WHERE at<?)').bind(T - 7 * 86400000).run();
          await env.DB.prepare('DELETE FROM calls WHERE at<?').bind(T - 7 * 86400000).run();
        }
        return json({ id, video: !!video, ice: await iceServers(env), skipped: to.length - ok.length, ws: !!env.CALLROOM,
          members: await callMembers(env, id, url.origin) }, 200, cors);
      }
      const c = cid ? await env.DB.prepare('SELECT * FROM calls WHERE id=?').bind(cid).first() : null;
      if (!c) return json({ error: 'nope' }, 404, cors);
      const mine = await env.DB.prepare('SELECT state FROM cmem WHERE call=? AND uid=?').bind(cid, user.id).first();
      if (!mine) return json({ error: 'nope' }, 404, cors);
      if (act === 'join') {
        if (c.ended) return json({ error: 'ended' }, 410, cors);
        const mem = await callMembers(env, cid, url.origin);
        if (mem.filter((m) => m.state === 'in' && m.id !== user.id).length >= CALL_MAX) return json({ error: 'full' }, 409, cors);
        await env.DB.prepare("UPDATE cmem SET state='in', at=?, seen=?, cam=? WHERE call=? AND uid=?").bind(T, T, body.cam ? 1 : 0, cid, user.id).run();
        await env.DB.prepare('DELETE FROM csig WHERE call=? AND dst=?').bind(cid, user.id).run();
        const host = (await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(c.host).first()) || {};
        await ringDone(env, cid, user.id, `📞 Звонок от ${host.nick || 'участника клуба'} — ты ответил(а)`);
        const last = await env.DB.prepare('SELECT COALESCE(MAX(id),0) n FROM csig').first();
        return json({ id: cid, video: !!c.video, host: c.host, ice: await iceServers(env), after: last ? last.n : 0, ws: !!env.CALLROOM,
          members: (await callMembers(env, cid, url.origin)) }, 200, cors);
      }
      if (act === 'no' || act === 'leave') {
        await env.DB.prepare('UPDATE cmem SET state=? WHERE call=? AND uid=?').bind(act === 'no' ? 'no' : 'left', cid, user.id).run();
        if (act === 'no') {
          const host = (await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(c.host).first()) || {};
          await ringDone(env, cid, user.id, `📞 Звонок от ${host.nick || 'участника клуба'} — отклонён`);
        }
        // Звонивший положил трубку до ответа — отменяем вызов у всех
        if (act === 'leave' && c.host === user.id) {
          const mem = await callMembers(env, cid, url.origin);
          if (!mem.some((m) => m.id !== user.id && m.state === 'in')) {
            await env.DB.prepare("UPDATE cmem SET state='gone' WHERE call=? AND state='ring'").bind(cid).run();
          }
        }
        await callTidy(env, cid, url.origin);
        return json({ ok: true }, 200, cors);
      }
      if (c.ended) return json({ ended: true, members: [], sigs: [] }, 200, cors);
      if (act === 'invite') {
        if (mine.state !== 'in') return json({ error: 'nope' }, 403, cors);
        const x = Number(body.to) || 0;
        if (!x || x === user.id) return json({ error: 'who' }, 400, cors);
        const mem = await callMembers(env, cid, url.origin);
        if (mem.filter((m) => m.state === 'in' || m.state === 'ring').length >= CALL_MAX) return json({ error: 'full' }, 409, cors);
        if (!await callAllowed(env, x, user.id)) return json({ error: 'nocall' }, 403, cors);
        await env.DB.prepare(`INSERT INTO cmem(call,uid,state,at,seen) VALUES(?,?,'ring',?,0)
          ON CONFLICT(call,uid) DO UPDATE SET state='ring', at=?`).bind(cid, x, T, T).run();
        await ringNotify(env, x, myName, cid, c.video, url.origin);
        return json({ ok: true, members: await callMembers(env, cid, url.origin) }, 200, cors);
      }
      // Камеру выключили или включили — остальные покажут аватар вместо картинки
      if (act === 'cam') {
        await env.DB.prepare('UPDATE cmem SET cam=? WHERE call=? AND uid=?').bind(body.on ? 1 : 0, cid, user.id).run();
        return json({ ok: true }, 200, cors);
      }
      if (act === 'sig') {
        if (mine.state !== 'in') return json({ error: 'nope' }, 403, cors);
        const dst = Number(body.to) || 0;
        const kind = ['offer', 'answer', 'bye'].includes(body.kind) ? body.kind : '';
        const data = String(body.data || '');
        if (!dst || !kind || data.length > 30000) return json({ error: 'bad' }, 400, cors);
        const peer = await env.DB.prepare('SELECT 1 x FROM cmem WHERE call=? AND uid=?').bind(cid, dst).first();
        if (!peer) return json({ error: 'who' }, 400, cors);
        await env.DB.prepare('INSERT INTO csig(call,src,dst,kind,data,at) VALUES(?,?,?,?,?,?)').bind(cid, user.id, dst, kind, data, T).run();
        return json({ ok: true }, 200, cors);
      }
      if (act === 'poll') {
        // «Я на связи» пишем не чаще раза в 8 секунд: каждая запись в базе на счету
        if (mine.state === 'in') {
          await env.DB.prepare("UPDATE cmem SET seen=? WHERE call=? AND uid=? AND state='in' AND seen<?")
            .bind(T, cid, user.id, T - 8000).run();
        }
        if (c.host === user.id) {
          const hn = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(c.host).first();
          await ringAgain(env, cid, (hn && hn.nick) || 'Участник клуба', c.video);
        }
        const after = Number(body.after) || 0;
        const s = await env.DB.prepare('SELECT id, src, kind, data FROM csig WHERE call=? AND dst=? AND id>? ORDER BY id LIMIT 20')
          .bind(cid, user.id, after).all();
        const ended = await callTidy(env, cid, url.origin);
        return json({ ended, members: ended ? [] : await callMembers(env, cid, url.origin), sigs: s.results || [] }, 200, cors);
      }
      return json({ error: 'act' }, 400, cors);
    }

    // 3d. Лента новостей: отдаём заголовки и ссылки, текст статей не трогаем
    if (body && url.pathname === '/feed') {
      const r = await env.DB.prepare('SELECT title,url,src,at FROM feed ORDER BY at DESC LIMIT 40').all();
      return json({ list: r.results || [] }, 200, cors);
    }

    // 3a. Видимость: игрок может спрятаться от других игроков
    if (body && url.pathname === '/pref') {
      await getPlayer(env, user);
      if (body.hidden !== undefined) {
        const h = body.hidden ? 1 : 0;
        await env.DB.prepare('INSERT INTO prefs(uid,hidden) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET hidden=?')
          .bind(user.id, h, h).run();
      }
      if (body.noseen !== undefined) {
        const v = body.noseen ? 1 : 0;
        await env.DB.prepare('INSERT INTO prefs(uid,noseen) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET noseen=?')
          .bind(user.id, v, v).run();
      }
      if (body.callwho !== undefined) {
        const v = Math.max(0, Math.min(3, Number(body.callwho) | 0));
        await env.DB.prepare('INSERT INTO prefs(uid,callwho) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET callwho=?')
          .bind(user.id, v, v).run();
      }
      const r = await env.DB.prepare('SELECT hidden, COALESCE(noseen,0) noseen, COALESCE(callwho,0) callwho FROM prefs WHERE uid=?').bind(user.id).first();
      return json({ ok: true, hidden: !!(r && r.hidden), noseen: !!(r && r.noseen), callwho: r ? r.callwho : 0 }, 200, cors);
    }

    // 3c. Кто сейчас в игре. Обычный игрок не видит спрятавшихся, владелец видит всех.
    if (body && url.pathname === '/online') {
      const own = isOwner(env, user);
      const since = NOW() - 300000;
      // all — весь состав клуба, а не только те, кто сейчас в приложении.
      // Спрятавшихся видит только владелец: иначе кнопка «скрыться» не работает.
      const all = !!body.all;
      const sql = `SELECT p.id, p.nick, p.av, p.no, p.joined, p.pts, p.best, p.seen, p.tier, p.tier_until,
                p.avimg, p.avurl, COALESCE(f.hidden,0) hidden, COALESCE(f.noseen,0) noseen
           FROM players p LEFT JOIN prefs f ON f.uid = p.id
          WHERE ${all ? '1=1' : 'p.seen > ?'}${own || all ? '' : ' AND COALESCE(f.hidden,0) = 0'}
          ORDER BY ${own && body.byNo ? 'p.no ASC' : 'p.seen DESC'} LIMIT ${all ? 300 : 60}`;
      const q = env.DB.prepare(sql);
      const r = await (all ? q : q.bind(since)).all();
      const tot = await env.DB.prepare(
        'SELECT COUNT(*) n FROM players').first();
      const nowN = await env.DB.prepare('SELECT COUNT(*) n FROM players WHERE seen>?').bind(since).first();
      // Саму картинку наружу не отдаём, только ссылку на неё
      const list = (r.results || []).map((x) => {
        const avu = avLink(url.origin, x);
        const base = own
          ? Object.assign({}, x, { avu })
          : { id: x.id, nick: x.nick, av: x.av, avu, pts: x.pts, best: x.best,
              seen: seenFor(false, x.hidden, x.noseen, x.seen), tier: x.tier_until > NOW() ? x.tier : 0 };
        delete base.avimg; delete base.avurl;
        return base;
      });
      return json({ list, all, n: nowN ? nowN.n : 0, total: tot ? tot.n : list.length,
        owner: own, now: NOW() }, 200, cors);
    }

    // 3b. Напоминания: игрок сам решает, писать ему или нет
    if (body && url.pathname === '/notif') {
      await getPlayer(env, user);
      const tz = Math.max(-840, Math.min(840, Number(body.tz) || 0));
      if (body.set !== undefined) {
        const on = body.set ? 1 : 0;
        await env.DB.prepare(`INSERT INTO notif(uid,on_,tz) VALUES(?,?,?)
          ON CONFLICT(uid) DO UPDATE SET on_=?, tz=?`).bind(user.id, on, tz, on, tz).run();
      } else {
        // просто обновляем часовой пояс, если игрок уехал или перевёл часы
        await env.DB.prepare('UPDATE notif SET tz=? WHERE uid=?').bind(tz, user.id).run();
      }
      const r = await env.DB.prepare('SELECT on_,mh,eh FROM notif WHERE uid=?').bind(user.id).first();
      return json({ ok: true, on: !!(r && r.on_), mh: r ? r.mh : 12, eh: r ? r.eh : 20 }, 200, cors);
    }

    // 4. Прогноз игрока: один на монету в час, он же считает настроение толпы
    if (body && url.pathname === '/vote') {
      const sym = clean(body.sym, 12).toUpperCase();
      const dir = body.dir > 0 ? 1 : -1;
      const k = Math.max(0, Math.min(1, Number(body.k) || 0));
      if (!sym) return json({ error: 'sym' }, 400, cors);
      const had = await env.DB.prepare('SELECT 1 x FROM preds WHERE uid=? AND sym=? AND hour=?')
        .bind(user.id, sym, HOUR()).first();
      await env.DB.prepare('INSERT OR REPLACE INTO preds(uid,sym,hour,dir,k,at) VALUES(?,?,?,?,?,?)')
        .bind(user.id, sym, HOUR(), dir, k, NOW()).run();
      if (!had) { await addRep(env, user.id, 3); await logEvent(env, user.id, 'pred', sym + ' ' + (dir > 0 ? '↑' : '↓')); }
      return json(await counts(env, sym), 200, cors);
    }

    // 5. Настроение толпы по монете
    if (body && url.pathname === '/sent') {
      const out = {};
      for (const s of (Array.isArray(body.syms) ? body.syms : []).slice(0, 30)) {
        const sym = clean(s, 12).toUpperCase();
        if (sym) out[sym] = await counts(env, sym);
      }
      return json(out, 200, cors);
    }

    // 6. Чат: сообщения общие для всех
    if (body && url.pathname === '/chat') {
      const room = clean(body.room, 32) || 'general';
      // Чат клана читают и пишут только его участники
      if (room.startsWith('clan:')) {
        const me0 = await getPlayer(env, user);
        if ((me0.clan | 0) !== (Number(room.slice(5)) || -1) && !isOwner(env, user)) return json({ error: 'noclan' }, 403, cors);
      }
      // Реакция смайликом на сообщение этого же чата
      if (body.react) {
        const mid = Number(body.react) || 0;
        const m = await env.DB.prepare('SELECT 1 x FROM msgs WHERE id=? AND room=?').bind(mid, room).first();
        if (m) await reactSet(env, 'msg', mid, user.id, String(body.emo || ''));
        if (!body.text) body.after = 0;
      }
      if (body.text) {
        const row = await getPlayer(env, user);
        const text = clean(body.text, 140);
        // Заблокированному чат закрыт, но ответ честный: он должен понимать, что
        // это не поломка, а решение, и что оспорить его можно через поддержку.
        if (row.banned) return json({ error: 'banned', note: row.ban_note || '' }, 403, cors);
        // Голос в чате открывается один раз и навсегда — но только если владелец
        // вообще включил плату. По умолчанию чат бесплатный.
        if (!row.chat_ok && !isOwner(env, user) && await chatPaid(env))
          return json({ error: 'needchat' }, 402, cors);
        const last = await env.DB.prepare('SELECT at FROM msgs WHERE uid=? ORDER BY id DESC LIMIT 1').bind(user.id).first();
        if (text && (!last || NOW() - last.at > 1500)) {
          await env.DB.prepare('INSERT INTO msgs(room,uid,nick,av,text,gold,at) VALUES(?,?,?,?,?,?,?)')
            .bind(room, user.id, row.nick || clean(user.first_name, 16), row.av || '🎩', text, body.gold ? 1 : 0, NOW()).run();
          if (body.gold && row.gm > 0) await env.DB.prepare('UPDATE players SET gm=gm-1 WHERE id=?').bind(user.id).run();
          await addRep(env, user.id, 1);
          await logEvent(env, user.id, 'msg', room);
        }
      }
      // before — листание в прошлое: игрок может дочитать переписку до самого начала
      const before = Math.max(0, Number(body.before) || 0);
      if (before) {
        const old = await env.DB.prepare(`SELECT m.id,m.uid,COALESCE(p.nick,m.nick) nick,COALESCE(p.av,m.av) av,m.text,m.gold,m.at,p.avimg,p.avurl
           FROM msgs m LEFT JOIN players p ON p.id=m.uid WHERE m.room=? AND m.id<? ORDER BY m.id DESC LIMIT 40`)
          .bind(room, before).all();
        const list = (old.results || []).reverse().map((x) => chatRow(url.origin, x));
        const rxo = await reactsFor(env, 'msg', list.map((x) => x.id), user.id);
        list.forEach((x) => { x.re = rxo[x.id] || []; });
        return json({ msgs: list, more: list.length === 40 }, 200, cors);
      }
      const after = Math.max(0, Number(body.after) || 0);
      const r = await env.DB.prepare(`SELECT m.id,m.uid,COALESCE(p.nick,m.nick) nick,COALESCE(p.av,m.av) av,m.text,m.gold,m.at,p.avimg,p.avurl
           FROM msgs m LEFT JOIN players p ON p.id=m.uid WHERE m.room=? AND m.id>? ORDER BY m.id DESC LIMIT 40`)
        .bind(room, after).all();
      const rows = (r.results || []).reverse().map((x) => chatRow(url.origin, x));
      const rx = await reactsFor(env, 'msg', rows.map((x) => x.id), user.id);
      rows.forEach((x) => { x.re = rx[x.id] || []; });
      return json({ msgs: rows }, 200, cors);
    }

    // 7. Кланы из живых людей
    if (body && url.pathname === '/clans') {
      const row = await getPlayer(env, user);
      const act = clean(body.act, 10);
      if (act === 'create') {
        const name = clean(body.name, 20);
        if (name.length < 3) return json({ error: 'name' }, 400, cors);
        const bought = (row.capbuy | 0);
        try {
          await env.DB.prepare('INSERT INTO clans(name,emb,cap,owner,at) VALUES(?,?,?,?,?)')
            .bind(name, clean(body.emb, 4) || '🛡', 20 + bought, user.id, NOW()).run();
        } catch (e) { return json({ error: 'taken' }, 409, cors); }
        const c = await env.DB.prepare('SELECT id FROM clans WHERE name=?').bind(name).first();
        await env.DB.prepare('UPDATE players SET clan=?, capbuy=0 WHERE id=?').bind(c.id, user.id).run();
      } else if (act === 'join') {
        const cid = Number(body.id) || 0;
        const c = await env.DB.prepare('SELECT * FROM clans WHERE id=?').bind(cid).first();
        if (!c) return json({ error: 'gone' }, 404, cors);
        const banned = await env.DB.prepare('SELECT 1 x FROM cbans WHERE clan=? AND uid=?').bind(cid, user.id).first();
        if (banned) return json({ error: 'cban' }, 403, cors);
        const n = await env.DB.prepare('SELECT COUNT(*) n FROM players WHERE clan=?').bind(cid).first();
        if (n && n.n >= c.cap) return json({ error: 'full' }, 409, cors);
        await env.DB.prepare('UPDATE players SET clan=? WHERE id=?').bind(cid, user.id).run();
      } else if (act === 'leave') {
        await env.DB.prepare('UPDATE players SET clan=0 WHERE id=?').bind(user.id).run();
      } else if (act === 'invite') {
        // Позвать человека в свой клан: бот пришлёт ему кнопку «Вступить»
        const cid = row.clan || 0;
        const c = cid ? await env.DB.prepare('SELECT id,name,cap FROM clans WHERE id=?').bind(cid).first() : null;
        const who = Number(body.uid) || 0;
        if (!c || !who || who === user.id) return json({ error: 'noclan' }, 400, cors);
        const t0 = await env.DB.prepare('SELECT clan FROM players WHERE id=?').bind(who).first();
        if (!t0) return json({ error: 'who' }, 404, cors);
        if ((t0.clan | 0) === c.id) return json({ error: 'already' }, 409, cors);
        if (await env.DB.prepare('SELECT 1 x FROM cbans WHERE clan=? AND uid=?').bind(c.id, who).first()) return json({ error: 'cban' }, 403, cors);
        const n = await env.DB.prepare('SELECT COUNT(*) n FROM players WHERE clan=?').bind(c.id).first();
        if (c.cap && n && n.n >= c.cap) return json({ error: 'full' }, 409, cors);
        const app = env.APP_URL ? `${env.APP_URL}${env.APP_URL.includes('?') ? '&' : '?'}api=${encodeURIComponent(url.origin)}&clan=${c.id}` : '';
        try { await tg(env, 'sendMessage', { chat_id: who, text: `🛡 ${row.nick || 'Участник клуба'} зовёт тебя в клан «${c.name}» в SHRhub`,
          reply_markup: app ? { inline_keyboard: [[{ text: 'Посмотреть клан', web_app: { url: app } }]] } : undefined }); } catch (e) {}
        return json({ ok: true }, 200, cors);
      } else if (['desc', 'delmsg', 'clear', 'ban', 'unban', 'pin', 'poll', 'pclose', 'emb'].includes(act)) {
        // Управление кланом: это может только тот, кто его создал,
        // и владелец платформы — ему нужно убирать нарушения
        const boss = isOwner(env, user);
        const cid = row.clan || 0;
        const c = await env.DB.prepare('SELECT id,owner,name FROM clans WHERE id=?').bind(cid).first();
        if (!c || (c.owner !== user.id && !boss)) return json({ error: 'notowner' }, 403, cors);
        const room = 'clan:' + c.id;
        if (act === 'desc') await env.DB.prepare('UPDATE clans SET descr=? WHERE id=?').bind(clean(body.text, 300) || null, c.id).run();
        else if (act === 'emb') { const e = clean(body.emb, 8); if (e) await env.DB.prepare('UPDATE clans SET emb=? WHERE id=?').bind(e, c.id).run(); }
        else if (act === 'delmsg') await env.DB.prepare('DELETE FROM msgs WHERE id=? AND room=?').bind(Number(body.id) || 0, room).run();
        else if (act === 'clear') { await env.DB.prepare('DELETE FROM msgs WHERE room=?').bind(room).run(); await env.DB.prepare('UPDATE clans SET pin=0 WHERE id=?').bind(c.id).run(); }
        else if (act === 'pin') await env.DB.prepare('UPDATE clans SET pin=? WHERE id=?').bind(Number(body.id) || 0, c.id).run();
        else if (act === 'ban' || act === 'unban') {
          const who = Number(body.uid) || 0;
          if (!who || who === c.owner) return json({ error: 'who' }, 400, cors);
          if (act === 'ban') {
            const note = clean(body.note, 120);
            await env.DB.prepare('INSERT OR REPLACE INTO cbans(clan,uid,at,note) VALUES(?,?,?,?)').bind(c.id, who, NOW(), note).run();
            await env.DB.prepare('UPDATE players SET clan=0 WHERE id=? AND clan=?').bind(who, c.id).run();
            try { await tg(env, 'sendMessage', { chat_id: who, text: `🛡 Создатель клана «${c.name}» исключил тебя из клана${note ? `. Причина: ${note}` : ''}.` }); } catch (e) {}
          } else await env.DB.prepare('DELETE FROM cbans WHERE clan=? AND uid=?').bind(c.id, who).run();
        } else if (act === 'poll') {
          const q = clean(body.q, 140);
          const opts = (Array.isArray(body.opts) ? body.opts : []).map((x) => clean(x, 60)).filter(Boolean).slice(0, 6);
          if (!q || opts.length < 2) return json({ error: 'poll' }, 400, cors);
          await env.DB.prepare('INSERT INTO cpolls(clan,q,opts,by,at) VALUES(?,?,?,?,?)').bind(c.id, q, JSON.stringify(opts), user.id, NOW()).run();
        } else if (act === 'pclose') await env.DB.prepare('UPDATE cpolls SET closed=1 WHERE id=? AND clan=?').bind(Number(body.id) || 0, c.id).run();
      } else if (act === 'vote') {
        const p = await env.DB.prepare('SELECT * FROM cpolls WHERE id=? AND clan=? AND closed=0').bind(Number(body.id) || 0, row.clan || -1).first();
        const o = Number(body.opt);
        if (p && o >= 0 && o < JSON.parse(p.opts).length) {
          await env.DB.prepare('INSERT INTO cvotes(poll,uid,opt) VALUES(?,?,?) ON CONFLICT(poll,uid) DO UPDATE SET opt=excluded.opt').bind(p.id, user.id, o).run();
        }
      } else if (act === 'embimg') {
        // Картинку ставит только тот, кто создал клан, и только если покупал
        // эмблему. Иначе любой участник мог бы поменять герб всему клану.
        // Можно, если эмблема куплена, если открыт полный доступ (личный или
        // всему клубу) или если это владелец платформы.
        const own = JSON.parse(row.owned || '{}');
        const boss = isOwner(env, user);
        const can = !!own.emb || boss || await giftOn(env, user.id) || !!(await openAllUntil(env));
        if (!can) return json({ error: 'locked' }, 403, cors);
        // Герб меняет создатель клана. Владелец платформы — у любого клана:
        // ему нужно убирать оскорбительные картинки.
        const cid = boss && Number(body.clan) ? Number(body.clan) : (row.clan || 0);
        const c = await env.DB.prepare('SELECT id,owner FROM clans WHERE id=?').bind(cid).first();
        if (!c || (c.owner !== user.id && !boss)) return json({ error: 'notowner' }, 403, cors);
        if (body.img === '') await env.DB.prepare('UPDATE clans SET embimg=NULL WHERE id=?').bind(c.id).run();
        else {
          const img = typeof body.img === 'string' && body.img.startsWith('data:image/')
            && body.img.length < 90000 ? body.img : null;
          if (!img) return json({ error: 'img' }, 400, cors);
          await env.DB.prepare('UPDATE clans SET embimg=? WHERE id=?').bind(img, c.id).run();
        }
      }
      const me = await env.DB.prepare('SELECT clan FROM players WHERE id=?').bind(user.id).first();
      const list = await env.DB.prepare(
        `SELECT c.id,c.name,c.emb,c.cap,c.tr,c.owner,LENGTH(COALESCE(c.embimg,'')) ei,
                COUNT(p.id) n,COALESCE(SUM(p.pts),0) pts
         FROM clans c LEFT JOIN players p ON p.clan=c.id GROUP BY c.id ORDER BY pts DESC LIMIT 30`).all();
      let members = [], info = null;
      if (me && me.clan) {
        const r = await env.DB.prepare(`SELECT p.id,p.nick,p.av,p.pts,p.avimg,p.avurl,p.seen,COALESCE(f.hidden,0) hid
          FROM players p LEFT JOIN prefs f ON f.uid=p.id WHERE p.clan=? ORDER BY p.pts DESC LIMIT 200`).bind(me.clan).all();
        const T = NOW();
        members = (r.results || []).map((x) => ({ id: x.id, nick: x.nick, av: x.av, pts: x.pts, avu: avLink(url.origin, x),
          on: !x.hid && x.seen > T - 300000 }));
        const c = await env.DB.prepare('SELECT owner, descr, pin FROM clans WHERE id=?').bind(me.clan).first();
        const boss = !!c && (c.owner === user.id || isOwner(env, user));
        let pin = null;
        if (c && c.pin) {
          const m = await env.DB.prepare(`SELECT m.id, m.text, COALESCE(p.nick,m.nick) nick FROM msgs m LEFT JOIN players p ON p.id=m.uid
            WHERE m.id=? AND m.room=?`).bind(c.pin, 'clan:' + me.clan).first();
          if (m) pin = { id: m.id, text: m.text, nick: m.nick || '' };
        }
        const pr = await env.DB.prepare('SELECT * FROM cpolls WHERE clan=? AND (closed=0 OR at>?) ORDER BY id DESC LIMIT 3').bind(me.clan, T - 3 * 86400000).all();
        const polls = [];
        for (const p of (pr.results || [])) {
          const v = await env.DB.prepare('SELECT opt, COUNT(*) n FROM cvotes WHERE poll=? GROUP BY opt').bind(p.id).all();
          const my = await env.DB.prepare('SELECT opt FROM cvotes WHERE poll=? AND uid=?').bind(p.id, user.id).first();
          const cnt = {}; (v.results || []).forEach((x) => { cnt[x.opt] = x.n; });
          const opts = JSON.parse(p.opts).map((tx, i) => ({ t: tx, n: cnt[i] || 0 }));
          polls.push({ id: p.id, q: p.q, opts, my: my ? my.opt : -1, total: opts.reduce((a, x) => a + x.n, 0), closed: !!p.closed });
        }
        let bans = [];
        if (boss) {
          const b = await env.DB.prepare('SELECT b.uid, b.note, p.nick FROM cbans b LEFT JOIN players p ON p.id=b.uid WHERE b.clan=? ORDER BY b.at DESC LIMIT 50').bind(me.clan).all();
          bans = (b.results || []).map((x) => ({ id: x.uid, nick: x.nick || '', note: x.note || '' }));
        }
        info = { descr: (c && c.descr) || '', pin, boss, polls, bans, online: members.filter((m) => m.on).length, owner: c ? c.owner : 0 };
      }
      const clans = (list.results || []).map((c) => Object.assign({}, c,
        { embu: c.ei ? `${url.origin}/cemb?id=${c.id}&v=${c.ei}` : '' }));
      return json({ clan: me ? me.clan : 0, clans, members, info }, 200, cors);
    }

    // 7b. Калькулятор средней цены: записи покупок игрока
    if (body && url.pathname === '/pf') {
      await getPlayer(env, user);
      if (body.add) {
        const sym = clean(body.add.sym, 12).toUpperCase();
        const usd = Number(body.add.usd), price = Number(body.add.price);
        if (!sym || !(usd > 0) || !(price > 0)) return json({ error: 'bad' }, 400, cors);
        // Валюта, в которой человек реально платил, и курс на момент записи.
        // Курс храним, чтобы задним числом не пересчитывать старую покупку по сегодняшнему.
        const cur = clean(body.add.cur, 4).toLowerCase() || 'usd';
        const amt = Number(body.add.amt) > 0 ? Number(body.add.amt) : usd;
        const rate = Number(body.add.rate) > 0 ? Number(body.add.rate) : 1;
        const k = body.add.k === 's' ? 's' : 'b'; // покупка или продажа
        const m = ['sp', 'ex', 'bg'].includes(body.add.m) ? body.add.m : 'sp'; // раздел учёта
        const note = clean(body.add.note, 24);
        const n = await env.DB.prepare('SELECT COUNT(*) n FROM pf WHERE uid=?').bind(user.id).first();
        if (n && n.n >= 300) return json({ error: 'limit' }, 409, cors);
        await env.DB.prepare('INSERT INTO pf(uid,sym,usd,price,at,cur,amt,rate,k,m,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .bind(user.id, sym, usd, price, NOW(), cur, amt, rate, k, m, note).run();
        // За запись в SHR рейтинг даём, но за её размер — нет: сумму человек
        // вписывает сам, и миллион в поле не делает его лучшим в клубе.
        await addRep(env, user.id, 1);
        // В ленту кладём только монету и раздел. Сумму — нет: это его деньги.
        await logEvent(env, user.id, 'pf', m + ' ' + sym);
      } else if (body.edit) {
        // Правка своей записи. Дату не трогаем: покупка была тогда, когда была.
        const e = body.edit;
        const id = Number(e.id) || 0;
        const usd = Number(e.usd), price = Number(e.price);
        if (id && usd > 0 && price > 0) {
          const cur = clean(e.cur, 4).toLowerCase() || 'usd';
          const amt = Number(e.amt) > 0 ? Number(e.amt) : usd;
          const rate = Number(e.rate) > 0 ? Number(e.rate) : 1;
          const k = e.k === 's' ? 's' : 'b';
          await env.DB.prepare('UPDATE pf SET usd=?,price=?,cur=?,amt=?,rate=?,k=? WHERE id=? AND uid=?')
            .bind(usd, price, cur, amt, rate, k, id, user.id).run();
        }
      } else if (body.del) {
        await env.DB.prepare('DELETE FROM pf WHERE id=? AND uid=?').bind(Number(body.del) || 0, user.id).run();
      }
      const r = await env.DB.prepare('SELECT id,sym,usd,price,at,cur,amt,rate,k,m,note FROM pf WHERE uid=? ORDER BY id').bind(user.id).all();
      return json({ list: r.results || [] }, 200, cors);
    }

    // 7c. Сводка для владельца бота
    if (body && url.pathname === '/stats') {
      if (!isOwner(env, user)) return json({ error: 'forbidden' }, 403, cors);
      const p = await env.DB.prepare('SELECT COUNT(*) n, SUM(CASE WHEN seen>? THEN 1 ELSE 0 END) live, SUM(CASE WHEN tier_until>? THEN 1 ELSE 0 END) subs FROM players')
        .bind(NOW() - 86400000, NOW()).first();
      const f = await env.DB.prepare('SELECT COUNT(DISTINCT uid) users, COUNT(*) rows, COALESCE(SUM(usd),0) usd FROM pf').first();
      const top = await env.DB.prepare('SELECT sym, COUNT(*) n, COALESCE(SUM(usd),0) usd FROM pf GROUP BY sym ORDER BY n DESC LIMIT 10').all();
      const pay = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(stars),0) stars FROM pays').first();
      // Кто что купил: по человеку и последние оплаты по одной
      const byUser = await env.DB.prepare(
        `SELECT y.uid, p.nick, p.av, COUNT(*) n, COALESCE(SUM(y.stars),0) stars, MAX(y.at) last
           FROM pays y LEFT JOIN players p ON p.id = y.uid
          GROUP BY y.uid ORDER BY stars DESC LIMIT 30`).all();
      const last = await env.DB.prepare(
        `SELECT y.uid, p.nick, y.product, y.arg, y.stars, y.at
           FROM pays y LEFT JOIN players p ON p.id = y.uid
          ORDER BY y.at DESC LIMIT 30`).all();
      // Лента последних событий. Сумм из чужих записей SHR здесь нет и не будет.
      const ev = await env.DB.prepare(
        `SELECT e.kind, e.note, e.at, e.uid, p.nick FROM events e LEFT JOIN players p ON p.id = e.uid
          ORDER BY e.id DESC LIMIT 60`).all();
      // Настоящий баланс звёзд у бота, если Telegram его отдаёт
      let balance = null;
      try {
        const b = await tg(env, 'getMyStarBalance', {});
        if (b && b.ok && b.result) balance = b.result.amount != null ? b.result.amount : b.result;
      } catch (e) {}
      const yNow = new Date().getUTCFullYear();
      const ag = await env.DB.prepare(
        `SELECT CASE WHEN ?-byear < 25 THEN '18–24' WHEN ?-byear < 35 THEN '25–34'
                     WHEN ?-byear < 45 THEN '35–44' WHEN ?-byear < 55 THEN '45–54' ELSE '55+' END g,
                COUNT(*) n FROM players WHERE COALESCE(byear,0) > 0 GROUP BY g ORDER BY g`)
        .bind(yNow, yNow, yNow, yNow).all();
      const msgs = await env.DB.prepare('SELECT COUNT(*) n FROM msgs').first();
      const clans = await env.DB.prepare('SELECT COUNT(*) n FROM clans').first();
      return json({ players: p.n, active: p.live, subs: p.subs, pfUsers: f.users, pfRows: f.rows, pfUsd: f.usd,
        coins: top.results || [], pays: pay.n, stars: pay.stars, msgs: msgs.n, clans: clans.n,
        buyers: byUser.results || [], lastPays: last.results || [],
        events: ev.results || [], balance, ages: ag.results || [],
        titles: Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [k, v.title])) }, 200, cors);
    }

    // 7d. Режим владельца: платформа открыта всегда, плюс переключатель «как игрок»
    if (body && url.pathname === '/owner') {
      if (!isOwner(env, user)) return json({ error: 'forbidden' }, 403, cors);
      await getPlayer(env, user);
      const act = clean(body.act, 12), id = user.id;
      if (act === 'asplayer') {
        await env.DB.prepare('INSERT INTO flags(uid,as_player) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET as_player=?')
          .bind(id, body.on ? 1 : 0, body.on ? 1 : 0).run();
      } else if (act === 'clearpf') {
        await env.DB.prepare('DELETE FROM pf WHERE uid=?').bind(id).run();
      } else if (act === 'sale') {
        // Скидка на всё сразу: процент и срок. 0 — выключить.
        const pct = Math.max(0, Math.min(80, Number(body.pct) | 0));
        const days = Math.max(1, Math.min(60, Number(body.days) || 7));
        const v = pct ? JSON.stringify({ pct, until: NOW() + days * 86400000 }) : JSON.stringify({ pct: 0, until: 0 });
        await env.DB.prepare("INSERT INTO settings(k,v) VALUES('sale',?) ON CONFLICT(k) DO UPDATE SET v=?")
          .bind(v, v).run();
        return json({ ok: true, sale: await getSale(env) }, 200, cors);
      } else if (act === 'announce') {
        const text = clean(body.text, 400);
        if (!text) return json({ error: 'text' }, 400, cors);
        await env.DB.prepare('INSERT INTO ann(text,at,sent) VALUES(?,?,0)').bind(text, NOW()).run();
        return json({ ok: true, ann: await lastAnn(env) }, 200, cors);
      } else if (act === 'dm') {
        // Личное письмо игроку от владельца. Подписываем, от кого оно: человек
        // должен понимать, что это живой владелец клуба, а не автоответчик.
        const uid = Number(body.uid) || 0;
        const text = clean(body.text, 600);
        if (!uid || !text) return json({ error: 'bad' }, 400, cors);
        // Сначала кладём в базу: даже если человек закрыл личку боту, письмо
        // дождётся его в приложении.
        await env.DB.prepare('INSERT INTO dms(uid,dir,text,at,seen) VALUES(?,?,?,?,0)')
          .bind(uid, 'in', text, NOW()).run();
        await logEvent(env, uid, 'dm', text.slice(0, 40));
        const r = await tg(env, 'sendMessage', { chat_id: uid,
          text: `✉️ Сообщение от владельца SHRhub\n\n${text}\n\n— ответь прямо здесь или в приложении, я прочитаю.` });
        if (r && r.ok === false) return json({ ok: true, telegram: 'blocked' }, 200, cors);
        return json({ ok: true }, 200, cors);
      } else if (act === 'announce_all') {
        // Письмо всем сразу. Только тем, кто разрешил писать себе: остальным
        // рассылка без спроса — прямой путь в блокировку бота.
        const text = clean(body.text, 600);
        if (!text) return json({ error: 'text' }, 400, cors);
        const r = await env.DB.prepare('SELECT uid FROM notif WHERE on_=1').all();
        const list = (r.results || []).map((x) => x.uid).filter((x) => x !== id);
        let sent = 0;
        for (const uid of list) {
          try {
            const res = await tg(env, 'sendMessage', { chat_id: uid, text: `📣 SHRhub\n\n${text}` });
            if (!res || res.ok !== false) sent++;
          } catch (e) {}
        }
        return json({ ok: true, sent, total: list.length }, 200, cors);
      } else if (act === 'chatpay') {
        const v = body.on ? '1' : '0';
        await env.DB.prepare("INSERT INTO settings(k,v) VALUES('chatpay',?) ON CONFLICT(k) DO UPDATE SET v=?")
          .bind(v, v).run();
        return json({ ok: true, chatpay: body.on ? 1 : 0 }, 200, cors);
      } else if (act === 'chatopen') {
        // Владелец может открыть голос бесплатно: другу, активному игроку, тому,
        // у кого просто нет чем платить.
        const uid = Number(body.uid) || 0;
        if (!uid) return json({ error: 'uid' }, 400, cors);
        await env.DB.prepare('UPDATE players SET chat_ok=? WHERE id=?').bind(body.on ? 1 : 0, uid).run();
        if (body.on) { try { await tg(env, 'sendMessage', { chat_id: uid, text: 'Тебе открыли голос в чатах SHRhub — бесплатно. Пиши.' }); } catch (e) {} }
        return json({ ok: true }, 200, cors);
      } else if (act === 'ban') {
        // Блокировка закрывает чат, новости и клан, но оставляет SHR и поддержку:
        // его записи не наше имущество, а без поддержки он не оспорит решение.
        const uid = Number(body.uid) || 0;
        if (!uid || uid === id) return json({ error: 'uid' }, 400, cors);
        const on = body.on ? 1 : 0;
        const note = clean(body.note, 120);
        await env.DB.prepare('UPDATE players SET banned=?, ban_note=? WHERE id=?').bind(on, note, uid).run();
        await logEvent(env, uid, on ? 'ban' : 'unban', note);
        try {
          await tg(env, 'sendMessage', { chat_id: uid, text: on
            ? `Тебе закрыли доступ к чатам и клану SHRhub.${note ? '\nПричина: ' + note : ''}\n\nКалькулятор SHR и твои записи остались на месте. Если считаешь, что это ошибка — ответь на это сообщение, я прочитаю.`
            : 'Доступ к чатам и клану SHRhub вернули. Добро пожаловать обратно.' });
        } catch (e) {}
        return json({ ok: true, uid, banned: on }, 200, cors);
      } else if (act === 'sections') {
        // Какие разделы выключены для всех. Владелец видит их всегда —
        // иначе он мог бы запереть сам себя снаружи собственного клуба.
        if (Array.isArray(body.off)) {
          const clean2 = body.off.filter((x) => typeof x === 'string' && x.length < 20).slice(0, 40);
          await env.DB.prepare(
            "INSERT INTO settings(k,v) VALUES('sections',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
            .bind(JSON.stringify(clean2)).run();
        }
        const r = await env.DB.prepare("SELECT v FROM settings WHERE k='sections'").first();
        let off = [];
        try { off = r && r.v ? JSON.parse(r.v) : []; } catch (e) {}
        return json({ ok: true, off: Array.isArray(off) ? off : [] }, 200, cors);
      } else if (act === 'tickets') {
        const r = await env.DB.prepare(
          `SELECT t.id, t.uid, t.text, t.at, t.done, p.nick, p.av, COALESCE(p.banned,0) banned
             FROM tickets t LEFT JOIN players p ON p.id = t.uid
            ORDER BY t.done ASC, t.id DESC LIMIT 50`).all();
        return json({ ok: true, tickets: r.results || [] }, 200, cors);
      } else if (act === 'ticket_done') {
        await env.DB.prepare('UPDATE tickets SET done=1 WHERE id=?').bind(Number(body.tid) || 0).run();
        return json({ ok: true }, 200, cors);
      } else if (act === 'players') {
        // Список игроков для выдачи доступа: кто давно в игре, кто платил, кому уже открыто
        const q = clean(body.q, 32);
        const like = '%' + q.toLowerCase() + '%';
        const r = await env.DB.prepare(
          `SELECT p.id, p.nick, p.av, p.pts, p.best, p.total, p.seen, p.tier, p.tier_until,
                  COALESCE(p.banned,0) banned, p.ban_note, COALESCE(p.chat_ok,0) chat_ok,
                  g.until gift,
                  (SELECT COALESCE(SUM(stars),0) FROM pays WHERE uid=p.id) stars
             FROM players p LEFT JOIN gifts g ON g.uid = p.id
            WHERE p.id <> ? AND (? = '' OR LOWER(COALESCE(p.nick,'')) LIKE ? OR CAST(p.id AS TEXT) LIKE ?)
            ORDER BY (g.until IS NOT NULL AND g.until <> 0) DESC, p.seen DESC
            LIMIT 60`).bind(id, q, like, like).all();
        const gn = await env.DB.prepare('SELECT COUNT(*) n FROM gifts').first();
        return json({ ok: true, players: r.results || [], now: NOW(),
          openall: await openAllUntil(env), gifts: (gn && gn.n) | 0 }, 200, cors);
      } else if (act === 'openall') {
        // Открыть или закрыть полный доступ сразу всем. days: 0 — выключить,
        // -1 — бессрочно, иначе на столько дней.
        const days = Number(body.days);
        const v = String(days === 0 ? 0 : days < 0 ? -1 : NOW() + Math.min(Math.max(days, 1), 3650) * 86400000);
        await env.DB.prepare("INSERT INTO settings(k,v) VALUES('openall',?) ON CONFLICT(k) DO UPDATE SET v=?")
          .bind(v, v).run();
        return json({ ok: true, openall: await openAllUntil(env) }, 200, cors);
      } else if (act === 'renum') {
        const k = await renumber(env);
        return json({ ok: true, renumbered: k }, 200, cors);
      } else if (act === 'giftsoff') {
        // Снять все личные доступы разом. Общий переключатель это не трогает.
        const c = await env.DB.prepare('SELECT COUNT(*) n FROM gifts').first();
        await env.DB.prepare('DELETE FROM gifts').run();
        return json({ ok: true, cleared: (c && c.n) | 0 }, 200, cors);
      } else if (act === 'gift') {
        const uid = Number(body.uid) || 0;
        if (!uid || uid === id) return json({ error: 'uid' }, 400, cors);
        // days: 0 — забрать, -1 — бессрочно, иначе на столько дней
        const days = Number(body.days);
        const until = days === 0 ? 0 : days < 0 ? -1 : NOW() + Math.min(days, 3650) * 86400000;
        if (!until) await env.DB.prepare('DELETE FROM gifts WHERE uid=?').bind(uid).run();
        else await env.DB.prepare(
          `INSERT INTO gifts(uid,until,note,by,at) VALUES(?,?,?,?,?)
           ON CONFLICT(uid) DO UPDATE SET until=?, note=?, by=?, at=?`)
          .bind(uid, until, clean(body.note, 64), id, NOW(), until, clean(body.note, 64), id, NOW()).run();
        // Сообщить человеку: иначе он просто не заметит, что ему открыли
        try {
          await tg(env, 'sendMessage', { chat_id: uid, text: until
            ? 'Тебе открыли полный доступ в SHRhub: все функции без подписки. Открой приложение заново, чтобы он включился.'
            : 'Полный доступ в SHRhub завершён. Твой прогресс и записи SHR остались на месте.' });
        } catch (e) {}
        return json({ ok: true, uid, until }, 200, cors);
      } else if (act !== 'read') return json({ error: 'act' }, 400, cors);
      const row = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
      const ap = await asPlayer(env, id);
      return json({ ok: true, asPlayer: ap, paid: paid(row, !ap), sale: await getSale(env),
        ann: await lastAnn(env), chatpay: (await chatPaid(env)) ? 1 : 0 }, 200, cors);
    }

    // 8. Общий рейтинг
    if (body && url.pathname === '/top') {
      const r = await env.DB.prepare(
        'SELECT id,nick,av,pts,best,COALESCE(rep,0) rep FROM players ORDER BY rep DESC, pts DESC LIMIT 30').all();
      // Оплаченное место идёт отдельным полем, а не подменяет собой первую строчку:
      // в таблице оно рисуется над рейтингом и подписано как оплаченное.
      const sp = await spotOf(env, 'player');
      let promo = null;
      if (sp) {
        const p = await env.DB.prepare('SELECT id,nick,av,pts,best,COALESCE(rep,0) rep FROM players WHERE id=?').bind(sp.id).first();
        if (p) promo = Object.assign({ until: sp.until }, p);
      }
      const csp = await spotOf(env, 'clan');
      let cpromo = null;
      if (csp) {
        const c = await env.DB.prepare('SELECT id,name,emb,tr FROM clans WHERE id=?').bind(csp.id).first();
        if (c) cpromo = Object.assign({ until: csp.until }, c);
      }
      const spotFree = { player: !sp, clan: !csp,
        playerUntil: sp ? sp.until : 0, clanUntil: csp ? csp.until : 0 };
      return json({ top: r.results || [], promo, cpromo, spot: spotFree }, 200, cors);
    }

    // 9. Сообщения от Telegram
    if (req.method === 'POST' && url.pathname === '/webhook') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const u = await req.json();
      if (u.pre_checkout_query) {
        const [, product] = String(u.pre_checkout_query.invoice_payload).split(':');
        await tg(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: u.pre_checkout_query.id, ok: !!PRODUCTS[product], error_message: 'Товар не найден' });
      } else if (u.message && u.message.successful_payment) {
        const sp = u.message.successful_payment;
        const parts = String(sp.invoice_payload).split(':');
        const [uid, product, arg] = parts;
        if (env.PAYMENTS) await env.PAYMENTS.put(`pay:${sp.telegram_payment_charge_id}`, JSON.stringify({ user: u.message.from.id, payload: sp.invoice_payload, stars: sp.total_amount, at: NOW() }));
        if (product === 'gift') {
          await sendPresent(env, u.message, sp, parts);
        } else {
          if (await ensure(env)) await grant(env, Number(uid) || u.message.from.id, product, arg || '', sp);
          await tg(env, 'sendMessage', { chat_id: u.message.chat.id, text: '⭐ Оплата получена. Спасибо! Покупка уже открыта в SHRhub.' });
        }
      } else if (u.callback_query) {
        // Кнопка под напоминанием: выключить, не открывая игру
        const cq = u.callback_query, uid = cq.from.id;
        let note = 'Готово';
        if (cq.data === 'nooff' && await ensure(env)) {
          await env.DB.prepare('INSERT INTO notif(uid,on_) VALUES(?,0) ON CONFLICT(uid) DO UPDATE SET on_=0').bind(uid).run();
          note = 'Больше не напоминаю. Включить обратно можно в игре, в Кабинете.';
        } else if (String(cq.data || '').startsWith('pmto:') && await ensure(env)) {
          // Человек выбрал, кому уходит его сообщение
          const to = Number(String(cq.data).slice(5)) || 0;
          const d = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(`pmdraft:${uid}`).first();
          const txt = d && d.v ? String(d.v) : '';
          if (to && txt) {
            const me = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(uid).first();
            await pmPut(env, uid, to, txt, (me && me.nick) || 'Участник клуба', url.origin);
            await env.DB.prepare('DELETE FROM settings WHERE k=?').bind(`pmdraft:${uid}`).run();
            const p = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(to).first();
            note = `Отправил: ${(p && p.nick) || 'участнику'}`;
          } else note = 'Сообщение потерялось, напиши ещё раз';
        }
        await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: note, show_alert: false });
        if (cq.message) await tg(env, 'editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
      } else if (u.message && u.message.contact) {
        // Человек поделился своим номером через Telegram. Чужой контакт,
        // пересланный в бот, игнорируем: это не его данные.
        const c = u.message.contact, from = u.message.from || {};
        if (c.user_id && c.user_id === from.id && await ensure(env)) {
          await getPlayer(env, from);
          await env.DB.prepare('UPDATE players SET phone=? WHERE id=?')
            .bind(clean(c.phone_number, 24), from.id).run();
          await tg(env, 'sendMessage', { chat_id: u.message.chat.id,
            text: 'Номер сохранён. Кто его видит, решаешь ты — в профиле, в разделе «Моя карточка». Убрать номер можно там же.' });
        } else {
          await tg(env, 'sendMessage', { chat_id: u.message.chat.id,
            text: 'Я сохраняю только твой собственный номер — тот, которым делится сам Telegram. Чужие контакты клуб не собирает.' });
        }
      } else if (u.message && typeof u.message.text === 'string' && u.message.text.startsWith('/id')) {
        // Свой ID всегда безопаснее спросить у своего же бота, чем у чужого
        await tg(env, 'sendMessage', { chat_id: u.message.chat.id, text: `Твой Telegram ID: ${u.message.from.id}` });
      } else if (u.message && (u.message.video || u.message.video_note)) {
        // Ролик приходит в бот, а мы запоминаем только его file_id: сам файл
        // остаётся у Telegram, и пересылать его можно без ограничения по размеру.
        const m = u.message, v = m.video || m.video_note, from = m.from || {};
        if (await ensure(env)) {
          const row = await env.DB.prepare('SELECT COALESCE(banned,0) b FROM players WHERE id=?').bind(from.id).first();
          if (row && row.b) {
            await tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'Тебе закрыт доступ к публикациям в SHRhub.' });
          } else {
            const title = clean(m.caption, 80);
            const thumb = (v.thumbnail && v.thumbnail.file_id) || (v.thumb && v.thumb.file_id) || '';
            await env.DB.prepare(
              `INSERT INTO vids(uid,title,file_id,thumb,dur,size,at) VALUES(?,?,?,?,?,?,?)`)
              .bind(from.id, title || 'Без названия', v.file_id, thumb, v.duration || 0, v.file_size || 0, NOW()).run();
            await logEvent(env, from.id, 'vid', title.slice(0, 40));
            await addRep(env, from.id, 2);
            await tg(env, 'sendMessage', { chat_id: m.chat.id, text:
              'Ролик добавлен в ленту SHRhub.' + (title ? '' : '\n\nПодпись пустая: отправь видео с подписью, и она станет заголовком.') +
              '\n\nПравила простые: без наркотиков, оружия, насилия и чужого контента. Нарушишь — ролик снимут, а доступ закроют.' });
            await tellOwner(env, `🎬 Новый ролик: ${title || 'без названия'}\nОт: ${clean(from.first_name, 32)} (id ${from.id})`);
          }
        }
      } else if (u.message && typeof u.message.text === 'string' && u.message.text.trim() && !u.message.text.startsWith('/')) {
        const m = u.message, from = m.from || {};
        const text = clean(m.text, 600);
        const rep = m.reply_to_message && m.reply_to_message.message_id;
        let sent = false;
        if (await ensure(env)) {
          const me = await env.DB.prepare('SELECT nick, COALESCE(banned,0) b FROM players WHERE id=?')
            .bind(from.id).first();
          if (me && me.b) {
            await tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'Доступ к клубу закрыт.' });
            sent = true;
          } else {
            // Ответ на письмо бота — это ответ человеку, а не в поддержку
            let to = 0;
            if (rep) {
              const link = await env.DB.prepare('SELECT peer FROM pmlink WHERE uid=? AND mid=?')
                .bind(from.id, rep).first();
              if (link) to = link.peer;
            }
            if (!to) {
              // Без ответа на письмо: если переписка за сутки ровно одна,
              // понятно, кому человек пишет. Если их несколько — спросим.
              const r = await env.DB.prepare(
                `SELECT CASE WHEN uid=? THEN peer ELSE uid END who, MAX(at) at
                   FROM pm WHERE (uid=? OR peer=?) AND at > ?
                  GROUP BY who ORDER BY at DESC LIMIT 4`)
                .bind(from.id, from.id, from.id, NOW() - 86400000).all();
              const list = r.results || [];
              if (list.length === 1) to = list[0].who;
              else if (list.length > 1) {
                const rows = [];
                for (const x of list) {
                  const p = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(x.who).first();
                  rows.push([{ text: (p && p.nick) || `id ${x.who}`, callback_data: `pmto:${x.who}` }]);
                }
                await env.DB.prepare(
                  "INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
                  .bind(`pmdraft:${from.id}`, text).run();
                await tg(env, 'sendMessage', { chat_id: m.chat.id,
                  text: 'Кому отправить? Нажми на имя, а в следующий раз просто ответь на его сообщение.',
                  reply_markup: { inline_keyboard: rows } });
                sent = true;
              }
            }
            if (to && !sent) {
              await pmPut(env, from.id, to, text, (me && me.nick) || clean(from.first_name, 32), url.origin);
              const p = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(to).first();
              await tg(env, 'sendMessage', { chat_id: m.chat.id,
                text: `Отправил: ${(p && p.nick) || 'участнику'}.` });
              sent = true;
            }
          }
        }
        // Переписки не нашлось — значит, человек пишет нам. Это поддержка.
        if (!sent && Number(env.OWNER_ID || env.SUPPORT_CHAT_ID || 0) !== from.id) {
          await tellOwner(env, `💬 ${clean(from.first_name, 32)}` +
            (from.username ? ` (@${from.username})` : '') + ` · id ${from.id}\n\n${String(m.text).slice(0, 900)}`);
          await tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'Передал. Отвечу, как только прочитаю.' });
        }
      } else if (u.message && typeof u.message.text === 'string' && u.message.text.startsWith('/paysupport')) {
        // Telegram требует, чтобы каждый бот, который берёт звёзды, отвечал на
        // /paysupport. Человеку объясняем, что делать, владельцу — сообщаем.
        const m = u.message;
        await tg(env, 'sendMessage', { chat_id: m.chat.id, text:
          'Вопрос по оплате в SHRhub.\n\n' +
          'Напиши одним сообщением: что купил, когда и сколько звёзд списалось. ' +
          'Владелец клуба проверит платёж. Если покупка не выдалась, звёзды вернём полностью.\n\n' +
          'Ответ придёт в приложении, в чате поддержки. Мы никогда не просим данные карты, коды из SMS или перевод денег.' });
        try {
          await tellOwner(env, `💳 /paysupport от ${clean(m.from && m.from.first_name, 32) || 'без имени'} (id ${m.from && m.from.id})`);
        } catch (e) {}
      } else if (u.message && typeof u.message.text === 'string' && u.message.text.startsWith('/start')) {
        await tg(env, 'sendMessage', { chat_id: u.message.chat.id, text: 'SHRhub — закрытый клуб прогнозов. Это игра, а не биржа: ставок и денежных призов нет. 18+', reply_markup: { inline_keyboard: [[{ text: 'Открыть SHRhub', web_app: { url: appUrl } }]] } });
      }
      return new Response('ok');
    }

    // 10. Одноразовая настройка: открыть /setup?key=WEBHOOK_SECRET в браузере
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const db = await ensure(env);
      const a = await tg(env, 'setWebhook', { url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'pre_checkout_query', 'callback_query'] });
      const b = await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'SHRhub', web_app: { url: appUrl } } });
      return json({ webhook: a, menu_button: b, database: db ? 'ok' : 'не привязана' });
    }
    // Картинка подарка. Отдаём только те file_id, что лежат в нашем каталоге,
    // чтобы по этой ссылке нельзя было вытянуть произвольный файл бота.
    if (url.pathname === '/gfile') {
      if (!await ensure(env)) return new Response('no db', { status: 503 });
      const id = url.searchParams.get('id') || '';
      const list = await giftList(env);
      const g = list.find((x) => x.id === id);
      if (!g || !g.th) return new Response('not found', { status: 404 });
      try {
        const f = await tg(env, 'getFile', { file_id: g.th });
        const path = f && f.ok && f.result && f.result.file_path;
        if (!path) return new Response('not found', { status: 404 });
        const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
        if (!r.ok) return new Response('not found', { status: 404 });
        return new Response(r.body, { headers: {
          'content-type': r.headers.get('content-type') || 'image/webp',
          'cache-control': 'public, max-age=86400',
          'access-control-allow-origin': '*',
        } });
      } catch (e) { return new Response('error', { status: 502 }); }
    }

    // Аватар участника. Отдельной ссылкой, чтобы списки оставались лёгкими,
    // а браузер закэшировал картинку и не просил её снова на каждый чат.
    // Эмблема клана картинкой. Отдаём байтами, как аватар: списки кланов
    // не должны таскать картинку в каждом ответе.
    if (url.pathname === '/cemb') {
      if (!await ensure(env)) return new Response('no db', { status: 503 });
      const cid = Number(url.searchParams.get('id')) || 0;
      if (!cid) return new Response('not found', { status: 404 });
      const c = await env.DB.prepare('SELECT embimg FROM clans WHERE id=?').bind(cid).first();
      const m = c && c.embimg && /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(c.embimg);
      if (!m) return new Response('not found', { status: 404 });
      const bin = atob(m[2]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { headers: { 'content-type': m[1],
        'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } });
    }
    if (url.pathname === '/av') {
      if (!await ensure(env)) return new Response('no db', { status: 503 });
      const uid = Number(url.searchParams.get('uid')) || 0;
      if (!uid) return new Response('not found', { status: 404 });
      const p = await env.DB.prepare('SELECT avimg, avurl FROM players WHERE id=?').bind(uid).first();
      if (!p) return new Response('not found', { status: 404 });
      const head = { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' };
      if (p.avimg) {
        const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(p.avimg);
        if (m) {
          const bin = atob(m[2]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new Response(bytes, { headers: Object.assign({ 'content-type': m[1] }, head) });
        }
      }
      if (p.avurl) {
        try {
          const r = await fetch(p.avurl);
          const ct = r.headers.get('content-type') || '';
          if (r.ok && ct.startsWith('image/')) return new Response(r.body, { headers: Object.assign({ 'content-type': ct }, head) });
        } catch (e) {}
      }
      // Ссылка на фото из Telegram часто не открывается с сервера — тогда
      // берём фото профиля через бота (если человек его не скрыл).
      // Ответ кладём в кэш Cloudflare на час, чтобы не дёргать Telegram.
      const ck = new Request(`https://av.cache/${uid}`);
      try { const hit = await caches.default.match(ck); if (hit) return hit; } catch (e) {}
      try {
        const ph = await tg(env, 'getUserProfilePhotos', { user_id: uid, limit: 1 });
        const sizes = ph && ph.ok && ph.result && ph.result.photos && ph.result.photos[0];
        if (sizes && sizes.length) {
          const pick = sizes.find((x) => x.width >= 160) || sizes[sizes.length - 1];
          const f = await tg(env, 'getFile', { file_id: pick.file_id });
          if (f && f.ok && f.result && f.result.file_path) {
            const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
            if (r.ok) {
              const out = new Response(await r.arrayBuffer(), { headers: Object.assign({ 'content-type': 'image/jpeg' }, head) });
              try { await caches.default.put(ck, out.clone()); } catch (e) {}
              return out;
            }
          }
        }
      } catch (e) {}
      const miss = new Response('not found', { status: 404, headers: head });
      try { await caches.default.put(ck, miss.clone()); } catch (e) {}
      return miss;
    }

    // Вложение из переписки. Ссылка подписана для конкретного зрителя, поэтому
    // подглядеть чужую переписку, подставив номер, нельзя.
    if (url.pathname === '/pmfile') {
      if (!await ensure(env)) return new Response('no db', { status: 503 });
      const id = Number(url.searchParams.get('id')) || 0;
      const uid = Number(url.searchParams.get('u')) || 0;
      const kind = url.searchParams.get('k') === 'thumb' ? 'thumb' : 'full';
      const sig = url.searchParams.get('s') || '';
      if (!id || !uid || sig !== await mediaSig(env.BOT_TOKEN, id, uid, kind)) {
        return new Response('forbidden', { status: 403 });
      }
      const m = await env.DB.prepare('SELECT uid, peer, kind, file_id, thumb, size FROM pm WHERE id=?').bind(id).first();
      if (!m || (m.uid !== uid && m.peer !== uid)) return new Response('not found', { status: 404 });
      const fid = kind === 'thumb' ? (m.thumb || m.file_id) : m.file_id;
      if (!fid) return new Response('not found', { status: 404 });
      if (isR2(fid) && env.MEDIA) {
        const fb = kind === 'full' && m.kind === 'video' ? 'video/mp4' : kind === 'full' && m.kind === 'voice' ? 'audio/mp4' : 'image/jpeg';
        return await r2Serve(env, req, fid, fb, 'private, max-age=86400');
      }
      // Больше 20 МБ Telegram боту не отдаёт — такой ролик смотрят у себя в чате
      if (kind === 'full' && m.kind === 'video' && !(m.size > 0 && m.size <= 19 * 1024 * 1024)) {
        return new Response('too large', { status: 413 });
      }
      try {
        const f = await tg(env, 'getFile', { file_id: fid });
        const path = f && f.ok && f.result && f.result.file_path;
        if (!path) return new Response('not found', { status: 404 });
        const fb = kind === 'full' && m.kind === 'video' ? 'video/mp4'
          : kind === 'full' && m.kind === 'voice' ? 'audio/ogg' : 'image/jpeg';
        return await tgServe(env, req, path, fb, 'private, max-age=86400');
      } catch (e) { return new Response('error', { status: 502 }); }
    }

    // Обложка и сам ролик. Ссылку у Telegram приходится просить заново: она живёт
    // около часа. Файл забираем сами и отдаём байтами: в ссылке Telegram лежит
    // токен бота, и перенаправлением мы бы отдали его прямо в браузер.
    if (url.pathname === '/vfile') {
      if (!await ensure(env)) return new Response('no db', { status: 503 });
      const id = Number(url.searchParams.get('id')) || 0;
      const kind = url.searchParams.get('kind') === 'video' ? 'video' : 'thumb';
      const v = await env.DB.prepare("SELECT thumb, file_id, size, COALESCE(kind,'reel') kind, media FROM vids WHERE id=? AND hidden=0").bind(id).first();
      if (!v) return new Response('not found', { status: 404 });
      // Скачать у Telegram можно только файл до 20 МБ. Крупный ролик бот
      // пересылает в чат по file_id, в приложении он не играет.
      const fid = kind === 'video' ? v.file_id : v.thumb;
      if (!fid) return new Response('not found', { status: 404 });
      if (isR2(fid) && env.MEDIA) {
        return await r2Serve(env, req, fid, kind === 'video' && v.kind !== 'photo' && v.media !== 'photo' ? 'video/mp4' : 'image/jpeg', 'public, max-age=86400');
      }
      if (kind === 'video' && v.size > 19 * 1024 * 1024) {
        return new Response('too large', { status: 413 });
      }
      try {
        const f = await tg(env, 'getFile', { file_id: fid });
        const path = f && f.ok && f.result && f.result.file_path;
        if (!path) return new Response('not found', { status: 404 });
        return await tgServe(env, req, path, kind === 'video' && v.kind !== 'photo' && v.media !== 'photo' ? 'video/mp4' : 'image/jpeg', 'public, max-age=86400');
      } catch (e) { return new Response('error', { status: 502 }); }
    }

    return new Response('SHRhub bot is running');
  },

  // Расписание: Cloudflare будит воркер раз в час, мы сами решаем, кому сейчас писать.
  // Час у каждого игрока свой — тот, что у него на телефоне, а не киевский.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
    ctx.waitUntil(sendBirthdays(env));
    ctx.waitUntil(pullFeed(env));
  },
};

// ---------- лента новостей ----------
// Берём обычные RSS изданий: ключей не нужно, лимитов нет, и если одно издание
// замолчит, остальные продолжат работать.
const FEEDS = [
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ['The Block', 'https://www.theblock.co/rss.xml'],
  ['Decrypt', 'https://decrypt.co/feed'],
];
const unxml = (x) => String(x || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

function parseFeed(xml) {
  const out = [];
  const blocks = String(xml).split(/<item[\s>]|<entry[\s>]/i).slice(1);
  for (const b of blocks.slice(0, 20)) {
    const t = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let l = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    let url = l ? unxml(l[1]) : '';
    if (!url) { const h = b.match(/<link[^>]*href="([^"]+)"/i); if (h) url = h[1]; }
    const d = b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || b.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
    const title = t ? unxml(t[1]) : '';
    if (!title || !/^https?:\/\//.test(url)) continue;
    const ts = d ? Date.parse(unxml(d[1])) : NaN;
    out.push({ title: title.slice(0, 200), url: url.slice(0, 400), at: isNaN(ts) ? NOW() : ts });
  }
  return out;
}

async function pullFeed(env) {
  if (!await ensure(env)) return;
  for (const [src, url] of FEEDS) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'SHRhub/1.0 (+telegram mini app)' } });
      if (!r.ok) continue;
      const items = parseFeed(await r.text());
      for (const it of items) {
        await env.DB.prepare('INSERT OR IGNORE INTO feed(title,url,src,at) VALUES(?,?,?,?)')
          .bind(it.title, it.url, src, it.at).run();
      }
    } catch (e) {}
  }
  // Старое никому не нужно и только занимает базу
  try { await env.DB.prepare('DELETE FROM feed WHERE at < ?').bind(NOW() - 14 * 86400000).run(); } catch (e) {}
}

// ---------- напоминания ----------
const DAY_KEY = (ms) => new Date(ms).toISOString().slice(0, 10);

// Цена биткоина для утреннего письма: если биржа молчит, пишем без неё
async function btcLine(env) {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
    if (!r.ok) return '';
    const j = await r.json();
    const p = Number(j.lastPrice), d = Number(j.priceChangePercent);
    if (!(p > 0)) return '';
    return `\nBTC $${p.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${d >= 0 ? '+' : ''}${d.toFixed(1)}% за сутки)`;
  } catch (e) { return ''; }
}

// Кто сегодня именинник. Шлём поздравление раз в день и только тем, кто
// не прятал дату: день рождения — это праздник, а не повод всех дёргать.
async function sendBirthdays(env) {
  if (!await ensure(env)) return;
  const d = new Date(NOW());
  const key = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const done = await env.DB.prepare("SELECT v FROM settings WHERE k='bday_done'").first();
  if (done && done.v === key) return;
  const r = await env.DB.prepare(
    `SELECT id, nick FROM players WHERE bday=? AND COALESCE(showbday,1)=1 LIMIT 40`).bind(key).all();
  const list = r.results || [];
  for (const p of list) {
    try {
      await tg(env, 'sendMessage', { chat_id: p.id,
        text: `🎂 С днём рождения!\n\nВесь клуб SHRhub тебя поздравляет.` });
    } catch (e) {}
  }
  if (list.length) {
    await tellOwner(env, `🎂 Сегодня день рождения: ${list.map((p) => p.nick || p.id).join(', ')}`);
  }
  await env.DB.prepare(
    "INSERT INTO settings(k,v) VALUES('bday_done',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(key).run();
}

async function sendReminders(env) {
  if (!await ensure(env)) return;
  const now = NOW();
  const rows = await env.DB.prepare(
    `SELECT n.uid, n.tz, n.mh, n.eh, n.lastm, n.laste, p.nick, p.streak, p.pts
       FROM notif n JOIN players p ON p.id = n.uid
      WHERE n.on_ = 1`).all();
  const list = rows.results || [];
  if (!list.length) return;

  const btc = await btcLine(env);
  // Новость от владельца уходит один раз, вместе с утренним письмом: отдельных
  // рассылок не делаем, человек соглашался на два письма в день, а не на три.
  const an = await env.DB.prepare('SELECT id,text FROM ann WHERE sent=0 ORDER BY id DESC LIMIT 1').first();
  let annSent = false;
  const kb = { inline_keyboard: [
    [{ text: 'Открыть SHRhub', web_app: { url: env.APP_URL } }],
    [{ text: 'Не напоминать', callback_data: 'nooff' }]] };

  for (const r of list) {
    const local = now + (r.tz | 0) * 60000;
    const hour = new Date(local).getUTCHours();
    const day = DAY_KEY(local);
    let text = null, col = null;

    if (hour === (r.mh | 0) && r.lastm !== day) {
      col = 'lastm';
      text = `Доброе утро${r.nick ? ', ' + r.nick : ''}.${btc}\n\n` +
        (r.streak > 0
          ? `Твоя серия: ${r.streak} подряд. Один прогноз — и она растёт дальше.`
          : 'Сделай прогноз на сегодня — серия начинается с первого попадания.');
      if (an) { text += `\n\n🆕 ${an.text}`; annSent = true; }
    } else if (hour === (r.eh | 0) && r.laste !== day) {
      col = 'laste';
      text = r.streak > 0
        ? `Вечер. Серия ${r.streak} ещё держится — закрой день прогнозом, чтобы не потерять её.`
        : 'Вечер. Загляни в SHRhub: посмотри, как сходили твои монеты за день, и обнови среднюю цену в SHR.';
    }
    if (!text) continue;

    // Если человек заблокировал бота, Telegram вернёт ошибку — просто выключаем ему напоминания
    try {
      const res = await tg(env, 'sendMessage', { chat_id: r.uid, text, reply_markup: kb });
      if (res && res.ok === false && /blocked|deactivated|chat not found/i.test(res.description || '')) {
        await env.DB.prepare('UPDATE notif SET on_=0 WHERE uid=?').bind(r.uid).run();
        continue;
      }
    } catch (e) { continue; }
    await env.DB.prepare(`UPDATE notif SET ${col}=? WHERE uid=?`).bind(day, r.uid).run();
  }
  if (an && annSent) await env.DB.prepare('UPDATE ann SET sent=1 WHERE id=?').bind(an.id).run();
}

// Настроение толпы по реальным прогнозам текущего часа
export async function counts(env, sym) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) n,
            SUM(CASE WHEN dir>0 THEN 1 ELSE 0 END) up,
            AVG(CASE WHEN dir>0 THEN k END) tu,
            AVG(CASE WHEN dir<0 THEN k END) td
     FROM preds WHERE sym=? AND hour=?`).bind(sym, HOUR()).first();
  const n = r && r.n ? r.n : 0;
  return { n, up: n ? Math.round((r.up / n) * 100) : 50, tu: r && r.tu != null ? r.tu : .4, td: r && r.td != null ? r.td : .4, real: true };
}

// Выдача купленного: только здесь, и только после подтверждения Telegram
export async function grant(env, uid, product, arg, sp) {
  try {
    const pr0 = PRODUCTS[product];
    if (pr0) {
      await logEvent(env, uid, 'pay', product + ' ' + pr0.stars + '⭐');
      const who = await env.DB.prepare('SELECT nick FROM players WHERE id=?').bind(uid).first();
      await tellOwner(env, `⭐ Оплата: ${pr0.title} — ${pr0.stars} звёзд\nОт: ${(who && who.nick) || uid}`);
    }
  } catch (e) {}
  const pr = PRODUCTS[product];
  if (!pr) return;
  const charge = sp && sp.telegram_payment_charge_id ? sp.telegram_payment_charge_id : `${uid}:${product}:${NOW()}`;
  const seen = await env.DB.prepare('SELECT charge FROM pays WHERE charge=?').bind(charge).first();
  if (seen) return; // та же оплата второй раз ничего не добавляет
  await env.DB.prepare('INSERT INTO pays(charge,uid,product,arg,stars,at) VALUES(?,?,?,?,?,?)')
    .bind(charge, uid, product, arg || '', sp ? sp.total_amount : pr.stars, NOW()).run();
  await getPlayer(env, { id: uid, first_name: '' });
  const row = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(uid).first();
  const until = NOW() + 31 * 86400000;
  if (pr.tier) {
    // Купил — проба закончилась, дальше это обычная оплаченная подписка
    await env.DB.prepare('UPDATE players SET tier=?,tier_until=?,trial=0 WHERE id=?').bind(pr.tier, until, uid).run();
  } else if (pr.coin) {
    const list = JSON.parse(row.extra || '[]');
    if (arg && !list.includes(arg)) list.push(arg);
    await env.DB.prepare('UPDATE players SET extra=? WHERE id=?').bind(JSON.stringify(list.slice(0, 50)), uid).run();
  } else if (pr.own) {
    const own = JSON.parse(row.owned || '{}');
    own[pr.own] = 1;
    await env.DB.prepare('UPDATE players SET owned=? WHERE id=?').bind(JSON.stringify(own), uid).run();
  } else if (pr.boost) {
    // arg — номер ролика. Если его нет или он чужой, звёзды не сгорают:
    // продление ляжет на самый свежий ролик этого человека.
    const vid = Number(arg) || 0;
    const row2 = vid
      ? await env.DB.prepare('SELECT id, boost_until FROM vids WHERE id=? AND uid=?').bind(vid, uid).first()
      : await env.DB.prepare('SELECT id, boost_until FROM vids WHERE uid=? ORDER BY id DESC LIMIT 1').bind(uid).first();
    if (row2) {
      const from = row2.boost_until > NOW() ? row2.boost_until : NOW();
      await env.DB.prepare('UPDATE vids SET boost_until=?, boost_stars=boost_stars+? WHERE id=?')
        .bind(from + 7 * 86400000, pr.stars, row2.id).run();
    }
  } else if (pr.chatOn) {
    await env.DB.prepare('UPDATE players SET chat_ok=1 WHERE id=?').bind(uid).run();
  } else if (pr.spot) {
    // Место на неделю. Если оно уже занято, новый срок начинается после старого,
    // чтобы два покупателя не стояли на одном месте и никто не платил впустую.
    const kind = pr.spot;
    const who = kind === 'clan' ? (Number(arg) || row.clan || 0) : uid;
    if (who) {
      const cur = await env.DB.prepare('SELECT until FROM spots WHERE kind=? AND until>? ORDER BY until DESC LIMIT 1')
        .bind(kind, NOW()).first();
      const from = cur && cur.until > NOW() ? cur.until : NOW();
      await env.DB.prepare(
        `INSERT INTO spots(kind,id,until,stars,at) VALUES(?,?,?,?,?)
         ON CONFLICT(kind,id) DO UPDATE SET until=?, stars=stars+?, at=?`)
        .bind(kind, who, from + 7 * 86400000, pr.stars, NOW(), from + 7 * 86400000, pr.stars, NOW()).run();
    }
  } else if (pr.seats) {
    // Места прибавляются к тем, что есть. Если клана ещё нет, покупка
    // не сгорает: места ждут и прибавятся к клану, когда он появится.
    if (row.clan) await env.DB.prepare('UPDATE clans SET cap=cap+? WHERE id=?').bind(pr.seats, row.clan).run();
    else await env.DB.prepare('UPDATE players SET capbuy=COALESCE(capbuy,0)+? WHERE id=?').bind(pr.seats, uid).run();
  } else if (pr.pass) {
    await env.DB.prepare('UPDATE players SET pass_until=? WHERE id=?').bind(NOW() + 7 * 86400000, uid).run();
  } else if (pr.save) {
    await env.DB.prepare('UPDATE players SET saves=saves+1 WHERE id=?').bind(uid).run();
  } else if (pr.codes) {
    await env.DB.prepare('UPDATE players SET codes=codes+3 WHERE id=?').bind(uid).run();
  } else if (pr.gm) {
    await env.DB.prepare('UPDATE players SET gm=gm+1 WHERE id=?').bind(uid).run();
  }
}
