require('dotenv').config({ path: './dotenv.env' });

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pokemon.db');
const dbUser = new sqlite3.Database('./user.db');
const dbServer = new sqlite3.Database('./server.db');

const token = process.env.DISCORD_TOKEN;

const {
	Client,
	GatewayIntentBits,
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
} = require('discord.js');

const Discord = require('discord.js');
const client = new Client({
  intents: [
    GatewayIntentBits.GuildMessages,
	GatewayIntentBits.Guilds,
	GatewayIntentBits.MessageContent,
  ],
});

const cooldowns = new Map(); 	//Map<serverId, cooldownEnd>
const activeDrops = new Map();	//Map<serverId, activePokemon {name, isShiny}>
const activeTrades = new Map();	//Map<serverId, {user1, user2, user1Pokemon, user2Pokemon, user1Confirmed, user2Confirmed}>

//Helper function, .party Embed Generator
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

//Helper function, .dex Embed Generator
function updateEmbed(shinyImg, dexNumber, pokemonRow) {
	const type2 = pokemonRow.type2 ? ` / ${pokemonRow.type2}` : '';
	const imageLink = shinyImg ? pokemonRow.shinyImageLink : pokemonRow.imageLink;
							
	return new EmbedBuilder()
		.setColor('#0099ff')
		.setTitle(`${pokemonRow.name} - #${dexNumber}`)
		.addFields(
			{ name: 'Type', value: `${pokemonRow.type1}${type2}`, inline: true },
			{ name: 'Region', value: `${pokemonRow.region}`, inline: true }
		)
		.setImage(imageLink)
		.setTimestamp();
}

//Helper function, replaces a char in a string
String.prototype.replaceAt = function(index, char) {
    var a = this.split("");
    a[index] = char;
    return a.join("");
}

//Helper function, capitalizes first letter in a string
function capitalizeFirstLetter(string) {
	return string.charAt(0).toUpperCase() + string.slice(1);
}

//Helper function, generates a random int given an upper bound: 0 to upperBound - 1 inclusive
function getRandomInt(upperBound) {
	return Math.floor(Math.random() * upperBound);
}

//Helper function, checks if the bot should be posting in a configured channel
function isChannelAllowed(serverId, channelId, callback) {
	dbServer.get("SELECT allowed_channels_id FROM server WHERE server_id = ?", [serverId], (err, row) => {
		if (err) {
			console.error(err.message);
			callback(false); // Return false if there's an error
			return;
		}
		if (!row || !row.allowed_channels_id) {
			callback(true); // Return true if there's no configuration (default)
			return;
		}
		const allowedChannels = row.allowed_channels_id.split(',');
		callback(allowedChannels.includes(channelId));
	});
}

const dropCommandRegex = /^\.(drop|d)\b/;
const setChannelCommandRegex = /^\.(setchannel|setchannels)\b/;
const viewChannelCommandRegex = /^\.(viewchannels)\b/;
const resetChannelCommandRegex = /^\.(resetchannels)\b/;
const viewCommandRegex = /^\.(view|v)\b/;
const partyCommandRegex = /^\.(party|p)\b/;
const currencyCommandRegex = /^\.(currency|c)\b/;
const helpCommandRegex = /^\.(help)\b/;
const hintCommandRegex = /^\.(hint|h)\b/;
const releaseCommandRegex = /^\.(release|r)\b/;
const tradeCommandRegex = /^\.(trade|t)\b/;
const dexCommandRegex = /^\.(dex)\b/;

const maxDexNum = 493; //number x is max pokedex entry - EDIT WHEN ADDING MORE POKEMON

client.on('ready', () => {
	console.log(`Logged in as ${client.user.tag}`);
	dbUser.run("CREATE TABLE IF NOT EXISTS user (user_id TEXT PRIMARY KEY, caught_pokemon TEXT, currency INTEGER DEFAULT 0)");
	dbServer.run("CREATE TABLE IF NOT EXISTS server (server_id TEXT PRIMARY KEY, allowed_channels_id TEXT)")});

