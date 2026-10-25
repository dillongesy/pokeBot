'use strict';

/**
 * Quest definitions - the source of truth.
 *
 * Edited by hand. The importer copies this into Data/Quests and validates
 * every entry, so mistakes fail at import time.
 *
 *   node Utils/importdata.js quests
 *
 * Two shapes of quest:
 *
 *   requires   a list of { dex, form? } - collect these
 *                { dex: 25 }                  any Pikachu
 *                { dex: 25, form: "Alola" }   that form specifically
 *              `count` means "any N of the list". Leave it out to need all.
 *
 *   goal       a counter - { kind, count, type? }
 *                total-caught   Pokemon caught, ever
 *                type-caught    caught of one type, needs `type`
 *                coins-spent    coins spent, ever
 *                shiny-caught   shinies caught. With withoutIncense: true
 *                               only natural shinies count.
 *
 * A quest has one or the other, never both. Utils/questprogress.js evaluates
 * either against a player.
 *
 * Other fields:
 *
 *   id           folder name and primary key. Kebab-case, must be unique.
 *   kind         collection | achievement. Grouping only.
 *   region       for grouping in the quest list.
 *   collection   the display name players see.
 *   reward       { gold, coins, items } - items are Data/Items slugs.
 *                Gold is earned nowhere else, so it gates the gold shop.
 *   notes        free text for reference. Not shown to players.
 *
 * Regional dex rules:
 *
 *   No legendaries, mythicals or Ultra Beasts; those have their own quests.
 *   (This is why Galarian Articuno, Zapdos and Moltres are not in the Galar
 *   dex.)
 *
 *   A regional dex includes the region's own Pokemon plus its regional forms
 *   of Pokemon from elsewhere (Alolan Rattata is in the Alola dex).
 *
 *   Every requirement must be obtainable. A form with a 0% drop rate in
 *   Utils/formrates.js can never be caught.
 */

