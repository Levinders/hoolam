/**
 * Where in Nigeria: states, their main cities, and well-known neighbourhoods, with the spellings and short forms
 * people actually type ("PH", "Portharcourt", "Lekki ph1", "Abja"). `findPlace` reads what someone typed and
 * returns the best match, or a few to choose from when it isn't sure. Cities carry rough coordinates, so a shared
 * WhatsApp location can be turned into "near <city>".
 */
export interface Place { area: string | null; city: string; state: string; lat?: number; lng?: number }

type City = { city: string; state: string; lat: number; lng: number; aka?: string[]; areas?: (string | [string, ...string[]])[] };

/** Main cities by state (rough centre coordinates) with their best-known areas. An area entry can list other spellings. */
const CITIES: City[] = [
  { city: 'Lagos', state: 'Lagos', lat: 6.5244, lng: 3.3792, aka: ['lag', 'lasgidi', 'eko'], areas: [
    ['Lekki', 'leki'], ['Lekki Phase 1', 'lekki ph1', 'lekki phase one', 'lekki 1'], 'Ajah', 'Victoria Island', ['Victoria Island', 'vi', 'v.i'], 'Ikoyi', 'Ikeja', ['Ikeja GRA', 'ikeja gra'],
    'Surulere', 'Yaba', 'Ojota', 'Ketu', 'Maryland', 'Gbagada', 'Magodo', 'Ogba', 'Agege', 'Ikorodu', 'Oshodi', 'Mushin', 'Festac', ['Festac Town', 'festac'],
    'Apapa', 'Ojo', ['Alaba', 'alaba international'], 'Ikotun', 'Egbeda', 'Isolo', 'Ajegunle', 'Badagry', 'Epe', 'Sangotedo', 'Chevron', 'Oniru', 'Obalende',
    ['Lagos Island', 'island', 'idumota', 'balogun'], 'Ilupeju', 'Anthony', 'Akoka', 'Bariga', 'Ojodu', 'Berger', 'Ogudu', 'Ipaja', 'Ayobo', 'Iyana Ipaja', 'Abule Egba', 'Idimu', 'Ejigbo', 'Satellite Town', 'Amuwo Odofin', 'Ojuelegba'] },
  { city: 'Abuja', state: 'FCT', lat: 9.0765, lng: 7.3986, aka: ['fct', 'abj', 'abja'], areas: [
    'Wuse', ['Wuse 2', 'wuse ii', 'wuse2'], 'Maitama', 'Garki', 'Asokoro', 'Gwarinpa', 'Jabi', 'Utako', 'Kubwa', 'Lugbe', 'Life Camp', 'Lokogoma', 'Apo', 'Karu', 'Nyanya',
    'Gwagwalada', 'Kuje', 'Dutse', 'Katampe', 'Mabushi', 'Durumi', 'Galadimawa', 'Jahi', 'Kado', 'Wuye', 'Area 1', 'Central Area', ['Central Business District', 'cbd'], 'Mararaba', 'Bwari'] },
  { city: 'Port Harcourt', state: 'Rivers', lat: 4.8156, lng: 7.0498, aka: ['ph', 'p.h', 'portharcourt', 'port-harcourt', 'phc', 'pitakwa', 'port harcout', 'porthacourt'], areas: [
    'Woji', ['GRA Phase 1', 'gra 1', 'gra phase one'], ['GRA Phase 2', 'gra 2', 'gra phase two', 'old gra'], 'Trans Amadi', 'Rumuola', 'Rumuokoro', 'Rumuokwuta', 'Rumuigbo', 'Rumuibekwe', 'Rumuogba',
    'Rumuomasi', 'Rumuodara', 'Rumuodomaya', 'Rumuepirikom', 'Eliozu', 'Elelenwo', 'Choba', 'Aluu', 'Alakahia', 'Rumuosi', 'Ozuoba', 'Rukpokwu', 'Iriebe', 'Oyigbo', 'Mile 1', 'Mile 2', 'Mile 3', 'Mile 4',
    'D-Line', ['Diobu', 'mile one'], 'Borokiri', 'Elekahia', 'Ada George', 'Agip', 'Rumueme', 'Ogbunabali', 'Peter Odili Road', 'Abuloma', 'Amadi Ama', 'Eagle Island', 'Igwuruta', 'Eneka', 'Obio Akpor', 'Rumuokparali', 'Mgbuoba', 'Ogbogoro', 'Rumuolumeni', 'Town', 'Old Township', 'Okrika', 'Onne', 'Bori', 'Omoku', 'Ahoada'] },
  { city: 'Ibadan', state: 'Oyo', lat: 7.3775, lng: 3.947, aka: ['ib', 'ibd'], areas: ['Bodija', 'Dugbe', 'Challenge', 'Ring Road', 'Mokola', 'Agodi', 'Jericho', 'Iwo Road', 'Akobo', 'Apata', 'Ojoo', 'Sango', 'Samonda', 'UI', 'Moniya', 'Oluyole'] },
  { city: 'Ogbomoso', state: 'Oyo', lat: 8.1335, lng: 4.2405 },
  { city: 'Oyo', state: 'Oyo', lat: 7.85, lng: 3.9333 },
  { city: 'Kano', state: 'Kano', lat: 12.0022, lng: 8.592, areas: ['Sabon Gari', 'Nasarawa GRA', 'Fagge', 'Tarauni', 'Gwale', 'Kumbotso', 'Kofar Mata'] },
  { city: 'Kaduna', state: 'Kaduna', lat: 10.5105, lng: 7.4165, areas: ['Barnawa', 'Malali', 'Ungwan Rimi', 'Sabon Tasha', 'Kawo', 'Narayi'] },
  { city: 'Zaria', state: 'Kaduna', lat: 11.0855, lng: 7.7199, aka: ['samaru'] },
  { city: 'Enugu', state: 'Enugu', lat: 6.4584, lng: 7.5464, areas: ['Independence Layout', 'New Haven', 'Trans Ekulu', 'Abakpa', 'Ogui', 'Uwani', 'Achara Layout', 'GRA', 'Emene', 'Coal Camp', 'Agbani'] },
  { city: 'Nsukka', state: 'Enugu', lat: 6.8567, lng: 7.3958 },
  { city: 'Benin City', state: 'Edo', lat: 6.335, lng: 5.6037, aka: ['benin', 'bini'], areas: ['GRA', 'Ugbowo', 'Uselu', 'Ring Road', 'Sapele Road', 'Airport Road', 'Ekehuan', 'Ikpoba Hill', 'Oluku'] },
  { city: 'Warri', state: 'Delta', lat: 5.5167, lng: 5.75, areas: ['Effurun', 'Okumagba', 'Airport Road', 'Ekpan', 'Enerhen', 'Jakpa', 'Ugbuwangue'] },
  { city: 'Asaba', state: 'Delta', lat: 6.1985, lng: 6.7341, areas: ['Okpanam', 'Cable Point', 'Summit'] },
  { city: 'Sapele', state: 'Delta', lat: 5.894, lng: 5.6767 },
  { city: 'Owerri', state: 'Imo', lat: 5.4836, lng: 7.0333, areas: ['New Owerri', 'Ikenegbu', 'Wetheral', 'World Bank', 'Douglas', 'Ihiagwa', 'Nekede'] },
  { city: 'Onitsha', state: 'Anambra', lat: 6.1499, lng: 6.7857, areas: ['Main Market', 'Fegge', 'GRA', 'Woliwo', 'Odoakpu', '3-3'] },
  { city: 'Awka', state: 'Anambra', lat: 6.2104, lng: 7.0741 },
  { city: 'Nnewi', state: 'Anambra', lat: 6.0177, lng: 6.9177 },
  { city: 'Aba', state: 'Abia', lat: 5.1066, lng: 7.3667, areas: ['Ariaria', 'Ogbor Hill', 'Asa Road', 'Faulks Road', 'Osisioma'] },
  { city: 'Umuahia', state: 'Abia', lat: 5.5249, lng: 7.4942 },
  { city: 'Uyo', state: 'Akwa Ibom', lat: 5.0377, lng: 7.9128, areas: ['Ewet Housing', 'Shelter Afrique', 'Itam', 'Oron Road', 'Aka Road'] },
  { city: 'Eket', state: 'Akwa Ibom', lat: 4.6423, lng: 7.9244 },
  { city: 'Calabar', state: 'Cross River', lat: 4.9757, lng: 8.3417, areas: ['Marian', 'Satellite Town', 'Etta Agbor', 'Ekorinim', 'State Housing'] },
  { city: 'Yenagoa', state: 'Bayelsa', lat: 4.9267, lng: 6.2676, areas: ['Amarata', 'Okaka', 'Swali', 'Opolo', 'Kpansia'] },
  { city: 'Abeokuta', state: 'Ogun', lat: 7.1475, lng: 3.3619, areas: ['Panseke', 'Kuto', 'Oke Mosan', 'Lafenwa', 'Ibara'] },
  { city: 'Ota', state: 'Ogun', lat: 6.6804, lng: 3.2356, aka: ['sango ota', 'sango-ota'] },
  { city: 'Ijebu Ode', state: 'Ogun', lat: 6.8208, lng: 3.9173 },
  { city: 'Mowe', state: 'Ogun', lat: 6.8104, lng: 3.4361, aka: ['ibafo', 'magboro', 'arepo'] },
  { city: 'Ilorin', state: 'Kwara', lat: 8.4966, lng: 4.5421, areas: ['Tanke', 'GRA', 'Fate', 'Taiwo', 'Challenge'] },
  { city: 'Akure', state: 'Ondo', lat: 7.2571, lng: 5.2058, areas: ['Alagbaka', 'Oba Ile', 'FUTA'] },
  { city: 'Ondo', state: 'Ondo', lat: 7.1, lng: 4.8333 },
  { city: 'Osogbo', state: 'Osun', lat: 7.7827, lng: 4.5418, aka: ['oshogbo'] },
  { city: 'Ile-Ife', state: 'Osun', lat: 7.4824, lng: 4.5603, aka: ['ife', 'ile ife'] },
  { city: 'Ado-Ekiti', state: 'Ekiti', lat: 7.6211, lng: 5.2214, aka: ['ado ekiti', 'ado'] },
  { city: 'Jos', state: 'Plateau', lat: 9.8965, lng: 8.8583, areas: ['Rayfield', 'Bukuru', 'Terminus', 'Angwan Rukuba'] },
  { city: 'Makurdi', state: 'Benue', lat: 7.7337, lng: 8.5214 },
  { city: 'Lafia', state: 'Nasarawa', lat: 8.4939, lng: 8.5153 },
  { city: 'Keffi', state: 'Nasarawa', lat: 8.8463, lng: 7.8736 },
  { city: 'Minna', state: 'Niger', lat: 9.6139, lng: 6.5569 },
  { city: 'Lokoja', state: 'Kogi', lat: 7.8023, lng: 6.743 },
  { city: 'Abakaliki', state: 'Ebonyi', lat: 6.3249, lng: 8.1137 },
  { city: 'Bauchi', state: 'Bauchi', lat: 10.3158, lng: 9.8442 },
  { city: 'Gombe', state: 'Gombe', lat: 10.2897, lng: 11.1673 },
  { city: 'Yola', state: 'Adamawa', lat: 9.2035, lng: 12.4954 },
  { city: 'Jalingo', state: 'Taraba', lat: 8.8937, lng: 11.3596 },
  { city: 'Maiduguri', state: 'Borno', lat: 11.8333, lng: 13.15 },
  { city: 'Damaturu', state: 'Yobe', lat: 11.747, lng: 11.9608 },
  { city: 'Dutse', state: 'Jigawa', lat: 11.7562, lng: 9.3388 },
  { city: 'Katsina', state: 'Katsina', lat: 12.9908, lng: 7.6006 },
  { city: 'Sokoto', state: 'Sokoto', lat: 13.0059, lng: 5.2476 },
  { city: 'Birnin Kebbi', state: 'Kebbi', lat: 12.4539, lng: 4.1975 },
  { city: 'Gusau', state: 'Zamfara', lat: 12.17, lng: 6.66 },
];

