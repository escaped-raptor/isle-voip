import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings } from '../src/defaults.js';
import { canTalk, compatibleSpecies, distanceMetres, fadeGain, inRange, matchSpecies, normalizeClass } from '../src/policy.js';
import { parsePlayerData } from '../src/rcon.js';
import { sanitizeSettings } from '../src/store.js';

const s = defaultSettings();
const p = (speciesId, groupId = null) => ({ speciesId, groupId });

test('carnivores: same species + same group only', () => {
  assert.equal(canTalk(s, p('carnotaurus', 'A'), p('carnotaurus', 'A')), true);
  assert.equal(canTalk(s, p('carnotaurus', 'A'), p('carnotaurus', 'B')), false, 'different groups');
  assert.equal(canTalk(s, p('carnotaurus'), p('carnotaurus')), false, 'no group');
  assert.equal(canTalk(s, p('carnotaurus', 'A'), p('ceratosaurus', 'A')), false, 'different carnivores');
});

test('omnivores: same species + same group only', () => {
  assert.equal(canTalk(s, p('gallimimus', 'A'), p('gallimimus', 'A')), true);
  assert.equal(canTalk(s, p('gallimimus', 'A'), p('beipiaosaurus', 'A')), false);
});

test('herbivores: any herbivore in the same group', () => {
  assert.equal(canTalk(s, p('stegosaurus', 'A'), p('maiasaura', 'A')), true);
  assert.equal(canTalk(s, p('stegosaurus', 'A'), p('maiasaura', 'B')), false);
  assert.equal(canTalk(s, p('stegosaurus', 'A'), p('carnotaurus', 'A')), false, 'herbivore with carnivore');
});

test('unknown or missing species can never talk', () => {
  assert.equal(canTalk(s, p(null, 'A'), p('stegosaurus', 'A')), false);
  assert.equal(canTalk(s, p('nope', 'A'), p('nope', 'A')), false);
});

test('server provider can change category rules', () => {
  const c = structuredClone(s);
  c.categories.carnivore = { scope: 'category', requireGroup: false };
  assert.equal(canTalk(c, p('carnotaurus'), p('ceratosaurus')), true);
  assert.equal(canTalk(c, p('carnotaurus'), p('stegosaurus')), false);
});

test('rules are mutual: one side opening up is not enough', () => {
  const c = structuredClone(s);
  c.species.find((x) => x.id === 'troodon').rule = { scope: 'all', requireGroup: false };
  assert.equal(canTalk(c, p('troodon'), p('carnotaurus', 'A')), false, 'carnotaurus still restricted');
  assert.equal(canTalk(c, p('troodon'), p('troodon')), true);
});

test('per-species "also" list works when both sides list each other', () => {
  const c = structuredClone(s);
  c.species.find((x) => x.id === 'troodon').rule = { also: ['herrerasaurus'] };
  assert.equal(compatibleSpecies(c, 'troodon', 'herrerasaurus'), false);
  c.species.find((x) => x.id === 'herrerasaurus').rule = { also: ['troodon'] };
  assert.equal(compatibleSpecies(c, 'troodon', 'herrerasaurus'), true);
  assert.equal(canTalk(c, p('troodon', 'A'), p('herrerasaurus', 'A')), true);
});

test('class names from the game match species', () => {
  assert.equal(normalizeClass('BP_Carnotaurus_C'), 'carnotaurus');
  assert.equal(matchSpecies(s, 'BP_Carnotaurus_C').id, 'carnotaurus');
  assert.equal(matchSpecies(s, 'stegosaurus').id, 'stegosaurus');
  assert.equal(matchSpecies(s, 'Tyrannosaurus'), null);
  assert.equal(matchSpecies(s, ''), null);
});

test('RCON player data parsing tolerates format differences', () => {
  const a = parsePlayerData(
    '[2026.01.01-10.00.00] PlayerDataName: Jem, PlayerID: 76561198000000001, Location: X=1 Y=2 Z=3, Class: BP_Carnotaurus_C, Growth: 0.75, Health: 1.00\n' +
      'Name: Rex Fan, PlayerID: 76561198000000002, Location: X=1 Y=2 Z=3, Class: BP_Stegosaurus_C, Growth: 1.0\n'
  );
  assert.deepEqual(a, [
    { steamId: '76561198000000001', name: 'Jem', className: 'BP_Carnotaurus_C', pos: { x: 1, y: 2, z: 3 } },
    { steamId: '76561198000000002', name: 'Rex Fan', className: 'BP_Stegosaurus_C', pos: { x: 1, y: 2, z: 3 } }
  ]);
  assert.deepEqual(parsePlayerData(''), []);
  assert.deepEqual(parsePlayerData('garbage with no players'), []);
});

test('settings validation', () => {
  const ok = sanitizeSettings({ ...structuredClone(s), species: [...s.species, { name: 'Tyrannosaurus', category: 'carnivore' }] });
  assert.equal(ok.species.at(-1).id, 'tyrannosaurus');
  assert.deepEqual(ok.species.at(-1).classNames, ['Tyrannosaurus']);
  assert.throws(() => sanitizeSettings({ ...s, species: [{ name: 'X', category: 'fish' }] }), /category/);
  assert.throws(() => sanitizeSettings({ ...s, species: [{ name: 'A', category: 'carnivore' }, { name: 'a', category: 'carnivore' }] }), /share/);
  assert.throws(() => sanitizeSettings({ ...s, categories: { ...s.categories, carnivore: { scope: 'galaxy', requireGroup: true } } }), /scope/);
  // an empty RCON password keeps the saved one
  const prev = structuredClone(s);
  prev.speciesSource.rcon.password = 'secret';
  assert.equal(sanitizeSettings(s, prev).speciesSource.rcon.password, 'secret');
});

