import { VALID_MOODS } from "./moods.js";

const START_MESSAGE =
  "Available Commands:\n" +
  "• `/start` — display this command overview\n" +
  "• `/faces` — download reference grid for face ids (0–32)\n" +
  "• `/moods` — open official imood list on imood.com/moods\n" +
  "• `/buddies` — view current moods of all your buddies\n" +
  "• `/history` — view your recent 16 imood logs\n" +
  "• `/translation` — view translation of available moods\n\n" +
  "Update Format:\n" +
  "`<mood> <mood details> <#face id>`\n\n" +
  "Example:\n" +
  "`calm i can now easily develop my imood habit #5`";

const HISTORY_LIMIT = 16;
const MAX_MESSAGE_LENGTH = 4000; // stays under Telegram's 4096-char limit

// --- XML HELPERS (imood's my.cgi returns simple, non-nested XML) ---
const extractTag = (xml, tag) => {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return match ? match[1].trim() : "";
};

const extractBundle = (xml, type) => {
  const match = xml.match(
    new RegExp(`<bundle[^>]*type="${type}"[^>]*>([\\s\\S]*?)</bundle>`, "i"),
  );
  return match ? match[1] : null;
};

const extractBlocks = (xml, tag) =>
  xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi"));

// Formats one buddy/history entry as "date / headline / note"
const formatEntry = (date, headline, msg) =>
  `• ${date}\n• ${headline}\n\n• ${msg ? msg + "\n" : ""}\n\n---\n\n`;

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const email = process.env.IMOOD_EMAIL;
  const password = process.env.IMOOD_PASSWORD;
  const username = process.env.IMOOD_USERNAME;

  // --- HELPER: SEND TELEGRAM MESSAGE ---
  const sendMessage = async (id, text, extra = {}) => {
    const payload = { chat_id: id, text, parse_mode: "Markdown", ...extra };

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  };

  // --- HELPER: SEND TELEGRAM DOCUMENT ---
  const sendDocument = async (id, document, caption) => {
    await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: id,
        document,
        caption,
        parse_mode: "Markdown",
      }),
    });
  };

  // --- HELPER: FETCH MY imood DATA ---
  const getMyimoodData = async (bundles) => {
    try {
      const params = new URLSearchParams({ email, password, bundles });
      const response = await fetch(
        `https://xml.imood.org/my.cgi?${params.toString()}`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; imoodBot/1.0)" } },
      );
      return await response.text();
    } catch (err) {
      console.error("Failed to fetch from my.cgi", err);
      return "";
    }
  };

  // --- HELPER: UPDATE IMOOD ---
  const updateimood = async (baseMood, personalNote = "", faceId = "") => {
    const params = new URLSearchParams({
      email,
      password,
      base: baseMood,
      personal: personalNote,
    });
    if (faceId) params.append("face", faceId);

    // 1. Submit the update
    await fetch("https://xml.imood.org/update.cgi", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; imoodBot/1.0)",
      },
      body: params.toString(),
    });

    // 2. Wait 1 second to allow imood's legacy database to register the write
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 3. Verify state via my.cgi
    const xmlResult = await getMyimoodData("personal");
    const personalXml = extractBundle(xmlResult, "personal") ?? xmlResult;
    const base = extractTag(personalXml, "base");

    return base.toLowerCase() === baseMood.toLowerCase();
  };

  // ==========================================
  // ROUTE 1: THE CRON JOB TRIGGER
  // ==========================================
  if (req.method === "GET" && req.query.secret) {
    if (req.query.secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await sendMessage(chatId, "log mood at least once before bed.");
    return res.status(200).json({ success: true });
  }

  // ROUTE 1.5: PUBLIC IMOOD DATA PROXY
  if (req.method === "GET" && req.query.action === "status") {
    const xmlResult = await getMyimoodData("personal");
    const personalXml = extractBundle(xmlResult, "personal") ?? xmlResult;

    // 1. Evaluate origin for safe local testing and production enforcement
    const origin = req.headers.origin;
    const allowedOrigin = process.env.ALLOWED_ORIGIN; // e.g. "https://your-site.com"

    // Validates localhost, local loopback, and standard 192.168.x.x LAN IPs on any port
    const isLocalNetwork =
      origin &&
      /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+):\d+$/.test(origin);

    if (origin === allowedOrigin || isLocalNetwork) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else {
      // Fallback to strict production origin if unrecognized or missing
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    }
    // Prevent Vercel's edge cache from serving one origin's cached
    res.setHeader("Vary", "Origin");

    // 2. Set Edge Caching headers
    res.setHeader(
      "Cache-Control",
      "max-age=0, s-maxage=300, stale-while-revalidate",
    );

    // 3. Return the payload
    return res.status(200).json({
      base: extractTag(personalXml, "base"),
      personal: extractTag(personalXml, "personal"),
    });
  }

  // ==========================================
  // ROUTE 2: THE TELEGRAM WEBHOOK
  // ==========================================
  if (req.method === "POST") {
    // FAIL FAST: Validate Telegram Secret Token before parsing body or execution
    const secretToken = req.headers["x-telegram-bot-api-secret-token"];
    if (secretToken !== process.env.TELEGRAM_SECRET_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { message } = req.body;

    // Ignore anyone who isn't you. Telegram's secret-token check above only
    // proves the request came from Telegram, not that it came from your chat -
    // any stranger who messages the bot passes that check too.
    if (message && message.chat.id.toString() !== chatId.toString()) {
      return res.status(200).send("OK");
    }

    // Fixed-reply / data-lookup commands, keyed by exact input text.
    // Each handler just performs its action — the single dispatch below
    // sends the "OK" response once, instead of repeating it per command.
    const COMMANDS = {
      "/start": async (id) => sendMessage(id, START_MESSAGE),
      "/moods": async (id) => sendMessage(id, "imood.com/moods"),
      "/translation": async (id) => {
        const url = `https://${req.headers.host}/moods-zh-tw.txt?v=${Date.now()}`;
        await sendMessage(id, url);
      },

      "/faces": async (id) => {
        const gridUrl = `https://${req.headers.host}/faces-grid.png?v=${Date.now()}`;
        await sendDocument(
          id,
          gridUrl,
          "if you're on desktop, recommend ping this message.",
        );
      },

      "/buddies": async (id) => {
        const xmlResult = await getMyimoodData("buddy");
        const buddyXml = extractBundle(xmlResult, "buddy");

        if (!buddyXml || buddyXml.trim() === "") {
          await sendMessage(id, "no buddy data found or your list is empty.");
          return;
        }

        const userBlocks = extractBlocks(buddyXml, "buddy") || [];
        const buddyText = userBlocks
          .map((block) => {
            const name = extractTag(block, "name") || "unknown";
            const face = extractTag(block, "face") || "unknown";
            const mood = extractTag(block, "base") || "unknown";
            const date = extractTag(block, "date") || "unknown";
            const msg = extractTag(block, "personal");
            return formatEntry(date, `${name}: face#${face} ${mood}`, msg);
          })
          .join("");

        await sendMessage(id, buddyText);
      },

      "/history": async (id) => {
        const xmlResult = await getMyimoodData("history");
        const historyXml = extractBundle(xmlResult, "history");
        const moodBlocks = historyXml
          ? extractBlocks(historyXml, "mood")
          : null;

        if (!moodBlocks) {
          await sendMessage(id, "no mood history found.");
          return;
        }

        // imood returns newest first; cap entries so the message stays
        // under Telegram's 4096-character limit as history grows
        let historyText = "";
        for (const block of moodBlocks.slice(0, HISTORY_LIMIT)) {
          const mood = extractTag(block, "base") || "unknown";
          const date = extractTag(block, "date") || "unknown";
          const msg = extractTag(block, "personal");
          const entry = formatEntry(date, mood, msg);
          if (historyText.length + entry.length > MAX_MESSAGE_LENGTH) break;
          historyText += entry;
        }

        // parse_mode disabled so notes containing _ or * don't break the message
        await sendMessage(id, historyText.trim(), { parse_mode: undefined });
      },
    };

    try {
      // --- HANDLE TEXT MESSAGES ---
      if (message && message.text) {
        const id = message.chat.id;
        let text = message.text.trim();

        if (COMMANDS[text]) {
          await COMMANDS[text](id);
          return res.status(200).send("OK");
        }

        // Handle mood parsing & face id extraction
        const faceMatch = text.match(/#(\d+)$/);
        let faceId = "";

        if (faceMatch) {
          const potentialFaceId = parseInt(faceMatch[1], 10);
          if (potentialFaceId >= 0 && potentialFaceId <= 32) {
            faceId = potentialFaceId.toString();
            text = text.replace(/#\d+$/, "").trim(); // Safely strip the Face Id from the note
          }
        }

        const lowerText = text.toLowerCase();
        const matchedMood = VALID_MOODS.find(
          (mood) => lowerText === mood || lowerText.startsWith(mood + " "),
        );

        if (matchedMood && faceId) {
          // imood misreads UTF-8 as Windows-1252 (’ becomes â€™, — becomes â€”),
          // so swap typographic punctuation for plain ASCII before sending
          const personalNote = text
            .slice(matchedMood.length)
            .trim()
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2013\u2014]/g, "-")
            .replace(/\u2026/g, "...");
          const ok = await updateimood(matchedMood, personalNote, faceId);
          const profileUrl = `https://www.imood.com/users/${username}`;

          if (ok) {
            await sendMessage(id, `imood updated!\n${profileUrl}`, {
              parse_mode: undefined,
              link_preview_options: {
                url: `${profileUrl}?v=${Date.now()}`,
              },
            });
          } else {
            await sendMessage(id, `update failed.`);
          }
        } else if (matchedMood) {
          await sendMessage(id, `missing face id.`);
        } else {
          const attemptedWord = text.split(" ")[0];
          await sendMessage(
            id,
            `invalid mood. "${attemptedWord}" is not on the official imood list.`,
          );
        }
      }

      return res.status(200).send("OK");
    } catch (err) {
      console.error(err);
      return res.status(500).send("Internal Server Error");
    }
  }

  // Fallback for unhandled HTTP methods
  return res.status(405).send("Method Not Allowed");
}
