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

let storedMessageId = process.env.MESSAGE_ID || null;

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
    const image = spotifyActivity.assets?.largeImage
      ? spotifyActivity.assets.largeImage.replace("spotify:", "https://i.scdn.co/image/")
      : null;

    const startMs = spotifyActivity.timestamps?.start || 0;
    const endMs = spotifyActivity.timestamps?.end || 0;
    const now = Date.now();

    const durationMs = endMs - startMs;
    const progressMs = now - startMs;

    function msToTime(duration) {
      const seconds = Math.floor((duration / 1000) % 60);
      const minutes = Math.floor((duration / (1000 * 60)) % 60);
      return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }

    const duration = durationMs > 0 ? msToTime(durationMs) : "Unknown";
    const progress = progressMs > 0 ? msToTime(progressMs) : "Unknown";

    return { track, artist, image, startMs, endMs, duration, progress };
  } catch (error) {
    console.error("Error fetching Spotify activity:", error);
    return null;
  }
}

function buildEmbed(data) {
  if (!data) {
    return {
      content: "not listening to spotify right now.",
      embeds: [],
    };
  }

  const embed = new EmbedBuilder()
    .setTitle("jack is currently listening to")
    .setColor(0x000000) // black color
    .setAuthor({
      name: "/lowky",
      iconURL:
        "https://cdn.discordapp.com/icons/1388338610884837429/d37930f7bec00e820124afeb55138fc9.webp?size=4096",
    })
    .setDescription(`${data.track} by ${data.artist}`)
    .setImage(data.image || null)
    .addFields(
      {
        name: "Started",
        value: `<t:${Math.floor(data.startMs / 1000)}:t>`,
        inline: true,
      },
      {
        name: "Ends",
        value: `<t:${Math.floor(data.endMs / 1000)}:t>`,
        inline: true,
      },
      {
        name: "Progress",
        value: `${data.progress} / ${data.duration}`,
        inline: true,
      }
    );

  return { embeds: [embed], content: "" };
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
      try {
        const channel = interaction.channel;
        const data = await fetchSpotifyActivity();
        const builtMessage = buildEmbed(data);
        const sentMsg = await channel.send(builtMessage);
        storedMessageId = sentMsg.id;
        await interaction.reply({ content: `Embed message sent and stored with ID: ${storedMessageId}`, ephemeral: true });
      } catch (error) {
        console.error("Error in setembed command:", error);
        if (!interaction.replied) {
          await interaction.reply({ content: `Failed to send embed: ${error.message}`, ephemeral: true });
        }
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
