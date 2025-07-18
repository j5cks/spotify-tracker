import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Discord Application Client ID
const GUILD_ID = process.env.GUILD_ID; // Your Discord server ID for slash commands
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID; // Channel to send embed updates
const STATUS_MESSAGE_ID = process.env.STATUS_MESSAGE_ID; // Message ID to edit

// Function to get a new Spotify access token using refresh token
async function getSpotifyAccessToken() {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: SPOTIFY_REFRESH_TOKEN
    })
  });

  const data = await response.json();
  if (data.access_token) return data.access_token;
  throw new Error('Failed to get Spotify access token');
}

// Function to get current playback info from Spotify
async function getCurrentPlayback(accessToken) {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.status === 204 || res.status > 400) return null; // No content or error
  return await res.json();
}

// Build embed with the same style you requested
function buildEmbed(track) {
  if (!track) {
    return new EmbedBuilder()
      .setColor('#000000')
      .setTitle('jack is currently not listening to anything')
      .setTimestamp();
  }

  const songName = track.item.name.toLowerCase();
  const artists = track.item.artists.map(a => a.name.toLowerCase()).join(', ');
  const durationMs = track.item.duration_ms;
  const progressMs = track.progress_ms;
  const progressPercent = Math.floor((progressMs / durationMs) * 100);
  const albumImage = track.item.album.images[0]?.url || null;

  return new EmbedBuilder()
    .setColor('#000000')
    .setTitle(`${songName} by ${artists}`)
    .setThumbnail(albumImage)
    .addFields(
      { name: 'Progress', value: `${progressPercent}%`, inline: true },
      { name: 'Duration', value: `${Math.floor(durationMs / 60000)}:${String(Math.floor((durationMs % 60000) / 1000)).padStart(2, '0')}`, inline: true }
    )
    .setTimestamp();
}

// Slash commands to test and refresh status
const commands = [
  new SlashCommandBuilder().setName('status').setDescription('Show Spotify listening status'),
  new SlashCommandBuilder().setName('refresh').setDescription('Refresh Spotify status'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await registerCommands();
  updateStatusLoop();
});

// Function to update or send the status message embed
async function updateStatus() {
  try {
    const accessToken = await getSpotifyAccessToken();
    const playback = await getCurrentPlayback(accessToken);

    const channel = await client.channels.fetch(STATUS_CHANNEL_ID);
    if (!channel) return;

    let message;
    try {
      message = await channel.messages.fetch(STATUS_MESSAGE_ID);
    } catch {
      // If no message, send new and store ID
      message = await channel.send({ embeds: [buildEmbed(playback)] });
      console.log('New status message sent, update your STATUS_MESSAGE_ID env var with:', message.id);
      return;
    }

    await message.edit({ embeds: [buildEmbed(playback)] });
  } catch (err) {
    console.error('Error updating status:', err);
  }
}

// Loop updater every 1 min (adjust as you want)
function updateStatusLoop() {
  updateStatus();
  setInterval(updateStatus, 60 * 1000);
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'status') {
    const accessToken = await getSpotifyAccessToken();
    const playback = await getCurrentPlayback(accessToken);
    await interaction.reply({ embeds: [buildEmbed(playback)], ephemeral: true });
  } else if (interaction.commandName === 'refresh') {
    await updateStatus();
    await interaction.reply({ content: 'Spotify status refreshed!', ephemeral: true });
  }
});

client.login(DISCORD_TOKEN);
