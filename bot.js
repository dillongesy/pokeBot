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
	PermissionsBitField,
} = require('discord.js');

const requiredPermissions = new PermissionsBitField([
	'ViewChannel',
	'SendMessages',
	'ReadMessageHistory',
	'EmbedLinks',
	'UseExternalEmojis'
]);

const Discord = require('discord.js');
const client = new Client({
  intents: [
    GatewayIntentBits.GuildMessages,
	GatewayIntentBits.Guilds,
	GatewayIntentBits.MessageContent,
  ],
});

const cooldowns = new Map(); 	//Map<userId, cooldownEnd>
const cooldownAlerts = new Map(); //Map<userId, alertEnabled>
const activeDrops = new Map();	//Map<serverId_channelId, activePokemon {name, isShiny, form}>
const activeTrades = new Map();	//Map<serverId, {user1, user2, user1Pokemon, user2Pokemon, user1Confirmed, user2Confirmed}>
const activeUserRepels = new Map(); //Map<userId, { standard, rare }

//Helper function, .party Embed Generator
//isSLM: 0 = default/name, 1 = shiny, 2 = legendary, 3 = mythical
function generatePartyEmbed(pokemonList, page, pageSize, title, isSLM) {
	const start = page * pageSize;
	const end = start + pageSize;
	const pagePokemon = pokemonList.slice(start, end);
	let formattedPokemonList = null;
	let color = '#0099ff';
	if (pokemonList.length > 0) {
		if (typeof pokemonList[0] === 'object') {
			formattedPokemonList = pagePokemon.map(p => {
				let displayName = p.name;

				let isShiny = false;
				if (p.name.startsWith('✨')) {
					displayName = `${displayName.substring(1)}`;
					isShiny = true;
				}

				if (p.form && p.form.toLowerCase() !== 'default') {
					const formPrefix = p.form; //.split(' ')[0];
					displayName = `${formPrefix} ${displayName}`;
					if (isShiny) {
						displayName = `✨${displayName}`;
					}
				}
				else if (isShiny) {
					displayName = `✨${displayName}`;
				}

				const maleSymbol = '`♂`';
				const femaleSymbol = '`♀`';

				if (p.gender === 'Male') {
					displayName += ` ${maleSymbol}`;
				}
				else if (p.gender === 'Female') {
					displayName += ` ${femaleSymbol}`;
				}

				return `\`\`${p.id}\`\`\t${displayName}`;
			}).join('\n');
		}
		else {
			formattedPokemonList = pagePokemon.map((pokemon, index) => `\`\`${start + index + 1}\`\`\t${pokemon}`).join('\n');
		}
	}
	if (isSLM === 1) { //shiny
		color = '#FFD700';
	}
	else if (isSLM === 2) { //legendary
		color = '#66FF00';
	}
	else if (isSLM === 3) { //mythical
		color = '#FF96C5';
	}
	
	const embed = new EmbedBuilder()
		.setColor(color)
		.setTitle(title)
		.setDescription(formattedPokemonList || 'No Pokémon Found')
		.setFooter({ text: `Showing ${start + 1}-${end > pokemonList.length ? pokemonList.length : end} of ${pokemonList.length} Pokémon` })
		.setTimestamp();
		
	return embed;
}

function getPartyBtns() {
	return new ActionRowBuilder()
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
}

function getDisablePartyBtns() {
	return new ActionRowBuilder()
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
}

