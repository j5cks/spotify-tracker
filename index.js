import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
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
  console.error("Missing environment variables.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let spotifyAccessToken = null;
let spotifyAccessTokenExpiresAt = 0;
let lastSpotifyData = null;
let lastProgressUpdate = Date.now();
let smartCapitals = true;
let updateTimer = null;

function applySmartCapitals(name) {
  if (!smartCapitals) return name;
  if (name === name.toUpperCase()) return name; // keep fully uppercase
  return name.toLowerCase();
}

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
  if (!response.ok) throw new Error(`Failed to refresh Spotify token: ${response.status} ${response.statusText}`);
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

async function fetchSpotifyData() {
  const token = await getSpotifyAccessToken();
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Failed to fetch Spotify data: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data || !data.item) return null;

  const progress_ms = data.progress_ms;
  const duration_ms = data.item.duration_ms;
  const started_at = Date.now() - progress_ms;
  const ends_at = started_at + duration_ms;

  return {
    track: applySmartCapitals(data.item.name),
    artist: applySmartCapitals(data.item.artists.map(a => a.name).join(", ")),
    albumArt: data.item.album.images[0]?.url || null,
    progress_ms,
    duration_ms,
    started_at,
    ends_at,
    is_playing: data.is_playing,
    id: data.item.id
  };
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function createEmbed(data) {
  if (!data) {
    return new EmbedBuilder()
      .setTitle("jack is not listening to anything right now")
      .setColor("#000000");
  }

  const progressFormatted = formatTime(data.progress_ms);
  const durationFormatted = formatTime(data.duration_ms);

  return new EmbedBuilder()
    .setColor("#000000")
    .setTitle("jack is currently listening to")
    .setDescription(`**${data.track}** by **${data.artist}**`)
    .setThumbnail(data.albumArt)
    .addFields(
      { name: "Started", value: `<t:${Math.floor(data.started_at / 1000)}:t>`, inline: true },
      { name: "Ends", value: `<t:${Math.floor(data.ends_at / 1000)}:t>`, inline: true },
      { name: "Progress", value: `${progressFormatted} / ${durationFormatted}`, inline: true }
    )
    .setTimestamp();
}

async function updateSpotifyMessage(channel, messageId) {
  const now = Date.now();
  let data = lastSpotifyData;

  if (!lastSpotifyData || now - lastProgressUpdate >= 5000) {
    data = await fetchSpotifyData();
    lastSpotifyData = data;
    lastProgressUpdate = now;
  } else if (data && data.is_playing) {
    const elapsed = now - lastProgressUpdate;
    data.progress_ms = Math.min(data.progress_ms + elapsed, data.duration_ms);
    lastProgressUpdate = now;
  }

  if (!data) {
    if (messageId) {
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [createEmbed(null)] });
    }
    return messageId;
  }

  let msg;
  if (messageId) {
    msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [createEmbed(data)] });
  } else {
    msg = await channel.send({ embeds: [createEmbed(data)] });
  }
  return msg.id;
}

function scheduleNextUpdate(channel, messageId) {
  if (updateTimer) clearTimeout(updateTimer);
  const interval = !lastSpotifyData
    ? 15000
    : lastSpotifyData.is_playing
      ? 1000
      : 5000;

  updateTimer = setTimeout(async () => {
    const newId = await updateSpotifyMessage(channel, messageId);
    scheduleNextUpdate(channel, newId || messageId);
  }, interval);
}

const commands = [
  new SlashCommandBuilder().setName("spotifystatus").setDescription("Show current Spotify listening status"),
  new SlashCommandBuilder().setName("getspotifytoken").setDescription("Get the current Spotify access token (owner only)"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
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

  if (interaction.commandName === "spotifystatus") {
    const data = await fetchSpotifyData();
    const embed = createEmbed(data);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === "getspotifytoken") {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "No permission.", ephemeral: true });
    }
    if (!spotifyAccessToken) await refreshSpotifyToken();
    await interaction.reply({ content: `Token:\n\`${spotifyAccessToken}\``, ephemeral: true });
  }

  if (interaction.commandName === "skip") {
    try {
      const token = await getSpotifyAccessToken();
      const res = await fetch("https://api.spotify.com/v1/me/player/next", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        await interaction.reply({ content: "⏭ Skipped!", ephemeral: true });
      } else {
        await interaction.reply({ content: `Failed to skip: ${res.status} ${res.statusText}`, ephemeral: true });
      }
    } catch (err) {
      await interaction.reply({ content: `Error: ${err.message}`, ephemeral: true });
    }
  }
});

client.login(DISCORD_TOKEN);