const STATES = [...new Set(CITIES.map((c) => c.state))];
const STATE_AKA: Record<string, string[]> = {
  FCT: ['federal capital territory', 'abuja fct'], 'Akwa Ibom': ['akwaibom', 'akwa-ibom'], 'Cross River': ['crossriver', 'cross-river'], Rivers: ['river state', 'rivers state'],
};

const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(state|road|rd|street|st|city|town|area)\b/g, ' ').replace(/\s+/g, ' ').trim();
const squash = (s: string) => norm(s).replace(/ /g, '');

interface Entry { key: string; place: Place; weight: number }
const ENTRIES: Entry[] = (() => {
  const out: Entry[] = [];
  const add = (name: string, place: Place, weight: number) => { const k = squash(name); if (k.length >= 2) out.push({ key: k, place, weight }); };
  for (const c of CITIES) {
    const city: Place = { area: null, city: c.city, state: c.state, lat: c.lat, lng: c.lng };
    add(c.city, city, 3);
    for (const a of c.aka ?? []) add(a, city, 3);
    for (const a of c.areas ?? []) {
      const [name, ...aka] = Array.isArray(a) ? a : [a];
      const place: Place = { area: name, city: c.city, state: c.state, lat: c.lat, lng: c.lng };
      add(name, place, 2);
      for (const x of aka) add(x, place, 2);
    }
  }
  for (const st of STATES) {
    const capital = CITIES.find((c) => c.state === st)!;
    const place: Place = { area: null, city: capital.city, state: st, lat: capital.lat, lng: capital.lng };
    add(st, { ...place, city: '' }, 1);
    for (const a of STATE_AKA[st] ?? []) add(a, { ...place, city: '' }, 1);
  }
  return out;
})();

