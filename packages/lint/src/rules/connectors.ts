import type { LintContext, HyperframeLintFinding } from "../context";
import { readAttr, truncateSnippet } from "../utils";
import type { LintRule } from "../types";

const MARKER_TAGS = new Set(["path", "line", "polyline", "polygon"]);
const GSAP_CALL_RE = /\.\s*(?:fromTo|from|to|set)\s*\(/gi;
const EL_ALIAS_RE =
  /\b([A-Za-z_$][\w$]*)\s*=\s*(?:document\.)?(?:getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)|querySelector\s*\(\s*['"]#([^'"]+)['"]\s*\))/g;

// Quote-aware: a naive depth scan closes inside strings / ${}.
// fallow-ignore-next-line complexity
function matchingParen(source: string, openIdx: number): number {
  if (source[openIdx] !== "(") return -1;
  let depth = 0;
  let inStr: string | null = null;
  let tmpl = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (inStr === "`") {
      if (c === "\\" && i + 1 < source.length) {
        i += 1;
        continue;
      }
      if (c === "`" && tmpl === 0) {
        inStr = null;
        continue;
      }
      if (c === "$" && source[i + 1] === "{") {
        tmpl += 1;
        i += 1;
        continue;
      }
      if (c === "}" && tmpl > 0) {
        tmpl -= 1;
        continue;
      }
      if (tmpl > 0) {
        if (c === "(") depth += 1;
        else if (c === ")") {
          depth -= 1;
          if (depth === 0) return i;
        }
      }
      continue;
    }
    if (inStr === "'" || inStr === '"') {
      if (c === "\\" && i + 1 < source.length) {
        i += 1;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function selectorHitsId(sel: string, elementId: string): boolean {
  const trimmed = sel.trim();
  if (trimmed === `#${elementId}`) return true;
  return new RegExp(
    `(?:^|[\\s,>|+~])#${elementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s,>|+~.:\\[])`,
  ).test(trimmed);
}

function aliasesIn(script: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of script.matchAll(EL_ALIAS_RE)) {
    const elementId = m[2] || m[3];
    if (m[1] && elementId) out.set(m[1], elementId);
  }
  return out;
}

type DashTarget = { kind: "sel" | "var"; value: string; index: number };

function tokenToDashTarget(token: string, callIndex: number): DashTarget | null {
  const quoted = token.match(/^(['"])([^'"]+)\1$/);
  if (quoted?.[2]) return { kind: "sel", value: quoted[2], index: callIndex };
  if (/^[A-Za-z_$][\w$]*$/.test(token)) return { kind: "var", value: token, index: callIndex };
  return null;
}

function firstArgDashTargets(args: string, callIndex: number): DashTarget[] {
  const trimmed = args.trimStart();
  const quote = trimmed.match(/^(['"])([^'"]+)\1\s*,/);
  if (quote?.[2]) return [{ kind: "sel", value: quote[2], index: callIndex }];
  const array = trimmed.match(/^\[\s*([^[\]]+)\]\s*,/);
  if (array?.[1]) {
    return array[1]
      .split(",")
      .map((part) => tokenToDashTarget(part.trim(), callIndex))
      .filter((hit): hit is DashTarget => hit !== null);
  }
  const ident = trimmed.match(/^([A-Za-z_$][\w$]*)\s*,/);
  if (ident?.[1]) return [{ kind: "var", value: ident[1], index: callIndex }];
  return [];
}

function dashHitsId(target: DashTarget, elementId: string, aliases: Map<string, string>): boolean {
  return target.kind === "sel"
    ? selectorHitsId(target.value, elementId)
    : aliases.get(target.value) === elementId;
}

function dashTargets(script: string): DashTarget[] {
  const hits: DashTarget[] = [];
  for (const m of script.matchAll(GSAP_CALL_RE)) {
    const open = script.indexOf("(", m.index ?? 0);
    if (open < 0) continue;
    const close = matchingParen(script, open);
    if (close < 0) continue;
    const args = script.slice(open + 1, close);
    if (!/strokeDashoffset/i.test(args)) continue;
    hits.push(...firstArgDashTargets(args, m.index ?? 0));
  }
  return hits;
}

function markerOrientFindings(ctx: LintContext): HyperframeLintFinding[] {
  const findings: HyperframeLintFinding[] = [];
  for (const tag of ctx.tags) {
    if (tag.name !== "marker") continue;
    if (!/(?:^|[\s"'])orientation\s*=/i.test(tag.attrs)) continue;
    findings.push({
      code: "marker_orient_typo",
      severity: "error",
      message:
        "SVG <marker> uses invalid attribute orientation= — browsers ignore it and default to orient=0 " +
        "(arrowhead pinned to +x / screen-right).",
      elementId: readAttr(tag.raw, "id") ?? undefined,
      snippet: truncateSnippet(tag.raw),
      fixHint:
        'Use orient="auto" (or orient="auto-start-reverse" for bidirectional ends). Never orientation=.',
    });
  }
  return findings;
}

function idsWithHtmlMarkers(ctx: LintContext): Set<string> {
  const ids = new Set<string>();
  for (const tag of ctx.tags) {
    if (!MARKER_TAGS.has(tag.name)) continue;
    if (!/\bmarker-(?:end|start)\s*=/i.test(tag.attrs)) continue;
    const id = readAttr(tag.raw, "id");
    if (id) ids.add(id);
  }
  return ids;
}

function markerDashFindings(ctx: LintContext): HyperframeLintFinding[] {
  const ids = idsWithHtmlMarkers(ctx);
  if (ids.size === 0) return [];
  const findings: HyperframeLintFinding[] = [];
  const seen = new Set<string>();
  for (const script of ctx.scripts) {
    const aliases = aliasesIn(script.content);
    for (const target of dashTargets(script.content)) {
      for (const elementId of ids) {
        if (seen.has(elementId)) continue;
        if (!dashHitsId(target, elementId, aliases)) continue;
        seen.add(elementId);
        findings.push({
          code: "marker_dash_draw_on",
          severity: "error",
          elementId,
          message:
            `#${elementId} has marker-end/marker-start and is animated with strokeDashoffset — ` +
            "the marker still shows while the shaft is hidden, so a bare arrowhead pops in first.",
          snippet: truncateSnippet(script.content.slice(target.index, target.index + 110)),
          fixHint:
            "Do not combine marker-* with strokeDashoffset draw-on. Finish the draw, then attach the " +
            "marker / fade a separate head; or use a layout-owned scaleX/scaleY connector.",
        });
      }
    }
  }
  return findings;
}

export const connectorRules: LintRule<LintContext>[] = [markerOrientFindings, markerDashFindings];
