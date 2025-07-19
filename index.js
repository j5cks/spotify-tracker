import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

if (
  !DISCORD_TOKEN ||
  !GUILD_ID ||
  !CHANNEL_ID ||
  !OWNER_ID ||
  !SPOTIFY_CLIENT_ID ||
  !SPOTIFY_CLIENT_SECRET ||
  !SPOTIFY_REFRESH_TOKEN
) {
  console.error("One or more environment variables are missing.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let spotifyAccessToken = null;
let spotifyAccessTokenExpiresAt = 0;
let lastSpotifyData = null;
let smartCapitals = true;
let updateTimeout;
let currentMessageId = null;
let startTime = Date.now();

function formatSmartCapitals(str) {
  if (!smartCapitals) return str.toLowerCase();
  if (str === str.toUpperCase()) return str;
  return str.toLowerCase();
}

async function refreshSpotifyToken() {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to refresh Spotify token: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  spotifyAccessToken = data.access_token;
  spotifyAccessTokenExpiresAt =
    Date.now() + (data.expires_in || 3600) * 1000 * 0.9;
  return spotifyAccessToken;
}

async function getSpotifyAccessToken() {
  if (!spotifyAccessToken || Date.now() > spotifyAccessTokenExpiresAt) {
    return refreshSpotifyToken();
  }
  return spotifyAccessToken;
}

async function fetchSpotifyData() {
  try {
    const token = await getSpotifyAccessToken();
    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 204) return null;

    if (!res.ok) throw new Error(`Failed to fetch Spotify data: ${res.status}`);

    const data = await res.json();
    if (!data || !data.item) return null;

    const progress_ms = data.progress_ms;
    const duration_ms = data.item.duration_ms;
    const started_at = Date.now() - progress_ms;
    const ends_at = started_at + duration_ms;

    return {
      track: formatSmartCapitals(data.item.name),
      artist: formatSmartCapitals(data.item.artists.map((a) => a.name).join(", ")),
      albumArt: data.item.album.images[0]?.url || null,
      progress_ms,
      duration_ms,
      started_at,
      ends_at,
      is_playing: data.is_playing,
    };
  } catch (err) {
    console.error("Spotify API error:", err);
    return null;
  }
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

  return new EmbedBuilder()
    .setColor("#000000")
    .setTitle("jack is currently listening to")
    .setDescription(`**${data.track}** by **${data.artist}**`)
    .setThumbnail(data.albumArt)
    .addFields(
      {
        name: "Started",
        value: `<t:${Math.floor(data.started_at / 1000)}:t>`,
        inline: true,
      },
      {
        name: "Ends",
        value: `<t:${Math.floor(data.ends_at / 1000)}:t>`,
        inline: true,
      },
      {
        name: "Progress",
        value: `${formatTime(data.progress_ms)} / ${formatTime(data.duration_ms)}`,
        inline: true,
      }
    )
    .setTimestamp();
}

async function updateSpotifyMessage(channel, messageId) {
  const data = await fetchSpotifyData();
  lastSpotifyData = data;

  if (!data) {
    if (messageId) {
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [createEmbed(null)] });
    }
    return;
  }

  let msg;
  if (messageId) {
    msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [createEmbed(data)] });
    else msg = await channel.send({ embeds: [createEmbed(data)] });
  } else {
    msg = await channel.send({ embeds: [createEmbed(data)] });
  }

  currentMessageId = msg.id;
}

function scheduleNextUpdate(channel) {
  const interval = !lastSpotifyData
    ? 15000
    : lastSpotifyData.is_playing
    ? 1000
    : 5000;

  updateTimeout = setTimeout(async () => {
    await updateSpotifyMessage(channel, currentMessageId);
    scheduleNextUpdate(channel);
  }, interval);
}

const commands = [
  new SlashCommandBuilder()
    .setName("spotifystatus")
    .setDescription("Show current Spotify listening status"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip to the next Spotify track"),
  new SlashCommandBuilder()
    .setName("sendspotify")
    .setDescription("Send a new Spotify status embed"),
  new SlashCommandBuilder().setName("info").setDescription("Show bot info"),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: commands.map((cmd) => cmd.toJSON()),
  });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  const channel = await client.channels.fetch(CHANNEL_ID);
  scheduleNextUpdate(channel);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "spotifystatus") {
      const data = await fetchSpotifyData();
      await interaction.reply({ embeds: [createEmbed(data)], ephemeral: true });
    }

    if (interaction.commandName === "sendspotify") {
      const channel = await client.channels.fetch(CHANNEL_ID);
      const msg = await channel.send({ embeds: [createEmbed(lastSpotifyData)] });
      currentMessageId = msg.id;
      await interaction.reply({ content: "New Spotify message sent.", ephemeral: true });
    }

    if (interaction.commandName === "skip") {
      try {
        const token = await getSpotifyAccessToken();
        await fetch("https://api.spotify.com/v1/me/player/next", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        await interaction.reply({ content: "Skipped to the next track.", ephemeral: true });
      } catch (err) {
        await interaction.reply({
          content: "Failed to skip track.",
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "info") {
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const isOnline = client.ws.status === 0 ? "Online" : "Offline";
      const spotifyStatus = spotifyAccessToken ? "Working" : "Disconnected";

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("toggle_smart_capitals")
          .setLabel(
            smartCapitals ? "Turn Smart Capitals Off" : "Turn Smart Capitals On"
          )
          .setStyle(ButtonStyle.Primary)
      );

      const embed = new EmbedBuilder()
        .setTitle("Bot Info")
        .setColor("#000000")
        .addFields(
          { name: "Uptime", value: `<t:${Math.floor(Date.now() / 1000 - uptime)}:R>`, inline: true },
          { name: "Status", value: isOnline, inline: true },
          { name: "Spotify API", value: spotifyStatus, inline: true },
          { name: "Smart Capitals", value: smartCapitals ? "On" : "Off", inline: true }
        );

      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === "toggle_smart_capitals") {
      smartCapitals = !smartCapitals;
      await interaction.reply({
        content: `Smart Capitals are now ${smartCapitals ? "ON" : "OFF"}.`,
        ephemeral: true,
      });
    }
  }
});

client.login(DISCORD_TOKEN);