module.exports = [
  {
    id: "genome-editor",
    kind: "collection",
    region: "Kanto",
    collection: "Genome Editor",
    description: "Mew and Mewtwo",
    requires: [
      {"dex":150}, {"dex":151},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "kanto-beginner",
    kind: "collection",
    region: "Kanto",
    collection: "Kanto Beginner",
    description: "All Kanto Starters and Evolutions",
    requires: [
      {"dex":1}, {"dex":2}, {"dex":3}, {"dex":4},
      {"dex":5}, {"dex":6}, {"dex":7}, {"dex":8},
      {"dex":9},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Jack",
  },

  {
    id: "kanto-completionist",
    kind: "collection",
    region: "Kanto",
    collection: "Kanto Completionist",
    description: "Kanto Dex Completion",
    requires: [
      {"dex":1}, {"dex":2}, {"dex":3}, {"dex":4},
      {"dex":5}, {"dex":6}, {"dex":7}, {"dex":8},
      {"dex":9}, {"dex":10}, {"dex":11}, {"dex":12},
      {"dex":13}, {"dex":14}, {"dex":15}, {"dex":16},
      {"dex":17}, {"dex":18}, {"dex":19}, {"dex":20},
      {"dex":21}, {"dex":22}, {"dex":23}, {"dex":24},
      {"dex":25}, {"dex":26}, {"dex":27}, {"dex":28},
      {"dex":29}, {"dex":30}, {"dex":31}, {"dex":32},
      {"dex":33}, {"dex":34}, {"dex":35}, {"dex":36},
      {"dex":37}, {"dex":38}, {"dex":39}, {"dex":40},
      {"dex":41}, {"dex":42}, {"dex":43}, {"dex":44},
      {"dex":45}, {"dex":46}, {"dex":47}, {"dex":48},
      {"dex":49}, {"dex":50}, {"dex":51}, {"dex":52},
      {"dex":53}, {"dex":54}, {"dex":55}, {"dex":56},
      {"dex":57}, {"dex":58}, {"dex":59}, {"dex":60},
      {"dex":61}, {"dex":62}, {"dex":63}, {"dex":64},
      {"dex":65}, {"dex":66}, {"dex":67}, {"dex":68},
      {"dex":69}, {"dex":70}, {"dex":71}, {"dex":72},
      {"dex":73}, {"dex":74}, {"dex":75}, {"dex":76},
      {"dex":77}, {"dex":78}, {"dex":79}, {"dex":80},
      {"dex":81}, {"dex":82}, {"dex":83}, {"dex":84},
      {"dex":85}, {"dex":86}, {"dex":87}, {"dex":88},
      {"dex":89}, {"dex":90}, {"dex":91}, {"dex":92},
      {"dex":93}, {"dex":94}, {"dex":95}, {"dex":96},
      {"dex":97}, {"dex":98}, {"dex":99}, {"dex":100},
      {"dex":101}, {"dex":102}, {"dex":103}, {"dex":104},
      {"dex":105}, {"dex":106}, {"dex":107}, {"dex":108},
      {"dex":109}, {"dex":110}, {"dex":111}, {"dex":112},
      {"dex":113}, {"dex":114}, {"dex":115}, {"dex":116},
      {"dex":117}, {"dex":118}, {"dex":119}, {"dex":120},
      {"dex":121}, {"dex":122}, {"dex":123}, {"dex":124},
      {"dex":125}, {"dex":126}, {"dex":127}, {"dex":128},
      {"dex":129}, {"dex":130}, {"dex":131}, {"dex":132},
      {"dex":133}, {"dex":134}, {"dex":135}, {"dex":136},
      {"dex":137}, {"dex":138}, {"dex":139}, {"dex":140},
      {"dex":141}, {"dex":142}, {"dex":143}, {"dex":147},
      {"dex":148}, {"dex":149},
    ],
    reward: {"gold":14,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "lugia-ops",
    kind: "collection",
    region: "Kanto",
    collection: "Lugia Ops",
    description: "Kanto Legendary Birds",
    requires: [
      {"dex":144}, {"dex":145}, {"dex":146},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "paw-patrol",
    kind: "collection",
    region: "Johto",
    collection: "Paw Patrol",
    description: "Johto Legendary Beasts",
    requires: [
      {"dex":243}, {"dex":244}, {"dex":245},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "johto-beginner",
    kind: "collection",
    region: "Johto",
    collection: "Johto Beginner",
    description: "All Johto Starters and Evolutions",
    requires: [
      {"dex":152}, {"dex":153}, {"dex":154}, {"dex":155},
      {"dex":156}, {"dex":157}, {"dex":158}, {"dex":159},
      {"dex":160},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "johto-completionist",
    kind: "collection",
    region: "Johto",
    collection: "Johto Completionist",
    description: "Regional Johto Dex Completion ",
    requires: [
      {"dex":152}, {"dex":153}, {"dex":154}, {"dex":155},
      {"dex":156}, {"dex":157}, {"dex":158}, {"dex":159},
      {"dex":160}, {"dex":161}, {"dex":162}, {"dex":163},
      {"dex":164}, {"dex":165}, {"dex":166}, {"dex":167},
      {"dex":168}, {"dex":169}, {"dex":170}, {"dex":171},
      {"dex":172}, {"dex":173}, {"dex":174}, {"dex":175},
      {"dex":176}, {"dex":177}, {"dex":178}, {"dex":179},
      {"dex":180}, {"dex":181}, {"dex":182}, {"dex":183},
      {"dex":184}, {"dex":185}, {"dex":186}, {"dex":187},
      {"dex":188}, {"dex":189}, {"dex":190}, {"dex":191},
      {"dex":192}, {"dex":193}, {"dex":194}, {"dex":195},
      {"dex":196}, {"dex":197}, {"dex":198}, {"dex":199},
      {"dex":200}, {"dex":201}, {"dex":202}, {"dex":203},
      {"dex":204}, {"dex":205}, {"dex":206}, {"dex":207},
      {"dex":208}, {"dex":209}, {"dex":210}, {"dex":211},
      {"dex":212}, {"dex":213}, {"dex":214}, {"dex":215},
      {"dex":216}, {"dex":217}, {"dex":218}, {"dex":219},
      {"dex":220}, {"dex":221}, {"dex":222}, {"dex":223},
      {"dex":224}, {"dex":225}, {"dex":226}, {"dex":227},
      {"dex":228}, {"dex":229}, {"dex":230}, {"dex":231},
      {"dex":232}, {"dex":233}, {"dex":234}, {"dex":235},
      {"dex":236}, {"dex":237}, {"dex":238}, {"dex":239},
      {"dex":240}, {"dex":241}, {"dex":242}, {"dex":246},
      {"dex":247}, {"dex":248},
    ],
    reward: {"gold":9,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "preschool-business",
    kind: "collection",
    region: "Johto",
    collection: "Preschool Business",
    description: "Johto Baby Pokemon",
    requires: [
      {"dex":172}, {"dex":173}, {"dex":174}, {"dex":175},
      {"dex":236}, {"dex":238}, {"dex":239}, {"dex":240},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "mama-birds",
    kind: "collection",
    region: "Johto",
    collection: "Mama Birds",
    description: "Both Johto Legendary Birds",
    requires: [
      {"dex":249}, {"dex":250},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "dynamic-duo",
    kind: "collection",
    region: "Hoenn",
    collection: "Dynamic Duo",
    description: "Latias and Latios",
    requires: [
      {"dex":380}, {"dex":381},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "water-earth-and-wind",
    kind: "collection",
    region: "Hoenn",
    collection: "Water, Earth, and Wind",
    description: "Hoenn Main Characters",
    requires: [
      {"dex":382}, {"dex":383}, {"dex":384},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "season-s-greetings",
    kind: "collection",
    region: "Hoenn",
    collection: "Season's Greetings",
    description: "Castform Forms",
    requires: [
      {"dex":351}, {"dex":351,"form":"Sunny"}, {"dex":351,"form":"Rainy"}, {"dex":351,"form":"Snowy"},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Jack",
  },

  {
    id: "alien-lover",
    kind: "collection",
    region: "Hoenn",
    collection: "Alien Lover",
    description: "Deoxys Forms",
    requires: [
      {"dex":386}, {"dex":386,"form":"Attack"}, {"dex":386,"form":"Defense"}, {"dex":386,"form":"Speed"},
    ],
    reward: {"gold":2,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "hoenn-beginner",
    kind: "collection",
    region: "Hoenn",
    collection: "Hoenn Beginner",
    description: "All Hoenn Starters and Evolutions",
    requires: [
      {"dex":252}, {"dex":253}, {"dex":254}, {"dex":255},
      {"dex":256}, {"dex":257}, {"dex":258}, {"dex":259},
      {"dex":260},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "hoenn-completionist",
    kind: "collection",
    region: "Hoenn",
    collection: "Hoenn Completionist",
    description: "Regional Hoenn Dex Completion",
    requires: [
      {"dex":252}, {"dex":253}, {"dex":254}, {"dex":255},
      {"dex":256}, {"dex":257}, {"dex":258}, {"dex":259},
      {"dex":260}, {"dex":261}, {"dex":262}, {"dex":263},
      {"dex":264}, {"dex":265}, {"dex":266}, {"dex":267},
      {"dex":268}, {"dex":269}, {"dex":270}, {"dex":271},
      {"dex":272}, {"dex":273}, {"dex":274}, {"dex":275},
      {"dex":276}, {"dex":277}, {"dex":278}, {"dex":279},
      {"dex":280}, {"dex":281}, {"dex":282}, {"dex":283},
      {"dex":284}, {"dex":285}, {"dex":286}, {"dex":287},
      {"dex":288}, {"dex":289}, {"dex":290}, {"dex":291},
      {"dex":292}, {"dex":293}, {"dex":294}, {"dex":295},
      {"dex":296}, {"dex":297}, {"dex":298}, {"dex":299},
      {"dex":300}, {"dex":301}, {"dex":302}, {"dex":303},
      {"dex":304}, {"dex":305}, {"dex":306}, {"dex":307},
      {"dex":308}, {"dex":309}, {"dex":310}, {"dex":311},
      {"dex":312}, {"dex":313}, {"dex":314}, {"dex":315},
      {"dex":316}, {"dex":317}, {"dex":318}, {"dex":319},
      {"dex":320}, {"dex":321}, {"dex":322}, {"dex":323},
      {"dex":324}, {"dex":325}, {"dex":326}, {"dex":327},
      {"dex":328}, {"dex":329}, {"dex":330}, {"dex":331},
      {"dex":332}, {"dex":333}, {"dex":334}, {"dex":335},
      {"dex":336}, {"dex":337}, {"dex":338}, {"dex":339},
      {"dex":340}, {"dex":341}, {"dex":342}, {"dex":343},
      {"dex":344}, {"dex":345}, {"dex":346}, {"dex":347},
      {"dex":348}, {"dex":349}, {"dex":350}, {"dex":351},
      {"dex":352}, {"dex":353}, {"dex":354}, {"dex":355},
      {"dex":356}, {"dex":357}, {"dex":358}, {"dex":359},
      {"dex":360}, {"dex":361}, {"dex":362}, {"dex":363},
      {"dex":364}, {"dex":365}, {"dex":366}, {"dex":367},
      {"dex":368}, {"dex":369}, {"dex":370}, {"dex":371},
      {"dex":372}, {"dex":373}, {"dex":374}, {"dex":375},
      {"dex":376},
    ],
    reward: {"gold":12,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "sinnoh-mythical-master",
    kind: "collection",
    region: "Sinnoh",
    collection: "Sinnoh Mythical Master",
    description: "All Sinnoh Mythicals",
    requires: [
      {"dex":489}, {"dex":490}, {"dex":491}, {"dex":492},
      {"dex":493},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "cloaked-up",
    kind: "collection",
    region: "Sinnoh",
    collection: "Cloaked Up",
    description: "All Burmy and Wormadam Forms",
    requires: [
      {"dex":412}, {"dex":412,"form":"Sandy"}, {"dex":412,"form":"Trash"}, {"dex":413},
      {"dex":413,"form":"Sandy"}, {"dex":413,"form":"Trash"},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "east-and-west",
    kind: "collection",
    region: "Sinnoh",
    collection: "East and West",
    description: "Both Shellos and Gastrodon Forms",
    requires: [
      {"dex":422,"form":"East"}, {"dex":422}, {"dex":423,"form":"East"}, {"dex":423},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "lake-mods",
    kind: "collection",
    region: "Sinnoh",
    collection: "Lake Mods",
    description: "All Three Lake Guardians",
    requires: [
      {"dex":480}, {"dex":481}, {"dex":482},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "sinnoh-beginner",
    kind: "collection",
    region: "Sinnoh",
    collection: "Sinnoh Beginner",
    description: "All Sinnoh Starters and Evolutions",
    requires: [
      {"dex":387}, {"dex":388}, {"dex":389}, {"dex":390},
      {"dex":391}, {"dex":392}, {"dex":393}, {"dex":394},
      {"dex":395},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "sinnoh-completionist",
    kind: "collection",
    region: "Sinnoh",
    collection: "Sinnoh Completionist",
    description: "Regional Sinnoh Dex Completion",
    requires: [
      {"dex":387}, {"dex":388}, {"dex":389}, {"dex":390},
      {"dex":391}, {"dex":392}, {"dex":393}, {"dex":394},
      {"dex":395}, {"dex":396}, {"dex":397}, {"dex":398},
      {"dex":399}, {"dex":400}, {"dex":401}, {"dex":402},
      {"dex":403}, {"dex":404}, {"dex":405}, {"dex":406},
      {"dex":407}, {"dex":408}, {"dex":409}, {"dex":410},
      {"dex":411}, {"dex":412}, {"dex":413}, {"dex":414},
      {"dex":415}, {"dex":416}, {"dex":417}, {"dex":418},
      {"dex":419}, {"dex":420}, {"dex":421}, {"dex":422},
      {"dex":423}, {"dex":424}, {"dex":425}, {"dex":426},
      {"dex":427}, {"dex":428}, {"dex":429}, {"dex":430},
      {"dex":431}, {"dex":432}, {"dex":433}, {"dex":434},
      {"dex":435}, {"dex":436}, {"dex":437}, {"dex":438},
      {"dex":439}, {"dex":440}, {"dex":441}, {"dex":442},
      {"dex":443}, {"dex":444}, {"dex":445}, {"dex":446},
      {"dex":447}, {"dex":448}, {"dex":449}, {"dex":450},
      {"dex":451}, {"dex":452}, {"dex":453}, {"dex":454},
      {"dex":455}, {"dex":456}, {"dex":457}, {"dex":458},
      {"dex":459}, {"dex":460}, {"dex":461}, {"dex":462},
      {"dex":463}, {"dex":464}, {"dex":465}, {"dex":466},
      {"dex":467}, {"dex":468}, {"dex":469}, {"dex":470},
      {"dex":471}, {"dex":472}, {"dex":473}, {"dex":474},
      {"dex":475}, {"dex":476}, {"dex":477}, {"dex":478},
      {"dex":479},
    ],
    reward: {"gold":9,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "motor-motor",
    kind: "collection",
    region: "Sinnoh",
    collection: "MOTOR MOTOR",
    description: "All Rotom Forms",
    requires: [
      {"dex":479}, {"dex":479,"form":"Heat"}, {"dex":479,"form":"Wash"}, {"dex":479,"form":"Frost"},
      {"dex":479,"form":"Fan"}, {"dex":479,"form":"Mow"},
    ],
    reward: {"gold":2,"coins":0,"items":[]},
    notes: "contributed by Jack",
  },

  {
    id: "deer-friend",
    kind: "collection",
    region: "Unova",
    collection: "Deer Friend",
    description: "All Deerling and Sawsbuck Forms",
    requires: [
      {"dex":585}, {"dex":585,"form":"Summer"}, {"dex":585,"form":"Autumn"}, {"dex":585,"form":"Winter"},
      {"dex":586}, {"dex":586,"form":"Summer"}, {"dex":586,"form":"Autumn"}, {"dex":586,"form":"Winter"},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "justiciaries",
    kind: "collection",
    region: "Unova",
    collection: "Justiciaries",
    description: "Swords of Justice",
    requires: [
      {"dex":638}, {"dex":639}, {"dex":640},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "unova-beginner",
    kind: "collection",
    region: "Unova",
    collection: "Unova Beginner",
    description: "All Unova Starters and Evolutions",
    requires: [
      {"dex":495}, {"dex":496}, {"dex":497}, {"dex":498},
      {"dex":499}, {"dex":500}, {"dex":501}, {"dex":502},
      {"dex":503},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "unova-completionist",
    kind: "collection",
    region: "Unova",
    collection: "Unova Completionist",
    description: "Regional Unova Dex Completion",
    requires: [
      {"dex":495}, {"dex":496}, {"dex":497}, {"dex":498},
      {"dex":499}, {"dex":500}, {"dex":501}, {"dex":502},
      {"dex":503}, {"dex":504}, {"dex":505}, {"dex":506},
      {"dex":507}, {"dex":508}, {"dex":509}, {"dex":510},
      {"dex":511}, {"dex":512}, {"dex":513}, {"dex":514},
      {"dex":515}, {"dex":516}, {"dex":517}, {"dex":518},
      {"dex":519}, {"dex":520}, {"dex":521}, {"dex":522},
      {"dex":523}, {"dex":524}, {"dex":525}, {"dex":526},
      {"dex":527}, {"dex":528}, {"dex":529}, {"dex":530},
      {"dex":531}, {"dex":532}, {"dex":533}, {"dex":534},
      {"dex":535}, {"dex":536}, {"dex":537}, {"dex":538},
      {"dex":539}, {"dex":540}, {"dex":541}, {"dex":542},
      {"dex":543}, {"dex":544}, {"dex":545}, {"dex":546},
      {"dex":547}, {"dex":548}, {"dex":549}, {"dex":550},
      {"dex":551}, {"dex":552}, {"dex":553}, {"dex":554},
      {"dex":555}, {"dex":556}, {"dex":557}, {"dex":558},
      {"dex":559}, {"dex":560}, {"dex":561}, {"dex":562},
      {"dex":563}, {"dex":564}, {"dex":565}, {"dex":566},
      {"dex":567}, {"dex":568}, {"dex":569}, {"dex":570},
      {"dex":571}, {"dex":572}, {"dex":573}, {"dex":574},
      {"dex":575}, {"dex":576}, {"dex":577}, {"dex":578},
      {"dex":579}, {"dex":580}, {"dex":581}, {"dex":582},
      {"dex":583}, {"dex":584}, {"dex":585}, {"dex":586},
      {"dex":587}, {"dex":588}, {"dex":589}, {"dex":590},
      {"dex":591}, {"dex":592}, {"dex":593}, {"dex":594},
      {"dex":595}, {"dex":596}, {"dex":597}, {"dex":598},
      {"dex":599}, {"dex":600}, {"dex":601}, {"dex":602},
      {"dex":603}, {"dex":604}, {"dex":605}, {"dex":606},
      {"dex":607}, {"dex":608}, {"dex":609}, {"dex":610},
      {"dex":611}, {"dex":612}, {"dex":613}, {"dex":614},
      {"dex":615}, {"dex":616}, {"dex":617}, {"dex":618},
      {"dex":619}, {"dex":620}, {"dex":621}, {"dex":622},
      {"dex":623}, {"dex":624}, {"dex":625}, {"dex":626},
      {"dex":627}, {"dex":628}, {"dex":629}, {"dex":630},
      {"dex":631}, {"dex":632}, {"dex":633}, {"dex":634},
      {"dex":635}, {"dex":636}, {"dex":637},
    ],
    reward: {"gold":14,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "monkey-madness",
    kind: "collection",
    region: "Unova",
    collection: "Monkey Madness",
    description: "All Elemental Monkeys",
    requires: [
      {"dex":511}, {"dex":512}, {"dex":513}, {"dex":514},
      {"dex":515}, {"dex":516},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Jack",
  },

  {
    id: "unova-mythical-master",
    kind: "collection",
    region: "Unova",
    collection: "Unova Mythical Master",
    description: "All Unova Mythicals",
    requires: [
      {"dex":494}, {"dex":647}, {"dex":648}, {"dex":649},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "dragon-emperor",
    kind: "collection",
    region: "Unova",
    collection: "Dragon Emperor",
    description: "Unova Legendary Dragons",
    requires: [
      {"dex":643}, {"dex":644}, {"dex":646},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "kalos-beginner",
    kind: "collection",
    region: "Kalos",
    collection: "Kalos Beginner",
    description: "All Kalos Starters and Evolutions",
    requires: [
      {"dex":650}, {"dex":651}, {"dex":652}, {"dex":653},
      {"dex":654}, {"dex":655}, {"dex":656}, {"dex":657},
      {"dex":658},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "kalos-completionist",
    kind: "collection",
    region: "Kalos",
    collection: "Kalos Completionist",
    description: "Regional Kalos Dex Completion",
    requires: [
      {"dex":650}, {"dex":651}, {"dex":652}, {"dex":653},
      {"dex":654}, {"dex":655}, {"dex":656}, {"dex":657},
      {"dex":658}, {"dex":659}, {"dex":660}, {"dex":661},
      {"dex":662}, {"dex":663}, {"dex":664}, {"dex":665},
      {"dex":666}, {"dex":667}, {"dex":668}, {"dex":669},
      {"dex":670}, {"dex":671}, {"dex":672}, {"dex":673},
      {"dex":674}, {"dex":675}, {"dex":676}, {"dex":677},
      {"dex":678}, {"dex":679}, {"dex":680}, {"dex":681},
      {"dex":682}, {"dex":683}, {"dex":684}, {"dex":685},
      {"dex":686}, {"dex":687}, {"dex":688}, {"dex":689},
      {"dex":690}, {"dex":691}, {"dex":692}, {"dex":693},
      {"dex":694}, {"dex":695}, {"dex":696}, {"dex":697},
      {"dex":698}, {"dex":699}, {"dex":700}, {"dex":701},
      {"dex":702}, {"dex":703}, {"dex":704}, {"dex":705},
      {"dex":706}, {"dex":707}, {"dex":708}, {"dex":709},
      {"dex":710}, {"dex":711}, {"dex":712}, {"dex":713},
      {"dex":714}, {"dex":715},
    ],
    reward: {"gold":6,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "flower-power",
    kind: "collection",
    region: "Kalos",
    collection: "Flower Power",
    description: "All Colors of Flabebe, Floette, and Florges",
    requires: [
      {"dex":669}, {"dex":669,"form":"Blue"}, {"dex":669,"form":"Yellow"}, {"dex":669,"form":"White"},
      {"dex":669,"form":"Orange"}, {"dex":670}, {"dex":670,"form":"Blue"}, {"dex":670,"form":"Yellow"},
      {"dex":670,"form":"White"}, {"dex":670,"form":"Orange"}, {"dex":671}, {"dex":671,"form":"Blue"},
      {"dex":671,"form":"Yellow"}, {"dex":671,"form":"White"}, {"dex":671,"form":"Orange"},
    ],
    reward: {"gold":2,"coins":0,"items":[]},
    notes: "contributed by Jack",
  },

  {
    id: "butterfly-collector",
    kind: "collection",
    region: "Kalos",
    collection: "Butterfly Collector",
    description: "All Vivillon Forms",
    requires: [
      {"dex":666}, {"dex":666,"form":"Archipelago"}, {"dex":666,"form":"Continental"}, {"dex":666,"form":"Elegant"},
      {"dex":666,"form":"Fancy"}, {"dex":666,"form":"Garden"}, {"dex":666,"form":"High Plains"}, {"dex":666,"form":"Icy Snow"},
      {"dex":666,"form":"Jungle"}, {"dex":666,"form":"Marine"}, {"dex":666,"form":"Modern"}, {"dex":666,"form":"Monsoon"},
      {"dex":666,"form":"Ocean"}, {"dex":666,"form":"Poke Ball"}, {"dex":666,"form":"Polar"}, {"dex":666,"form":"River"},
      {"dex":666,"form":"Sandstorm"}, {"dex":666,"form":"Savanna"}, {"dex":666,"form":"Sun"}, {"dex":666,"form":"Tundra"},
    ],
    reward: {"gold":3,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "auramaxxing",
    kind: "collection",
    region: "Kalos",
    collection: "Auramaxxing",
    description: "All Three Aura Trio Pokemon",
    requires: [
      {"dex":716}, {"dex":717}, {"dex":718},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "kalos-mythical-master",
    kind: "collection",
    region: "Kalos",
    collection: "Kalos Mythical Master",
    description: "All Kalos Mythicals",
    requires: [
      {"dex":719}, {"dex":720}, {"dex":721},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "alola-beginner",
    kind: "collection",
    region: "Alola",
    collection: "Alola Beginner",
    description: "All Alola Starters and Evolutions",
    requires: [
      {"dex":722}, {"dex":723}, {"dex":724}, {"dex":725},
      {"dex":726}, {"dex":727}, {"dex":728}, {"dex":729},
      {"dex":730},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "alola-completionist",
    kind: "collection",
    region: "Alola",
    collection: "Alola Completionist",
    description: "Regional Alola Dex Completion",
    requires: [
      {"dex":722}, {"dex":723}, {"dex":724}, {"dex":725},
      {"dex":726}, {"dex":727}, {"dex":728}, {"dex":729},
      {"dex":730}, {"dex":731}, {"dex":732}, {"dex":733},
      {"dex":734}, {"dex":735}, {"dex":736}, {"dex":737},
      {"dex":738}, {"dex":739}, {"dex":740}, {"dex":741},
      {"dex":742}, {"dex":743}, {"dex":744}, {"dex":745},
      {"dex":746}, {"dex":747}, {"dex":748}, {"dex":749},
      {"dex":750}, {"dex":751}, {"dex":752}, {"dex":753},
      {"dex":754}, {"dex":755}, {"dex":756}, {"dex":757},
      {"dex":758}, {"dex":759}, {"dex":760}, {"dex":761},
      {"dex":762}, {"dex":763}, {"dex":764}, {"dex":765},
      {"dex":766}, {"dex":767}, {"dex":768}, {"dex":769},
      {"dex":770}, {"dex":771}, {"dex":774}, {"dex":775},
      {"dex":776}, {"dex":777}, {"dex":778}, {"dex":779},
      {"dex":780}, {"dex":781}, {"dex":782}, {"dex":783},
      {"dex":784}, {"dex":19,"form":"Alola"}, {"dex":20,"form":"Alola"}, {"dex":26,"form":"Alola"},
      {"dex":27,"form":"Alola"}, {"dex":28,"form":"Alola"}, {"dex":37,"form":"Alola"}, {"dex":38,"form":"Alola"},
      {"dex":50,"form":"Alola"}, {"dex":51,"form":"Alola"}, {"dex":52,"form":"Alola"}, {"dex":53,"form":"Alola"},
      {"dex":74,"form":"Alola"}, {"dex":75,"form":"Alola"}, {"dex":76,"form":"Alola"}, {"dex":88,"form":"Alola"},
      {"dex":89,"form":"Alola"}, {"dex":103,"form":"Alola"}, {"dex":105,"form":"Alola"},
    ],
    reward: {"gold":6,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "oricorio-enthusiast",
    kind: "collection",
    region: "Alola",
    collection: "Oricorio Enthusiast",
    description: "All Oricorio Forms",
    requires: [
      {"dex":741}, {"dex":741,"form":"Pom Pom"}, {"dex":741,"form":"Pau"}, {"dex":741,"form":"Sensu"},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Jack",
  },

  {
    id: "not-quite-legendary",
    kind: "collection",
    region: "Alola",
    collection: "Not Quite Legendary",
    description: "All Ultra Beast Pokemon",
    requires: [
      {"dex":793}, {"dex":794}, {"dex":795}, {"dex":796},
      {"dex":797}, {"dex":798}, {"dex":799}, {"dex":803},
      {"dex":804}, {"dex":805}, {"dex":806},
    ],
    reward: {"gold":4,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "hard-core",
    kind: "collection",
    region: "Alola",
    collection: "Hard Core",
    description: "All Minior Forms",
    requires: [
      {"dex":774}, {"dex":774,"form":"Red"}, {"dex":774,"form":"Orange"}, {"dex":774,"form":"Yellow"},
      {"dex":774,"form":"Green"}, {"dex":774,"form":"Blue"}, {"dex":774,"form":"Indigo"}, {"dex":774,"form":"Violet"},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "akala-island-server-admins",
    kind: "collection",
    region: "Alola",
    collection: "Akala Island Server Admins",
    description: "All Four Guardian Deities",
    requires: [
      {"dex":785}, {"dex":786}, {"dex":787}, {"dex":788},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "legendary-bloodline",
    kind: "collection",
    region: "Alola",
    collection: "Legendary Bloodline",
    description: "All Cosmog Evolutions",
    requires: [
      {"dex":789}, {"dex":790}, {"dex":791}, {"dex":792},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "necrozma-gaming",
    kind: "collection",
    region: "Alola",
    collection: "Necrozma Gaming",
    description: "All Necrozma Forms",
    requires: [
      {"dex":800}, {"dex":800,"form":"Dusk"}, {"dex":800,"form":"Dawn"}, {"dex":800,"form":"Ultra"},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "alola-mythical-master",
    kind: "collection",
    region: "Alola",
    collection: "Alola Mythical Master",
    description: "All Alola Mythicals",
    requires: [
      {"dex":801}, {"dex":802}, {"dex":807}, {"dex":808},
      {"dex":809},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "bird-watching-extremist",
    kind: "collection",
    region: "Galar",
    collection: "Bird Watching Extremist",
    description: "Galar Legendary Birds",
    requires: [
      {"dex":144,"form":"Galar"}, {"dex":145,"form":"Galar"}, {"dex":146,"form":"Galar"},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "galar-beginner",
    kind: "collection",
    region: "Galar",
    collection: "Galar Beginner",
    description: "All Galar Starters and Evolutions",
    requires: [
      {"dex":810}, {"dex":811}, {"dex":812}, {"dex":813},
      {"dex":814}, {"dex":815}, {"dex":816}, {"dex":817},
      {"dex":818},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "galar-completionist",
    kind: "collection",
    region: "Galar",
    collection: "Galar Completionist",
    description: "Regional Galar Dex Completion",
    requires: [
      {"dex":810}, {"dex":811}, {"dex":812}, {"dex":813},
      {"dex":814}, {"dex":815}, {"dex":816}, {"dex":817},
      {"dex":818}, {"dex":819}, {"dex":820}, {"dex":821},
      {"dex":822}, {"dex":823}, {"dex":824}, {"dex":825},
      {"dex":826}, {"dex":827}, {"dex":828}, {"dex":829},
      {"dex":830}, {"dex":831}, {"dex":832}, {"dex":833},
      {"dex":834}, {"dex":835}, {"dex":836}, {"dex":837},
      {"dex":838}, {"dex":839}, {"dex":840}, {"dex":841},
      {"dex":842}, {"dex":843}, {"dex":844}, {"dex":845},
      {"dex":846}, {"dex":847}, {"dex":848}, {"dex":849},
      {"dex":850}, {"dex":851}, {"dex":852}, {"dex":853},
      {"dex":854}, {"dex":855}, {"dex":856}, {"dex":857},
      {"dex":858}, {"dex":859}, {"dex":860}, {"dex":861},
      {"dex":862}, {"dex":863}, {"dex":864}, {"dex":865},
      {"dex":866}, {"dex":867}, {"dex":868}, {"dex":869},
      {"dex":870}, {"dex":871}, {"dex":872}, {"dex":873},
      {"dex":874}, {"dex":875}, {"dex":876}, {"dex":877},
      {"dex":878}, {"dex":879}, {"dex":880}, {"dex":881},
      {"dex":882}, {"dex":883}, {"dex":884}, {"dex":885},
      {"dex":886}, {"dex":887}, {"dex":52,"form":"Galar"}, {"dex":77,"form":"Galar"},
      {"dex":78,"form":"Galar"}, {"dex":79,"form":"Galar"}, {"dex":80,"form":"Galar"}, {"dex":83,"form":"Galar"},
      {"dex":110,"form":"Galar"}, {"dex":122,"form":"Galar"}, {"dex":199,"form":"Galar"}, {"dex":222,"form":"Galar"},
      {"dex":263,"form":"Galar"}, {"dex":264,"form":"Galar"}, {"dex":554,"form":"Galar"}, {"dex":555,"form":"Galar Standard"},
      {"dex":555,"form":"Galar Zen"}, {"dex":562,"form":"Galar"}, {"dex":618,"form":"Galar"},
    ],
    reward: {"gold":8,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "doctor-hater",
    kind: "collection",
    region: "Galar",
    collection: "Doctor Hater",
    description: "All Apple Pokemon",
    requires: [
      {"dex":840}, {"dex":841}, {"dex":842}, {"dex":1019},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "darkest-day-roleplaying",
    kind: "collection",
    region: "Galar",
    collection: "Darkest Day Roleplaying",
    description: "All Darkest Day Event Pokemon",
    requires: [
      {"dex":888}, {"dex":889}, {"dex":890},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "king-for-a-day",
    kind: "collection",
    region: "Galar",
    collection: "King For A Day",
    description: "All Calyrex Forms",
    requires: [
      {"dex":898}, {"dex":898,"form":"Ice"}, {"dex":898,"form":"Shadow"},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "dragon-patrol",
    kind: "collection",
    region: "Paldea",
    collection: "Dragon Patrol",
    description: "Paldea Legendary Beasts",
    requires: [
      {"dex":1009}, {"dex":1020}, {"dex":1021},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "paldea-beginner",
    kind: "collection",
    region: "Paldea",
    collection: "Paldea Beginner",
    description: "All Paldea Starters and Evolutions",
    requires: [
      {"dex":906}, {"dex":907}, {"dex":908}, {"dex":909},
      {"dex":910}, {"dex":911}, {"dex":912}, {"dex":913},
      {"dex":914},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "paldea-completionist",
    kind: "collection",
    region: "Paldea",
    collection: "Paldea Completionist",
    description: "Regional Paldea Dex Completion",
    requires: [
      {"dex":906}, {"dex":907}, {"dex":908}, {"dex":909},
      {"dex":910}, {"dex":911}, {"dex":912}, {"dex":913},
      {"dex":914}, {"dex":915}, {"dex":916}, {"dex":917},
      {"dex":918}, {"dex":919}, {"dex":920}, {"dex":921},
      {"dex":922}, {"dex":923}, {"dex":924}, {"dex":925},
      {"dex":926}, {"dex":927}, {"dex":928}, {"dex":929},
      {"dex":930}, {"dex":931}, {"dex":932}, {"dex":933},
      {"dex":934}, {"dex":935}, {"dex":936}, {"dex":937},
      {"dex":938}, {"dex":939}, {"dex":940}, {"dex":941},
      {"dex":942}, {"dex":943}, {"dex":944}, {"dex":945},
      {"dex":946}, {"dex":947}, {"dex":948}, {"dex":949},
      {"dex":950}, {"dex":951}, {"dex":952}, {"dex":953},
      {"dex":954}, {"dex":955}, {"dex":956}, {"dex":957},
      {"dex":958}, {"dex":959}, {"dex":960}, {"dex":961},
      {"dex":962}, {"dex":963}, {"dex":964}, {"dex":965},
      {"dex":966}, {"dex":967}, {"dex":968}, {"dex":969},
      {"dex":970}, {"dex":971}, {"dex":972}, {"dex":973},
      {"dex":974}, {"dex":975}, {"dex":976}, {"dex":977},
      {"dex":978}, {"dex":979}, {"dex":980}, {"dex":981},
      {"dex":982}, {"dex":983}, {"dex":984}, {"dex":985},
      {"dex":986}, {"dex":987}, {"dex":988}, {"dex":989},
      {"dex":990}, {"dex":991}, {"dex":992}, {"dex":993},
      {"dex":994}, {"dex":995}, {"dex":996}, {"dex":997},
      {"dex":998}, {"dex":999}, {"dex":1000}, {"dex":1005},
      {"dex":1006}, {"dex":1011}, {"dex":1012}, {"dex":1013},
      {"dex":1018}, {"dex":1019}, {"dex":128,"form":"Paldea Combat Breed"}, {"dex":128,"form":"Paldea Blaze Breed"},
      {"dex":128,"form":"Paldea Aqua Breed"}, {"dex":194,"form":"Paldea"},
    ],
    reward: {"gold":10,"coins":0,"items":[]},
    notes: "Legends and Mythicals excluded. Contributed by Neil.",
  },

  {
    id: "an-ancient-paradox",
    kind: "collection",
    region: "Paldea",
    collection: "An Ancient Paradox",
    description: "All Ancient Paradox Pokemon",
    requires: [
      {"dex":984}, {"dex":985}, {"dex":986}, {"dex":987},
      {"dex":988}, {"dex":989}, {"dex":1005}, {"dex":1007},
      {"dex":1009}, {"dex":1020}, {"dex":1021},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "a-future-paradox",
    kind: "collection",
    region: "Paldea",
    collection: "A Future Paradox",
    description: "All Future Paradox Pokemon",
    requires: [
      {"dex":990}, {"dex":991}, {"dex":992}, {"dex":993},
      {"dex":994}, {"dex":995}, {"dex":1006}, {"dex":1008},
      {"dex":1010}, {"dex":1022}, {"dex":1023},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "future-justiciaries",
    kind: "collection",
    region: "Paldea",
    collection: "Future Justiciaries",
    description: "Swords of Justice Paradox Pokemon",
    requires: [
      {"dex":1010}, {"dex":1022}, {"dex":1023},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "bring-back-bullying",
    kind: "collection",
    region: "Paldea",
    collection: "Bring Back Bullying",
    description: "All Teal Mask Legendary Pokemon",
    requires: [
      {"dex":1014}, {"dex":1015}, {"dex":1016}, {"dex":1017},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Dillon",
  },

  {
    id: "alphabet-soup",
    kind: "collection",
    region: "Multiple",
    collection: "Alphabet soup",
    description: "Unown Letters",
    requires: [
      {"dex":201}, {"dex":201,"form":"B"}, {"dex":201,"form":"C"}, {"dex":201,"form":"D"},
      {"dex":201,"form":"E"}, {"dex":201,"form":"F"}, {"dex":201,"form":"G"}, {"dex":201,"form":"H"},
      {"dex":201,"form":"I"}, {"dex":201,"form":"J"}, {"dex":201,"form":"K"}, {"dex":201,"form":"L"},
      {"dex":201,"form":"M"}, {"dex":201,"form":"N"}, {"dex":201,"form":"O"}, {"dex":201,"form":"P"},
      {"dex":201,"form":"Q"}, {"dex":201,"form":"R"}, {"dex":201,"form":"S"}, {"dex":201,"form":"T"},
      {"dex":201,"form":"U"}, {"dex":201,"form":"V"}, {"dex":201,"form":"W"}, {"dex":201,"form":"X"},
      {"dex":201,"form":"Y"}, {"dex":201,"form":"Z"}, {"dex":201,"form":"Exclamation"}, {"dex":201,"form":"Question"},
    ],
    reward: {"gold":4,"coins":0,"items":[]},
    notes: "contributed by Jack",
  },

  {
    id: "quest",
    kind: "collection",
    region: "Multiple",
    collection: "⍑ᒷ  ᓭ⚍リ  ∷",
    description: "All Regis",
    requires: [
      {"dex":377}, {"dex":378}, {"dex":379}, {"dex":486},
      {"dex":894}, {"dex":895},
    ],
    reward: {"gold":3,"coins":0,"items":[]},
    notes: "contributed by Jack",
  },

  {
    id: "porygon-collector",
    kind: "collection",
    region: "Multiple",
    collection: "Porygon Collector",
    description: "All Porygons",
    requires: [
      {"dex":137}, {"dex":233}, {"dex":474},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "light-snack",
    kind: "collection",
    region: "Multiple",
    collection: "Light Snack",
    description: "Set Meal of Food Pokemon",
    requires: [
      {"dex":43}, {"dex":582}, {"dex":840}, {"dex":926},
      {"dex":978},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Neil",
  },

  {
    id: "eevee-petter",
    kind: "collection",
    region: "Multiple",
    collection: "Eevee Petter",
    description: "Eevee and all Eevee Evolutions",
    requires: [
      {"dex":133}, {"dex":134}, {"dex":135}, {"dex":136},
      {"dex":196}, {"dex":197}, {"dex":470}, {"dex":471},
      {"dex":700},
    ],
    reward: {"gold":1,"coins":0,"items":[]},
    notes: "contributed by Neil",
  },

  {
    id: "gone-fishing",
    kind: "collection",
    region: "Multiple",
    collection: "Gone Fishing",
    description: "All Basculin/Basculegion Forms",
    requires: [
      {"dex":550}, {"dex":550,"form":"Blue Striped"}, {"dex":550,"form":"White Striped"}, {"dex":902},
      {"dex":902,"form":"Female"},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "tauros-breeder",
    kind: "collection",
    region: "Multiple",
    collection: "Tauros Breeder",
    description: "All Tauros Breeds",
    requires: [
      {"dex":128}, {"dex":128,"form":"Paldea Combat Breed"}, {"dex":128,"form":"Paldea Blaze Breed"}, {"dex":128,"form":"Paldea Aqua Breed"},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "time-and-space-lovers",
    kind: "collection",
    region: "Multiple",
    collection: "Time and Space Lovers",
    description: "Celebi and Sinnoh Main Characters",
    requires: [
      {"dex":251}, {"dex":483}, {"dex":484}, {"dex":487},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "lamp-rubber",
    kind: "collection",
    region: "Multiple",
    collection: "Lamp Rubber",
    description: "All Genie Pokemon",
    requires: [
      {"dex":641}, {"dex":642}, {"dex":645}, {"dex":905},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "contributed by Dillon",
  },

  {
    id: "hisui-completionist",
    kind: "collection",
    region: "Hisui",
    collection: "Hisui Completionist",
    description: "Regional Hisui Dex Completion",
    requires: [
      {"dex":899}, {"dex":900}, {"dex":901}, {"dex":902},
      {"dex":903}, {"dex":904}, {"dex":58,"form":"Hisui"}, {"dex":59,"form":"Hisui"},
      {"dex":100,"form":"Hisui"}, {"dex":101,"form":"Hisui"}, {"dex":157,"form":"Hisui"}, {"dex":211,"form":"Hisui"},
      {"dex":215,"form":"Hisui"}, {"dex":503,"form":"Hisui"}, {"dex":549,"form":"Hisui"}, {"dex":570,"form":"Hisui"},
      {"dex":571,"form":"Hisui"}, {"dex":628,"form":"Hisui"}, {"dex":705,"form":"Hisui"}, {"dex":706,"form":"Hisui"},
      {"dex":713,"form":"Hisui"}, {"dex":724,"form":"Hisui"},
    ],
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
    notes: "Hisui species were previously part of the Galar dex.",
  },

  {
    id: "shiny-dropper",
    kind: "achievement",
    region: "Achievements",
    collection: "Shiny Dropper",
    description: "Drop a Shiny Without an Incense",
    goal: {"kind":"shiny-caught","count":1,"withoutIncense":true},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "normal-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Normal Beginner",
    description: "Catch 10 Normal Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"normal"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "fire-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Fire Beginner",
    description: "Catch 10 Fire Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"fire"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "fighting-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Fighting Beginner",
    description: "Catch 10 Fighting Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"fighting"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "water-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Water Beginner",
    description: "Catch 10 Water Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"water"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "flying-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Flying Beginner",
    description: "Catch 10 Flying Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"flying"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "grass-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Grass Beginner",
    description: "Catch 10 Grass Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"grass"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "poison-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Poison Beginner",
    description: "Catch 10 Poison Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"poison"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "electric-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Electric Beginner",
    description: "Catch 10 Electric Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"electric"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "ground-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Ground Beginner",
    description: "Catch 10 Ground Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"ground"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "psychic-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Psychic Beginner",
    description: "Catch 10 Psychic Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"psychic"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "rock-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Rock Beginner",
    description: "Catch 10 Rock Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"rock"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "ice-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Ice Beginner",
    description: "Catch 10 Ice Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"ice"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "bug-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Bug Beginner",
    description: "Catch 10 Bug Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"bug"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "dragon-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Dragon Beginner",
    description: "Catch 10 Dragon Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"dragon"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "ghost-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Ghost Beginner",
    description: "Catch 10 Ghost Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"ghost"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "dark-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Dark Beginner",
    description: "Catch 10 Dark Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"dark"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "steel-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Steel Beginner",
    description: "Catch 10 Steel Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"steel"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "fairy-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Fairy Beginner",
    description: "Catch 10 Fairy Type Pokemon",
    goal: {"kind":"type-caught","count":10,"type":"fairy"},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "normal-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Normal Novice",
    description: "Catch 100 Normal Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"normal"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "fire-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Fire Novice",
    description: "Catch 100 Fire Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"fire"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "fighting-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Fighting Novice",
    description: "Catch 100 Fighting Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"fighting"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "water-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Water Novice",
    description: "Catch 100 Water Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"water"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "flying-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Flying Novice",
    description: "Catch 100 Flying Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"flying"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "grass-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Grass Novice",
    description: "Catch 100 Grass Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"grass"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "poison-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Poison Novice",
    description: "Catch 100 Poison Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"poison"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "electric-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Electric Novice",
    description: "Catch 100 Electric Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"electric"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "ground-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Ground Novice",
    description: "Catch 100 Ground Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"ground"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "psychic-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Psychic Novice",
    description: "Catch 100 Psychic Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"psychic"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "rock-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Rock Novice",
    description: "Catch 100 Rock Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"rock"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "ice-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Ice Novice",
    description: "Catch 100 Ice Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"ice"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "bug-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Bug Novice",
    description: "Catch 100 Bug Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"bug"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "dragon-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Dragon Novice",
    description: "Catch 100 Dragon Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"dragon"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "ghost-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Ghost Novice",
    description: "Catch 100 Ghost Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"ghost"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "dark-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Dark Novice",
    description: "Catch 100 Dark Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"dark"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "steel-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Steel Novice",
    description: "Catch 100 Steel Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"steel"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "fairy-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "Fairy Novice",
    description: "Catch 100 Fairy Type Pokemon",
    goal: {"kind":"type-caught","count":100,"type":"fairy"},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "normal-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Normal Master",
    description: "Catch 1000 Normal Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"normal"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "fire-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Fire Master",
    description: "Catch 1000 Fire Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"fire"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "fighting-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Fighting Master",
    description: "Catch 1000 Fighting Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"fighting"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "water-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Water Master",
    description: "Catch 1000 Water Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"water"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "flying-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Flying Master",
    description: "Catch 1000 Flying Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"flying"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "grass-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Grass Master",
    description: "Catch 1000 Grass Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"grass"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "poison-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Poison Master",
    description: "Catch 1000 Poison Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"poison"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "electric-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Electric Master",
    description: "Catch 1000 Electric Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"electric"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "ground-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Ground Master",
    description: "Catch 1000 Ground Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"ground"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "psychic-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Psychic Master",
    description: "Catch 1000 Psychic Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"psychic"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "rock-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Rock Master",
    description: "Catch 1000 Rock Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"rock"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "ice-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Ice Master",
    description: "Catch 1000 Ice Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"ice"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "bug-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Bug Master",
    description: "Catch 1000 Bug Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"bug"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "dragon-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Dragon Master",
    description: "Catch 1000 Dragon Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"dragon"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "ghost-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Ghost Master",
    description: "Catch 1000 Ghost Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"ghost"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "dark-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Dark Master",
    description: "Catch 1000 Dark Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"dark"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "steel-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Steel Master",
    description: "Catch 1000 Steel Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"steel"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "fairy-master",
    kind: "achievement",
    region: "Achievements",
    collection: "Fairy Master",
    description: "Catch 1000 Fairy Type Pokemon",
    goal: {"kind":"type-caught","count":1000,"type":"fairy"},
    reward: {"gold":3,"coins":0,"items":[]},
  },

  {
    id: "pokedropper-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "PokeDropper Beginner",
    description: "Catch 10 Pokemon",
    goal: {"kind":"total-caught","count":10},
    reward: {"gold":0,"coins":0,"items":["lootbox"]},
  },

  {
    id: "pokedropper-apprentice",
    kind: "achievement",
    region: "Achievements",
    collection: "PokeDropper Apprentice",
    description: "Catch 100 Pokemon",
    goal: {"kind":"total-caught","count":100},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "pokedropper-novice",
    kind: "achievement",
    region: "Achievements",
    collection: "PokeDropper Novice",
    description: "Catch 1000 Pokemon",
    goal: {"kind":"total-caught","count":1000},
    reward: {"gold":5,"coins":0,"items":[]},
  },

  {
    id: "pokedropper-elite",
    kind: "achievement",
    region: "Achievements",
    collection: "PokeDropper Elite",
    description: "Catch 5000 Pokemon",
    goal: {"kind":"total-caught","count":5000},
    reward: {"gold":10,"coins":0,"items":[]},
  },

  {
    id: "pokedropper-master",
    kind: "achievement",
    region: "Achievements",
    collection: "PokeDropper Master",
    description: "Catch 10000 Pokemon",
    goal: {"kind":"total-caught","count":10000},
    reward: {"gold":20,"coins":0,"items":[]},
  },

  {
    id: "shopping-beginner",
    kind: "achievement",
    region: "Achievements",
    collection: "Shopping Beginner",
    description: "Spend 1000 Coins",
    goal: {"kind":"coins-spent","count":1000},
    reward: {"gold":1,"coins":0,"items":[]},
  },

  {
    id: "shopping-apprentice",
    kind: "achievement",
    region: "Achievements",
    collection: "Shopping Apprentice",
    description: "Spend 10000 Coins",
    goal: {"kind":"coins-spent","count":10000},
    reward: {"gold":5,"coins":0,"items":[]},
  },

  {
    id: "shopping-apprentice-2",
    kind: "achievement",
    region: "Achievements",
    collection: "Shopping Apprentice",
    description: "Spend 50000 Coins",
    goal: {"kind":"coins-spent","count":50000},
    reward: {"gold":10,"coins":0,"items":[]},
  },

  {
    id: "shopping-elite",
    kind: "achievement",
    region: "Achievements",
    collection: "Shopping Elite",
    description: "Spend 100000 Coins",
    goal: {"kind":"coins-spent","count":100000},
    reward: {"gold":20,"coins":0,"items":[]},
  },

];
