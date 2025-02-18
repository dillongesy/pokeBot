const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./achievements.db');

db.serialize(() => {
	db.run(`CREATE TABLE IF NOT EXISTS achievements (
    ach_id INTEGER PRIMARY KEY,
    ach_name TEXT NOT NULL,
	ach_type INTEGER DEFAULT 0,
    description TEXT NOT NULL,
    reward TEXT NOT NULL,
	requirement TEXT NOT NULL,
    poke_count INTEGER,
    contributor TEXT DEFAULT '',
    note TEXT DEFAULT ''
	)`);

	/*
	ach_type key:
	0: Total Caught
	1: Type Caught
	2: Total Spent
	3: Shiny Dropped
	*/

	const stmt = db.prepare("INSERT INTO achievements (ach_id, ach_name, ach_type, description, reward, requirement, poke_count, contributor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");

	const achievements = [
		// 2/8/2025
		{ ach_id: 201, ach_name: 'Shiny Dropper', ach_type: 3, description: 'Drop a Shiny Without an Incense', reward: '1', requirement: '', poke_count: 1, contributor: 'Dillon', note: '' },
		
		{ ach_id: 202, ach_name: 'Normal Beginner', ach_type: 1, description: 'Catch 10 Normal Type Pokemon', reward: 'Lootbox', requirement: 'Normal', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 203, ach_name: 'Fire Beginner', ach_type: 1, description: 'Catch 10 Fire Type Pokemon', reward: 'Lootbox', requirement: 'Fire', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 204, ach_name: 'Fighting Beginner', ach_type: 1, description: 'Catch 10 Fighting Type Pokemon', reward: 'Lootbox', requirement: 'Fighting', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 205, ach_name: 'Water Beginner', ach_type: 1, description: 'Catch 10 Water Type Pokemon', reward: 'Lootbox', requirement: 'Water', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 206, ach_name: 'Flying Beginner', ach_type: 1, description: 'Catch 10 Flying Type Pokemon', reward: 'Lootbox', requirement: 'Flying', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 207, ach_name: 'Grass Beginner', ach_type: 1, description: 'Catch 10 Grass Type Pokemon', reward: 'Lootbox', requirement: 'Grass', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 208, ach_name: 'Poison Beginner', ach_type: 1, description: 'Catch 10 Poison Type Pokemon', reward: 'Lootbox', requirement: 'Poison', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 209, ach_name: 'Electric Beginner', ach_type: 1, description: 'Catch 10 Electric Type Pokemon', reward: 'Lootbox', requirement: 'Electric', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 210, ach_name: 'Ground Beginner', ach_type: 1, description: 'Catch 10 Ground Type Pokemon', reward: 'Lootbox', requirement: 'Ground', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 211, ach_name: 'Psychic Beginner', ach_type: 1, description: 'Catch 10 Psychic Type Pokemon', reward: 'Lootbox', requirement: 'Psychic', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 212, ach_name: 'Rock Beginner', ach_type: 1, description: 'Catch 10 Rock Type Pokemon', reward: 'Lootbox', requirement: 'Rock', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 213, ach_name: 'Ice Beginner', ach_type: 1, description: 'Catch 10 Ice Type Pokemon', reward: 'Lootbox', requirement: 'Ice', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 214, ach_name: 'Bug Beginner', ach_type: 1, description: 'Catch 10 Bug Type Pokemon', reward: 'Lootbox', requirement: 'Bug', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 215, ach_name: 'Dragon Beginner', ach_type: 1, description: 'Catch 10 Dragon Type Pokemon', reward: 'Lootbox', requirement: 'Dragon', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 216, ach_name: 'Ghost Beginner', ach_type: 1, description: 'Catch 10 Ghost Type Pokemon', reward: 'Lootbox', requirement: 'Ghost', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 217, ach_name: 'Dark Beginner', ach_type: 1, description: 'Catch 10 Dark Type Pokemon', reward: 'Lootbox', requirement: 'Dark', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 218, ach_name: 'Steel Beginner', ach_type: 1, description: 'Catch 10 Steel Type Pokemon', reward: 'Lootbox', requirement: 'Steel', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 219, ach_name: 'Fairy Beginner', ach_type: 1, description: 'Catch 10 Fairy Type Pokemon', reward: 'Lootbox', requirement: 'Fairy', poke_count: 10, contributor: 'Dillon', note: '' },
		
		{ ach_id: 220, ach_name: 'Normal Novice', ach_type: 1, description: 'Catch 100 Normal Type Pokemon', reward: '1', requirement: 'Normal', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 221, ach_name: 'Fire Novice', ach_type: 1, description: 'Catch 100 Fire Type Pokemon', reward: '1', requirement: 'Fire', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 222, ach_name: 'Fighting Novice', ach_type: 1, description: 'Catch 100 Fighting Type Pokemon', reward: '1', requirement: 'Fighting', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 223, ach_name: 'Water Novice', ach_type: 1, description: 'Catch 100 Water Type Pokemon', reward: '1', requirement: 'Water', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 224, ach_name: 'Flying Novice', ach_type: 1, description: 'Catch 100 Flying Type Pokemon', reward: '1', requirement: 'Flying', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 225, ach_name: 'Grass Novice', ach_type: 1, description: 'Catch 100 Grass Type Pokemon', reward: '1', requirement: 'Grass', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 226, ach_name: 'Poison Novice', ach_type: 1, description: 'Catch 100 Poison Type Pokemon', reward: '1', requirement: 'Poison', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 227, ach_name: 'Electric Novice', ach_type: 1, description: 'Catch 100 Electric Type Pokemon', reward: '1', requirement: 'Electric', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 228, ach_name: 'Ground Novice', ach_type: 1, description: 'Catch 100 Ground Type Pokemon', reward: '1', requirement: 'Ground', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 229, ach_name: 'Psychic Novice', ach_type: 1, description: 'Catch 100 Psychic Type Pokemon', reward: '1', requirement: 'Psychic', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 230, ach_name: 'Rock Novice', ach_type: 1, description: 'Catch 100 Rock Type Pokemon', reward: '1', requirement: 'Rock', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 231, ach_name: 'Ice Novice', ach_type: 1, description: 'Catch 100 Ice Type Pokemon', reward: '1', requirement: 'Ice', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 232, ach_name: 'Bug Novice', ach_type: 1, description: 'Catch 100 Bug Type Pokemon', reward: '1', requirement: 'Bug', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 233, ach_name: 'Dragon Novice', ach_type: 1, description: 'Catch 100 Dragon Type Pokemon', reward: '1', requirement: 'Dragon', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 234, ach_name: 'Ghost Novice', ach_type: 1, description: 'Catch 100 Ghost Type Pokemon', reward: '1', requirement: 'Ghost', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 235, ach_name: 'Dark Novice', ach_type: 1, description: 'Catch 100 Dark Type Pokemon', reward: '1', requirement: 'Dark', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 236, ach_name: 'Steel Novice', ach_type: 1, description: 'Catch 100 Steel Type Pokemon', reward: '1', requirement: 'Steel', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 237, ach_name: 'Fairy Novice', ach_type: 1, description: 'Catch 100 Fairy Type Pokemon', reward: '1', requirement: 'Fairy', poke_count: 100, contributor: 'Dillon', note: '' },
		
		{ ach_id: 238, ach_name: 'Normal Master', ach_type: 1, description: 'Catch 1000 Normal Type Pokemon', reward: '3', requirement: 'Normal', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 239, ach_name: 'Fire Master', ach_type: 1, description: 'Catch 1000 Fire Type Pokemon', reward: '3', requirement: 'Fire', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 240, ach_name: 'Fighting Master', ach_type: 1, description: 'Catch 1000 Fighting Type Pokemon', reward: '3', requirement: 'Fighting', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 241, ach_name: 'Water Master', ach_type: 1, description: 'Catch 1000 Water Type Pokemon', reward: '3', requirement: 'Water', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 242, ach_name: 'Flying Master', ach_type: 1, description: 'Catch 1000 Flying Type Pokemon', reward: '3', requirement: 'Flying', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 243, ach_name: 'Grass Master', ach_type: 1, description: 'Catch 1000 Grass Type Pokemon', reward: '3', requirement: 'Grass', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 244, ach_name: 'Poison Master', ach_type: 1, description: 'Catch 1000 Poison Type Pokemon', reward: '3', requirement: 'Poison', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 245, ach_name: 'Electric Master', ach_type: 1, description: 'Catch 1000 Electric Type Pokemon', reward: '3', requirement: 'Electric', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 246, ach_name: 'Ground Master', ach_type: 1, description: 'Catch 1000 Ground Type Pokemon', reward: '3', requirement: 'Ground', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 247, ach_name: 'Psychic Master', ach_type: 1, description: 'Catch 1000 Psychic Type Pokemon', reward: '3', requirement: 'Psychic', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 248, ach_name: 'Rock Master', ach_type: 1, description: 'Catch 1000 Rock Type Pokemon', reward: '3', requirement: 'Rock', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 249, ach_name: 'Ice Master', ach_type: 1, description: 'Catch 1000 Ice Type Pokemon', reward: '3', requirement: 'Ice', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 250, ach_name: 'Bug Master', ach_type: 1, description: 'Catch 1000 Bug Type Pokemon', reward: '3', requirement: 'Bug', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 251, ach_name: 'Dragon Master', ach_type: 1, description: 'Catch 1000 Dragon Type Pokemon', reward: '3', requirement: 'Dragon', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 252, ach_name: 'Ghost Master', ach_type: 1, description: 'Catch 1000 Ghost Type Pokemon', reward: '3', requirement: 'Ghost', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 253, ach_name: 'Dark Master', ach_type: 1, description: 'Catch 1000 Dark Type Pokemon', reward: '3', requirement: 'Dark', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 254, ach_name: 'Steel Master', ach_type: 1, description: 'Catch 1000 Steel Type Pokemon', reward: '3', requirement: 'Steel', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 255, ach_name: 'Fairy Master', ach_type: 1, description: 'Catch 1000 Fairy Type Pokemon', reward: '3', requirement: 'Fairy', poke_count: 1000, contributor: 'Dillon', note: '' },
		
		{ ach_id: 256, ach_name: 'PokeDropper Beginner', ach_type: 0, description: 'Catch 10 Pokemon', reward: 'Lootbox', requirement: '', poke_count: 10, contributor: 'Dillon', note: '' },
		{ ach_id: 257, ach_name: 'PokeDropper Apprentice', ach_type: 0, description: 'Catch 100 Pokemon', reward: '1', requirement: '', poke_count: 100, contributor: 'Dillon', note: '' },
		{ ach_id: 258, ach_name: 'PokeDropper Novice', ach_type: 0, description: 'Catch 1000 Pokemon', reward: '5', requirement: '', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 259, ach_name: 'PokeDropper Elite', ach_type: 0, description: 'Catch 5000 Pokemon', reward: '10', requirement: '', poke_count: 5000, contributor: 'Dillon', note: '' },
		{ ach_id: 260, ach_name: 'PokeDropper Master', ach_type: 0, description: 'Catch 10000 Pokemon', reward: '20', requirement: '', poke_count: 10000, contributor: 'Dillon', note: '' },
		
		{ ach_id: 261, ach_name: 'Shopping Beginner', ach_type: 2, description: 'Spend 1000 Coins', reward: '1', requirement: '', poke_count: 1000, contributor: 'Dillon', note: '' },
		{ ach_id: 262, ach_name: 'Shopping Apprentice', ach_type: 2, description: 'Spend 10000 Coins', reward: '5', requirement: '', poke_count: 10000, contributor: 'Dillon', note: '' },
		{ ach_id: 263, ach_name: 'Shopping Apprentice', ach_type: 2, description: 'Spend 50000 Coins', reward: '10', requirement: '', poke_count: 50000, contributor: 'Dillon', note: '' },		
		{ ach_id: 264, ach_name: 'Shopping Elite', ach_type: 2, description: 'Spend 100000 Coins', reward: '20', requirement: '', poke_count: 100000, contributor: 'Dillon', note: '' },

		//{ ach_id: , ach_name: '', ach_type: 0, description: '', reward: '', requirement: '', poke_count: , contributor: '', note: '' },
	];
	achievements.forEach(achievement => {
		stmt.run(achievement.ach_id, achievement.ach_name, achievement.ach_type, achievement.description, achievement.reward, achievement.requirement, achievement.poke_count, achievement.contributor, achievement.note);
	});

	stmt.finalize();
});

db.close();
console.log("Achievement database setup complete.");