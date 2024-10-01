const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./shop.db');

db.serialize(() => {
	db.run("CREATE TABLE IF NOT EXISTS shop (id INTEGER PRIMARY KEY, item_name TEXT, item_class INTEGER, pokemon_usage TEXT, new_form TEXT, reusable INTEGER, price INTEGER, explanation TEXT)");

	const stmt = db.prepare("INSERT INTO shop (item_name, item_class, pokemon_usage, new_form, reusable, price, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)");

	//item_class: 0: items for general use
	//item_class: 1: items for pokemon
	
	//reusable: 0: no
	//reusable: 1: yes
	//reusable: 2: no, but get item back when form !default (aka "held" item)
	const shopItems = [
		{ item_name: 'Normal Repel', item_class: 0, pokemon_usage: null, new_form: null, reusable: 0, price: 1000, explanation: 'Has a 50% chance to drop an uncaught Pokemon' },
		
		{ item_name: 'Defaulter', item_class: 1, pokemon_usage: 'All', new_form: 'Default', reusable: 1, price: 500, explanation: '**REUSABLE**: Resets the Pokemon\'s form to default' },
		{ item_name: 'Stove', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Heat', reusable: 2, price: 2000, explanation: '**CONSUMABLE**: Stove for Rotom transformation' },
		{ item_name: 'Washing Machine', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Wash', reusable: 2, price: 2000, explanation: '**CONSUMABLE**: Washing Machine for Rotom transformation' },
		{ item_name: 'Fridge', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Frost', reusable: 2, price: 2000, explanation: '**CONSUMABLE**: Stove for Rotom transformation' },
		{ item_name: 'Fan', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Fan', reusable: 2, price: 2000, explanation: '**CONSUMABLE**: Stove for Rotom transformation' },
		{ item_name: 'Lawn Mower', item_class: 1, pokemon_usage: 'Rotom', new_form: 'Mow', reusable: 2, price: 2000, explanation: '**CONSUMABLE**: Stove for Rotom transformation' },
		
		{ item_name: 'Venusaurite', item_class: 1, pokemon_usage: 'Venusaur', new_form: 'Mega', reusable: 2, price: 2500, explanation: '**CONSUMABLE**: Mega Stone for Venusaur transformation' }
	]; 

	shopItems.forEach(shopItem => {
		stmt.run(shopItem.item_name, shopItem.item_class, shopItem.pokemon_usage, shopItem.new_form, shopItem.reusable, shopItem.price, shopItem.explanation);
	});

	stmt.finalize();
});

db.close();
console.log("Database setup complete.");