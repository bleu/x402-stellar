import { describe, it, expect } from "vitest";
import { extractDiscoveryInfo } from "@x402/extensions/bazaar";

import { SEED_CORPUS, seedPayloadOf } from "../../src/modules/catalog/seed-corpus.js";

describe("seed corpus", () => {
  it("holds about twenty services", () => {
    expect(SEED_CORPUS.length).toBeGreaterThanOrEqual(20);
  });

  it("produces payloads the real extraction path accepts", () => {
    // The corpus goes in through extractDiscoveryInfo, the same door a
    // settlement uses, so it cannot contain a shape real traffic could not.
    for (const entry of SEED_CORPUS) {
      const { paymentPayload, requirements } = seedPayloadOf(entry);
      const discovered = extractDiscoveryInfo(paymentPayload, requirements);

      expect(discovered, `${entry.resource} was rejected by extractDiscoveryInfo`).not.toBeNull();
    }
  });

  it("fields rival weather services so the live endpoint has competition", () => {
    const weather = SEED_CORPUS.filter((entry) =>
      /weather|forecast|temperature/i.test(`${entry.serviceName} ${entry.description}`),
    );

    expect(weather.length).toBeGreaterThanOrEqual(3);
  });

  it("prices some entries in XLM so maxUsdPrice goes through a live rate", () => {
    const assets = new Set(SEED_CORPUS.map((entry) => entry.asset));

    expect(assets).toContain("XLM");
    expect([...assets].filter((asset) => asset.startsWith("C")).length).toBeGreaterThan(0);
  });

  it("includes an asset with no USD mapping so keep-and-warn is reachable", () => {
    const unmapped = SEED_CORPUS.filter((entry) => entry.asset === "CUNMAPPEDSEEDASSET");
    expect(unmapped).toHaveLength(1);
  });

  it("includes a templated route so canonical keying is visible", () => {
    expect(SEED_CORPUS.some((entry) => entry.routeTemplate)).toBe(true);
  });

  it("includes entries that trip the soft-drop rules", () => {
    // serviceName over 32 characters is dropped entirely; tags past 5 are cut.
    expect(SEED_CORPUS.some((entry) => (entry.serviceName?.length ?? 0) > 32)).toBe(true);
    expect(SEED_CORPUS.some((entry) => (entry.tags?.length ?? 0) > 5)).toBe(true);
  });

  it("includes an entry with no service name at all", () => {
    expect(SEED_CORPUS.some((entry) => !entry.serviceName)).toBe(true);
  });

  it("includes an entry with a thin description", () => {
    expect(SEED_CORPUS.some((entry) => entry.description.length < 20)).toBe(true);
  });

  it("includes an MCP tool", () => {
    expect(SEED_CORPUS.some((entry) => entry.toolName)).toBe(true);
  });

  it("drops the over-long service name through the real sanitizer", () => {
    const overLong = SEED_CORPUS.find((entry) => (entry.serviceName?.length ?? 0) > 32)!;
    const { paymentPayload, requirements } = seedPayloadOf(overLong);

    const discovered = extractDiscoveryInfo(paymentPayload, requirements)!;
    expect(discovered.serviceName).toBeUndefined();
  });

  it("trims the over-long tag list through the real sanitizer", () => {
    const manyTags = SEED_CORPUS.find((entry) => (entry.tags?.length ?? 0) > 5)!;
    const { paymentPayload, requirements } = seedPayloadOf(manyTags);

    const discovered = extractDiscoveryInfo(paymentPayload, requirements)!;
    expect(discovered.tags).toHaveLength(5);
  });

  it("keys a templated entry by its template", () => {
    const templated = SEED_CORPUS.find((entry) => entry.routeTemplate)!;
    const { paymentPayload, requirements } = seedPayloadOf(templated);

    const discovered = extractDiscoveryInfo(paymentPayload, requirements)!;
    expect(discovered.resourceUrl).toContain(templated.routeTemplate!);
  });
});
