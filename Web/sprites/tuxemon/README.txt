Tuxemon assets
==============

Source: https://github.com/Tuxemon/Tuxemon (development branch), files under
mods/tuxemon/. Downloaded unchanged, except that "core_set pieces" was renamed
core_set_pieces to keep spaces out of URLs.

tilesets/core_outdoor.png (+ .tsx)      grass, sand paths, water, trees,
                                        tall grass, flowers. 16x16, 37 columns.
tilesets/core_buildings.png (+ .tsx)    houses and shops. 47 columns.
tilesets/core_set_pieces.png (+ .tsx)   signs and props. 31 columns.
    The .tsx files are Tiled's tileset files: they hold the animations
    (water, flowers) and tile properties.
animations/grass.png                    leaves kicked up in tall grass, 2 frames.
animations/splash_small.png             water splash, 4 frames.
characters/adventurer.png               the player: 16x32 frames, 3 across
                                        (step, stand, step), rows facing
                                        down, left, right, up.
characters/drop_shadow.png              shadow under characters.
characters/*.png                        all 207 of Tuxemon's overworld
                                        characters (mods/tuxemon/sprites), in
                                        the same layout as adventurer.png: for
                                        trainers, NPCs and the outfit choice.
bubbles/exclamation.png                 the "!" when a trainer spots you.
animations/surfboard.png                what you ride on the sea (gfx/items).
tilesets/core_indoor_*.png (+ .tsx)     floors, walls and stairs for rooms.
The rooms themselves are Tuxemon's .tmx maps, kept in Web/maps/tuxemon and
read by Web/maps/tmx.js.
battle/*.png                            battle backgrounds, one per biome
                                        (mods/tuxemon/gfx/ui/combat/*_background.png).

Licence
-------
Tuxemon's code is GPL-3.0; its art is a mix of open licences, mostly
CC BY-SA, CC BY and CC0, plus Kelvin Shadewing's XYG Open Source License for
some tiles. Every piece, its author(s) and its licence are listed in
ATTRIBUTIONS.md (Tuxemon's own file, copied here). Using them means crediting
those authors, and CC BY-SA pieces stay under CC BY-SA if changed.

The "core" tilesets are by rubberduck, compiled from work by Buch (commissioned
by luke83), George_, Kelvin Shadewing, Midi, PastTheFuture, ArMM1998,
Redshrike, Mike Bramson and others - see the CORES section of ATTRIBUTIONS.md.
The splash is "Fishing Splash" by Jesse McCarthy (CC BY), adapted by Sanglorian.
