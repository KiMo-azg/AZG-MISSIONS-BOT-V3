require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const crypto = require("crypto");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_KEY = process.env.AZG_API_KEY;
const PORT = Number(process.env.PORT || 3000);
const MISSIONS_CHANNEL_ID = process.env.MISSIONS_CHANNEL_ID || "";
const LINK_CODE_TTL_MINUTES = Number(process.env.LINK_CODE_TTL_MINUTES || 10);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DISCORD_TOKEN || !API_KEY) {
  console.error("❌ Missing DISCORD_TOKEN or AZG_API_KEY in .env");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL in .env (Postgres connection string, e.g. from Neon)");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "32kb" }));

// Protects the API from being hammered (accidentally or by someone probing the key).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, slow down." }
});
app.use("/api/", apiLimiter);

// Neon (and most managed Postgres) requires SSL. rejectUnauthorized:false is what
// Neon's own connection docs recommend when not pinning their CA certificate.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS linked_users (
      discord_id TEXT PRIMARY KEY,
      steamid TEXT NOT NULL UNIQUE,
      linked_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_codes (
      code TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_missions (
      period TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_mission_items (
      period TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      PRIMARY KEY (period, mission_id)
    );

    CREATE TABLE IF NOT EXISTS mission_progress (
      discord_id TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      period TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      completed_at BIGINT,
      PRIMARY KEY (discord_id, mission_id, period)
    );

    CREATE INDEX IF NOT EXISTS idx_linked_steamid ON linked_users(steamid);
    CREATE INDEX IF NOT EXISTS idx_progress_discord ON mission_progress(discord_id);
  `);
}

const dailyMissionsPool = [
  { id:"d1", title:"🎯 Dust2 AK-47 Headshot Master", description:"Get 40 headshot kills using the AK-47 on de_dust2.", reward:"Owner-decided reward", type:"headshots", target:40 },
  { id:"d2", title:"⚡ Deagle Quick Execution", description:"Get 25 kills using the Desert Eagle.", reward:"Owner-decided reward", type:"kills", target:25 },
  { id:"d3", title:"💣 Inferno Site Defender", description:"Secure 30 kills defending bomb sites using the M4A1.", reward:"Owner-decided reward", type:"kills", target:30 },
  { id:"d4", title:"🛡️ AWP Sniper Elite", description:"Secure 35 kills using the AWP.", reward:"Owner-decided reward", type:"kills", target:35 },
  { id:"d5", title:"💥 AK-47 Spray Control", description:"Score 45 kills using the AK-47.", reward:"Owner-decided reward", type:"kills", target:45 },
  { id:"d6", title:"🔫 M4A1 Tactical Striker", description:"Score 45 kills using the M4A1 as CT.", reward:"Owner-decided reward", type:"kills", target:45 },
  { id:"d7", title:"🎯 Deagle Long Range", description:"Secure 20 headshot kills with the Desert Eagle.", reward:"Owner-decided reward", type:"headshots", target:20 },
  { id:"d8", title:"🦅 AWP Reflex Master", description:"Get 25 kills using the AWP.", reward:"Owner-decided reward", type:"kills", target:25 },
  { id:"d9", title:"💣 Bomb Defuser Pro", description:"Successfully defuse 6 bombs on active maps.", reward:"Owner-decided reward", type:"defuses", target:6 },
  { id:"d10", title:"🔥 Terrorist AK-47 Rush", description:"Win 20 rounds playing Terrorist using AK-47.", reward:"Owner-decided reward", type:"rounds", target:20 },
  { id:"d11", title:"🎯 AK-47 Precision Strike", description:"Score 30 eligible AK-47 kills.", reward:"Owner-decided reward", type:"kills", target:30 },
  { id:"d12", title:"⚡ Deagle Pistol Round Domination", description:"Secure 18 kills using only the Deagle in public matches.", reward:"Owner-decided reward", type:"kills", target:18 },
  { id:"d13", title:"🛡️ M4A1 Long Guard", description:"Get 35 eligible M4A1 kills.", reward:"Owner-decided reward", type:"kills", target:35 },
  { id:"d14", title:"🦅 AWP Crossfire Master", description:"Eliminate 30 enemies using AWP.", reward:"Owner-decided reward", type:"kills", target:30 },
  { id:"d15", title:"💥 AK-47 Multi-Killer", description:"Achieve 10 multi-kills using the AK-47.", reward:"Owner-decided reward", type:"multikills", target:10 },
  { id:"d16", title:"🎯 Deagle Headshot Hunter", description:"Get 15 headshot kills with Desert Eagle.", reward:"Owner-decided reward", type:"headshots", target:15 },
  { id:"d17", title:"🛡️ CT M4A1 Victory March", description:"Win 18 rounds on CT using M4A1.", reward:"Owner-decided reward", type:"rounds", target:18 },
  { id:"d18", title:"🔥 AWP Fast Scope Expert", description:"Secure 22 eligible AWP kills.", reward:"Owner-decided reward", type:"kills", target:22 },
  { id:"d19", title:"💣 Plant & Protect with AK", description:"Plant 10 bombs and secure the required AK-47 progress.", reward:"Owner-decided reward", type:"objective", target:10 },
  { id:"d20", title:"⚡ Ultimate Weapon Switcher", description:"Get alternating eligible kills using Deagle and AK-47.", reward:"Owner-decided reward", type:"kills", target:25 },
  { id:"d21", title:"🎯 Dust2 AWP Long Control", description:"Secure 25 AWP kills on de_dust2.", reward:"Owner-decided reward", type:"kills", target:25 },
  { id:"d22", title:"🔥 AK-47 B Site Dominator", description:"Get 30 eligible AK-47 kills around B site.", reward:"Owner-decided reward", type:"kills", target:30 },
  { id:"d23", title:"🛡️ M4A1 A Site Protector", description:"Get 30 eligible M4A1 kills defending A site.", reward:"Owner-decided reward", type:"kills", target:30 },
  { id:"d24", title:"⚡ Deagle Close Combat", description:"Secure 15 close-quarter Deagle kills.", reward:"Owner-decided reward", type:"kills", target:15 },
  { id:"d25", title:"🦅 AWP Total Annihilation", description:"Score 40 AWP kills.", reward:"Owner-decided reward", type:"kills", target:40 },
  { id:"d26", title:"💥 AK-47 Double Tap Expert", description:"Get 20 eligible AK-47 kills.", reward:"Owner-decided reward", type:"kills", target:20 },
  { id:"d27", title:"🔫 M4A1 Silenced Assassin", description:"Secure 35 eligible M4A1 kills.", reward:"Owner-decided reward", type:"kills", target:35 },
  { id:"d28", title:"🎯 Deagle Headshot Specialist", description:"Achieve 20 Deagle headshot kills.", reward:"Owner-decided reward", type:"headshots", target:20 },
  { id:"d29", title:"🛡️ Counter-Terrorist AWP Guard", description:"Win 12 rounds on CT using AWP.", reward:"Owner-decided reward", type:"rounds", target:12 },
  { id:"d30", title:"🔥 Terrorist AK-47 Rampage", description:"Secure 45 AK-47 kills as Terrorist.", reward:"Owner-decided reward", type:"kills", target:45 },
  { id:"d31", title:"💣 Plant Master with Deagle Backup", description:"Plant 8 bombs with the required Deagle condition.", reward:"Owner-decided reward", type:"objective", target:8 },
  { id:"d32", title:"⚡ Fast Reflex AK-47", description:"Secure 35 AK-47 kills.", reward:"Owner-decided reward", type:"kills", target:35 },
  { id:"d33", title:"🛡️ M4A1 Eco Round Destroyer", description:"Win 5 eligible eco-round objectives using M4A1.", reward:"Owner-decided reward", type:"rounds", target:5 },
  { id:"d34", title:"🦅 AWP Quick Scope King", description:"Get 25 quick-scope AWP kills. The CS plugin validates the condition.", reward:"Owner-decided reward", type:"kills", target:25 },
  { id:"d35", title:"💥 Ultimate Server Marksman", description:"Get 50 combined eligible kills using AK-47, M4A1, AWP, or Deagle.", reward:"Owner-decided reward", type:"kills", target:50 }
];

const weeklyMissionsPool = [
  { id:"w1", title:"🏆 Ultimate AK-47 Legend", description:"Accumulate 300 AK-47 kills this week.", reward:"Owner-decided reward", type:"kills", target:300 },
  { id:"w2", title:"👑 AWP God of the Week", description:"Secure 250 AWP kills this week.", reward:"Owner-decided reward", type:"kills", target:250 },
  { id:"w3", title:"⚔️ M4A1 Fortress Guardian", description:"Get 250 M4A1 kills while playing CT.", reward:"Owner-decided reward", type:"kills", target:250 },
  { id:"w4", title:"🎯 Desert Eagle Mastermind", description:"Secure 150 Deagle kills.", reward:"Owner-decided reward", type:"kills", target:150 },
  { id:"w5", title:"🛡️ Bomb Planter & Defuser King", description:"Plant or defuse the bomb 70 times.", reward:"Owner-decided reward", type:"objective", target:70 },
  { id:"w6", title:"🔥 Heavy Arsenal Marathon", description:"Complete 150 eligible rounds using AK-47 or M4A1.", reward:"Owner-decided reward", type:"rounds", target:150 },
  { id:"w7", title:"🎯 AK-47 Headshot Fanatic Weekly", description:"Secure 180 AK-47 headshots.", reward:"Owner-decided reward", type:"headshots", target:180 },
  { id:"w8", title:"🦅 AWP Sniper Overlord", description:"Get 220 AWP kills.", reward:"Owner-decided reward", type:"kills", target:220 },
  { id:"w9", title:"🛡️ M4A1 Defensive Master", description:"Secure 200 eligible M4A1 kills.", reward:"Owner-decided reward", type:"kills", target:200 },
  { id:"w10", title:"⚡ Deagle Elite Gunfighter", description:"Accumulate 140 Deagle kills.", reward:"Owner-decided reward", type:"kills", target:140 },
  { id:"w11", title:"🏆 Dust2 Weapon Master", description:"Get 350 combined eligible kills on de_dust2.", reward:"Owner-decided reward", type:"kills", target:350 },
  { id:"w12", title:"⚔️ Hardcore Round Conqueror", description:"Win 120 eligible rounds.", reward:"Owner-decided reward", type:"rounds", target:120 },
  { id:"w13", title:"🎯 AK-47 Elite Executioner", description:"Secure 280 AK-47 kills.", reward:"Owner-decided reward", type:"kills", target:280 },
  { id:"w14", title:"🛡️ CT M4A1 Dominance Weekly", description:"Win 100 CT rounds.", reward:"Owner-decided reward", type:"rounds", target:100 },
  { id:"w15", title:"🦅 AWP Long Range Terror", description:"Get 200 eligible long-range AWP kills.", reward:"Owner-decided reward", type:"kills", target:200 },
  { id:"w16", title:"⚡ Deagle Ultimate Legend", description:"Secure 130 Deagle kills.", reward:"Owner-decided reward", type:"kills", target:130 },
  { id:"w17", title:"🔥 Objective & Weapon Master", description:"Complete 50 eligible bomb objectives.", reward:"Owner-decided reward", type:"objective", target:50 },
  { id:"w18", title:"🏆 Supreme Server Grinder", description:"Complete 200 eligible active rounds.", reward:"Owner-decided reward", type:"rounds", target:200 },
  { id:"w19", title:"🎯 Ultimate Headshot Hunter Weekly", description:"Get 220 eligible headshots.", reward:"Owner-decided reward", type:"headshots", target:220 },
  { id:"w20", title:"⚔️ AZG Ultimate Champion", description:"Secure 400 total eligible kills using approved weapons.", reward:"Owner-decided reward", type:"kills", target:400 }
];

const allMissions = new Map([...dailyMissionsPool, ...weeklyMissionsPool].map(m => [m.id, m]));

function randomSample(arr, count) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

async function getPeriod(period) {
  const row = await queryOne("SELECT * FROM active_missions WHERE period = $1", [period]);
  if (!row) return null;

  const idRows = await query("SELECT mission_id FROM active_mission_items WHERE period = $1", [period]);
  const missions = idRows.map(r => allMissions.get(r.mission_id)).filter(Boolean);

  return { expiresAt: Number(row.expires_at), missions };
}

async function rotatePeriod(period) {
  const isDaily = period === "daily";
  const sourcePool = isDaily ? dailyMissionsPool : weeklyMissionsPool;
  const count = isDaily ? 8 : 4;
  const expiresAt = Date.now() + (isDaily ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000);
  const selected = randomSample(sourcePool, count);

  await withTransaction(async (client) => {
    await client.query("DELETE FROM active_mission_items WHERE period = $1", [period]);
    await client.query(`
      INSERT INTO active_missions (period, expires_at)
      VALUES ($1, $2)
      ON CONFLICT (period) DO UPDATE SET expires_at = EXCLUDED.expires_at
    `, [period, expiresAt]);

    for (const m of selected) {
      await client.query("INSERT INTO active_mission_items (period, mission_id) VALUES ($1, $2)", [period, m.id]);
    }

    // "period" only stores "daily"/"weekly", not which rotation/cycle it was.
    // Without this, a mission ID that gets picked again in a later rotation would
    // keep yesterday's leftover progress (or even come back pre-completed), and
    // the table would grow forever. A fresh rotation means a fresh scoreboard.
    await client.query("DELETE FROM mission_progress WHERE period = $1", [period]);
  });

  console.log(`🔄 ${period} missions rotated.`);
}

async function ensureMissions() {
  for (const period of ["daily", "weekly"]) {
    const current = await getPeriod(period);
    if (!current || Date.now() >= current.expiresAt || current.missions.length === 0) {
      await rotatePeriod(period);
    }
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to the AZG Counter-Strike server"),
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink your Discord account from the AZG Counter-Strike server"),
  new SlashCommandBuilder()
    .setName("mystatus")
    .setDescription("Show your linked SteamID and current mission progress")
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

async function cleanupExpiredCodes() {
  await pool.query("DELETE FROM pending_codes WHERE expires_at <= $1", [Date.now()]);
}

function generateLinkCode() {
  return `AZG-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual throws on mismatched lengths — check first so a wrong-length
  // header returns a clean 401 instead of a stack trace.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireApiKey(req, res, next) {
  const provided = req.get("x-azg-api-key");
  if (!provided || !safeCompare(provided, API_KEY)) {
    return res.status(401).json({ success:false, message:"Unauthorized" });
  }
  next();
}

async function getLinkedBySteam(steamid) {
  return await queryOne("SELECT * FROM linked_users WHERE steamid = $1", [String(steamid)]);
}

async function sendCompletionDM(discordId, mission, progress) {
  try {
    const user = await client.users.fetch(discordId);

    const missionPeriod = mission.id.startsWith("d") ? "📅 Daily Mission" : "📆 Weekly Mission";

    const completionMessage =
      `🎉 **AZG MISSION COMPLETED!** 🎉\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🔥 **Congratulations! You have completed an AZG Mission!**\n\n` +
      `You successfully reached the required target for the mission below. ` +
      `This message is your completion confirmation from the AZG Missions System.\n\n` +

      `📌 **MISSION DETAILS**\n` +
      `> ${missionPeriod}\n` +
      `> 🎯 **Mission:** ${mission.title}\n` +
      `> 📋 **Objective:** ${mission.description}\n` +
      `> 📊 **Progress:** ${progress}/${mission.target}\n` +
      `> 🆔 **Mission ID:** ${mission.id}\n\n` +

      `🎁 **REWARD INFORMATION**\n` +
      `> ${mission.reward}\n\n` +
      `⚠️ **Important:** The AZG bot does NOT automatically give the reward. ` +
      `The Server Owner/Admin will review your completion and handle the reward manually.\n\n` +

      `📸 **WHAT YOU NEED TO DO NOW**\n` +
      `1️⃣ Take a clear screenshot of **this entire DM message**.\n` +
      `2️⃣ Make sure the mission name, objective, progress, Mission ID, and reward information are visible.\n` +
      `3️⃣ Send the screenshot to the **AZG Server Owner / Admin**.\n` +
      `4️⃣ The Owner/Admin will verify your completion and give you the appropriate reward according to the server rules.\n\n` +

      `✅ **MISSION STATUS: COMPLETED**\n` +
      `🏆 Keep playing and look out for the next AZG Missions!\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 **AZG Automated Missions System**`;

    await user.send(completionMessage);
    return true;
  } catch (err) {
    console.error("DM error:", err.message);
    return false;
  }
}

async function updateMissionsChannel() {
  if (!MISSIONS_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(MISSIONS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    // Only delete the bot's previous mission messages, not everyone else's messages.
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);

    // Discord's bulkDelete silently refuses messages older than 14 days, so those
    // would pile up forever if the bot was ever offline for a while. Delete those
    // one by one instead.
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = botMessages.filter(m => m.createdTimestamp > twoWeeksAgo);
    const stale = botMessages.filter(m => m.createdTimestamp <= twoWeeksAgo);

    if (recent.size) await channel.bulkDelete(recent, true).catch(() => {});
    for (const m of stale.values()) await m.delete().catch(() => {});

    const daily = await getPeriod("daily");
    const weekly = await getPeriod("weekly");

    const embed = new EmbedBuilder()
      .setTitle("🔥 AMAZING GAMING PUBLIC (AZG) - Server Missions")
      .setDescription(
        "Complete missions in the AZG CS 1.6 server.\n" +
        "Use `/link` in Discord to connect your Discord account.\n\n" +
        "📸 When a mission is completed, the bot sends you a DM. Screenshot it and send it to the Owner/Admin. Rewards are handled manually."
      )
      .setColor(0x00AE86)
      .setTimestamp()
      .setFooter({ text: "AZG Automated Missions • Daily & Weekly Rotation" });

    embed.addFields({
      name: "📅 DAILY MISSIONS",
      value: daily.missions.map((m, i) =>
        `**${i + 1}. ${m.title}**\n${m.description}\n🎁 ${m.reward}`
      ).join("\n\n") || "No daily missions.",
      inline: false
    });

    embed.addFields({
      name: "📆 WEEKLY MISSIONS",
      value: weekly.missions.map((m, i) =>
        `**${i + 1}. ${m.title}**\n${m.description}\n🎁 ${m.reward}`
      ).join("\n\n") || "No weekly missions.",
      inline: false
    });

    await channel.send({ embeds: [embed] });
    console.log("✅ Missions channel updated.");
  } catch (error) {
    console.error("❌ Missions channel error:", error.message);
  }
}

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error("❌ Command registration error:", error);
  }

  await updateMissionsChannel();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "link") {
    await cleanupExpiredCodes();

    const discordId = interaction.user.id;
    const code = generateLinkCode();
    const expiresAt = Date.now() + LINK_CODE_TTL_MINUTES * 60 * 1000;

    await pool.query("DELETE FROM pending_codes WHERE discord_id = $1", [discordId]);
    await pool.query("INSERT INTO pending_codes (code, discord_id, expires_at) VALUES ($1, $2, $3)",
      [code, discordId, expiresAt]);

    try {
      await interaction.user.send(
        `🔗 Your **AZG Counter-Strike linking code** is: **${code}**\n\n` +
        `Type this in the AZG CS 1.6 server chat:\n` +
        `\`/link ${code}\`\n\n` +
        `⏱️ This code expires in **${LINK_CODE_TTL_MINUTES} minutes**.`
      );

      await interaction.reply({
        content: "✅ Linking code sent to your DM!",
        ephemeral: true
      });
    } catch {
      await pool.query("DELETE FROM pending_codes WHERE code = $1", [code]);
      await interaction.reply({
        content: "❌ I couldn't DM you. Please enable DMs from this server and try again.",
        ephemeral: true
      });
    }
    return;
  }

  if (interaction.commandName === "unlink") {
    const result = await pool.query("DELETE FROM linked_users WHERE discord_id = $1", [interaction.user.id]);

    await interaction.reply({
      content: result.rowCount
        ? "🔓 Your account has been unlinked. Use `/link` again any time to reconnect."
        : "ℹ️ You don't have a linked account.",
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === "mystatus") {
    const linked = await queryOne("SELECT * FROM linked_users WHERE discord_id = $1", [interaction.user.id]);

    if (!linked) {
      await interaction.reply({
        content: "ℹ️ You don't have a linked account yet. Use `/link` to get started.",
        ephemeral: true
      });
      return;
    }

    const rows = await query(`
      SELECT mission_id, period, progress, completed_at
      FROM mission_progress
      WHERE discord_id = $1
      ORDER BY period, mission_id
    `, [interaction.user.id]);

    const lines = rows.length
      ? rows.map(r => {
          const mission = allMissions.get(r.mission_id);
          const title = mission ? mission.title : r.mission_id;
          const target = mission ? mission.target : "?";
          const status = r.completed_at ? "✅ Completed" : `${r.progress}/${target}`;
          return `> **${title}** — ${status}`;
        }).join("\n")
      : "> No active progress yet.";

    const embed = new EmbedBuilder()
      .setTitle("📊 Your AZG Status")
      .setDescription(`🔗 Linked SteamID: **${linked.steamid}**\n\n${lines}`)
      .setColor(0x00AE86);

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
});

// -------- API --------

app.get("/health", (req, res) => {
  res.json({ ok:true, service:"AZG Missions", time:Date.now() });
});

app.get("/api/missions", requireApiKey, async (req, res) => {
  await ensureMissions();
  const daily = await getPeriod("daily");
  const weekly = await getPeriod("weekly");

  res.json({
    success:true,
    daily: daily.missions,
    weekly: weekly.missions,
    expiresDaily: daily.expiresAt,
    expiresWeekly: weekly.expiresAt
  });
});

app.post("/api/verify-link", requireApiKey, async (req, res) => {
  await cleanupExpiredCodes();

  const { code, steamid } = req.body;
  if (!code || !steamid) {
    return res.status(400).json({ success:false, message:"Missing code or steamid." });
  }

  const pending = await queryOne("SELECT * FROM pending_codes WHERE code = $1", [String(code)]);
  if (!pending || Number(pending.expires_at) <= Date.now()) {
    return res.status(400).json({ success:false, message:"Invalid or expired code." });
  }

  const existing = await getLinkedBySteam(steamid);
  if (existing && existing.discord_id !== pending.discord_id) {
    return res.status(409).json({ success:false, message:"This SteamID is already linked to another Discord account." });
  }

  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO linked_users (discord_id, steamid, linked_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (discord_id) DO UPDATE SET steamid = EXCLUDED.steamid, linked_at = EXCLUDED.linked_at
    `, [pending.discord_id, String(steamid), Date.now()]);

    await client.query("DELETE FROM pending_codes WHERE code = $1", [String(code)]);
  });

  return res.json({
    success:true,
    message:"Account linked successfully!",
    discordId:pending.discord_id
  });
});

/*
  The CS 1.6 plugin should validate the mission's detailed conditions
  (weapon/map/team/headshot/etc.) and send only eligible progress.

  Example:
  {
    "steamid": "STEAM_0:1:123456",
    "missionId": "d1",
    "amount": 1
  }
*/
app.post("/api/mission-progress", requireApiKey, async (req, res) => {
  await ensureMissions();

  const { steamid, missionId, amount } = req.body;
  const increment = Number(amount);

  if (!steamid || !missionId || !Number.isInteger(increment) || increment < 1 || increment > 100) {
    return res.status(400).json({ success:false, message:"Invalid steamid, missionId or amount." });
  }

  const linked = await getLinkedBySteam(steamid);
  if (!linked) {
    return res.status(404).json({ success:false, message:"SteamID is not linked to Discord." });
  }

  const mission = allMissions.get(String(missionId));
  if (!mission) {
    return res.status(404).json({ success:false, message:"Mission does not exist." });
  }

  const period = mission.id.startsWith("d") ? "daily" : "weekly";
  const active = await getPeriod(period);
  if (!active.missions.some(m => m.id === mission.id)) {
    return res.status(409).json({ success:false, message:"Mission is not currently active." });
  }

  const existing = await queryOne(`
    SELECT * FROM mission_progress
    WHERE discord_id = $1 AND mission_id = $2 AND period = $3
  `, [linked.discord_id, mission.id, period]);

  if (existing?.completed_at) {
    return res.json({
      success:true,
      alreadyCompleted:true,
      progress:existing.progress,
      target:mission.target
    });
  }

  const oldProgress = existing?.progress || 0;
  const newProgress = Math.min(mission.target, oldProgress + increment);
  const completed = newProgress >= mission.target;
  const now = Date.now();

  await pool.query(`
    INSERT INTO mission_progress
      (discord_id, mission_id, period, progress, completed_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (discord_id, mission_id, period)
    DO UPDATE SET progress=EXCLUDED.progress, completed_at=EXCLUDED.completed_at
  `, [linked.discord_id, mission.id, period, newProgress, completed ? now : null]);

  let dmSent = false;
  if (completed) {
    dmSent = await sendCompletionDM(linked.discord_id, mission, newProgress);
  }

  return res.json({
    success:true,
    completed,
    dmSent,
    progress:newProgress,
    target:mission.target,
    missionId:mission.id
  });
});

app.get("/api/player-progress/:steamid", requireApiKey, async (req, res) => {
  const linked = await getLinkedBySteam(req.params.steamid);
  if (!linked) {
    return res.status(404).json({ success:false, message:"SteamID is not linked." });
  }

  const rows = await query(`
    SELECT mission_id, period, progress, completed_at
    FROM mission_progress
    WHERE discord_id = $1
    ORDER BY period, mission_id
  `, [linked.discord_id]);

  res.json({ success:true, discordId:linked.discord_id, progress:rows });
});

app.use((err, req, res, next) => {
  console.error("API error:", err);
  res.status(500).json({ success:false, message:"Internal server error." });
});

setInterval(async () => {
  try {
    await cleanupExpiredCodes();

    const beforeDaily = (await getPeriod("daily"))?.expiresAt || 0;
    const beforeWeekly = (await getPeriod("weekly"))?.expiresAt || 0;

    await ensureMissions();

    const changed =
      (await getPeriod("daily"))?.expiresAt !== beforeDaily ||
      (await getPeriod("weekly"))?.expiresAt !== beforeWeekly;

    if (changed) await updateMissionsChannel();
  } catch (err) {
    console.error("Rotation check error:", err.message);
  }
}, 60 * 1000);

// -------- Keep-alive heartbeat (Render free tier) --------
// A free Render web service spins down after 15 minutes with no incoming
// HTTP request. This makes the service ping its own /health endpoint every
// few minutes so it never goes quiet long enough to be put to sleep.
// Notes:
//  - This does NOT reduce Render's 750 free-instance-hours/month usage — a
//    service that never sleeps uses close to the full monthly allowance
//    either way. It only stops the bot from disconnecting from Discord and
//    stops requests from hanging on a ~30-60s cold start.
//  - RENDER_EXTERNAL_URL is set automatically by Render on deploy, so no
//    manual configuration is needed there. Locally (no Render env) this
//    simply does nothing.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }, 10 * 60 * 1000);
  console.log(`💓 Self-ping heartbeat enabled for ${SELF_URL}`);
} else {
  console.log("💤 RENDER_EXTERNAL_URL not set — heartbeat disabled (fine for local dev).");
}

async function start() {
  await initSchema();
  await ensureMissions();

  app.listen(PORT, () => {
    console.log(`🚀 AZG API running on port ${PORT}`);
  });

  await client.login(DISCORD_TOKEN);
}

start().catch(err => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