test('Steam sign-in answers are verified with Steam and bound to this server', async () => {
  const { verifySteamReturn, Auth } = await import('../src/auth.js');
  const url = 'https://voice.example.com';
  const q = {
    'openid.mode': 'id_res',
    'openid.return_to': `${url}/auth/steam/return`,
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
    'openid.sig': 'abc'
  };
  const steamSays = (text) => async (endpoint, init) => {
    assert.equal(endpoint, 'https://steamcommunity.com/openid/login');
    assert.equal(init.body.get('openid.mode'), 'check_authentication');
    return { text: async () => text };
  };
  assert.equal(await verifySteamReturn(q, url, steamSays('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n')), '76561198000000001');
  await assert.rejects(verifySteamReturn(q, url, steamSays('is_valid:false')), /could not confirm/);
  await assert.rejects(verifySteamReturn({ ...q, 'openid.return_to': 'https://evil.example/auth/steam/return' }, url, steamSays('is_valid:true')), /wrong address/);
  await assert.rejects(verifySteamReturn({ ...q, 'openid.claimed_id': 'https://evil.example/openid/id/76561198000000001' }, url, steamSays('is_valid:true')), /valid account/);
  await assert.rejects(verifySteamReturn({ ...q, 'openid.mode': 'cancel' }, url, steamSays('is_valid:true')), /cancelled/);

  // tokens: tampering and expiry are rejected
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const auth = new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')));
  const t = auth.sign({ sub: 'x', role: 'player' }, 60);
  assert.equal(auth.verify(t).sub, 'x');
  const forged = Buffer.from(JSON.stringify({ role: 'admin', exp: 9e9 })).toString('base64url') + '.' + t.split('.')[1];
  assert.equal(auth.verify(forged), null);
  assert.equal(auth.verify(auth.sign({ sub: 'x' }, -1)), null);
});

test('proximity: range is 100 m by default and applies on top of the rules', () => {
  assert.deepEqual(s.proximity, { enabled: true, rangeMetres: 100, fade: true, updateSeconds: 3, unitsPerMetre: 100 });
  const at = (x, y = 0) => ({ speciesId: 'carnotaurus', groupId: 'A', pos: { x: x * 100, y: y * 100, z: 0 } }); // metres -> game units
  assert.equal(distanceMetres(s, at(0), at(30, 40)), 50);
  const o = { proximity: 'required' };
  assert.equal(canTalk(s, at(0), at(99), o), true);
  assert.equal(canTalk(s, at(0), at(101), o), false, 'out of range');
  assert.equal(canTalk(s, at(0), at(105), { ...o, rangeScale: 1.1 }), true, 'open streams hold on to 110%');
  assert.equal(canTalk(s, at(0), at(111), { ...o, rangeScale: 1.1 }), false);
  assert.equal(canTalk(s, at(0), { speciesId: 'carnotaurus', groupId: 'A', pos: null }, o), false, 'unknown position fails closed');
  assert.equal(canTalk(s, at(0), { ...at(10), groupId: 'B' }, o), false, 'in range but the rules still apply');
  // test mode: only applied when both have a position; legacy: never applied
  assert.equal(inRange(s, at(0), { pos: null }, 'optional'), true);
  assert.equal(inRange(s, at(0), at(500), 'optional'), false);
  assert.equal(inRange(s, at(0), at(500), 'off'), true);
  // operator changes
  const c = structuredClone(s);
  c.proximity.rangeMetres = 600;
  assert.equal(canTalk(c, at(0), at(500), o), true);
  c.proximity.enabled = false;
  assert.equal(canTalk(c, at(0), at(5000), o), true);
  // fade: full volume to half range, quieter to the edge, never silent
  assert.equal(fadeGain(s, at(0), at(40), 'required'), 1);
  assert.equal(fadeGain(s, at(0), at(75), 'required'), 0.6);
  assert.equal(fadeGain(s, at(0), at(100), 'required'), 0.2);
  // validation
  assert.equal(sanitizeSettings({ ...s, proximity: { enabled: true, rangeMetres: -5 } }).proximity.rangeMetres, 1);
  assert.equal(sanitizeSettings({ ...s, proximity: undefined }).proximity.rangeMetres, 100, 'older settings files get the default');
});

test('RCON locations are parsed in the formats seen in the wild', () => {
  assert.deepEqual(parsePlayerData('Name: A, PlayerID: 76561198000000001, Location: X=-12345.6 Y=200 Z=-3.5, Class: BP_Troodon_C')[0].pos, { x: -12345.6, y: 200, z: -3.5 });
  assert.deepEqual(parsePlayerData('Name: A, PlayerID: 76561198000000001, Location: X=1.0, Y=2.0, Z=3.0, Class: BP_Troodon_C')[0].pos, { x: 1, y: 2, z: 3 });
  assert.equal(parsePlayerData('Name: A, PlayerID: 76561198000000001, Class: BP_Troodon_C')[0].pos, null);
});

test('version numbers count 0-9 in the last place, then roll the middle number', async () => {
  const { nextVersion } = await import('../../scripts/bump-version.mjs');
  assert.equal(nextVersion('0.2.0'), '0.2.1');
  assert.equal(nextVersion('0.2.9'), '0.3.0');
  assert.equal(nextVersion('0.3.9'), '0.4.0');
  assert.throws(() => nextVersion('banana'));
});
