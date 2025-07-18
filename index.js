import { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import fetch from "node-fetch";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const DISCORD_TOKEN = process.env.BOT_TOKEN;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

let storedMessageId = null;
let smartCapitalization = true;
let autoUpdates = true;

function smartLowercase(str) {
  if (!str) return "";
  const letters = str.replace(/[^A-Za-z]/g, "");
  if (letters && letters === letters.toUpperCase()) {
    return str;
  }
  return str.toLowerCase();
}

async function getAccessToken() {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });
  const data = await response.json();
  return data.access_token;
}

async function fetchSpotifyCurrentlyPlaying() {
  const token = await getAccessToken();
  const response = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 204 || response.status > 400) return null;
  const data = await response.json();

  if (!data.is_playing) return null;

  const trackRaw = data.item.name;
  const artistRaw = data.item.artists.map(a => a.name).join(", ");
  const track = smartCapitalization ? smartLowercase(trackRaw) : trackRaw;
  const artist = smartCapitalization ? smartLowercase(artistRaw) : artistRaw;

  const startMs = Date.now() - data.progress_ms;
  const endMs = startMs + data.item.duration_ms;

  return {
    track,
    artist,
    image: data.item.album.images[0]?.url,
    startMs,
    endMs,
    progress: formatDuration(data.progress_ms),
    duration: formatDuration(data.item.duration_ms),
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function buildEmbed(data) {
  return new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle(`${data.track} — ${data.artist}`)
    .setDescription(`Jack is currently listening to:`)
    .setImage(data.image || null)
    .addFields(
      { name: "started", value: `<t:${Math.floor(data.startMs / 1000)}:t>`, inline: true },
      { name: "ends", value: `<t:${Math.floor(data.endMs / 1000)}:t>`, inline: true },
      { name: "progress", value: `${data.progress} / ${data.duration}`, inline: true }
    )
    .setTimestamp();
}

async function updateEmbed() {
  if (!autoUpdates) return;
  const channel = await client.channels.fetch(CHANNEL_ID);
  const data = await fetchSpotifyCurrentlyPlaying();

  if (!data) return;

  const embed = buildEmbed(data);

  if (storedMessageId) {
    try {
      const message = await channel.messages.fetch(storedMessageId);
      await message.edit({ embeds: [embed] });
      return;
    } catch {
      storedMessageId = null;
    }
  }

  const sent = await channel.send({ embeds: [embed] });
  storedMessageId = sent.id;
}

setInterval(updateEmbed, 15000); // Update every 15 seconds

const commands = [
  new SlashCommandBuilder().setName("testembed").setDescription("Send a test Spotify embed message"),
  new SlashCommandBuilder().setName("restart").setDescription("Restart the bot (logout and login)"),
  new SlashCommandBuilder().setName("setembed").setDescription("Send embed message and store its ID"),
  new SlashCommandBuilder().setName("status").setDescription("Show bot status and settings"),
  new SlashCommandBuilder()
    .setName("smartcase")
    .setDescription("Toggle smart capitalization on/off")
    .addStringOption(option =>
      option.setName("mode")
        .setDescription("Set smart capitalization mode")
        .setRequired(true)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })),
  new SlashCommandBuilder().setName("trackinfo").setDescription("Show detailed info about the current track"),
  new SlashCommandBuilder().setName("recent").setDescription("Show your most recently played tracks"),
  new SlashCommandBuilder().setName("toggleupdates").setDescription("Toggle automatic embed updates on/off"),
].map(command => command.toJSON());

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "testembed":
      {
        const data = await fetchSpotifyCurrentlyPlaying();
        if (!data) {
          await interaction.reply({ content: "No track is currently playing.", ephemeral: true });
          return;
        }
        const embed = buildEmbed(data);
        await interaction.reply({ embeds: [embed] });
      }
      break;

    case "restart":
      await interaction.reply({ content: "Restarting bot...", ephemeral: true });
      await client.destroy();
      await client.login(DISCORD_TOKEN);
      break;

    case "setembed":
      {
        const data = await fetchSpotifyCurrentlyPlaying();
        if (!data) {
          await interaction.reply({ content: "No track is currently playing.", ephemeral: true });
          return;
        }
        const channel = await client.channels.fetch(CHANNEL_ID);
        const embed = buildEmbed(data);
        const sent = await channel.send({ embeds: [embed] });
        storedMessageId = sent.id;
        await interaction.reply({ content: "Embed sent and stored.", ephemeral: true });
      }
      break;

    case "status":
      {
        const uptimeSeconds = Math.floor(client.uptime / 1000);
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const seconds = uptimeSeconds % 60;
        const uptimeString = `${hours}h ${minutes}m ${seconds}s`;

        await interaction.reply({
          content: `🟢 Bot is running\n⏱️ Uptime: ${uptimeString}\n📝 Smart Capitalization: ${smartCapitalization ? "ON" : "OFF"}\n🔄 Auto-updates: ${autoUpdates ? "ON" : "OFF"}`,
          ephemeral: true,
        });
      }
      break;

    case "smartcase":
      {
        const mode = interaction.options.getString("mode");
        smartCapitalization = mode === "on";
        await interaction.reply({
          content: `Smart Capitalization is now **${smartCapitalization ? "ON" : "OFF"}**.`,
          ephemeral: true,
        });
      }
      break;

    case "toggleupdates":
      autoUpdates = !autoUpdates;
      await interaction.reply({ content: `Auto-updates are now **${autoUpdates ? "ON" : "OFF"}**.`, ephemeral: true });
      break;

    case "trackinfo":
      {
        const token = await getAccessToken();
        const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 204) {
          await interaction.reply({ content: "No track is currently playing.", ephemeral: true });
          return;
        }
        const data = await res.json();
        await interaction.reply({
          content: `🎵 **${data.item.name}** by ${data.item.artists.map(a => a.name).join(", ")}\nAlbum: ${data.item.album.name}\nExplicit: ${data.item.explicit ? "Yes" : "No"}\nPopularity: ${data.item.popularity}`,
          ephemeral: true,
        });
      }
      break;

    case "recent":
      {
        const token = await getAccessToken();
        const res = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=5", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const tracks = data.items.map(t => `${t.track.name} — ${t.track.artists.map(a => a.name).join(", ")}`).join("\n");
        await interaction.reply({ content: `**Recently played:**\n${tracks}`, ephemeral: true });
      }
      break;
  }
});

client.login(DISCORD_TOKEN);
