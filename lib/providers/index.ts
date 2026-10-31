import "server-only";
import type { Mode, ProviderStatus } from "@/lib/contracts";
import { braveProvider } from "./brave";
import { demoProvider } from "./demo";
import { gdeltProvider } from "./gdelt";
import { mastodonProvider } from "./mastodon";
import { googleFactCheckProvider } from "./google-fact-check";
import { rssProvider } from "./rss";
import type { Provider } from "./types";
import { wikipediaProvider } from "./wikipedia";

const LIVE: Provider[] = [rssProvider, wikipediaProvider, gdeltProvider, mastodonProvider, braveProvider, googleFactCheckProvider];

export function providersFor(mode: Mode): Provider[] {
  if (mode === "demo") return [demoProvider];
  return LIVE.filter((p) => p.enabled());
}

export function coverageScope(mode: Mode): "selected_sources" | "broader_web" {
  return providersFor(mode).some((p) => p.scope === "broad") ? "broader_web" : "selected_sources";
}

export function providerStatuses(): ProviderStatus[] {
  return LIVE.map((p) => ({ id: p.id, name: p.name, kind: p.kind, enabled: p.enabled(), note: p.enabled() ? p.description : (p.disabledReason() ?? "") }));
}
