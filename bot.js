require('dotenv').config({ path: './dotenv.env' });

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pokemon.db');
const dbUser = new sqlite3.Database('./user.db');
const dbServer = new sqlite3.Database('./server.db');
const dbShop = new sqlite3.Database('./shop.db')
const dbQuests = new sqlite3.Database('./quests.db')
const dbUserQuests = new sqlite3.Database('./user_quests.db');
const dbGoldShop = new sqlite3.Database('./goldshop.db');

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
const activeDrops = new Map();	//Map<serverId_channelId, activePokemon {name, isShiny, form, userThatDroppedID}>
const activeTrades = new Map();	//Map<serverId, {user1, user2, user1Pokemon, user2Pokemon, user1Confirmed, user2Confirmed}>
const activeUserRepels = new Map(); //Map<userId, { standard, rare }>

//Helper function, .party Embed Generator
//isSLM: 0 = default/name, 1 = shiny, 2 = legendary, 3 = mythical, 4 = ultra beast
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
					const formPrefix = p.form;
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
	else if (isSLM === 4) { //ultra beast
		color = '#CF9FFF';
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
function updateEmbed(shinyImg, dexNumber, pokemonRow, selectedForm, pokeList, genders, totalCaught, formCaughtCount, ) {
	const shinyImageLinks = JSON.parse(pokemonRow.shinyImageLinks);
	const imgLinks = JSON.parse(pokemonRow.imageLinks);

	const imageLink = shinyImg ? shinyImageLinks[selectedForm] || shinyImageLinks.default : imgLinks[selectedForm] || imgLinks.default;

	const formTypes = getFormTypes(pokemonRow.name, selectedForm, pokeList);
	let type1Field = '';
	let type2Field = '';
	let regionField = '';
	let genderRatio = '';
	let formOwnedVar = '';
	if (formTypes.formFound === true) {
		type1Field = formTypes.type1;
		type2Field = formTypes.type2 ? ` / ${formTypes.type2}` : '';
		regionField = formTypes.region;
	}
	else {
		type1Field = pokemonRow.type1;
		type2Field = pokemonRow.type2 ? ` / ${pokemonRow.type2}` : '';
		regionField = pokemonRow.region;
	}
	if (selectedForm.toLowerCase() === 'alolan' || selectedForm.toLowerCase() === 'default') {
		selectedForm = '';
	}
	if (selectedForm.toLowerCase() !== '') {
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

	if (totalCaught === 0) {
		totalCaught = 'Not owned';
	}
	if (formCaughtCount === 0) {
		formOwnedVar = 'Not owned';
	}
	else {
		formOwnedVar = `${formCaughtCount}`;
	}

	return new EmbedBuilder()
		.setColor('#0099ff')
		.setTitle(`${pokemonRow.name} - #${dexNumber} ${selectedForm}`)
		.addFields(
			{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
			{ name: 'Region', value: `${regionField}`, inline: true },
			{ name: 'Gender Ratio', value: `${genderRatio}`, inline: true },
			{ name: 'Total Owned:', value: `${totalCaught}`, inline: true },
			{ name: 'Form Owned:', value: `${formOwnedVar}`, inline: true }
		)
		.setImage(imageLink)
		.setTimestamp();
}

//Helper function, query for form + name to get typings
function getFormTypes(name, form, pokeList) {
	const dexEntry = `${form} ${name}`.trim();
	//filter by: pokeList[i].isLM = 3 && pokeList[i].name = dexEntry
	const filteredList = pokeList.filter(pokemon => pokemon.isLM === 3 && pokemon.name === dexEntry);
	if (filteredList.length > 0) {
		const foundPokemon = filteredList[0];
		return {
			formFound: true,
			type1: foundPokemon.type1,
			type2: foundPokemon.type2,
			region: foundPokemon.region
		};
	}
	else {
		return {
			formFound: false,
			type1: '',
			type2: '',
			region: ''
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

function getFixedName(user) {
	return user.replace(/_/g, '\\_');
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
	else if (pokemonIdentifier === 'Sirfetchd' || pokemonIdentifier === 'Sirfetch’d' || pokemonIdentifier === 'Sirfetch‘d') {
		pokemonIdentifier = 'Sirfetch\'d';
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
	else if (pokemonIdentifier === 'Mr' && args.length > 2) { //args.length > 2
		if (args[2].toLowerCase() === 'rime') {
			pokemonIdentifier = 'Mr. Rime';
		}
	}
	else if (pokemonIdentifier === 'Mr.' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'rime') {
			pokemonIdentifier = 'Mr. Rime';
		}
	}
	else if (pokemonIdentifier === 'Mr.rime' || pokemonIdentifier === 'Mrrime') { //length > 2
		pokemonIdentifier = 'Mr. Rime';
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
	else if (pokemonIdentifier === 'Type:' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'null') {
			pokemonIdentifier = 'Type: Null';
		}
	}
	else if (pokemonIdentifier === 'Type' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'null') {
			pokemonIdentifier = 'Type: Null';
		}
	}
	else if (pokemonIdentifier === 'Type:null') {
		pokemonIdentifier = 'Type: Null';
	}
	else if (pokemonIdentifier === 'Typenull') {
		pokemonIdentifier = 'Type: Null';
	}
	else if (pokemonIdentifier === 'Jangmo' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'o') {
			pokemonIdentifier = 'Jangmo-o';
		}
	}
	else if (pokemonIdentifier === 'Jangmoo') {
		pokemonIdentifier = 'Jangmo-o';
	}
	else if (pokemonIdentifier === 'Hakamo' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'o') {
			pokemonIdentifier = 'Hakamo-o';
		}
	}
	else if (pokemonIdentifier === 'Hakamoo') {
		pokemonIdentifier = 'Hakamo-o';
	}
	else if (pokemonIdentifier === 'Kommo' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'o') {
			pokemonIdentifier = 'Kommo-o';
		}
	}
	else if (pokemonIdentifier === 'Kommoo') {
		pokemonIdentifier = 'Kommo-o';
	}
	else if (pokemonIdentifier === 'Tapu' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'koko') {
			pokemonIdentifier = 'Tapu Koko';
		}
		else if (args[2].toLowerCase() === 'lele') {
			pokemonIdentifier = 'Tapu Lele';
		}
		else if (args[2].toLowerCase() === 'bulu') {
			pokemonIdentifier = 'Tapu Bulu';
		}
		else if (args[2].toLowerCase() === 'fini') {
			pokemonIdentifier = 'Tapu Fini';
		}
	}
	else if (pokemonIdentifier === 'Great' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'tusk') {
			pokemonIdentifier = 'Great Tusk';
		}
	}
	else if (pokemonIdentifier === 'Greattusk') {
		pokemonIdentifier = 'Great Tusk';
	}
	else if (pokemonIdentifier === 'Scream' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'tail') {
			pokemonIdentifier = 'Scream Tail';
		}
	}
	else if (pokemonIdentifier === 'Screamtail') {
		pokemonIdentifier = 'Scream Tail';
	}
	else if (pokemonIdentifier === 'Brute' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'bonnet') {
			pokemonIdentifier = 'Brute Bonnet';
		}
	}
	else if (pokemonIdentifier === 'Brutebonnet') {
		pokemonIdentifier = 'Brute Bonnet';
	}
	else if (pokemonIdentifier === 'Flutter' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'mane') {
			pokemonIdentifier = 'Flutter Mane';
		}
	}
	else if (pokemonIdentifier === 'Fluttermane') {
		pokemonIdentifier = 'Flutter Mane';
	}
	else if (pokemonIdentifier === 'Slither' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'wing') {
			pokemonIdentifier = 'Slither Wing';
		}
	}
	else if (pokemonIdentifier === 'Slitherwing') {
		pokemonIdentifier = 'Slither Wing';
	}
	else if (pokemonIdentifier === 'Sandy' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'shocks') {
			pokemonIdentifier = 'Sandy Shocks';
		}
	}
	else if (pokemonIdentifier === 'Sandyshocks') {
		pokemonIdentifier = 'Sandy Shocks';
	}
	else if (pokemonIdentifier === 'Iron' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'treads') {
			pokemonIdentifier = 'Iron Treads';
		}
		else if (args[2].toLowerCase() === 'bundle') {
			pokemonIdentifier = 'Iron Bundle';
		}
		else if (args[2].toLowerCase() === 'hands') {
			pokemonIdentifier = 'Iron Hands';
		}
		else if (args[2].toLowerCase() === 'jugulis') {
			pokemonIdentifier = 'Iron Jugulis';
		}
		else if (args[2].toLowerCase() === 'moth') {
			pokemonIdentifier = 'Iron Moth';
		}
		else if (args[2].toLowerCase() === 'thorns') {
			pokemonIdentifier = 'Iron Thorns';
		}
		else if (args[2].toLowerCase() === 'valiant') {
			pokemonIdentifier = 'Iron Valiant';
		}
		else if (args[2].toLowerCase() === 'leaves') {
			pokemonIdentifier = 'Iron Leaves';
		}
		else if (args[2].toLowerCase() === 'boulder') {
			pokemonIdentifier = 'Iron Boulder';
		}
		else if (args[2].toLowerCase() === 'crown') {
			pokemonIdentifier = 'Iron Crown';
		}
	}
	else if (pokemonIdentifier === 'Irontreads') {
		pokemonIdentifier = 'Iron Treads';
	}
	else if (pokemonIdentifier === 'Ironbundle') {
		pokemonIdentifier = 'Iron Bundle';
	}
	else if (pokemonIdentifier === 'Ironhands') {
		pokemonIdentifier = 'Iron Hands';
	}
	else if (pokemonIdentifier === 'Ironjugulis') {
		pokemonIdentifier = 'Iron Jugulis';
	}
	else if (pokemonIdentifier === 'Ironmoth') {
		pokemonIdentifier = 'Iron Moth';
	}
	else if (pokemonIdentifier === 'Ironthorns') {
		pokemonIdentifier = 'Iron Thorns';
	}
	else if (pokemonIdentifier === 'Wo' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'chien') {
			pokemonIdentifier = 'Wo-Chien';
		}
	}
	else if (pokemonIdentifier === 'Wochien') {
		pokemonIdentifier = 'Wo-Chien';
	}
	else if (pokemonIdentifier === 'Chien' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'pao') {
			pokemonIdentifier = 'Chien-Pao';
		}
	}
	else if (pokemonIdentifier === 'Chienpao') {
		pokemonIdentifier = 'Chien-Pao';
	}
	else if (pokemonIdentifier === 'Ting' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'lu') {
			pokemonIdentifier = 'Ting-Lu';
		}
	}
	else if (pokemonIdentifier === 'Tinglu') {
		pokemonIdentifier = 'Ting-Lu';
	}
	else if (pokemonIdentifier === 'Chi' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'yu') {
			pokemonIdentifier = 'Chi-Yu';
		}
	}
	else if (pokemonIdentifier === 'Chiyu') {
		pokemonIdentifier = 'Chi-Yu';
	}
	else if (pokemonIdentifier === 'Roaring' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'moon') {
			pokemonIdentifier = 'Roaring Moon';
		}
	}
	else if (pokemonIdentifier === 'Roaringmoon') {
		pokemonIdentifier = 'Roaring Moon';
	}
	else if (pokemonIdentifier === 'Ironvaliant') {
		pokemonIdentifier = 'Iron Valiant';
	}
	else if (pokemonIdentifier === 'Walking' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'wake') {
			pokemonIdentifier = 'Walking Wake';
		}
	}
	else if (pokemonIdentifier === 'Walkingwake') {
		pokemonIdentifier = 'Walking Wake';
	}
	else if (pokemonIdentifier === 'Ironleaves') {
		pokemonIdentifier = 'Iron Leaves';
	}
	else if (pokemonIdentifier === 'Gouging' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'fire') {
			pokemonIdentifier = 'Gouging Fire';
		}
	}
	else if (pokemonIdentifier === 'Gougingfire') {
		pokemonIdentifier = 'Gouging Fire';
	}
	else if (pokemonIdentifier === 'Raging' && args.length > 2) { //length > 2
		if (args[2].toLowerCase() === 'bolt') {
			pokemonIdentifier = 'Raging Bolt';
		}
	}
	else if (pokemonIdentifier === 'Ragingbolt') {
		pokemonIdentifier = 'Raging Bolt';
	}
	else if (pokemonIdentifier === 'Ironboulder') {
		pokemonIdentifier = 'Iron Boulder';
	}
	else if (pokemonIdentifier === 'Ironcrown') {
		pokemonIdentifier = 'Iron Crown';
	}
	
	return pokemonIdentifier;
}

