/**
 * Shared category detection for market slugs.
 * Used by dashboard.ts (category breakdowns, risk concentration).
 * public/index.html only maps category keys to labels/colors — the
 * categorization itself happens exclusively here.
 */

const CATEGORY_RULES: [string, RegExp][] = [
  ['politics',      /\belection\b|\bpresident\b|\bcongress\b|\btrump\b|\bharris\b|\bvote\b|\bsenate\b|\brepublican\b|\bdemocrat\b/i],
  ['esports',       /\besport|\bcs2\b|\bcs\b|\bvalorant\b|\bdota\b|\blol\b|\bgaming\b/i],
  // Sports: common league abbreviations + slug prefixes + general sport terms.
  // Slug prefixes (with hyphens replaced by spaces): bkcba/bkjpn/bkkbl (basketball variants),
  // epl (English Premier League), kbl (Korean Basketball), kor/jpn/bra (country sports slugs).
  // Added 2026-06-11 (these were silently falling through to other categories):
  // fif (FIFA WC qualifiers), es2 (Spanish Segunda), bra/bra2 (Brazilian Serie A/B),
  // chi/chi1 (Chilean leagues), sud (Sudani league), mls (Major League Soccer),
  // dfb (German DFB-Pokal).
  // "spread" and "total" in slug context = sports betting market structures.
  ['sports',        /\batp\b|\bwta\b|\bnhl\b|\bnba\b|\bmlb\b|\bnfl\b|\bucl\b|\bspl\b|\bepl\b|\bkbl\b|\bfif\b|\bes2\b|\bbra\b|\bbra2\b|\bchi\b|\bchi1\b|\bsud\b|\bmls\b|\bdfb\b|\bbkcba\b|\bbkjpn\b|\bbkkbl\b|\bbknbl\b|\bbktur\b|\bbkfra\b|\bbkita\b|\bbkaus\b|\bbkger\b|\btennis\b|\bsoccer\b|\bbasketball\b|\bbaseball\b|\bfootball\b|\bhockey\b|\bgolf\b|\bufc\b|\bmma\b|\brugby\b|\blaliga\b|\bbundesliga\b|\bserie a\b|\bligue 1\b|\bnfl\b|\bncaa\b|\bpga\b|\bwimbledon\b|\bformula\b|\bf1\b|\bnascar\b|\boxing\b|\bcricket\b|\bpremier league\b/i],
  ['crypto',        /\bbtc\b|\beth\b|\bbitcoin\b|\bethereum\b|\bcrypto\b|\bsolana\b|\bdefi\b/i],
  ['finance',       /\bfed\b|\binflation\b|\bgdp\b|\brecession\b|\bstock\b|\bsp500\b|\bnasdaq\b|\bearnings\b/i],
  ['geopolitics',   /\bwar\b|\bukraine\b|\brussia\b|\bnato\b|\bchina\b|\btaiwan\b|\bisrael\b|\bgaza\b|\bmilitary\b|\bconflict\b/i],
  ['science',       /\bai\b|\bopenai\b|\bspacex\b|\bnasa\b|\blaunch\b|\bclimate\b|\bvaccine\b|\bfda\b|\bdrug\b/i],
  ['entertainment', /\boscar\b|\bemmy\b|\bmovie\b|\bmusic\b|\bcelebrity\b|\bactor\b|\bfilm\b/i],
  ['social',        /\btiktok\b|\btwitter\b|\belon\b|\bmusk\b|\bsocial\b|\bban\b|\blaw\b|\bcourt\b|\bsupreme\b/i],
];

export function detectCategory(slug: string): string {
  const s = (slug || '').toLowerCase().replace(/-/g, ' ');
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(s)) return cat;
  }
  return 'other';
}
