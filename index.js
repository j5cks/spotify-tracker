import { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  REST, 
  Routes, 
  SlashCommandBuilder 
} from "discord.js";
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
let messageId = null;
let mainUpdateTimeout;
let progressUpdateInterval;

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

async function fetchSpotifyData() {
  const token = await getSpotifyAccessToken();

  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 204) return null;

  if (!res.ok) {
    throw new Error(`Failed to fetch Spotify currently playing: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (!data || !data.item) return null;

  const progress_ms = data.progress_ms;
  const duration_ms = data.item.duration_ms;
  const started_at = Date.now() - progress_ms;
  const ends_at = started_at + duration_ms;

  return {
    track: data.item.name,
    artist: data.item.artists.map(a => a.name).join(", "),
    albumArt: data.item.album.images[0]?.url || null,
    progress_ms,
    duration_ms,
    started_at,
    ends_at,
    is_playing: data.is_playing,
  };
}

function formatTrackTitle(title) {
  if (title === title.toUpperCase()) return title; 
  return title.toLowerCase();
}

function createEmbed(data, progressOverride = null) {
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

  const currentProgress = progressOverride !== null ? progressOverride : data.progress_ms;
  const progressFormatted = formatTime(currentProgress);
  const durationFormatted = formatTime(data.duration_ms);

  return new EmbedBuilder()
    .setColor("#000000")
    .setTitle("jack is currently listening to")
    .setDescription(`**${formatTrackTitle(data.track)}** by **${data.artist}**`)
    .setThumbnail(data.albumArt)
    .addFields(
      { name: "Started", value: `<t:${Math.floor(data.started_at / 1000)}:t>`, inline: true },
      { name: "Ends", value: `<t:${Math.floor(data.ends_at / 1000)}:t>`, inline: true },
      { name: "Progress", value: `${progressFormatted} / ${durationFormatted}`, inline: true }
    )
    .setTimestamp();
}

async function updateSpotifyMessage(channel) {
  try {
    const data = await fetchSpotifyData();
    if (!data) {
      lastSpotifyData = null;
      clearInterval(progressUpdateInterval);
      const msg = messageId ? await channel.messages.fetch(messageId).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [createEmbed(null)] });
      else {
        const newMsg = await channel.send({ embeds: [createEmbed(null)] });
        messageId = newMsg.id;
      }
      scheduleNextUpdate(channel);
      return;
    }

    const sameTrack = lastSpotifyData && lastSpotifyData.track === data.track && lastSpotifyData.artist === data.artist;

    lastSpotifyData = data;

    let msg = messageId ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [createEmbed(data)] });
    else {
      msg = await channel.send({ embeds: [createEmbed(data)] });
      messageId = msg.id;
    }

    clearInterval(progressUpdateInterval);
    progressUpdateInterval = setInterval(async () => {
      if (!lastSpotifyData) return;
      const now = Date.now();
      const newProgress = now - lastSpotifyData.started_at;
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [createEmbed(lastSpotifyData, newProgress)] });
    }, 1000);

    scheduleNextUpdate(channel, sameTrack ? 5000 : 15000);
  } catch (err) {
    console.error("Error updating Spotify message:", err);
  }
}

function scheduleNextUpdate(channel, interval = 15000) {
  clearTimeout(mainUpdateTimeout);
  mainUpdateTimeout = setTimeout(() => updateSpotifyMessage(channel), interval);
}

const commands = [
  new SlashCommandBuilder().setName("spotifystatus").setDescription("Show current Spotify listening status"),
  new SlashCommandBuilder().setName("getspotifytoken").setDescription("Get the current Spotify access token (owner only)"),
  new SlashCommandBuilder().setName("clearcommands").setDescription("Clear all registered slash commands (owner only)"),
  new SlashCommandBuilder().setName("fixcommands").setDescription("Re-register missing slash commands (owner only)"),
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
  scheduleNextUpdate(channel);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "spotifystatus") {
    const data = await fetchSpotifyData();
    await interaction.reply({ embeds: [createEmbed(data)], ephemeral: true });
  }

  if (interaction.commandName === "getspotifytoken") {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "You do not have permission.", ephemeral: true });
    if (!spotifyAccessToken) await refreshSpotifyToken();
    await interaction.reply({ content: `Spotify Access Token:\n\`${spotifyAccessToken}\``, ephemeral: true });
  }

  if (interaction.commandName === "clearcommands") {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "You do not have permission.", ephemeral: true });
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [] });
    await interaction.reply({ content: "All commands cleared.", ephemeral: true });
  }

  if (interaction.commandName === "fixcommands") {
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "You do not have permission.", ephemeral: true });
    await registerCommands();
    await interaction.reply({ content: "Commands fixed and re-registered.", ephemeral: true });
  }
});

client.login(DISCORD_TOKEN);
