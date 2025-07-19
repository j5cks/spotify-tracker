import { 
  Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionType 
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
let spotifyApiWorking = false;
let updateTimeout;

let smartCapitals = false; // Smart capitals mode, default off

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
    spotifyApiWorking = false;
    throw new Error(`Failed to refresh Spotify token: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  spotifyAccessToken = data.access_token;
  spotifyAccessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000 * 0.9;
  spotifyApiWorking = true;
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

    if (res.status === 204) {
      spotifyApiWorking = true;
      return null; // No content, nothing playing
    }

    if (!res.ok) {
      spotifyApiWorking = false;
      throw new Error(`Failed to fetch Spotify currently playing: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    if (!data || !data.item) return null;

    const progress_ms = data.progress_ms;
    const duration_ms = data.item.duration_ms;
    const started_at = Date.now() - progress_ms;
    const ends_at = started_at + duration_ms;

    spotifyApiWorking = true;

    return {
      track: data.item.name,
      artist: data.item.artists.map(a => a.name).join(", "),
      albumArt: data.item.album.images[0]?.url || null,
      progress_ms,
      duration_ms,
      started_at,
      ends_at,
      is_playing: data.is_playing,
      spotify_url: data.item.external_urls.spotify,
    };
  } catch (error) {
    spotifyApiWorking = false;
    throw error;
  }
}

function applySmartCapitals(text) {
  // If text is all uppercase, keep as is
  if (text.toUpperCase() === text) return text;
  // else lowercase all words (or lowercase whole string as you want)
  return text.toLowerCase();
}

function createSpotifyEmbed(data) {
  if (!data) {
    return new EmbedBuilder()
      .setTitle("jack is not listening to anything right now")
      .setColor("#000000");
  }

  // format progress times as mm:ss
  const formatTime = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const progressFormatted = formatTime(data.progress_ms);
  const durationFormatted = formatTime(data.duration_ms);

  return new EmbedBuilder()
    .setColor("#000000") // Black bar on left
    .setTitle("jack is currently listening to")
    .setDescription(`**${applySmartCapitals(data.track)}** by **${applySmartCapitals(data.artist)}**`)
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
        if (msg) await msg.edit({ embeds: [createSpotifyEmbed(null)] });
      }
      return;
    }

    lastSpotifyData = data;

    let msg;
    if (messageId) {
      msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [createSpotifyEmbed(data)] });
      } else {
        msg = await channel.send({ embeds: [createSpotifyEmbed(data)] });
      }
    } else {
      msg = await channel.send({ embeds: [createSpotifyEmbed(data)] });
    }
    return msg.id;
  } catch (err) {
    console.error("Error updating Spotify message:", err);
  }
}

function scheduleNextUpdate(channel, messageId) {
  let interval;
  if (!lastSpotifyData || !lastSpotifyData.is_playing) {
    interval = 15000; // 15 seconds if not playing
  } else {
    interval = 5000; // 5 seconds if playing
  }
  updateTimeout = setTimeout(async () => {
    const newMessageId = await updateSpotifyMessage(channel, messageId);
    scheduleNextUpdate(channel, newMessageId || messageId);
  }, interval);
}

const commands = [
  new SlashCommandBuilder()
    .setName("spotifystatus")
    .setDescription("Show current Spotify listening status"),
  new SlashCommandBuilder()
    .setName("getspotifytoken")
    .setDescription("Get the current Spotify access token (owner only)"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip to the next Spotify track (owner only)"),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the Spotify playback (owner only)"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the Spotify playback (owner only)"),
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("Show bot info and toggle smart capitals"),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands.map(cmd => cmd.toJSON()),
    });
    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
}

async function skipTrack() {
  try {
    const token = await getSpotifyAccessToken();

    const res = await fetch("https://api.spotify.com/v1/me/player/next", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Failed to skip track: ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error("Failed to skip track:", err);
  }
}

async function pausePlayback() {
  try {
    const token = await getSpotifyAccessToken();

    const res = await fetch("https://api.spotify.com/v1/me/player/pause", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Failed to pause playback: ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error("Failed to pause playback:", err);
  }
}

async function stopPlayback() {
  try {
    const token = await getSpotifyAccessToken();

    // Spotify API doesn't have a 'stop' endpoint, so we pause and seek to start
    let res = await fetch("https://api.spotify.com/v1/me/player/pause", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Failed to pause playback: ${res.status} ${res.statusText}`);

    res = await fetch("https://api.spotify.com/v1/me/player/seek?position_ms=0", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Failed to seek playback: ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error("Failed to stop playback:", err);
  }
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
  if (interaction.type === InteractionType.ApplicationCommand) {
    const { commandName } = interaction;

    if (commandName === "spotifystatus") {
      const data = await fetchSpotifyData();
      const embed = createSpotifyEmbed(data);
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === "getspotifytoken") {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
      }
      if (!spotifyAccessToken) {
        await refreshSpotifyToken();
      }
      await interaction.reply({ content: `Current Spotify Access Token:\n\`${spotifyAccessToken}\``, ephemeral: true });
    }

    if (commandName === "skip") {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
      }
      await skipTrack();
      await interaction.reply({ content: "Skipped to next track.", ephemeral: true });
    }

    if (commandName === "pause") {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
      }
      await pausePlayback();
      await interaction.reply({ content: "Playback paused.", ephemeral: true });
    }

    if (commandName === "stop") {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
      }
      await stopPlayback();
      await interaction.reply({ content: "Playback stopped and reset.", ephemeral: true });
    }

    if (commandName === "info") {
      const uptimeSeconds = Math.floor(process.uptime());
      const uptimeString = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`;
      const embed = new EmbedBuilder()
        .setTitle("bot info")
        .addFields(
          { name: "smart capitals", value: smartCapitals ? "on" : "off", inline: true },
          { name: "uptime", value: uptimeString, inline: true },
          { name: "spotify api", value: spotifyApiWorking ? "online" : "offline", inline: true }
        )
        .setColor("#000000")
        .setTimestamp();

      const toggleButton = new ButtonBuilder()
        .setCustomId("toggleSmartCaps")
        .setLabel(smartCapitals ? "Turn Smart Capitals OFF" : "Turn Smart Capitals ON")
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(toggleButton);

      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === "toggleSmartCaps") {
      smartCapitals = !smartCapitals;
      const uptimeSeconds = Math.floor(process.uptime());
      const uptimeString = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`;

      const embed = new EmbedBuilder()
        .setTitle("bot info")
        .addFields(
          { name: "smart capitals", value: smartCapitals ? "on" : "off", inline: true },
          { name: "uptime", value: uptimeString, inline: true },
          { name: "spotify api", value: spotifyApiWorking ? "online" : "offline", inline: true }
        )
        .setColor("#000000")
        .setTimestamp();

      const toggleButton = new ButtonBuilder()
        .setCustomId("toggleSmartCaps")
        .setLabel(smartCapitals ? "Turn Smart Capitals OFF" : "Turn Smart Capitals ON")
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(toggleButton);

      await interaction.update({ embeds: [embed], components: [row] });
    }
  }
});

client.login(DISCORD_TOKEN);
