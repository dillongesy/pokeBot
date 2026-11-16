PokeDropper web sprites
=======================

Each source has its own folder, with its own README and licence notes.
Served by the site at /sprites/...

tuxemon/        IN USE. From the open-source game Tuxemon
                (https://github.com/Tuxemon/Tuxemon). The town, both
                stations, the player, tall grass and water all come from here.
opengameart/    Downloaded, not used yet. Two openly licensed tilesets from
                OpenGameArt, kept for later.
archive/        No longer used by the site. archive/emerald is the Emerald
                Safari Zone pack and hero sheet the site used before.

How the site puts them together: Web/public/world.js lays out the town from
tile numbers in tuxemon/tilesets (see the TILES table there). Nothing is
pre-combined into a new image, so swapping a piece means changing a number.

Credits shown to players: /sprites/CREDITS.txt (linked from the site).