function showQuestCompletions(userId, message) {
    let info = [];
    dbUserQuests.all("SELECT * FROM user_quests WHERE user_id = ? AND completed = 1", [userId], (err, quests) => {
        if (err) {
            console.error(err);
            message.channel.send("Could not find user's quests");
            return;
        }
        if (quests.length === 0) {
            message.channel.send("User has no completed quests!");
            return;
        }

        dbQuests.all("SELECT * FROM quests", [], (err2, questInfo) => {
            if (err2) {
                message.channel.send("Could not find the quest given a quest id");
                return;
            }

            quests.forEach(quest => {
                let currentQuest = questInfo.find(t => t.quest_id === quest.quest_id);
                if (currentQuest) {
                    info.push({
                        quest_header: currentQuest.collection_name,
                        quest_description: currentQuest.description,
                        quest_progress: `Date Completed: ${quest.completed_at}`
                    });
                }
            });

            let page = 0;
            let totalPages = Math.ceil(info.length / 3);

            const buttonRow = new ActionRowBuilder()
                .addComponents(
					new ButtonBuilder()
						.setCustomId('rewind')
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
						.setCustomId('fforward')
						.setLabel('⏩')
						.setStyle(ButtonStyle.Primary)
                );
		

            const generateQuestEmbed = (page) => {
                const start = page * 3;
                const end = start + 3;
                const pageItems = info.slice(start, end);

                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle(`Quest Completions (Page ${page + 1}/${totalPages})`)
                    .setTimestamp();

                pageItems.forEach((item, index) => {
                    embed.addFields({
                        name: `\`${start + index + 1}:\` **${item.quest_header}**`,
                        value: `${item.quest_description}\n${item.quest_progress}`
                    });
                });

                return embed;
            };

            const embed = generateQuestEmbed(page);
            message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
                const filter = i => i.user.id === message.author.id;
                const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

                collector.on('collect', async i => {
                    try {
                        if (i.customId === 'prevPage') {
                            page = (page - 1 + totalPages) % totalPages;
                        } else if (i.customId === 'nextPage') {
                            page = (page + 1) % totalPages;
                        } else if (i.customId === 'rewind') {
							page = 0;
						} else if (i.customId === 'fforward') {
							page = totalPages - 1;
						}
                        const updatedEmbed = generateQuestEmbed(page);
                        await i.update({ embeds: [updatedEmbed], components: [buttonRow] });
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
									.setCustomId('rewind')
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
									.setCustomId('fforward')
									.setLabel('⏩')
									.setStyle(ButtonStyle.Primary)
                                    .setDisabled(true)
                            );

                        await sentMessage.edit({ components: [disabledRow] });
                    } catch (error) {
                        if (error.code === 10008) {
                            console.log('The message was deleted before the interaction was handled.');
                        } else {
                            console.error('An unexpected error occurred:', error);
                        }
                    }
                });
            }).catch(err => {
                console.error('Error sending the quest message:', err);
            });
        });
    });
}


//Shows the quest progress for the user's quests
function showQuestProgress(userId, message) {
    let info = [];
    dbUserQuests.all("SELECT * FROM user_quests WHERE user_id = ? AND completed = 0", [userId], (err, quests) => {
        if (err) {
            console.error(err);
            message.channel.send("Could not find user's quests");
            return;
        }
        if (quests.length === 0) {
            message.channel.send("User has completed all quests!");
            return;
        }

        dbQuests.all("SELECT * FROM quests", [], (err2, questInfo) => {
            if (err2) {
                message.channel.send("Could not find the quest given a quest id");
                return;
            }

            quests.forEach(quest => {
                let currentQuest = questInfo.find(t => t.quest_id === quest.quest_id);
                if (currentQuest) {
                    info.push({
                        quest_header: currentQuest.collection_name,
                        quest_description: currentQuest.description,
                        quest_progress: `Progress: ${quest.progress}/${currentQuest.poke_count}`
                    });
                }
            });

            let page = 0;
            let totalPages = Math.ceil(info.length / 3);

            const buttonRow = new ActionRowBuilder()
                .addComponents(
					new ButtonBuilder()
						.setCustomId('rewind')
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
						.setCustomId('fforward')
						.setLabel('⏩')
						.setStyle(ButtonStyle.Primary)
                );
		

            const generateQuestEmbed = (page) => {
                const start = page * 3;
                const end = start + 3;
                const pageItems = info.slice(start, end);

                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle(`Quest Progress (Page ${page + 1}/${totalPages})`)
                    .setTimestamp();

                pageItems.forEach((item, index) => {
                    embed.addFields({
                        name: `\`${start + index + 1}:\` **${item.quest_header}**`,
                        value: `${item.quest_description}\n${item.quest_progress}`
                    });
                });

                return embed;
            };

            const embed = generateQuestEmbed(page);
            message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
                const filter = i => i.user.id === message.author.id;
                const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

                collector.on('collect', async i => {
                    try {
                        if (i.customId === 'prevPage') {
                            page = (page - 1 + totalPages) % totalPages;
                        } else if (i.customId === 'nextPage') {
                            page = (page + 1) % totalPages;
                        } else if (i.customId === 'rewind') {
							page = 0;
						} else if (i.customId === 'fforward') {
							page = totalPages - 1;
						}
                        const updatedEmbed = generateQuestEmbed(page);
                        await i.update({ embeds: [updatedEmbed], components: [buttonRow] });
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
									.setCustomId('rewind')
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
									.setCustomId('fforward')
									.setLabel('⏩')
									.setStyle(ButtonStyle.Primary)
                                    .setDisabled(true)
                            );

                        await sentMessage.edit({ components: [disabledRow] });
                    } catch (error) {
                        if (error.code === 10008) {
                            console.log('The message was deleted before the interaction was handled.');
                        } else {
                            console.error('An unexpected error occurred:', error);
                        }
                    }
                });
            }).catch(err => {
                console.error('Error sending the quest message:', err);
            });
        });
    });
}

