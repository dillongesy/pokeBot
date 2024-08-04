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
const activeDrops = new Map();	//Map<serverId, activePokemon>
const activeTrades = new Map();	//Map<serverId, {user1, user2, user1Pokemon, user2Pokemon, user1Confirmed, user2Confirmed}>

//Embed Generator
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

//Helper function, replaces a char in a string
String.prototype.replaceAt = function(index, char) {
    var a = this.split("");
    a[index] = char;
    return a.join("");
}

//Helper function, generates a random int given an upper bound: 0 to upperBound - 1 inclusive
function getRandomInt(upperBound) {
	return Math.floor(Math.random() * upperBound);
}

client.on('ready', () => {
	console.log(`Logged in as ${client.user.tag}`);
	dbUser.run("CREATE TABLE IF NOT EXISTS user ( user_id TEXT PRIMARY KEY, caught_pokemon TEXT, currency INTEGER DEFAULT 0)");
});

client.on('messageCreate', (message) => {
	if (!message.author.bot) {
		if (message.content.length > 0) {
			const serverId = message.guild.id;
			const userId = message.author.id;
			const now = Date.now();
			
			//drop
			if (message.content.startsWith('.d') || message.content.startsWith('.drop')) {
				if (cooldowns.has(userId)) {
					const cooldownEnd = Math.floor(cooldowns.get(userId) / 1000);
					message.channel.send(`Please wait <t:${cooldownEnd}:R> before using this command again.`);
					return;
				}
				const cooldownEnd = now + 300000;
				cooldowns.set(userId, cooldownEnd);
                setTimeout(() => cooldowns.delete(userId), 300000);
				
				const randPokemon = getRandomInt(386); //number x is max pokedex entry - EDIT WHEN ADDING MORE POKEMON
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
			
			//catch
			else if ( activeDrops.has(serverId) && (
				   (message.content.toLowerCase() === activeDrops.get(serverId).toLowerCase())
				|| (activeDrops.get(serverId).toLowerCase() === 'farfetch\'d' && message.content.toLowerCase() === 'farfetchd')
				|| (activeDrops.get(serverId).toLowerCase() === 'mr. mime' && message.content.toLowerCase() === 'mr mime')
				|| (activeDrops.get(serverId).toLowerCase() === 'ho-oh' && message.content.toLowerCase() === 'ho oh')
				|| (activeDrops.get(serverId).toLowerCase() === 'ho-oh' && message.content.toLowerCase() === 'hooh'))) { //edge case
				const curMon = activeDrops.get(serverId);
				const coinsToAdd = getRandomInt(21) + 5;
				message.channel.send(`Added ${curMon} to party! You gained ${coinsToAdd} coins for your catch.`);
				dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
					if (err) {
						console.error(err.message);
						return;
					}
					if (!row) {
						// User isn't in the database, add them
						dbUser.run("INSERT INTO user (user_id, caught_pokemon, currency) VALUES (?, ?, ?)", [userId, JSON.stringify([curMon]), coinsToAdd], (err) => {
							if (err) {
								console.error(err.message);
							}
							activeDrops.delete(serverId);
						});
					} 
					else {
						// User is in the database, update their caught Pokémon & currency
						const caughtPokemon = JSON.parse(row.caught_pokemon);
						caughtPokemon.push(curMon);
						const newCurrency = row.currency + coinsToAdd;
						dbUser.run("UPDATE user SET caught_pokemon = ?, currency = ? WHERE user_id = ?", [JSON.stringify(caughtPokemon), newCurrency, userId], (err) => {
							if (err) {
								console.error(err.message);
							}
							activeDrops.delete(serverId);
						});
					}
				});
			}
			
			//party
			else if (message.content.startsWith('.p') || message.content.startsWith('.party') ) {
			// Get the user's ID and display all their Pokémon in an embedded list
				dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
					if (err) {
						console.error(err.message);
						message.channel.send('An error occurred while fetching your Pokémon.');
						return;
					}
					if (!row || !row.caught_pokemon) {
						message.channel.send('You have not caught any Pokémon yet.');
					} 
					else {
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
							const filter = i => i.user.id === userId;
							const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

							collector.on('collect', async i => {
								if (i.customId === 'prev') {
									if (page > 0) page--;
								} 
								else if (i.customId === 'next') {
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
			
			//currency
			else if (message.content.startsWith('.c') || message.content.startsWith('.currency')) {
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
			}
			
			//help
			else if(message.content.startsWith('.help')) {
				const helpEmbed = new EmbedBuilder()
					.setColor('#0099ff')
					.setTitle('Help')
					.setDescription('List of available commands and how to use them:')
					.addFields(
						{ name: '.drop (.d)', value: 'Drops a random Pokémon in the channel. Cooldown: 5 minutes.' },
                        { name: '.party (.p)', value: 'Displays your caught Pokémon.' },
                        { name: '.currency (.c)', value: 'Displays your current amount of coins.' },
                        { name: '.hint (.h)', value: 'Gives a hint for the currently dropped Pokémon.' },
                        { name: '.release <partyNum> (.r)', value: 'Releases a Pokémon from your party. Example: .release 1' },
                        { name: '.trade @<user> (.t)', value: 'Initiates a trade with another user.' },
						{ name: 'Catching:', value: 'Type a pokemon\'s name after it has dropped to claim. Example: Pikachu' }
                    )
                    .setFooter({ text: 'Use the commands above to interact with the bot' })
                    .setTimestamp();

				message.channel.send({ embeds: [helpEmbed] });
			}
			
			//hint
			else if (message.content.startsWith('.h') || message.content.startsWith('.hint')) {
				let curMon = "";
				let monLength = 0;
				try {
					curMon = activeDrops.get(serverId);
					monLength = curMon.length;
					let numLetters = 0;
					let curMonHint = activeDrops.get(serverId);
					while (numLetters / monLength < 0.6) {
						const randomInt = getRandomInt(monLength);
						if (!(curMonHint[randomInt] === '_')) {
							curMonHint = curMonHint.replaceAt(randomInt, '_');
							numLetters++;
						}
					}
					//Edge cases handled in poor ways
					if (curMon.toLowerCase() === 'farfetch\'d') {
						curMonHint = curMonHint.replaceAt(8, '\'');;
					}
					else if (curMon.toLowerCase() === 'mr. mime') {
						curMonHint = curMonHint.replaceAt(2, '.');
					}
					else if (curMon.toLowerCase() === 'ho-oh') {
						curMonHint = curMonHint.replaceAt(2, '-');
					}
					const regex = new RegExp("_", 'g');
					let finalHint = curMonHint.replace(regex, "\\_");
					message.channel.send(finalHint);
				}
				catch (error) {
					message.channel.send('No current pokemon dropped!');
				}	
			}
				
			//release
			else if (message.content.startsWith('.release') || message.content.startsWith('.r')) {
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
						message.channel.send('Please specify a valid Pokémon number.');
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
			}
			
			//trade
			else if (message.content.startsWith('.trade') || message.content.startsWith('.t')) {
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
						if (trade.user1 === userId) {
							trade.user1Pokemon = partyNum;
						} 
						else if (trade.user2 === userId) {
							trade.user2Pokemon = partyNum;
						}
						else {
							message.channel.send("You are not part of the active trade.");
							return;
						}
						if (trade.user1Pokemon !== null && trade.user2Pokemon !== null) {
							message.channel.send("Both Pokémon have been added to the trade. Type `.trade confirm` to confirm the trade.");
						} 
						else {
							message.channel.send("Pokémon added to the trade. Waiting for the other user to add their Pokémon.");
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
			}
			
			//turn off
			else if ( (message.content === '.off' || message.content === '.stop') && (userId === '177580797165961216')) {
				message.delete();
				process.exit();
			}
		}
	}
});

client.login(token);