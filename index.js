import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import fetch from 'node-fetch';

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // Discord channel ID for updates

// Function to get a new access token using the refresh token
async function getAccessToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', SPOTIFY_REFRESH_TOKEN);
  params.append('client_id', SPOTIFY_CLIENT_ID);
  params.append('client_secret', SPOTIFY_CLIENT_SECRET);

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    body: params
  });

  if (!res.ok) {
    console.error('Failed to get access token:', await res.text());
    return null;
  }

  const data = await res.json();
  return data.access_token;
}

// Function to get currently playing track
async function getCurrentTrack(accessToken) {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (res.status === 204 || res.status === 202) return null; // no content, not playing
  if (!res.ok) {
    console.error('Error fetching current track:', await res.text());
    return null;
  }

  return await res.json();
}

function buildEmbed(trackData) {
  if (!trackData || !trackData.item) {
    return new EmbedBuilder()
      .setColor('#000000')
      .setTitle('Not playing anything')
      .setDescription('Spotify is currently idle.')
      .setTimestamp();
  }

  const track = trackData.item;
  const artists = track.artists.map(artist => artist.name).join(', ');
  const title = track.name;
  const album = track.album.name;
  const cover = track.album.images[0]?.url;

  return new EmbedBuilder()
    .setColor('#000000')
    .setTitle(title.toLowerCase())
    .setURL(track.external_urls.spotify)
    .setAuthor({ name: artists.toLowerCase() })
    .setDescription(`Album: ${album.toLowerCase()}`)
    .setThumbnail(cover)
    .setTimestamp();
}

let lastMessageId = null;

async function updateSpotifyStatus() {
  const accessToken = await getAccessToken();
  if (!accessToken) return;

  const trackData = await getCurrentTrack(accessToken);
  const embed = buildEmbed(trackData);

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) {
    console.error('Channel not found');
    return;
  }

  try {
    if (lastMessageId) {
      // Try to edit last message
      const lastMessage = await channel.messages.fetch(lastMessageId);
      await lastMessage.edit({ embeds: [embed] });
    } else {
      // Send new message
      const msg = await channel.send({ embeds: [embed] });
      lastMessageId = msg.id;
    }
  } catch (error) {
    console.error('Failed to send or edit message:', error);
  }
}

client.once('ready', () => {
  console.log('Bot is online!');

  // Update immediately and then every 60 seconds
  updateSpotifyStatus();
  setInterval(updateSpotifyStatus, 60_000);
});

client.login(DISCORD_TOKEN);
