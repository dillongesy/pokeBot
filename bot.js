require('dotenv').config({ path: './dotenv.env' });

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pokemon.db');
const dbUser = new sqlite3.Database('./user.db');

const token = process.env.DISCORD_TOKEN;

const {
	Client,
	GatewayIntentBits,
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	InteractionCollector, //Check if needed
} = require('discord.js');

const myUserID = '177580797165961216';

const Discord = require('discord.js');
const client = new Client({
  intents: [
    GatewayIntentBits.GuildMessages,
	GatewayIntentBits.Guilds,
	GatewayIntentBits.MessageContent,
  ],
});

//NEW
const cooldowns = new Map(); 	//Map<serverId, cooldownEnd>
const activeDrops = new Map();	//Map<serverId, activePokemon>
//NOTNEW

/*
let curMon = "";
let messageCount = 0;
const cooldowns = new Map();*/

function generatePartyEmbed(pokemonList, page, pageSize) {
	const start = page * pageSize;
	const end = start + pageSize;
	const pagePokemon = pokemonList.slice(start, end);
	
	const formattedPokemonList = pagePokemon.map((pokemon, index) => `\`\`${start + index + 1}\`\`\t${pokemon}`).join('\n');
	
	const embed = new EmbedBuilder()
		.setColor('#0099ff')
		.setTitle('Your Pokémon')
		.setDescription(formattedPokemonList || 'No Pokémon Found')
		.setFooter({ text: `Showing ${start + 1}-${end > pokemonList.length ? pokemonList.length : end} of ${pokemonList.length} Pokémon` })
		.setTimestamp();
		
	return embed;
}

client.on('ready', () => {
	console.log(`Logged in as ${client.user.tag}`);
	dbUser.run("CREATE TABLE IF NOT EXISTS user ( user_id TEXT PRIMARY KEY, caught_pokemon TEXT)");
});

client.on('messageCreate', (message) => {
	if (!message.author.bot) {
		if (message.content.length > 0) {
			/*messageCount = Math.random(); */
			const serverId = message.guild.id;
			const userId = message.author.id;
			const now = Date.now();
			//console.log('Message math: ', messageCount, 'from: ', message.author.tag, 'Message: ', message.content);
			if (message.content.startsWith('.d')) {//message.content[0] == '.' && message.content[1] == 'd') {
				/* const now = Date.now(); */
				if (cooldowns.has(userId)) {
					const cooldownEnd = Math.floor(cooldowns.get(userId) / 1000);
					message.channel.send(`Please wait <t:${cooldownEnd}:R> before using this command again.`);
					return;
				}
				const cooldownEnd = now + 300000;
				cooldowns.set(userId, cooldownEnd);
                setTimeout(() => cooldowns.delete(userId), 300000);
				
				const messageCount = Math.random();
				const randPokemon = Math.floor(messageCount * 386); //number x is max pokedex entry //THIS LINE
				db.all("SELECT * FROM pokemon", [], (err, rows) => {
					if (err) {
						console.error(err.message);
						message.channel.send('An error occurred while fetching the Pokémon.');
						return;
					}
					if (rows.length > 0) {
						const pokemon = rows[randPokemon];
						const type2 = pokemon.type2 ? ` / ${pokemon.type2}` : '';
						const curMon = pokemon.name ? `${pokemon.name}` : '';
						console.log(curMon);
						
						activeDrops.set(serverId, curMon);
						
						const embed = new EmbedBuilder()
							.setColor('#0099ff')
							//.setTitle(`Name: ${pokemon.name}`)
							.addFields(
								{ name: 'Dex Number', value: `${pokemon.dexNum}`, inline: true },
								{ name: 'Type', value: `${pokemon.type1}${type2}`, inline: true },
								{ name: 'Region', value: `${pokemon.region}`, inline: true }
							)
							.setImage(pokemon.imageLink)
							.setTimestamp()

						message.channel.send({ embeds: [embed] });
					} 
					else {
						message.channel.send('No Pokémon found in the database.');
					}
				});
					
			}
			else if ( activeDrops.has(serverId) && (
				   (message.content.toLowerCase() === activeDrops.get(serverId).toLowerCase())
				|| (activeDrops.get(serverId).toLowerCase() === 'farfetch\'d' && message.content.toLowerCase() === 'farfetchd')
				|| (activeDrops.get(serverId).toLowerCase() === 'mr. mime' && message.content.toLowerCase() === 'mr mime')
				|| (activeDrops.get(serverId).toLowerCase() === 'ho-oh' && message.content.toLowerCase() === 'ho oh')
				|| (activeDrops.get(serverId).toLowerCase() === 'ho-oh' && message.content.toLowerCase() === 'hooh'))) { //edge case
				const curMon = activeDrops.get(serverId);
				message.channel.send('Added to party list');
				dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
					if (err) {
						console.error(err.message);
						return;
					}
					if (!row) {
						// User isn't in the database, add them
						dbUser.run("INSERT INTO user (user_id, caught_pokemon) VALUES (?, ?)", [userId, JSON.stringify([curMon])], (err) => {
							if (err) {
								console.error(err.message);
							}
							activeDrops.delete(serverId);
						});
					} else {
						// User is in the database, update their caught Pokémon
						const caughtPokemon = JSON.parse(row.caught_pokemon);
						caughtPokemon.push(curMon);
						dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(caughtPokemon), userId], (err) => {
							if (err) {
								console.error(err.message);
							}
							activeDrops.delete(serverId);
						});
					}
				});
			}
			else if (message.content === '.p' || message.content === '.party') {
			// Get the user's ID and display all their Pokémon in an embedded list
			dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
				if (err) {
					console.error(err.message);
					message.channel.send('An error occurred while fetching your Pokémon.');
					return;
				}
				if (!row || !row.caught_pokemon) {
					message.channel.send('You have not caught any Pokémon yet.');
				} else {
					const caughtPokemon = JSON.parse(row.caught_pokemon);
					const pageSize = 20;
					let page = 0;

					const embed = generatePartyEmbed(caughtPokemon, page, pageSize);

					const buttonRow = new ActionRowBuilder()
						.addComponents(
							new ButtonBuilder()
								.setCustomId('prev')
								.setLabel('◀')
								.setStyle(ButtonStyle.Primary),
							new ButtonBuilder()
								.setCustomId('next')
								.setLabel('▶')
								.setStyle(ButtonStyle.Primary)
						);

					message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
						const filter = i => i.user.id === message.author.id;
						const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

						collector.on('collect', async i => {
							if (i.customId === 'prev') {
								if (page > 0) page--;
							} else if (i.customId === 'next') {
								if ((page + 1) * pageSize < caughtPokemon.length) page++;
							}

							await i.update({ embeds: [generatePartyEmbed(caughtPokemon, page, pageSize)] });
						});

						collector.on('end', collected => {
							const disabledRow = new ActionRowBuilder()
								.addComponents(
									new ButtonBuilder()
										.setCustomId('prev')
										.setLabel('◀')
										.setStyle(ButtonStyle.Primary)
										.setDisabled(true),
									new ButtonBuilder()
										.setCustomId('next')
										.setLabel('▶')
										.setStyle(ButtonStyle.Primary)
										.setDisabled(true)
								);
							sentMessage.edit({ components: [disabledRow] });
						});
					});
				}
			});
			}
			else if ( (message.content === '.off' || message.content === '.stop') && (message.author.id === myUserID)) {
				message.delete();
				process.exit();
			}
		}
	}
});

client.login(token);