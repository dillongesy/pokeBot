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

const cooldowns = new Map(); 	//Map<serverId, cooldownEnd>
const activeDrops = new Map();	//Map<serverId_channelId, activePokemon {name, isShiny, form}>
const activeTrades = new Map();	//Map<serverId, {user1, user2, user1Pokemon, user2Pokemon, user1Confirmed, user2Confirmed}>

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
					const formPrefix = p.form.split(' ')[0];
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
function updateEmbed(shinyImg, dexNumber, pokemonRow, selectedForm, pokeList) {
	//const type2 = pokemonRow.type2 ? ` / ${pokemonRow.type2}` : '';
	const shinyImageLinks = JSON.parse(pokemonRow.shinyImageLinks);
	const imgLinks = JSON.parse(pokemonRow.imageLinks);

	const imageLink = shinyImg ? shinyImageLinks[selectedForm] || shinyImageLinks.default : imgLinks[selectedForm] || imgLinks.default;

	const formTypes = getFormTypes(pokemonRow.name, selectedForm, pokeList);
	let type1Field = '';
	let type2Field = '';
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
							
	return new EmbedBuilder()
		.setColor('#0099ff')
		.setTitle(`${pokemonRow.name} - #${dexNumber} ${selectedForm}`)
		.addFields(
			{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
			{ name: 'Region', value: `${pokemonRow.region}`, inline: true }
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
	});

	collector.on('end', collected => {
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
		sentMessage.edit({ components: [disabledRow] });
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
	else if (pokemonIdentifier === 'Sunny' && args.length > 2) {
		if (args[2].toLowerCase() === 'castform') {
			pokemonIdentifier = 'Sunny Castform';
		}
	}
	else if (pokemonIdentifier === 'Rainy' && args.length > 2) {
		if (args[2].toLowerCase() === 'castform') {
			pokemonIdentifier = 'Rainy Castform';
		}
	}
	else if (pokemonIdentifier === 'Snowy' && args.length > 2) {
		if (args[2].toLowerCase() === 'castform') {
			pokemonIdentifier = 'Snowy Castform';
		}
	}
	else if (pokemonIdentifier === 'Sandy' && args.length > 2) {
		if (args[2].toLowerCase() === 'wormadam') {
			pokemonIdentifier = 'Sandy Wormadam';
		}
	}
	else if (pokemonIdentifier === 'Trash' && args.length > 2) {
		if (args[2].toLowerCase() === 'wormadam') {
			pokemonIdentifier = 'Trash Wormadam';
		}
	}
	else if (pokemonIdentifier === 'Plant' && args.length > 2) {
		if (args[2].toLowerCase() === 'wormadam') {
			pokemonIdentifier = 'Wormadam';
		}
	}
	else if (pokemonIdentifier === 'Heat' && args.length > 2) {
		if (args[2].toLowerCase() === 'rotom') {
			pokemonIdentifier = 'Heat Rotom';
		}
	}
	else if (pokemonIdentifier === 'Wash' && args.length > 2) {
		if (args[2].toLowerCase() === 'rotom') {
			pokemonIdentifier = 'Wash Rotom';
		}
	}
	else if (pokemonIdentifier === 'Frost' && args.length > 2) {
		if (args[2].toLowerCase() === 'rotom') {
			pokemonIdentifier = 'Frost Rotom';
		}
	}
	else if (pokemonIdentifier === 'Sky' && args.length > 2) {
		if (args[2].toLowerCase() === 'shaymin') {
			pokemonIdentifier = 'Sky Shaymin';
		}
	}
	else if (pokemonIdentifier === 'Zen' && args.length > 2) {
		if (args[2].toLowerCase() === 'darmanitan') {
			pokemonIdentifier = 'Zen Darmanitan';
		}
	}
	else if (pokemonIdentifier === 'Therian' && args.length > 2) {
		if (args[2].toLowerCase() === 'tornadus') {
			pokemonIdentifier = 'Therian Tornadus';
		}
	}
	else if (pokemonIdentifier === 'Therian' && args.length > 2) {
		if (args[2].toLowerCase() === 'thunderus') {
			pokemonIdentifier = 'Therian Thunderus';
		}
	}
	else if (pokemonIdentifier === 'Therian' && args.length > 2) {
		if (args[2].toLowerCase() === 'landorus') {
			pokemonIdentifier = 'Therian Landorus';
		}
	}
	else if (pokemonIdentifier === 'White' && args.length > 2) {
		if (args[2].toLowerCase() === 'kyurem') {
			pokemonIdentifier = 'White Kyurem';
		}
	}
	else if (pokemonIdentifier === 'Black' && args.length > 2) {
		if (args[2].toLowerCase() === 'kyurem') {
			pokemonIdentifier = 'Black Kyurem';
		}
	}
	else if (pokemonIdentifier === 'Pirouette' && args.length > 2) {
		if (args[2].toLowerCase() === 'meloetta') {
			pokemonIdentifier = 'Pirouette Meloetta';
		}
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
const currencyCommandRegex = /^\.(currency|c)\b/;
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
const forceShinySpawnRegex = /^\.(shinydrop)\b/;
const giveCCmdRegex = /^\.(give)\b/; //For people who find bugs
const changeLogRegex = /^\.(changelog|log)\b/;
const orderCommandRegex = /^\.(order|sort)\b/;

const maxDexNum = 649; //number x is max pokedex entry - EDIT WHEN ADDING MORE POKEMON

client.on('ready', () => {
	console.log(`Logged in as ${client.user.tag}`);
	dbUser.run("CREATE TABLE IF NOT EXISTS user (user_id TEXT PRIMARY KEY, caught_pokemon TEXT, currency INTEGER DEFAULT 0, inventory TEXT DEFAULT '[]')");
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
							if (mythicalNumber < 0.005) {
								isMythical = true;
							}
							else if (legendaryNumber < 0.0075) {
								isLegendary = true;
							}
							
							let randPokemon = getRandomInt(maxDexNum); 
							let pokemon = null;
							let embedColor = '#0099FF';

							if (isMythical) {
								const rowsM = rows.filter(row => row.isLM === 2);
								if (rowsM.length > 0) {
									pokemon = rowsM[getRandomInt(rowsM.length)];
									embedColor = '#FF96C5';
								}
								else {
									console.log("Error, no mythical pokemon!");
								}
							}
							else if (isLegendary) {
								const rowsL = rows.filter(row => row.isLM === 1);
								if (rowsL.length > 0) {
									pokemon = rowsL[getRandomInt(rowsL.length)];
									embedColor = '#66FF00';
								}
								else {
									console.log("Error, no mythical pokemon!");
								}
							}
							else {
								const rowsN = rows.filter(row => row.isLM !== 3);
								pokemon = rowsN[randPokemon]; //this is fine
								embedColor = '#0099FF';
								while (pokemon.isLM !== 0) {
									randPokemon = getRandomInt(maxDexNum);
									pokemon = rowsN[randPokemon];
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

							if (selectForm.name.includes('(F)') || selectForm.name.includes('(M)')) {
								selectForm = {
									name: selectForm.name.substring(0, selectForm.name.length - 4),
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
							
							const type2 = pokemon.type2 ? ` / ${pokemon.type2}` : '';
							const curMon = pokemon.name ? `${pokemon.name}` : '';
							console.log('Current pokemon: ' + curMon + '\n' + 'ShinyNum:     ' + shinyNumber + ' (<0.00025)' + '\n' + 'MythicalNum:  ' + mythicalNumber + ' (<0.005)' + '\n' + 'LegendaryNum: ' + legendaryNumber + ' (<0.0075)' +'\n');
							
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
			}

			//flatten everyone's caught_pokemon
			else if(message.content.toLowerCase() === '.flatten' && userId === '177580797165961216') {
				dbUser.all("SELECT user_id, caught_pokemon FROM user", [], (err, rows) => {
					if (err) {
						console.error(err.message);
						message.channel.send('An error occurred while fetching the user\'s Pokémon.');
						return;
					}
					rows.forEach((row) => {
						if (!row.caught_pokemon) {
							console.log(`User ${row.user_id} has no Pokémon to order.`);
							return;
						}
						let list = JSON.parse(row.caught_pokemon).flat();
						dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(list), row.user_id], (err) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while updating your Pokémon.');
								return;
							}
							else {
								console.log(`Pokemon successfully made into objects for user ${row.user_id}.`);
							}
						});
					});
				});
			}

			//Make pokemon objects
			else if(message.content.toLowerCase() === '.makepobj' && userId === '177580797165961216') {
				dbUser.all("SELECT user_id, caught_pokemon FROM user", [], (err, rows) => {
					if (err) {
						console.error(err.message);
						message.channel.send('An error occurred while fetching the user\'s Pokémon.');
						return;
					}

					db.all("SELECT * FROM pokemon", [], (error, allPokemonList) => { //test 0, userPokemonList.length, 1, userPokemonList.length + 1
						if (error) {
							console.error(error.message);
							message.channel.send('An error occurred while fetching the Pokémon database.');
							return;
						}
						//check if string starts with ✨, if it does: make a variable "checkName" that deletes it (we still want the name to start with ✨ in the name!!!)
						//compare "checkName" names to allPokemonList
						//use Math.random() * 100 to roll pokemon traits for gender and form
						//each edited entry should look something like this in the db:
						// [{"name":"Bulbasaur","gender":"Male","form":"Default"}]
						rows.forEach((row) => {
							if (!row.caught_pokemon) {
								console.log(`User ${row.user_id} has no Pokémon to order.`);
								return;
							}
							let userPokemonList = JSON.parse(row.caught_pokemon);
							let pokemonObjects = [];

							for(let i = 0; i < userPokemonList.length; i++) {
								const pkmnName = userPokemonList[i];
								let checkName = ''
								let isShiny = pkmnName.startsWith("✨");
								if (isShiny) {
									checkName = pkmnName.substring(1);
								}
								else {
									checkName = pkmnName;
								}
								const pkmnRow = allPokemonList.find(pokemon => pokemon.name.toLowerCase() === checkName.toLowerCase());
								if (!pkmnRow) {
									console.error(`Pokémon ${checkName} not found in the database.`);
									continue;
								}
	
								const genders = JSON.parse(pkmnRow.gender);
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
	
								const forms = JSON.parse(pkmnRow.forms);
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
	
								const newObj = {
									name: pkmnName,
									gender: selectGender.name,
									form: selectForm.name
								};
								pokemonObjects.push(newObj);
							}

							dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify([pokemonObjects]), row.user_id], (err) => {
								if (err) {
									console.error(err.message);
									message.channel.send('An error occurred while updating your Pokémon.');
									return;
								}
								else {
									console.log(`Pokemon successfully made into objects for user ${row.user_id}.`);
								}
							});
						});
						message.channel.send("Pokemon objects have been processed for all users.");
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
							console.log('Name: ' + pokemon.name + '\nShinyNum: ' + shinyNumber + ' (<0.00025)');

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

							if (selectForm.name.includes('(F)') || selectForm.name.includes('(M)')) {
								selectForm = {
									name: selectForm.name.substring(0, selectForm.name.length - 4),
									percentage: selectForm.percentage
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
							
							const type2 = pokemon.type2 ? ` / ${pokemon.type2}` : '';
							const curMon = pokemon.name ? `${pokemon.name}` : '';
							
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
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'porygon-z' && message.content.toLowerCase() === 'porygonz'))) { //edge case
				
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
							? `Added ✨${formName}${curMonName} ${genderSymbol}to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`
							: `Added ${formName}${curMonName} ${genderSymbol}to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`;
						
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
									activeDrops.delete(`${serverId}_${message.channel.id}`);
								});
							} 
							else {
								// User is in the database, update their caught Pokémon & currency
								const caughtPokemon = JSON.parse(row.caught_pokemon);
								let newList = caughtPokemon.concat(shinyMon);
								const newCurrency = row.currency + coinsToAdd;
								dbUser.run("UPDATE user SET caught_pokemon = ?, currency = ? WHERE user_id = ?", [JSON.stringify(newList), newCurrency, userId], (err) => {
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
							{ name: 'Order/Sort', value: 'Added reorganization of your party. Use .help for more information!' },
							{ name: 'Detailed Pokemon', value: 'Added details to pokemon, such as gender, forms, and more!' },
						)
						.setTimestamp();

					message.channel.send({ embeds: [helpEmbed] });
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
							filteredUsers.sort((a, b) => b.value - a.value);
							sendLeaderboard(message, filteredUsers, 'Total Pokémon Caught Leaderboard');
						});
					}
					else if (args[0].toLowerCase() === 'c' || args[0].toLowerCase() === 'currency') {
						//display currency leaderboard
						dbUser.all("SELECT user_id, currency FROM user ORDER BY currency DESC", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the currency leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								const user = await client.users.fetch(row.user_id).catch(() => null);
								const value = row.currency || 0;

								return value > 0 ? {
									name: user ? `${user.username}` : `User ID: ${row.user_id}`,
									value
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							filteredUsers.sort((a, b) => b.value - a.value);
							sendLeaderboard(message, filteredUsers, 'Currency Leaderboard');
						});
					}

					else if (args[0].toLowerCase() === 's' || args[0].toLowerCase() === 'shiny') {
						//display shiny leaderboard
						dbUser.all("SELECT user_id, caught_pokemon FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the shiny leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon) {
									return null;
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
							filteredUsers.sort((a, b) => b.value - a.value);
							sendLeaderboard(message, filteredUsers, 'Shiny Pokémon Leaderboard');
						});
					}

					else if (args[0].toLowerCase() === 'l' || args[0].toLowerCase() === 'legendary') {
						//display legendary leaderboard
						//Use in-memory data to make this call a lot faster
						const legendaryPokemon = [
							'Articuno', 'Zapdos', 'Moltres', 'Mewtwo', 
							'Raikou', 'Entei', 'Suicune', 'Lugia', 'Ho-Oh',
							'Regirock', 'Regice', 'Registeel', 'Latias', 'Latios', 'Kyogre', 'Groudon', 'Rayquaza',
							'Uxie', 'Mesprit', 'Azelf', 'Dialga', 'Palkia', 'Heatran', 'Regigigas', 'Giratina', 'Cresselia',
							'Cobalion', 'Terrakion', 'Virizion', 'Tornadus', 'Thundurus', 'Reshiram', 'Zekrom', 'Landorus', 'Kyurem'
						];
						dbUser.all("SELECT user_id, caught_pokemon FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the legendary leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon) {
									return null;
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
							filteredUsers.sort((a, b) => b.value - a.value);
							sendLeaderboard(message, filteredUsers, 'Legendary Pokémon Leaderboard');
						});
					}

					else if (args[0].toLowerCase() === 'm' || args[0].toLowerCase() === 'mythical') {
						//display mythical leaderboard
						////Use in-memory data to make this call a lot faster
						const mythicalPokemon = [
							'Mew',
							'Celebi',
							'Jirachi', 'Deoxys',
							'Phione', 'Manaphy', 'Darkrai', 'Shaymin', 'Arceus',
							'Victini', 'Keldeo', 'Meloetta', 'Genesect'
						];
						dbUser.all("SELECT user_id, caught_pokemon FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the mythical leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon) {
									return null;
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
							filteredUsers.sort((a, b) => b.value - a.value);
							sendLeaderboard(message, filteredUsers, 'Mythical Pokémon Leaderboard');
						});
					}

					else if (args[0].toLowerCase() === 'pokedex' || args[0].toLowerCase() === 'dex') {
						//display pokedex completeness leaderboard
						dbUser.all("SELECT user_id, caught_pokemon FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the Pokédex completeness leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async row => {
								if (!row.caught_pokemon) {
									return null;
								}
								const user = await client.users.fetch(row.user_id).catch(() => null);
								const caughtPokemon = JSON.parse(row.caught_pokemon).flat().map(pokemon => pokemon.name) || [];
								
								const uniquePokemon = new Set(caughtPokemon.map(pokemonName => {
									if (typeof pokemonName !== 'string') {
										return '';
									}
									if (pokemonName.startsWith('✨')) {
										return `${pokemonName.substring(1)}`;
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
							filteredUsers.sort((a, b) => b.value - a.value);
							sendLeaderboard(message, filteredUsers, 'Pokédex Completeness Leaderboard (/649)');
						});
					}

					else if (args.length > 0) {
						//lb by pokemon name
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

						dbUser.all("SELECT user_id, caught_pokemon FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the leaderboard.');
								return;
							}

							const users = await Promise.all(rows.map(async (row) => {
								if (!row.caught_pokemon) {
									return null;
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
								sendLeaderboard(message, filteredUsers, `Leaderboard for ${pokemonIdentifier}`);
							}
							else {
								message.channel.send(`No users have caught that or they aren't registered in the pokedex.`);
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
					db.all("SELECT * FROM pokemon", [], (err, pokeList) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching Pokémon information.');
							return;
						}
						let index = 0;
						let curMon = '';
						const result = pokeList.find(({ name }) => name === pokemonIdentifier);
						if (!isNumber) {
							if (result != null) {
								index = result.dexNum;
								if (isNaN(index.substring(index.length - 1, index.length))) {
									index = index.substring(0, index.length - 1);
								}
								curMon = pokeList[index - 1];
							}
							else {
								message.channel.send('Pokémon not found in the pokedex.');
								return;
							}
						}
						else {
							index = pokemonIdentifier;
							curMon = pokeList[index - 1];
						}

						if (!curMon) {
							message.channel.send('Syntax error occurred, try again.');
							return;
						}
						let shinyImg = false;

						let selectedForm = 'default'; // Default form selection
						let forms = JSON.parse(curMon.forms);

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
								forms.map(form => ({
									label: form.name,
									value: form.name,
								}))
							);
						
						let embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList);
						
						let buttonRow = new ActionRowBuilder()
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

						message.channel.send({ 
							embeds: [embed], 
							components: [new ActionRowBuilder().addComponents(formSelectMenu), buttonRow],
						}).then(sentMessage => {
							const filter = i => i.user.id === userId;
							const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

							collector.on('collect', async i => {
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

									formSelectMenu = new Discord.StringSelectMenuBuilder()
										.setCustomId('formSelect')
										.setPlaceholder('Select a Form')
										.addOptions(
											forms.map(form => ({
												label: form.name,
												value: form.name,
											}))
										);

									embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList);
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

										formSelectMenu = new Discord.StringSelectMenuBuilder()
										.setCustomId('formSelect')
										.setPlaceholder('Select a Form')
										.addOptions(
											forms.map(form => ({
												label: form.name,
												value: form.name,
											}))
										);

									}

									embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList);
									i.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(formSelectMenu), buttonRow] });
								} 
								else if (i.customId === 'shinyBtn') {
									shinyImg = !shinyImg;
									embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList);
									i.update({ embeds: [embed] });
								}
								else if (i.customId === 'formSelect') {
									selectedForm = i.values[0];
									if (selectedForm.toLowerCase() === 'default') {
										selectedForm = '';
									}
									embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList);
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

						const caughtPokemon = JSON.parse(row.caught_pokemon).flat();

						if (index < 0 || index >= caughtPokemon.length) {
							message.channel.send('Please specify a valid party number.');
							return;
						}

						const pokemonToDisplay = caughtPokemon[index];
						const isShiny = pokemonToDisplay.name.startsWith('✨');
						const pokemonName = isShiny ? pokemonToDisplay.name.slice(1) : pokemonToDisplay.name;
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
							const defaultMon = pokemonRows.filter(pokemon => pokemon.isLM !== 3 && pokemon.name === pokemonName)[0];
							if (defaultMon.length < 1){ 
								message.channel.send('Pokémon not found in the database.');
								return;
							}

							const shinyImageLinks = JSON.parse(defaultMon.shinyImageLinks);
							const imgLinks = JSON.parse(defaultMon.imageLinks);
							//const imageLinks = JSON.parse(isShiny ? defaultMon.shinyImageLinks : defaultMon.imageLinks);
							const imageLink = isShiny ? shinyImageLinks[formName] || shinyImageLinks.default : imgLinks[formName] || imgLinks.default;

							const curForm = getFormTypes(pokemonName, formName, pokemonRows);
							let type1Field = '';
							let type2Field = '';
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

							const embed = new EmbedBuilder()
									.setColor('#0099ff')
									.setTitle(`Your ${isShiny ? '✨' : ''}${formName}${defaultMon.name}`)
									.addFields(
										{ name: 'Dex Number', value: `${defaultMon.dexNum}`, inline: true },
										{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
										{ name: 'Region', value: `${defaultMon.region}`, inline: true }
									)
									.setImage(imageLink)
									.setTimestamp();
									
									message.channel.send({embeds: [embed] });
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
								});

								collector.on('end', collected => {
									const disabledRow = getDisablePartyBtns();
									sentMessage.edit({ components: [disabledRow] });
								});
							});
						}
						
						else if (args[0].toLowerCase() === 'name:' || args[0].toLowerCase() === 'name' || args[0].toLowerCase() === 'n' || args[0].toLowerCase() === 'n:') {
							if (args.length > 1) {
								let searchName = args[1].toLowerCase();
								searchName = capitalizeFirstLetter(searchName);
								searchName = fixPokemonName(searchName, args);

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
										});
										collector.on('end', collected => {
											const disabledRow = getDisablePartyBtns();
											sentMessage.edit({ components: [disabledRow] });
										});
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
									});
									collector.on('end', collected => {
										const disabledRow = getDisablePartyBtns();
										sentMessage.edit({ components: [disabledRow] });
									});
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

									let isShiny = false;
									if (pokemonName.startsWith('✨')) {
										isShiny = true;
										pokemonName = pokemonName.substring(1);
									}

									if (legendaryPokemon.includes(pokemonName)) {
										return {
											name: isShiny ? `✨${pokemonName}` : pokemonName,
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
									});

									collector.on('end', collected => {
										const disabledRow = getDisablePartyBtns();
										sentMessage.edit({ components: [disabledRow] });
									});
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

									 let isShiny = false;
									 if (pokemonName.startsWith('✨')) {
										isShiny = true;
										pokemonName = pokemonName.substring(1);
									 }

									 if (mythicalPokemon.includes(pokemonName)) {
										return {
											name: isShiny ? `✨${pokemonName}` : pokemonName,
											id: index + 1
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
									});

									collector.on('end', collected => {
										const disabledRow = getDisablePartyBtns();
										sentMessage.edit({ components: [disabledRow] });
									});
								});
							}
						}
						else {
							message.channel.send("Invalid command usage. Use `.p` for party, `.p name: <pokemon>` to search, or `.p swap <partyNum1> <partyNum2>` to swap.");
						}
					});
				});
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
										if (ignoreNum < 1 || ignoreNum > userPokemonList.length) {
											message.channel.send('Error: provided ignore num is invalid');
											return;
										}
									}

									const ignoredList = userPokemonList.slice(0, ignoreNum);
									let sortableList = userPokemonList.slice(ignoreNum);

									const dexMap = new Map();
									allPokemonList.forEach(pokemon => {
										dexMap.set(pokemon.name, pokemon.dexNum);
									});

									sortableList.sort((a, b) => {
										const nameA = a.name.startsWith('✨') ? a.name.substring(1) : a.name;
										const nameB = b.name.startsWith('✨') ? b.name.substring(1) : b.name;

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
									if (ignoreNum < 1 || ignoreNum > userPokemonList.length) {
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
									if (ignoreNum < 1 || ignoreNum > userPokemonList.length) {
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
									if (ignoreNum < 1 || ignoreNum > userPokemonList.length) {
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
										if (ignoreNum < 1 || ignoreNum > userPokemonList.length) {
											message.channel.send('Error: provided ignore num is invalid');
											return;
										}
									}

									const ignoredList = userPokemonList.slice(0, ignoreNum);
									let sortableList = userPokemonList.slice(ignoreNum);

									const dexMap = new Map();
									allPokemonList.forEach(pokemon => {
										dexMap.set(pokemon.name, {dexNum: pokemon.dexNum, isLM: pokemon.isLM});
									});

									const countMap = new Map();
									sortableList.forEach(pokemon => {
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

									sortableList.sort((a, b) => {
										let nameA = a.name.startsWith('✨') ? a.name.substring(1) : a.name;
										let nameB = b.name.startsWith('✨') ? b.name.substring(1) : b.name;

										let dexA = dexMap.get(nameA) || { dexNum: 9999, isLM: 0 };
										let dexB = dexMap.get(nameB) || { dexNum: 9999, isLM: 0 };

										let countA = countMap.get(nameA);
										let countB = countMap.get(nameB);

										if (a.name.startsWith('✨') && !b.name.startsWith('✨')) {
											return -1;  // Shiny comes first
										}
										if (!a.name.startsWith('✨') && b.name.startsWith('✨')) {
											return 1;   // Shiny comes first
										}

										// Sort by Mythical -> Legendary -> Regular
										if (dexA.isLM !== dexB.isLM) {
											return dexB.isLM - dexA.isLM;
										}

										// For Mythical and Legendary, sort by count (low to high)
										if (dexA.isLM > 0 && countA.count !== countB.count) {
											return countA.count - countB.count;
										}

										// For regular Pokémon, sort by dex number
										if (dexA.isLM === 0 && dexB.isLM === 0) {
											return dexA.dexNum - dexB.dexNum;
										}

										return nameA.localeCompare(nameB); // Alphabetical as a last resort
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
							message.channel.send('Improper command usage. Orders: `flexdex`, `dex`, `countHigh`, `countLow` `alphabetical`');
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
					const shopEmbed = new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Shop')
						.setDescription('List of available items in the shop' + '\n' + 'Use the command .buy <shopNum> to purchase an item')
						.addFields(
							{ name: '` 1:` **Rare Candy (500)**', value: 'Levels a pokemon up (coming soon)' },
							{ name: '` 2:` **Fire Stone (5000)**', value: 'Fire stone (coming soon)' },
							{ name: '` 3:` **Water Stone (5000)**', value: 'Water evolution stone (coming soon)' },
							{ name: '` 4:` **Thunder Stone (5000)**', value: 'Electric evolution Stone (coming soon)' },
							{ name: '` 5:` **Leaf Stone (5000)**', value: 'Grass evolution Stone (coming soon)' },
							{ name: '` 6:` **Moon Stone (5000)**', value: 'Moon evolution Stone (coming soon)' },
							{ name: '` 7:` **Sun Stone (5000)**', value: 'Sun evolution Stone (coming soon)' },
							{ name: '` 8:` **Shiny Stone (5000)**', value: 'Shiny evolution Stone (coming soon)' },
							{ name: '` 9:` **Dusk Stone (5000)**', value: 'Dusk evolution Stone (coming soon)' },
							{ name: '`10:` **Dawn Stone (5000)**', value: 'Dawn evolution Stone (coming soon)' },
							{ name: '`11:` **Ice Stone (5000)**', value: 'Ice evolution Stone (coming soon)' },
							{ name: '`12:` **Shiny Drop (20000)**', value: 'Drops a shiny on command using .shinydrop' + '\n' + '__It is recommended to do this in a private place!__' }
						)
						.setTimestamp();

					message.channel.send({ embeds: [shopEmbed] });
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
					let isNum = !isNaN(shopNum);
					if (!isNum || shopNum < 1 || shopNum > 12) {
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
						else if (shopNum === '1' && userCurrency >= 500) {
							userCurrency -= 500;
							boughtItem = 'Rare Candy';
							amount = 500;
						}
						else if (shopNum === '2'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Fire Stone';
							amount = 5000;
						}
						else if (shopNum === '3'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Water Stone';
							amount = 5000;
						}
						else if (shopNum === '4'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Thunder Stone';
							amount = 5000;
						}
						else if (shopNum === '5'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Leaf Stone';
							amount = 5000;
						}
						else if (shopNum === '6'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Moon Stone';
							amount = 5000;
						}
						else if (shopNum === '7'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Sun Stone';
							amount = 5000;
						}
						else if (shopNum === '8'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Shiny Stone';
							amount = 5000;
						}
						else if (shopNum === '9'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Dusk Stone';
							amount = 5000;
						}
						else if (shopNum === '10'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Dawn Stone';
							amount = 5000;
						}
						else if (shopNum === '11'  && userCurrency >= 5000) {
							userCurrency -= 5000;
							boughtItem = 'Ice Stone';
							amount = 5000;
						}
						else if (shopNum === '12'  && userCurrency >= 20000) {
							userCurrency -= 20000;
							boughtItem = 'Shiny Drop';
							amount = 20000;
						}
						else {
							message.channel.send('You do not have enough currency to purchase requested item.');
						}
						if (boughtItem !== '') {
							const embed = new EmbedBuilder()
							.setColor('#ff0000')
							.setTitle('Buy Item')
							.setDescription(`Really buy ${boughtItem} for ${amount}? Leftover currency after transaction: ${userCurrency}`)
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
									if (i.customId === 'buy_yes') {
										const userInventory = JSON.parse(row.inventory);
										userInventory.push(boughtItem);
										dbUser.run("UPDATE user SET inventory = ?, currency = ? WHERE user_id = ?", [JSON.stringify(userInventory), userCurrency, userId], (err) => {
											if (err) {
												console.error(err.message);
											}
											i.update({ content: `Successfully purchased ${boughtItem} for ${amount}. You have ${userCurrency} leftover.`, embeds: [], components: [] });
										});
									} 
									else if (i.customId === 'buy_no') {
										i.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
									}
								});
	
								collector.on('end', collected => {
									sentMessage.edit({components: [] });
								});
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

								await i.update({ embeds: [generatePartyEmbed(userInventory, page, pageSize, `Your Pokémon`, 0)] });
							});

							collector.on('end', collected => {
								const disabledRow = getDisablePartyBtns();
								sentMessage.edit({ components: [disabledRow] });
							});
						});
					});
				});
			}

			//shinydrop
			else if (forceShinySpawnRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					//check if user has a shiny drop
					dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while checking your inventory.');
							return;
						}
						if (!row) {
							message.channel.send('You do not have any Shiny Drops in your inventory.');
							return;
						}
						const userInventory = JSON.parse(row.inventory);
						if (!userInventory.includes('Shiny Drop')) {
							message.channel.send('You do not have any Shiny Drops in your inventory.');
							return;
						}

						const confirmEmbed = new EmbedBuilder()
							.setColor('#ff0000')
							.setTitle('Use Shiny Drop?')
							.setDescription('Are you sure you want to use your Shiny Drop? Other users can also see and catch this Pokémon!')
							.setTimestamp();

						const buttonRow = new ActionRowBuilder()
							.addComponents(
								new ButtonBuilder()
									.setCustomId('use_yes')
									.setLabel('Yes')
									.setStyle(ButtonStyle.Success),
								new ButtonBuilder()
									.setCustomId('use_no')
									.setLabel('No')
									.setStyle(ButtonStyle.Danger)
							);

						message.channel.send({ embeds: [confirmEmbed], components: [buttonRow] }).then(sentMessage => {
							const filter = i => i.user.id === message.author.id;
							const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });
						
							collector.on('collect', async i => {
								if (i.customId === 'use_yes') {
									const index = userInventory.indexOf('Shiny Drop');
									if (index !== -1) {
										userInventory.splice(index, 1);
									}
									dbUser.run("UPDATE user SET inventory = ? WHERE user_id = ?", [JSON.stringify(userInventory), userId], (err) => {
										if (err) {
											console.error(err.message);
											message.channel.send('An error occurred while updating your inventory.');
											return;
										}
									});
									db.all("SELECT * FROM pokemon", [], (err, rowsMon) => {
										if (err) {
											console.error(err.message);
											message.channel.send('An error occurred while fetching Pokémon data.');
											return;
										}

										const mythicalNumber = Math.random();
										let isMythical = false;
										const legendaryNumber = Math.random();
										let isLegendary = false;
										if (mythicalNumber < 0.025) {
											isMythical = true;
										}
										else if (legendaryNumber < 0.05) {
											isLegendary = true;
										}

										let pokemon = null;
										if (isMythical) {
											const rowsM = rowsMon.filter(row => row.isLM === 2); //rows = pokemon db query
											if (rowsM.length > 0) {
												pokemon = rowsM[getRandomInt(rowsM.length)];
											}
											else {
												console.log("Error, no mythical pokemon!");
												message.channel.send("Error: No Mythical Pokémon found!");
												return;
											}
										}
										else if (isLegendary) {
											const rowsL = rowsMon.filter(row => row.isLM === 1); //rows = pokemon db query
											if (rowsL.length > 0) {
												pokemon = rowsL[getRandomInt(rowsL.length)];
											}
											else {
												console.log("Error, no legendary pokemon!");
												message.channel.send("Error: No legendary Pokémon found!");
												return;
											}
										}
										else {
											let randPokemon = getRandomInt(maxDexNum);
											const rowsN = rowsMon.filter(row => row.isLM !== 3);
											pokemon = rowsN[randPokemon];
											while (pokemon.isLM !== 0) {
												randPokemon = getRandomInt(maxDexNum);
												pokemon = rowsN[randPokemon];
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
												percentage: selectGender.percentage
											};
										}
										
										let imageLink = null;
										const shinyImageLinks = JSON.parse(pokemon.shinyImageLinks);
										imageLink = shinyImageLinks[selectForm.name.toLowerCase()] || shinyImageLinks.default;
			
										if (selectForm.name.includes('(F)') || selectForm.name.includes('(M)')) {
											selectForm = {
												name: selectForm.name.substring(0, selectForm.name.length - 4),
												percentage: selectForm.percentage
											};
										}

										const type2 = pokemon.type2 ? ` / ${pokemon.type2}` : '';
										const curMon = pokemon.name ? `${pokemon.name}` : '';
										console.log('Current pokemon: ' + curMon + '\n' + 'MythicalNum:  ' + mythicalNumber + ' (<0.025)' + '\n' + 'LegendaryNum: ' + legendaryNumber + ' (<0.05)' +'\n');
										const isShiny = true;

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
								else if (i.customId === 'use_no') {
									i.update({ content: 'Shiny drop cancelled.', embeds: [], components: [] });
								}
							});

							collector.on('end', collected => {
								sentMessage.edit({components: [] });
							});
						});
					});
				});
			}

			//help
			else if (helpCommandRegex.test(message.content.toLowerCase())) {
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
							{ name: '.party (.p)', value: 'Displays your caught Pokémon.' + '\n' + 'Usages: .p name: <pokémon> *|* .p shiny *|* .p legendary *|* .p mythical *|* .p swap 1 10' },
							{ name: '.order <order> <ignoreNum> (.sort)', value: 'Sorts your Pokémon in an order. If an ignoreNum is added, it will not rearrange the Pokémon from indices 1 -> ignoreNum.' + '\n' + 'Orders: `flexdex`, `dex`, `countLow`, `countHigh`, and `alphabetical`.' },
							{ name: '.view <partyNum> (.v)', value: 'Displays a pokémon from your party.' + '\n' + 'Example: .view 1' },
							{ name: '.dex <pokémon>', value: 'Displays a pokémon from the pokedex.' + '\n' + 'Usages: .dex 1 | .dex bulbasaur' },
							{ name: '.currency (.c)', value: 'Displays your current amount of coins.' },
							{ name: '.inventory (.i)', value: 'Displays the items in your inventory.' },
							{ name: '.shop (.s)', value: 'Displays the global shop.' },
							{ name: '.buy <shopNum> (.b)', value: 'Buys an item from the shop.' + '\n' + 'Example: .buy 1' },
							{ name: '.hint (.h)', value: 'Gives a hint for the currently dropped Pokémon.' },
							{ name: '.release <partyNum> (.r)', value: 'Releases a Pokémon from your party.' + '\n' + 'Example: .release 1' },
							{ name: '.trade @<user> (.t)', value: 'Initiates a trade with another user.' },
							{ name: '.count', value: 'Displays the amount of each pokémon you\'ve caught.'},
							{ name: '.leaderboard (.lb)', value: 'Display a leaderboard.' + '\n' + 'Usages: .lb currency *|* .lb shiny *|* .lb legendary *|* .lb mythical *|* .lb pokedex *|* .lb {pokémon}' },
							{ name: '.shinydrop', value: 'Drops a shiny pokémon, using a Shiny Drop item in the process.' },
							{ name: '.setChannel: #<channel>', value: '`ADMIN ONLY:` Directs the bot to only allow commands inside the #<channel>.' + '\n' + 'Example: .setChannel <text1> <text2>' },
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