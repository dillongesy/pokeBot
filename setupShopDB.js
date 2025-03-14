const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./shop.db');

db.serialize(() => {
	db.run("CREATE TABLE IF NOT EXISTS shop (id INTEGER PRIMARY KEY, itemNum INTEGER, item_name TEXT, item_class INTEGER, pokemon_usage TEXT, new_form TEXT, reusable INTEGER, price INTEGER, drop_class TEXT, drop_rate DOUBLE, explanation TEXT)");

	const stmt = db.prepare("INSERT INTO shop (itemNum, item_name, item_class, pokemon_usage, new_form, reusable, price, drop_class, drop_rate, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

	//item_class: 0: items for general use
	//item_class: 1: items for pokemon
	//item_class: 2: instantly used items (amulet coin, cd reducers)
	
	//reusable: 0: no
	//reusable: 1: yes
	//reusable: 2: no, but get item back when form !default (aka "held" item)
	
	//0 = 1 = 15
	//330 min = 67 catches = 1000 coins
	//495 min = 100 catches = 1500 coins
	//830 min = 167 catches = 2500 coins
	//27 hours = 334 catches = 5000 coins
	//24 hours = 288 catches = 4320 coins
	//36 hours = 432 catcehs = 6480 coins
	// 7500
	//2.3 days = 667 catches = 10000 coins
	//6 days = 1728 catches = 25920 coins
	//11.5 days = 3334 catches = 50000
	
	const common = 70 / 15;
	const rare = 22 / 2;
	const epic = 7 / 3;
	const ssr = 1 / 1;
	
	const shopItems = [
		{ itemNum: 1, item_name: 'Normal Repel', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1000, drop_class: 'common', drop_rate: common, explanation: 'Has a 50% chance to drop an uncaught Pokemon' },
		{ itemNum: 2, item_name: 'Super Repel', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 2750, drop_class: 'rare', drop_rate: rare, explanation: 'Has a 75% chance to drop an uncaught Pokemon' },
		{ itemNum: 3, item_name: 'Max Repel', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 5000, drop_class: 'rare', drop_rate: rare, explanation: 'Has a 90% chance to drop an uncaught Pokemon' },
		{ itemNum: 4, item_name: 'Ultra Beast Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 5000, drop_class: 'epic', drop_rate: epic, explanation: 'Makes your next pokemon drop a legendary pokemon' + '\n' + '__It is recommended to do this in a private place!__' },
		{ itemNum: 5, item_name: 'Legendary Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 5000, drop_class: 'epic', drop_rate: epic, explanation: 'Makes your next pokemon drop a legendary pokemon' + '\n' + '__It is recommended to do this in a private place!__' },
		{ itemNum: 6, item_name: 'Mythical Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 7500, drop_class: 'epic', drop_rate: epic, explanation: 'Makes your next pokemon drop a mythical pokemon' + '\n' + '__It is recommended to do this in a private place!__' },
		{ itemNum: 7, item_name: 'Shiny Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 20000, drop_class: 'ssr', drop_rate: ssr, explanation: 'Makes your next pokemon drop a shiny pokemon' + '\n' + '__It is recommended to do this in a private place!__' },
		
		{ itemNum: 8, item_name: 'Defaulter', item_class: 1, pokemon_usage: 'Form_All', new_form: 'Default', reusable: 1, price: 500,  drop_class: null, drop_rate: 0, explanation: '**REUSABLE**: Resets the Pokemon\'s form to default' }, //Form_All
		{ itemNum: 9, item_name: 'Dynamax Band', item_class: 1, pokemon_usage: 'Gigantamax', new_form: 'Gigantamax', reusable: 1, price: 1000,  drop_class: null, drop_rate: 0, explanation: '**REUSABLE**: Evolves the Pokemon into their Gigantamax form' }, //Gigantamax
		{ itemNum: 10, item_name: 'Kanto Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop a Kanto pokemon' },
		{ itemNum: 11, item_name: 'Johto Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop a Johto pokemon' },
		{ itemNum: 12, item_name: 'Hoenn Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop a Hoenn pokemon' },
		{ itemNum: 13, item_name: 'Sinnoh Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop a Sinnoh pokemon' },
		{ itemNum: 14, item_name: 'Unova Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop a Unova pokemon' },
		{ itemNum: 15, item_name: 'Kalos Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop a Kalos pokemon' },
		{ itemNum: 16, item_name: 'Alola Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop an Alola pokemon' },
		{ itemNum: 17, item_name: 'Galar & Hisui Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop a Kanto pokemon' },
		{ itemNum: 18, item_name: 'Paldea Incense', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1250,  drop_class: 'common', drop_rate: common / 9, explanation: 'Makes your next pokemon drop a Paldea pokemon' },

		//Mega Evolution Store
		{ itemNum: 100, item_name: 'Venusaurite', item_class: 1, pokemon_usage: 'Venusaur', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Venusaur transformation' },
		{ itemNum: 101, item_name: 'Charizardite X', item_class: 1, pokemon_usage: 'Charizard', new_form: 'Mega X', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Charizard transformation' },
		{ itemNum: 102, item_name: 'Charizardite Y', item_class: 1, pokemon_usage: 'Charizard', new_form: 'Mega Y', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Charizard transformation' },
		{ itemNum: 103, item_name: 'Blastoisinite', item_class: 1, pokemon_usage: 'Blastoise', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Blastoise transformation' },
		{ itemNum: 104, item_name: 'Beedrillite', item_class: 1, pokemon_usage: 'Beedrill', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Beedrill transformation' },
		{ itemNum: 105, item_name: 'Pidgeotite', item_class: 1, pokemon_usage: 'Pidgeot', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Pidgeot transformation' },
		{ itemNum: 106, item_name: 'Alakazite', item_class: 1, pokemon_usage: 'Alakazam', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Alakazam transformation' },
		{ itemNum: 107, item_name: 'Slowbronite', item_class: 1, pokemon_usage: 'Slowbro', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Slowbro transformation' },
		{ itemNum: 108, item_name: 'Gengarite', item_class: 1, pokemon_usage: 'Gengar', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Gengar transformation' },
		{ itemNum: 109, item_name: 'Kangaskhanite', item_class: 1, pokemon_usage: 'Kangaskhan', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Kangaskhan transformation' },
		{ itemNum: 110, item_name: 'Pinsirite', item_class: 1, pokemon_usage: 'Pinsir', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Pinsir transformation' },
		{ itemNum: 111, item_name: 'Gyaradosite', item_class: 1, pokemon_usage: 'Gyarados', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Gyarados transformation' },
		{ itemNum: 112, item_name: 'Aerodactylite', item_class: 1, pokemon_usage: 'Aerodactyl', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Aerodactyl transformation' },
		{ itemNum: 113, item_name: 'Mewtwonite X', item_class: 1, pokemon_usage: 'Mewtwo', new_form: 'Mega X', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Mewtwo transformation' },
		{ itemNum: 114, item_name: 'Mewtwonite Y', item_class: 1, pokemon_usage: 'Mewtwo', new_form: 'Mega Y', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Mewtwo transformation' },
		{ itemNum: 115, item_name: 'Ampharosite', item_class: 1, pokemon_usage: 'Ampharos', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Ampharos transformation' },
		{ itemNum: 116, item_name: 'Steelixite', item_class: 1, pokemon_usage: 'Steelix', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Steelix transformation' },
		{ itemNum: 117, item_name: 'Scizorite', item_class: 1, pokemon_usage: 'Scizor', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Scizor transformation' },
		{ itemNum: 118, item_name: 'Heracronite', item_class: 1, pokemon_usage: 'Heracross', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Heracross transformation' },
		{ itemNum: 119, item_name: 'Houndoominite', item_class: 1, pokemon_usage: 'Houndoom', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Houndoom transformation' },
		{ itemNum: 120, item_name: 'Tyranitarite', item_class: 1, pokemon_usage: 'Tyranitar', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Tyranitar transformation' },
		{ itemNum: 121, item_name: 'Sceptilite', item_class: 1, pokemon_usage: 'Sceptile', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Sceptile transformation' },
		{ itemNum: 122, item_name: 'Blazikenite', item_class: 1, pokemon_usage: 'Blaziken', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Blaziken transformation' },
		{ itemNum: 123, item_name: 'Swampertite', item_class: 1, pokemon_usage: 'Swampert', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Swampert transformation' },
		{ itemNum: 124, item_name: 'Gardevoirite', item_class: 1, pokemon_usage: 'Gardevoir', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Gardevoir transformation' },
		{ itemNum: 125, item_name: 'Sablenite', item_class: 1, pokemon_usage: 'Sableye', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Sableye transformation' },
		{ itemNum: 126, item_name: 'Mawilite', item_class: 1, pokemon_usage: 'Mawile', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Mawile transformation' },
		{ itemNum: 127, item_name: 'Aggronite', item_class: 1, pokemon_usage: 'Aggron', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Aggron transformation' },
		{ itemNum: 128, item_name: 'Medichamite', item_class: 1, pokemon_usage: 'Medicham', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Medicham transformation' },
		{ itemNum: 129, item_name: 'Manectite', item_class: 1, pokemon_usage: 'Manectric', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Manectric transformation' },
		{ itemNum: 130, item_name: 'Sharpedonite', item_class: 1, pokemon_usage: 'Sharpedo', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Sharpedo transformation' },
		{ itemNum: 131, item_name: 'Camperuptite', item_class: 1, pokemon_usage: 'Camerupt', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Camerupt transformation' },
		{ itemNum: 132, item_name: 'Altarianite', item_class: 1, pokemon_usage: 'Altaria', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Altaria transformation' },
		{ itemNum: 133, item_name: 'Banettite', item_class: 1, pokemon_usage: 'Banette', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Banette transformation' },
		{ itemNum: 134, item_name: 'Absolite', item_class: 1, pokemon_usage: 'Absol', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Absol transformation' },
		{ itemNum: 135, item_name: 'Glalitite', item_class: 1, pokemon_usage: 'Glalie', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Glalie transformation' },
		{ itemNum: 136, item_name: 'Salamencite', item_class: 1, pokemon_usage: 'Salamence', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Salamence transformation' },
		{ itemNum: 137, item_name: 'Metagrossite', item_class: 1, pokemon_usage: 'Metagross', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Metagross transformation' },
		{ itemNum: 138, item_name: 'Latiasite', item_class: 1, pokemon_usage: 'Latias', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Latias transformation' },
		{ itemNum: 139, item_name: 'Latiosite', item_class: 1, pokemon_usage: 'Latios', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Latios transformation' },
		{ itemNum: 140, item_name: 'Lopunnite', item_class: 1, pokemon_usage: 'Lopunny', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Lopunny transformation' },
		{ itemNum: 141, item_name: 'Garchompite', item_class: 1, pokemon_usage: 'Garchomp', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Garchomp transformation' },
		{ itemNum: 142, item_name: 'Lucarionite', item_class: 1, pokemon_usage: 'Lucario', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Lucario transformation' },
		{ itemNum: 143, item_name: 'Abomasite', item_class: 1, pokemon_usage: 'Abomasnow', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Abomasnow transformation' },
		{ itemNum: 144, item_name: 'Galladite', item_class: 1, pokemon_usage: 'Gallade', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Gallade transformation' },
		{ itemNum: 145, item_name: 'Audinite', item_class: 1, pokemon_usage: 'Audino', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Audino transformation' },
		{ itemNum: 146, item_name: 'Diancite', item_class: 1, pokemon_usage: 'Diancie', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Diancie transformation' },
		{ itemNum: 147, item_name: 'Blue Orb', item_class: 1, pokemon_usage: 'Kyogre', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Kyogre transformation' },
		{ itemNum: 148, item_name: 'Red Orb', item_class: 1, pokemon_usage: 'Groudon', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50, explanation: '**CONSUMABLE**: Mega Stone for Groudon transformation' },
		{ itemNum: 149, item_name: 'Meteorite', item_class: 1, pokemon_usage: 'Rayquaza', new_form: 'Mega', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 50 / 50, explanation: '**CONSUMABLE**: Mega Stone for Rayquaza transformation' },
		
		//Rotom Store
		{ itemNum: 500, item_name: 'Stove', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Heat', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 5, explanation: '**CONSUMABLE**: Stove for Rotom transformation' },
		{ itemNum: 501, item_name: 'Washing Machine', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Wash', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 5, explanation: '**CONSUMABLE**: Washing Machine for Rotom transformation' },
		{ itemNum: 502, item_name: 'Fridge', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Frost', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 5, explanation: '**CONSUMABLE**: Stove for Rotom transformation' },
		{ itemNum: 503, item_name: 'Fan', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Fan', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 5, explanation: '**CONSUMABLE**: Stove for Rotom transformation' },
		{ itemNum: 504, item_name: 'Lawn Mower', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Mow', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 5, explanation: '**CONSUMABLE**: Stove for Rotom transformation' },
		
		//Shaymin Store
		{ itemNum: 505, item_name: 'Gracidea Flower', item_class: 1, pokemon_usage: 'Shaymin', new_form: 'Sky Forme', reusable: 1, price: 1000, drop_class: null, drop_rate: 0, explanation: '**REUSABLE**: Flower for Shaymin Skye Forme transformation' },
		
		//Arceus Store
		{ itemNum: 506, item_name: 'Fist Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Fist', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Fist plate for Arceus transformation' },
		{ itemNum: 507, item_name: 'Sky Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Sky', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Sky plate for Arceus transformation' },
		{ itemNum: 508, item_name: 'Toxic Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Toxic', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Toxic plate for Arceus transformation' },
		{ itemNum: 509, item_name: 'Earth Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Earth', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Earth plate for Arceus transformation' },
		{ itemNum: 510, item_name: 'Stone Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Stone', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Stone plate for Arceus transformation' },
		{ itemNum: 511, item_name: 'Insect Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Insect', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Insect plate for Arceus transformation' },
		{ itemNum: 512, item_name: 'Spooky Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Spooky', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Spooky plate for Arceus transformation' },
		{ itemNum: 513, item_name: 'Iron Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Iron', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Iron plate for Arceus transformation' },
		{ itemNum: 514, item_name: 'Flame Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Flame', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Flame plate for Arceus transformation' },
		{ itemNum: 515, item_name: 'Splash Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Splash', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Splash plate for Arceus transformation' },
		{ itemNum: 516, item_name: 'Meadow Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Meadow', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Meadow plate for Arceus transformation' },
		{ itemNum: 517, item_name: 'Zap Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Zap', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Zap plate for Arceus transformation' },
		{ itemNum: 518, item_name: 'Mind Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Mind', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Mind plate for Arceus transformation' },
		{ itemNum: 519, item_name: 'Icicle Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Icicle', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Icicle plate for Arceus transformation' },
		{ itemNum: 520, item_name: 'Draco Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Draco', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Draco plate for Arceus transformation' },
		{ itemNum: 521, item_name: 'Dread Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Dread', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Dread plate for Arceus transformation' },
		{ itemNum: 522, item_name: 'Pixie Plate', item_class: 1, pokemon_usage: 'Arceus', new_form: 'Pixie', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Pixie plate for Arceus transformation' },
		
		//Tornadus/Thundurus/Landrous/Enamorus Store
		{ itemNum: 523, item_name: 'Reveal Glass', item_class: 1, pokemon_usage: 'Genies', new_form: 'Therian', reusable: 1, price: 1000, drop_class: null, drop_rate: 0, explanation: '**REUSABLE**: Glass for Tornadus/Thundurus/Landorus/Enamorus Therian transformation' }, //Genies
		
		//Kyurem Store
		{ itemNum: 524, item_name: 'White DNA Splicer', item_class: 1, pokemon_usage: 'Kyurem', new_form: 'White', reusable: 1, price: 750, drop_class: null, drop_rate: 0, explanation: '**REUSABLE**: DNA splicer for Reshiram/White Kyurem transformation' },
		{ itemNum: 525, item_name: 'Black DNA Splicer', item_class: 1, pokemon_usage: 'Kyurem', new_form: 'Black', reusable: 1, price: 750, drop_class: null, drop_rate: 0, explanation: '**REUSABLE**: DNA splicer for Reshiram/White Kyurem transformation' },
		
		//Furfrou Store
		{ itemNum: 526, item_name: 'Heart Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'Heart Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: Heart trim for Furfrou transformation' },
		{ itemNum: 527, item_name: 'Star Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'Star Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: Star trim for Furfrou transformation' },
		{ itemNum: 528, item_name: 'Diamond Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'Diamond Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: Diamond trim for Furfrou transformation' },
		{ itemNum: 529, item_name: 'Debutante Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'Debutante Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: Debutante trim for Furfrou transformation' },
		{ itemNum: 530, item_name: 'Matron Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'Matron Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: Matron trim for Furfrou transformation' },
		{ itemNum: 531, item_name: 'Dandy Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'Dandy Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: Dandy trim for Furfrou transformation' },
		{ itemNum: 532, item_name: 'La Reine Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'La Reine Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: La Reine trim for Furfrou transformation' },
		{ itemNum: 533, item_name: 'Kabuki Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'Kabuki Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: Kabuki trim for Furfrou transformation' },
		{ itemNum: 534, item_name: 'Pharaoh Trim', item_class: 1, pokemon_usage: 'Furfrou', new_form: 'Pharaoh Trim', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 9, explanation: '**CONSUMABLE**: Pharaoh trim for Furfrou transformation' },
		
		//Hoopa Store
		{ itemNum: 535, item_name: 'Prison Bottle', item_class: 1, pokemon_usage: 'Hoopa', new_form: 'Unbound', reusable: 1, price: 1000, explanation: '**REUSABLE**: Bottle for Hoopa Unbound transformation' },
		
		//Oricorio Store
		{ itemNum: 536, item_name: 'Red Nectar', item_class: 1, pokemon_usage: 'Oricorio', new_form: 'Baile Style', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 4, explanation: '**CONSUMABLE**: Red nectar for Oricorio transformation' },
		{ itemNum: 537, item_name: 'Yellow Nectar', item_class: 1, pokemon_usage: 'Oricorio', new_form: 'Pom-Pom Style', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 4, explanation: '**CONSUMABLE**: Yellow nectar for Oricorio transformation' },
		{ itemNum: 538, item_name: 'Pink Nectar', item_class: 1, pokemon_usage: 'Oricorio', new_form: 'Pa\'u Style', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 4, explanation: '**CONSUMABLE**: Pink nectar for Oricorio transformation' },
		{ itemNum: 539, item_name: 'Purple Nectar', item_class: 1, pokemon_usage: 'Oricorio', new_form: 'Sensu Style', reusable: 0, price: 250, drop_class: 'common', drop_rate: common / 4, explanation: '**CONSUMABLE**: Purple nectar for Oricorio transformation' },
		
		//Silvally Store
		{ itemNum: 540, item_name: 'Fighting Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Fighting', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Fighting memory for Silvally transformation' },
		{ itemNum: 541, item_name: 'Flying Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Flying', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Flying memory for Silvally transformation' },
		{ itemNum: 542, item_name: 'Poison Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Poison', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Poison memory for Silvally transformation' },
		{ itemNum: 543, item_name: 'Ground Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Ground', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Ground memory for Silvally transformation' },
		{ itemNum: 544, item_name: 'Rock Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Rock', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Rock memory for Silvally transformation' },
		{ itemNum: 545, item_name: 'Bug Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Bug', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Bug memory for Silvally transformation' },
		{ itemNum: 546, item_name: 'Ghost Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Ghost', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Ghost memory for Silvally transformation' },
		{ itemNum: 547, item_name: 'Steel Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Steel', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Steel memory for Silvally transformation' },
		{ itemNum: 548, item_name: 'Fire Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Fire', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Fire memory for Silvally transformation' },
		{ itemNum: 549, item_name: 'Water Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Water', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Water memory for Silvally transformation' },
		{ itemNum: 550, item_name: 'Grass Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Grass', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Grass memory for Silvally transformation' },
		{ itemNum: 551, item_name: 'Electric Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Electric', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Electric memory for Silvally transformation' },
		{ itemNum: 552, item_name: 'Psychic Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Psychic', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Psychic memory for Silvally transformation' },
		{ itemNum: 553, item_name: 'Ice Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Ice', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Ice memory for Silvally transformation' },
		{ itemNum: 554, item_name: 'Dragon Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Dragon', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Dragon memory for Silvally transformation' },
		{ itemNum: 555, item_name: 'Dark Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Dark', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Dark memory for Silvally transformation' },
		{ itemNum: 556, item_name: 'Fairy Memory', item_class: 1, pokemon_usage: 'Silvally', new_form: 'Type: Fairy', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 17, explanation: '**CONSUMABLE**: Fairy memory for Silvally transformation' },
		
		//Necrozma Store
		{ itemNum: 557, item_name: 'N-Solarizer', item_class: 1, pokemon_usage: 'Necrozma', new_form: 'Dusk Mane', reusable: 1, price: 1000, drop_class: null, drop_rate: 0, explanation: '**REUSABLE**: N-Solarizer for Dusk Mane Necrozma transformation' },
		{ itemNum: 558, item_name: 'N-Lunarizer', item_class: 1, pokemon_usage: 'Necrozma', new_form: 'Dawn Wings', reusable: 1, price: 1000, drop_class: null, drop_rate: 0, explanation: '**REUSABLE**: N-Lunarizer for Dawn Wings Necrozma transformation' },
		{ itemNum: 559, item_name: 'Ultranecrozium Z', item_class: 1, pokemon_usage: 'Necrozma', new_form: 'Ultra', reusable: 0, price: 500, drop_class: 'common', drop_rate: common / 1, explanation: '**CONSUMABLE**: Ultranecrozium Z for Ultra Necrozma transformation \n __**REQUIRES** Dusk Mane or Dawn Wings Necrozma!!!__' },
		
		//Zacian Store
		{ itemNum: 560, item_name: 'Rusted Sword', item_class: 1, pokemon_usage: 'Zacian', new_form: 'Crowned Sword', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 1, explanation: '**CONSUMABLE**: Rusted sword for Crowned Sword Zacian transformation' },
		
		//Zamazenta Store
		{ itemNum: 561, item_name: 'Rusted Shield', item_class: 1, pokemon_usage: 'Zamazenta', new_form: 'Crowned Shield', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 1, explanation: '**CONSUMABLE**: Rusted sword for Crowned Shield Zamazenta transformation' },
		
		//Dialga
		{ itemNum: 562, item_name: 'Adamant Crystal', item_class: 1, pokemon_usage: 'Dialga', new_form: 'Origin', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 1, explanation: '**CONSUMABLE**: Adamant Crystal for Origin Dialga transformation' },
		
		//Palkia
		{ itemNum: 563, item_name: 'Lustrous Globe', item_class: 1, pokemon_usage: 'Palkia', new_form: 'Origin', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 1, explanation: '**CONSUMABLE**: Lustrous Globe for Origin Palkia transformation' },
		
		//Giratina
		{ itemNum: 564, item_name: 'Griseous Core', item_class: 1, pokemon_usage: 'Giratina', new_form: 'Origin', reusable: 2, price: 500,drop_class: 'common', drop_rate: common / 1,  explanation: '**CONSUMABLE**: Griseous Core for Origin Giratina transformation' },
		
		//Ogerpon
		{ itemNum: 565, item_name: 'Wellspring Mask', item_class: 1, pokemon_usage: 'Ogerpon', new_form: 'Wellspring', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 3, explanation: '**CONSUMABLE**: Wellspring Mask for Wellspring Ogerpon transformation' },
		{ itemNum: 566, item_name: 'Hearthflame Mask', item_class: 1, pokemon_usage: 'Ogerpon', new_form: 'Hearthflame', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 3, explanation: '**CONSUMABLE**: Hearthflame Mask for Hearthflame Ogerpon transformation' },
		{ itemNum: 567, item_name: 'Cornerstone Mask', item_class: 1, pokemon_usage: 'Ogerpon', new_form: 'Cornerstone', reusable: 2, price: 500, drop_class: 'common', drop_rate: common / 3, explanation: '**CONSUMABLE**: Cornerstone Mask for Cornerstone Ogerpon transformation' }
	]; 
	//{ itemNum: , item_name: '', item_class: , pokemon_usage: null, new_form: null, reusable: , price: , explanation: '' },

	shopItems.forEach(shopItem => {
		stmt.run(shopItem.itemNum, shopItem.item_name, shopItem.item_class, shopItem.pokemon_usage, shopItem.new_form, shopItem.reusable, shopItem.price, shopItem.drop_class, shopItem.drop_rate, shopItem.explanation);
	});

	stmt.finalize();
});

db.close();
console.log("Database setup complete.");