// Default rules and species. Everything here can be changed in the admin panel.

export const CATEGORIES = ['carnivore', 'herbivore', 'omnivore'];

// scope: who a species may talk to
//   species  - same species only
//   category - anything in the same diet category
//   all      - any species
export const SCOPES = ['species', 'category', 'all'];

const sp = (name, category, extraClassNames = []) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  category,
  // Class names the game reports for this species. Matching ignores case,
  // a "BP_" prefix and a "_C" suffix, so "BP_Carnotaurus_C" matches "Carnotaurus".
  classNames: [name, ...extraClassNames],
  rule: null // null = follow the category rule
});

export function defaultSettings() {
  return {
    categories: {
      carnivore: { scope: 'species', requireGroup: true },
      herbivore: { scope: 'category', requireGroup: true },
      omnivore: { scope: 'species', requireGroup: true }
    },
    species: [
      sp('Carnotaurus', 'carnivore'),
      sp('Ceratosaurus', 'carnivore'),
      sp('Deinosuchus', 'carnivore'),
      sp('Dilophosaurus', 'carnivore'),
      sp('Herrerasaurus', 'carnivore'),
      sp('Omniraptor', 'carnivore'),
      sp('Pteranodon', 'carnivore'),
      sp('Troodon', 'carnivore'),
      sp('Diabloceratops', 'herbivore'),
      sp('Dryosaurus', 'herbivore'),
      sp('Hypsilophodon', 'herbivore'),
      sp('Maiasaura', 'herbivore'),
      sp('Pachycephalosaurus', 'herbivore'),
      sp('Stegosaurus', 'herbivore'),
      sp('Tenontosaurus', 'herbivore'),
      sp('Beipiaosaurus', 'omnivore'),
      sp('Gallimimus', 'omnivore')
    ],
    callMacro: { enabled: true },
    groups: { maxSize: 0 }, // 0 = no limit
    testAccess: { whitelist: [] }, // testing mode only: SteamIDs allowed to connect
    // Proximity: players only hear each other when their dinosaurs are close.
    // The game does not publish the range of the "F" call, so 100 m is a
    // starting estimate. Measure it on your server and adjust in the admin panel.
    proximity: { enabled: true, rangeMetres: 100, fade: true, updateSeconds: 3, unitsPerMetre: 100 },
    speciesSource: {
      type: 'manual', // rcon | legacy | manual
      recheckSeconds: 20,
      rcon: { host: '127.0.0.1', port: 8888, password: '' },
      legacy: { dir: '' }
    }
  };
}