//Parses quest-required pokemon
function parseRequiredPokemon(requiredPokemonStr, requiredFormsStr, callback) {
	let requiredPokemonList = [];
	let dexNums = [];

	// Parse required Pokemon, handling ranges (e.g., "133-136, 196, 197")
	requiredPokemonStr.split(",").forEach(part => {
		part = part.trim();
		if (part.includes("-")) {
			let [start, end] = part.split("-").map(Number);
			for (let i = start; i <= end; i++) {
				dexNums.push(i);
			}
		} else {
			dexNums.push(Number(part));
		}
	});

	let formMap = JSON.parse(requiredFormsStr || "{}");
	let queriesRemaining = dexNums.length; // Track remaining async queries

	dexNums.forEach(dexNum => {
		db.get("SELECT name FROM pokemon WHERE dexNum = ?", [dexNum], (err, row) => {
			if (!err && row) {
				let name = row.name;
				let forms = formMap[dexNum] || [null]; // Allow any form if not specified

				forms.forEach(form => requiredPokemonList.push({ name, form }));
			}

			// Ensure all database queries finish before returning
			queriesRemaining--;
			if (queriesRemaining === 0) {
				callback(requiredPokemonList);
			}
		});
	});

	// If there were no dexNums, return immediately
	if (dexNums.length === 0) {
		callback(requiredPokemonList);
	}
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
const goldShopCommandRegex = /^\.(goldshop|gs|gshop)\b/;
const goldBuyCommandRegex = /^\.(gbuy|goldbuy)\b/;

const maxDexNum = 1025; //number x is max pokedex entry - EDIT WHEN ADDING MORE POKEMON

client.on('ready', () => {
	console.log(`Logged in as ${client.user.tag}`);
	dbUser.run("CREATE TABLE IF NOT EXISTS user" +
		" (user_id TEXT PRIMARY KEY," + 
		" caught_pokemon TEXT," +
		" currency INTEGER DEFAULT 0," +
		" inventory TEXT DEFAULT '[]'," +
		" servers TEXT DEFAULT '[]'," +
		" cdString TEXT DEFAULT ''," +
		" acNum INTEGER DEFAULT 0," +
		" totalCaught INTEGER DEFAULT 0," +
		" totalSpent INTEGER DEFAULT 0," +
		" gold INTEGER DEFAULT 0," + 
		" critDropString TEXT DEFAULT '')");
	dbServer.run("CREATE TABLE IF NOT EXISTS server" +
		" (server_id TEXT PRIMARY KEY," +
		" allowed_channels_id TEXT)")});
	dbUserQuests.run(`CREATE TABLE IF NOT EXISTS user_quests (
			user_id TEXT,
			quest_id INTEGER,
			progress INTEGER DEFAULT 0,
			completed INTEGER DEFAULT 0,
			completed_at TEXT DEFAULT NULL,
			PRIMARY KEY (user_id, quest_id),
			FOREIGN KEY (quest_id) REFERENCES quests(quest_id)
		)`);

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

			//hard coded for stella
		
			if (serverId === '945102690113953802' && message.content.includes('<:Hmm:1325888545906233446>')) {
				message.channel.send('<:Hehe:1327059514771509329>');
			}
			else if (serverId === '945102690113953802' && message.content.includes('<:Hehe:1327059514771509329>')) {
				message.channel.send('<:Hmm:1325888545906233446>');
			}

			//TODO: Move up
			function createQuestsForUserAndUpdate(message, userId, newPokemonObj) {
				dbQuests.all("SELECT * FROM quests", [], (err, quests) => {
					if (err) {
						console.error("Error fetching quests:", err.message);
						message.channel.send("An error occurred while updating quests.");
						return;
					}

					if (quests.length === 0) {
						message.channel.send("Must run setupQuestsDB.js first!");
						return;
					}

					dbUserQuests.serialize(() => {
                        dbUserQuests.run("BEGIN TRANSACTION");
                    

						quests.forEach(quest => {
							dbUserQuests.run(`INSERT INTO user_quests (user_id, quest_id) VALUES (?, ?)`, [userId, quest.quest_id], (err) => {
									if (err) {
										console.error(`Error updating quest progress for ${user.user_id}, Quest ${quest.quest_id}:`, err.message);
									}
								}
							);
						});

						dbUserQuests.run("COMMIT", err => {
							if (err) {
								console.error("Transaction commit failed:", err.message);
							} else {
								updateQuestProgress(message, userId, newPokemonObj);
							}
						});
					});
				});
			}

			//TODO: Move up
			async function rewardUserForCompleteQuest(message, userId, userInfo, questId, quests) {
				let completedQuest = quests.filter(k => k.quest_id === questId)[0];
				let reward = completedQuest.reward;
				let userInventory = JSON.parse(userInfo.inventory) || [];
				let currentUserGold = userInfo.gold;

				if (reward === 'Lootbox') {
					let foundFlag = false;
					for (let i = 0; i < userInventory.length; i++) {
						if (userInventory[i].includes('Lootbox')) {
							foundFlag = true;
							
							let parts = userInventory[i].split('(x');
							let count = parseInt(parts[1]) || 0;

							count += 1;
							userInventory[i] = `Lootbox (x${count})`;
							break;
						}
					}

					if (!foundFlag) {
						userInventory.push(`Lootbox (x1)`);
					}
				} else {
					currentUserGold += parseInt(reward);
				}
				let displayMessage = (reward === 'Lootbox') ? `You completed the ${completedQuest.collection_name} quest!\nYou have been awarded a ${reward}!` :
					`You completed the ${completedQuest.collection_name} quest!\nYou have been awarded ${reward} gold!`;
				message.channel.send(displayMessage);
				dbUser.run("UPDATE user SET inventory = ?, gold = ? WHERE user_id = ?", [JSON.stringify(userInventory), currentUserGold, userId], (error) => {
					if (error) {
						console.log(`Couldn't update user's inventory`);
						return;
					}
				});
				return {
					newGold: currentUserGold,
					newInventory: userInventory
				};
			}

			async function updateReleaseQuestProgress(message, userId, oldPokemonObj) {
				dbQuests.all("SELECT * FROM quests", [], (err, quests) => {
					if (err) {
						console.error("Error fetching quests:", err.message);
						message.channel.send("An error occurred while updating quests.");
						return;
					}

					if (quests.length === 0) {
						console.error("Quests DB is empty! Run setupQuestsDB.js.");
						return;
					}

					dbUser.get("SELECT caught_pokemon, inventory, gold FROM user WHERE user_id = ?", [userId], (err, userInfo) => {
						if (err) {
							console.error("Error fetching user's pokemon:", err.message);
							message.channel.send("An error occurred while updating quests.");
							return;
						}

						const caughtUserPokemon = JSON.parse(userInfo.caught_pokemon);
						if (caughtUserPokemon.length === 0 || caughtUserPokemon === null) {
							console.error("Error fetching user's pokemon:", err.message);
							message.channel.send("An error occurred while updating quests.");
							return;
						}


						quests.forEach(quest => {
							parseRequiredPokemon(quest.required_pokemon, quest.required_forms, (requiredPokemonList) => {
								let caughtName = oldPokemonObj.name.replace("✨", "");
								//speed up, filter
									
								let caughtFlag = false;
								dbUserQuests.get("SELECT * FROM user_quests WHERE user_id = ? AND quest_id = ?", [userId, quest.quest_id], async (error, result) => {
									if (error) {
										console.log(error);
										return;
									}
									if (!result) {
										console.log('user is not in the database for some reason?');
										return;
									}
									
									//want to find: what pokemon the user just gave away in quests not yet completed
									for (let i = 0; i < requiredPokemonList.length; i++) {
										if (requiredPokemonList[i].name.toLowerCase() === caughtName.toLowerCase()) {
											caughtFlag = true;
										}
									}

									//if the user already has it OR the quest is already completed, ignore
									let duplicateChecker = caughtUserPokemon.filter(pokemon => pokemon.name === oldPokemonObj.name && pokemon.form === oldPokemonObj.form);
									if (duplicateChecker.length > 0 || result.completed === 1) {
										caughtFlag = false;
									}

									if (caughtFlag) {
										//traded away a pokemon that COUNTS towards a quest's progress
										dbUserQuests.run("UPDATE user_quests SET progress = ? WHERE user_id = ? AND quest_id = ?", [result.progress - 1, userId, quest.quest_id]);
									}
								});
							});
						});
					});

				});
			}

			//TODO: Move up
			function updateQuestProgress(message, userId, newPokemonObj) {
				//parseRequiredPokemon for each quest
				dbQuests.all("SELECT * FROM quests", [], (err, quests) => {
					if (err) {
						console.error("Error fetching quests:", err.message);
						message.channel.send("An error occurred while updating quests.");
						return;
					}

					if (quests.length === 0) {
						console.error("Quests DB is empty! Run setupQuestsDB.js.");
						return;
					}

					dbUser.get("SELECT caught_pokemon, inventory, gold FROM user WHERE user_id = ?", [userId], (err, userInfo) => {
						if (err) {
							console.error("Error fetching user's pokemon:", err.message);
							message.channel.send("An error occurred while updating quests.");
							return;
						}

						let caughtUserPokemon = JSON.parse(userInfo.caught_pokemon);
						if (caughtUserPokemon.length === 0 || caughtUserPokemon === null) {
							console.error("Error fetching user's pokemon:", err.message);
							message.channel.send("An error occurred while updating quests.");
							return;
						}

						quests.forEach(quest => {
							parseRequiredPokemon(quest.required_pokemon, quest.required_forms, (requiredPokemonList) => {
								let caughtName = newPokemonObj.name.replace("✨", "");
								//speed up, filter
								let caughtFlag = false;
								dbUserQuests.get("SELECT completed FROM user_quests WHERE user_id = ? AND quest_id = ?", [userId, quest.quest_id], async (error, result) => {
									if (error) {
										console.log(error);
										return;
									}
									if (!result) {
										console.log('user is not in the database for some reason?');
										return;
									}
									
									for (let i = 0; i < requiredPokemonList.length; i++) {
										if (requiredPokemonList[i].name.toLowerCase() === caughtName.toLowerCase()) {
											caughtFlag = true;
										}
									}
		
									if (result.completed === 1) {
										caughtFlag = false;
									}

									if (caughtFlag) {
										

										let pokeCount = quest.poke_count;
										let progress = 0;
				
										requiredPokemonList.forEach(reqPokemon => {

											for (let caught of caughtUserPokemon) {
												let caughtName = caught.name.replace("✨", "");
												let caughtForm = caught.form;
		
												if (reqPokemon.name === caughtName && (reqPokemon.form === null || reqPokemon.form === caughtForm)) {
													progress++;
													break;
												}
			
												// Handle Nidoran gender-based naming
												if (reqPokemon.name === "Nidoran" && caughtName.includes("Nidoran")) {
													if (reqPokemon.form === newPokemonObj.gender) {
														progress++;
														break;
													}
												}
											}
										});
		
										let completed = progress >= pokeCount ? 1 : 0;
										let dateString = null;
										if (progress >= pokeCount) {
											dateString = new Date().toLocaleString("en-US", { timeZone: "CST" });
											let newUserInfo = await rewardUserForCompleteQuest(message, userId, userInfo, quest.quest_id, quests);
											userInfo.gold = newUserInfo.newGold;
											userInfo.inventory = JSON.stringify(newUserInfo.newInventory);
										}
		
										dbUserQuests.run("UPDATE user_quests SET progress = ?, completed = ?, completed_at = ? WHERE user_id = ? AND quest_id = ?", [progress, completed, dateString, userId, quest.quest_id]);
									}
								});
							});
						});
					});
				});
			}

 
			if (message.content.toLowerCase() === '.updatequests' && userId === '177580797165961216') {
				dbUser.all("SELECT user_id, caught_pokemon FROM user", [], (err, users) => {
					if (err) {
						console.error("Error fetching users:", err.message);
						message.channel.send("An error occurred while updating quests.");
						return;
					}
			
					if (users.length === 0) {
						message.channel.send("No users found.");
						return;
					}
			
					dbQuests.all("SELECT * FROM quests", [], (err, quests) => {
						if (err) {
							console.error("Error fetching quests:", err.message);
							message.channel.send("An error occurred while updating quests.");
							return;
						}
			
						users.forEach(user => {
							if (!user.caught_pokemon) return;
							let caughtPokemon = JSON.parse(user.caught_pokemon || "[]");
			
							quests.forEach(quest => {
								parseRequiredPokemon(quest.required_pokemon, quest.required_forms, (requiredPokemonList) => {
									let pokeCount = quest.poke_count;
									let progress = 0;
			
									requiredPokemonList.forEach(reqPokemon => {
										for (let caught of caughtPokemon) {
											let caughtName = caught.name.replace("✨", "");
											let caughtForm = caught.form;
			
											if (reqPokemon.name === caughtName && (reqPokemon.form === null || reqPokemon.form === caughtForm)) {
												progress++;
												break;
											}
			
											// Handle Nidoran gender-based naming
											if (reqPokemon.name === "Nidoran" && caughtName.includes("Nidoran")) {
												if (reqPokemon.form === caught.gender) {
													progress++;
													break;
												}
											}
										}
									});
			
									let completed = progress >= pokeCount ? 1 : 0;
									let dateString = null;
									if (progress >= pokeCount) {
										dateString = new Date().toLocaleString("en-US", { timeZone: "CST" });
									}
			
									dbUserQuests.run(`
										INSERT INTO user_quests (user_id, quest_id, progress, completed, completed_at) 
										VALUES (?, ?, ?, ?, ?)
										ON CONFLICT(user_id, quest_id) 
										DO UPDATE SET progress = ?, completed = ?, completed_at = ?`, 
										[user.user_id, quest.quest_id, progress, completed, dateString, progress, completed, dateString], 
										(err) => {
											if (err) {
												console.error(`Error updating quest progress for ${user.user_id}, Quest ${quest.quest_id}:`, err.message);
											}
										}
									);
								});
							});
						});
						message.channel.send("✅ Quests have been updated for all users!");
					});
				});
			}
			

			if (message.content.toLowerCase() === '.forceclaim' && userId === '177580797165961216') {
				dbUserQuests.all("SELECT user_id, quest_id FROM user_quests WHERE completed = 1", [], (err, completedQuests) => {
					if (err) {
						console.error("Error fetching completed quests:", err.message);
						message.channel.send("An error occurred while processing force claims.");
						return;
					}
			
					if (completedQuests.length === 0) {
						message.channel.send("No completed quests to claim.");
						return;
					}
			
					let userMap = new Map(); // Stores total rewards per user
			
					let pendingQueries = completedQuests.length;
			
					completedQuests.forEach(({ user_id, quest_id }) => {
						dbQuests.get("SELECT reward FROM quests WHERE quest_id = ?", [quest_id], (err, quest) => {
							if (err || !quest) {
								console.error(`Error fetching quest reward for quest ${quest_id}:`, err?.message || "Quest not found");
								if (--pendingQueries === 0) updateUsers(userMap);
								return;
							}
			
							let reward = quest.reward.toLowerCase();
			
							if (!userMap.has(user_id)) {
								userMap.set(user_id, { gold: 0, lootboxes: 0 });
							}
			
							if (reward === 'lootbox') {
								userMap.get(user_id).lootboxes += 1;
							} else {
								userMap.get(user_id).gold += parseInt(reward) || 0;
							}
			
							if (--pendingQueries === 0) updateUsers(userMap);
						});
					});
			
					function updateUsers(userMap) {
						userMap.forEach(({ gold, lootboxes }, user_id) => {
							dbUser.get("SELECT inventory, gold FROM user WHERE user_id = ?", [user_id], (err, user) => {
								if (err || !user) {
									console.error(`Error fetching user data for ${user_id}:`, err?.message || "User not found");
									return;
								}
			
								let userInventory = JSON.parse(user.inventory || "[]");
								let finalGoldAmount = user.gold + gold;
			
								if (lootboxes > 0) {
									let lootboxIndex = userInventory.findIndex(item => item.includes("Lootbox"));
									if (lootboxIndex !== -1) {
										let parts = userInventory[lootboxIndex].split("(x");
										let count = parseInt(parts[1]) || 0;
										count += lootboxes;
										userInventory[lootboxIndex] = `Lootbox (x${count})`;
									} else {
										userInventory.push(`Lootbox (x${lootboxes})`);
									}
								}
			
								dbUser.run("UPDATE user SET inventory = ?, gold = ? WHERE user_id = ?", 
									[JSON.stringify(userInventory), finalGoldAmount, user_id]);
							});
						});
			
						message.channel.send("✅ All completed quests have been force-claimed!");
					}
				});
			}
			

			if (message.content.toLowerCase() === '.checkgold') {
				dbUser.get("SELECT gold FROM user WHERE user_id = ?", [userId], (err, user) => {
					if (err || !user) {
						console.log('Error, user isn\'t in the system!');
						return;
					}

					message.channel.send(`You have ${user.gold} gold.`);
				});
			}

			//goldshop
			if (goldShopCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					dbGoldShop.all("SELECT * from goldshop", [], async (err, rows) => {
						if (err || !rows || rows.length === 0) {
							console.log('Error, user or goldshop isn\'t in the system!');
							message.channel.send("The shop is currently empty.");
							return;
						}
						const itemsPerPage = 5;
						let page = 1;
						const totalPages = Math.ceil(rows.length / itemsPerPage);

						const generateEmbed = (pageNum) => {
							const start = (pageNum - 1) * itemsPerPage;
							const end = start + itemsPerPage;
							const pageItems = rows.slice(start, end);

							const embed = new EmbedBuilder()
								.setTitle(`Gold Shop (Page ${pageNum}/${totalPages})`)
								.setDescription("List of available premium items in the gold shop\nUse the command `.goldbuy <shopNum>` to purchase an item")
								.setColor("#FFD700");

							pageItems.forEach(item => {
								embed.addFields({
									name: `\`${item.itemNum}:\` ${item.item_name} (${item.price} Gold)`,
									value: item.explanation
								});
							});

							return embed;
						};

						const embed = generateEmbed(page);
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

						message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
							const filter = i => i.user.id === message.author.id;
							const collector = sentMessage.createMessageComponentCollector({ filter, time: 60000 });

							collector.on('collect', async i => {
								try {
									if (i.customId === 'prevPage') {
										page = page - 1;
										if (page < 1) {
											page = totalPages;
										}
									}
									else if (i.customId === 'nextPage') {
										page = page + 1;
										if (page > totalPages) {
											page = 1;
										}
									}
									const updatedEmbed = generateEmbed(page);
									await i.update({ embeds: [updatedEmbed], components: [buttonRow] });
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
						});
					});
				});
			}

			/*things to worry about
				Implement other quests db
				Implement lootboxes
				add new incenses in the shop
				Add isChannelAllowed to like all the commands lol
				buffs command to show active buffs

				Make numbers on showQuestProgress & showQuestCompletions reference quest_id instead of a random index
				Add quest lookup command that displays an embed of all required pokemon, with pages of 10 pokemon/page
			*/

			if (goldBuyCommandRegex.test(message.content.toLowerCase())) {
				dbGoldShop.all('SELECT * FROM goldshop', [], (err, items) => {
					if (err) {
						console.log(err);
						message.channel.send('Database access error!');
						return;
					}
					if (!items || items.length === 0) {
						message.channel.send('Database not initialized!');
						return;
					}
					dbUser.get('SELECT * FROM user WHERE user_id = ?', [userId], (err2, userInfo) => {
						if (err2) {
							console.log(err);
							message.channel.send('Database access error!');
							return;
						}
						if (!userInfo) {
							message.channel.send('User isn\'t in the system!');
							return;
						}

						const args = message.content.split(' ').slice(1);
						if (args.length < 1) {
							message.channel.send('Please specify a valid shop number. Usage: `.goldbuy <shopNum>`');
							return;
						}
						let boughtItem = null;
						let shopNum = parseInt(args[0], 10);
						for (let i = 0; i < items.length; i++) {
							if (shopNum === items[i].itemNum) {
								if (userInfo.gold >= items[i].price) {
									if (items[i].user_column.toLowerCase() === 'acnum') {
										if (userInfo.acNum === 1) {
											message.channel.send('You already own this item!');
											return;
										}
										else {
											boughtItem = {
												name: items[i].item_name,
												price: items[i].price
											};
											userInfo.acNum = 1;
											userInfo.gold = userInfo.gold - items[i].price;
										}
									}
									else if (items[i].user_column.toLowerCase() === 'shinycharm') {
										if (userInfo.shinyCharm === 1) {
											message.channel.send('You already own this item!');
											return;
										}
										else {
											boughtItem = {
												name: items[i].item_name,
												price: items[i].price
											};
											userInfo.shinyCharm = 1;
											userInfo.gold = userInfo.gold - items[i].price;
										}
									}
									else if (items[i].user_column.toLowerCase() === 'critdropstring') {
										if (userInfo.critDropString.includes(items[i].identifier)) {
											message.channel.send('You already own this item!');
											return;
										}
										else {
											boughtItem = {
												name: items[i].item_name,
												price: items[i].price
											};
											userInfo.critDropString += items[i].identifier;
											userInfo.gold = userInfo.gold - items[i].price;
										}
									}
									else if (items[i].user_column.toLowerCase() === 'cdstring') {
										if (userInfo.cdString.includes(items[i].identifier)) {
											message.channel.send('You already own this item!');
											return;
										}
										else {
											boughtItem = {
												name: items[i].item_name,
												price: items[i].price
											};
											userInfo.cdString += items[i].identifier;
											userInfo.gold = userInfo.gold - items[i].price;
										}
									}
								} else {
									message.channel.send(`You don't have enough money for this!`);
									return;
								}
								
							}
						}

						if (!boughtItem) {
							message.channel.send('Not a valid goldshop number!');
							return;
						}

						const embed = new EmbedBuilder()
								.setColor('#ff0000')
								.setTitle('Buy Item')
								.setDescription(`Really buy ${boughtItem.name} for ${boughtItem.price}? Leftover gold after transaction: ${userInfo.gold}`)
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
												dbUser.run("UPDATE user SET acNum = ?, shinyCharm = ?, critDropString = ?, cdString = ?, gold = ? WHERE user_id = ?", [userInfo.acNum, userInfo.shinyCharm, userInfo.critDropString, userInfo.cdString, userInfo.gold, userId], (err) => {
													if (err) {
														console.error(err.message);
													}
													i.update({ content: `Successfully purchased ${boughtItem.name} for ${boughtItem.price}. You have ${userInfo.gold} leftover.`, embeds: [], components: [] });
												});
											} 
											else if (i.customId === 'buy_no') {
												i.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
												return;
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
					});
				});
			}

			//TODO: move down
			if (message.content.toLowerCase() === '.checkquestprogress') {
				showQuestProgress(userId, message);
			}

			//TODO: move down
			if (message.content.toLowerCase() === '.checkcompletedquests') {
				showQuestCompletions(userId, message);
			}

			if (message.content.toLowerCase() === '.addcritcharm' && userId === '177580797165961216') {
				dbUser.serialize(() => {
					dbUser.run("ALTER TABLE user ADD COLUMN critDropString TEXT DEFAULT ''");
					dbUser.run("ALTER TABLE user ADD COLUMN shinyCharm INTEGER DEFAULT 0");
				});
				message.channel.send("Added critDropString and shinyCharm columns.");
			}
			
			//drop
			if (dropCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					
					dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, caughtPokemonList) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your caught Pokémon.');
							return;
						}

						if (cooldowns.has(userId)) {
							const cooldownEnd = Math.floor(cooldowns.get(userId) / 1000);
							message.channel.send(`You can drop again <t:${cooldownEnd}:R>.`);
							return;
						}
						
						let cooldownDiff;
						let dropResetPercentage;
						let resetDrop = false;
						try 
						{
							cooldownDiff = caughtPokemonList.cdString;
							cooldownDiff = cooldownDiff.length;
							dropResetPercentage = caughtPokemonList.critDropString;
							dropResetPercentage = (6.25 * dropResetPercentage.length);
							dropResetPercentage = dropResetPercentage / 100;
							let randVar = Math.random();
							if (randVar < dropResetPercentage) {
								resetDrop = true;
								message.channel.send('Your drop has been instantly reset!');
							}
						} catch (error) {
							cooldownDiff = 0;
						}
						if (!resetDrop) {
							const cooldownEnd = now + 300000 - (30000 * cooldownDiff);
							cooldowns.set(userId, cooldownEnd);
							setTimeout(() => {
								cooldowns.delete(userId)
								if (cooldownAlerts.has(userId) && cooldownAlerts.get(userId)) {
									message.channel.send(`<@!${userId}>, your drop is off cooldown!`);
								}
							}, 300000  - (30000 * cooldownDiff));
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
								const ultraBeastNumber = Math.random();
								let isUltraBeast = false;
								const legendaryNumber = Math.random();
								let isLegendary = false;
								const mythicalNumber = Math.random();
								let isMythical = false;
								
								let pokemon = null;
								let embedColor = '#0099FF';
	
								const userRepels = activeUserRepels.get(userId);
								let repelList = rows.filter(row => row.isLM !== 3);

								let ub = false; //ultra beast
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
										if (rareRepel === 'Ultra Beast Incense') {
											ub = true;
										}
										else if (rareRepel === 'Legendary Incense') {
											l = true;
										}
										else if (rareRepel === 'Mythical Incense') {
											m = true;
										}
										else if (rareRepel === 'Shiny Incense') {
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
										else if (ub) {
											uncaughtPokemon = uncaughtPokemon.filter(pokemon => pokemon.isLM == 4);
										}


										// user caught all pokemon
										if (uncaughtPokemon.length === 0) {
											message.channel.send('You have caught all pokemon!');
											uncaughtPokemon = rows.filter(row => row.isLM !== 3);
										}

										const randRepelNum = Math.random();
										if (standardRepel === 'Normal Repel') {
											if (randRepelNum < 0.5) {
												message.channel.send('Repel worked **successfully**.');
												repelList = uncaughtPokemon;
											}
											else {
												message.channel.send('Repel was **unsuccessful**.');
											}
										}
										else if (standardRepel === 'Super Repel') {
											if (randRepelNum < 0.75) {
												message.channel.send('Repel worked **successfully**.');
												repelList = uncaughtPokemon;
											}
											else {
												message.channel.send('Repel was **unsuccessful**.');
											}
										}
										else if (standardRepel === 'Max Repel') {
											if (randRepelNum < 0.9) {
												message.channel.send('Repel worked **successfully**.');
												repelList = uncaughtPokemon;
											}
											else {
												message.channel.send('Repel was **unsuccessful**.');
											}
										}
									}

									activeUserRepels.delete(userId);
								}

								let shinyOdds = 0.00025;
								if (caughtPokemonList.shinyCharm === 1) {
									shinyOdds = 0.00025 * 2;
								}
								if (shinyNumber < shinyOdds || s) {
									isShiny = true;
								}
								
								if ((mythicalNumber < 0.005 || m) && !l && !ub) {
										isMythical = true;
								}
								else if (s && mythicalNumber < 0.025) {
									isMythical = true;
								}
								else if ((legendaryNumber < 0.0075 || l) && !ub) { 
									isLegendary = true;
								}
								else if (s && legendaryNumber < 0.05) {
									isLegendary = true;
								}
								else if (ultraBeastNumber < 0.0075 || ub) {
									isUltraBeast = true;
								}
								else if (s && ultraBeastNumber < 0.025) {
									isUltraBeast = true;
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
										console.log("Error, no legendary pokemon!");
									}
								}
								else if (isUltraBeast) {
									let rowsUB = repelList.filter(row => row.isLM === 4);
									if (rowsUB.length === 0) {
										rowsUB = rows.filter(row => row.isLM === 4);
									}
									if (rowsUB.length > 0) {
										pokemon = rowsUB[getRandomInt(rowsUB.length)];
										embedColor = '#CF9FFF';
									}
									else {
										console.log("Error, no ultra beast pokemon!");
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
								
								const formTypes = getFormTypes(pokemon.name, selectForm.name, rows);
								let type1Field = pokemon.type1;
								let type2Field = pokemon.type2 ? ` / ${pokemon.type2}` : '';
								let realRegion = pokemon.region;
								if (formTypes.formFound === true) {
									type1Field = formTypes.type1;
									type2Field = formTypes.type2 ? ` / ${formTypes.type2}` : '';
									realRegion = formTypes.region;
								}
								

								const curMon = pokemon.name ? `${pokemon.name}` : '';
								console.log('Current pokemon: ' + curMon + '\n' + 
									'ShinyNum:     ' + shinyNumber + ` (<${shinyOdds})` + '\n' + 
									'MythicalNum:  ' + mythicalNumber + ' (<0.005)' + '\n' + 
									'LegendaryNum: ' + legendaryNumber + ' (<0.0075)' +'\n' +
									'UltraBeastNum: ' + ultraBeastNumber + ' (<0.0075)' +'\n' +
									'Form: ' + selectForm.name + '\n' +
									'Gender: ' + selectGender.name + '\n');
								
								activeDrops.set(`${serverId}_${message.channel.id}`, { name: curMon, isShiny, form: selectForm.name, gender: selectGender.name, userThatDroppedID: userId });
								
								const embed = new EmbedBuilder()
									.setColor(embedColor)
									.addFields(
										{ name: 'Type', value: `${type1Field}${type2Field}`, inline: true },
										{ name: 'Region', value: `${realRegion}`, inline: true }
									)
									.setImage(imageLink)
									.setTimestamp()
	
								message.channel.send({ embeds: [embed] });
								if (userId === '216789962459185152' && curMon.toLowerCase() === 'Koffing') {
									message.channel.send('L000000L EVERYONE LOOK LOOK LOOK EVERYONE LOOK BRENDA DROPPED A KOFFING LMFAOOOOOOOOOOOOOOOO LOOK GUYS IT\'S HILARIOUS BETTER TYPE KOFFING BRENDAAAA YOU REALLLLLY NEED TO CLAIM IT MAKE SURE YOU GRAB IT FAST IT MIGHT GET STOLEN L000000L JK NICE KOFFING');
								}
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
					// let isNumber = !isNaN(pokemonIdentifier);
					// if (!isNumber) {
					// 	message.channel.send('Please specify a valid pokedex number. Usage: `.forceSpawn <PokedexNum>`');
					// }
					// else {
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
							
							activeDrops.set(`${serverId}_${message.channel.id}`, { name: curMon, isShiny, form: selectForm.name, gender: selectGender.name, userThatDroppedID: userId });
							
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
					// }
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
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'flabébé' && message.content.toLowerCase() === 'flabebe')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'type: null' && message.content.toLowerCase() === 'type null')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'type: null' && message.content.toLowerCase() === 'type:null')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'type: null' && message.content.toLowerCase() === 'typenull')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'jangmo-o' && message.content.toLowerCase() === 'jangmo o')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'jangmo-o' && message.content.toLowerCase() === 'jangmoo')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'hakamo-o' && message.content.toLowerCase() === 'hakamo o')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'hakamo-o' && message.content.toLowerCase() === 'hakamoo')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'Kommo-o' && message.content.toLowerCase() === 'kommo o')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'Kommo-o' && message.content.toLowerCase() === 'kommoo')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'tapu koko' && message.content.toLowerCase() === 'tapukoko')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'tapu lele' && message.content.toLowerCase() === 'tapulele')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'tapu bulu' && message.content.toLowerCase() === 'tapubulu')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'tapu fini' && message.content.toLowerCase() === 'tapufini')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'sirfetch\'d' && message.content.toLowerCase() === 'sirfetchd')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'sirfetch\'d' && message.content.toLowerCase() === 'sirfetch’d')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'sirfetch\'d' && message.content.toLowerCase() === 'sirfetch‘d')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mr. rime' && message.content.toLowerCase() === 'mr rime')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mr. rime' && message.content.toLowerCase() === 'mr.rime')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'mr. rime' && message.content.toLowerCase() === 'mrrime')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'great tusk' && message.content.toLowerCase() === 'greattusk')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'scream tail' && message.content.toLowerCase() === 'screamtail')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'brute bonnet' && message.content.toLowerCase() === 'brutebonnet')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'flutter mane' && message.content.toLowerCase() === 'fluttermane')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'slither wing' && message.content.toLowerCase() === 'slitherwing')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'sandy shocks' && message.content.toLowerCase() === 'sandyshocks')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron treads' && message.content.toLowerCase() === 'irontreads')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron bundle' && message.content.toLowerCase() === 'ironbundle')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron hands' && message.content.toLowerCase() === 'ironhands')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron jugulis' && message.content.toLowerCase() === 'ironjugulis')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron moth' && message.content.toLowerCase() === 'ironmoth')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron thorns' && message.content.toLowerCase() === 'ironthorns')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'wo-chien' && message.content.toLowerCase() === 'wochien')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'wo-chien' && message.content.toLowerCase() === 'wo chien')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'chien-pao' && message.content.toLowerCase() === 'chienpao')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'chien-pao' && message.content.toLowerCase() === 'chien pao')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'ting-lu' && message.content.toLowerCase() === 'tinglu')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'ting-lu' && message.content.toLowerCase() === 'ting lu')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'chi-yu' && message.content.toLowerCase() === 'chiyu')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'chi-yu' && message.content.toLowerCase() === 'chi yu')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'roaring moon' && message.content.toLowerCase() === 'roaringmoon')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron valiant' && message.content.toLowerCase() === 'ironvaliant')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'walking wake' && message.content.toLowerCase() === 'walkingwake')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron leaves' && message.content.toLowerCase() === 'ironleaves')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'gouging fire' && message.content.toLowerCase() === 'gougingfire')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'raging bolt' && message.content.toLowerCase() === 'ragingbolt')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron boulder' && message.content.toLowerCase() === 'ironboulder')
				|| (activeDrops.get(`${serverId}_${message.channel.id}`).name.toLowerCase() === 'iron crown' && message.content.toLowerCase() === 'ironcrown'))) { //edge case
				
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					const curMon = activeDrops.get(`${serverId}_${message.channel.id}`);
					const userDropped = curMon.userThatDroppedID;
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
						let coinsToAdd = getRandomInt(21) + 5;
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
							genderSymbol = ' `♂\u200B`';//'♂️';
						}
						else if (gender === 'Female') {
							genderSymbol = ' `♀\u200B`';//'♀';
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
						
						dbUser.get("SELECT * FROM user WHERE user_id = ?", [userId], (err, row) => {
							if (err) {
								console.error(err.message);
								return;
							}
							if (!row) {
								// User isn't in the database, add them
								const messageText = isShinyVar
									? `Added ✨${formName}${curMonName}${genderSymbol} to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`
									: `Added ${formName}${curMonName}${genderSymbol} to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`;
							
								message.channel.send(messageText);

								dbUser.run("INSERT INTO user (user_id, caught_pokemon, currency, servers, totalCaught) VALUES (?, ?, ?, ?, ?)", [userId, JSON.stringify(shinyMon), coinsToAdd, JSON.stringify([serverId]), 1], (err) => {
									if (err) {
										console.error(err.message);
									}
									createQuestsForUserAndUpdate(message, userId, shinyMon[0]);
									activeDrops.delete(`${serverId}_${message.channel.id}`);
								});

							} 
							else {
								// User is in the database, update their caught Pokémon & currency
								
								if (userDropped === userId) {
									let acNum = row.acNum;
									acNum = acNum === 0 ? 1 : 2;
									coinsToAdd = coinsToAdd * acNum;
								}

								const messageText = isShinyVar
								? `Added ✨${formName}${curMonName}${genderSymbol} to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`
								: `Added ${formName}${curMonName}${genderSymbol} to ${userDisplayName}'s party! You gained ${coinsToAdd} coins for your catch.`;
						
								message.channel.send(messageText);

								const caughtPokemon = JSON.parse(row.caught_pokemon);
								let newList = caughtPokemon.concat(shinyMon);
								const newCurrency = row.currency + coinsToAdd;
								let serverList = JSON.parse(row.servers);
								const totalCaughtPokemon = row.totalCaught + 1;
								if (!serverList.includes(serverId)) {
									serverList.push(serverId);
								}
								dbUser.run("UPDATE user SET caught_pokemon = ?, currency = ?, servers = ?, totalCaught = ? WHERE user_id = ?", [JSON.stringify(newList), newCurrency, JSON.stringify(serverList), totalCaughtPokemon, userId], (err) => {
									if (err) {
										console.error(err.message);
									}
									updateQuestProgress(message, userId, shinyMon[0]);
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
							{ name: 'Add gen 7:', value: 'Added gen 7 pokemon and their items' },
							{ name: 'Add shop.db:', value: 'Changed pretty much nothing on user end but built a shop database and made it so specific pokemon commands work in .shop.' },
							{ name: 'Add .team:', value: 'Allows users to look at the first 6 of someone else\'s party.' },
							{ name: 'Add .compare:', value: 'Allows users to see what pokemon a user has compared to what they don\'t have.' },
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
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
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
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
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
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
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
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
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
							'Cobalion', 'Terrakion', 'Virizion', 'Tornadus', 'Thundurus', 'Reshiram', 'Zekrom', 'Landorus', 'Kyurem',
							'Xerneas', 'Yveltal', 'Zygarde',
							'Type: Null', 'Silvally', 'Tapu Koko', 'Tapu Lele', 'Tapu Bulu', 'Tapu Fini', 'Cosmog', 'Cosmoem', 'Solgaleo', 'Lunala', 'Necrozma',
							'Zacian', 'Zamazenta', 'Eternatus', 'Kubfu', 'Urshifu', 'Regieleki', 'Regidrago', 'Glastrier', 'Spectrier', 'Calyrex', 'Enamorus',
							'Wo-Chien', 'Chien-Pao', 'Ting-Lu', 'Chi-Yu', 'Koraidon', 'Miraidon', 'Walking Wake', 'Iron Leaves', 'Okidogi', 'Munkidori', 'Fezandipiti', 'Ogerpon', 'Gouging Fire',
							'Raging Bolt', 'Iron Boulder', 'Iron Crown', 'Terapagos'
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
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
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
							'Victini', 'Keldeo', 'Meloetta', 'Genesect',
							'Diancie', 'Hoopa', 'Volcanion',
							'Magearna', 'Marshadow', 'Zeraora', 'Meltan', 'Melmetal',
							'Zarude', 'Pecharunt'
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
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
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

					else if (args[0].toLowerCase() === 'ultrabeasts' || args[0].toLowerCase() === 'ultra' 
						|| args[0].toLowerCase() === 'ultrabeast' || args[0].toLowerCase() === 'ub') {
						//display mythical leaderboard
						let serverLb = false;
						if (args.length > 1 && args[1].toLowerCase() === 'server') {
							serverLb = true;
						}
						// Use in-memory data to make this call a lot faster
						const ultraBeastPokemon = [
							'Nihilego', 'Buzzwole', 'Pheromosa', 'Xurkitree', 'Celesteela', 'Kartana', 'Guzzlord', 'Poipole', 'Naganadel', 'Stakataka', 'Blacephalon'
						];
						dbUser.all("SELECT user_id, caught_pokemon, servers FROM user", [], async (err, rows) => {
							if (err) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the ultra beast leaderboard.');
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

								const ultraBeastCount = caughtPokemon.reduce((acc, pokemonName) => {
									if (typeof pokemonName === 'string') {
										let finalName = pokemonName.startsWith('✨') ? pokemonName.substring(1) : pokemonName;
										if (ultraBeastPokemon.includes(finalName)) {
											acc += 1;
										}
									}
									return acc;
								}, 0);

								return ultraBeastCount > 0 ? {
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
									value: ultraBeastCount
								} : null;
							}));

							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send(serverLb ? 'No users in this server have caught an ultra beast yet.' : 'No users have caught an ultra beast yet.');
								return;
							}
							filteredUsers.sort((a, b) => b.value - a.value);
							const leaderboardTitle = serverLb ? 'Server Ultra Beast Pokémon Leaderboard' : 'Ultra Beast Pokémon Leaderboard';
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
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
									value
								} : null;
							}));
							
							const filteredUsers = users.filter(user => user !== null);
							if (filteredUsers.length < 1) {
								message.channel.send(serverLb ? 'No users in this server have caught Pokémon yet.' : 'No users have caught Pokémon yet.');
								return;
							}
							filteredUsers.sort((a, b) => b.value - a.value);
							const leaderboardTitle = serverLb ? `Pokédex Completeness Server Leaderboard (/${maxDexNum})` : `Pokédex Completeness Leaderboard (/${maxDexNum})`;
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
									name: user ? getFixedName(user.username) : `User ID: ${row.user_id}`,
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

							let totalCaughtCount = inUser.length || 0;
	
							if (forms.length > 0) {
								if (forms[0].name.toLowerCase() !== 'default') {
									selectedForm = forms[0].name;
								}
								else {
									selectedForm = 'Default';
								}
							}
							let formSelectMenu = new Discord.StringSelectMenuBuilder()
								.setCustomId('formSelect')
								.setPlaceholder('Select a Form')
								.addOptions(
									forms.slice(0, 25).map(form => ({
										label: `${form.name} (${form.percentage}%)`,
										value: form.name,
									}))
								);
							
							let caughtCount = inUser.filter(pokemon => pokemon.form === selectedForm).length || 0;	
							let embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, totalCaughtCount, caughtCount);
	
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
													selectedForm = 'Default';
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
											totalCaughtCount = inUser.length || 0;
		
											formSelectMenu = new Discord.StringSelectMenuBuilder()
												.setCustomId('formSelect')
												.setPlaceholder('Select a Form')
												.addOptions(
													forms.slice(0, 25).map(form => ({
														label: `${form.name} (${form.percentage}%)`,
														value: form.name,
													}))
												);
		
											caughtCount = inUser.filter(pokemon => pokemon.form === selectedForm).length || 0;	
											embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, totalCaughtCount, caughtCount);
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
													selectedForm = 'Default';
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
											totalCaughtCount = inUser.length || 0;
	
											formSelectMenu = new Discord.StringSelectMenuBuilder()
												.setCustomId('formSelect')
												.setPlaceholder('Select a Form')
												.addOptions(
													forms.slice(0, 25).map(form => ({
														label: `${form.name} (${form.percentage}%)`,
														value: form.name,
													}))
												);
											caughtCount = inUser.filter(pokemon => pokemon.form === selectedForm).length || 0;	
											embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, totalCaughtCount, caughtCount);
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
	
											embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, totalCaughtCount, caughtCount);
											i.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(formSelectMenu), buttonRow] });
										}
										else if (i.customId === 'formSelect') {
											selectedForm = i.values[0];
											totalCaughtCount = inUser.length || 0;
											caughtCount = inUser.filter(pokemon => pokemon.form === selectedForm).length || 0;	
											embed = updateEmbed(shinyImg, curMon.dexNum, curMon, selectedForm, pokeList, genders, totalCaughtCount, caughtCount);
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
			
			//view
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

						const caughtPokemon = JSON.parse(row.caught_pokemon);

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

							if (formName.includes('Female') || formName.includes('Spiky-eared')) {
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
							let regionField = '';
							let genderSymbol = '';
							if (curForm.formFound) {
								type1Field = curForm.type1;
								type2Field = curForm.type2 ? ` / ${curForm.type2}` : '';
								regionField = curForm.region;
							}
							else {
								type1Field = defaultMon.type1;
								type2Field = defaultMon.type2 ? ` / ${defaultMon.type2}` : '';
								regionField = defaultMon.region;
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
										{ name: 'Region', value: `${regionField}`, inline: true }
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

											if (formName.includes('Female') || formName.includes('Spiky-eared')) {
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

											if (formName.includes('Female') || formName.includes('Spiky-eared')) {
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

						else if (args[0].toLowerCase() === 'ultrabeast' || args[0].toLowerCase() === 'ub' 
								|| args[0].toLowerCase() === 'ultra' || args[0].toLowerCase() === 'ultrabeasts') {
							const ultraBeastPokemon = [
								'Nihilego', 'Buzzwole', 'Pheromosa', 'Xurkitree', 'Celesteela', 'Kartana', 'Guzzlord', 'Poipole', 'Naganadel', 'Stakataka', 'Blacephalon'
							];
			
							const ultraBeastsCaught = caughtPokemon
								.map((pokemonObj, index) => {
									let pokemonName = pokemonObj.name;
			
									if (pokemonName.startsWith('✨')) {
										pokemonName = pokemonName.substring(1);
									}
			
									if (ultraBeastPokemon.includes(pokemonName)) {
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
								
							if (ultraBeastsCaught.length === 0) {
								message.channel.send("You do not have any legendary Pokémon.");
							}
							else {
								const pageSize = 20;
								let page = 0;
			
								const embed = generatePartyEmbed(ultraBeastsCaught, page, pageSize, `Your Ultra Beast Pokémon`, 4);
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
													page = Math.ceil(ultraBeastsCaught.length / pageSize) - 1;
												}
											} 
											else if (i.customId === 'next') {
												if ((page + 1) * pageSize < ultraBeastsCaught.length) {
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
												page = Math.ceil(ultraBeastsCaught.length / pageSize) - 1;
											}
			
											await i.update({ embeds: [generatePartyEmbed(ultraBeastsCaught, page, pageSize, `Your Ultra Beast Pokémon`, 4)] });
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
								'Cobalion', 'Terrakion', 'Virizion', 'Tornadus', 'Thundurus', 'Reshiram', 'Zekrom', 'Landorus', 'Kyurem',
								'Xerneas', 'Yveltal', 'Zygarde',
								'Type: Null', 'Silvally', 'Tapu Koko', 'Tapu Lele', 'Tapu Bulu', 'Tapu Fini', 'Cosmog', 'Cosmoem', 'Solgaleo', 'Lunala', 'Necrozma',
								'Zacian', 'Zamazenta', 'Eternatus', 'Kubfu', 'Urshifu', 'Regieleki', 'Regidrago', 'Glastrier', 'Spectrier', 'Calyrex', 'Enamorus',
								'Wo-Chien', 'Chien-Pao', 'Ting-Lu', 'Chi-Yu', 'Koraidon', 'Miraidon', 'Walking Wake', 'Iron Leaves', 'Okidogi', 'Munkidori', 'Fezandipiti', 'Ogerpon', 'Gouging Fire',
								'Raging Bolt', 'Iron Boulder', 'Iron Crown', 'Terapagos'
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
								'Victini', 'Keldeo', 'Meloetta', 'Genesect',
								'Diancie', 'Hoopa', 'Volcanion',
								'Magearna', 'Marshadow', 'Zeraora', 'Meltan', 'Melmetal',
								'Zarude', 'Pecharunt'
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
									.setTitle(`${tagName}'s Pokemon You Don't Own`)
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
					message.channel.send("You must @ a user to view their team.");
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

							const teamEmbed = generatePartyEmbed(partyArray, 0, 10, getFixedName(user.username) + `'s Team`, 0);
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
						if (pokemonToDisplay == null) {
							message.channel.send('User doesn\'t have a Pokemon in that slot!');
							return;
						}
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

							if (formName.includes('Female') || formName.includes('Spiky-eared')) {
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
									.setTitle(getFixedName(user.username) + `'s ${isShiny ? '✨' : ''}${formName}${defaultMon.name}${genderSymbol}`)
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

			//order //sort
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
										let name = pokemon.name;
										if (name === 'Nidoran') {
											if (pokemon.gender === 'Female') {
												name = 'Nidoran-Female';
											}
											else {
												name = 'Nidoran-Male';
											}
										}
										if (!countMap.has(name)) {
											countMap.set(name, { count: 0 });
										}
										let entry = countMap.get(name);
										entry.count += 1;
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

										let countA = countMap.get(a.name);
										let countB = countMap.get(b.name);

										//shiny
										if (a.name.startsWith('✨') && !b.name.startsWith('✨')) {
											return -1;
										}
										if (!a.name.startsWith('✨') && b.name.startsWith('✨')) {
											return 1;
										}

										//within shiny: count low to high -> mythical -> ultra beast -> legendary -> regular
										if (a.name.startsWith('✨') && b.name.startsWith('✨')) {
											//Order: Mythical (2), Ultra Beast (4), Legendary (1), Regular (0)
											const shinyOrder = { 2: 0, 4: 1, 1: 2, 0: 3 }; //mapping for shiny priority
											if (shinyOrder[dexA.isLM] !== shinyOrder[dexB.isLM]) {
												return shinyOrder[dexA.isLM] - shinyOrder[dexB.isLM];
											}
											if (countA.count !== countB.count) {
												return countA.count - countB.count;
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

										//ultra beast
										if (dexA.isLM === 4 && dexB.isLM !== 4) {
											return -1;
										}
										if (dexA.isLM !== 4 && dexB.isLM === 4) {
											return 1;
										}

										//within ultra beast: count low to high -> dex num -> alphabetical
										if (dexA.isLM === 4 && dexB.isLM === 4) {
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
					dbUser.get("SELECT currency, gold FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching your currency.');
							return;
						}
						if (!row) {
							message.channel.send('You have not earned any currency yet.');
						}
						else {
							message.channel.send(`You currently have ${row.currency} coins and ${row.gold} gold.`);
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
					const genies = [
						'Tornadus', 'Thundurus', 'Landorus', 'Enamorus'
					];

					const args = message.content.split(' ').slice(1);
					
					dbShop.all("SELECT * FROM shop", [], (error, shopItems) => {
						if (error) {
							console.error(err.message);
							message.channel.send('An error occurred while fetching the shop.');
							return;
						}
						if (!shopItems || shopItems.length === 0) {
							message.channel.send('There are no items in the shop database.');
							return;
						}

						let filteredItems;
						let shopHeader;
						let shopDescription;

						if (!args || args.length < 1 || args[0] === ' ') {
							const generalItemsMaxNum = 9;
							const generalItemsMinNum = 1;

							filteredItems = shopItems.filter(item => item.itemNum <= generalItemsMaxNum && item.itemNum >= generalItemsMinNum);
							shopHeader = 'General Shop';
							shopDescription = 'List of available items in the shop' + '\n' + 
									'Use the command .buy <shopNum> to purchase an item' + '\n' + 
									'For specific pokemon shops, use `.shop <pokemon>`' + '\n' + 
									'Current shops: `General`, `Mega`, and `<pokemon>` shops';
						}
						else if (args[0].toLowerCase() === 'mega') {
							const megaMinNum = 100;
							const megaMaxNum = 149;
							filteredItems = shopItems.filter(item => item.itemNum <= megaMaxNum && item.itemNum >= megaMinNum);
							shopHeader = 'Mega Stone Shop';
							shopDescription = 'List of available Mega Stone items in the shop' + '\n' + 
									'Use the command .buy <shopNum> to purchase an item';
						}
						else {
							let pokemonName = args[0].toLowerCase();
							pokemonName = capitalizeFirstLetter(pokemonName);
							pokemonName = fixPokemonName(pokemonName, args);
							if (genies.includes(pokemonName)) {
								let searchTerm = 'Genies';
								filteredItems = shopItems.filter(item => item.pokemon_usage === searchTerm);
							}
							else {
								filteredItems = shopItems.filter(item => item.pokemon_usage === pokemonName);
							}

							if (filteredItems.length === 0) {
								message.channel.send('There are no items available for this Pokemon.');
								return;
							}
							shopHeader = `${pokemonName} Shop`;
							if (filteredItems.filter(item => item.reusable === 2).length > 0) {
								shopDescription = `List of available ${pokemonName} items in the shop` + '\n' + 
										'Use the command .buy <shopNum> to purchase an item' + '\n' + 
										`You will get your item back if ${pokemonName} is no longer actively using it`;
							}
							else {
								shopDescription = `List of available ${pokemonName} items in the shop` + '\n' + 
										'Use the command .buy <shopNum> to purchase an item'
							}
							
						}

						const itemsPerPage = 5;
						const totalPages = Math.ceil(filteredItems.length / itemsPerPage);

						const generateShopEmbed = (page, header, description) => {
							const start = page * itemsPerPage;
							const end = start + itemsPerPage;
							const pageItems = filteredItems.slice(start, end);

							const embed = new EmbedBuilder()
								.setColor('#0099ff')
								.setTitle(`${header} (Page ${page + 1}/${totalPages})`)
								.setDescription(description)
								.setTimestamp();

							// Add each item to the embed
							pageItems.forEach(item => {
								embed.addFields({
									name: `\`${item.itemNum}:\` **${item.item_name} (${item.price})**`,
									value: `${item.explanation}`
								});
							});

							return embed;
						};

						let page = 0;
						const embed = generateShopEmbed(page, shopHeader, shopDescription);
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

						message.channel.send({ embeds: [embed], components: [buttonRow] }).then(sentMessage => {
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
									const updatedEmbed = generateShopEmbed(page, shopHeader, shopDescription);
									await i.update({ embeds: [updatedEmbed], components: [buttonRow] });
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
				});
			}

			//buy
			else if (buyCommandRegex.test(message.content.toLowerCase())) {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}
					//REMOVE WHEN PRICES ARE UPDATED
					// message.channel.send('Prices are currently being worked on! Check back again at a later time.');
					// return;
					const args = message.content.split(' ');
					if (args.length < 2) {
						message.channel.send('Please specify a valid shop number. Usage: `.buy <shopNum>`');
						return;
					}
					let shopNum = parseInt(args[1], 10);
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
						dbShop.all("SELECT * FROM shop", [], (error, shopItems) => {
							if (error) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the shop.');
								return;
							}
							if (!shopItems || shopItems.length === 0) {
								message.channel.send('There are no items in the shop database.');
								return;
							}

							let userCurrency = row.currency;
							let boughtItem = '';
							let amount = 0;

							const selectedItems = shopItems.filter(item => item.itemNum === shopNum);
							if (selectedItems.length === 0 || selectedItems.length > 1) {
								message.channel.send('Not a valid shop number!.');
								return;
							}
							
							const selectedItem = selectedItems[0];
							if (userCurrency >= selectedItem.price * quantityNum) {
								userCurrency -= (selectedItem.price * quantityNum);
								boughtItem = selectedItem.item_name;
								amount = selectedItem.price;
							}
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
												let userInventory = JSON.parse(row.inventory);
												let foundFlag = false;
												for (let i = 0; i < userInventory.length; i++) {
													if (userInventory[i].includes(boughtItem)) {
														foundFlag = true;
														
														let parts = userInventory[i].split('(x');
														let count = parseInt(parts[1]) || 0;

														count += quantityNum;
														userInventory[i] = `${boughtItem} (x${count})`;
														break;
													}
												}

												if (!foundFlag) {
													userInventory.push(`${boughtItem} (x${quantityNum})`);
												}

												const newTotalSpent = row.totalSpent + (quantityNum * amount);
												dbUser.run("UPDATE user SET inventory = ?, currency = ?, totalSpent = ? WHERE user_id = ?", [JSON.stringify(userInventory), userCurrency, newTotalSpent, userId], (err) => {
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

			//trash, TODO!!!
			else if (message.content.startsWith('.trash') && userId === '177580797165961216') {
				isChannelAllowed(serverId, message.channel.id, (allowed) => {
					if (!allowed) {
						return;
					}

					const args = message.content.split(' ').slice(1);
					let itemNum = parseInt(args[0], 10);
					dbUser.get("SELECT inventory FROM user WHERE user_id = ?", [userId], (err, row) => {
						if (err) {
							console.error(err.message);
							return;
						}
						if (!row) {
							message.channel.send('User has not caught a pokemon yet.');
							return;
						}
						let inventoryArr = JSON.parse(row.inventory).flat();
						inventoryArr.splice(itemNum - 1, 1);
						dbUser.run("UPDATE user SET inventory = ? WHERE user_id = ?", [JSON.stringify(inventoryArr), userId], (err) => {
							if (err) {
								console.error('Error updating user inventory and caught pokemon:', err.message);
								return;
							}
							message.channel.send('Trashed that item.')
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
					//For pokemon that aren't mega/gigantamax that can transfer back
					const defaultList = [
						'Kyogre', 'Groudon', 'Rayquaza',
						'Rotom', 'Shaymin', 'Arceus',
						'Tornadus', 'Thundurus', 'Landorus',
						'Kyurem',
						'Furfrou', 'Hoopa',
						'Silvally', 'Necrozma',
						'Enamorus', 'Alcremie', 'Zacian', 'Zamazenta',
						'Ogerpon'
					];
					const geniesList = [
						'Tornadus', 'Thundurus', 'Landorus', 'Enamorus'
					];
					const gigantamaxList = [
						'Venusaur', 'Charizard', 'Blastoise', 'Butterfree', 'Pikachu', 'Meowth', 'Machamp', 'Gengar', 'Kingler', 'Lapras', 'Eevee', 'Snorlax', 'Garbodor',
						'Melmetal',
						'Rillaboom', 'Cinderace', 'Inteleon', 'Corviknight', 'Orbeetle', 'Drednaw', 'Coalossal', 'Flapple', 'Appletun', 'sandaconda', 'Toxtricity',
						'Centiskorch', 'Hatterene', 'Grimmsnarl', 'Alcremie', 'Copperajah', 'Duraludon', 'Urshifu'
					];

					const args = message.content.split(' ').slice(1);

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

						dbShop.all("SELECT * FROM shop", [], (error, shopItems) => {
							if (error) {
								console.error(err.message);
								message.channel.send('An error occurred while fetching the shop.');
								return;
							}
							if (!shopItems) {
								message.channel.send('There are no items in the shop database.');
								return;
							}

							let itemNum;
							if (args.length > 0) {
								itemNum = parseInt(args[0], 10);
							}
							else {
								message.channel.send('Improper command usage, you must supply an item number! Usage: `.use <itemNum> <partyNum>`');
								return;
							}
							if (isNaN(itemNum)) {
								message.channel.send('Improper command usage. Usage: `.use <itemNum> <partyNum>`');
								return;
							}
							if (itemNum < 1 || itemNum > inventoryArr.length) {
								message.channel.send('Improper command usage: You have no pokemon in that party slot!');
								return;
							}

							let selectedItem = inventoryArr[itemNum - 1];
							let parts = selectedItem.split(' (x');
							let itemCount = parseInt(parts[1]) || 0;
							selectedItem = parts[0];

							const itemRowArr = shopItems.filter(shopItem => shopItem.item_name === selectedItem).flat();
							const itemRow = itemRowArr[0];
							//CHECK
							//TODO: delete this check in the future, just a failsafe
							if (itemRow.length > 1) {
								message.channel.send('Came across a bug in using items, sorry for the inconvenience.');
								return;
							}

							if (itemRow.item_class === 0) {
								if (itemRow.reusable === 0) {
									// use and delete
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

									if (itemRow.item_name.includes('Repel')) {
										if (standardRepel) {
											message.channel.send('You must use your currently equipped repel before activating a new one.');
											return;
										}
										activeUserRepels.set(userId, { standard: itemRow.item_name, rare: rareRepel });
										if (itemCount === 1) {
											inventoryArr.splice(itemNum - 1, 1);
										}
										else {
											inventoryArr[itemNum - 1] = `${selectedItem} (x${itemCount - 1})`;
										}
									}
									else if (itemRow.item_name.includes('Incense')) {
										if (rareRepel) {
											message.channel.send('You must use your currently equipped incense before activating a new one.');
											return;
										}
										activeUserRepels.set(userId, { standard: standardRepel, rare: itemRow.item_name });
										if (itemCount === 1) {
											inventoryArr.splice(itemNum - 1, 1);
										}
										else {
											inventoryArr[itemNum - 1] = `${selectedItem} (x${itemCount - 1})`;
										}
									}
									else {
										message.channel.send('Could not use selected item, this might not be implemented yet!');
										return;
									}
									dbUser.run("UPDATE user SET inventory = ? WHERE user_id = ?", [JSON.stringify(inventoryArr), userId], (err) => {
										if (err) {
											console.error('Error updating user inventory:', err.message);
											return;
										}
										message.channel.send(`${selectedItem} Activated.`);
									});
								}
								else if (itemRow.reusable === 1) {
									//just use, do not delete the item
									//TODO?
								}
							}
							else if (itemRow.item_class === 1) {
								let partyNum;
								if (args.length > 1) {
									partyNum = parseInt(args[1], 10);
								}
								else {
									message.channel.send('Improper command usage, you must supply a party number! Usage: `.use <itemNum> <partyNum>`');
									return;
								}
								if (isNaN(partyNum)) {
									message.channel.send('Improper command usage. Usage: `.use <itemNum> <partyNum>`');
									return;
								}
								if (partyNum < 1 || partyNum > pokemonArr.length) {
									message.channel.send('Improper command usage: You have no pokemon in that party slot!');
									return;
								}
								const selectedMon = pokemonArr[partyNum - 1];
								if (itemRow.pokemon_usage === selectedMon.name) {
									let oldItem = null;
									if (itemRow.reusable === 2 && selectedMon.form !== 'Default') {
										const oldItemRow = shopItems
											.filter(shopItem => 
												shopItem.new_form === selectedMon.form 
												&& shopItem.reusable === 2
												&& shopItem.pokemon_usage === selectedMon.name);
										//CHECK
										//TODO: delete this check in the future, just a failsafe
										if (oldItemRow.length > 1) {
											message.channel.send('Came across a bug in using items, sorry for the inconvenience.');
											return;
										}
										if (oldItemRow.length === 1) {
											oldItem = oldItemRow[0].item_name;
										}
									}
									if (itemRow.itemNum === 558 && !(selectedMon.form === 'Dusk Mane' || selectedMon.form === 'Dawn Wings')) {
										message.channel.send('This item requires Dusk Mane or Dawn Wings form to use!');
										return;
									}
									let oldPokemon = {
										name: pokemonArr[partyNum - 1].name,
										form: pokemonArr[partyNum - 1].form,
										gender: pokemonArr[partyNum - 1].gender
									};
									pokemonArr[partyNum - 1].form = itemRow.new_form;
									let newPokemon = {
										name: pokemonArr[partyNum - 1].name,
										form: pokemonArr[partyNum - 1].form,
										gender: pokemonArr[partyNum - 1].gender
									};
									
									if (itemRow.reusable !== 1) {
										//inventoryArr.splice(itemNum - 1, 1);
										if (itemCount === 1) {
											inventoryArr.splice(itemNum - 1, 1);
										}
										else {
											inventoryArr[itemNum - 1] = `${selectedItem} (x${itemCount - 1})`;
										}
									}
									if (oldItem) {
										//inventoryArr = inventoryArr.concat(oldItem);
										let foundFlag = false;
										for (let i = 0; i < inventoryArr.length; i++) {
											if (inventoryArr[i].includes(oldItem)) {
												foundFlag = true;
												
												let parts = inventoryArr[i].split(' (x');
												let count = parseInt(parts[1]) || 0;

												count += 1;
												inventoryArr[i] = `${oldItem} (x${count})`;
												break;
											}
										}

										if (!foundFlag) {
											inventoryArr.push(`${oldItem} (x1)`);
										}
									}
									dbUser.run("UPDATE user SET caught_pokemon = ?, inventory = ? WHERE user_id = ?", [JSON.stringify(pokemonArr), JSON.stringify(inventoryArr), userId], async (err) => {
										if (err) {
											console.error('Error updating user inventory and caught pokemon:', err.message);
											return;
										}
										await updateReleaseQuestProgress(message, userId, oldPokemon);

										updateQuestProgress(message, userId, newPokemon);
										message.channel.send('Transformation Successful.')
									});
								}
								else if (itemRow.pokemon_usage === 'Form_All') {
									if (defaultList.includes(selectedMon.name) 
										|| selectedMon.form.startsWith('Mega')
										|| selectedMon.form.includes('Gigantamax')) {
										let oldItem = null;
										const oldItemRow = shopItems
											.filter(shopItem => 
												shopItem.new_form === selectedMon.form 
												&& shopItem.reusable === 2 
												&& shopItem.pokemon_usage === selectedMon.name);
										//CHECK
										//TODO: delete this check in the future, just a failsafe
										if (oldItemRow.length > 1) {
											message.channel.send('Came across a bug in using items, sorry for the inconvenience.');
											return;
										}
										if (oldItemRow.length === 1) {
											oldItem = oldItemRow[0].item_name;
										}

										let oldPokemon = {
											name: pokemonArr[partyNum - 1].name,
											form: pokemonArr[partyNum - 1].form,
											gender: pokemonArr[partyNum - 1].gender
										};
										
										if (selectedMon.name === 'Shaymin') {
											pokemonArr[partyNum - 1].form = 'Land Forme';
										}
										else if (selectedMon.name === 'Tornadus' || selectedMon.name === 'Thundurus' || selectedMon.name === 'Landorus' || selectedMon.name === 'Enamorus') {
											pokemonArr[partyNum - 1].form = 'Incarnate';
										}
										else if (selectedMon.name === 'Hoopa') {
											pokemonArr[partyNum - 1].form = 'Confined';
										}
										else if (selectedMon.name === 'Alcremie') {
											pokemonArr[partyNum - 1].form = 'Strawberry Vanilla Cream';
										}
										else if (selectedMon.name === 'Toxtricity') {
											if (selectedMon.form === 'Amped Gigantamax') {
												pokemonArr[partyNum - 1].form = 'Amped';
											}
											else if (selectedMon.form === 'Low Key Gigantamax') {
												pokemonArr[partyNum - 1].form = 'Low Key';
											}
											else {
												message.channel.send('Could not use selected item on selected pokemon.');
												return;
											}
										}
										else if (selectedMon.name === 'Urshifu') {
											if (selectedMon.form === 'Single Strike Gigantamax') {
												pokemonArr[partyNum - 1].form = 'Single Strike';
											}
											else if (selectedMon.form === 'Rapid Strike Gigantamax') {
												pokemonArr[partyNum - 1].form = 'Rapid Strike';
											}
											else {
												message.channel.send('Could not use selected item on selected pokemon.');
												return;
											}
										}
										else if (selectedMon.name === 'Ogerpon') {
											pokemonArr[partyNum - 1].form = 'Teal';
										}

										else {
											pokemonArr[partyNum - 1].form = itemRow.new_form;
										}
										let newPokemon = {
											name: pokemonArr[partyNum - 1].name,
											form: pokemonArr[partyNum - 1].form,
											gender: pokemonArr[partyNum - 1].gender
										};

										if (oldItem) {
											//inventoryArr = inventoryArr.concat(oldItem);
											let foundFlag = false;
											for (let i = 0; i < inventoryArr.length; i++) {
												if (inventoryArr[i].includes(oldItem)) {
													foundFlag = true;
													
													let parts = inventoryArr[i].split(' (x');
													let count = parseInt(parts[1]) || 0;

													count += 1;
													inventoryArr[i] = `${oldItem} (x${count})`;
													break;
												}
											}

											if (!foundFlag) {
												inventoryArr.push(`${oldItem} (x1)`);
											}
										}
										dbUser.run("UPDATE user SET caught_pokemon = ?, inventory = ? WHERE user_id = ?", [JSON.stringify(pokemonArr), JSON.stringify(inventoryArr), userId], async (err) => {
											if (err) {
												console.error('Error updating user inventory and caught pokemon:', err.message);
												return;
											}
											await updateReleaseQuestProgress(message, userId, oldPokemon);

											updateQuestProgress(message, userId, newPokemon);
											message.channel.send('Transformation Successful.')
										});
									}
								}
								else if (itemRow.pokemon_usage === 'Genies') {
									if (geniesList.includes(selectedMon.name)) {
										let oldPokemon = {
											name: pokemonArr[partyNum - 1].name,
											form: pokemonArr[partyNum - 1].form,
											gender: pokemonArr[partyNum - 1].gender
										};
										pokemonArr[partyNum - 1].form = itemRow.new_form;
										let newPokemon = {
											name: pokemonArr[partyNum - 1].name,
											form: pokemonArr[partyNum - 1].form,
											gender: pokemonArr[partyNum - 1].gender
										};
										dbUser.run("UPDATE user SET caught_pokemon = ?, inventory = ? WHERE user_id = ?", [JSON.stringify(pokemonArr), JSON.stringify(inventoryArr), userId], async (err) => {
											if (err) {
												console.error('Error updating user inventory and caught pokemon:', err.message);
												return;
											}
											await updateReleaseQuestProgress(message, userId, oldPokemon);

											updateQuestProgress(message, userId, newPokemon);
											message.channel.send('Transformation Successful.')
										});
									}
									else {
										message.channel.send('Could not use selected item on selected pokemon.');
										return;
									}
								}
								else if (itemRow.pokemon_usage === 'Gigantamax') {
									if (gigantamaxList.includes(selectedMon.name)) {
										let oldPokemon = {
											name: pokemonArr[partyNum - 1].name,
											form: pokemonArr[partyNum - 1].form,
											gender: pokemonArr[partyNum - 1].gender
										};
										if (selectedMon.name === 'Toxtricity') {
											if (selectedMon.form === 'Amped') {
												pokemonArr[partyNum - 1].form = 'Amped Gigantamax';
											}
											else {
												pokemonArr[partyNum - 1].form = 'Low Key Gigantamax';
											}
										}
										else if (selectedMon.name === 'Urshifu') {
											if (selectedMon.form === 'Single Strike') {
												pokemonArr[partyNum - 1].form = 'Single Strike Gigantamax';
											}
											else  {
												pokemonArr[partyNum - 1].form = 'Rapid Strike Gigantamax';
											}
										}
										else if (selectedMon.name === 'Meowth') {
											if (selectedMon.form === 'Default') {
												pokemonArr[partyNum - 1].form = 'Gigantamax';
											}
											else {
												message.channel.send('Could not use selected item on selected pokemon.');
												return;
											}
										}
										else if (selectedMon.name === 'Slowbro') {
											if (selectedMon.form === 'Default') {
												pokemonArr[partyNum - 1].form = 'Mega';
											}
											else {
												message.channel.send('Could not use selected item on selected pokemon.');
												return;
											}
										}
										else {
											pokemonArr[partyNum - 1].form = 'Gigantamax';
										}
										let newPokemon = {
											name: pokemonArr[partyNum - 1].name,
											form: pokemonArr[partyNum - 1].form,
											gender: pokemonArr[partyNum - 1].gender
										};
										dbUser.run("UPDATE user SET caught_pokemon = ?, inventory = ? WHERE user_id = ?", [JSON.stringify(pokemonArr), JSON.stringify(inventoryArr), userId], async (err) => {
											if (err) {
												console.error('Error updating user inventory and caught pokemon:', err.message);
												return;
											}
											await updateReleaseQuestProgress(message, userId, oldPokemon);

											updateQuestProgress(message, userId, newPokemon);
											message.channel.send('Transformation Successful.')
										});
									}
									else {
										message.channel.send('Could not use selected item on selected pokemon.');
										return;
									}
								}
								else {
									message.channel.send('Could not use selected item on selected pokemon.');
									return;
								}
							}
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
					const helpPages = [
					 new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Help (Page 1/4)')
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
						.setTitle('Help (Page 2/4)')
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
						.setTitle('Help (Page 3/4)')
						.setDescription('List of available commands:')
						.addFields(
							{ name: '.uncaught (.u)', value: 'Displays a list of your uncaught pokémon' },
							{ name: '.release <partyNum> (.r)', value: 'Releases a Pokémon from your party.' + '\n' + 'Example: .release 1' },
							{ name: '.trade @<user> (.t)', value: 'Initiates a trade with another user.' },
							{ name: '.count', value: 'Displays the amount of each pokémon you\'ve caught.'},
							{ name: '.leaderboard (.lb)', value: 'Display a leaderboard.' + '\n' + 'Usages: .lb currency *|* .lb shiny *|* .lb legendary *|* .lb mythical *|* .lb pokedex *|* .lb {pokémon}' },
							{ name: '.remind', value: 'Reminds you when your drop is off cooldown.'},
						)
						.setTimestamp(),
					new EmbedBuilder()
						.setColor('#0099ff')
						.setTitle('Help (Page 4/4)')
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
						//regex \.-: and ' '
						while (numLetters / monLength < 0.5) {
							const randomInt = getRandomInt(monLength);
							let letter = curMonHint[randomInt];
							if (!(letter === '_' || letter === '\'' || letter === '.'
								|| letter === '-' || letter === ':' || letter === ' ')) {
									curMonHint = curMonHint.replaceAt(randomInt, '_');
									numLetters++;
							}
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
										let oldPokemon = caughtPokemon[index];
										caughtPokemon.splice(index, 1);
										dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(caughtPokemon), userId], async (err) => {
										if (err) {
											console.error(err.message);
										}
										await updateReleaseQuestProgress(message, userId, oldPokemon);
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
											dbUser.run("UPDATE user SET caught_pokemon = ? WHERE user_id = ?", [JSON.stringify(user2Pokemon), trade.user2], async (err) => {
												if (err) {
													console.error(err.message);
													return;
												}
												await updateReleaseQuestProgress(message, trade.user1, user1TradedPokemon);
												await updateReleaseQuestProgress(message, trade.user2, user2TradedPokemon);

												updateQuestProgress(message, trade.user1, user2TradedPokemon);
												updateQuestProgress(message, trade.user2, user1TradedPokemon);

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