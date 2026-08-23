/**
 * FAA National Airspace System status — free, no key, no rate limit.
 *
 * https://nasstatus.faa.gov/api/airport-status-information returns XML listing
 * every active ground stop, ground delay program, arrival/departure delay and
 * airport closure in the US.
 *
 * Why the bag room cares: a ground stop at ATL does not show up anywhere in an
 * ADS-B feed, but it is the single best early warning that the 8:00 AM Atlanta
 * departure is about to become a bag-recovery job. This driver separates
 * programs at AUS itself (`local`) from programs at the destinations AUS flies
 * to on Delta metal (`network`).
 */

import { NasProgram, NasSummary } from "../types";
import { STATION, ICAO_TO_IATA, DELTA_HUBS } from "../config";

const NAS_URL = "https://nasstatus.faa.gov/api/airport-status-information";

/** Destinations that matter to this station, as IATA. */
const WATCHED = new Set<string>(
  [...DELTA_HUBS].map((icao) => ICAO_TO_IATA[icao] ?? icao.replace(/^K/, "")),
);

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decode(m[1].trim()) : "";
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1]);
}

/**
 * The FAA document nests each program type under a <Delay_type> whose <Name>
 * identifies it. We read the section names rather than guessing at element
 * names, so a new program type degrades to "unknown kind" instead of vanishing.
 */
function parse(xml: string): { updatedAt: string; programs: NasProgram[] } {
  const updatedAt = tagText(xml, "Update_Time");
  const programs: NasProgram[] = [];

  for (const section of blocks(xml, "Delay_type")) {
    const name = tagText(section, "Name").toLowerCase();

    const kind: NasProgram["kind"] = name.includes("ground stop")
      ? "Ground Stop"
      : name.includes("ground delay")
        ? "Ground Delay"
        : name.includes("closure")
          ? "Closure"
          : name.includes("arrival")
            ? "Arrival Delay"
            : "Departure Delay";

    // Each program element carries an <ARPT> plus reason/timing children.
    const entries = [
      ...blocks(section, "Program"),
      ...blocks(section, "Ground_Delay"),
      ...blocks(section, "Airport_Closure"),
      ...blocks(section, "Delay"),
      ...blocks(section, "Arrival_Departure_Delay"),
    ];

    for (const e of entries) {
      const airport = tagText(e, "ARPT");
      if (!airport) continue;
      programs.push({
        airport,
        kind,
        reason: tagText(e, "Reason") || "not stated",
        avg: tagText(e, "Avg") || undefined,
        max: tagText(e, "Max") || undefined,
        endTime: tagText(e, "End_Time") || tagText(e, "Reopen") || undefined,
      });
    }
  }

  return { updatedAt, programs };
}

export async function fetchNasStatus(): Promise<NasSummary> {
  const res = await fetch(NAS_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/xml, text/xml, */*" },
  });
  if (!res.ok) throw new Error(`FAA NAS ${res.status}`);
  const xml = await res.text();
  const { updatedAt, programs } = parse(xml);

  return {
    updatedAt,
    local: programs.filter((p) => p.airport === STATION.iata),
    network: programs.filter((p) => p.airport !== STATION.iata && WATCHED.has(p.airport)),
    fetchedAt: new Date().toISOString(),
  };
}

/** One-line operational read for the dashboard and the shift report. */
export function nasHeadline(nas: NasSummary | null): string {
  if (!nas) return "FAA status unavailable";
  if (nas.local.length) {
    const p = nas.local[0];
    return `${STATION.iata}: ${p.kind} — ${p.reason}${p.endTime ? ` until ${p.endTime}` : ""}`;
  }
  if (nas.network.length) {
    const stops = nas.network.filter((p) => p.kind === "Ground Stop");
    const worst = stops[0] ?? nas.network[0];
    return `${nas.network.length} program${nas.network.length === 1 ? "" : "s"} on Delta destinations — worst: ${worst.airport} ${worst.kind} (${worst.reason})`;
  }
  return "No FAA programs affecting AUS or its Delta destinations";
}
