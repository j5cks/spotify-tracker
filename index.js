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
  PORT = 8080,
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

function smartCase(text) {
  if (!text) return text;
  if (text === text.toUpperCase()) return text; // keep fully uppercase
  return text.toLowerCase();
}

async function refreshSpotifyToken() {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
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
  if (!res.ok) throw new Error(`Failed to fetch Spotify currently playing: ${res.status} ${res.statusText}`);

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

  const progressFormatted = formatTime(data.progress_ms);
  const durationFormatted = formatTime(data.duration_ms);

  return new EmbedBuilder()
    .setColor("#000000")
    .setTitle("jack is currently listening to")
    .setDescription(`**${smartCase(data.track)}** by **${smartCase(data.artist)}**`)
    .setThumbnail(data.albumArt)
    .addFields(
      { name: "Started", value: `<t:${Math.floor(data.started_at / 1000)}:t>`, inline: true },
      { name: "Ends", value: `<t:${Math.floor(data.ends_at / 1000)}:t>`, inline: true },
      { name: "Progress", value: `${progressFormatted} / ${durationFormatted}`, inline: true }
    )
    .setTimestamp();
}

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

async function spotifyControl(action) {
  const token = await getSpotifyAccessToken();
  const url = `https://api.spotify.com/v1/me/player/${action}`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to ${action} track: ${res.status} ${res.statusText}`);
}

const commands = [
  new SlashCommandBuilder().setName("spotifystatus").setDescription("Show current Spotify listening status"),
  new SlashCommandBuilder().setName("getspotifytoken").setDescription("Get the current Spotify access token (owner only)"),
  new SlashCommandBuilder().setName("reloadcommands").setDescription("Remove and re-register all slash commands (owner only)"),
  new SlashCommandBuilder().setName("clearcommands").setDescription("Remove all slash commands from the guild (owner only)"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback (owner only)"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip current track (owner only)"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playback (owner only)")
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  console.log("Registering slash commands...");
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: commands.map(cmd => cmd.toJSON()),
  });
  console.log("Slash commands registered.");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) {
    console.error("Channel not found!");
    process.exit(1);
  }
  scheduleNextUpdate(channel, null);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "spotifystatus") {
    const data = await fetchSpotifyData();
    await interaction.reply({ embeds: [createEmbed(data)], ephemeral: true });
  }

  if (interaction.commandName === "getspotifytoken") {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
    }
    if (!spotifyAccessToken) {
      await refreshSpotifyToken();
    }
    await interaction.reply({ content: `Current Spotify Access Token:\n\`${spotifyAccessToken}\``, ephemeral: true });
  }

  if (interaction.commandName === "reloadcommands" || interaction.commandName === "clearcommands") {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
    }
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    if (interaction.commandName === "clearcommands") {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [] });
      return interaction.reply({ content: "All commands cleared.", ephemeral: true });
    } else {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [] });
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands.map(cmd => cmd.toJSON()) });
      return interaction.reply({ content: "Commands have been reloaded.", ephemeral: true });
    }
  }

  if (interaction.commandName === "pause" || interaction.commandName === "skip" || interaction.commandName === "stop") {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
    }
    try {
      if (interaction.commandName === "pause") await spotifyControl("pause");
      if (interaction.commandName === "skip") await spotifyControl("next");
      if (interaction.commandName === "stop") await spotifyControl("pause");
      await interaction.reply({ content: `Spotify playback ${interaction.commandName} command sent.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `Failed to ${interaction.commandName} track: ${err.message}`, ephemeral: true });
    }
  }
});

client.login(DISCORD_TOKEN);