//Helper function, .dex Embed Generator
function updateEmbed(shinyImg, dexNumber, pokemonRow, selectedForm, pokeList, genders, caughtCount) {
	const shinyImageLinks = JSON.parse(pokemonRow.shinyImageLinks);
	const imgLinks = JSON.parse(pokemonRow.imageLinks);

	const imageLink = shinyImg ? shinyImageLinks[selectedForm] || shinyImageLinks.default : imgLinks[selectedForm] || imgLinks.default;

	const formTypes = getFormTypes(pokemonRow.name, selectedForm, pokeList);
	let type1Field = '';
	let type2Field = '';
	let genderRatio = '';
	let ownedVar = '';
	if (formTypes.formFound === true) {
		type1Field = formTypes.type1;
		type2Field = formTypes.type2 ? ` / ${formTypes.type2}` : '';
	}
	else {
		type1Field = pokemonRow.type1;
		type2Field = pokemonRow.type2 ? ` / ${pokemonRow.type2}` : '';
	}
	if (selectedForm.toLowerCase() !== 'default' && selectedForm.toLowerCase() !== '') {
		selectedForm = `(${selectedForm})`;
	}

	if (selectedForm.toLowerCase().includes('(f)') || selectedForm.toLowerCase().includes('(m)')) {
		selectedForm = `${selectedForm.substring(0, selectedForm.length - 5)})`;
	}
	
	if (genders.length === 2) {
		genderRatio = `♂ ` + genders[0].percentage + '% - ' + `♀ ` + genders[1].percentage + '%';
	}
	else if (genders.length === 1) {
		if (genders[0].name === 'Male') {
			genderRatio = `♂ ` + genders[0].percentage + '%';
		}
		else if (genders[0].name === 'Female') {
			genderRatio = `♀ ` + genders[0].percentage + '%';
		}
		else {
			genderRatio = 'Unknown';
		}
	}
	else {
		genderRatio = 'Unknown';
	}

	if (caughtCount === 0) {
		ownedVar = 'Not owned';
	}
	else {
		ownedVar = `${caughtCount}`;
	}

	return new EmbedBuilder()
		.setColor('#0099ff')
		.setTitle(`${pokemonRow.name} - #${dexNumber} ${selectedForm}`)
		.addFields(
			{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
			{ name: 'Region', value: `${pokemonRow.region}`, inline: true },
			{ name: 'Gender Ratio', value: `${genderRatio}`, inline: true },
			{ name: 'Owned:', value: `${ownedVar}`, inline: true },
		)
		.setImage(imageLink)
		.setTimestamp();
}

//Helper function, query for form + name to get typings
function getFormTypes(name, form, pokeList) {
	const dexEntry = `${form} ${name}`.trim();
	//filter by: pokeList[i].isLM = 3 && pokeList[i].name = dexEntry\
	const filteredList = pokeList.filter(pokemon => pokemon.isLM === 3 && pokemon.name === dexEntry);
	if (filteredList.length > 0) {
		const foundPokemon = filteredList[0];
		return {
			formFound: true,
			type1: foundPokemon.type1,
			type2: foundPokemon.type2
		};
	}
	else {
		return {
			formFound: false,
			type1: '',
			type2: ''
		};
	}
}

//Helper function, leaderboard generator
function generateLeaderboardEmbed(users, page, pageSize, title) {
	const start = page * pageSize;
	const end = start + pageSize;
	const pageData = users.slice(start, end);
	
	return new EmbedBuilder()
		.setColor('#0099ff')
		.setTitle(title)
		.setDescription(pageData.map((user, index) => `**${start + index + 1}.** ${user.name} - ${user.value}`).join('\n'))
		.setFooter({ text: `Page ${page + 1} of ${Math.ceil(users.length / pageSize)}` })
		.setTimestamp();
}

//Helper function, lb generator with button interactions
async function sendLeaderboard(message, users, title) {
	const pageSize = 20;
	let page = 0;

	const embed = generateLeaderboardEmbed(users, page, pageSize, title);

	const buttonRow = new ActionRowBuilder()
		.addComponents(
			new ButtonBuilder()
				.setCustomId('rewindPage')
				.setLabel('⏪')
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId('prevPage')
				.setLabel('◀')
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId('nextPage')
				.setLabel('▶')
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId('fforwardPage')
				.setLabel('⏩')
				.setStyle(ButtonStyle.Primary)
		);

	const sentMessage = await message.channel.send({ embeds: [embed], components: [buttonRow] });

	const filter = i => i.user.id === message.author.id;
	const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

	collector.on('collect', async i => {
		try {
			if (i.customId === 'rewindPage') {
				page = 0;
			}
			else if (i.customId === 'prevPage') {
				if (page > 0) {
					page--;
				}
				else {
					page = Math.ceil(users.length / pageSize) - 1;
				}
			} 
			else if (i.customId === 'fforwardPage') {
				page = Math.ceil(users.length / pageSize) - 1;
			}
			else if (i.customId === 'nextPage') {
				if ((page + 1) * pageSize < users.length) {
					page++;
				}
				else {
					page = 0;
				}
			}
	
			await i.update({ embeds: [generateLeaderboardEmbed(users, page, pageSize, title)] });
		} catch (error) {
			if (error.code === 10008) {
				console.log('Failed gracefully.');
			}
			else {
				console.error('An unexpected error occurred:', error);
			}
		}
	});

	collector.on('end', async () => {
		try {
			const disabledRow = new ActionRowBuilder()
				.addComponents(
					new ButtonBuilder()
						.setCustomId('rewindPage')
						.setLabel('⏪')
						.setStyle(ButtonStyle.Primary)
						.setDisabled(true),
					new ButtonBuilder()
						.setCustomId('prevPage')
						.setLabel('◀')
						.setStyle(ButtonStyle.Primary)
						.setDisabled(true),
					new ButtonBuilder()
						.setCustomId('nextPage')
						.setLabel('▶')
						.setStyle(ButtonStyle.Primary)
						.setDisabled(true),
					new ButtonBuilder()
						.setCustomId('fforwardPage')
						.setLabel('⏩')
						.setStyle(ButtonStyle.Primary)
						.setDisabled(true),
				);
			await sentMessage.edit({ components: [disabledRow] });
		} catch (error) {
			if (error.code === 10008) {
				console.log('Failed gracefully.');
			}
			else {
				console.error('An unexpected error occurred:', error);
			}
		}
	});
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

//Helper function, help handle some weird pokemon names that are a little weird
//Takes in an all lowercase pokemon name, except a capitalized first letter
function fixPokemonName(pokemonIdentifier, args) {
	if (pokemonIdentifier === 'Farfetchd' || pokemonIdentifier === 'Farfetch’d' || pokemonIdentifier === 'Farfetch‘d') {
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
	else if (pokemonIdentifier === 'Mr.mime' || pokemonIdentifier === 'Mrmime') { //length > 2
		pokemonIdentifier = 'Mr. Mime';
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
	else if (pokemonIdentifier === 'Mimejr' || pokemonIdentifier === 'Mimejr.') {
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
	else if (pokemonIdentifier === 'Flabebe') {
		pokemonIdentifier = 'Flabébé';
	}
	
	return pokemonIdentifier;
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

//Check Permissions
function hasPermissions(channel, permissions) {
	return channel.permissionsFor(channel.guild.members.me).has(permissions);
}

const dropCommandRegex = /^\.(drop|d)\b/;
const setChannelCommandRegex = /^\.(setchannel|setchannels)\b/;
const viewChannelCommandRegex = /^\.(viewchannels)\b/;
const resetChannelCommandRegex = /^\.(resetchannels)\b/;
const viewCommandRegex = /^\.(view|v)\b/;
const partyCommandRegex = /^\.(party|p)\b/;
const currencyCommandRegex = /^\.(currency|c|bal)\b/;
const helpCommandRegex = /^\.(help)\b/;
const hintCommandRegex = /^\.(hint|h)\b/;
const releaseCommandRegex = /^\.(release|r)\b/;
const tradeCommandRegex = /^\.(trade|t)\b/;
const dexCommandRegex = /^\.(dex)\b/;
const forceSpawnCommandRegex = /^\.(forcespawn)\b/;
const leaderboardCommandRegex = /^\.(leaderboard|lb)\b/;
const countCommandRegex = /^\.(count)\b/;
const shopCommandRegex = /^\.(shop|s)\b/;
const buyCommandRegex = /^\.(buy|b)\b/;
const inventoryCommandRegex = /^\.(inventory|i)\b/;
const giveCCmdRegex = /^\.(give)\b/; //For people who find bugs
const changeLogRegex = /^\.(changelog|log)\b/;
const orderCommandRegex = /^\.(order|sort|o)\b/;
const uncaughtCommandRegex = /^\.(uncaught|u)\b/;
const remindCommandRegex = /^\.(remind)\b/;
const useCommandRegex = /^\.(use)\b/;
const compareCommandRegex = /^\.(compare)\b/;
const teamCommandRegex = /^\.(team)\b/;

const maxDexNum = 721; //number x is max pokedex entry - EDIT WHEN ADDING MORE POKEMON

client.on('ready', () => {
	console.log(`Logged in as ${client.user.tag}`);
	dbUser.run("CREATE TABLE IF NOT EXISTS user (user_id TEXT PRIMARY KEY, caught_pokemon TEXT, currency INTEGER DEFAULT 0, inventory TEXT DEFAULT '[]', servers TEXT DEFAULT '[]')");
	dbServer.run("CREATE TABLE IF NOT EXISTS server (server_id TEXT PRIMARY KEY, allowed_channels_id TEXT)")});

client.on('messageCreate', (message) => {
	if (!message.author.bot) {
		if (message.content.length > 0) {
			const serverId = message.guild.id;
			const userId = message.author.id;
			const now = Date.now();

			if(!hasPermissions(message.channel, requiredPermissions)) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					//message somewhere in the future about lacking perms, something with default .setChannels settings
					return;
				});
			}
			
			//drop
			if (dropCommandRegex.test(message.content.toLowerCase())) {
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
					setTimeout(() => {
						cooldowns.delete(userId)
						if (cooldownAlerts.has(userId) && cooldownAlerts.get(userId)) {
							message.channel.send(`<@!${userId}>, your drop is off cooldown!`);
						}
					}, 300000);
					
					dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, caughtPokemonList) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your caught Pokémon.');
							return;
						}

						const caughtPokemon = caughtPokemonList && caughtPokemonList.caught_pokemon ? JSON.parse(caughtPokemonList.caught_pokemon).flat().map(p => ({ 
							name: p.name.startsWith('✨') ? p.name.slice(1) : p.name,
							gender: p.gender 
						})) : [];

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
								
								let pokemon = null;
								let embedColor = '#0099FF';
	
								const userRepels = activeUserRepels.get(userId);
								let repelList = rows.filter(row => row.isLM !== 3);

								let s = false; //shiny
								let l = false; //legendary
								let m = false; //mythical

								if (userRepels) {
									let standardRepel = null; 
									let rareRepel = null;
									if (userRepels.standard) {
										standardRepel = userRepels.standard;
									}
									if (userRepels.rare) {
										rareRepel = userRepels.rare;
									}

									if (rareRepel) {
										if (rareRepel === 'Legendary Repel') {
											l = true;
										}
										else if (rareRepel === 'Mythical Repel') {
											m = true;
										}
										else if (rareRepel === 'Shiny Repel') {
											s = true;
										}
									}

									if (standardRepel) {
										const hasCaughtPokemon = (pokemon) => {
											if (pokemon.name === 'Nidoran') {
												const pokemonGenderList = JSON.parse(pokemon.gender);
												const isFemale = pokemonGenderList.some(g => g.name === 'Female');
												const isMale = pokemonGenderList.some(g => g.name === 'Male');
			
												if (isFemale) {
													return caughtPokemon.some(cp => cp.name === 'Nidoran' && cp.gender === 'Female');
												}
												else if (isMale) {
													return caughtPokemon.some(cp => cp.name === 'Nidoran' && cp.gender === 'Male');
												}
											}
											return caughtPokemon.some(cp => cp.name === pokemon.name);
										};

										let uncaughtPokemon = repelList.filter(pokemon => !hasCaughtPokemon(pokemon));
										if (l) {
											uncaughtPokemon = uncaughtPokemon.filter(pokemon => pokemon.isLM == 1);
										}
										else if (m) {
											uncaughtPokemon = uncaughtPokemon.filter(pokemon => pokemon.isLM == 2);
										}


										//user caught all pokemon
										if (uncaughtPokemon.length === 0) {
											message.channel.send('You have caught all pokemon, repel will be given back.');
											uncaughtPokemon = rows.filter(row => row.isLM !== 3);
										}

										const randRepelNum = Math.random();
										if (standardRepel === 'Normal Repel') {
											if (randRepelNum < 0.5) {
												message.channel.send('Repel worked successfully.');
												repelList = uncaughtPokemon;
											}
										}
										else if (standardRepel === 'Super Repel') {
											if (randRepelNum < 0.75) {
												message.channel.send('Repel worked successfully.');
												repelList = uncaughtPokemon;
											}
										}
										else if (standardRepel === 'Max Repel') {
											if (randRepelNum < 0.9) {
												message.channel.send('Repel worked successfully.');
												repelList = uncaughtPokemon;
											}
										}
									}

									activeUserRepels.delete(userId);
								}

								if (shinyNumber < 0.00025 || s) {
									isShiny = true;
								}

								if ((mythicalNumber < 0.005 || m) && !l) {
										isMythical = true;
								}
								else if (s && mythicalNumber < 0.025) {
									isMythical = true;
								}
								else if (legendaryNumber < 0.0075 || l) {
									isLegendary = true;
								}
								else if (s && legendaryNumber < 0.05) {
									isLegendary = true;
								}

								if (isMythical) {
									let rowsM = repelList.filter(row => row.isLM === 2);
									if (rowsM.length === 0) {
										rowsM = rows.filter(row => row.isLM === 2);
									}
									if (rowsM.length > 0) {
										pokemon = rowsM[getRandomInt(rowsM.length)];
										embedColor = '#FF96C5';
									}
									else {
										console.log("Error, no mythical pokemon!");
									}
								}
								else if (isLegendary) {
									let rowsL = repelList.filter(row => row.isLM === 1);
									if (rowsL.length === 0) {
										rowsL = rows.filter(row => row.isLM === 1);
									}
									if (rowsL.length > 0) {
										pokemon = rowsL[getRandomInt(rowsL.length)];
										embedColor = '#66FF00';
									}
									else {
										console.log("Error, no mythical pokemon!");
									}
								}
								else {
									let rowsN = repelList.filter(row => row.isLM !== 2 && row.isLM !== 1);
									if (rowsN.length === 0) {
										rowsN = rows.filter(row => row.isLM !== 3 && row.isLM !== 2 && row.isLM !== 1);
									}
									pokemon = rowsN[getRandomInt(rowsN.length)];
									embedColor = '#0099FF';
									while (pokemon.isLM !== 0) {
										pokemon = rowsN[getRandomInt(rowsN.length)];
									}
								}
								
								const genders = JSON.parse(pokemon.gender);
								let randomPercentage = Math.random() * 100;
								let selectGender;
								let cumulativePercentage = 0;
								for (const gender of genders) {
									cumulativePercentage += gender.percentage;
									if (randomPercentage <= cumulativePercentage) {
										selectGender = gender;
										break;
									}
								}
	
								const forms = JSON.parse(pokemon.forms);
								randomPercentage = Math.random() * 100;
								let selectForm;
								cumulativePercentage = 0;
								for (const form of forms) {
									cumulativePercentage += form.percentage;
									if (randomPercentage <= cumulativePercentage) {
										selectForm = form;
										break;
									}
								}
	
								if (selectGender.name === 'Female' && selectForm.name.includes('(M)')) {
									selectGender = {
										name: 'Male',
										percentage: selectGender.percentage
									};
								}
								else if (selectGender.name === 'Male' && selectForm.name.includes('(F)')) {
									selectGender = {
										name: 'Female',
										percentage: selectForm.percentage
									};
								}
	
								let imageLink = null;
								if (isShiny) {
									embedColor = '#FFD700';
									const shinyImageLinks = JSON.parse(pokemon.shinyImageLinks);
									imageLink = shinyImageLinks[selectForm.name] || shinyImageLinks.default;
								}
								else {
									const imageLinks = JSON.parse(pokemon.imageLinks);
									imageLink = imageLinks[selectForm.name] || imageLinks.default;
								}
	
								if (selectForm.name.includes('(F)') || selectForm.name.includes('(M)')) {
									selectForm = {
										name: selectForm.name.substring(0, selectForm.name.length - 4),
										percentage: selectForm.percentage
									};
								}
								
								const type2 = pokemon.type2 ? ` / ${pokemon.type2}` : '';
								const curMon = pokemon.name ? `${pokemon.name}` : '';
								console.log('Current pokemon: ' + curMon + '\n' + 
									'ShinyNum:     ' + shinyNumber + ' (<0.00025)' + '\n' + 
									'MythicalNum:  ' + mythicalNumber + ' (<0.005)' + '\n' + 
									'LegendaryNum: ' + legendaryNumber + ' (<0.0075)' +'\n' +
									'Form: ' + selectForm.name + '\n' +
									'Gender: ' + selectGender.name + '\n');
								
								activeDrops.set(`${serverId}_${message.channel.id}`, { name: curMon, isShiny, form: selectForm.name, gender: selectGender.name });
								
								const embed = new EmbedBuilder()
									.setColor(embedColor)
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
				});
			}

			//FOR DEV USE ONLY, doesn't work for nidoran for some reason
			else if(message.content.toLowerCase() === '.filldex' && userId === '177580797165961216') {
				dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, rows) => {
					if (err) {
						console.error(err.message);
						message.channel.send('An error occurred while fetching your Pokémon.');
						return;
					}
					db.all("SELECT * FROM pokemon", [], (err, allPokemonList) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching Pokémon data.');
							return;
						}
						let allList = allPokemonList.filter(row => row.isLM !== 3);
						let userMons = JSON.parse(rows.caught_pokemon);
						for(let i = 0; i < allList.length; i++) {
							let pokemon = allList[i];
							const genders = JSON.parse(pokemon.gender);
							let randomPercentage = Math.random() * 100;
							let selectGender;
							let cumulativePercentage = 0;
							for (const gender of genders) {
								cumulativePercentage += gender.percentage;
								if (randomPercentage <= cumulativePercentage) {
									selectGender = gender;
									break;
								}
							}

							const forms = JSON.parse(pokemon.forms);
							randomPercentage = Math.random() * 100;
							let selectForm;
							cumulativePercentage = 0;
							for (const form of forms) {
								cumulativePercentage += form.percentage;
								if (randomPercentage <= cumulativePercentage) {
									selectForm = form;
									break;
								}
							}

							if (selectGender.name === 'Female' && selectForm.name.includes('(M)')) {
								selectGender = {
									name: 'Male',
									percentage: selectGender.percentage
								};
							}
							else if (selectGender.name === 'Male' && selectForm.name.includes('(F)')) {
								selectGender = {
									name: 'Female',
									percentage: selectForm.percentage
								};
							}

							if (selectForm.name.includes('(F)') || selectForm.name.includes('(M)')) {
								selectForm = {
									name: selectForm.name.substring(0, selectForm.name.length - 4),
									percentage: selectForm.percentage
								};
							}

							userMons.push({ name: pokemon.name, gender: selectForm.name, form: selectForm.name });
						}

						dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(userMons), userId], (err) => {
							if (err) {
								console.error(err.message);
							}
							message.channel.send('Gave you all pokemon.');
						})
					});
				});
			}

			//fix pokemon's objects (default -> male)
			else if (message.content.toLowerCase() === '.fixmon' && userId === '177580797165961216') {
				dbUser.all("SELECT user_id, caught_pokemon FROM user", [], (err, rows) => {
					if (err) {
						console.error(err.message);
						message.channel.send('An error occurred while fetching your Pokémon.');
						return;
					}
					db.all("SELECT * FROM pokemon", [], (err, allPokemonList) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching Pokémon data.');
							return;
						}
						rows.forEach((row) => {
							if (!row.caught_pokemon) {
								console.log(`User ${row.user_id} has no Pokémon to fix.`);
								return;
							}
							//get list of all user's pokemon
							let userPokemonList = JSON.parse(row.caught_pokemon);
							//filter list by form = 'Default'
							//get dexNum of the filtered list
							let defaultFormPokemon = userPokemonList.filter(pokemon => pokemon.form.toLowerCase() === 'default');
							
							for (let i = 0; i < defaultFormPokemon.length; i++) {
								let curNMame = defaultFormPokemon[i].name;
								let filteredList = allPokemonList.filter(pokemon => pokemon.name === curNMame);
								if (filteredList.length > 0) {
									let forms = JSON.parse(filteredList[0].forms);
									let hasDefault = forms.some(form => form.name.toLowerCase() === 'default');
									if (!hasDefault) {
										defaultFormPokemon[i].form = forms[0].name;
									}
								}
							}
							dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(userPokemonList), row.user_id], (err) => {
								if (err) {
									console.error(`Error updating Pokémon for user ${row.user_id}:`, err.message);
								} else {
									console.log(`Successfully updated Pokémon for user ${row.user_id}`);
								}
							});
						});
						message.channel.send('Finished fixing Pokémon forms for all users.');
					});
				});
			}
			
			//force a spawn
			else if (forceSpawnCommandRegex.test(message.content.toLowerCase()) && userId === '177580797165961216') {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const args = message.content.split(' ');
					if (args.length < 2) {
						message.channel.send('Please specify a valid pokedex number. Usage: `.forceSpawn <PokedexNum>`');
						return;
					}
					
					let pokemonIdentifier = args[1];
					let isNumber = !isNaN(pokemonIdentifier);
					if (!isNumber) {
						message.channel.send('Please specify a valid pokedex number. Usage: `.forceSpawn <PokedexNum>`');
					}
					else {
						db.get("SELECT * FROM pokemon WHERE dexNum = ?", [pokemonIdentifier], (err, pokemon) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching Pokémon information.');
								return;
							}
							if (!pokemon) {
								message.channel.send('Pokémon not found in the database.');
								return;
							}
							
							const shinyNumber = Math.random();
							let isShiny = false;
							
							if (shinyNumber < 0.00025) {
								isShiny = true;
							}

							const genders = JSON.parse(pokemon.gender);
							let randomPercentage = Math.random() * 100;
							let selectGender;
							let cumulativePercentage = 0;
							for (const gender of genders) {
								cumulativePercentage += gender.percentage;
								if (randomPercentage <= cumulativePercentage) {
									selectGender = gender;
									break;
								}
							}
							
							const forms = JSON.parse(pokemon.forms);
							randomPercentage = Math.random() * 100;
							let selectForm;
							cumulativePercentage = 0;
							for (const form of forms) {
								cumulativePercentage += form.percentage;
								if (randomPercentage <= cumulativePercentage) {
									selectForm = form;
									break;
								}
							}

							if (selectGender.name === 'Female' && selectForm.name.includes('(M)')) {
								selectGender = {
									name: 'Male',
									percentage: selectGender.percentage
								};
							}
							else if (selectGender.name === 'Male' && selectForm.name.includes('(F)')) {
								selectGender = {
									name: 'Female',
									percentage: selectGender.percentage
								};
							}
							
							let imageLink = null;
							if (isShiny) {
								const shinyImageLinks = JSON.parse(pokemon.shinyImageLinks);
								imageLink = shinyImageLinks[selectForm.name] || shinyImageLinks.default;
							}
							else {
								const imageLinks = JSON.parse(pokemon.imageLinks);
   					 			imageLink = imageLinks[selectForm.name] || imageLinks.default;
							}

							if (selectForm.name.includes('(F)') || selectForm.name.includes('(M)')) {
								selectForm = {
									name: selectForm.name.substring(0, selectForm.name.length - 4),
									percentage: selectForm.percentage
								};
							}
							
							const type2 = pokemon.type2 ? ` / ${pokemon.type2}` : '';
							const curMon = pokemon.name ? `${pokemon.name}` : '';

							console.log('Name: ' + pokemon.name + '\nShinyNum: ' + shinyNumber + ' (<0.00025)' + '\nForm: ' + selectForm.name + '\nGender: ' + selectGender.name + '\n');
							
							activeDrops.set(`${serverId}_${message.channel.id}`, { name: curMon, isShiny, form: selectForm.name, gender: selectGender.name });
							
							const embed = new EmbedBuilder()
								.setColor('#0099ff')
								.addFields(
									{ name: 'Type', value: `${pokemon.type1}${type2}`, inline: true },
									{ name: 'Region', value: `${pokemon.region}`, inline: true }
								)
								.setImage(imageLink)
								.setTimestamp()
								
							message.channel.send({ embeds: [embed] });
						});
					}
				});
			}
			
			//catch
			else if ( activeDrops.has(`${serverId}_${message.channel.id}`) && (
				   (message.content.toLowerCase() === activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase())
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'farfetch\'d' && message.content.toLowerCase() === 'farfetchd')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'farfetch\'d' && message.content.toLowerCase() === 'farfetch’d')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'farfetch\'d' && message.content.toLowerCase() === 'farfetch‘d')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mr. mime' && message.content.toLowerCase() === 'mr mime')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mr. mime' && message.content.toLowerCase() === 'mr.mime')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mr. mime' && message.content.toLowerCase() === 'mrmime')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'ho-oh' && message.content.toLowerCase() === 'ho oh')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'ho-oh' && message.content.toLowerCase() === 'hooh')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mime jr.' && message.content.toLowerCase() === 'mime jr')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mime jr.' && message.content.toLowerCase() === 'mimejr')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mime jr.' && message.content.toLowerCase() === 'mimejr.')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'spoink' && message.content.toLowerCase() === 'boingo')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'porygon-z' && message.content.toLowerCase() === 'porygon z')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'porygon-z' && message.content.toLowerCase() === 'porygonz')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'flabébé' && message.content.toLowerCase() === 'flabebe'))) { //edge case
				
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const curMon = activeDrops.get(`${serverId}_${message.channel.id}`);
					const curMonName = curMon.name;
					const form = curMon.form;
					const gender = curMon.gender
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
						let shinyMon;
						if (isShinyVar) {
							shinyMon = [{
								name: `✨${curMonName}`,
								gender: gender,
								form: form,
							}];
						}
						else {
							shinyMon = [{
								name: curMonName,
								gender: gender,
								form: form,
							}];
						}

						let genderSymbol = '';
						if (gender === 'Male') {
							genderSymbol = '♂\u200B ';//'♂️';
						}
						else if (gender === 'Female') {
							genderSymbol = '♀\u200B ';//'♀';
						}

						let formName = '';
						if (form !== 'Default') {
							formName = form + ' ';
						}
						
						let userDisplayName = '';
						if (message.guild.members.cache.get(userId).displayName.toLowerCase().includes("@everyone") || message.guild.members.cache.get(userId).displayName.toLowerCase().includes("@here")) {
							userDisplayName = "Someone";
						}
						else {
							userDisplayName = message.guild.members.cache.get(userId).displayName;
						}
						
						const messageText = isShinyVar
							? `Added ✨${formName}${curMonName} \`${genderSymbol}\` to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`
							: `Added ${formName}${curMonName} ${genderSymbol}to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`;
						
						message.channel.send(messageText);
						
						dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
							if (err) {
								console.error(err.message);
								return;
							}
							if (!row) {
								// User isn't in the database, add them
								dbUser.run("INSERT INTO user (user_id, caught_pokemon, currency, servers) VALUES (?, ?, ?, ?)", [userId, JSON.stringify(shinyMon), coinsToAdd, JSON.stringify(serverId)], (err) => {
									if (err) {
										console.error(err.message);
									}
									activeDrops.delete(`${serverId}_${message.channel.id}`);
								});
							} 
							else {
								// User is in the database, update their caught Pokémon & currency
								const caughtPokemon = JSON.parse(row.caught_pokemon);
								let newList = caughtPokemon.concat(shinyMon);
								const newCurrency = row.currency + coinsToAdd;
								let serverList = JSON.parse(row.servers);
								if (!serverList.includes(serverId)) {
									serverList.push(serverId);
								}
								dbUser.run("UPDATE user SET caught_pokemon = ?, currency = ?, servers = ? WHERE user_id = ?", [JSON.stringify(newList), newCurrency, JSON.stringify(serverList), userId], (err) => {
									if (err) {
										console.error(err.message);
									}
									activeDrops.delete(`${serverId}_${message.channel.id}`);
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
						try {
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
						} catch (error) {
							if (error.code === 10008) {
								console.log('Failed gracefully.');
							}
							else {
								console.error('AN unexpected error occurred:', error);
							}
						}
					});

					collector.on('end', async () => {
						try {
							await sentMessage.edit({components: [] });
						} catch (error) {
							if (error.code === 10008) {
								console.log('Failed gracefully.');
							}
							else {
								console.error('AN unexpected error occurred:', error);
							}
						}
					});
				}).catch(err => {
					console.error('Error sending the reset channels message:', err);
				});
			}

			//give DEVELOPMENT:to be erased
			else if (giveCCmdRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					if (userId !== '177580797165961216') {
						message.channel.send('User does not have permission for this command!');
						return;
					}
					const args = message.content.split(' ').slice(1);
					if (args.length < 2) {
						message.channel.send('Requires 2 args: .give <userID> <amount>');
						return;
					}
					else {
						const userR = args[0];
						const coinsToAdd = args[1];
						if (isNaN(coinsToAdd) || coinsToAdd === '') {
							message.channel.send('Syntax error - Requires 2 args: .give <userID> <amount>');
							return;
						}
						dbUser.get("SELECT * FROM user WHERE user_id = ?", [userR], (err, row) => {
							if (err) {
								console.error(err.message);
								return;
							}
							if (!row) {
								message.channel.send('User not found in database.');
								return;
							}
							else {
								const newCurrency = row.currency + parseInt(coinsToAdd);
								dbUser.run("UPDATE user SET currency = ? WHERE user_id = ?", [newCurrency, userR], (err) => {
									if (err) {
										console.error(err.message);
									}
									message.channel.send(`Successfully transfered ${coinsToAdd} to user.`);
								});
							}
						});
					}
				});
			}

			//log
			else if (changeLogRegex.test(message.content.toLowerCase())) { 
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const helpEmbed = new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Change Log')
						.setDescription('Recently added Changes')
						.addFields(
							{ name: 'ANNOUNCEMENT:', value: 'For any bug found, you may recieve currency in the range 100-5000!' },
							{ name: 'Add .team:', value: 'Allows users to look at the first 6 of someone else\'s party.' },
							{ name: 'Add .compare:', value: 'Allows users to see what pokemon a user has compared to what they don\'t have.' },
							{ name: 'Dex Update:', value: 'Added how many you own when you look at pokemon in .dex.' },
							{ name: 'Repel Exploit:', value: 'Fixed a repel exploit where users had the dex filled out, forcing a mythical.' },
							{ name: 'Updated Shop/Drop:', value: 'Added repels to the store for drops.' },
							{ name: 'Updated Buy:', value: 'Added quantity option.' },
							{ name: 'Updated Shop:', value: 'Added various items to the store for pokemon\'s forms.' },
							{ name: 'Remind Command:', value: 'Added .remind to get notified when your drop is off cooldown.' },
							{ name: 'Use Command:', value: 'Allows you to use some items on pokemon to change their forms.' },
						)
						.setTimestamp();

					message.channel.send({ embeds: [helpEmbed] });
				});
			}

			//reminder
			else if(remindCommandRegex.test(message.content.toLowerCase())) {
				if (cooldownAlerts.has(userId) && cooldownAlerts.get(userId)) {
					cooldownAlerts.set(userId, false);
					message.channel.send(`<@!${userId}>, you won't be alerted when your drop is off cooldown.`);
				}
				else {
					cooldownAlerts.set(userId, true);
					message.channel.send(`<@!${userId}>, you'll be alerted when your drop is off cooldown.`);
				}
			}
			
			//uncaught
			else if(uncaughtCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your caught Pokémon.');
							return;
						}

						const caughtPokemon = row && row.caught_pokemon ? JSON.parse(row.caught_pokemon).flat().map(p => ({ 
							name: p.name.startsWith('✨') ? p.name.slice(1) : p.name,
							gender: p.gender 
						})) : [];

						db.all("SELECT name, dexNum, isLM, gender FROM pokemon WHERE isLM != 3", [], (err, allPokemonList) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the Pokémon database.');
								return;
							}
							if (!allPokemonList) {
								console.message('No Pokémon in database.');
								return;
							}

							const hasCaughtPokemon = (pokemon) => {
								if (pokemon.name === 'Nidoran') {
									const pokemonGenderList = JSON.parse(pokemon.gender);
									const isFemale = pokemonGenderList.some(g => g.name === 'Female');
									const isMale = pokemonGenderList.some(g => g.name === 'Male');

									if (isFemale) {
										return caughtPokemon.some(cp => cp.name === 'Nidoran' && cp.gender === 'Female');
									}
									else if (isMale) {
										return caughtPokemon.some(cp => cp.name === 'Nidoran' && cp.gender === 'Male');
									}
								}
								return caughtPokemon.some(cp => cp.name === pokemon.name);
							};

							const uncaughtPokemon = allPokemonList.filter(pokemon => !hasCaughtPokemon(pokemon));

							if (uncaughtPokemon.length === 0) {
								message.channel.send('You have caught all available Pokémon!');
                    			return;
							}

							const pageSize = 20;
							let page = 0;

							const generateUncaughtEmbed = (uncaughtList, page, pageSize) => {
								const start = page * pageSize;
								const end = start + pageSize;
								const pageData = uncaughtList.slice(start, end);

								return new EmbedBuilder()
									.setColor('#0099ff')
									.setTitle('Your Uncaught Pokémon')
									.setDescription(pageData.map((pokemon, index) => {
										// Display gender for Nidoran only
										if (pokemon.name === 'Nidoran' && pokemon.gender) {
											const pokemonGenderList = JSON.parse(pokemon.gender);
											if (pokemonGenderList.some(g => g.name === 'Female')) {
												return `\`${pokemon.dexNum}\` ${pokemon.name} (♀)`;
											}
											if (pokemonGenderList.some(g => g.name === 'Male')) {
												return `\`${pokemon.dexNum}\` ${pokemon.name} (♂)`;
											}
										}
										return `\`${pokemon.dexNum}\` ${pokemon.name}`;
									}).join('\n'))
									.setFooter({ text: `Page ${page + 1} of ${Math.ceil(uncaughtList.length / pageSize)}` })
									.setTimestamp();
							};

							const buttonRow = new ActionRowBuilder()
								.addComponents(
									new ButtonBuilder()
										.setCustomId('prevPage')
										.setLabel('◀')
										.setStyle(ButtonStyle.Primary),
									new ButtonBuilder()
										.setCustomId('nextPage')
										.setLabel('▶')
										.setStyle(ButtonStyle.Primary)
								);
							const embed = generateUncaughtEmbed(uncaughtPokemon, page, pageSize);

							message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
								const filter = i => i.user.id === userId;
								const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

								collector.on('collect', async i => {
									try {
										if (i.customId === 'prevPage') {
											page = page - 1;
											if (page < 0) {
												page = Math.ceil(uncaughtPokemon.length / pageSize) - 1;
											}
										}
										else if (i.customId === 'nextPage') {
											page = page + 1;
											if (page > Math.ceil(uncaughtPokemon.length / pageSize) - 1) {
												page = 0;
											}
										}

										const updatedEmbed = generateUncaughtEmbed(uncaughtPokemon, page, pageSize);
										await i.update({ embeds: [updatedEmbed] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});

								collector.on('end', async () => {
									try {
										const disabledRow = new ActionRowBuilder()
											.addComponents(
												new ButtonBuilder()
													.setCustomId('prevPage')
													.setLabel('◀')
													.setStyle(ButtonStyle.Primary)
													.setDisabled(true),
												new ButtonBuilder()
													.setCustomId('nextPage')
													.setLabel('▶')
													.setStyle(ButtonStyle.Primary)
													.setDisabled(true)
											);
										await sentMessage.edit({ components: [disabledRow] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});
							}).catch(err => {
								console.error('Error sending the uncaught Pokémon list:', err);
							});
						});
					});
				});
			}

			//leaderboard
			else if (leaderboardCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const args = message.content.split(' ').slice(1);
					
					if (args.length === 0) {
						//default, display total pokemon caught
						dbUser.all("SELECT user_id, caught_pokemon FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the leaderboard.');
								return;
							}
                
							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon) {
									return null;
								}
								const user = await client.users.fetch(row.user_id).catch(() => null);
								
								let caughtPokemonList = JSON.parse(row.caught_pokemon).flat();
								let totalPokemonCount = caughtPokemonList.length;

								return totalPokemonCount > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value: totalPokemonCount
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send('No users have caught Pokémon yet.');
								return;
							}
							filteredUsers.sort((a, b) => b.value - a.value);
							sendLeaderboard(message, filteredUsers, 'Total Pokémon Caught Leaderboard');
						});
					}
					else if (args[0].toLowerCase() === 'c' || args[0].toLowerCase() === 'currency') {
						//display currency leaderboard
						let serverLb = false;
						if (args.length > 1 && args[1].toLowerCase() === 'server') {
							serverLb = true;
						}
						dbUser.all("SELECT user_id, currency, servers FROM user ORDER BY currency DESC", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the currency leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (serverLb) {
									if (!row.servers) {
										return null;
									}
									const userServers = JSON.parse(row.servers);
									if (!userServers.includes(serverId)) {
										return null;
									}
								}

								const user = await client.users.fetch(row.user_id).catch(() => null);
								const value = row.currency || 0;

								return value > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send(serverLb ? 'No users have currency in this server yet.' : 'No users have currency yet.');
								return;
							}
							filteredUsers.sort((a, b) => b.value - a.value);
							const leaderboardTitle = serverLb ? 'Server Currency Leaderboard' : 'Currency Leaderboard';
							sendLeaderboard(message, filteredUsers, leaderboardTitle);
						});
					}

					else if (args[0].toLowerCase() === 's' || args[0].toLowerCase() === 'shiny') {
						//display shiny leaderboard
						let serverLb = false;
						if (args.length > 1 && args[1].toLowerCase() === 'server') {
							serverLb = true;
						}
						dbUser.all("SELECT user_id, caught_pokemon, servers FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the shiny leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon || (serverLb && !row.servers)) {
									return null;
								}

								if (serverLb) {
									const userServers = JSON.parse(row.servers);
									if (!userServers.includes(serverId)) {
										return null;
									}
								}

								const user = await client.users.fetch(row.user_id).catch(() => null);

								let caughtPokemonList = JSON.parse(row.caught_pokemon).flat();
								const shinyCount = caughtPokemonList
								.map(pokemon => pokemon.name)
								.filter(pokemonName => typeof pokemonName === 'string' && pokemonName.startsWith('✨'))
								.length;

								return shinyCount > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value: shinyCount
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send(serverLb ? 'No users have caught a shiny in this server yet.' : 'No users have caught a shiny yet.');
								return;
							}
							filteredUsers.sort((a, b) => b.value - a.value);
							const leaderboardTitle = serverLb ? 'Server Shiny Pokémon Leaderboard' : 'Shiny Pokémon Leaderboard';
							sendLeaderboard(message, filteredUsers, leaderboardTitle);
						});
					}

					else if(args[0].toLowerCase() === 'server') {
						dbUser.all("SELECT user_id, caught_pokemon, servers FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the server leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon || !row.servers) {
									return null;
								}
					
								// Parse the servers field to check if the user belongs to the current server
								const userServers = JSON.parse(row.servers);
								if (!userServers.includes(serverId)) {
									return null; // Skip users not part of this server
								}
					
								const user = await client.users.fetch(row.user_id).catch(() => null);
					
								// Process the caught Pokémon list
								let caughtPokemonList = JSON.parse(row.caught_pokemon).flat();
								let totalPokemonCount = caughtPokemonList.length;
					
								// Return the user and total Pokémon count, or null if none caught
								return totalPokemonCount > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value: totalPokemonCount
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send('No users have caught Pokémon in this server yet.');
								return;
							}

							filteredUsers.sort((a, b) => b.value - a.value);
							sendLeaderboard(message, filteredUsers, 'Server Total Pokémon Caught Leaderboard');
						});
					}

					else if (args[0].toLowerCase() === 'l' || args[0].toLowerCase() === 'legendary') {
						//display legendary leaderboard
						let serverLb = false;
						if (args.length > 1 && args[1].toLowerCase() === 'server') {
							serverLb = true;
						}
						// Use in-memory data to make this call a lot faster
						const legendaryPokemon = [
							'Articuno', 'Zapdos', 'Moltres', 'Mewtwo', 
							'Raikou', 'Entei', 'Suicune', 'Lugia', 'Ho-Oh',
							'Regirock', 'Regice', 'Registeel', 'Latias', 'Latios', 'Kyogre', 'Groudon', 'Rayquaza',
							'Uxie', 'Mesprit', 'Azelf', 'Dialga', 'Palkia', 'Heatran', 'Regigigas', 'Giratina', 'Cresselia',
							'Cobalion', 'Terrakion', 'Virizion', 'Tornadus', 'Thundurus', 'Reshiram', 'Zekrom', 'Landorus', 'Kyurem'
						];
						dbUser.all("SELECT user_id, caught_pokemon, servers FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the legendary leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon || (serverLb && !row.servers)) {
									return null;
								}

								if (serverLb) {
									const userServers = JSON.parse(row.servers);
									if (!userServers.includes(serverId)) {
										return null;
									}
								}

								const user = await client.users.fetch(row.user_id).catch(() => null);

								const caughtPokemon = JSON.parse(row.caught_pokemon).flat().map(pokemon => pokemon.name) || [];

								const legendaryCount = caughtPokemon.reduce((acc, pokemonName) => {
									if (typeof pokemonName === 'string') {
										let finalName = pokemonName.startsWith('✨') ? pokemonName.substring(1) : pokemonName;
										if (legendaryPokemon.includes(finalName)) {
											acc += 1;
										}
									}
									return acc;
								}, 0);

								return legendaryCount > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value: legendaryCount
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send(serverLb ? 'No users in this server have caught a legendary yet.' : 'No users have caught a legendary yet.');
								return;
							}
							filteredUsers.sort((a, b) => b.value - a.value);
							const leaderboardTitle = serverLb ? 'Server Legendary Pokémon Leaderboard' : 'Legendary Pokémon Leaderboard';
							sendLeaderboard(message, filteredUsers, leaderboardTitle);
						});
					}

					else if (args[0].toLowerCase() === 'm' || args[0].toLowerCase() === 'mythical' || args[0].toLowerCase() === 'mythic') {
						//display mythical leaderboard
						let serverLb = false;
						if (args.length > 1 && args[1].toLowerCase() === 'server') {
							serverLb = true;
						}
						// Use in-memory data to make this call a lot faster
						const mythicalPokemon = [
							'Mew',
							'Celebi',
							'Jirachi', 'Deoxys',
							'Phione', 'Manaphy', 'Darkrai', 'Shaymin', 'Arceus',
							'Victini', 'Keldeo', 'Meloetta', 'Genesect'
						];
						dbUser.all("SELECT user_id, caught_pokemon, servers FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the mythical leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon || (serverLb && !row.servers)) {
									return null;
								}

								if (serverLb) {
									const userServers = JSON.parse(row.servers);
									if (!userServers.includes(serverId)) {
										return null;
									}
								}

								const user = await client.users.fetch(row.user_id).catch(() => null);
								const caughtPokemon = JSON.parse(row.caught_pokemon).flat().map(pokemon => pokemon.name) || [];

								const mythicalCount = caughtPokemon.reduce((acc, pokemonName) => {
									if (typeof pokemonName === 'string') {
										let finalName = pokemonName.startsWith('✨') ? pokemonName.substring(1) : pokemonName;
										if (mythicalPokemon.includes(finalName)) {
											acc += 1;
										}
									}
									return acc;
								}, 0);

								return mythicalCount > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value: mythicalCount
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send(serverLb ? 'No users in this server have caught a mythical yet.' : 'No users have caught a mythical yet.');
								return;
							}
							filteredUsers.sort((a, b) => b.value - a.value);
							const leaderboardTitle = serverLb ? 'Server Mythical Pokémon Leaderboard' : 'Mythical Pokémon Leaderboard';
							sendLeaderboard(message, filteredUsers, leaderboardTitle);
						});
					}

					else if (args[0].toLowerCase() === 'pokedex' || args[0].toLowerCase() === 'dex') {
						//display pokedex completeness leaderboard
						let serverLb = false;
						if (args.length > 1 && args[1].toLowerCase() === 'server') {
							serverLb = true;
						}
						dbUser.all("SELECT user_id, caught_pokemon, servers FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the Pokédex completeness leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon || (serverLb && !row.servers)) {
									return null;
								}

								if (serverLb) {
									const userServers = JSON.parse(row.servers);
									if (!userServers.includes(serverId)) {
										return null;
									}
								}

								const user = await client.users.fetch(row.user_id).catch(() => null);
								const caughtPokemon = JSON.parse(row.caught_pokemon).flat() || [];

								const uniquePokemon = new Set(caughtPokemon.map(pokemon => {
									if (typeof pokemon !== 'object' || !pokemon.name) {
										return '';
									}
									let pokemonName = pokemon.name;

									if (pokemonName.startsWith('✨')) {
										pokemonName = pokemonName.substring(1);
									}

									if (pokemonName === 'Nidoran' && pokemon.gender) {
										if (pokemon.gender === 'Male') {
											return 'Nidoran♂';
										}
										else if (pokemon.gender === 'Female') {
											return 'Nidoran♀';
										}
									}
									return pokemonName;
								}));
								uniquePokemon.delete('');
								const value = uniquePokemon.size;

								return value > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value
								} : null;
							}));
							
							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send(serverLb ? 'No users in this server have caught Pokémon yet.' : 'No users have caught Pokémon yet.');
								return;
							}
							filteredUsers.sort((a, b) => b.value - a.value);
							const leaderboardTitle = serverLb ? `Pokédex Completeness Server Leaderboard (/${maxDexNum})` : `Pokédex Completeness Leaderboard (/${maxDexNum}|)`;
							sendLeaderboard(message, filteredUsers, leaderboardTitle);
						});
					}

					else if (args.length > 0) {
						//lb by pokemon name
						let serverLb = false;
						if (args.length > 1 && args[1].toLowerCase() === 'server') {
							serverLb = true;
						}
						let pokemonIdentifier = args[0];
						let isNumber = !isNaN(pokemonIdentifier);
						if (!isNumber) {
							pokemonIdentifier = pokemonIdentifier.toLowerCase();
							pokemonIdentifier = capitalizeFirstLetter(pokemonIdentifier);
							let arr = args[0];
							if (args.length > 1) {
								arr = ['', args[0], args[1]];
							}
							pokemonIdentifier = fixPokemonName(pokemonIdentifier, arr);
						}
						else {
							message.channel.send('Pokemon must be a name!');
							return;
						}

						dbUser.all("SELECT user_id, caught_pokemon, servers FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async (row) => {
								if (!row.caught_pokemon || (serverLb && !row.servers)) {
									return null;
								}

								if (serverLb) {
									const userServers = JSON.parse(row.servers);
									if (!userServers.includes(serverId)) {
										return null;
									}
								}

								const user = await client.users.fetch(row.user_id).catch(() => null);
								const caughtPokemon = JSON.parse(row.caught_pokemon).flat().map(pokemon => pokemon.name) || [];
								const count = caughtPokemon.filter(pokemonName => {
									if (typeof pokemonName !== 'string') {
										return false;
									}
									let finalName = pokemonName.startsWith('✨') ? pokemonName.substring(1) : pokemonName;
									return finalName === pokemonIdentifier;
								}).length;

								return count > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value: count
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							filteredUsers.sort((a, b) => b.value - a.value);

							if (filteredUsers.length > 0) {
								const leaderboardTitle = serverLb ? `Server Leaderboard for ${pokemonIdentifier}` : `Leaderboard for ${pokemonIdentifier}`;
								sendLeaderboard(message, filteredUsers, leaderboardTitle);
							}
							else {
								message.channel.send(serverLb ? `No users in this server have caught that or they aren't registered in the pokedex.` : `No users have caught that or they aren't registered in the pokedex.`);
							}
						});
					}
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
					if (!isNumber) {
						pokemonIdentifier = pokemonIdentifier.toLowerCase();
						pokemonIdentifier = capitalizeFirstLetter(pokemonIdentifier);
						pokemonIdentifier = fixPokemonName(pokemonIdentifier, args);
					}
					else {
						pokemonIdentifier = parseInt(pokemonIdentifier, 10);
						if (pokemonIdentifier < 1 || pokemonIdentifier > maxDexNum) {
							message.channel.send('Please specify a valid pokemon or its pokedex number. Usage: `.dex <Pokemon>` or `.dex <PokedexNum>`');
							return;
						}
					}
					dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (error, rows) => {
						if (error) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching Pokémon information.');
							return;
						}
						if (!rows) {
							rows = { user_id: userId, caught_pokemon: JSON.stringify([{name: "Filler", gender: "Filler", form: "Filler"}])};
						}
						const userCaughtPokemon = JSON.parse(rows.caught_pokemon);
						db.all("SELECT * FROM pokemon", [], (err, pokeList) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching Pokémon information.');
								return;
							}
							let index = 0;
							let curMon = '';
							const result = pokeList.find(({ name }) => name === pokemonIdentifier);
							let inUser;
							if (!isNumber) {
								if (result != null) {
									index = result.dexNum;
									if (isNaN(index.substring(index.length - 1, index.length))) {
										index = index.substring(0, index.length - 1);
									}
									curMon = pokeList[index - 1];
									if (curMon.name === 'Nidoran') {
										inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name && pokemon.gender === 'Female');
									}
									else {
										inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name);
									}
								}
								else {
									message.channel.send('Pokémon not found in the pokedex.');
									return;
								}
							}
							else {
								index = pokemonIdentifier;
								curMon = pokeList[index - 1];
								if (index === 29) {
									inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name && pokemon.gender === 'Female');
								}
								else if (index === 32) {
									inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name && pokemon.gender === 'Male');
								}
								else {
									inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name);
								}
							}
	
							if (!curMon) {
								message.channel.send('Syntax error occurred, try again.');
								return;
							}
							let shinyImg = false;
	
							let selectedForm = 'default'; // Default form selection
							let forms = JSON.parse(curMon.forms);
							let genders = JSON.parse(curMon.gender);

							let caughtCount = inUser.length || 0;
	
							if (forms.length > 0) {
								if (forms[0].name.toLowerCase() !== 'default') {
									selectedForm = forms[0].name;
								}
								else {
									selectedForm = '';
								}
							}
							let formSelectMenu = new Discord.StringSelectMenuBuilder()
								.setCustomId('formSelect')
								.setPlaceholder('Select a Form')
								.addOptions(
									forms.slice(0, 25).map(form => ({
										label: form.name,
										value: form.name,
									}))
								);
							
							let embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, caughtCount);
	
							let shinyButtonStyle = shinyImg ? ButtonStyle.Danger : ButtonStyle.Primary;
							
							let buttonRow = new ActionRowBuilder()
								.addComponents(
									new ButtonBuilder()
										.setCustomId('prev')
										.setLabel('◀')
										.setStyle(ButtonStyle.Primary),
									new ButtonBuilder()
										.setCustomId('shinyBtn')
										.setLabel('✨')
										.setStyle(shinyButtonStyle),
									new ButtonBuilder()
										.setCustomId('next')
										.setLabel('▶')
										.setStyle(ButtonStyle.Primary)
								);
	
							message.channel.send({ 
								embeds: [embed], 
								components: [new ActionRowBuilder().addComponents(formSelectMenu), buttonRow],
							}).then(sentMessage => {
								const filter = i => i.user.id === userId;
								const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });
	
								collector.on('collect', async i => {
									try {
										if (i.customId === 'prev') {
											let prevDexNum = curMon.dexNum - 2;
											if (prevDexNum < 0) {
												prevDexNum = maxDexNum - 1;
											}
											curMon = pokeList[prevDexNum];
		
											forms = JSON.parse(curMon.forms);
											if (forms.length > 0) {
												if (forms[0].name.toLowerCase() !== 'default') {
													selectedForm = forms[0].name;
												}
												else {
													selectedForm = '';
												}
											}
											genders = JSON.parse(curMon.gender);
											
											if (prevDexNum === 28) {
												inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name && pokemon.gender === 'Female');
											}
											else if (prevDexNum === 31) {
												inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name && pokemon.gender === 'Male');
											}
											else {
												inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name);
											}
											caughtCount = inUser.length || 0;
		
											formSelectMenu = new Discord.StringSelectMenuBuilder()
												.setCustomId('formSelect')
												.setPlaceholder('Select a Form')
												.addOptions(
													forms.slice(0, 25).map(form => ({
														label: form.name,
														value: form.name,
													}))
												);
		
											embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, caughtCount);
											i.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(formSelectMenu), buttonRow] });
											
										} 
										else if (i.customId === 'next') {
											let nextDexNum = curMon.dexNum;
											if (nextDexNum > maxDexNum - 1) {
												nextDexNum = 0;
											}
											curMon = pokeList[nextDexNum];
		
											forms = JSON.parse(curMon.forms);
											if (forms.length > 0) {
												if (forms[0].name.toLowerCase() !== 'default') {
													selectedForm = forms[0].name;
												}
												else {
													selectedForm = '';
												}
											}
											genders = JSON.parse(curMon.gender);
											if (nextDexNum === '28') {
												inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name && pokemon.gender === 'Female');
											}
											else if (nextDexNum === '31') {
												inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name && pokemon.gender === 'Male');
											}
											else {
												inUser = userCaughtPokemon.filter(pokemon => pokemon.name === curMon.name);
											}
											caughtCount = inUser.length || 0;
	
											formSelectMenu = new Discord.StringSelectMenuBuilder()
												.setCustomId('formSelect')
												.setPlaceholder('Select a Form')
												.addOptions(
													forms.slice(0, 25).map(form => ({
														label: form.name,
														value: form.name,
													}))
												);
		
											embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, caughtCount);
											i.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(formSelectMenu), buttonRow] });
										} 
										else if (i.customId === 'shinyBtn') {
											shinyImg = !shinyImg;
											shinyButtonStyle = shinyImg ? ButtonStyle.Danger: ButtonStyle.Primary;
											buttonRow = new ActionRowBuilder()
												.addComponents(
													new ButtonBuilder()
														.setCustomId('prev')
														.setLabel('◀')
														.setStyle(ButtonStyle.Primary),
													new ButtonBuilder()
														.setCustomId('shinyBtn')
														.setLabel('✨')
														.setStyle(shinyButtonStyle),
													new ButtonBuilder()
														.setCustomId('next')
														.setLabel('▶')
														.setStyle(ButtonStyle.Primary)
												);
	
											embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, caughtCount);
											i.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(formSelectMenu), buttonRow] });
										}
										else if (i.customId === 'formSelect') {
											selectedForm = i.values[0];
											if (selectedForm.toLowerCase() === 'default') {
												selectedForm = '';
											}
											embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, caughtCount);
											i.update({ embeds: [embed] });
										}
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});
	
								collector.on('end', async () => {
									try {
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
										await sentMessage.edit({ components: [disabledRow] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});
							}).catch (err => {
								console.error('Error sending the dex message:', err);
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
					let index;
					if (args.length < 2) {
						index = 0;
					}
					else {
						index = parseInt(args[1], 10) - 1;
						if (isNaN(index)) {
							message.channel.send('Syntax error, command usage: .view <partyNum>.');
							return;
						}
					}
					
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

						const caughtPokemon = JSON.parse(row.caught_pokemon).flat();

						if (index < 0 || index >= caughtPokemon.length) {
							message.channel.send('Please specify a valid party number.');
							return;
						}

						let pokemonToDisplay = caughtPokemon[index];
						let isShiny = pokemonToDisplay.name.startsWith('✨');
						let pokemonName = isShiny ? pokemonToDisplay.name.slice(1) : pokemonToDisplay.name;
						let formName = pokemonToDisplay.form;
						db.all("SELECT * FROM pokemon", [], (err, pokemonRows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching Pokémon information.');
								return;
							}
							if (!pokemonRows) {
								message.channel.send('Pokémon not found in the database.');
								return;
							}
							let defaultMon = pokemonRows.filter(pokemon => pokemon.isLM !== 3 && pokemon.name === pokemonName);
							if (defaultMon.length < 1){ 
								message.channel.send('Pokémon not found in the database.');
								return;
							}
							if (defaultMon.length === 1) {
								defaultMon = defaultMon[0];
							}
							else {
								if (pokemonToDisplay.gender === 'Female') {
									defaultMon = defaultMon[0];
								}
								else {
									defaultMon = defaultMon[1];
								}
							}

							if (formName.includes('Female')) {
								formName = pokemonToDisplay.form + ' (F)';
							}
							else if (formName.includes('Male')) {
								formName = pokemonToDisplay.form + ' (M)';
							}

							let shinyImageLinks = JSON.parse(defaultMon.shinyImageLinks);
							let imgLinks = JSON.parse(defaultMon.imageLinks);
							let imageLink = isShiny ? shinyImageLinks[formName] || shinyImageLinks.default : imgLinks[formName] || imgLinks.default;

							let curForm = getFormTypes(pokemonName, formName, pokemonRows);
							let type1Field = '';
							let type2Field = '';
							let genderSymbol = '';
							if (curForm.formFound) {
								type1Field = curForm.type1;
								type2Field = curForm.type2 ? ` / ${curForm.type2}` : '';
							}
							else {
								type1Field = defaultMon.type1;
								type2Field = defaultMon.type2 ? ` / ${defaultMon.type2}` : '';
							}

							if (formName.toLowerCase() !== 'default') {
								formName = formName + ' ';
							}
							else {
								formName = '';
							}
							if (pokemonToDisplay.gender === 'Male') {
								genderSymbol = '`♂\u200B`';
							}
							else if (pokemonToDisplay.gender === 'Female') {
								genderSymbol = '`♀\u200B`';
							}

							if (formName.includes('(F)') || formName.includes('(M)')) {
								formName = formName.substring(0, formName.length - 4);
							}

							const embed = new EmbedBuilder()
									.setColor('#0099ff')
									.setTitle(`Your ${isShiny ? '✨' : ''}${formName}${defaultMon.name}${genderSymbol}`)
									.addFields(
										{ name: 'Dex Number', value: `${defaultMon.dexNum}`, inline: true },
										{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
										{ name: 'Region', value: `${defaultMon.region}`, inline: true }
									)
									.setImage(imageLink)
									.setTimestamp();
							
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
								const filter = i => i.user.id === userId;
								const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

								collector.on('collect', async i => {
									try {
										if (i.customId === 'prev') {
											index = index - 1;
											if (index < 0) {
												index = caughtPokemon.length - 1;
											}
											pokemonToDisplay = caughtPokemon[index];
											isShiny = pokemonToDisplay.name.startsWith('✨');
											pokemonName = isShiny ? pokemonToDisplay.name.slice(1) : pokemonToDisplay.name;
											formName = pokemonToDisplay.form;
											defaultMon = pokemonRows.filter(pokemon => pokemon.isLM !== 3 && pokemon.name === pokemonName);
											if (defaultMon.length < 1) {
												message.channel('Error getting requested pokémon.');
												return;
											}
											if (defaultMon.length === 1) {
												defaultMon = defaultMon[0];
											}
											else {
												if (pokemonToDisplay.gender === 'Female') {
													defaultMon = defaultMon[0];
												}
												else {
													defaultMon = defaultMon[1];
												}
											}

											if (formName.includes('Female')) {
												formName = pokemonToDisplay.form + ' (F)';
											}
											else if (formName.includes('Male')) {
												formName = pokemonToDisplay.form + ' (M)';
											}

											shinyImageLinks = JSON.parse(defaultMon.shinyImageLinks);
											imgLinks = JSON.parse(defaultMon.imageLinks);
											imageLink = isShiny ? shinyImageLinks[formName] || shinyImageLinks.default : imgLinks[formName] || imgLinks.default;

											curForm = getFormTypes(pokemonName, formName, pokemonRows);
											let type1Field = '';
											let type2Field = '';
											let genderSymbol = '';
											if (curForm.formFound) {
												type1Field = curForm.type1;
												type2Field = curForm.type2 ? ` / ${curForm.type2}` : '';
											}
											else {
												type1Field = defaultMon.type1;
												type2Field = defaultMon.type2 ? ` / ${defaultMon.type2}` : '';
											}

											if (formName.toLowerCase() !== 'default') {
												formName = formName + ' ';
											}
											else {
												formName = '';
											}
											if (pokemonToDisplay.gender === 'Male') {
												genderSymbol = '`♂\u200B`';
											}
											else if (pokemonToDisplay.gender === 'Female') {
												genderSymbol = '`♀\u200B`';
											}

											if (formName.includes('(F)') || formName.includes('(M)')) {
												formName = formName.substring(0, formName.length - 4);
											}
				
											const embedPrev = new EmbedBuilder()
												.setColor('#0099ff')
												.setTitle(`Your ${isShiny ? '✨' : ''}${formName}${defaultMon.name}${genderSymbol}`)
												.addFields(
													{ name: 'Dex Number', value: `${defaultMon.dexNum}`, inline: true },
													{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
													{ name: 'Region', value: `${defaultMon.region}`, inline: true }
												)
												.setImage(imageLink)
												.setTimestamp();

											i.update({ embeds: [embedPrev], components: [buttonRow] });
										}
										else if (i.customId === 'next') {
											index = index + 1;
											if (index > caughtPokemon.length - 1) {
												index = 0;
											}
											pokemonToDisplay = caughtPokemon[index];
											isShiny = pokemonToDisplay.name.startsWith('✨');
											pokemonName = isShiny ? pokemonToDisplay.name.slice(1) : pokemonToDisplay.name;
											formName = pokemonToDisplay.form;
											defaultMon = pokemonRows.filter(pokemon => pokemon.isLM !== 3 && pokemon.name === pokemonName);
											if (defaultMon.length < 1) {
												message.channel('Error getting requested pokémon.');
												return;
											}
											if (defaultMon.length === 1) {
												defaultMon = defaultMon[0];
											}
											else {
												if (pokemonToDisplay.gender === 'Female') {
													defaultMon = defaultMon[0];
												}
												else {
													defaultMon = defaultMon[1];
												}
											}

											if (formName.includes('Female')) {
												formName = pokemonToDisplay.form + ' (F)';
											}
											else if (formName.includes('Male')) {
												formName = pokemonToDisplay.form + ' (M)';
											}

											shinyImageLinks = JSON.parse(defaultMon.shinyImageLinks);
											imgLinks = JSON.parse(defaultMon.imageLinks);
											imageLink = isShiny ? shinyImageLinks[formName] || shinyImageLinks.default : imgLinks[formName] || imgLinks.default;

											curForm = getFormTypes(pokemonName, formName, pokemonRows);
											let type1Field = '';
											let type2Field = '';
											let genderSymbol = '';
											if (curForm.formFound) {
												type1Field = curForm.type1;
												type2Field = curForm.type2 ? ` / ${curForm.type2}` : '';
											}
											else {
												type1Field = defaultMon.type1;
												type2Field = defaultMon.type2 ? ` / ${defaultMon.type2}` : '';
											}

											if (formName.toLowerCase() !== 'default') {
												formName = formName + ' ';
											}
											else {
												formName = '';
											}
											if (pokemonToDisplay.gender === 'Male') {
												genderSymbol = '`♂\u200B`';
											}
											else if (pokemonToDisplay.gender === 'Female') {
												genderSymbol = '`♀\u200B`';
											}

											if (formName.includes('(F)') || formName.includes('(M)')) {
												formName = formName.substring(0, formName.length - 4);
											}				

											const embedPrev = new EmbedBuilder()
												.setColor('#0099ff')
												.setTitle(`Your ${isShiny ? '✨' : ''}${formName}${defaultMon.name}${genderSymbol}`)
												.addFields(
													{ name: 'Dex Number', value: `${defaultMon.dexNum}`, inline: true },
													{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
													{ name: 'Region', value: `${defaultMon.region}`, inline: true }
												)
												.setImage(imageLink)
												.setTimestamp();

											i.update({ embeds: [embedPrev], components: [buttonRow] });
										}
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});

								collector.on('end', async () => {
									try {
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
										await sentMessage.edit({ components: [disabledRow] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});
							}).catch(err => {
								console.error('Error sending the view message:', err);
							});
						});
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
						
						const caughtPokemon = JSON.parse(row.caught_pokemon).flat();
						
						if (args.length === 0) {
							const pmap = caughtPokemon.map((p, index) => ({
								...p,
								id: index + 1
							}));

							const pageSize = 20;
							let page = 0;

							const embed = generatePartyEmbed(pmap, page, pageSize, `Your Pokémon`, 0);
							const buttonRow = getPartyBtns();
							
							message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
								const filter = i => i.user.id === userId;
								const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

								collector.on('collect', async i => {
									try {
										if (i.customId === 'prev') {
											if (page > 0) {
												page--;
											}
											else {
												page = Math.ceil(pmap.length / pageSize) - 1;
											}
										} 
										else if (i.customId === 'next') {
											if ((page + 1) * pageSize < pmap.length) {
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
											page = Math.ceil(pmap.length / pageSize) - 1;;
										}
										await i.update({ embeds: [generatePartyEmbed(pmap, page, pageSize, `Your Pokémon`, 0)] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});

								collector.on('end', async () => {
									try {
										const disabledRow = getDisablePartyBtns();
										await sentMessage.edit({ components: [disabledRow] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});
							}).catch(err => {
								console.error('Error sending the help message:', err);
							});
						}
						
						else if (args[0].toLowerCase() === 'name:' || args[0].toLowerCase() === 'name' || args[0].toLowerCase() === 'n' || args[0].toLowerCase() === 'n:') {
							if (args.length > 1) {
								let searchName = args[1].toLowerCase();
								searchName = capitalizeFirstLetter(searchName);
								searchName = fixPokemonName(searchName, args);
								if (searchName === '') {
									message.channel.send('Syntax error, usage: .party name: <pokemon>');
									return;
								}

								const filteredPokemon = caughtPokemon
									.map((p, index) => {
										let isShiny = false;
										let fullName = '';
										if (p.name.startsWith('✨')) {
											isShiny = true;
											fullName = p.name.substring(1);
										}
										else {
											fullName = p.name;
										}
										if (isShiny) {
											fullName = p.form !== 'Default' ? `✨${p.form} ${fullName}` : `✨${fullName}`;
										}
										else {
											fullName = p.form !== 'Default' ? `${p.form} ${fullName}` : p.name;
										}
										
										if (p.gender === 'Male') {
											fullName += ' ♂\u200B';
										}
										else if (p.gender === 'Female') {
											fullName += ' ♀\u200B';
										}

										return {
											name: fullName,
											id: index + 1
										};
									})
									.filter(p => p.name.toLowerCase().includes(searchName.toLowerCase()));
								
								if (filteredPokemon.length === 0) {
									message.channel.send(`You do not have any Pokémon with that name.`);
								}
								else {
									const pageSize = 20;
									let page = 0;
									
									const embed = generatePartyEmbed(filteredPokemon, page, pageSize, `All ${searchName} in your party`, 0);
									const buttonRow = getPartyBtns(); 
									
									message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
										const filter = i => i.user.id === userId;
										const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });
			
										collector.on('collect', async i => {
											try {
												if (i.customId === 'prev') {
													if (page > 0) {
														page--;
													}
													else {
														page = Math.ceil(filteredPokemon.length / pageSize) - 1;;
													}
												} 
												else if (i.customId === 'next') {
													if ((page + 1) * pageSize < filteredPokemon.length) {
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
													page = Math.ceil(filteredPokemon.length / pageSize) - 1;;
												}
												await i.update({ embeds: [generatePartyEmbed(filteredPokemon, page, pageSize, `All ${searchName} in your party`, 0)] });
											} catch (error) {
												if (error.code === 10008) {
													console.log('The message was deleted before the interaction was handled.');
												}
												else {
													console.error('An unexpected error occurred:', error);
												}
											}
										});
										collector.on('end', async () => {
											try {
												const disabledRow = getDisablePartyBtns();
												await sentMessage.edit({ components: [disabledRow] });
											} catch (error) {
												if (error.code === 10008) {
													console.log('The message was deleted before the interaction was handled.');
												}
												else {
													console.error('An unexpected error occurred:', error);
												}
											}
										});
									}).catch(err => {
										console.error('Error sending the party message:', err);
									});
								}
							}

							else {
								message.channel.send('Improper use of command. Example: .p name: <pokemon>');
							}
						}

						else if (args[0].toLowerCase() === 'swap') {
							let isInTrade = false;
							for (const [serverId, trade] of activeTrades.entries()) {
								if (trade && (userId === trade.user1 || userId === trade.user2)) {
									isInTrade = true;
									break;
								}
							}
							if (isInTrade) {
								message.channel.send('Cannot order your pokemon while in a trade!');
								return;
							}
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

						else if (args[0].toLowerCase() === 'shiny' || args[0].toLowerCase() === 's') {
							const shinyPokemon = caughtPokemon
							.map((p, index) => ({ ...p, id: index + 1 }))
							.filter(p => typeof p.name === 'string' && p.name.startsWith('✨'));
							if (shinyPokemon.length === 0) {
								message.channel.send("You do not have any shiny Pokémon.");
							} 
							else {
								const pageSize = 20
								let page = 0;

								const embed = generatePartyEmbed(shinyPokemon, page, pageSize, `Your Shiny Pokémon`, 1);
								const buttonRow = getPartyBtns();
									
								message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
									const filter = i => i.user.id === userId;
									const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });
			
									collector.on('collect', async i => {
										try {
											if (i.customId === 'prev') {
												if (page > 0) {
													page--;
												}
												else {
													page = Math.ceil(shinyPokemon.length / pageSize) - 1;;
												}
											} 
											else if (i.customId === 'next') {
												if ((page + 1) * pageSize < shinyPokemon.length) {
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
												page = Math.ceil(shinyPokemon.length / pageSize) - 1;;
											}
				
											await i.update({ embeds: [generatePartyEmbed(shinyPokemon, page, pageSize, `Your Shiny Pokémon`, 1)] });
										} catch (error) {
											if (error.code === 10008) {
												console.log('The message was deleted before the interaction was handled.');
											}
											else {
												console.error('An unexpected error occurred:', error);
											}
										}
									});
									collector.on('end', async () => {
										try {
											const disabledRow = getDisablePartyBtns();
											await sentMessage.edit({ components: [disabledRow] });
										} catch (error) {
											if (error.code === 10008) {
												console.log('The message was deleted before the interaction was handled.');
											}
											else {
												console.error('An unexpected error occurred:', error);
											}
										}
									});
								}).catch(err => {
									console.error('Error sending the party message:', err);
								});
							}
						}

						else if (args[0].toLowerCase() === 'legendary' || args[0].toLowerCase() === 'l') {
							const legendaryPokemon = [
								'Articuno', 'Zapdos', 'Moltres', 'Mewtwo', 
								'Raikou', 'Entei', 'Suicune', 'Lugia', 'Ho-Oh',
								'Regirock', 'Regice', 'Registeel', 'Latias', 'Latios', 'Kyogre', 'Groudon', 'Rayquaza',
								'Uxie', 'Mesprit', 'Azelf', 'Dialga', 'Palkia', 'Heatran', 'Regigigas', 'Giratina', 'Cresselia',
								'Cobalion', 'Terrakion', 'Virizion', 'Tornadus', 'Thundurus', 'Reshiram', 'Zekrom', 'Landorus', 'Kyurem'
							];

							const legendaryCaught = caughtPokemon
								.map((pokemonObj, index) => {
									let pokemonName = pokemonObj.name;

									if (pokemonName.startsWith('✨')) {
										pokemonName = pokemonName.substring(1);
									}

									if (legendaryPokemon.includes(pokemonName)) {
										return {
											...pokemonObj,
											id: index + 1
										};
									}
									else {
										return null;
									}
								})
								.filter(p => p !== null);
								
							if (legendaryCaught.length === 0) {
								message.channel.send("You do not have any legendary Pokémon.");
							}
							else {
								const pageSize = 20;
								let page = 0;

								const embed = generatePartyEmbed(legendaryCaught, page, pageSize, `Your Legendary Pokémon`, 2);
								const buttonRow = getPartyBtns();

								message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
									const filter = i => i.user.id === userId;
									const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

									collector.on('collect', async i => {
										try {
											if (i.customId === 'prev') {
												if (page > 0) {
													page--;
												} 
												else {
													page = Math.ceil(legendaryCaught.length / pageSize) - 1;
												}
											} 
											else if (i.customId === 'next') {
												if ((page + 1) * pageSize < legendaryCaught.length) {
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
												page = Math.ceil(legendaryCaught.length / pageSize) - 1;
											}
	
											await i.update({ embeds: [generatePartyEmbed(legendaryCaught, page, pageSize, `Your Legendary Pokémon`, 2)] });
										} catch (error) {
											if (error.code === 10008) {
												console.log('The message was deleted before the interaction was handled.');
											}
											else {
												console.error('An unexpected error occurred:', error);
											}
										}
									});

									collector.on('end', async () => {
										try {
											const disabledRow = getDisablePartyBtns();
											await sentMessage.edit({ components: [disabledRow] });
										} catch (error) {
											if (error.code === 10008) {
												console.log('The message was deleted before the interaction was handled.');
											}
											else {
												console.error('An unexpected error occurred:', error);
											}
										}
									});
								}).catch(err => {
									console.error('Error sending the party message:', err);
								});
							}
						}

						else if (args[0].toLowerCase() === 'mythical' || args[0].toLowerCase() === 'm') {
							const mythicalPokemon = [
								'Mew',
								'Celebi',
								'Jirachi', 'Deoxys',
								'Phione', 'Manaphy', 'Darkrai', 'Shaymin', 'Arceus',
								'Victini', 'Keldeo', 'Meloetta', 'Genesect'
							];

							const mythicalCaught = caughtPokemon
								.map((pokemonObj, index) => {
									 let pokemonName = pokemonObj.name;

									 if (pokemonName.startsWith('✨')) {
										pokemonName = pokemonName.substring(1);
									 }

									 if (mythicalPokemon.includes(pokemonName)) {
										return {
											...pokemonObj,
											id: index + 1
											//name: isShiny ? `✨${pokemonName}` : pokemonName,
											//id: index + 1
										};
									 }
									 else {
										return null;
									 }
								})
								.filter(p => p !== null);
								
							if (mythicalCaught.length === 0) {
								message.channel.send("You do not have any mythical Pokémon.");
							}
							else {
								const pageSize = 20;
								let page = 0;

								const embed = generatePartyEmbed(mythicalCaught, page, pageSize, `Your Mythical Pokémon`, 3);
								const buttonRow = getPartyBtns();

								message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
									const filter = i => i.user.id === userId;
									const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

									collector.on('collect', async i => {
										try {
											if (i.customId === 'prev') {
												if (page > 0) {
													page--;
												} 
												else {
													page = Math.ceil(mythicalCaught.length / pageSize) - 1;
												}
											} 
											else if (i.customId === 'next') {
												if ((page + 1) * pageSize < mythicalCaught.length) {
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
												page = Math.ceil(mythicalCaught.length / pageSize) - 1;
											}
	
											await i.update({ embeds: [generatePartyEmbed(mythicalCaught, page, pageSize, `Your Mythical Pokémon`, 3)] });
										} catch (error) {
											if (error.code === 10008) {
												console.log('The message was deleted before the interaction was handled.');
											}
											else {
												console.error('An unexpected error occurred:', error);
											}
										}
									});

									collector.on('end', async () => {
										try {
											const disabledRow = getDisablePartyBtns();
											await sentMessage.edit({ components: [disabledRow] });
										} catch (error) {
											if (error.code === 10008) {
												console.log('The message was deleted before the interaction was handled.');
											}
											else {
												console.error('An unexpected error occurred:', error);
											}
										}
									});
								}).catch(err => {
									console.error('Error sending the party message:', err);
								});
							}
						}
						else {
							message.channel.send("Invalid command usage. Use `.p` for party, `.p name: <pokemon>` to search, or `.p swap <partyNum1> <partyNum2>` to swap.");
						}
					});
				});
			}

			//compare
			else if (compareCommandRegex.test(message.content.toLowerCase())) {
				//syntax: .compare <userName>
				const args = message.content.split(' ').slice(1);
				const userRegex = /^<@\d+>|<@!\d+>$/;
				if (!userRegex.test(args[0])) {
					message.channel.send("You must @ a user to compare.");
					return;
				}
				let tag = args[0].substring(2, args[0].length - 1);
				dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, cmdUser) => {
					if (err) {
						console.error(err);
						return;
					}
					if (!cmdUser) {
						message.channel.send('Catch a pokemon to use this command.');
						return;
					}
					const cmdUserCaughtPokemon = cmdUser && cmdUser.caught_pokemon ? JSON.parse(cmdUser.caught_pokemon).flat().map(p => ({
						name: p.name.startsWith('✨') ? p.name.slice(1) : p.name,
						gender: p.gender
					})) : [];

					dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [tag], (err2, tagUser) => {
						if (err2) {
							console.error(err2);
							return;
						}
						if (!tagUser) {
							message.channel.send('Target user has not caught any pokemon yet.');
							return;
						}
						const tagUserCaughtPokemon = tagUser && tagUser.caught_pokemon ? JSON.parse(tagUser.caught_pokemon).flat().map(p => ({
							name: p.name.startsWith('✨') ? p.name.slice(1) : p.name,
							gender: p.gender
						})) : [];

						db.all("SELECT name, dexNum, isLM, gender FROM pokemon WHERE isLM != 3", [], async (err, allPokemonList) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the Pokémon database.');
								return;
							}
							if (!allPokemonList) {
								console.message('No Pokémon in database.');
								return;
							}

							const hasCaughtPokemon = (pokemon) => {
								if (pokemon.name === 'Nidoran') {
									if (pokemon.dexNum === '29') {
										return cmdUserCaughtPokemon.some(cp => cp.name === 'Nidoran' && cp.gender === 'Female');
									} else if (pokemon.dexNum === '32') {
										return cmdUserCaughtPokemon.some(cp => cp.name === 'Nidoran' && cp.gender === 'Male');
									}
								}
								return cmdUserCaughtPokemon.some(cp => cp.name === pokemon.name);
							};

							const hasCaughtPokemon2 = (pokemon) => {
								if (pokemon.name === 'Nidoran') {
									if (pokemon.dexNum === '29') {
										return tagUserCaughtPokemon.some(cp => cp.name === 'Nidoran' && cp.gender === 'Female');
									} else if (pokemon.dexNum === '32') {
										return tagUserCaughtPokemon.some(cp => cp.name === 'Nidoran' && cp.gender === 'Male');
									}
								}
								return tagUserCaughtPokemon.some(cp => cp.name === pokemon.name);
							};

							const uncaughtPokemon = allPokemonList.filter(pokemon => !hasCaughtPokemon(pokemon));

							const caughtPokemon = allPokemonList.filter(pokemon => hasCaughtPokemon2(pokemon));

							if (uncaughtPokemon.length === 0) {
								message.channel.send('You have caught all available Pokémon!');
                    			return;
							}

							const matchingPokemon = caughtPokemon.filter(caught =>
								uncaughtPokemon.some(uncaught =>
									uncaught.name === caught.name && uncaught.dexNum === caught.dexNum
								)
							);

							if (matchingPokemon.length === 0) {
								message.channel.send('The other user has no pokemon you don\'t own.');
                    			return;
							}

							const pageSize = 20;
							let page = 0;

							const generateUncaughtEmbed = async (compareList, page, pageSize) => {
								const start = page * pageSize;
								const end = start + pageSize;
								const pageData = compareList.slice(start, end);

								const tagName = await client.users.fetch(tag)
									.then(user => user.username)
									.catch(err => {
										console.error('An error occurred while fetching the tagged person\'s username');
										return 'User';
									});

								return new EmbedBuilder()
									.setColor('#0099ff')
									.setTitle(`${tagName}'s pokemon you don't own.`)
									.setDescription(pageData.map((pokemon) => {
										// Display gender for Nidoran only
										if (pokemon.name === 'Nidoran' && pokemon.dexNum === '29') {
											return `\`${pokemon.dexNum}\` ${pokemon.name} (♀)`;
										}
										if (pokemon.name === 'Nidoran' && pokemon.dexNum === '32') {
											return `\`${pokemon.dexNum}\` ${pokemon.name} (♂)`;
										}
										return `\`${pokemon.dexNum}\` ${pokemon.name}`;
									}).join('\n'))
									.setFooter({ text: `Page ${page + 1} of ${Math.ceil(compareList.length / pageSize)}` })
									.setTimestamp();
							};

							const buttonRow = new ActionRowBuilder()
								.addComponents(
									new ButtonBuilder()
										.setCustomId('prevPage')
										.setLabel('◀')
										.setStyle(ButtonStyle.Primary),
									new ButtonBuilder()
										.setCustomId('nextPage')
										.setLabel('▶')
										.setStyle(ButtonStyle.Primary)
								);
							const embed = await generateUncaughtEmbed(matchingPokemon, page, pageSize);

							message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
								const filter = i => i.user.id === userId;
								const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

								collector.on('collect', async i => {
									try {
										if (i.customId === 'prevPage') {
											page = page - 1;
											if (page < 0) {
												page = Math.ceil(matchingPokemon.length / pageSize) - 1;
											}
										}
										else if (i.customId === 'nextPage') {
											page = page + 1;
											if (page > Math.ceil(matchingPokemon.length / pageSize) - 1) {
												page = 0;
											}
										}

										const updatedEmbed = await generateUncaughtEmbed(matchingPokemon, page, pageSize);
										await i.update({ embeds: [updatedEmbed] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});

								collector.on('end', async () => {
									try {
										const disabledRow = new ActionRowBuilder()
											.addComponents(
												new ButtonBuilder()
													.setCustomId('prevPage')
													.setLabel('◀')
													.setStyle(ButtonStyle.Primary)
													.setDisabled(true),
												new ButtonBuilder()
													.setCustomId('nextPage')
													.setLabel('▶')
													.setStyle(ButtonStyle.Primary)
													.setDisabled(true)
											);
										await sentMessage.edit({ components: [disabledRow] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});
							}).catch(err => {
								console.error('Error sending the uncaught Pokémon list:', err);
							});
						});
					});
				});
			}

			//team
			else if (teamCommandRegex.test(message.content.toLowerCase())) {
				//syntax: .team <userName> or .team <userName> <view || v> <1-6>
				const args = message.content.split(' ').slice(1);
				const userRegex = /^<@\d+>|<@!\d+>$/;
				if (!userRegex.test(args[0])) {
					message.channel.send("You must @ a user to compare.");
					return;
				}
				let tag = args[0].substring(2, args[0].length - 1);
				if (args.length === 1) {
					dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [tag], (err, row) => {
						if (err) {
							console.error(err.message);
							return;
						}
						if (!row) {
							message.channel.send('User has not caught any pokemon.');
							return;
						}
						const caughtPokemon = JSON.parse(row.caught_pokemon);
						const party = caughtPokemon.slice(0, 6);

						client.users.fetch(tag).then(user => {

							const partyArray = party.map((p, index) => ({
								...p,
								id: index + 1
							}));

							const teamEmbed = generatePartyEmbed(partyArray, 0, 10, `${user.username}'s Team`, 0);
							message.channel.send( {embeds: [teamEmbed]} );
						}).catch(err => {
							console.error('Error fetching the user:', err);
							message.channel.send('An error occurred while fetching the user.');
						});
					});
				}
				else if (args.length > 2 && (args[1] === 'v' || args[1] === 'view') && (args[2] > 0 && args[2] < 7)) {
					dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [tag], (err, row) => {
						if (err) {
							console.error(err.message);
							return;
						}
						if (!row) {
							message.channel.send('User has not caught any pokemon.');
							return;
						}
						const caughtPokemon = JSON.parse(row.caught_pokemon);
						let pokemonToDisplay = caughtPokemon[args[2] - 1];
						let isShiny = pokemonToDisplay.name.startsWith('✨');
						let pokemonName = isShiny ? pokemonToDisplay.name.slice(1) : pokemonToDisplay.name;
						let formName = pokemonToDisplay.form;
						db.all("SELECT * FROM pokemon", [], (err, pokemonRows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching Pokémon information.');
								return;
							}
							if (!pokemonRows) {
								message.channel.send('Pokémon not found in the database.');
								return;
							}
							let defaultMon = pokemonRows.filter(pokemon => pokemon.isLM !== 3 && pokemon.name === pokemonName);
							if (defaultMon.length < 1){ 
								message.channel.send('Pokémon not found in the database.');
								return;
							}
							if (defaultMon.length === 1) {
								defaultMon = defaultMon[0];
							}
							else {
								if (pokemonToDisplay.gender === 'Female') {
									defaultMon = defaultMon[0];
								}
								else {
									defaultMon = defaultMon[1];
								}
							}

							if (formName.includes('Female')) {
								formName = pokemonToDisplay.form + ' (F)';
							}
							else if (formName.includes('Male')) {
								formName = pokemonToDisplay.form + ' (M)';
							}

							let shinyImageLinks = JSON.parse(defaultMon.shinyImageLinks);
							let imgLinks = JSON.parse(defaultMon.imageLinks);
							let imageLink = isShiny ? shinyImageLinks[formName] || shinyImageLinks.default : imgLinks[formName] || imgLinks.default;

							let curForm = getFormTypes(pokemonName, formName, pokemonRows);
							let type1Field = '';
							let type2Field = '';
							let genderSymbol = '';
							if (curForm.formFound) {
								type1Field = curForm.type1;
								type2Field = curForm.type2 ? ` / ${curForm.type2}` : '';
							}
							else {
								type1Field = defaultMon.type1;
								type2Field = defaultMon.type2 ? ` / ${defaultMon.type2}` : '';
							}

							if (formName.toLowerCase() !== 'default') {
								formName = formName + ' ';
							}
							else {
								formName = '';
							}
							if (pokemonToDisplay.gender === 'Male') {
								genderSymbol = '`♂\u200B`';
							}
							else if (pokemonToDisplay.gender === 'Female') {
								genderSymbol = '`♀\u200B`';
							}

							if (formName.includes('(F)') || formName.includes('(M)')) {
								formName = formName.substring(0, formName.length - 4);
							}

							client.users.fetch(tag).then(user => {
								const teamEmbed = new EmbedBuilder()
									.setColor('#0099ff')
									.setTitle(`${user.username}'s ${isShiny ? '✨' : ''}${formName}${defaultMon.name}${genderSymbol}`)
									.addFields(
										{ name: 'Dex Number', value: `${defaultMon.dexNum}`, inline: true },
										{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
										{ name: 'Region', value: `${defaultMon.region}`, inline: true }
									)
									.setImage(imageLink)
									.setTimestamp();
	
								message.channel.send({ embeds: [teamEmbed]});
							}).catch(err => {
								console.error('Error fetching the user:', err);
								message.channel.send('An error occurred while fetching the user.');
							});
						});
					});
				}
				else {
					message.channel.send("Incorrect command usage. Example: `.team <@user>` or `.team <@user> view 1`");
					return;
				}
			}

			//order
			else if (orderCommandRegex.test(message.content.toLowerCase())) {
				//.order <dex> <ignoreNum>
				//orders: flexdex (mythical -> legendary -> dex), dex, count num, alphabetical order
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					let isInTrade = false;
					for (const [serverId, trade] of activeTrades.entries()) {
						if (trade && (userId === trade.user1 || userId === trade.user2)) {
							isInTrade = true;
							break;
						}
					}
					if (isInTrade) {
						message.channel.send('Cannot order your pokemon while in a trade!');
						return;
					}

					const args = message.content.split(' ').slice(1);

					if (args.length > 0) {
						const order = args[0];

						if (order.toLowerCase() === 'dex') {
							dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, row) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while fetching the user\'s Pokémon.');
									return;
								}
								if (!row || !row.caught_pokemon) {
									message.channel.send('You have no Pokémon to order.');
                					return;
								}

								let userPokemonList = JSON.parse(row.caught_pokemon).flat();

								db.all("SELECT name, dexNum FROM pokemon", [], (error, allPokemonList) => {
									if (error) {
										console.error(error.message);
                    					message.channel.send('An error occurred while fetching the Pokémon database.');
                        				return;
									}

									let ignoreNum = 0;
									if (args.length > 1 && !isNaN(args[1])) {
										ignoreNum = parseInt(args[1], 10);
										if (ignoreNum < 1 || ignoreNum > userPokemonList.length || isNaN(ignoreNum)) {
											message.channel.send('Error: provided ignore num is invalid');
											return;
										}
									}

									const ignoredList = userPokemonList.slice(0, ignoreNum);
									let sortableList = userPokemonList.slice(ignoreNum);

									const dexMap = new Map();
									allPokemonList.forEach(pokemon => {
										if (pokemon.name === 'Nidoran') {
											if (pokemon.dexNum === '29') {
												dexMap.set('Nidoran-Female', pokemon.dexNum);
											}
											else if (pokemon.dexNum === '32') {
												dexMap.set('Nidoran-Male', pokemon.dexNum);
											}
										}
										else {
											dexMap.set(pokemon.name, pokemon.dexNum);
										}
									});

									sortableList.sort((a, b) => {
										let nameA = a.name.startsWith('✨') ? a.name.substring(1) : a.name;
										let nameB = b.name.startsWith('✨') ? b.name.substring(1) : b.name;

										//NIDORANNNN
										if (nameA === 'Nidoran') {
											if (a.gender === 'Female') {
												nameA = 'Nidoran-Female';
											}
											else {
												nameA = 'Nidoran-Male';
											}
										}
										if (nameB === 'Nidoran') {
											if (b.gender === 'Female') {
												nameB = 'Nidoran-Female';
											}
											else {
												nameB = 'Nidoran-Male';
											}
										}

										// Get Dex numbers from the map
										const dexA = dexMap.get(nameA) || 9999; // Use a large number if not found
										const dexB = dexMap.get(nameB) || 9999;

										// Sort by Dex number
										if (dexA !== dexB) {
											return dexA - dexB;
										}

										// If Dex numbers are the same, sort by shiny status
										const isShinyA = a.name.startsWith('✨');
										const isShinyB = b.name.startsWith('✨');
										if (isShinyA && !isShinyB) {
											return -1;
										}
										if (!isShinyA && isShinyB) {
											return 1;
										}

										// If both are shiny or both are not, maintain their order
										return 0;
									});

									const finalList = ignoredList.concat(sortableList);

									dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(finalList), userId], (err3) => {
										if (err3) {
											console.error(err3.message);
                   							message.channel.send('An error occurred while saving your Pokémon order.');
                    						return;
										}
										message.channel.send('Pokémon successfully ordered.');
									});
								});
							});
						}
						else if (order.toLowerCase() === 'countlow') {
							dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, row) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while fetching the user\'s Pokémon.');
									return;
								}
								if (!row || !row.caught_pokemon) {
									message.channel.send('You have no Pokémon to order.');
                					return;
								}

								let userPokemonList = JSON.parse(row.caught_pokemon).flat();

								let ignoreNum = 0;
								if (args.length > 1 && !isNaN(args[1])) {
									ignoreNum = parseInt(args[1], 10);
									if (ignoreNum < 1 || ignoreNum > userPokemonList.length || isNaN(ignoreNum)) {
										message.channel.send('Error: provided ignore num is invalid');
										return;
									}
								}

								let ignoreList = userPokemonList.slice(0, ignoreNum);
								let sortedList = userPokemonList.slice(ignoreNum);

								let countMap = new Map();
								sortedList.forEach(pokemon => {
									let name = pokemon.name.startsWith('✨') ? pokemon.name.substring(1) : pokemon.name;
									if (!countMap.has(name)) {
										countMap.set(name, { count: 0, shiny: 0 });
									}
									let entry = countMap.get(name);
									entry.count += 1;
									if (pokemon.name.startsWith('✨')) {
										entry.shiny += 1;
									}
									countMap.set(name, entry);
								});

								sortedList.sort((a, b) => {
									let nameA = a.name.startsWith('✨') ? a.name.substring(1) : a.name;
									let nameB = b.name.startsWith('✨') ? b.name.substring(1) : b.name;
									let countA = countMap.get(nameA);
									let countB = countMap.get(nameB);
									
									if (countA.count === countB.count) {
										if (countA.shiny !== countB.shiny) {
											return countB.shiny - countA.shiny; // Sort shiny first
										}
										return nameA.localeCompare(nameB); // Alphabetical if tied
									}
									return countA.count - countB.count; // Sort by count (low to high)
								});

								let finalList = ignoreList.concat(sortedList);

								dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(finalList), userId], (err) => {
									if (err) {
										console.error(err.message);
										message.channel.send('An error occurred while updating your Pokémon.');
										return;
									}
									message.channel.send('Your Pokémon have been ordered by count (low to high).');
								});
							});
						}
						else if (order.toLowerCase() === 'counthigh') {
							dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, row) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while fetching the user\'s Pokémon.');
									return;
								}
								if (!row || !row.caught_pokemon) {
									message.channel.send('You have no Pokémon to order.');
                					return;
								}

								let userPokemonList = JSON.parse(row.caught_pokemon).flat();

								let ignoreNum = 0;
								if (args.length > 1 && !isNaN(args[1])) {
									ignoreNum = parseInt(args[1], 10);
									if (ignoreNum < 1 || ignoreNum > userPokemonList.length || isNaN(ignoreNum)) {
										message.channel.send('Error: provided ignore num is invalid');
										return;
									}
								}

								let ignoreList = userPokemonList.slice(0, ignoreNum);
								let sortedList = userPokemonList.slice(ignoreNum);

								// Count Pokémon occurrences
								let countMap = new Map();
								sortedList.forEach(pokemon => {
									let name = pokemon.name.startsWith('✨') ? pokemon.name.substring(1) : pokemon.name;
									if (!countMap.has(name)) {
										countMap.set(name, { count: 0, shiny: 0 });
									}
									let entry = countMap.get(name);
									entry.count += 1;
									if (pokemon.name.startsWith('✨')) {
										entry.shiny += 1;
									}
									countMap.set(name, entry);
								});

								// Sort by count (descending), then shiny, then alphabetical
								sortedList.sort((a, b) => {
									let nameA = a.name.startsWith('✨') ? a.name.substring(1) : a.name;
									let nameB = b.name.startsWith('✨') ? b.name.substring(1) : b.name;
									let countA = countMap.get(nameA);
									let countB = countMap.get(nameB);

									if (countA.count === countB.count) {
										if (countA.shiny !== countB.shiny) {
											return countB.shiny - countA.shiny; // Sort shiny first
										}
										return nameA.localeCompare(nameB); // Alphabetical if tied
									}
									return countB.count - countA.count; // Sort by count (high to low)
								});

								// Final list with ignored Pokémon at the beginning
								let finalList = ignoreList.concat(sortedList);
								
								dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(finalList), userId], (err3) => {
									if (err3) {
										console.error(err3.message);
										   message.channel.send('An error occurred while saving your Pokémon order.');
										return;
									}
									message.channel.send('Pokémon successfully ordered.');
								});
							});
						}
						else if (order.toLowerCase() === 'alphabetical'){
							dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, row) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while fetching the user\'s Pokémon.');
									return;
								}
								if (!row || !row.caught_pokemon) {
									message.channel.send('You have no Pokémon to order.');
                					return;
								}

								let userPokemonList = JSON.parse(row.caught_pokemon).flat();

								let ignoreNum = 0;
								if (args.length > 1 && !isNaN(args[1])) {
									ignoreNum = parseInt(args[1], 10);
									if (ignoreNum < 1 || ignoreNum > userPokemonList.length || isNaN(ignoreNum)) {
										message.channel.send('Error: provided ignore num is invalid');
										return;
									}
								}

								let ignoreList = userPokemonList.slice(0, ignoreNum);
								let sortedList = userPokemonList.slice(ignoreNum);

								sortedList.sort((a, b) => {
									let nameA = a.name.startsWith('✨') ? a.name.substring(1) : a.name;
									let nameB = b.name.startsWith('✨') ? b.name.substring(1) : b.name;
						
									// First, sort alphabetically by name
									let nameComparison = nameA.localeCompare(nameB);
									if (nameComparison !== 0) return nameComparison;
						
									// If names are the same, prioritize shiny Pokémon
									if (a.name.startsWith('✨') && !b.name.startsWith('✨')) {
										return -1;
									}
									if (!a.name.startsWith('✨') && b.name.startsWith('✨')) {
										return 1;
									}
						
									return 0; // If names and shiny status are the same
								});
						
								// Combine ignored list with the sorted list
								let finalList = ignoreList.concat(sortedList);

								dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(finalList), userId], (err3) => {
									if (err3) {
										console.error(err3.message);
										   message.channel.send('An error occurred while saving your Pokémon order.');
										return;
									}
									message.channel.send('Pokémon successfully ordered.');
								});
							});
						}
						else if (order.toLowerCase() === 'flexdex') {
							dbUser.get("SELECT caught_pokemon FROM user WHERE user_id = ?", [userId], (err, row) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while fetching the user\'s Pokémon.');
									return;
								}
								if (!row || !row.caught_pokemon) {
									message.channel.send('You have no Pokémon to order.');
                					return;
								}

								let userPokemonList = JSON.parse(row.caught_pokemon).flat();

								db.all("SELECT name, dexNum, isLM FROM pokemon", [], (error, allPokemonList) => {
									if (error) {
										console.error(error.message);
                    					message.channel.send('An error occurred while fetching the Pokémon database.');
                        				return;
									}

									let ignoreNum = 0;
									if (args.length > 1 && !isNaN(args[1])) {
										ignoreNum = parseInt(args[1], 10);
										if (ignoreNum < 1 || ignoreNum > userPokemonList.length || isNaN(ignoreNum)) {
											message.channel.send('Error: provided ignore num is invalid');
											return;
										}
									}

									const ignoredList = userPokemonList.slice(0, ignoreNum);
									let sortableList = userPokemonList.slice(ignoreNum);

									const dexMap = new Map();
									allPokemonList.forEach(pokemon => {
										if (pokemon.name === 'Nidoran') {
											if (pokemon.dexNum === '29') {
												dexMap.set('Nidoran-Female', { dexNum: 29, isLM: pokemon.isLM });
											}
											if (pokemon.dexNum === '32') {
												dexMap.set('Nidoran-Male', { dexNum: 32, isLM: pokemon.isLM });
											}
										}
										else {
											dexMap.set(pokemon.name, {dexNum: pokemon.dexNum, isLM: pokemon.isLM});
										}
									});

									const countMap = new Map();
									sortableList.forEach(pokemon => {
										let name = pokemon.name.startsWith('✨') ? pokemon.name.substring(1) : pokemon.name;
										if (name === 'Nidoran') {
											if (pokemon.gender === 'Female') {
												name = 'Nidoran-Female';
											}
											else {
												name = 'Nidoran-Male';
											}
										}
										if (!countMap.has(name)) {
											countMap.set(name, { count: 0, shiny: 0 });
										}
										let entry = countMap.get(name);
										entry.count += 1;
										if (pokemon.name.startsWith('✨')) {
											entry.shiny += 1;
										}
										countMap.set(name, entry);
									});

									sortableList.sort((a, b) => {
										let nameA = a.name.startsWith('✨') ? a.name.substring(1) : a.name;
										let nameB = b.name.startsWith('✨') ? b.name.substring(1) : b.name;

										//Pesky Nidoran
										if (nameA === 'Nidoran') {
											if (a.gender === 'Female') {
												nameA = 'Nidoran-Female';
											}
											else {
												nameA = 'Nidoran-Male';
											}
										}
										if (nameB === 'Nidoran') {
											if (b.gender === 'Female') {
												nameB = 'Nidoran-Female';
											}
											else {
												nameB = 'Nidoran-Male';
											}
										}

										let dexA = dexMap.get(nameA) || { dexNum: 9999, isLM: 0 };
										let dexB = dexMap.get(nameB) || { dexNum: 9999, isLM: 0 };

										let countA = countMap.get(nameA);
										let countB = countMap.get(nameB);

										//shiny
										if (a.name.startsWith('✨') && !b.name.startsWith('✨')) {
											return -1;
										}
										if (!a.name.startsWith('✨') && b.name.startsWith('✨')) {
											return 1;
										}

										//within shiny: count low to high -> mythical -> legendary -> regular
										if (a.name.startsWith('✨') && b.name.startsWith('✨')) {
											if (countA.count !== countB.count) {
												return countA.count - countB.count;
											}
											if (dexA.isLM !== dexB.isLM) {
												return dexB.isLM - dexA.isLM;
											}
											if (dexA.dexNum !== dexB.dexNum) {
												return dexA.dexNum - dexB.dexNum;
											}
											return nameA.localeCompare(nameB);
										}

										//mythical
										if (dexA.isLM === 2 && dexB.isLM !== 2) {
											return -1;
										}
										if (dexA.isLM !== 2 && dexB.isLM === 2) {
											return 1;
										}

										//within mythical: count low to high -> dex num -> alphabetical
										if (dexA.isLM === 2 && dexB.isLM === 2) {
											if (countA.count !== countB.count) {
												return countA.count - countB.count;
											}
											if (dexA.dexNum !== dexB.dexNum) {
												return dexA.dexNum - dexB.dexNum;
											}
											return nameA.localeCompare(nameB);
										}

										//legendary
										if (dexA.isLM === 1 && dexB.isLM !== 1) {
											return -1;
										}
										if (dexA.isLM !== 1 && dexB.isLM === 1) {
											return 1;
										}

										//within legendary: count low to high -> dex num -> alphabetical
										if (dexA.isLM === 1 && dexB.isLM === 1) {
											if (countA.count !== countB.count) {
												return countA.count - countB.count;
											}
											if (dexA.dexNum !== dexB.dexNum) {
												return dexA.dexNum - dexB.dexNum;
											}
											return nameA.localeCompare(nameB);
										}

										//regular pokemon, dex number
										if (dexA.dexNum !== dexB.dexNum) {
											return dexA.dexNum - dexB.dexNum;
										}

										// Alphabetical as a last resort
										return nameA.localeCompare(nameB); 
									});

									let finalList = ignoredList.concat(sortableList);

									dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(finalList), userId], (err3) => {
										if (err3) {
											console.error(err3.message);
											   message.channel.send('An error occurred while saving your Pokémon order.');
											return;
										}
										message.channel.send('Pokémon successfully ordered.');
									});
								});
							});
						}
						else {
							message.channel.send('Improper command usage. Orders: `flexdex`, `dex`, `countHigh`, `countLow`, and `alphabetical`');
						}
					}
					else {
						message.channel.send('Improper command usage. Example: .order <order> <ignorenum>');
					}
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

			//shop
			else if (shopCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					let shopPages = null;
					const args = message.content.split(' ').slice(1);
					if (!args || args.length < 1 || args[0] === ' ') {
						shopPages = [
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('General Shop (Page 1/5)')
								.setDescription('List of available items in the shop' + '\n' + 
									'Use the command .buy <shopNum> to purchase an item' + '\n' + 
									'For specific pokemon shops, use `.shop <shop name>`' + '\n' + 
									'Current shops: `Mega`, `Rotom`, `Arceus`, and `Furfrou`')
								.addFields(
									{ name: '` 1:` **Normal Repel (1000)**', value: 'Has a 50% chance to drop an uncaught Pokemon' },
									{ name: '` 2:` **Super Repel (1500)**', value: 'Has a 75% chance to drop an uncaught Pokemon' },
									{ name: '` 3:` **Max Repel (2000)**', value: 'Has a 90% chance to drop an uncaught Pokemon' },
									{ name: '` 4:` **Legendary Repel (10000)**', value: 'Makes your next pokemon drop a legendary pokemon' + '\n' + '__It is recommended to do this in a private place!__' },
									{ name: '` 5:` **Mythical Repel (15000)**', value: 'Makes your next pokemon drop a mythical pokemon' + '\n' + '__It is recommended to do this in a private place!__' },
									{ name: '` 6:` **Shiny Repel (20000)**', value: 'Makes your next pokemon drop a shiny pokemon' + '\n' + '__It is recommended to do this in a private place!__' }
									
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('General Shop (Page 2/5)')
								.setDescription('List of available items in the shop' + '\n' + 
									'Use the command .buy <shopNum> to purchase an item' + '\n' + 
									'For specific pokemon shops, use `.shop <shop name>`' + '\n' + 
									'Current shops: `Mega`, `Rotom`, `Arceus`, and `Furfrou`')
								.addFields(
									{ name: '` 7:` **Fire Stone (1000)**', value: 'Fire stone (coming soon)' },
									{ name: '` 8:` **Water Stone (1000)**', value: 'Water evolution stone (coming soon)' },
									{ name: '` 9:` **Thunder Stone (1000)**', value: 'Electric evolution Stone (coming soon)' },
									{ name: '`10:` **Leaf Stone (1000)**', value: 'Grass evolution Stone (coming soon)' },
									{ name: '`11:` **Moon Stone (1000)**', value: 'Moon evolution Stone (coming soon)' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('General Shop (Page 3/5)')
								.setDescription('List of available items in the shop' + '\n' + 
									'Use the command .buy <shopNum> to purchase an item' + '\n' + 
									'For specific pokemon shops, use `.shop <shop name>`' + '\n' + 
									'Current shops: `Mega`, `Rotom`, `Arceus`, and `Furfrou`')
								.addFields(
									{ name: '`12:` **Sun Stone (1000)**', value: 'Sun evolution Stone (coming soon)' },
									{ name: '`13:` **Shiny Stone (1000)**', value: 'Shiny evolution Stone (coming soon)' },
									{ name: '`14:` **Dusk Stone (1000)**', value: 'Dusk evolution Stone (coming soon)' },
									{ name: '`15:` **Dawn Stone (1000)**', value: 'Dawn evolution Stone (coming soon)' },
									{ name: '`16:` **Ice Stone (1000)**', value: 'Ice evolution Stone (coming soon)' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('General Shop (Page 4/5)')
								.setDescription('List of available items in the shop' + '\n' + 
									'Use the command .buy <shopNum> to purchase an item' + '\n' + 
									'For specific pokemon shops, use `.shop <shop name>`' + '\n' + 
									'Current shops: `Mega`, `Rotom`, `Arceus`, and `Furfrou`')
								.addFields(
									{ name: '`17:` **Defaulter (500)**', value: '**REUSABLE**: Resets the Pokemon\'s form to default' },
									{ name: '`18:` **Gracidea Flower (2000)**', value: '**REUSABLE**: Flower for Shaymin Skye Forme transformation' },
									{ name: '`19:` **Reveal Glass (2000)**', value: '**REUSABLE**: Glass for Tornadus/Thundurus/Landorus Therian transformation' },
									{ name: '`20:` **White DNA Splicer (2000)**', value: '**REUSABLE**: DNA splicer for Reshiram/White Kyurem transformation' },
									{ name: '`21:` **Black DNA Splicer (2000)**', value: '**REUSABLE**: DNA splicer for Zekrom/Black Kyurem transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('General Shop (Page 5/5)')
								.setDescription('List of available items in the shop' + '\n' + 
									'Use the command .buy <shopNum> to purchase an item' + '\n' + 
									'For specific pokemon shops, use `.shop <shop name>`' + '\n' + 
									'Current shops: `Mega`, `Rotom`, `Arceus`, and `Furfrou`')
								.addFields(
									{ name: '`22:` **Prison Bottle (2000)**', value: '**REUSABLE**: Bottle for Hoopa Unbound transformation' },
									{ name: '`23:` **Rare Candy (500)**', value: 'Levels a pokemon up (coming soon)' }
								)
								.setTimestamp()
						]
					}
					//Start at 100
					else if (args[0].toLowerCase() === 'mega') {
						shopPages = [
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 1/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`100:` **Venusaurite (2500)**', value: '**REUSABLE**: Mega Stone for Venusaur transformation' },
									{ name: '`101:` **Charizardite X (2500)**', value: '**REUSABLE**: Mega Stone for Charizard transformation' },
									{ name: '`102:` **Charizardite Y (2500)**', value: '**REUSABLE**: Mega Stone for Charizard transformation' },
									{ name: '`103:` **Blastoisinite (2500)**', value: '**REUSABLE**: Mega Stone for Blastoise transformation' },
									{ name: '`104:` **Beedrillite (2500)**', value: '**REUSABLE**: Mega Stone for Beedrill transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 2/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`105:` **Pidgeotite (2500)**', value: '**REUSABLE**: Mega Stone for Pidgeot transformation' },
									{ name: '`106:` **Alakazite (2500)**', value: '**REUSABLE**: Mega Stone for Alakazam transformation' },
									{ name: '`107:` **Slowbronite (2500)**', value: '**REUSABLE**: Mega Stone for Slowbro transformation' },
									{ name: '`108:` **Gengarite (2500)**', value: '**REUSABLE**: Mega Stone for Gengar transformation' },
									{ name: '`109:` **Kangaskhanite (2500)**', value: '**REUSABLE**: Mega Stone for Kangaskhan transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 3/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`110:` **Pinsirite (2500)**', value: '**REUSABLE**: Mega Stone for Pinsir transformation' },
									{ name: '`111:` **Gyaradosite (2500)**', value: '**REUSABLE**: Mega Stone for Gyarados transformation' },
									{ name: '`112:` **Aerodactylite (2500)**', value: '**REUSABLE**: Mega Stone for Aerodactyl transformation' },
									{ name: '`113:` **Mewtwonite X (2500)**', value: '**REUSABLE**: Mega Stone for Mewtwo transformation' },
									{ name: '`114:` **Mewtwonite Y (2500)**', value: '**REUSABLE**: Mega Stone for Mewtwo transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 4/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`115:` **Ampharosite (2500)**', value: '**REUSABLE**: Mega Stone for Ampharos transformation' },
									{ name: '`116:` **Steelixite (2500)**', value: '**REUSABLE**: Mega Stone for Steelix transformation' },
									{ name: '`117:` **Scizorite (2500)**', value: '**REUSABLE**: Mega Stone for Scizor transformation' },
									{ name: '`118:` **Heracronite (2500)**', value: '**REUSABLE**: Mega Stone for Heracross transformation' },
									{ name: '`119:` **Houndoominite (2500)**', value: '**REUSABLE**: Mega Stone for Houndoom transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 5/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`120:` **Tyranitarite (2500)**', value: '**REUSABLE**: Mega Stone for Tyranitar transformation' },
									{ name: '`121:` **Sceptilite (2500)**', value: '**REUSABLE**: Mega Stone for Sceptile transformation' },
									{ name: '`122:` **Blazikenite (2500)**', value: '**REUSABLE**: Mega Stone for Blaziken transformation' },
									{ name: '`123:` **Swampertite (2500)**', value: '**REUSABLE**: Mega Stone for Swampert transformation' },
									{ name: '`124:` **Gardevoirite (2500)**', value: '**REUSABLE**: Mega Stone for Gardevoir transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 6/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`125:` **Sablenite (2500)**', value: '**REUSABLE**: Mega Stone for Sableye transformation' },
									{ name: '`126:` **Mawilite (2500)**', value: '**REUSABLE**: Mega Stone for Mawile transformation' },
									{ name: '`127:` **Aggronite (2500)**', value: '**REUSABLE**: Mega Stone for Aggron transformation' },
									{ name: '`128:` **Medichamite (2500)**', value: '**REUSABLE**: Mega Stone for Medicham transformation' },
									{ name: '`129:` **Manectite (2500)**', value: '**REUSABLE**: Mega Stone for Manectric transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 7/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`130:` **Sharpedonite (2500)**', value: '**REUSABLE**: Mega Stone for Sharpedo transformation' },
									{ name: '`131:` **Cameruptite (2500)**', value: '**REUSABLE**: Mega Stone for Camerupt transformation' },
									{ name: '`132:` **Altarianite (2500)**', value: '**REUSABLE**: Mega Stone for Altaria transformation' },
									{ name: '`133:` **Banettite (2500)**', value: '**REUSABLE**: Mega Stone for Banette transformation' },
									{ name: '`134:` **Absolite (2500)**', value: '**REUSABLE**: Mega Stone for Absol transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 8/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`135:` **Glalitite (2500)**', value: '**REUSABLE**: Mega Stone for Glalie transformation' },
									{ name: '`136:` **Salamencite (2500)**', value: '**REUSABLE**: Mega Stone for Salamence transformation' },
									{ name: '`137:` **Metagrossite (2500)**', value: '**REUSABLE**: Mega Stone for Metagross transformation' },
									{ name: '`138:` **Latiasite (2500)**', value: '**REUSABLE**: Mega Stone for Latias transformation' },
									{ name: '`139:` **Latiosite (2500)**', value: '**REUSABLE**: Mega Stone for Latios transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 9/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`140:` **Lopunnite (2500)**', value: '**REUSABLE**: Mega Stone for Lopunny transformation' },
									{ name: '`141:` **Garchompite (2500)**', value: '**REUSABLE**: Mega Stone for Garchomp transformation' },
									{ name: '`142:` **Lucarionite (2500)**', value: '**REUSABLE**: Mega Stone for Lucario transformation' },
									{ name: '`143:` **Abomasite (2500)**', value: '**REUSABLE**: Mega Stone for Abomasnow transformation' },
									{ name: '`144:` **Galladite (2500)**', value: '**REUSABLE**: Mega Stone for Gallade transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Mega Stone Shop (Page 10/10)')
								.setDescription('List of available Mega Stone items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`145:` **Audinite (2500)**', value: '**REUSABLE**: Mega Stone for Audino transformation' },
									{ name: '`146:` **Diancite (2500)**', value: '**REUSABLE**: Mega Stone for Diancie transformation' }
								)
								.setTimestamp()
						]
					}
					//Start at 200
					else if (args[0].toLowerCase() === 'gigantamax') {
						message.channel.send('Not implemented yet!');
						return;
					}
					//Start at 500
					else if (args[0].toLowerCase() === 'rotom') {
						shopPages = [
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Rotom Shop')
								.setDescription('List of available Rotom items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item' + '\n' + 'You will get your appliance back if Rotom is no longer actively using it')
								.addFields(
									{ name: '`500:` **Stove (2000)**', value: '**CONSUMABLE**: Stove for Rotom transformation' },
									{ name: '`501:` **Washing Machine (2000)**', value: '**CONSUMABLE**: Washing machine for Rotom transformation' },
									{ name: '`502:` **Fridge (2000)**', value: '**CONSUMABLE**: Fridge for Rotom transformation' },
									{ name: '`503:` **Fan (2000)**', value: '**CONSUMABLE**: Fan for Rotom transformation' },
									{ name: '`504:` **Lawn Mower (2000)**', value: '**CONSUMABLE**: Lawn mower for Rotom transformation' }
								)
								.setTimestamp()
						]
					}
					else if (args[0].toLowerCase() === 'arceus') {
						shopPages = [
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Arceus Shop (Page 1/4)')
								.setDescription('List of available Arceus items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item' + '\n' + 'You will get your plates back if Arceus is no longer actively using it')
								.addFields(
									{ name: '`505:` **Fist Plate (2000)**', value: '**CONSUMABLE**: Fist plate for Arceus transformation' },
									{ name: '`506:` **Sky Plate (2000)**', value: '**CONSUMABLE**: Sky plate for Arceus transformation' },
									{ name: '`507:` **Toxic Plate (2000)**', value: '**CONSUMABLE**: Toxic plate for Arceus transformation' },
									{ name: '`508:` **Earth Plate (2000)**', value: '**CONSUMABLE**: Earth plate for Arceus transformation' },
									{ name: '`509:` **Stone Plate (2000)**', value: '**CONSUMABLE**: Stone plate for Arceus transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Arceus Shop (Page 2/4)')
								.setDescription('List of available Arceus items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item' + '\n' + 'You will get your plates back if Arceus is no longer actively using it')
								.addFields(
									{ name: '`510:` **Insect Plate (2000)**', value: '**CONSUMABLE**: Insect plate for Arceus transformation' },
									{ name: '`511:` **Spooky Plate (2000)**', value: '**CONSUMABLE**: Spooky plate for Arceus transformation' },
									{ name: '`512:` **Iron Plate (2000)**', value: '**CONSUMABLE**: Iron plate for Arceus transformation' },
									{ name: '`513:` **Flame Plate (2000)**', value: '**CONSUMABLE**: Flame plate for Arceus transformation' },
									{ name: '`514:` **Splash Plate (2000)**', value: '**CONSUMABLE**: Splash plate for Arceus transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Arceus Shop (Page 3/4)')
								.setDescription('List of available Arceus items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item' + '\n' + 'You will get your plates back if Arceus is no longer actively using it')
								.addFields(
									{ name: '`515:` **Meadow Plate (2000)**', value: '**CONSUMABLE**: Meadow plate for Arceus transformation' },
									{ name: '`516:` **Zap Plate (2000)**', value: '**CONSUMABLE**: Zap plate for Arceus transformation' },
									{ name: '`517:` **Mind Plate (2000)**', value: '**CONSUMABLE**: Mind plate for Arceus transformation' },
									{ name: '`518:` **Icicle Plate (2000)**', value: '**CONSUMABLE**: Icicle plate for Arceus transformation' },
									{ name: '`519:` **Draco Plate (2000)**', value: '**CONSUMABLE**: Draco plate for Arceus transformation' }
								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Arceus Shop (Page 4/4)')
								.setDescription('List of available Arceus items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item' + '\n' + 'You will get your plates back if Arceus is no longer actively using it')
								.addFields(
									{ name: '`520:` **Dread Plate (2000)**', value: '**CONSUMABLE**: Dread plate for Arceus transformation' },
									{ name: '`521:` **Pixie Plate (2000)**', value: '**CONSUMABLE**: Pixie plate for Arceus transformation' }
								)
								.setTimestamp()
						]
					}
					else if (args[0].toLowerCase() === 'furfrou') {
						shopPages = [
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Furfrou Shop (Page 1/2)')
								.setDescription('List of available items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`522:` **Heart Trim (2000)**', value: '**CONSUMABLE**: Heart trim for Furfrou transformation' },
									{ name: '`523:` **Star Trim (2000)**', value: '**CONSUMABLE**: Star trim for Furfrou transformation' },
									{ name: '`524:` **Diamond Trim (2000)**', value: '**CONSUMABLE**: Diamond trim for Furfrou transformation' },
									{ name: '`525:` **Debutante Trim (2000)**', value: '**CONSUMABLE**: Debutante trim for Furfrou transformation' },
									{ name: '`526:` **Matron Trim (2000)**', value: '**CONSUMABLE**: Matron trim for Furfrou transformation' }

								)
								.setTimestamp(),
							new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle('Furfrou Shop (Page 2/2)')
								.setDescription('List of available items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
								.addFields(
									{ name: '`527:` **Dandy Trim (2000)**', value: '**CONSUMABLE**: Dandy trim for Furfrou transformation' },
									{ name: '`528:` **La Reine Trim (2000)**', value: '**CONSUMABLE**: La Reine trim for Furfrou transformation' },
									{ name: '`529:` **Kabuki Trim (2000)**', value: '**CONSUMABLE**: Kabuki trim for Furfrou transformation' },
									{ name: '`530:` **Pharaoh Trim (2000)**', value: '**CONSUMABLE**: Pharaoh trim for Furfrou transformation' }
								)
								.setTimestamp(),
						]
					}
					else {
						message.channel.send('Shop doesn\'t exist');
						return;
					}

					let page = 0;
					const totalPages = shopPages.length;

					const buttonRow = new ActionRowBuilder()
						.addComponents(
							new ButtonBuilder()
								.setCustomId('prevPage')
								.setLabel('◀')
								.setStyle(ButtonStyle.Primary),
							new ButtonBuilder()
								.setCustomId('nextPage')
								.setLabel('▶')
								.setStyle(ButtonStyle.Primary)
						);

					message.channel.send({ embeds: [shopPages[page]], components: [buttonRow] }).then(sentMessage => {
						const filter = i => i.user.id === message.author.id;
           				const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

						collector.on('collect', async i => {
							try {
								if (i.customId === 'prevPage') {
									page = page - 1;
									if (page < 0) {
										page = totalPages - 1;
									}
								}
								else if (i.customId === 'nextPage') {
									page = page + 1;
									if (page > totalPages - 1) {
										page = 0;
									}
								}
			
								await i.update({ embeds: [shopPages[page]], components: [buttonRow] });
							} catch (error) {
								if (error.code === 10008) {
									console.log('The message was deleted before the interaction was handled.');
								}
								else {
									console.error('An unexpected error occurred:', error);
								}
							}
						});

						collector.on('end', async () => {
							try {
								const disabledRow = new ActionRowBuilder()
									.addComponents(
										new ButtonBuilder()
											.setCustomId('prevPage')
											.setLabel('◀')
											.setStyle(ButtonStyle.Primary)
											.setDisabled(true),
										new ButtonBuilder()
											.setCustomId('nextPage')
											.setLabel('▶')
											.setStyle(ButtonStyle.Primary)
											.setDisabled(true)
									);
								await sentMessage.edit({ components: [disabledRow] });
							} catch (error) {
								if (error.code === 10008) {
									console.log('The message was deleted before the interaction was handled.');
								}
								else {
									console.error('An unexpected error occurred:', error);
								}
							}
						});
					}).catch(err => {
						console.error('Error sending the shop message:', err);
					})
				});
			}

			//buy
			else if (buyCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const args = message.content.split(' ');
					if (args.length < 2) {
						message.channel.send('Please specify a valid shop number. Usage: `.buy <shopNum>`');
						return;
					}
					let shopNum = args[1];
					let quantityNum = null;
					if (args.length > 2) {
						quantityNum = parseInt(args[2], 10);
					}
					else {
						quantityNum = 1;
					}
					if (isNaN(quantityNum)) {
						message.channel.send('Syntax error on quantity, defaulting to 1.');
						quantityNum = 1;
					}
					let isNum = !isNaN(shopNum);
					if (!isNum) {
						message.channel.send('Please specify a valid shop number. Usage: `.buy <shopNum>`');
						return;
					}
					dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your currency.');
							return;
						}
						if (!row) {
							message.channel.send('You do not have enough currency to purchase an item.');
						}
						let userCurrency = row.currency;
						let boughtItem = '';
						let amount = 0;
						if (userCurrency < 500) {
							message.channel.send('You do not have enough currency to purchase an item.');
						}
						//General Store Start
						else if (shopNum === '1'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Normal Repel';
							amount = 1000;
						}
						else if (shopNum === '2'  && userCurrency >= 1500 * quantityNum) {
							userCurrency -= (1500 * quantityNum);
							boughtItem = 'Super Repel';
							amount = 1500;
						}
						else if (shopNum === '3'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Max Repel';
							amount = 2000;
						}
						else if (shopNum === '4'  && userCurrency >= 10000 * quantityNum) {
							userCurrency -= (10000 * quantityNum);
							boughtItem = 'Legendary Repel';
							amount = 10000;
						}
						else if (shopNum === '5'  && userCurrency >= 15000 * quantityNum) {
							userCurrency -= (15000 * quantityNum);
							boughtItem = 'Mythical Repel';
							amount = 15000;
						}
						else if (shopNum === '6'  && userCurrency >= 20000 * quantityNum) {
							userCurrency -= (20000 * quantityNum);
							boughtItem = 'Shiny Repel';
							amount = 20000;
						}
						else if (shopNum === '7'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Fire Stone';
							amount = 1000;
						}
						else if (shopNum === '8'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Water Stone';
							amount = 1000;
						}
						else if (shopNum === '9'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Thunder Stone';
							amount = 1000;
						}
						else if (shopNum === '10'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Leaf Stone';
							amount = 1000;
						}
						else if (shopNum === '11'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Moon Stone';
							amount = 1000;
						}
						else if (shopNum === '12'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Sun Stone';
							amount = 1000;
						}
						else if (shopNum === '13'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Shiny Stone';
							amount = 1000;
						}
						else if (shopNum === '14'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Dusk Stone';
							amount = 1000;
						}
						else if (shopNum === '15'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Dawn Stone';
							amount = 1000;
						}
						else if (shopNum === '16'  && userCurrency >= 1000 * quantityNum) {
							userCurrency -= (1000 * quantityNum);
							boughtItem = 'Ice Stone';
							amount = 1000;
						}
						else if (shopNum === '17'  && userCurrency >= 500 * quantityNum) {
							userCurrency -= (500 * quantityNum);
							boughtItem = 'Defaulter';
							amount = 500;
						}
						else if (shopNum === '18'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Gracidea Flower';
							amount = 2000;
						}
						else if (shopNum === '19'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Reveal Glass';
							amount = 2000;
						}
						else if (shopNum === '20'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'White DNA Splicer';
							amount = 2000;
						}
						else if (shopNum === '21'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Black DNA Splicer';
							amount = 2000;
						}
						else if (shopNum === '22' && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Prison Bottle';
							amount = 2000;
						}
						else if (shopNum === '23' && userCurrency >= 500 * quantityNum) {
							userCurrency -= (500 * quantityNum);
							boughtItem = 'Rare Candy';
							amount = 500;
						}
						//General Store End

						//Mega Store Start
						else if (shopNum === '100' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Venusaurite';
							amount = 2500;
						}
						else if (shopNum === '101' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Charizardite X';
							amount = 2500;
						}
						else if (shopNum === '102' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Charizardite Y';
							amount = 2500;
						}
						else if (shopNum === '103' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Blastoisinite';
							amount = 2500;
						}
						else if (shopNum === '104' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Beedrillite';
							amount = 2500;
						}
						else if (shopNum === '105' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Pidgeotite';
							amount = 2500;
						}
						else if (shopNum === '106' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Alakazite';
							amount = 2500;
						}
						else if (shopNum === '107' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Slowbronite';
							amount = 2500;
						}
						else if (shopNum === '108' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Gengarite';
							amount = 2500;
						}
						else if (shopNum === '109' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Kangaskhanite';
							amount = 2500;
						}
						else if (shopNum === '110' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Pinsirite';
							amount = 2500;
						}
						else if (shopNum === '111' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Gyaradosite';
							amount = 2500;
						}
						else if (shopNum === '112' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Aerodactylite';
							amount = 2500;
						}
						else if (shopNum === '113' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Mewtwonite X';
							amount = 2500;
						}
						else if (shopNum === '114' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Mewtwonite Y';
							amount = 2500;
						}
						else if (shopNum === '115' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Ampharosite';
							amount = 2500;
						}
						else if (shopNum === '116' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Steelixite';
							amount = 2500;
						}
						else if (shopNum === '117' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Scizorite';
							amount = 2500;
						}
						else if (shopNum === '118' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Heracronite';
							amount = 2500;
						}
						else if (shopNum === '119' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Houndoominite';
							amount = 2500;
						}
						else if (shopNum === '120' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Tyranitarite';
							amount = 2500;
						}
						else if (shopNum === '121' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Sceptilite';
							amount = 2500;
						}
						else if (shopNum === '122' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Blazikenite';
							amount = 2500;
						}
						else if (shopNum === '123' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Swampertite';
							amount = 2500;
						}
						else if (shopNum === '124' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Gardevoirite';
							amount = 2500;
						}
						else if (shopNum === '125' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Sablenite';
							amount = 2500;
						}
						else if (shopNum === '126' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Mawilite';
							amount = 2500;
						}
						else if (shopNum === '127' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Aggronite';
							amount = 2500;
						}
						else if (shopNum === '128' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Medichamite';
							amount = 2500;
						}
						else if (shopNum === '129' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Manectite';
							amount = 2500;
						}
						else if (shopNum === '130' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Sharpedonite';
							amount = 2500;
						}
						else if (shopNum === '131' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Cameruptite';
							amount = 2500;
						}
						else if (shopNum === '132' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Altarianite';
							amount = 2500;
						}
						else if (shopNum === '133' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Banettite';
							amount = 2500;
						}
						else if (shopNum === '134' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Absolite';
							amount = 2500;
						}
						else if (shopNum === '135' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Glalitite';
							amount = 2500;
						}
						else if (shopNum === '136' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Salamencite';
							amount = 2500;
						}
						else if (shopNum === '137' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Metagrossite';
							amount = 2500;
						}
						else if (shopNum === '138' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Latiasite';
							amount = 2500;
						}
						else if (shopNum === '139' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Latiosite';
							amount = 2500;
						}
						else if (shopNum === '140' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Lopunnite';
							amount = 2500;
						}
						else if (shopNum === '141' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Garchompite';
							amount = 2500;
						}
						else if (shopNum === '142' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Lucarionite';
							amount = 2500;
						}
						else if (shopNum === '143' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Abomasite';
							amount = 2500;
						}
						else if (shopNum === '144' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Galladite';
							amount = 2500;
						}
						else if (shopNum === '145' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Audinite';
							amount = 2500;
						}
						else if (shopNum === '146' && userCurrency >= 2500 * quantityNum) {
							userCurrency -= (2500 * quantityNum);
							boughtItem = 'Diancite';
							amount = 2500;
						}
						//Mega Store End

						//Gigantamax Store Start
						//Gigantamax Store End

						//Rotom Store Start
						else if (shopNum === '500'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Stove';
							amount = 2000;
						}
						else if (shopNum === '501'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Washing Machine';
							amount = 2000;
						}
						else if (shopNum === '502'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Fridge';
							amount = 2000;
						}
						else if (shopNum === '503'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Fan';
							amount = 2000;
						}
						else if (shopNum === '504'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Lawn Mower';
							amount = 2000;
						}
						//Rotom Store End

						//Arceus Store Start
						else if (shopNum === '505'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Fist Plate';
							amount = 2000;
						}
						else if (shopNum === '506'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Sky Plate';
							amount = 2000;
						}
						else if (shopNum === '507'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Toxic Plate';
							amount = 2000;
						}
						else if (shopNum === '508'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Earth Plate';
							amount = 2000;
						}
						else if (shopNum === '509'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Stone Plate';
							amount = 2000;
						}
						else if (shopNum === '510'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Insect Plate';
							amount = 2000;
						}
						else if (shopNum === '511'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Spooky Plate';
							amount = 2000;
						}
						else if (shopNum === '512'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Iron Plate';
							amount = 2000;
						}
						else if (shopNum === '513'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Flame Plate';
							amount = 2000;
						}
						else if (shopNum === '514'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Splash Plate';
							amount = 2000;
						}
						else if (shopNum === '515'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Meadow Plate';
							amount = 2000;
						}
						else if (shopNum === '516'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Zap Plate';
							amount = 2000;
						}
						else if (shopNum === '517'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Mind Plate';
							amount = 2000;
						}
						else if (shopNum === '518'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Icicle Plate';
							amount = 2000;
						}
						else if (shopNum === '519'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Draco Plate';
							amount = 2000;
						}
						else if (shopNum === '520'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Dread Plate';
							amount = 2000;
						}
						else if (shopNum === '521'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Pixie Plate';
							amount = 2000;
						}
						//Arceus Store End

						//Furfrou Store Start
						else if (shopNum === '522'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Heart Trim';
							amount = 2000;
						}
						else if (shopNum === '523'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Star Trim';
							amount = 2000;
						}
						else if (shopNum === '524'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Diamond Trim';
							amount = 2000;
						}
						else if (shopNum === '525'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Debutante Trim';
							amount = 2000;
						}
						else if (shopNum === '526'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Matron Trim';
							amount = 2000;
						}
						else if (shopNum === '527'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Dandy Trim';
							amount = 2000;
						}
						else if (shopNum === '528'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'La Reine Trim';
							amount = 2000;
						}
						else if (shopNum === '529'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Kabuki Trim';
							amount = 2000;
						}
						else if (shopNum === '530'  && userCurrency >= 2000 * quantityNum) {
							userCurrency -= (2000 * quantityNum);
							boughtItem = 'Pharaoh Trim';
							amount = 2000;
						}
						//Furfrou Store end

						else {
							message.channel.send('You do not have enough currency to purchase requested item or it doesn\'t exist.');
						}
						if (boughtItem !== '') {
							const embed = new EmbedBuilder()
							.setColor('#ff0000')
							.setTitle('Buy Item')
							.setDescription(`Really buy ${quantityNum} ${boughtItem}(s) for ${quantityNum * amount}? Leftover currency after transaction: ${userCurrency}`)
							.setTimestamp();

							const buttonRow = new ActionRowBuilder()
							.addComponents(
							new ButtonBuilder()
								.setCustomId('buy_yes')
								.setLabel('Yes')
								.setStyle(ButtonStyle.Success),
							new ButtonBuilder()
								.setCustomId('buy_no')
								.setLabel('No')
								.setStyle(ButtonStyle.Danger)
							);

							message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
								const filter = i => i.user.id === message.author.id;
								const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });
							
								collector.on('collect', async i => {
									try {
										if (i.customId === 'buy_yes') {
											const userInventory = JSON.parse(row.inventory);
											for (let i = 0; i < quantityNum; i++) {
												userInventory.push(boughtItem);
											}
											dbUser.run("UPDATE user SET inventory = ?, currency = ? WHERE user_id = ?", [JSON.stringify(userInventory), userCurrency, userId], (err) => {
												if (err) {
													console.error(err.message);
												}
												i.update({ content: `Successfully purchased ${quantityNum} ${boughtItem}(s) for ${quantityNum * amount}. You have ${userCurrency} leftover.`, embeds: [], components: [] });
											});
										} 
										else if (i.customId === 'buy_no') {
											i.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
										}
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});
	
								collector.on('end', async () => {
									try {
										await sentMessage.edit({components: [] });
									} catch (error) {
										if (error.code === 10008) {
											console.log('The message was deleted before the interaction was handled.');
										}
										else {
											console.error('An unexpected error occurred:', error);
										}
									}
								});
							}).catch(err => {
								console.error('Error sending the confirm item message', err);
							});
						}
					});
				});
			}
			
			//inventory
			else if (inventoryCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your inventory.');
							return;
						}
						if (!row || row.inventory === '[]') {
							message.channel.send('You have not purchased any items yet.');
							return;
						}
						const userInventory = JSON.parse(row.inventory);
						const pageSize = 20;
						let page = 0;
						const embed = generatePartyEmbed(userInventory, page, pageSize, `Your Inventory`, 0);
						const buttonRow = getPartyBtns();

						message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
							const filter = i => i.user.id === userId;
							const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

							collector.on('collect', async i => {
								try {
									if (i.customId === 'prev') {
										if (page > 0) {
											page--;
										}
										else {
											page = Math.ceil(userInventory.length / pageSize) - 1;
										}
									} 
									else if (i.customId === 'next') {
										if ((page + 1) * pageSize < userInventory.length) {
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
										page = Math.ceil(userInventory.length / pageSize) - 1;;
									}
	
									await i.update({ embeds: [generatePartyEmbed(userInventory, page, pageSize, `Your Inventory`, 0)] });
								} catch (error) {
									if (error.code === 10008) {
										console.log('The message was deleted before the interaction was handled.');
									}
									else {
										console.error('An unexpected error occurred:', error);
									}
								}
							});

							collector.on('end', async () => {
								try {
									const disabledRow = getDisablePartyBtns();
									await sentMessage.edit({ components: [disabledRow] });
								} catch (error) {
									if (error.code === 10008) {
										console.log('The message was deleted before the interaction was handled.');
									}
									else {
										console.error('An unexpected error occurred:', error);
									}
								}
							});
						}).catch(err => {
							console.error('Error sending the inventory message:', err);
						});
					});
				});
			}

			//use
			else if (useCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const args = message.content.split(' ').slice(1);
					if (args.length === 2 && !isNaN(args[0]) && !isNaN(args[1])) {
						const itemNum = parseInt(args[0], 10);
						const partyNum = parseInt(args[1], 10);
						if (isNaN(itemNum) || isNaN(partyNum)) {
							message.channel.send('Improper command usage. Usage: `.use <itemNum> <partyNum>`');
							return;
						}
						dbUser.get("SELECT caught_pokemon, inventory FROM user WHERE user_id = ?", [userId], (err, row) => {
							if (err) {
								console.error(err.message);
								return;
							}
							if (!row) {
								message.channel.send('User has not caught a pokemon yet.');
								return;
							}
							let inventoryArr = JSON.parse(row.inventory).flat();
							let pokemonArr = JSON.parse(row.caught_pokemon).flat();
							if (inventoryArr.length < 1 || pokemonArr.length < 1) {
								message.channel.send('You have no items or you have no caught pokemon!');
								return;
							}
							if (itemNum > inventoryArr.length || itemNum < 1 || partyNum > pokemonArr.length || partyNum < 1) {
								message.channel.send('Improper command usage. Usage: `.use <itemNum> <partyNum>`');
								return;
							}

							const selectedItem = inventoryArr[itemNum - 1];
							const selectedMon = pokemonArr[partyNum - 1];
							let newItem = null;

							if (selectedMon.name === 'Rotom') {
								if (selectedItem === 'Stove') {
									if (selectedMon.form.toLowerCase() !== 'default') {
										newItem = selectedMon.form;
									}
									inventoryArr.splice(itemNum - 1, 1);
									pokemonArr[partyNum - 1].form = 'Heat';
								}
								else if (selectedItem === 'Washing Machine') {
									if (selectedMon.form.toLowerCase() !== 'default') {
										newItem = selectedMon.form;
									}
									inventoryArr.splice(itemNum - 1, 1);
									pokemonArr[partyNum - 1].form = 'Wash';
								}
								else if (selectedItem === 'Fridge') {
									if (selectedMon.form.toLowerCase() !== 'default') {
										newItem = selectedMon.form;
									}
									inventoryArr.splice(itemNum - 1, 1);
									pokemonArr[partyNum - 1].form = 'Frost';
								}
								else if (selectedItem === 'Fan') {
									if (selectedMon.form.toLowerCase() !== 'default') {
										newItem = selectedMon.form;
									}
									inventoryArr.splice(itemNum - 1, 1);
									pokemonArr[partyNum - 1].form = 'Fan';
								}
								else if (selectedItem === 'Lawn Mower') {
									if (selectedMon.form.toLowerCase() !== 'default') {
										newItem = selectedMon.form;
									}
									inventoryArr.splice(itemNum - 1, 1);
									pokemonArr[partyNum - 1].form = 'Mow';
								}
								else if (selectedItem === 'Defaulter') {
									if (selectedMon.form.toLowerCase() !== 'default') {
										newItem = selectedMon.form;
									}
									pokemonArr[partyNum - 1].form = 'Default';
								}
								else {
									message.channel.send('Could not use selected item on selected pokemon.');
									return;
								}

								if (newItem !== null && newItem === 'Heat') {
									newItem = 'Stove';
								}
								else if (newItem !== null && newItem === 'Wash') {
									newItem = 'Washing Machine';
								}
								else if (newItem !== null && newItem === 'Frost') {
									newItem = 'Fridge';
								}
								else if (newItem !== null && newItem === 'Mow') {
									newItem = 'Lawn Mower';
								}

								if (newItem !== null) {
									inventoryArr = inventoryArr.concat(newItem);
								}
							}
							
							else if (selectedMon.name === 'Shaymin') {
								if (selectedItem === 'Gracidea Flower') {
									pokemonArr[partyNum - 1].form = 'Sky Forme';
								}
								else if (selectedItem === 'Defaulter') {
									pokemonArr[partyNum - 1].form = 'Land Forme';
								}
								else {
									message.channel.send('Could not use selected item on selected pokemon.');
									return;
								}
							}
							else if (selectedMon.name === 'Tornadus' || selectedMon.name === 'Thundurus' || selectedMon.name === 'Landorus') {
								if (selectedItem === 'Reveal Glass') {
									pokemonArr[partyNum - 1].form = 'Therian';
								}
								else if (selectedItem === 'Defaulter') {
									pokemonArr[partyNum - 1].form = 'Incarnate';
								}
								else {
									message.channel.send('Could not use selected item on selected pokemon.');
									return;
								}
							}
							else if (selectedMon.name === 'Kyurem') {
								if (selectedItem === 'White DNA Splicer') {
									pokemonArr[partyNum - 1].form = 'White';
								}
								else if (selectedItem === 'Black DNA Splicer') {
									pokemonArr[partyNum - 1].form = 'Black';
								}
								else if (selectedItem === 'Defaulter') {
									pokemonArr[partyNum - 1].form = 'Default';
								}
								else {
									message.channel.send('Could not use selected item on selected pokemon.');
									return;
								}
							}
							//Mega
							else if (selectedItem.substring(selectedItem.length - 5, selectedItem.length).includes('ite')) {
								let megaOrbName = '';
								let xyFlag = '';
								if (selectedItem.charAt(selectedItem.length - 1) === 'X') {
									megaOrbName = selectedItem.substring(0, selectedItem.length - 7);
									xyFlag = 'X';
								}
								else if (selectedItem.charAt(selectedItem.length - 1) === 'Y') {
									megaOrbName = selectedItem.substring(0, selectedItem.length - 7);
									xyFlag = 'Y';
								}
								else {
									megaOrbName = selectedItem.substring(0, selectedItem.length - 5);
								}

								//edge cases, before general mega transformation
								if (selectedItem === 'Latiasite') {
									if (selectedMon.name === 'Latias') {
										pokemonArr[partyNum - 1].form = 'Mega';
									}
									else {
										message.channel.send('Could not use selected item on selected pokemon.');
										return;
									}
								}
								else if (selectedItem === 'Latiosite') {
									if (selectedMon.name === 'Latios') {
										pokemonArr[partyNum - 1].form = 'Mega';
									}
									else {
										message.channel.send('Could not use selected item on selected pokemon.');
										return;
									}
								}
								else if (selectedItem === 'Pidgeotite') {
									if (selectedMon.name === 'Pidgeot') {
										pokemonArr[partyNum - 1].form = 'Mega';
									}
									else {
										message.channel.send('Could not use selected item on selected pokemon.');
										return;
									}
								}
								else if (selectedItem === 'Diancite') {
									if (selectedMon.name === 'Diancie') {
										pokemonArr[partyNum - 1].form = 'Mega';
									}
									else {
										message.channel.send('Could not use selected item on selected pokemon.');
										return;
									}
								}
								else if (selectedMon.name.startsWith(megaOrbName)) {
									if (selectedMon.form.toLowerCase() !== 'default') {
										newItem = selectedMon.form;
									}
									if (xyFlag === 'X') {
										pokemonArr[partyNum - 1].form = 'Mega X';
									}
									else if (xyFlag === 'Y') {
										pokemonArr[partyNum - 1].form = 'Mega Y';
									}
									else {
										pokemonArr[partyNum - 1].form = 'Mega';
									}
								}
								else {
									message.channel.send('Could not use selected item on selected pokemon.');
									return;
								}
							}
							else if (selectedItem === 'Defaulter') {
								if (selectedMon.form.toLowerCase().includes('mega')) {
									pokemonArr[partyNum - 1].form = 'Default';
								}
							}
							else {
								message.channel.send('Could not use selected item on selected pokemon.');
								return;
							}

							dbUser.run("UPDATE user SET caught_pokemon = ?, inventory = ? WHERE user_id = ?", [JSON.stringify(pokemonArr), JSON.stringify(inventoryArr), userId], (err) => {
								if (err) {
									console.error('Error updating user inventory and caught pokemon:', err.message);
									return;
								}
								message.channel.send('Transformation Successful');
							});
						});
					}
					else if (args.length === 1 && !isNaN(args[0])) {
						const itemNum = parseInt(args[0], 10);
						if (isNaN(itemNum)) {
							message.channel.send('Improper command usage. Usage: `.use <itemNum>`');
							return;
						}
						dbUser.get("SELECT inventory FROM user WHERE user_id = ?", [userId], (err, row) => {
							if (err) {
								console.error(err.message);
								return;
							}
							if (!row) {
								message.channel.send('You have not caught a pokemon yet.');
								return;
							}
							let inventoryArr = JSON.parse(row.inventory).flat();
							if (inventoryArr.length < 1) {
								message.channel.send('You have no items!');
								return;
							}
							if (itemNum > inventoryArr.length || itemNum < 1) {
								message.channel.send('Improper command usage. Usage: `.use <itemNum>`');
								return;
							}

							const selectedItem = inventoryArr[itemNum - 1];
							//get currently used items
							const userRepels = activeUserRepels.get(userId);
							let standardRepel = null; 
							let rareRepel = null; 
							if (userRepels) {
								if (userRepels.standard) {
									standardRepel = userRepels.standard;
								}
								if (userRepels.rare) {
									rareRepel = userRepels.rare;
								}
							}

							if (selectedItem === 'Normal Repel') {
								if (standardRepel) {
									message.channel.send('You must use your currently equipped standard repel before activating a new one.');
									return;
								}
								activeUserRepels.set(userId, { standard: 'Normal Repel', rare: rareRepel });
								inventoryArr.splice(itemNum - 1, 1);
							}
							else if (selectedItem === 'Super Repel') {
								if (standardRepel) {
									message.channel.send('You must use your currently equipped standard repel before activating a new one.');
									return;
								}
								activeUserRepels.set(userId, { standard: 'Super Repel', rare: rareRepel });
								inventoryArr.splice(itemNum - 1, 1);
							}
							else if (selectedItem === 'Max Repel') {
								if (standardRepel) {
									message.channel.send('You must use your currently equipped standard repel before activating a new one.');
									return;
								}
								activeUserRepels.set(userId, { standard: 'Max Repel', rare: rareRepel });
								inventoryArr.splice(itemNum - 1, 1);
							}
							else if (selectedItem === 'Legendary Repel') {
								if (rareRepel) {
									message.channel.send('You must use your currently equipped rare repel before activating a new one.');
									return;
								}
								activeUserRepels.set(userId, { standard: standardRepel, rare: 'Legendary Repel'});
								inventoryArr.splice(itemNum - 1, 1);
							}
							else if (selectedItem === 'Mythical Repel') {
								if (rareRepel) {
									message.channel.send('You must use your currently equipped rare repel before activating a new one.');
									return;
								}
								activeUserRepels.set(userId, { standard: standardRepel, rare: 'Mythical Repel'});
								inventoryArr.splice(itemNum - 1, 1);
							}
							else if (selectedItem === 'Shiny Repel') {
								if (rareRepel) {
									message.channel.send('You must use your currently equipped rare repel before activating a new one.');
									return;
								}
								activeUserRepels.set(userId, { standard: standardRepel, rare: 'Shiny Repel'});
								inventoryArr.splice(itemNum - 1, 1);
							}
							else {
								message.channel.send('Could not use selected item.');
								return;
							}

							dbUser.run("UPDATE user SET inventory = ? WHERE user_id = ?", [JSON.stringify(inventoryArr), userId], (err) => {
								if (err) {
									console.error('Error updating user inventory:', err.message);
									return;
								}
								message.channel.send(`${selectedItem} Activated.`);
							});
						});
					}
					else {
						message.channel.send('Improper command usage. Usage: `.use <itemNum> <partyNum>`');
					}
				});
			}

			//help
			else if (helpCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const helpPages = [
					 new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Help (Page 1)')
						.setDescription('List of available commands:')
						.addFields(
							{ name: '.drop (.d)', value: 'Drops a random Pokémon in the channel. Cooldown: 5 minutes.' },
							{ name: '.party (.p)', value: 'Displays your caught Pokémon.' + '\n' + 'Usages: .p name: <pokémon> *|* .p shiny *|* .p legendary *|* .p mythical *|* .p swap 1 10' },
							{ name: '.order <order> <ignoreNum> (.o)', value: 'Sorts your Pokémon in an order. If an ignoreNum is added, it will not rearrange the Pokémon from indices 1 -> ignoreNum.' + '\n' + 'Orders: `flexdex`, `dex`, `countLow`, `countHigh`, and `alphabetical`.' },
							{ name: '.view <partyNum> (.v)', value: 'Displays a pokémon from your party.' + '\n' + 'Example: .view 1' },
							{ name: '.dex <pokémon>', value: 'Displays a pokémon from the pokedex.' + '\n' + 'Usages: .dex 1 | .dex bulbasaur' }
						)
						.setTimestamp(),
					new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Help (Page 2)')
						.setDescription('List of available commands:')
						.addFields(
							{ name: '.currency (.c)', value: 'Displays your current amount of coins.' },
							{ name: '.inventory (.i)', value: 'Displays the items in your inventory.' },
							{ name: '.shop (.s)', value: 'Displays the global shop.' },
							{ name: '.buy <shopNum> <quantity> (.b)', value: 'Buys an item from the shop. If a quantity is supplied, buys that many.' + '\n' + 'Example: .buy 1 5' },
							{ name: '.hint (.h)', value: 'Gives a hint for the currently dropped Pokémon.' }
						)
						.setTimestamp(),
					new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Help (Page 3)')
						.setDescription('List of available commands:')
						.addFields(
							{ name: '.uncaught (.u)', value: 'Displays a list of your uncaught pokémon' },
							{ name: '.release <partyNum> (.r)', value: 'Releases a Pokémon from your party.' + '\n' + 'Example: .release 1' },
							{ name: '.trade @<user> (.t)', value: 'Initiates a trade with another user.' },
							{ name: '.count', value: 'Displays the amount of each pokémon you\'ve caught.'},
							{ name: '.leaderboard (.lb)', value: 'Display a leaderboard.' + '\n' + 'Usages: .lb currency *|* .lb shiny *|* .lb legendary *|* .lb mythical *|* .lb pokedex *|* .lb {pokémon}' }
						)
						.setTimestamp(),
					new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Help (Page 4)')
						.setDescription('List of available commands:')
						.addFields(
							{ name: '.use <itemNum> <partyNum>', value: 'Uses an item. If a partyNum is supplied, uses the item on a Pokémon.' },
							{ name: '.compare @<user>:', value: 'Posts a list of all the Pokémon you don\'t own that @<user> does.' },
							{ name: '.team @<user> <view> <1-6>:', value: 'Posts the @<user>\'s first 6 Pokémon.' + '\n' +'If <view> and <1-6> is supplied, looks at that current Pokémon.' },
							{ name: '.setChannel: #<channel>', value: '`ADMIN ONLY:` Directs the bot to only allow commands inside the #<channel>.' + '\n' + 'Example: .setChannel <text1> <text2>' },
							{ name: '.resetChannels:', value: '`ADMIN ONLY:` Resets the bot to default, can use commands in any channel' },
							{ name: '.viewChannels:', value: '`ADMIN ONLY:` Posts a list of channels the server allows bot commands in' }
						)
						.setTimestamp()
					]

					let page = 0;
					const totalPages = helpPages.length;

					const buttonRow = new ActionRowBuilder()
						.addComponents(
							new ButtonBuilder()
								.setCustomId('prevPage')
								.setLabel('◀')
								.setStyle(ButtonStyle.Primary),
							new ButtonBuilder()
								.setCustomId('nextPage')
								.setLabel('▶')
								.setStyle(ButtonStyle.Primary)
						);

					message.channel.send({ embeds: [helpPages[page]], components: [buttonRow] }).then(sentMessage => {
						const filter = i => i.user.id === message.author.id;
						const collector = sentMessage.createMessageComponentCollector({filter, time: 60000});

						collector.on('collect', async i => {
							try {
								if (i.customId === 'prevPage') {
									page = page - 1;
									if (page < 0) {
										page = totalPages - 1;
									}
								}
								else if (i.customId === 'nextPage') {
									page = page + 1;
									if (page > totalPages - 1) {
										page = 0;
									}
								}
								await i.update({ embeds: [helpPages[page]], compoents: [buttonRow]});
							} catch (error) {
								if (error.code === 10008) {
									console.log('The message was deleted before the interaction was handled.');
								} else {
									console.error('An unexpected error occurred:', error);
								}
							}
						});

						collector.on('end', async () => {
							try {
								const disabledRow = new ActionRowBuilder()
									.addComponents(
										new ButtonBuilder()
											.setCustomId('prevPage')
											.setLabel('◀')
											.setStyle(ButtonStyle.Primary)
											.setDisabled(true),
										new ButtonBuilder()
											.setCustomId('nextPage')
											.setLabel('▶')
											.setStyle(ButtonStyle.Primary)
											.setDisabled(true)
									);
								await sentMessage.edit({ components: [disabledRow] });
							} catch (error) {
								if (error.code === 10008) {
									console.log('Failed Gracefully.');
								} else {
									console.error('An unexpected error occurred while editing:', error);
								}
							}
						});
					}).catch(err => {
						console.error('Error sending the help message:', err);
					});
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
						curMon = activeDrops.get(`${serverId}_${message.channel.id}`).name;
						monLength = curMon.length;
						let numLetters = 0;
						let curMonHint = activeDrops.get(`${serverId}_${message.channel.id}`).name;
						while (numLetters / monLength < 0.5) {
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

			//count
			else if (countCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
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

						const caughtPokemon = JSON.parse(row.caught_pokemon).flat();
						const cleanedNames = caughtPokemon
							.map(pokemon => {
								let pokemonName = pokemon.name.startsWith('✨') ? pokemon.name.slice(1) : pokemon.name

								if (pokemonName.toLowerCase() === 'nidoran') {
									if (pokemon.gender === 'Male') {
										pokemonName += '♂\u200B';
									}
									else if (pokemon.gender === 'Female') {
										pokemonName += '♀\u200B';
									}
								}
								return pokemonName;
							});

						const nameCount = cleanedNames.reduce((acc, name) => {
							acc[name] = (acc[name] || 0) + 1;
							return acc;
						}, {});

						const sortedNameCounts = Object.entries(nameCount)
  							.map(([name, value]) => ({ name, value }))
  							.sort((a, b) => b.value - a.value);

						sendLeaderboard(message, sortedNameCounts, 'Your pokemon counts');
					});
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

						let isShiny = false;
						let finalName = '';
						if (caughtPokemon[index].name.startsWith('✨')) {
							isShiny = true;
							finalName = caughtPokemon[index].name.substring(1);
						}
						else {
							finalName = caughtPokemon[index].name;
						}
						let form = '';
						if (caughtPokemon[index].form.toLowerCase() !== 'default') {
							form = caughtPokemon[index].form + ' ';
						}
						if (isShiny) {
							finalName = '✨'+ form + finalName;
						}
						else {
							finalName = form + finalName;
						}

						const embed = new EmbedBuilder()
							.setColor('#ff0000')
							.setTitle('Release Pokémon')
							.setDescription(`Really release #${index + 1}, ${finalName}?`)
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
								try {
									if (i.customId === 'release_yes') {
										caughtPokemon.splice(index, 1);
										dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(caughtPokemon), userId], (err) => {
										if (err) {
											console.error(err.message);
										}
										i.update({ content: `Successfully released ${finalName}`, embeds: [], components: [] });
										});
									} 
									else if (i.customId === 'release_no') {
										i.update({ content: 'Release cancelled.', embeds: [], components: [] });
									}
								} catch (error) {
									if (error.code === 10008) {
										console.log('Failed Gracefully.');
									} else {
										console.error('An unexpected error occurred while editing:', error);
									}
								}
							});

							collector.on('end', async () => {
								try {
									await sentMessage.edit({components: [] });
								} catch (error) {
									if (error.code === 10008) {
										console.log('Failed Gracefully.');
									} else {
										console.error('An unexpected error occurred while editing:', error);
									}
								}
							});
						}).catch(err => {
							console.error('Error sending the release message:', err);
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
									const user1Pokemon = JSON.parse(user1Row.caught_pokemon).flat();
									const user1TradedPokemon = user1Pokemon.splice(trade.user1Pokemon, 1)[0];
				
									dbUser.get("SELECT * FROM user WHERE user_id = ?", [trade.user2], (err, user2Row) => {
										if (err) {
											console.error(err.message);
											message.channel.send('An error occurred while fetching user data.');
											return;
										}
										const user2Pokemon = JSON.parse(user2Row.caught_pokemon).flat();
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

												const u1TName = user1TradedPokemon.name;
												let isShiny = false;
												let finalDisplayName1 = '';
												if (u1TName.startsWith('✨')) {
													finalDisplayName1 = `${u1TName.substring(1)}`;
													isShiny = true;
												}
												else {
													finalDisplayName1 = u1TName;
												}
												if (user1TradedPokemon.form.toLowerCase() !== 'default') {
													finalDisplayName1 = `${user1TradedPokemon.form} ${finalDisplayName1}`;
													if (isShiny) {
														finalDisplayName1 = `✨${finalDisplayName1}`;
													}
												}
												else if(isShiny) {
													finalDisplayName1 = `✨${finalDisplayName1}`;
												}

												const maleSymbol = '`♂`';
												const femaleSymbol = '`♀`';

												if (user1TradedPokemon.gender === 'Male') {
													finalDisplayName1 += ` ${maleSymbol}`;
												}
												else if (user1TradedPokemon.gender === 'Female') {
													finalDisplayName1 += ` ${femaleSymbol}`;
												}

												const u2TName = user2TradedPokemon.name;
												isShiny = false;
												let finalDisplayName2 = '';
												if (u2TName.startsWith('✨')) {
													finalDisplayName2 = `${u2TName.substring(1)}`;
													isShiny = true;
												}
												else {
													finalDisplayName2 = u2TName;
												}
												if (user2TradedPokemon.form.toLowerCase() !== 'default') {
													finalDisplayName2 = `${user2TradedPokemon.form} ${finalDisplayName2}`;
													if (isShiny) {
														finalDisplayName2 = `✨${finalDisplayName2}`;
													}
												}
												else if(isShiny) {
													finalDisplayName2 = `✨${finalDisplayName2}`;
												}

												if (user2TradedPokemon.gender === 'Male') {
													finalDisplayName2 += ` ${maleSymbol}`;
												}
												else if (user2TradedPokemon.gender === 'Female') {
													finalDisplayName2 += ` ${femaleSymbol}`;
												}

												message.channel.send(`Trade completed! <@!${user1Row.user_id}> traded ${finalDisplayName1} with <@!${user2Row.user_id}> for ${finalDisplayName2}.`);
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

						const trade = activeTrades.get(serverId);
						if (trade.user1Confirmed || trade.user2Confirmed) {
							message.channel.send("A user has already confirmed the trade, cannot edit now. Do .trade cancel to start a new trade.");
                			return;
						}
						
						if (isNaN(args[2]) || parseInt(args[2], 10) <= 0) {
							message.channel.send("You must provide a valid party number.");
							return;
						}
						
						const partyNum = parseInt(args[2], 10) - 1;
						if (isNaN(partyNum)) {
							message.channel.send("Syntax error: you must provide a valid party number.");
							return;
						}
						
						dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching your Pokémon data.');
								return;
							}
							const userPokemon = JSON.parse(row.caught_pokemon).flat();
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
							
							const pokeName = userPokemon[partyNum].name;
							let isShiny = false;
							let finalDisplayName = '';
							if (pokeName.startsWith('✨')) {
								finalDisplayName = `${pokeName.substring(1)}`;
								isShiny = true;
							}
							else {
								finalDisplayName = pokeName;
							}
							if (userPokemon[partyNum].form.toLowerCase() !== 'default') {
								finalDisplayName = `${userPokemon[partyNum].form} ${finalDisplayName}`;
								if (isShiny) {
									finalDisplayName = `✨${finalDisplayName}`;
								}
							}
							else if(isShiny) {
								finalDisplayName = `✨${finalDisplayName}`;
							}

							const maleSymbol = '`♂`';
							const femaleSymbol = '`♀`';

							if (userPokemon[partyNum].gender === 'Male') {
								finalDisplayName += ` ${maleSymbol}`;
							}
							else if (userPokemon[partyNum].gender === 'Female') {
								finalDisplayName += ` ${femaleSymbol}`;
							}

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
									const user1PokemonName = JSON.parse(user1Row.caught_pokemon).flat()[trade.user1Pokemon].name;
									let isShiny = false;
									let finalDisplayName1 = '';
									if (user1PokemonName.startsWith('✨')) {
										finalDisplayName1 = `${user1PokemonName.substring(1)}`;
										isShiny = true;
									}
									else {
										finalDisplayName1 = user1PokemonName;
									}
									if (JSON.parse(user1Row.caught_pokemon).flat()[trade.user1Pokemon].form.toLowerCase() !== 'default') {
										finalDisplayName1 = `${JSON.parse(user1Row.caught_pokemon).flat()[trade.user1Pokemon].form} ${finalDisplayName1}`;
										if (isShiny) {
											finalDisplayName1 = `✨${finalDisplayName1}`;
										}
									}
									else if(isShiny) {
										finalDisplayName1 = `✨${finalDisplayName1}`;
									}

									const maleSymbol = '`♂`';
									const femaleSymbol = '`♀`';

									if (JSON.parse(user1Row.caught_pokemon).flat()[trade.user1Pokemon].gender === 'Male') {
										finalDisplayName1 += ` ${maleSymbol}`;
									}
									else if (JSON.parse(user1Row.caught_pokemon).flat()[trade.user1Pokemon].gender === 'Female') {
										finalDisplayName1 += ` ${femaleSymbol}`;
									}

									dbUser.get("SELECT * FROM user WHERE user_id = ?", [trade.user2], (err, user2Row) => {
										if (err) {
											console.error(err.message);
											message.channel.send('An error occurred while fetching user2 data.');
											return;
										}

										const user2PokemonName = JSON.parse(user2Row.caught_pokemon).flat()[trade.user2Pokemon].name;
										let isShiny = false;
										let finalDisplayName2 = '';
										if (user2PokemonName.startsWith('✨')) {
											finalDisplayName2 = `${user2PokemonName.substring(1)}`;
											isShiny = true;
										}
										else {
											finalDisplayName2 = user2PokemonName;
										}
										if (JSON.parse(user2Row.caught_pokemon).flat()[trade.user2Pokemon].form.toLowerCase() !== 'default') {
											finalDisplayName2 = `${JSON.parse(user2Row.caught_pokemon).flat()[trade.user2Pokemon].form} ${finalDisplayName2}`;
											if (isShiny) {
												finalDisplayName2 = `✨${finalDisplayName2}`;
											}
										}
										else if(isShiny) {
											finalDisplayName2 = `✨${finalDisplayName2}`;
										}

										const maleSymbol = '`♂`';
										const femaleSymbol = '`♀`';

										if (JSON.parse(user2Row.caught_pokemon).flat()[trade.user2Pokemon].gender === 'Male') {
											finalDisplayName2 += ` ${maleSymbol}`;
										}
										else if (JSON.parse(user2Row.caught_pokemon).flat()[trade.user2Pokemon].gender === 'Female') {
											finalDisplayName2 += ` ${femaleSymbol}`;
										}
										
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
											`Trade set: **${finalDisplayName1}** (added by ${userDisplayName1}) and **${finalDisplayName2}** (added by ${userDisplayName2}). Type \`.trade confirm\` to confirm the trade.`
										);
									});
								});
							}
							else {
								message.channel.send(`${authorUserName} added **${finalDisplayName}** to the trade. Waiting for the other user to add their Pokémon.`);
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
						let isInTrade = false;
						for (const [serverId, trade] of activeTrades.entries()) {
							if (trade && (userId === trade.user1 || userId === trade.user2)) {
								isInTrade = true;
								break;
							}
						}
						if (isInTrade) {
							message.channel.send('Cannot trade while in an active trade!');
							return;
						}
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
								try {
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
								} catch (error) {
									if (error.code === 10008) {
										console.log('Failed Gracefully.');
									} else {
										console.error('An unexpected error occurred while editing:', error);
									}
								}
							});
							collector.on('end', async (collected) => {
								try {
									if (collected.size === 0) {
										await sentMessage.edit({ content: `Trade request timed out.`, embeds: [], components: [] });
									}
								} catch (error) {
									if (error.code === 10008) {
										console.log('Failed Gracefully.');
									} else {
										console.error('An unexpected error occurred while editing:', error);
									}
								}
							});
						}).catch(err => {
							console.error('Error sending the trade message:', err);
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