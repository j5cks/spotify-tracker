import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const USER_ID = process.env.USER_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ALLOWED_ROLE_ID = "1388340520128086182";

let storedMessageId = process.env.MESSAGE_ID || null; // fallback if you want

const embedTemplate = `{
  "title": "currently listening",
  "description": "**{track}**\\nby **{artist}**\\nAlbum: {album}\\n[Open in Spotify]({url})",
  "color": 1752220,
  "author": {
    "name": "/lowky",
    "url": "https://cdn.discordapp.com/icons/1388338610884837429/d37930f7bec00e820124afeb55138fc9.webp?size=4096"
  },
  "image": {
    "url": "{image}"
  },
  "footer": {
    "text": "Started: {start} | Ends: {end} | {progress}/{duration}"
  }
}`;

function msToTime(duration) {
  const seconds = Math.floor((duration / 1000) % 60);
  const minutes = Math.floor((duration / (1000 * 60)) % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function timestampToDiscord(ts) {
  const unixSeconds = Math.floor(ts / 1000);
  return `<t:${unixSeconds}:t>`;
}

async function fetchSpotifyActivity() {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !channel.guild) {
      console.log("Channel or guild not found");
      return null;
    }
    const guild = channel.guild;
    const member = await guild.members.fetch(USER_ID);

    const spotifyActivity = member.presence?.activities.find(
      (a) => a.name === "Spotify" && a.type === 2
    );

    if (!spotifyActivity) return null;

    const track = spotifyActivity.details || "Unknown Track";
    const artist = spotifyActivity.state || "Unknown Artist";
    const album = spotifyActivity.assets?.largeText || "Unknown Album";
    const url = `https://open.spotify.com/track/${spotifyActivity.syncId}`;
    const image = spotifyActivity.assets?.largeImage
      ? spotifyActivity.assets.largeImage.replace("spotify:", "https://i.scdn.co/image/")
      : null;

    const startMs = spotifyActivity.timestamps?.start || 0;
    const endMs = spotifyActivity.timestamps?.end || 0;
    const now = Date.now();

    const start = startMs ? timestampToDiscord(startMs) : "Unknown";
    const end = endMs ? timestampToDiscord(endMs) : "Unknown";
    const durationMs = endMs - startMs;
    const progressMs = now - startMs;

    const duration = durationMs > 0 ? msToTime(durationMs) : "Unknown";
    const progress = progressMs > 0 ? msToTime(progressMs) : "Unknown";

    return { track, artist, album, url, image, start, end, duration, progress };
  } catch (error) {
    console.error("Error fetching Spotify activity:", error);
    return null;
  }
}

function buildEmbed(data) {
  if (!data) {
    return {
      content: "Not listening to Spotify right now.",
      embeds: [],
    };
  }
  let embedJson = embedTemplate
    .replace(/{track}/g, data.track)
    .replace(/{artist}/g, data.artist)
    .replace(/{album}/g, data.album)
    .replace(/{url}/g, data.url)
    .replace(/{image}/g, data.image || "")
    .replace(/{start}/g, data.start)
    .replace(/{end}/g, data.end)
    .replace(/{duration}/g, data.duration)
    .replace(/{progress}/g, data.progress);

  const embedData = JSON.parse(embedJson);
  const embed = EmbedBuilder.from(embedData);
  return { content: "", embeds: [embed] };
}

async function updateSpotifyStatus() {
  if (!storedMessageId) {
    console.log("No message ID stored, cannot update.");
    return;
  }
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.log("Channel not found");
      return;
    }
    const message = await channel.messages.fetch(storedMessageId);
    if (!message) {
      console.log("Message to update not found");
      return;
    }
    const data = await fetchSpotifyActivity();
    const updatedMessage = buildEmbed(data);
    await message.edit(updatedMessage);
  } catch (err) {
    console.error("Error updating status:", err);
  }
}

let updateInterval = null;
async function startUpdating(intervalMs = 15000) {
  if (updateInterval) return;
  await updateSpotifyStatus();
  updateInterval = setInterval(updateSpotifyStatus, intervalMs);
  console.log("Started auto-updating Spotify status.");
}

function stopUpdating() {
  if (!updateInterval) return;
  clearInterval(updateInterval);
  updateInterval = null;
  console.log("Stopped auto-updating Spotify status.");
}

const commands = [
  new SlashCommandBuilder().setName("refresh").setDescription("Refresh the Spotify embed now"),
  new SlashCommandBuilder().setName("start").setDescription("Start auto-updating Spotify status"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop auto-updating Spotify status"),
  new SlashCommandBuilder().setName("testembed").setDescription("Send a test Spotify embed message"),
  new SlashCommandBuilder().setName("restart").setDescription("Restart the bot (logout and login)"),
  new SlashCommandBuilder().setName("setembed").setDescription("Send embed message and store its ID (restricted)"),
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log("Slash commands registered.");
  } catch (error) {
    console.error(error);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();

  startUpdating();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  const memberRoles = interaction.member.roles.cache;
  const hasRole = memberRoles.has(ALLOWED_ROLE_ID);

  switch (interaction.commandName) {
    case "setembed":
      if (!hasRole) {
        await interaction.reply({ content: "You do not have permission to use this command.", ephemeral: true });
        return;
      }

      // Send embed message and save message ID
      {
        const channel = interaction.channel;
        const data = await fetchSpotifyActivity();
        const builtMessage = buildEmbed(data);
        const sentMsg = await channel.send(builtMessage);
        storedMessageId = sentMsg.id;

        await interaction.reply({ content: `Embed message sent and stored with ID: ${storedMessageId}`, ephemeral: true });
      }
      break;

    case "refresh":
      if (!storedMessageId) {
        await interaction.reply({ content: "Embed message ID is not set. Use /setembed first.", ephemeral: true });
        return;
      }
      await updateSpotifyStatus();
      await interaction.reply({ content: "Spotify embed refreshed.", ephemeral: true });
      break;

    case "start":
      startUpdating();
      await interaction.reply({ content: "Started auto-updating Spotify status.", ephemeral: true });
      break;

    case "stop":
      stopUpdating();
      await interaction.reply({ content: "Stopped auto-updating Spotify status.", ephemeral: true });
      break;

    case "testembed": {
      const data = await fetchSpotifyActivity();
      const builtMessage = buildEmbed(data);

      const channel = interaction.channel;
      await channel.send(builtMessage);

      await interaction.reply({ content: "Test embed sent!", ephemeral: true });
      break;
    }

    case "restart":
      await interaction.reply({ content: "Restarting bot...", ephemeral: true });
      stopUpdating();
      await client.destroy();
      await client.login(process.env.BOT_TOKEN);
      break;
  }
});

client.login(process.env.BOT_TOKEN);
