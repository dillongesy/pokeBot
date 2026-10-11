// Forms that PokeAPI does not carry, plus the gender splits it does.
//
// `forms`      extra forms importdata.js creates. `basedOn` is the PokeAPI
//              form they inherit stats and typing from; `art`/`shiny` are
//              downloaded to disk because there is no CDN url for them.
// `genderLock` a form that can only ever be one gender.
// `exclude`    PokeAPI forms left out of the roster.
// `rename`     nicer folder names for PokeAPI slugs.

module.exports = {
  forms: [
    {
      species: 384, slug: 'rayquaza-top-3-2024', name: 'Top 3 2024',
      basedOn: 'rayquaza',
      art: 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/e48d6b9d-3b1d-46a0-a254-3a448ec3a8a5/dei2o8s-d7cfdc9a-e5ab-44e4-96dd-522a00b9d15b.png?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1cm46YXBwOjdlMGQxODg5ODIyNjQzNzNhNWYwZDQxNWVhMGQyNmUwIiwiaXNzIjoidXJuOmFwcDo3ZTBkMTg4OTgyMjY0MzczYTVmMGQ0MTVlYTBkMjZlMCIsIm9iaiI6W1t7InBhdGgiOiJcL2ZcL2U0OGQ2YjlkLTNiMWQtNDZhMC1hMjU0LTNhNDQ4ZWMzYThhNVwvZGVpMm84cy1kN2NmZGM5YS1lNWFiLTQ0ZTQtOTZkZC01MjJhMDBiOWQxNWIucG5nIn1dXSwiYXVkIjpbInVybjpzZXJ2aWNlOmZpbGUuZG93bmxvYWQiXX0.8xe0LEb27dYaqaVWbk2fZ6bkxtVvDdafiutevBPIxvM',
      shiny: 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/f/e48d6b9d-3b1d-46a0-a254-3a448ec3a8a5/dei2o8s-d7cfdc9a-e5ab-44e4-96dd-522a00b9d15b.png?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1cm46YXBwOjdlMGQxODg5ODIyNjQzNzNhNWYwZDQxNWVhMGQyNmUwIiwiaXNzIjoidXJuOmFwcDo3ZTBkMTg4OTgyMjY0MzczYTVmMGQ0MTVlYTBkMjZlMCIsIm9iaiI6W1t7InBhdGgiOiJcL2ZcL2U0OGQ2YjlkLTNiMWQtNDZhMC1hMjU0LTNhNDQ4ZWMzYThhNVwvZGVpMm84cy1kN2NmZGM5YS1lNWFiLTQ0ZTQtOTZkZC01MjJhMDBiOWQxNWIucG5nIn1dXSwiYXVkIjpbInVybjpzZXJ2aWNlOmZpbGUuZG93bmxvYWQiXX0.8xe0LEb27dYaqaVWbk2fZ6bkxtVvDdafiutevBPIxvM',
    },
    {
      species: 643, slug: 'reshiram-overdrive', name: 'Overdrive',
      basedOn: 'reshiram',
      art: 'https://archives.bulbagarden.net/media/upload/3/33/0643Reshiram-Activated.png',
      shiny: 'https://i.ibb.co/kg2dBLf/643-Reshiram-Activated.png',
    },
    {
      species: 644, slug: 'zekrom-overdrive', name: 'Overdrive',
      basedOn: 'zekrom',
      art: 'https://archives.bulbagarden.net/media/upload/6/6b/0644Zekrom-Activated.png',
      shiny: 'https://i.ibb.co/SXYqZNj/644-Zekrom-Activated.png',
    },
    {
      species: 802, slug: 'marshadow-zenith', name: 'Zenith',
      basedOn: 'marshadow',
      art: 'https://archives.bulbagarden.net/media/upload/6/6e/0802Marshadow-Alt.png',
      shiny: 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/i/e48d6b9d-3b1d-46a0-a254-3a448ec3a8a5/ddn43ra-94a76142-591e-4f64-917a-3659635d4bff.png',
    },
    {
      species: 521, slug: 'unfezant-male', name: 'Male',
      basedOn: 'unfezant', gender: 'male',
      art: 'https://archives.bulbagarden.net/media/upload/2/2e/0521Unfezant-Male.png',
      shiny: 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/i/e48d6b9d-3b1d-46a0-a254-3a448ec3a8a5/ddkef3u-d2f86c4f-53c5-4c06-b6cb-327991520786.png/v1/fill/w_846,h_846/_521_unfezant__male__by_tonofdirt726_ddkef3u-fullview.png',
    },
    {
      species: 521, slug: 'unfezant-female', name: 'Female',
      basedOn: 'unfezant', gender: 'female',
      art: 'https://archives.bulbagarden.net/media/upload/d/d9/0521Unfezant-Female.png',
      shiny: 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/i/e48d6b9d-3b1d-46a0-a254-3a448ec3a8a5/ddkef7a-f8a497e7-ed43-4a1c-a054-3cf0a2746b76.png',
    },
  ],

  genderLock: {
    'basculegion-female': 'female',
    'basculegion-male': 'male',
    'frillish-female': 'female',
    'frillish-male': 'male',
    'indeedee-female': 'female',
    'indeedee-male': 'male',
    'jellicent-female': 'female',
    'jellicent-male': 'male',
    'meowstic-female': 'female',
    'meowstic-male': 'male',
    'oinkologne-female': 'female',
    'oinkologne-male': 'male',
    'pyroar-female': 'female',
    'pyroar-male': 'male',
    'unfezant-female': 'female',
    'unfezant-male': 'male',
  },

  exclude: ['unfezant', 'minior-orange-meteor', 'minior-yellow-meteor', 'minior-green-meteor', 'minior-blue-meteor', 'minior-indigo-meteor', 'minior-violet-meteor'],

  rename: {
    'minior-red-meteor': 'Meteor',
  },
};
