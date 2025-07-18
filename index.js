import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } from "discord.js";
import fetch from "node-fetch";

const {
  DISCORD_TOKEN,
  GUILD_ID,
  CHANNEL_ID,
  OWNER_ID,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !CHANNEL_ID || !OWNER_ID || !SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
  console.error("One or more environment variables are missing.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let spotifyAccessToken = null;
let spotifyAccessTokenExpiresAt = 0;
let lastSpotifyData = null;
let updateTimeout;
const startTime = Date.now();

// === Spotify token handling ===
async function refreshSpotifyToken() {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh Spotify token: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  spotifyAccessToken = data.access_token;
  spotifyAccessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000 * 0.9;
  return spotifyAccessToken;
}

async function getSpotifyAccessToken() {
  if (!spotifyAccessToken || Date.now() > spotifyAccessTokenExpiresAt) {
    return refreshSpotifyToken();
  }
  return spotifyAccessToken;
}

// === Fetch Spotify playback data ===
async function fetchSpotifyData() {
  const token = await getSpotifyAccessToken();
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Failed to fetch Spotify currently playing: ${res.status} ${res.statusText}`);

  const data = await res.json();
  if (!data || !data.item) return null;

  const progress_ms = data.progress_ms;
  const duration_ms = data.item.duration_ms;
  const started_at = Date.now() - progress_ms;
  const ends_at = started_at + duration_ms;

  const smartCap = (str) => {
    if (!str) return "";
    const letters = str.replace(/[^A-Za-z]/g, "");
    return letters && letters === letters.toUpperCase() ? str : str.toLowerCase();
  };

  return {
    track: smartCap(data.item.name),
    artist: smartCap(data.item.artists.map(a => a.name).join(", ")),
    albumArt: data.item.album.images[0]?.url || null,
    progress_ms,
    duration_ms,
    started_at,
    ends_at,
    is_playing: data.is_playing,
  };
}

// === Create embed ===
function createEmbed(data) {
  if (!data) {
    return new EmbedBuilder()
      .setTitle("jack is not listening to anything right now")
      .setColor("#000000");
  }

  const formatTime = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  return new EmbedBuilder()
    .setColor("#000000")
    .setTitle("jack is currently listening to")
    .setDescription(`**${data.track}** by **${data.artist}**`)
    .setThumbnail(data.albumArt)
    .addFields(
      { name: "Started", value: `<t:${Math.floor(data.started_at / 1000)}:t>`, inline: true },
      { name: "Ends", value: `<t:${Math.floor(data.ends_at / 1000)}:t>`, inline: true },
      { name: "Progress", value: `${formatTime(data.progress_ms)} / ${formatTime(data.duration_ms)}`, inline: true }
    )
    .setTimestamp();
}

// === Dynamic updater ===
async function updateSpotifyMessage(channel, messageId) {
  try {
    const data = await fetchSpotifyData();

    if (!data) {
      if (messageId) {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [createEmbed(null)] });
      }
      return;
    }

    lastSpotifyData = data;

    let msg;
    if (messageId) {
      msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [createEmbed(data)] });
      } else {
        msg = await channel.send({ embeds: [createEmbed(data)] });
      }
    } else {
      msg = await channel.send({ embeds: [createEmbed(data)] });
    }
    return msg.id;
  } catch (err) {
    console.error("Error updating Spotify message:", err);
  }
}

function scheduleNextUpdate(channel, messageId) {
  const interval = lastSpotifyData && lastSpotifyData.is_playing ? 5000 : 30000;
  updateTimeout = setTimeout(async () => {
    const newMessageId = await updateSpotifyMessage(channel, messageId);
    scheduleNextUpdate(channel, newMessageId || messageId);
  }, interval);
}

// === Commands ===
const commands = [
  new SlashCommandBuilder().setName("spotifystatus").setDescription("Show current Spotify listening status"),
  new SlashCommandBuilder().setName("getspotifytoken").setDescription("Get the current Spotify access token (owner only)"),
  new SlashCommandBuilder().setName("refreshspotifytoken").setDescription("Force refresh the Spotify access token (owner only)"),
  new SlashCommandBuilder().setName("clearcommands").setDescription("Clear all registered slash commands (owner only)"),
  new SlashCommandBuilder().setName("reloadcommands").setDescription("Reload all slash commands (owner only)"),
  new SlashCommandBuilder().setName("ping").setDescription("Check bot latency"),
  new SlashCommandBuilder().setName("uptime").setDescription("Check bot uptime"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause Spotify playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume Spotify playback"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip to next track"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playback (pause)"),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: commands.map(cmd => cmd.toJSON()),
  });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  const channel = await client.channels.fetch(CHANNEL_ID);
  scheduleNextUpdate(channel, null);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  const isOwner = user.id === OWNER_ID;

  if (commandName === "spotifystatus") {
    const data = await fetchSpotifyData();
    await interaction.reply({ embeds: [createEmbed(data)], ephemeral: true });
  }

  if (commandName === "getspotifytoken" && isOwner) {
    if (!spotifyAccessToken) await refreshSpotifyToken();
    await interaction.reply({ content: `Access Token: \`${spotifyAccessToken}\``, ephemeral: true });
  }

  if (commandName === "refreshspotifytoken" && isOwner) {
    await refreshSpotifyToken();
    await interaction.reply({ content: "Spotify token refreshed.", ephemeral: true });
  }

  if (commandName === "clearcommands" && isOwner) {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [] });
    await interaction.reply({ content: "All slash commands cleared.", ephemeral: true });
  }

  if (commandName === "reloadcommands" && isOwner) {
    await registerCommands();
    await interaction.reply({ content: "Slash commands reloaded.", ephemeral: true });
  }

  if (commandName === "ping") {
    await interaction.reply({ content: `Pong! Latency: ${Date.now() - interaction.createdTimestamp}ms`, ephemeral: true });
  }

  if (commandName === "uptime") {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    await interaction.reply({ content: `Uptime: ${h}h ${m}m ${s}s`, ephemeral: true });
  }

  // === Playback control commands ===
  if (["pause", "resume", "skip", "stop"].includes(commandName)) {
    if (!isOwner) {
      return interaction.reply({ content: "You are not authorized to control playback.", ephemeral: true });
    }
    const token = await getSpotifyAccessToken();
    let endpoint = "";
    let method = "POST";
    if (commandName === "pause" || commandName === "stop") endpoint = "pause";
    if (commandName === "resume") endpoint = "play";
    if (commandName === "skip") endpoint = "next";

    const res = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      await interaction.reply({ content: `Command \`${commandName}\` executed successfully.`, ephemeral: true });
    } else {
      await interaction.reply({ content: `Failed to execute \`${commandName}\`: ${res.status} ${res.statusText}`, ephemeral: true });
    }
  }
});

client.login(DISCORD_TOKEN);
