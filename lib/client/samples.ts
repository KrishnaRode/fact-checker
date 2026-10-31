import cases from "@/fixtures/demo/cases.json";
import type { Mode } from "@/lib/contracts";

export type Sample = { label: string; input: string; mode: Mode; note: string };

/**
 * Three suggestions under the composer. Demo samples come from the human-reviewed fictional
 * fixtures. The live sample was checked against accessible sources on 31 Oct 2026 (BBC News,
 * Al Jazeera: the PM ruled out financial reparations); live results can change over time and
 * are never hardcoded.
 */
const demo = (cases.cases as { title: string; input: string; sample?: boolean }[]).filter((c) => c.sample);

export const SAMPLES: Sample[] = [
  { label: demo[0]!.title, input: demo[0]!.input, mode: "demo", note: "Demo · fictional" },
  { label: "UK slavery reparations", input: "Prime Minister Andy Burnham has agreed to pay financial reparations for the UK's role in the slave trade.", mode: "live", note: "Live · checked 31 Oct 2026" },
  { label: demo[2]?.title ?? demo[1]!.title, input: (demo[2] ?? demo[1])!.input, mode: "demo", note: "Demo · fictional" },
];