/** Edit distance with swaps of two neighbouring letters counted as one (Damerau, optimal string alignment). */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** How close a typed piece is to a name: 1 = the same, 0 = nothing alike. */
function closeness(typed: string, key: string): number {
  if (typed === key) return 1;
  if (key.length >= 4 && typed.startsWith(key)) return 0.9;  // "rumuokorojunction" → Rumuokoro
  const dist = distance(typed, key);
  const allowed = key.length <= 4 ? 0 : key.length <= 6 ? 1 : key.length <= 10 ? 2 : 3;
  return dist <= allowed ? 1 - dist / Math.max(typed.length, key.length) : 0;
}

export type PlaceMatch = { kind: 'sure'; place: Place } | { kind: 'choose'; options: Place[] } | { kind: 'none' };

/**
 * Reads a typed area: "Woji, Port Harcourt", "rumuokwuta", "lekki ph1", "abja". Each comma or word group is tried
 * against every name; an area that sits in a city the text also names wins. Sure: one clear best. Otherwise up to 3.
 */
export function findPlace(text: string): PlaceMatch {
  // typed exactly as a known name (or one of its other spellings): no guessing
  const whole = squash(text);
  const exact = ENTRIES.filter((e) => e.key === whole);
  if (exact.length === 1 || (exact.length > 1 && exact.every((e) => e.place.city === exact[0]!.place.city && e.place.area === exact[0]!.place.area))) return { kind: 'sure', place: exact[0]!.place };
  const parts = text.split(/[,/]| in | near /i).map(squash).filter(Boolean);
  // "Wuse 2, Abuja": one part is an area's exact name, and the other parts (if any) name its city or state
  for (const part of parts) {
    const hits = ENTRIES.filter((e) => e.key === part && e.place.area && parts.every((q) => q === part || squash(e.place.city) === q || squash(e.place.state) === q));
    const ids = new Set(hits.map((e) => `${e.place.area}|${e.place.city}`));
    if (ids.size === 1) return { kind: 'sure', place: hits[0]!.place };
  }
  const words = norm(text).split(' ').filter(Boolean);
  // try the whole text, each part, and runs of 1–3 words (so "woji port harcourt" finds both)
  const tries = new Set<string>([squash(text), ...parts]);
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= words.length; i++) tries.add(words.slice(i, i + n).join(''));
  const scored = new Map<string, { place: Place; score: number }>();
  for (const t of tries) {
    if (t.length < 2) continue;
    for (const e of ENTRIES) {
      const c = closeness(t, e.key);
      if (!c) continue;
      const score = c * (1 + e.weight / 10) + t.length / 100;
      const id = `${e.place.area ?? ''}|${e.place.city}|${e.place.state}`;
      const was = scored.get(id);
      if (!was || was.score < score) scored.set(id, { place: e.place, score });
    }
  }
  if (!scored.size) return { kind: 'none' };
  // an area whose city (or state) is also named gets a lift
  for (const v of scored.values()) {
    if (v.place.area && [...scored.values()].some((o) => !o.place.area && o.place.city === v.place.city && o.score > 0.85)) v.score += 0.3;
  }
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  // drop entries that are just the city of the best area
  const best = ranked[0]!;
  const rest = ranked.slice(1).filter((r) => !(r.place.city === best.place.city && !r.place.area && best.place.area));
  if (best.score >= 1.05 && (!rest[0] || best.score - rest[0].score >= 0.12)) return { kind: 'sure', place: best.place };
  return { kind: 'choose', options: [best, ...rest].slice(0, 3).map((r) => r.place) };
}

/** The nearest main city to a shared location (within 80 km), else null. */
export function placeNear(lat: number, lng: number): Place | null {
  let best: City | null = null, bestKm = Infinity;
  for (const c of CITIES) {
    const km = haversine(lat, lng, c.lat, c.lng);
    if (km < bestKm) { bestKm = km; best = c; }
  }
  return best && bestKm <= 80 ? { area: null, city: best.city, state: best.state, lat, lng } : null;
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** "Woji, Port Harcourt" · "Port Harcourt" · "Rivers" */
export const placeText = (p: Place | null | undefined): string => !p ? 'all Nigeria' : [p.area, p.city || null, p.city ? null : p.state].filter(Boolean).join(', ');
/** The short name shown in headings: the area, else the city, else the state. */
export const placeShort = (p: Place | null | undefined): string => !p ? 'all Nigeria' : p.area ?? (p.city || p.state);
