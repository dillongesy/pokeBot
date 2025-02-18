const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./goldshop.db');

db.serialize(() => {
	db.run("CREATE TABLE IF NOT EXISTS goldshop (id INTEGER PRIMARY KEY, itemNum INTEGER, item_name TEXT, user_column TEXT, identifier TEXT, price INTEGER, explanation TEXT)");

	const stmt = db.prepare("INSERT INTO goldshop (itemNum, item_name, user_column, identifier, price, explanation) VALUES (?, ?, ?, ?, ?, ?)");

	const shopItems = [
		{ itemNum: 1, item_name: 'Amulet Coin', user_column: 'acNum', identifier: '1', price: 30, explanation: 'Boosts currency drop rate by 2x (Only applies to your own drops)' },
		{ itemNum: 2, item_name: 'Shiny Charm', user_column: 'shinyCharm', identifier: '1', price: 50, explanation: 'Boosts shiny drop rate by 2x' },
		{ itemNum: 3, item_name: 'Critical Drop 1', user_column: 'critDropString', identifier: 'A', price: 15, explanation: 'Adds a 6.25% chance to instantly refresh your drop cooldown' },
		{ itemNum: 4, item_name: 'Critical Drop 2', user_column: 'critDropString', identifier: 'B', price: 20, explanation: 'Adds a 6.25% chance to instantly refresh your drop cooldown' },
		{ itemNum: 5, item_name: 'Critical Drop 3', user_column: 'critDropString', identifier: 'C', price: 25, explanation: 'Adds a 6.25% chance to instantly refresh your drop cooldown' },
		{ itemNum: 6, item_name: 'Critical Drop 4', user_column: 'critDropString', identifier: 'D', price: 30, explanation: 'Adds a 6.25% chance to instantly refresh your drop cooldown' },
		{ itemNum: 7, item_name: 'Cooldown Reducer 1', user_column: 'cdString', identifier: 'A', price: 15, explanation: 'Decreases your cooldown by 30 seconds' },
		{ itemNum: 8, item_name: 'Cooldown Reducer 2', user_column: 'cdString', identifier: 'B', price: 20, explanation: 'Decreases your cooldown by 30 seconds' },
		{ itemNum: 9, item_name: 'Cooldown Reducer 3', user_column: 'cdString', identifier: 'C', price: 25, explanation: 'Decreases your cooldown by 30 seconds' },
		{ itemNum: 10, item_name: 'Cooldown Reducer 4', user_column: 'cdString', identifier: 'D', price: 30, explanation: 'Decreases your cooldown by 30 seconds' },
	]; 
	//{ itemNum: 1, item_name: '', user_column: '', price: 0, explanation: '' },

	shopItems.forEach(shopItem => {
		stmt.run(shopItem.itemNum, shopItem.item_name, shopItem.user_column, shopItem.identifier, shopItem.price, shopItem.explanation);
	});

	stmt.finalize();
});

db.close();
console.log("Database setup complete.");