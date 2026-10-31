import { FetchError } from "@/lib/network/safe-fetch";
import { redactSecrets } from "@/lib/config";
import { ProviderError } from "./types";

export function asProviderError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof FetchError) {
    if (err.code === "aborted") return new ProviderError(provider, "aborted", "Cancelled.");
    if (err.code === "timeout") return new ProviderError(provider, "timeout", "Did not respond within its time budget.");
    if (err.status === 429) return new ProviderError(provider, "rate_limited", "Rate limited by the service; try again shortly.");
    if (err.status === 401 || err.status === 403) return new ProviderError(provider, "not_configured", "The service rejected the request (check the API key).");
    return new ProviderError(provider, "unavailable", redactSecrets(err.message));
  }
  if (err instanceof SyntaxError) return new ProviderError(provider, "bad_response", "Returned a response in an unexpected format.");
  return new ProviderError(provider, "unavailable", "Could not be reached.");
}

export function safeJson(text: string): unknown {
  return JSON.parse(text.replace(/^﻿/, ""));
}
