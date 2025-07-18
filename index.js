import { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch';

const DISCORD_TOKEN = process.env.Discord_token;
const SPOTIFY_CLIENT_ID = process.env.Spotify_client_id;
const SPOTIFY_CLIENT_SECRET = process.env.Spotify_client_secret;
const SPOTIFY_REFRESH_TOKEN = process.env.Spotify_refresh_token;
const CHANNEL_ID = process.env.Channel_id;
const ALLOWED_ROLE_ID = process.env.Allowed_role_id; // your role ID for restricted commands
let storedMessageId = process.env.Message_id || null;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let spotifyAccessToken = null;
let smartCapitalization = true; // default on

function smartLowercase(str) {
  if (!str) return '';
  const letters = str.replace(/[^A-Za-z]/g, '');
  if (letters && letters === letters.toUpperCase()) return str;
  return str.toLowerCase();
}

async function refreshSpotifyToken() {
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh Spotify token: ${response.statusText}`);
  }
  const data = await response.json();
  spotifyAccessToken = data.access_token;
}

async function fetchSpotifyData() {
  if (!spotifyAccessToken) {
    await refreshSpotifyToken();
  }

  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${spotifyAccessToken}` },
  });

  if (res.status === 204) return null; // no content means nothing playing
  if (res.status === 401) {
    // Token expired, refresh and retry once
    await refreshSpotifyToken();
    return fetchSpotifyData();
  }

  if (!res.ok) throw new Error(`Spotify API error: ${res.statusText}`);

  const data = await res.json();
  if (!data.is_playing || !data.item) return null;

  // Build info object
  const track = smartCapitalization
    ? smartLowercase(data.item.name)
    : data.item.name;
  const artist = smartCapitalization
    ? smartLowercase(data.item.artists.map(a => a.name).join(', '))
    : data.item.artists.map(a => a.name).join(', ');

  const startMs = Date.now() - data.progress_ms;
  const endMs = startMs + data.item.duration_ms;

  const progress = formatDuration(data.progress_ms);
  const duration = formatDuration(data.item.duration_ms);

  const image = data.item.album.images[0]?.url || null;

  return { track, artist, startMs, endMs, progress, duration, image };
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function buildEmbed(data) {
  return new EmbedBuilder()
    .setColor('#000000') // black left bar
    .setTitle('jack is currently listening to')
    .setDescription(`${data.track} by ${data.artist}`)
    .addFields(
      { name: 'Started', value: `<t:${Math.floor(data.startMs / 1000)}:t>`, inline: true },
      { name: 'Ends', value: `<t:${Math.floor(data.endMs / 1000)}:t>`, inline: true },
      { name: 'Progress', value: `${data.progress} / ${data.duration}`, inline: true },
    )
    .setImage(data.image);
}

async function updateOrSendMessage(embed) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) {
    console.error('Channel not found');
    return;
  }

  if (storedMessageId) {
    try {
      const msg = await channel.messages.fetch(storedMessageId);
      if (msg) {
        await msg.edit({ embeds: [embed] });
        return;
      }
    } catch {
      // message not found or error - fallback to sending new
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  storedMessageId = msg.id;
}

const commands = [
  new SlashCommandBuilder().setName('testembed').setDescription('Send a test Spotify embed message'),
  new SlashCommandBuilder().setName('restart').setDescription('Restart the bot (logout and login)'),
  new SlashCommandBuilder().setName('setembed').setDescription('Send embed message and store its ID (restricted)'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status and settings'),
  new SlashCommandBuilder()
    .setName('smartcase')
    .setDescription('Toggle smart capitalization on/off')
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('Set smart capitalization mode')
        .setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
        )),
  // Extra commands you wanted:
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback'),
].map(cmd => cmd.toJSON());

async function registerCommands() {
  if (!client.application?.owner) await client.application?.fetch();
  await client.application.commands.set(commands);
  console.log('Slash commands registered');
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  registerCommands();

  updateSpotifyMessage();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const hasRole = interaction.member.roles.cache.has(ALLOWED_ROLE_ID);

  switch (interaction.commandName) {
    case 'testembed': {
      const data = await fetchSpotifyData();
      if (!data) {
        await interaction.reply({ content: 'No Spotify activity found.', ephemeral: true });
        return;
      }
      const embed = buildEmbed(data);
      await interaction.reply({ embeds: [embed] });
      break;
    }
    case 'restart': {
      if (!hasRole) {
        await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        return;
      }
      await interaction.reply({ content: 'Restarting bot...' });
      await client.destroy();
      await client.login(DISCORD_TOKEN);
      break;
    }
    case 'setembed': {
      if (!hasRole) {
        await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        return;
      }
      const data = await fetchSpotifyData();
      if (!data) {
        await interaction.reply({ content: 'No Spotify activity found.', ephemeral: true });
        return;
      }
      const embed = buildEmbed(data);
      const channel = await client.channels.fetch(CHANNEL_ID);
      const msg = await channel.send({ embeds: [embed] });
      storedMessageId = msg.id;
      await interaction.reply({ content: 'Embed message sent and stored.', ephemeral: true });
      break;
    }
    case 'status': {
      const uptimeSeconds = Math.floor(client.uptime / 1000);
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;

      const uptimeString = `${hours}h ${minutes}m ${seconds}s`;
      await interaction.reply({
        content: `🟢 Bot is running\n⏱️ Uptime: ${uptimeString}\n📝 Smart Capitalization: ${smartCapitalization ? 'ON' : 'OFF'}`,
        ephemeral: true,
      });
      break;
    }
    case 'smartcase': {
      if (!hasRole) {
        await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        return;
      }
      const mode = interaction.options.getString('mode');
      smartCapitalization = mode === 'on';
      await interaction.reply({
        content: `Smart Capitalization is now **${smartCapitalization ? 'ON' : 'OFF'}**.`,
        ephemeral: true,
      });
      break;
    }
    // Dummy implementations for skip, pause, stop:
    case 'skip':
    case 'pause':
    case 'stop': {
      await interaction.reply({ content: 'This command is not implemented yet.', ephemeral: true });
      break;
    }
    default:
      break;
  }
});

// Dynamic interval updating Spotify message
let updateInterval = 5000;

async function updateSpotifyMessage() {
  try {
    const spotifyData = await fetchSpotifyData();
    if (!spotifyData) {
      console.log('No Spotify data found.');
      updateInterval = 10000;
    } else {
      const embed = buildEmbed(spotifyData);
      await updateOrSendMessage(embed);

      const now = Date.now();
      const timeLeft = spotifyData.endMs - now;

      updateInterval = Math.min(5000, Math.max(1000, timeLeft));
    }
  } catch (error) {
    console.error('Error updating Spotify message:', error);
    updateInterval = 10000;
  } finally {
    setTimeout(updateSpotifyMessage, updateInterval);
  }
}

client.login(DISCORD_TOKEN);
