// The rules engine: decides who may talk to whom.
// Pure functions, no I/O, so they are easy to test.

export function normalizeClass(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^bp_/, '')
    .replace(/_c$/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Find the species a game class name belongs to, or null. */
export function matchSpecies(settings, className) {
  const wanted = normalizeClass(className);
  if (!wanted) return null;
  for (const s of settings.species) {
    if (normalizeClass(s.id) === wanted || normalizeClass(s.name) === wanted) return s;
    if ((s.classNames || []).some((c) => normalizeClass(c) === wanted)) return s;
  }
  return null;
}

export function getSpecies(settings, id) {
  return settings.species.find((s) => s.id === id) || null;
}

/** A species' own rule, falling back to its category's rule. */
export function effectiveRule(settings, species) {
  const cat = settings.categories[species.category];
  const own = species.rule || {};
  return {
    scope: own.scope ?? cat.scope,
    requireGroup: own.requireGroup ?? cat.requireGroup,
    also: own.also ?? []
  };
}

// One-directional check: do A's rules let A talk to B?
function allows(settings, a, b, ignoreGroup) {
  const sa = getSpecies(settings, a.speciesId);
  const sb = getSpecies(settings, b.speciesId);
  if (!sa || !sb) return false;
  const rule = effectiveRule(settings, sa);
  const inScope =
    sa.id === sb.id ||
    rule.scope === 'all' ||
    (rule.scope === 'category' && sa.category === sb.category) ||
    rule.also.includes(sb.id);
  if (!inScope) return false;
  if (rule.requireGroup && !ignoreGroup) {
    return Boolean(a.groupId) && a.groupId === b.groupId;
  }
  return true;
}

/** Distance between two players in metres, or null if either position is unknown. */
export function distanceMetres(settings, a, b) {
  if (!a.pos || !b.pos) return null;
  const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
  return d / (settings.proximity.unitsPerMetre || 100);
}

/**
 * Are two players close enough to hear each other?
 * mode: 'required' - positions come from the game; unknown position = not in range
 *       'optional' - test mode; only applied when both players have a position
 *       'off'      - positions are not available, so range is not applied
 * scale widens the range slightly for streams that are already open, so
 * players standing right at the edge do not cut in and out.
 */
export function inRange(settings, a, b, mode = 'off', scale = 1) {
  if (!settings.proximity?.enabled || mode === 'off') return true;
  const d = distanceMetres(settings, a, b);
  if (d == null) return mode === 'optional';
  return d <= settings.proximity.rangeMetres * scale;
}

/** Volume (0.2 to 1) for a voice at this distance: full up to half range, then fading. */
export function fadeGain(settings, a, b, mode = 'off') {
  if (!settings.proximity?.enabled || !settings.proximity.fade || mode === 'off') return 1;
  const d = distanceMetres(settings, a, b);
  if (d == null) return 1;
  const t = d / settings.proximity.rangeMetres;
  const gain = t <= 0.5 ? 1 : Math.max(0.2, 1 - (t - 0.5) * 1.6);
  return Math.round(gain * 20) / 20;
}

/**
 * Two players can talk only when BOTH sides' rules allow it, so nobody is
 * ever heard by someone they cannot hear back.
 * a, b: { speciesId, groupId, pos }
 */
export function canTalk(settings, a, b, { ignoreGroup = false, proximity = 'off', rangeScale = 1 } = {}) {
  return allows(settings, a, b, ignoreGroup) && allows(settings, b, a, ignoreGroup) && inRange(settings, a, b, proximity, rangeScale);
}

/** Could these two species ever share a voice group? */
export function compatibleSpecies(settings, speciesIdA, speciesIdB) {
  return canTalk(settings, { speciesId: speciesIdA }, { speciesId: speciesIdB }, { ignoreGroup: true });
}
