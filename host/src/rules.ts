// Engine 3 (SPEC 10.3): fixed patterns that map field labels to profile keys. No model involved.

export interface FormField {
  ref: string;
  label: string;
  kind: string; // text, email, tel, url, number, textarea, select, combobox, checkbox, radio, file
  options?: string[];
  required?: boolean;
  value?: string;
  accept?: string;
}

/** Ordered: the first rule whose pattern matches the normalized label wins. */
export const RULES: { key: string; pattern: RegExp; kinds?: string[] }[] = [
  { key: "preferredName", pattern: /^(preferred|nick) ?(first )?name$/ },
  { key: "firstName", pattern: /^(legal )?(first|given) ?name$/ },
  { key: "lastName", pattern: /^(legal )?(last|family|sur) ?name$|^surname$/ },
  { key: "@fullName", pattern: /^(full |legal )?name$|^full legal name$|^your name$/ },
  { key: "email", pattern: /^e-?mail( address)?$/ },
  { key: "phone", pattern: /^(phone|mobile|cell)( phone)?( number)?$/ },
  { key: "city", pattern: /^city$/ },
  { key: "state", pattern: /^(state|province|state\/province|state or province)$/ },
  { key: "country", pattern: /^country( of residence)?$/ },
  { key: "@location", pattern: /^(current )?location( \(city\))?$|^where are you (currently )?(located|based)\??$/ },
  { key: "links.github", pattern: /^github( profile| url| link)?$/ },
  { key: "links.linkedin", pattern: /^linkedin( profile| url| link)?$/ },
  { key: "resumePath", pattern: /^(resume|cv|resume ?\/ ?cv)$/, kinds: ["file"] },
  { key: "answers.yearsExperience", pattern: /^(how many )?years of (professional |relevant |work )?experience( do you have)?\??$/ },
  { key: "answers.backend5PlusYears", pattern: /5\+? years.*backend|backend.*5\+? years/ },
  { key: "answers.workAuthorizedNoSponsorship", pattern: /authori[sz]ed to work|require (visa )?sponsorship|need sponsorship/ },
  { key: "answers.willingToRelocate", pattern: /willing to relocate|open to relocat/ },
  { key: "answers.willingToTravelForOnsite", pattern: /travel .*(onsite|on-site|office)|willing to travel/ },
  { key: "answers.salaryExpectation", pattern: /salary|compensation expectation|desired (pay|compensation)/ },
];

const EEO = /gender|\bsex\b|\brace\b|ethnic|hispanic|latin[oax]\b|veteran|disabilit|sexual orientation|transgender|pronoun/i;

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[*✱]/g, "")
    .replace(/\(required\)|\(optional\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/[:\s]+$/, "")
    .trim();
}

export function isEeoField(label: string): boolean {
  return EEO.test(label);
}

export function isFreeText(field: FormField): boolean {
  if (field.kind === "textarea") return true;
  return /^(why|what|how|tell us|describe|please (describe|explain|share))\b/i.test(field.label.trim()) && field.kind === "text";
}

export function getPath(obj: any, key: string): unknown {
  return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** All answerable profile keys (dotted), excluding nested objects. */
export function profileKeys(profile: Record<string, any>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(profile ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...profileKeys(v, key));
    else out.push(key);
  }
  return out;
}

export interface ProfileValue {
  key: string;
  /** undefined: the profile has no such key. null: the profile says "always ask me". */
  value: string | number | boolean | null | undefined;
}

/** Resolves a profile key, including the synthetic composite keys used by the rules. */
export function profileValue(profile: Record<string, any>, key: string): ProfileValue {
  if (key === "@fullName") {
    const f = profile.firstName, l = profile.lastName;
    if (f == null || l == null) return { key, value: f === undefined && l === undefined ? undefined : null };
    return { key, value: `${f} ${l}` };
  }
  if (key === "@location") {
    const parts = [profile.city, profile.state].filter((x) => x != null && x !== "");
    return { key, value: parts.length ? parts.join(", ") : null };
  }
  const v = getPath(profile, key);
  if (v !== null && v !== undefined && typeof v === "object") return { key, value: undefined };
  return { key, value: v as ProfileValue["value"] };
}

export function matchRule(field: FormField): string | null {
  const label = normalizeLabel(field.label);
  if (!label) return null;
  for (const r of RULES) {
    if (r.kinds && !r.kinds.includes(field.kind)) continue;
    if (!r.kinds && field.kind === "file") continue;
    if (r.pattern.test(label)) return r.key;
  }
  return null;
}

/** Picks the option that matches a profile value, or null. Only exact-ish matches. */
export function matchOption(value: unknown, options: string[] | undefined): string | null {
  if (!options || options.length === 0) return value == null ? null : String(value);
  if (value == null) return null;
  const v = typeof value === "boolean" ? (value ? "yes" : "no") : String(value).trim().toLowerCase();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
  const exact = options.find((o) => o.trim().toLowerCase() === v);
  if (exact) return exact;
  const n = options.find((o) => norm(o) === norm(v));
  if (n) return n;
  // "Yes" -> "Yes, I am authorized", "No" -> "No, I will need sponsorship"
  if (v === "yes" || v === "no") {
    const starts = options.filter((o) => norm(o).split(" ")[0] === v);
    if (starts.length === 1) return starts[0];
  }
  // Numbers against ranges such as "10+ years" or "5-10".
  const num = Number(v);
  if (Number.isFinite(num)) {
    for (const o of options) {
      const range = o.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
      if (range && num >= +range[1] && num <= +range[2]) return o;
      const plus = o.match(/(\d+)\s*\+/);
      if (plus && num >= +plus[1]) return o;
    }
  }
  return null;
}

/** Splits "leave work authorization and salary for me" style phrases into label fragments. */
export function skipPhrasesFromInstruction(instruction: string): string[] {
  const out: string[] = [];
  const re = /(?:leave|skip|don'?t fill|do not fill|ignore)\s+(?:the\s+)?(.+?)(?:\s+(?:for me|blank|empty|alone))?(?:[.;]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(instruction))) {
    for (const part of m[1].split(/,|\band\b|\bor\b/)) {
      const t = part.replace(/\b(the|questions?|fields?|blank|for me)\b/gi, "").trim().toLowerCase();
      if (t.length >= 3) out.push(t);
    }
  }
  return out;
}

/** Crude stem so "authorization" matches "authorized" and "sponsorship" matches "sponsor". */
const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);

export function labelMatchesAny(label: string, fragments: string[]): boolean {
  const labelStems = new Set(normalizeLabel(label).split(/\s+/).map(stem).filter(Boolean));
  return fragments.some((f) => {
    const words = f.split(/\s+/).map(stem).filter((w) => w.length >= 3);
    return words.length > 0 && words.every((w) => labelStems.has(w));
  });
}
