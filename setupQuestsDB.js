const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./quests.db');

db.serialize(() => {
	db.run(`CREATE TABLE IF NOT EXISTS quests (
    quest_id INTEGER PRIMARY KEY,
    region TEXT,
    collection_name TEXT,
    description TEXT,
    reward TEXT,
    required_pokemon TEXT, -- Comma-separated dex numbers (e.g., "722-730,741")
    required_forms TEXT, -- JSON object mapping dex numbers to required forms (e.g., '{"741": ["Baile Style", "Pom-Pom Style"]}')
    poke_count INTEGER, -- Number of required Pokémon
    contributor TEXT,
    note TEXT
)`);

	const stmt = db.prepare("INSERT INTO quests (quest_id, region, collection_name, description, reward, required_pokemon, required_forms, poke_count, contributor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

	const quests = [
		// 2/8/2025
		{ quest_id: 1, region: 'Alola', collection_name: 'Alola Beginner', description: 'All Alola Starters and Evolutions', reward: '1', required_pokemon: '722-730', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 2, region: 'Alola', collection_name: 'Alola Completionist', description: 'Regional Alola Dex Completion', reward: '6', required_pokemon: '722-784', required_forms: JSON.stringify({}), poke_count: 61, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 3, region: 'Alola', collection_name: 'Oricorio Enthusiast', description: 'All Oricorio Forms', reward: 'Lootbox', required_pokemon: '741', required_forms: JSON.stringify({'741': ['Baile Style', 'Pom-Pom Style', 'Pa\'u Style', 'Sensu Style']}), poke_count: 4, contributor: 'Jack', note: '' },
		{ quest_id: 4, region: 'Alola', collection_name: 'Not Quite Legendary', description: 'All Ultra Beast Pokemon', reward: '4', required_pokemon: '793-799, 803-806', required_forms: JSON.stringify({}), poke_count: 11, contributor: 'Dillon', note: '' },
		{ quest_id: 5, region: 'Galar', collection_name: 'Bird Watching Extremist', description: 'Galar Legendary Birds', reward: 'Lootbox', required_pokemon: '144-146', required_forms: JSON.stringify({'144': ['Galarian'], '145': ['Galarian'], '146': ['Galarian']}), poke_count: 3, contributor: 'Dillon', note: '' },
		{ quest_id: 6, region: 'Galar', collection_name: 'Galar Beginner', description: 'All Galar Starters and Evolutions', reward: '1', required_pokemon: '810-818', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 7, region: 'Galar', collection_name: 'Galar Completionist', description: 'Regional Galar Dex Completion', reward: '8', required_pokemon: '810-887, 899-904', required_forms: JSON.stringify({}), poke_count: 84, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 8, region: 'Hoenn', collection_name: 'Season\'s Greetings', description: 'Castform Forms', reward: 'Lootbox', required_pokemon: '351', required_forms: JSON.stringify({'351': ['Default', 'Sunny', 'Rainy', 'Snowy']}), poke_count: 4, contributor: 'Jack', note: '' },
		{ quest_id: 9, region: 'Hoenn', collection_name: 'Alien Lover', description: 'Deoxys Forms', reward: '2', required_pokemon: '386', required_forms: JSON.stringify({'386': ['Normal', 'Attack', 'Defense', 'Speed']}), poke_count: 4, contributor: 'Dillon', note: '' },
		{ quest_id: 10, region: 'Hoenn', collection_name: 'Hoenn Beginner', description: 'All Hoenn Starters and Evolutions', reward: '1', required_pokemon: '252-260', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 11, region: 'Hoenn', collection_name: 'Hoenn Completionist', description: 'Regional Hoenn Dex Completion', reward: '12', required_pokemon: '252-376', required_forms: JSON.stringify({}), poke_count: 125, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 12, region: 'Johto', collection_name: 'Paw Patrol', description: 'Johto Legendary Beasts', reward: 'Lootbox', required_pokemon: '243-245', required_forms: JSON.stringify({}), poke_count: 3, contributor: 'Dillon', note: '' },
		{ quest_id: 13, region: 'Johto', collection_name: 'Johto Beginner', description: 'All Johto Starters and Evolutions', reward: '1', required_pokemon: '152-160', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 14, region: 'Johto', collection_name: 'Johto Completionist', description: 'Regional Johto Dex Completion ', reward: '9', required_pokemon: '152-242, 246-248', required_forms: JSON.stringify({}), poke_count: 94, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 15, region: 'Kalos', collection_name: 'Kalos Beginner', description: 'All Kalos Starters and Evolutions', reward: '1', required_pokemon: '650-658', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 16, region: 'Kalos', collection_name: 'Kalos Completionist', description: 'Regional Kalos Dex Completion', reward: '6', required_pokemon: '650-715', required_forms: JSON.stringify({}), poke_count: 66, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 17, region: 'Kalos', collection_name: 'Flower Power', description: 'All Colors of Flabebe, Floette, and Florges', reward: '2', required_pokemon: '669-671', required_forms: JSON.stringify({'669': ['Red', 'Blue', 'Yellow', 'White', 'Orange'], '670': ['Red', 'Blue', 'Yellow', 'White', 'Orange'], '671': ['Red', 'Blue', 'Yellow', 'White', 'Orange']}), poke_count: 15, contributor: 'Jack', note: '' },
		{ quest_id: 18, region: 'Kanto', collection_name: 'Kanto Beginner', description: 'All Kanto Starters and Evolutions', reward: '1', required_pokemon: '1-9', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Jack', note: '' },
		{ quest_id: 19, region: 'Kanto', collection_name: 'Kanto Completionist', description: 'Kanto Dex Completion', reward: '14', required_pokemon: '1-143, 147-149', required_forms: JSON.stringify({'29': ['Female'], '32': ['Male']}), poke_count: 146, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 20, region: 'Kanto', collection_name: 'Lugia Ops', description: 'Kanto Legendary Birds', reward: 'Lootbox', required_pokemon: '144-146', required_forms: JSON.stringify({'144': ['Default'], '145': ['Default'], '146': ['Default']}), poke_count: 3, contributor: 'Dillon', note: '' },
		{ quest_id: 21, region: 'Multiple', collection_name: 'Alphabet soup', description: 'Unown Letters', reward: '4', required_pokemon: '201', required_forms: JSON.stringify({'201': ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '!', '?']}), poke_count: 28, contributor: 'Jack', note: '' },
		{ quest_id: 22, region: 'Multiple', collection_name: '⍑ᒷ  ᓭ⚍リ  ∷', description: 'All Regis', reward: '3', required_pokemon: '377-379, 486, 894, 895', required_forms: JSON.stringify({}), poke_count: 6, contributor: 'Jack', note: '' },
		{ quest_id: 23, region: 'Multiple', collection_name: 'Porygon Collector', description: 'All Porygons', reward: 'Lootbox', required_pokemon: '137, 233, 474', required_forms: JSON.stringify({}), poke_count: 3, contributor: 'Dillon', note: '' },
		{ quest_id: 24, region: 'Multiple', collection_name: 'Light Snack', description: 'Set Meal of Food Pokemon', reward: 'Lootbox', required_pokemon: '43, 582, 840, 926, 978', required_forms: JSON.stringify({}), poke_count: 5, contributor: 'Neil', note: '' },
		{ quest_id: 25, region: 'Multiple', collection_name: 'Eevee Petter', description: 'Eevee and all Eevee Evolutions', reward: '1', required_pokemon: '133-136, 196, 197, 470, 471, 700', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 26, region: 'Multiple', collection_name: 'Gone Fishing', description: 'All Basculin/Basculegion Forms', reward: 'Lootbox', required_pokemon: '550, 902', required_forms: JSON.stringify({'550': ['Red-Striped', 'Blue-Striped', 'White-Striped'], '902': ['Male', 'Female']}), poke_count: 5, contributor: 'Dillon', note: '' },
		{ quest_id: 27, region: 'Multiple', collection_name: 'Tauros Breeder', description: 'All Tauros Breeds', reward: 'Lootbox', required_pokemon: '128', required_forms: JSON.stringify({'128': ['Default', 'Combat Breed', 'Blaze Breed', 'Aqua Breed']}), poke_count: 4, contributor: 'Dillon', note: '' },
		{ quest_id: 28, region: 'Paldea', collection_name: 'Dragon Patrol', description: 'Paldea Legendary Beasts', reward: 'Lootbox', required_pokemon: '1009, 1020, 1021', required_forms: JSON.stringify({}), poke_count: 3, contributor: 'Dillon', note: '' },
		{ quest_id: 29, region: 'Paldea', collection_name: 'Paldea Beginner', description: 'All Paldea Starters and Evolutions', reward: '1', required_pokemon: '906-914', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 30, region: 'Paldea', collection_name: 'Paldea Completionist', description: 'Regional Paldea Dex Completion', reward: '10', required_pokemon: '906-1000, 1005, 1006, 1011-1013, 1018, 1019', required_forms: JSON.stringify({}), poke_count: 102, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 31, region: 'Sinnoh', collection_name: 'Sinnoh Beginner', description: 'All Sinnoh Starters and Evolutions', reward: '1', required_pokemon: '387-395', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 32, region: 'Sinnoh', collection_name: 'Sinnoh Completionist', description: 'Regional Sinnoh Dex Completion', reward: '9', required_pokemon: '387-479', required_forms: JSON.stringify({}), poke_count: 93, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 33, region: 'Sinnoh', collection_name: 'MOTOR MOTOR', description: 'All Rotom Forms', reward: '2', required_pokemon: '479', required_forms: JSON.stringify({'479': ['Default', 'Heat', 'Wash', 'Frost', 'Fan', 'Mow']}), poke_count: 6, contributor: 'Jack', note: '' },
		{ quest_id: 34, region: 'Unova', collection_name: 'Unova Beginner', description: 'All Unova Starters and Evolutions', reward: '1', required_pokemon: '495-503', required_forms: JSON.stringify({}), poke_count: 9, contributor: 'Neil', note: '' },
		{ quest_id: 35, region: 'Unova', collection_name: 'Unova Completionist', description: 'Regional Unova Dex Completion', reward: '14', required_pokemon: '495-637', required_forms: JSON.stringify({}), poke_count: 143, contributor: 'Neil', note: 'Legends and Mythicals excluded' },
		{ quest_id: 36, region: 'Unova', collection_name: 'Simipan Collector', description: 'All Elemental Monkeys', reward: 'Lootbox', required_pokemon: '511-516', required_forms: JSON.stringify({}), poke_count: 6, contributor: 'Jack', note: '' }//,

		
		//{ quest_id: , region: '', collection_name: '', description: '', reward: '', required_pokemon: '', required_forms: JSON.stringify({}), poke_count: , contributor: '', note: '' },
	];
	quests.forEach(quest => {
		stmt.run(quest.quest_id, quest.region, quest.collection_name, quest.description, quest.reward, quest.required_pokemon, quest.required_forms, quest.poke_count, quest.contributor, quest.note);
	});

	stmt.finalize();
});

db.close();
console.log("Quest database setup complete.");