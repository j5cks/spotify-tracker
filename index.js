import { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import fetch from "node-fetch";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const CHANNEL_ID = process.env.CHANNEL_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let storedMessageId = process.env.MESSAGE_ID || null;
let smartCapitalization = true;

function smartLowercase(str) {
  if (!str) return "";
  const letters = str.replace(/[^A-Za-z]/g, "");
  if (letters && letters === letters.toUpperCase()) {
    return str;
  }
  return str.toLowerCase();
}

async function refreshAccessToken() {
  const authString = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authString}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });
  const data = await response.json();
  if (data.access_token) return data.access_token;
  throw new Error("Failed to refresh Spotify access token");
}

async function fetchCurrentlyPlaying(accessToken) {
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 204 || res.status === 202) return null; // no content

  if (!res.ok) throw new Error(`Spotify API error: ${res.status}`);

  return res.json();
}

function smartCap(str) {
  return smartCapitalization ? smartLowercase(str) : str;
}

function buildEmbed(data) {
  const {
    trackName,
    artistName,
    albumArt,
    startMs,
    endMs,
    progressMs,
  } = data;

  const durationMs = endMs - startMs || 0;
  const progressSec = Math.floor(progressMs / 1000);
  const durationSec = Math.floor(durationMs / 1000);

  return new EmbedBuilder()
    .setColor("#000000") // black bar on left
    .setTitle("jack is currently listening to")
    .setDescription(`${trackName} by ${artistName}`)
    .setThumbnail(albumArt || null)
    .addFields(
      { name: "started", value: `<t:${Math.floor(startMs / 1000)}:t>`, inline: true },
      { name: "ends", value: `<t:${Math.floor(endMs / 1000)}:t>`, inline: true },
      { name: "progress", value: `${formatDuration(progressSec)} / ${formatDuration(durationSec)}`, inline: true }
    );
}

function formatDuration(seconds) {
  if (isNaN(seconds) || seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

let currentInterval = 5000; // start with 5 sec
let lastTrackId = null;

async function updateSpotifyEmbed() {
  try {
    const accessToken = await refreshAccessToken();
    const playingData = await fetchCurrentlyPlaying(accessToken);

    if (!playingData || !playingData.is_playing) {
      // Optionally clear embed or notify no music
      return;
    }

    const track = playingData.item;
    if (!track) return;

    // If same track as last update, increase interval slightly, else reset
    if (track.id === lastTrackId) {
      currentInterval = Math.min(currentInterval + 1000, 15000); // max 15 sec
    } else {
      currentInterval = 5000; // reset to 5 sec
      lastTrackId = track.id;
    }

    const embedData = {
      trackName: smartCap(track.name),
      artistName: smartCap(track.artists.map(a => a.name).join(", ")),
      albumArt: track.album.images[0]?.url || null,
      startMs: playingData.timestamp - playingData.progress_ms,
      endMs: playingData.timestamp - playingData.progress_ms + track.duration_ms,
      progressMs: playingData.progress_ms,
    };

    const embed = buildEmbed(embedData);

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return console.warn("Channel not found");

    if (storedMessageId) {
      try {
        const message = await channel.messages.fetch(storedMessageId);
        await message.edit({ embeds: [embed] });
      } catch {
        const newMessage = await channel.send({ embeds: [embed] });
        storedMessageId = newMessage.id;
      }
    } else {
      const newMessage = await channel.send({ embeds: [embed] });
      storedMessageId = newMessage.id;
    }

  } catch (error) {
    console.error("Error updating Spotify embed:", error);
    // On error, increase interval to avoid hammering API
    currentInterval = Math.min(currentInterval + 5000, 30000);
  } finally {
    setTimeout(updateSpotifyEmbed, currentInterval);
  }
}

// Slash commands
const commands = [
  new SlashCommandBuilder().setName("testembed").setDescription("Send a test Spotify embed message"),
  new SlashCommandBuilder().setName("restart").setDescription("Restart the bot"),
  new SlashCommandBuilder().setName("status").setDescription("Show bot status and settings"),
  new SlashCommandBuilder()
    .setName("smartcase")
    .setDescription("Toggle smart capitalization on/off")
    .addStringOption(option =>
      option.setName("mode")
        .setDescription("Set smart capitalization mode")
        .setRequired(true)
        .addChoices(
          { name: "on", value: "on" },
          { name: "off", value: "off" },
        )),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song (if you have premium)"),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the currently playing song"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume playback"),
].map(cmd => cmd.toJSON());

async function registerCommands() {
  if (!client.application?.owner) await client.application?.fetch();

  await client.application.commands.set(commands);
  console.log("Slash commands registered");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await registerCommands();

  // Start updating embed
  updateSpotifyEmbed();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) return;

  const hasRole = interaction.member.roles.cache.has(process.env.ALLOWED_ROLE_ID);

  switch (interaction.commandName) {
    case "testembed": {
      if (!hasRole) return interaction.reply({ content: "No permission.", ephemeral: true });

      const embed = buildEmbed({
        trackName: "Test Song",
        artistName: "Test Artist",
        albumArt: null,
        startMs: Date.now(),
        endMs: Date.now() + 180000,
        progressMs: 0,
      });
      await interaction.reply({ embeds: [embed] });
      break;
    }
    case "restart": {
      if (!hasRole) return interaction.reply({ content: "no permission nigga.", ephemeral: true });
      await client.destroy();
      await client.login(BOT_TOKEN);
      await interaction.reply({ content: "bot restarted.", ephemeral: true });
      break;
    }
    case "status": {
      const uptimeSeconds = Math.floor(client.uptime / 1000);
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;

      const uptimeString = `${hours}h ${minutes}m ${seconds}s`;
      await interaction.reply({
        content: `🟢 bot is running\n⏱️ uptime: ${uptimeString}\n📝 smart capitalization: ${smartCapitalization ? "ON" : "OFF"}`,
        ephemeral: true,
      });
      break;
    }
    case "smartcase": {
      if (!hasRole) return interaction.reply({ content: "No permission.", ephemeral: true });
      const mode = interaction.options.getString("mode");
      smartCapitalization = mode === "on";
      await interaction.reply({ content: `Smart Capitalization is now **${smartCapitalization ? "ON" : "OFF"}**.`, ephemeral: true });
      break;
    }
    case "skip": {
      // Implement skipping song with Spotify API if desired (requires premium & more scopes)
      if (!hasRole) return interaction.reply({ content: "No permission.", ephemeral: true });
      await interaction.reply({ content: "Skip command not implemented yet.", ephemeral: true });
      break;
    }
    case "pause": {
      if (!hasRole) return interaction.reply({ content: "No permission.", ephemeral: true });
      await interaction.reply({ content: "Pause command not implemented yet.", ephemeral: true });
      break;
    }
    case "resume": {
      if (!hasRole) return interaction.reply({ content: "No permission.", ephemeral: true });
      await interaction.reply({ content: "Resume command not implemented yet.", ephemeral: true });
      break;
    }
  }
});

client.login(BOT_TOKEN);
