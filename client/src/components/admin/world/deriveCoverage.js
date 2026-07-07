// Pure, defensive derivation of a server's setup/coverage state. Consumes the
// admin list ROW (always) and the optional /overview payload (may be null when
// only the row is available — e.g. on a ServerCard). Every field defaults to a
// safe 0/false so a pre-B1 row (missing zones_with_* counts) still computes.
//
//   deriveCoverage(server, overview) -> {
//     steps:   [{ key, label, done, optional?, hint? }],  // setup checklist
//     pct:     number,     // 0..100, required steps only (IPs excluded)
//     ready:   boolean,    // LENIENT: names && background && visible
//     verdict: 'ready' | 'not_published' | 'incomplete',
//     names, background, visible,          // the three LENIENT signals
//     zones_with_data, zones_with_bounds, zones_with_background,  // denominators
//   }
//
// LOCKED rule: "Ready" = named counts present (any of zone/mob/npc > 0) AND at
// least one background AND visible. not_published = complete-but-hidden.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function deriveCoverage(server, overview) {
  const s = server || {};

  const zones_with_data       = num(s.zones_with_data);
  const zones_with_bounds     = num(s.zones_with_bounds);
  const zones_with_background = num(s.zones_with_background);

  const namedTotal =
    num(s.zone_named_count) + num(s.mob_named_count) + num(s.npc_named_count);

  const names      = namedTotal > 0;
  const background = zones_with_background > 0;
  const visible    = !!s.visible;
  const hasIps     = (s.known_ips || []).length > 0;

  const steps = [
    {
      key: 'name',
      label: 'Named',
      done: !!s.name,
      hint: 'Give the server a display name.',
    },
    {
      key: 'ips',
      label: 'Known IPs',
      done: hasIps,
      optional: true,
      hint: 'Associate the game-server IPs so recorded spawns auto-attach.',
    },
    {
      key: 'names',
      label: 'Reference names imported',
      done: names,
      hint: 'Import names.json / zones.csv so zones, monsters and NPCs read as names.',
    },
    {
      key: 'background',
      label: 'At least one zone background',
      done: background,
      hint: 'Upload a zone map image so spawns render over the world.',
    },
    {
      key: 'visible',
      label: 'Published (visible)',
      done: visible,
      hint: 'Publish so the server appears on the user-facing map.',
    },
  ];

  // pct = required steps only; the optional IPs step is shown but never counted.
  const required = steps.filter((st) => !st.optional);
  const doneReq  = required.filter((st) => st.done).length;
  const pct = required.length ? Math.round((doneReq / required.length) * 100) : 0;

  const ready = names && background && visible; // LENIENT
  const verdict = ready
    ? 'ready'
    : (s.visible === false && names && background ? 'not_published' : 'incomplete');

  // Count of required steps still outstanding (for the "N steps left" copy).
  const stepsLeft = required.length - doneReq;

  return {
    steps,
    pct,
    ready,
    verdict,
    stepsLeft,
    names,
    background,
    visible,
    zones_with_data,
    zones_with_bounds,
    zones_with_background,
    overview: overview || null,
  };
}

export default deriveCoverage;