client.on('messageCreate', (message) => {
	if (!message.author.bot) {
		if (message.content.length > 0) {
			const serverId = message.guild.id;
			const userId = message.author.id;
			const now = Date.now();
			
			//drop
			if (dropCommandRegex.test(message.content.toLowerCase())) { //TODO: fix channels in 1 server interfering
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					if (cooldowns.has(userId)) {
						const cooldownEnd = Math.floor(cooldowns.get(userId) / 1000);
						message.channel.send(`You can drop again <t:${cooldownEnd}:R>.`);
						return;
					}
					
					const cooldownEnd = now + 300000;
					cooldowns.set(userId, cooldownEnd);
					setTimeout(() => cooldowns.delete(userId), 300000);
					
					
					db.all("SELECT * FROM pokemon", [], (err, rows) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching the Pokémon.');
							return;
						}
						if (rows.length > 0) {
							const shinyNumber = Math.random();
							let isShiny = false;
							const legendaryNumber = Math.random();
							let isLegendary = false;
							const mythicalNumber = Math.random();
							let isMythical = false;
							
							if (shinyNumber < 0.00025) {
								isShiny = true;
							}
							if (legendaryNumber < 0.0075) {
								isLegendary = true;
							}
							if (mythicalNumber < 0.005) {
								isMythical = true;
							}
							
							let randPokemon = getRandomInt(maxDexNum); 
							let pokemon = null;
							
							if (isMythical) { //query the database for isLM = 2 and randomly select
								pokemon = rows[randPokemon];
								while (pokemon.isLM !== 2) {
									randPokemon = getRandomInt(maxDexNum);
									pokemon = rows[randPokemon];
								}
							}
							else if (isLegendary) { //query the database for isLM = 1 and randomly select
								pokemon = rows[randPokemon];
								while (pokemon.isLM !== 1) {
									randPokemon = getRandomInt(maxDexNum);
									pokemon = rows[randPokemon];
								}
							}
							else {
								pokemon = rows[randPokemon]; //this is fine
								while (pokemon.isLM !== 0) {
									randPokemon = getRandomInt(maxDexNum);
									pokemon = rows[randPokemon];
								}
							}
							
							let imageLink = null;
							
							if (isShiny) {
								imageLink = pokemon.shinyImageLink;
							}
							else {
								imageLink = pokemon.imageLink;
							}
							
							const type2 = pokemon.type2 ? ` / ${pokemon.type2}` : '';
							const curMon = pokemon.name ? `${pokemon.name}` : '';
							console.log('Current pokemon: ' + curMon + '\n' + 'ShinyNum:     ' + shinyNumber + ' (<0.00025)' + '\n' + 'MythicalNum:  ' + mythicalNumber + ' (<0.005)' + '\n' + 'LegendaryNum: ' + legendaryNumber + ' (<0.0075)' +'\n');
							
							activeDrops.set(serverId, { name: curMon, isShiny });
							
							const embed = new EmbedBuilder()
								.setColor('#0099ff')
								.addFields(
									{ name: 'Type', value: `${pokemon.type1}${type2}`, inline: true },
									{ name: 'Region', value: `${pokemon.region}`, inline: true }
								)
								.setImage(imageLink)
								.setTimestamp()

							message.channel.send({ embeds: [embed] });
						} 
						else {
							message.channel.send('No Pokémon found in the database.');
						}
					});
				});
			}
			
			//catch
			else if ( activeDrops.has(serverId) && (
				   (message.content.toLowerCase() === activeDrops.get(serverId).name.toLowerCase())
				|| (activeDrops.get(serverId).name.toLowerCase() === 'farfetch\'d' && message.content.toLowerCase() === 'farfetchd')
				|| (activeDrops.get(serverId).name.toLowerCase() === 'mr. mime' && message.content.toLowerCase() === 'mr mime')
				|| (activeDrops.get(serverId).name.toLowerCase() === 'ho-oh' && message.content.toLowerCase() === 'ho oh')
				|| (activeDrops.get(serverId).name.toLowerCase() === 'ho-oh' && message.content.toLowerCase() === 'hooh')
				|| (activeDrops.get(serverId).name.toLowerCase() === 'mime jr.' && message.content.toLowerCase() === 'mime jr')
				|| (activeDrops.get(serverId).name.toLowerCase() === 'mime jr.' && message.content.toLowerCase() === 'mimejr')
				|| (activeDrops.get(serverId).name.toLowerCase() === 'porygon-z' && message.content.toLowerCase() === 'porygon z')
				|| (activeDrops.get(serverId).name.toLowerCase() === 'porygon-z' && message.content.toLowerCase() === 'porygonz'))) { //edge case
				
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const curMon = activeDrops.get(serverId);
					const curMonName = curMon.name;
					let isShinyVar = curMon.isShiny ? 1 : 0;
					db.get("SELECT * FROM pokemon WHERE name = ?", [curMonName], (err, pokemonRow) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching Pokémon information.');
							return;
						}
						if (!pokemonRow) {
							message.channel.send('Pokémon not found in the database.');
							return;
						}
						const coinsToAdd = getRandomInt(21) + 5;
						const shinyMon = isShinyVar ? `✨${curMonName}` : curMonName;
						
						let userDisplayName = '';
						if (message.guild.members.cache.get(userId).displayName.toLowerCase().includes("@everyone") || message.guild.members.cache.get(userId).displayName.toLowerCase().includes("@here")) {
							userDisplayName = "Someone";
						}
						else {
							userDisplayName = message.guild.members.cache.get(userId).displayName;
						}
						
						const messageText = isShinyVar
							? `Added ✨${curMonName} to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`
							: `Added ${curMonName} to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`;
						
						message.channel.send(messageText);
						
						dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
							if (err) {
								console.error(err.message);
								return;
							}
							if (!row) {
								// User isn't in the database, add them
								dbUser.run("INSERT INTO user (user_id, caught_pokemon, currency) VALUES (?, ?, ?)", [userId, JSON.stringify([shinyMon]), coinsToAdd], (err) => {
									if (err) {
										console.error(err.message);
									}
									activeDrops.delete(serverId);
								});
							} 
							else {
								// User is in the database, update their caught Pokémon & currency
								const caughtPokemon = JSON.parse(row.caught_pokemon);
								caughtPokemon.push(shinyMon);
								const newCurrency = row.currency + coinsToAdd;
								dbUser.run("UPDATE user SET caught_pokemon = ?, currency = ? WHERE user_id = ?", [JSON.stringify(caughtPokemon), newCurrency, userId], (err) => {
									if (err) {
										console.error(err.message);
									}
									activeDrops.delete(serverId);
								});
							}
						}); 
					});
				});
			}
			
			//Config: Set channel(s) for the bot
			else if (setChannelCommandRegex.test(message.content.toLowerCase())) {
				try {
					if (!message.member.permissions.has('ADMINISTRATOR')) {
						isChannelAllowed(serverId, message.channel.id, (allowed) => {
							if (!allowed) {
								return;
							}
						message.channel.send("You do not have permission to use this command.");
						return;
						});
					}
				}
				catch (error) {
					//TO BE ERASED AFTER DEVELOPMENT
					if (userId === '177580797165961216') {
						//erase else{} too, but keep the inside
					}
					else {
						isChannelAllowed(serverId, message.channel.id, (allowed) => {
							if (!allowed) {
								return;
							}
						message.channel.send("You do not have permission to use this command.");
						return;
						});
					}
				}
				
				const args = message.content.split(' ').slice(1);
				if (args.length === 0) {
					message.channel.send("You must specify at least one channel.");
					return;
				}
				
				const channelRegex = /^<#\d+>$/;
				const newChannels = new Set();
				for (const arg of args) {
					if (!channelRegex.test(arg)) {
						message.channel.send('Invalid channel format. Make sure to tag the channel with a #');
						return;
					}
					newChannels.add(arg.replace('<#', '').replace('>', ''));
				}
				
				dbServer.get("SELECT allowed_channels_id FROM server WHERE server_id = ?", [serverId], (err, row) => {
					if (err) {
						console.error(err.message);
						message.channel.send('An error occurred while retrieving the current configuration.');
						return;
					}
					
					let existingChannels = new Set();
					if (row && row.allowed_channels_id) {
						existingChannels = new Set(row.allowed_channels_id.split(','));
					}
					
					//Merge existing channels with new channels
					const combinedChannels = new Set([...existingChannels, ...newChannels]);
					const allowedChannels = Array.from(combinedChannels).join(',');
					
					dbServer.run("REPLACE INTO server (server_id, allowed_channels_id) VALUES (?, ?)", [serverId, allowedChannels], (err) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while saving the configuration.');
							return;
						}
						message.channel.send('Allowed channels have been set.');
					});
				});
			}
			
			//Config: View Set Channels
			else if (viewChannelCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					dbServer.get("SELECT allowed_channels_id FROM server WHERE server_id = ?", [serverId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your server\'s active channels.');
							return;
						}
						if (!row || !row.allowed_channels_id) {
							message.channel.send('You have not selected any active channels yet.');
						}
						else {
							const activeChannels = row.allowed_channels_id.split(',');
							const pageChannels = activeChannels.slice(0, 20);
							const formattedChannelsList = pageChannels.map((channelId) => `<#${channelId.trim()}>`).join('\n');
							
							const embed = new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('My Active Channels')
								.setDescription(formattedChannelsList || 'No Channels Found')
								.setFooter({ text: `Showing ${Math.min(20, activeChannels.length)} of ${activeChannels.length} Channels` })
								.setTimestamp();
								
							message.channel.send({embeds: [embed] });
						}
					});
				});
			}
			
			//Config: Remove Set Channels
			else if (resetChannelCommandRegex.test(message.content.toLowerCase())) {
				try {
					if (!message.member.permissions.has('ADMINISTRATOR')) {
						isChannelAllowed(serverId, message.channel.id, (allowed) => {
							if (!allowed) {
								return;
							}
						message.channel.send("You do not have permission to use this command.");
						return;
						});
					}
				}
				catch (error) {
					//TO BE ERASED AFTER DEVELOPMENT
					if (userId === '177580797165961216') {
						//erase else{} too, but keep the inside
					}
					else {
						isChannelAllowed(serverId, message.channel.id, (allowed) => {
							if (!allowed) {
								return;
							}
						message.channel.send("You do not have permission to use this command.");
						return;
						});
					}
				}
				const embed = new EmbedBuilder()
						.setColor('#ff0000')
						.setTitle('Reset channel configuration')
						.setDescription('Really reset the configuration?')
						.setTimestamp();

					const buttonRow = new ActionRowBuilder()
						.addComponents(
						new ButtonBuilder()
							.setCustomId('reset_yes')
							.setLabel('Yes')
							.setStyle(ButtonStyle.Success),
						new ButtonBuilder()
							.setCustomId('reset_no')
							.setLabel('No')
							.setStyle(ButtonStyle.Danger)
						);

					message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
						const filter = i => i.user.id === message.author.id;
						const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

						collector.on('collect', async i => {
							if (i.customId === 'reset_yes') {
								dbServer.run("UPDATE server SET allowed_channels_id = NULL WHERE server_id = ?", [serverId], (err) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while resetting the channels.');
									return;
								}
								i.update({ content: 'Successfully reset channel configuration', embeds: [], components: [] });
								});
								
							} 
							else if (i.customId === 'reset_no') {
								i.update({ content: 'Cancelled channel configuration reset', embeds: [], components: [] });
							}
						});

						collector.on('end', collected => {
							sentMessage.edit({components: [] });
						});
					});
			}
			
			//dex
			else if (dexCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const args = message.content.split(' ');
					if (args.length < 2) {
						message.channel.send('Please specify a valid pokemon or its pokedex number. Usage: `.dex <Pokemon>` or `.dex <PokedexNum>`');
						return;
					}
					
					let pokemonIdentifier = args[1];
					let isNumber = !isNaN(pokemonIdentifier);
					let query = '';
					if (!isNumber) {
						pokemonIdentifier = pokemonIdentifier.toLowerCase();
						pokemonIdentifier = capitalizeFirstLetter(pokemonIdentifier);
						
						
						
						//more edge cases handled in bad ways
						if (pokemonIdentifier === 'Farfetchd') {
							pokemonIdentifier = 'Farfetch\'d';
						}
						else if (pokemonIdentifier === 'Mr' && args.length > 2) { //args.length > 2
							if (args[2].toLowerCase() === 'mime') {
								pokemonIdentifier = 'Mr. Mime';
							}
						}
						else if (pokemonIdentifier === 'Mr.' && args.length > 2) { //length > 2
							if (args[2].toLowerCase() === 'mime') {
								pokemonIdentifier = 'Mr. Mime';
							}
						}
						else if (pokemonIdentifier === 'Ho' && args.length > 2) { //args.length > 2
							if (args[2].toLowerCase() === 'oh') {
								pokemonIdentifier = 'Ho-Oh';
							}
						}
						else if (pokemonIdentifier === 'Hooh') {
							pokemonIdentifier = 'Ho-Oh';
						}
						else if (pokemonIdentifier === 'Ho-oh') {
							pokemonIdentifier = 'Ho-Oh';
						}
						else if (pokemonIdentifier === 'Mime' && args.length > 2) { //length > 2
							if (args[2].toLowerCase() === 'jr' || args[2].toLowerCase() === 'jr.') {
								pokemonIdentifier = 'Mime Jr.';
							}
						}
						else if (pokemonIdentifier === 'Mimejr') {
							pokemonIdentifier = 'Mime Jr.';
						}
						else if (pokemonIdentifier === 'Porygon' && args.length > 2) { //length > 2
							if (args[2].toLowerCase() === 'z') {
								pokemonIdentifier = 'Porygon-Z';
							}
						}
						else if (pokemonIdentifier === 'Porygonz') {
							pokemonIdentifier = 'Porygon-Z';
						}
						else if (pokemonIdentifier === 'Porygon-z') {
							pokemonIdentifier = 'Porygon-Z';
						}
						
						
						query = "SELECT * FROM pokemon WHERE name = ?";
					}
					else {
						pokemonIdentifier = parseInt(pokemonIdentifier, 10);
						query = "SELECT * FROM pokemon WHERE dexNum = ?";
					}
					
					db.get(query, [pokemonIdentifier], (err, pokemonRow) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching Pokémon information.');
							return;
						}
						if (!pokemonRow) {
							message.channel.send('Pokémon not found in the database.');
							return;
						}
						let shinyImg = false;
						
						let embed = updateEmbed(shinyImg, pokemonRow.dexNum, pokemonRow);
						
						const buttonRow = new ActionRowBuilder()
							.addComponents(
								new ButtonBuilder()
									.setCustomId('prev')
									.setLabel('◀')
									.setStyle(ButtonStyle.Primary),
								new ButtonBuilder()
									.setCustomId('shinyBtn')
									.setLabel('✨')
									.setStyle(ButtonStyle.Primary),
								new ButtonBuilder()
									.setCustomId('next')
									.setLabel('▶')
									.setStyle(ButtonStyle.Primary)
							);
						
						message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
							const filter = i => i.user.id === userId;
							const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

							collector.on('collect', async i => {
								if (i.customId === 'prev') {
									let prevDexNum = pokemonRow.dexNum - 1;
									if (prevDexNum < 1) {
										prevDexNum = maxDexNum;
									}
									db.get("SELECT * FROM pokemon WHERE dexNum = ?", [prevDexNum], (err, prevPokemonRow) => {
										if (err) {
											console.error(err.message);
											message.channel.send('An error occurred while fetching Pokémon information.');
											return;
										}
										if (!prevPokemonRow) {
											message.channel.send('Pokémon not found in the database.');
											return;
										}
										pokemonRow = prevPokemonRow;
										embed = updateEmbed(shinyImg, prevDexNum, pokemonRow);
										i.update({ embeds: [embed] });
									});
									
								} else if (i.customId === 'next') {
									let nextDexNum = pokemonRow.dexNum + 1;
									if (nextDexNum > maxDexNum) {
										nextDexNum = 1;
									}
									db.get("SELECT * FROM pokemon WHERE dexNum = ?", [nextDexNum], (err, nextPokemonRow) => {
										if (err) {
											console.error(err.message);
											message.channel.send('An error occurred while fetching Pokémon information.');
											return;
										}
										if (!nextPokemonRow) {
											message.channel.send('Pokémon not found in the database.');
											return;
										}
										pokemonRow = nextPokemonRow;
										embed = updateEmbed(shinyImg, nextDexNum, pokemonRow);
										i.update({ embeds: [embed] });
									});
									
								} else if (i.customId === 'shinyBtn') {
									shinyImg = !shinyImg;
									embed = updateEmbed(shinyImg, pokemonRow.dexNum, pokemonRow);
									i.update({ embeds: [embed] });
								}
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
											.setCustomId('shinyBtn')
											.setLabel('✨')
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
					});
				});
			}
			
			//View
			else if (viewCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const args = message.content.split(' ');
					if (args.length < 2 || isNaN(args[1])) {
						message.channel.send('Please specify a valid number. Usage: `.view <partyNumber>`');
						return;
					}
					
					const index = parseInt(args[1], 10) - 1;
					
					dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your Pokémon.');
							return;
						}

						if (!row || !row.caught_pokemon) {
							message.channel.send('You have not caught any Pokémon yet.');
							return;
						}

						const caughtPokemon = JSON.parse(row.caught_pokemon);

						if (index < 0 || index >= caughtPokemon.length) {
							message.channel.send('Please specify a valid party number.');
							return;
						}

						const pokemonToDisplay = caughtPokemon[index];
						
						if (pokemonToDisplay[0] === '✨') {
							let shinyDisplayedPokemon = pokemonToDisplay.replaceAt(0, '');
							db.get("SELECT * FROM pokemon WHERE name = ?", [shinyDisplayedPokemon], (err, pokemonRow) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while fetching Pokémon information.');
									return;
								}
								if (!pokemonRow) {
									message.channel.send('Pokémon not found in the database.');
									return;
								}
								
								const type2 = pokemonRow.type2 ? ` / ${pokemonRow.type2}` : '';
								
								
								const embed = new EmbedBuilder()
									.setColor('#0099ff')
									.setTitle(`Your ✨${pokemonRow.name}`)
									.addFields(
										{ name: 'Dex Number', value: `${pokemonRow.dexNum}`, inline: true },
										{ name: 'Type', value: `${pokemonRow.type1}${type2}`, inline: true },
										{ name: 'Region', value: `${pokemonRow.region}`, inline: true }
									)
									.setImage(pokemonRow.shinyImageLink)
									.setTimestamp();
									
									message.channel.send({embeds: [embed] });
							});
						}
						else {
							db.get("SELECT * FROM pokemon WHERE name = ?", [pokemonToDisplay], (err, pokemonRow) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while fetching Pokémon information.');
									return;
								}
								if (!pokemonRow) {
									message.channel.send('Pokémon not found in the database.');
									return;
								}
								
								const type2 = pokemonRow.type2 ? ` / ${pokemonRow.type2}` : '';
								
								
								const embed = new EmbedBuilder()
									.setColor('#0099ff')
									.setTitle(`Your ${pokemonRow.name}`)
									.addFields(
										{ name: 'Dex Number', value: `${pokemonRow.dexNum}`, inline: true },
										{ name: 'Type', value: `${pokemonRow.type1}${type2}`, inline: true },
										{ name: 'Region', value: `${pokemonRow.region}`, inline: true }
									)
									.setImage(pokemonRow.imageLink)
									.setTimestamp();
									
									message.channel.send({embeds: [embed] });
							});
						}
						
					});
				});
			}
			
			//party
			else if (partyCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					
					const args = message.content.split(' ').slice(1);
					
					// Get the user's ID and display all their Pokémon in an embedded list
					dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your Pokémon.');
							return;
						}
						if (!row || !row.caught_pokemon) {
							message.channel.send('You have not caught any Pokémon yet.');
							return;
						} 
						
						const caughtPokemon = JSON.parse(row.caught_pokemon);
						
						if (args.length === 0) {
							const pageSize = 20;
							let page = 0;

							const embed = generatePartyEmbed(caughtPokemon, page, pageSize);

							const buttonRow = new ActionRowBuilder()
								.addComponents(
									new ButtonBuilder()
										.setCustomId('rewind')
										.setLabel('⏪')
										.setStyle(ButtonStyle.Primary),
									new ButtonBuilder()
										.setCustomId('prev')
										.setLabel('◀')
										.setStyle(ButtonStyle.Primary),
									new ButtonBuilder()
										.setCustomId('next')
										.setLabel('▶')
										.setStyle(ButtonStyle.Primary),
									new ButtonBuilder()
										.setCustomId('fforward')
										.setLabel('⏩')
										.setStyle(ButtonStyle.Primary)
								);

							message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
								const filter = i => i.user.id === userId;
								const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

								collector.on('collect', async i => {
									if (i.customId === 'prev') {
										if (page > 0) {
											page--;
										}
										else {
											page = Math.ceil(caughtPokemon.length / pageSize) - 1;;
										}
									} 
									else if (i.customId === 'next') {
										if ((page + 1) * pageSize < caughtPokemon.length) {
											page++;
										}
										else {
											page = 0;
										}
									}
									else if (i.customId === 'rewind') {
										page = 0;
									}
									else if (i.customId === 'fforward') {
										page = Math.ceil(caughtPokemon.length / pageSize) - 1;;
									}

									await i.update({ embeds: [generatePartyEmbed(caughtPokemon, page, pageSize)] });
								});

								collector.on('end', collected => {
									const disabledRow = new ActionRowBuilder()
										.addComponents(
											new ButtonBuilder()
												.setCustomId('rewind')
												.setLabel('⏪')
												.setStyle(ButtonStyle.Primary)
												.setDisabled(true),
											new ButtonBuilder()
												.setCustomId('prev')
												.setLabel('◀')
												.setStyle(ButtonStyle.Primary)
												.setDisabled(true),
											new ButtonBuilder()
												.setCustomId('next')
												.setLabel('▶')
												.setStyle(ButtonStyle.Primary)
												.setDisabled(true),
											new ButtonBuilder()
												.setCustomId('fforward')
												.setLabel('⏩')
												.setStyle(ButtonStyle.Primary)
												.setDisabled(true)
											);
									sentMessage.edit({ components: [disabledRow] });
								});
							});
						}
						
						else if (args[0].toLowerCase() === 'name:') {
							if (args.length > 1) {
								let searchName = args[1].toLowerCase();
								searchName = capitalizeFirstLetter(searchName);
								
								const filteredPokemon = caughtPokemon.map((p, index) => ({name: p, id: index + 1})).filter(p => typeof p.name === 'string' && (p.name === searchName || p.name === '✨' + searchName));
								
								if (filteredPokemon.length === 0) {
									message.channel.send(`You do not have any Pokémon named ${args[1]}.`);
								}
								else {
									const embed = new EmbedBuilder()
										.setColor('#0099ff')
										.setTitle(`All ${searchName} in your party:`)
										.setDescription(filteredPokemon.map(p => ` \`\`${p.id}\`\` ${p.name} `).join('\n'))
										.setTimestamp();
									message.channel.send({ embeds: [embed] });
								}
							}
							else {
								message.channel.send('Improper use of command. Example: .p name: <pokemon>');
							}
						}
						else if (args[0].toLowerCase() === 'swap') {
							if (args.length > 2) {
								const partyNum1 = parseInt(args[1], 10) - 1;
								const partyNum2 = parseInt(args[2], 10) - 1;
								
								if (isNaN(partyNum1) || isNaN(partyNum2) || partyNum1 < 0 || partyNum2 < 0 || partyNum1 >= caughtPokemon.length || partyNum2 >= caughtPokemon.length) {
									message.channel.send("Invalid party numbers provided for swapping.");
									return;
								}
								if (partyNum1 === partyNum2) {
									message.channel.send("There's no reason to swap the same pokemon.");
									return;
								}
								
								[caughtPokemon[partyNum1], caughtPokemon[partyNum2]] = [caughtPokemon[partyNum2], caughtPokemon[partyNum1]];
								
								dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(caughtPokemon), userId], (err) => {
									if (err) {
										console.error(err.message);
										message.channel.send('An error occurred while swapping your Pokémon.');
										return;
									}
									message.channel.send(`Swapped Pokémon at positions ${partyNum1 + 1} and ${partyNum2 + 1}.`);
								});
							}
							else {
								message.channel.send('Improper use of command. Example: .p swap <partyNum> <partyNum>');
							}
						}
						else if (args[0].toLowerCase() === 'shiny') {
							const shinyPokemon = caughtPokemon.map((p, index) => ({ name: p, id: index + 1 })).filter(p => typeof p.name === 'string' && p.name.startsWith('✨'));
							if (shinyPokemon.length === 0) {
								message.channel.send("You do not have any shiny Pokémon.");
							} else {
								const embed = new EmbedBuilder()
									.setColor('#FFD700') // Gold color for shiny Pokémon
									.setTitle('Your Shiny Pokémon')
									.setDescription(shinyPokemon.map(p => ` \`\`${p.id}\`\` ${p.name} `).join('\n'))
									.setTimestamp();
								message.channel.send({ embeds: [embed] });
							}
						}
						else {
							message.channel.send("Invalid command usage. Use `.p` for party, `.p name: <pokemon>` to search, or `.p swap <partyNum1> <partyNum2>` to swap.");
						}
						
					});
				});
			}
			
			//currency
			else if (currencyCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					dbUser.get("SELECT currency FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your currency.');
							return;
						}
						if (!row) {
							message.channel.send('You have not earned any currency yet.');
						}
						else {
							message.channel.send(`You currently have ${row.currency} coins.`);
						}
					});
				});
			}
			
			//help
			else if(helpCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const helpEmbed = new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Help')
						.setDescription('List of available commands and how to use them:')
						.addFields(
							{ name: '.drop (.d)', value: 'Drops a random Pokémon in the channel. Cooldown: 5 minutes.' },
							{ name: '.party (.p)', value: 'Displays your caught Pokémon. \n Usages: .party name: <pokemon> | .party shiny | .party swap 1 10' },
							{ name: '.view <partyNum> (.v)', value: 'Displays a pokemon from your party. \n Example: .view 1' },
							{ name: '.currency (.c)', value: 'Displays your current amount of coins.' },
							{ name: '.hint (.h)', value: 'Gives a hint for the currently dropped Pokémon.' },
							{ name: '.release <partyNum> (.r)', value: 'Releases a Pokémon from your party. \n Example: .release 1' },
							{ name: '.trade @<user> (.t)', value: 'Initiates a trade with another user.' },
							{ name: '.setChannel: #<channel>', value: '`ADMIN ONLY:` Directs the bot to only allow commands inside the #<channels>.' },
							{ name: '.resetChannels:', value: '`ADMIN ONLY:` Resets the bot to default, can use commands in any channel' },
							{ name: '.viewChannels:', value: '`ADMIN ONLY:` Posts a list of channels the server allows bot commands in' }
						)
						.setTimestamp();

					message.channel.send({ embeds: [helpEmbed] });
				});
			}
			
			//hint
			else if (hintCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					let curMon = "";
					let monLength = 0;
					try {
						curMon = activeDrops.get(serverId).name;
						monLength = curMon.length;
						let numLetters = 0;
						let curMonHint = activeDrops.get(serverId).name;
						while (numLetters / monLength < 0.6) {
							const randomInt = getRandomInt(monLength);
							if (!(curMonHint[randomInt] === '_')) {
								curMonHint = curMonHint.replaceAt(randomInt, '_');
								numLetters++;
							}
						}
						//Edge cases handled in poor ways
						if (curMon.toLowerCase() === 'farfetch\'d') {
							curMonHint = curMonHint.replaceAt(8, '\'');
						}
						else if (curMon.toLowerCase() === 'mr. mime') {
							curMonHint = curMonHint.replaceAt(2, '.');
						}
						else if (curMon.toLowerCase() === 'ho-oh') {
							curMonHint = curMonHint.replaceAt(2, '-');
						}
						else if (curMon.toLowerCase() === 'mime jr.') {
							curMonHint = curMonHint.replaceAt(7, '.');
						}
						else if (curMon.toLowerCase() === 'porygon-z') {
							curMonHint = curMonHint.replaceAt(7, '-');
						}
						const regex = new RegExp("_", 'g');
						let finalHint = curMonHint.replace(regex, "\\_");
						message.channel.send(finalHint);
					}
					catch (error) {
						message.channel.send('No current pokemon dropped!');
					}
				});				
			}
			
			//release
			else if (releaseCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const args = message.content.split(' ');
					if (args.length !== 2 || isNaN(args[1])) {
						message.channel.send('Please specify a valid number. Usage: `.release <partyNumber>`');
						return;
					}

					const index = parseInt(args[1], 10) - 1;

					dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your Pokémon.');
							return;
						}

						if (!row || !row.caught_pokemon) {
							message.channel.send('You have not caught any Pokémon yet.');
							return;
						}

						const caughtPokemon = JSON.parse(row.caught_pokemon);

						if (index < 0 || index >= caughtPokemon.length) {
							message.channel.send('Please specify a valid party number.');
							return;
						}

						const pokemonToRelease = caughtPokemon[index];

						const embed = new EmbedBuilder()
							.setColor('#ff0000')
							.setTitle('Release Pokémon')
							.setDescription(`Really release #${index + 1}, ${pokemonToRelease}?`)
							.setTimestamp();

						const buttonRow = new ActionRowBuilder()
							.addComponents(
							new ButtonBuilder()
								.setCustomId('release_yes')
								.setLabel('Yes')
								.setStyle(ButtonStyle.Success),
							new ButtonBuilder()
								.setCustomId('release_no')
								.setLabel('No')
								.setStyle(ButtonStyle.Danger)
							);

						message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
							const filter = i => i.user.id === message.author.id;
							const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

							collector.on('collect', async i => {
								if (i.customId === 'release_yes') {
									caughtPokemon.splice(index, 1);
									dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(caughtPokemon), userId], (err) => {
									if (err) {
										console.error(err.message);
									}
									i.update({ content: `Successfully released ${pokemonToRelease}`, embeds: [], components: [] });
									});
								} 
								else if (i.customId === 'release_no') {
									i.update({ content: 'Release cancelled.', embeds: [], components: [] });
								}
							});

							collector.on('end', collected => {
								sentMessage.edit({components: [] });
							});
						});
					});
				});
			}
			
			//trade
			else if (tradeCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const args = message.content.split(' ');
					if (args[1] === 'confirm') {
						if (!activeTrades.has(serverId)) {
							message.channel.send("No active trade to confirm.");
							return;
						}
						const trade = activeTrades.get(serverId);
							if (trade.user1 === userId) {
								trade.user1Confirmed = true;
							} 
							else if (trade.user2 === userId) {
								trade.user2Confirmed = true;
							} 
							else {
								message.channel.send("You are not part of the active trade.");
								return;
							}
							if (trade.user1Confirmed && trade.user2Confirmed) {
								// Swap Pokémon
								dbUser.get("SELECT * FROM user WHERE user_id = ?", [trade.user1], (err, user1Row) => {
									if (err) {
										console.error(err.message);
										message.channel.send('An error occurred while fetching user data.');
										return;
									}
									const user1Pokemon = JSON.parse(user1Row.caught_pokemon);
									const user1TradedPokemon = user1Pokemon.splice(trade.user1Pokemon, 1)[0];
				
									dbUser.get("SELECT * FROM user WHERE user_id = ?", [trade.user2], (err, user2Row) => {
										if (err) {
											console.error(err.message);
											message.channel.send('An error occurred while fetching user data.');
											return;
										}
										const user2Pokemon = JSON.parse(user2Row.caught_pokemon);
										const user2TradedPokemon = user2Pokemon.splice(trade.user2Pokemon, 1)[0];
					
										user1Pokemon.push(user2TradedPokemon);
										user2Pokemon.push(user1TradedPokemon);

										dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(user1Pokemon), trade.user1], (err) => {
											if (err) {
												console.error(err.message);
												return;
											}
											dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(user2Pokemon), trade.user2], (err) => {
												if (err) {
													console.error(err.message);
													return;
												}
												message.channel.send(`Trade completed! <@!${user1Row.user_id}> traded ${user1TradedPokemon} with <@!${user2Row.user_id}> for ${user2TradedPokemon}.`);
												clearTimeout(trade.timeout);
												activeTrades.delete(serverId);
											});
										});
									});
								});
							} 
						else {
							message.channel.send("Trade confirmed. Waiting for the other user to confirm.");
						}
					}
					else if (args[1] === 'add') {
						if (!activeTrades.has(serverId)) {
							message.channel.send("No active trade to add Pokémon.");
							return;
						}
						
						if (isNaN(args[2]) || parseInt(args[2], 10) <= 0) {
							message.channel.send("You must provide a valid party number.");
							return;
						}
						
						const trade = activeTrades.get(serverId);
						const partyNum = parseInt(args[2], 10) - 1;
						
						dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching your Pokémon data.');
								return;
							}
							const userPokemon = JSON.parse(row.caught_pokemon);
							if (partyNum < 0 || partyNum >= userPokemon.length) {
								message.channel.send("You do not have a Pokémon in that party slot.");
								return;
							}
							let isUser1 = false;
							
							if (trade.user1 === userId) {
								trade.user1Pokemon = partyNum;
								isUser1 = true;
							} 
							else if (trade.user2 === userId) {
								trade.user2Pokemon = partyNum;
							}
							else {
								message.channel.send("You are not part of the active trade.");
								return;
							}
							
							const pokeName = userPokemon[partyNum];
							let authorUserName = message.member.displayName;
							if (authorUserName.toLowerCase().includes("@everyone") || authorUserName.toLowerCase().includes("@here")) {
								authorUserName = "Someone";
							}
							
							if (trade.user1Pokemon !== null && trade.user2Pokemon !== null) {
								
								dbUser.get("SELECT * FROM user WHERE user_id = ?", [trade.user1], (err, user1Row) => {
									if (err) {
										console.error(err.message);
										message.channel.send('An error occurred while fetching user1 data.');
										return;
									}
									const user1PokemonName = JSON.parse(user1Row.caught_pokemon)[trade.user1Pokemon];

									dbUser.get("SELECT * FROM user WHERE user_id = ?", [trade.user2], (err, user2Row) => {
										if (err) {
											console.error(err.message);
											message.channel.send('An error occurred while fetching user2 data.');
											return;
										}
										const user2PokemonName = JSON.parse(user2Row.caught_pokemon)[trade.user2Pokemon];
										
										let userDisplayName1 = '';
										let userDisplayName2 = '';
										if (message.guild.members.cache.get(trade.user1).displayName.toLowerCase().includes("@everyone") || message.guild.members.cache.get(trade.user1).displayName.toLowerCase().includes("@here")) {
											userDisplayName1 = "Someone";
										}
										else {
											userDisplayName1 = message.guild.members.cache.get(trade.user1).displayName;
										}
										if (message.guild.members.cache.get(trade.user2).displayName.toLowerCase().includes("@everyone") || message.guild.members.cache.get(trade.user2).displayName.toLowerCase().includes("@here")) {
											userDisplayName2 = "Someone";
										}
										else {
											userDisplayName2 = message.guild.members.cache.get(trade.user2).displayName;
										}
										message.channel.send(
											`Trade set: **${user1PokemonName}** (added by ${userDisplayName1}) and **${user2PokemonName}** (added by ${userDisplayName2}). Type \`.trade confirm\` to confirm the trade.`
										);
									});
								});
							}
							else {
								message.channel.send(`${authorUserName} added **${pokeName}** to the trade. Waiting for the other user to add their Pokémon.`);//TODO: display pokemon added
							}
						});	
					}
					
					else if (args[1] === 'cancel') {
						if (!activeTrades.has(serverId)) {
							message.channel.send("No active trade to cancel.");
							return;
						}
						const trade = activeTrades.get(serverId);
						if (trade.user1 !== userId && trade.user2 !== userId) {
							message.channel.send("You are not part of the active trade.");
							return;
						}
						activeTrades.delete(serverId);
						clearTimeout(trade.timeout);
						message.channel.send("Trade has been cancelled.");
					}
					
					else if (args.length === 2) {
						const targetUser = message.mentions.users.first();
						if (!targetUser) {
							message.channel.send("You must mention a user to trade with.");
							return;
						}
						if (activeTrades.has(serverId)) {
							message.channel.send("A trade is already in progress.");
							return;
						}
						if (targetUser.id === userId) {
							message.channel.send("You can't trade with yourself!");
							return;
						}
						const tradeEmbed = new EmbedBuilder()
							.setColor('#0099ff')
							.setTitle('Trade Request')
							.setDescription(`${message.author} wants to trade with ${targetUser}.`)
							.setTimestamp();
						const buttonRow = new ActionRowBuilder()
							.addComponents(
								new ButtonBuilder()
									.setCustomId('accept_trade')
									.setLabel('Accept')
									.setStyle(ButtonStyle.Success),
								new ButtonBuilder()
									.setCustomId('decline_trade')
									.setLabel('Decline')
									.setStyle(ButtonStyle.Danger)
							);
						message.channel.send({ embeds: [tradeEmbed], components: [buttonRow] }).then(sentMessage => {
							const filter = i => i.user.id === targetUser.id;
							const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });
							collector.on('collect', async i => {
								if (i.customId === 'accept_trade') {
									activeTrades.set(serverId, {
										user1: userId,
										user2: targetUser.id,
										user1Pokemon: null,
										user2Pokemon: null,
										user1Confirmed: false,
										user2Confirmed: false,
										timeout: setTimeout(() => {
											activeTrades.delete(serverId);
											message.channel.send("Trade has timed out due to inactivity.");
										}, 300000)
									});
									await i.update({ content: `Trade accepted. Both users, please add your Pokémon to the trade using \`.trade add <partyNum>\``, embeds: [], components: [] });
								}
								else if (i.customId === 'decline_trade') {
									await i.update({ content: `Trade declined by ${targetUser}`, embeds: [], components: [] });
								}
							});
							collector.on('end', collected => {
								if (collected.size === 0) {
									sentMessage.edit({ content: `Trade request timed out.`, embeds: [], components: [] });
								}
							});
						});
					}
					else if (args.length === 1) {
						message.channel.send("To trade, use `.trade @<user>` to start.");
						return;
					}
				});
			}
			
			//turn off, remove on official release
			else if ( (message.content === '.off' || message.content === '.stop') && ((userId === '177580797165961216') || (userId === '233239544776884224'))) {
				message.delete();
				process.exit();
			}
		}
	}
});

client.login(token);