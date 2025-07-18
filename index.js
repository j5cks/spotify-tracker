import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DISCORD_TOKEN = process.env.Discord_token;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USER = process.env.LASTFM_USER; // real user, e.g. 'sxftjak'
const LASTFM_DISPLAY_NAME = '6aoi'; // display name in Discord

let smartCapitalization = true; // default ON
let storedMessageId = process.env.MESSAGE_ID || null;

const commands = [
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
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    console.log('Successfully registered application commands.');
  } catch (error) {
    console.error(error);
  }
}

function smartLowercase(str) {
  if (!str) return '';
  const letters = str.replace(/[^A-Za-z]/g, '');
  if (letters && letters === letters.toUpperCase()) {
    return str;
  }
  return str.toLowerCase();
}

async function fetchLastFmRecentTrack() {
  const url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_API_KEY}&format=json&limit=1`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.recenttracks || !data.recenttracks.track || data.recenttracks.track.length === 0) {
      return null;
    }
    const track = data.recenttracks.track[0];
    return {
      name: track.name,
      artist: track.artist['#text'],
      album: track.album['#text'],
      url: track.url,
      nowPlaying: track['@attr']?.nowplaying === 'true',
      date: track.date ? track.date['#text'] : null,
      image: track.image?.length ? track.image[track.image.length - 1]['#text'] : null,
    };
  } catch (e) {
    console.error('Error fetching Last.fm data:', e);
    return null;
  }
}

function buildLastFmEmbed(track) {
  const title = `${LASTFM_DISPLAY_NAME} is currently listening to`;
  const song = track ? `${track.name} by ${track.artist}` : 'No recent track found.';
  const embed = new EmbedBuilder()
    .setColor(0x000000) // black left bar
    .setTitle(title)
    .setDescription(song)
    .setURL(track?.url || null)
    .setTimestamp();

  if (track?.image) {
    embed.setThumbnail(track.image);
  }
  return embed;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  const channel = await client.channels.fetch(CHANNEL_ID);

  async function updateLastFmMessage() {
    const track = await fetchLastFmRecentTrack();
    const embed = buildLastFmEmbed(track);

    if (storedMessageId) {
      try {
        const message = await channel.messages.fetch(storedMessageId);
        await message.edit({ embeds: [embed] });
      } catch {
        // Message missing or deleted, send a new one
        const msg = await channel.send({ embeds: [embed] });
        storedMessageId = msg.id;
        // Optionally save this to your environment/config storage
      }
    } else {
      const msg = await channel.send({ embeds: [embed] });
      storedMessageId = msg.id;
      // Optionally save this to your environment/config storage
    }
  }

  // Update every 30 seconds as a good balance
  updateLastFmMessage();
  setInterval(updateLastFmMessage, 30 * 1000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const hasRole = interaction.member.roles.cache.has(ALLOWED_ROLE_ID);

  switch (interaction.commandName) {
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

    case 'smartcase':
      if (!hasRole) {
        await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        return;
      }
      {
        const mode = interaction.options.getString('mode');
        smartCapitalization = mode === 'on';
        await interaction.reply({
          content: `Smart Capitalization is now **${smartCapitalization ? 'ON' : 'OFF'}**.`,
          ephemeral: true,
        });
      }
      break;
  }
});

client.login(DISCORD_TOKEN);
